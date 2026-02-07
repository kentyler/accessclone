(ns app.state-report
  "Report editor state management - report-specific functions split from state.cljs"
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]
            [app.state :as state :refer [app-state api-base db-headers
                                         log-error! log-event! build-data-query-params
                                         update-object! filename->display-name
                                         coerce-yes-no coerce-to-number coerce-to-keyword
                                         yes-no-control-props yes-no-control-defaults number-control-props]]))

;; Forward declarations
(declare save-report! save-report-to-file!)

;; ============================================================
;; REPORT NORMALIZATION
;; ============================================================

(defn- normalize-report-control
  "Normalize a single report control: keywordize :type, coerce yes/no and number props."
  [ctrl]
  (-> (reduce (fn [c prop]
                (let [v (get c prop)]
                  (if (nil? v)
                    (assoc c prop (get yes-no-control-defaults prop 0))
                    (assoc c prop (coerce-yes-no v)))))
              (update ctrl :type coerce-to-keyword)
              yes-no-control-props)
      (#(reduce (fn [c prop]
                  (if (contains? c prop)
                    (assoc c prop (coerce-to-number (get c prop)))
                    c))
                % number-control-props))))

(defn- normalize-report-section
  "Normalize all controls in a report section."
  [section]
  (if (:controls section)
    (update section :controls #(mapv normalize-report-control %))
    section))

(def ^:private report-section-keys
  [:report-header :page-header :detail :page-footer :report-footer])

(defn- normalize-report-definition
  "Apply defaults and normalize types across the full report definition."
  [definition]
  (let [;; Normalize standard sections
        def-with-sections
        (reduce (fn [d section-key]
                  (if (get d section-key)
                    (update d section-key normalize-report-section)
                    d))
                definition
                report-section-keys)
        ;; Normalize group sections (group-header-0, group-footer-0, etc.)
        all-keys (keys def-with-sections)
        group-keys (filter (fn [k]
                             (let [n (name k)]
                               (or (str/starts-with? n "group-header-")
                                   (str/starts-with? n "group-footer-"))))
                           all-keys)]
    (reduce (fn [d gk]
              (if (get d gk)
                (update d gk normalize-report-section)
                d))
            def-with-sections
            group-keys)))

;; ============================================================
;; REPORT EDITOR - DEFINITION & CONTROLS
;; ============================================================

(defn set-report-definition!
  "Update report editor current definition and mark dirty."
  [definition]
  (swap! app-state assoc-in [:report-editor :current] definition)
  (swap! app-state assoc-in [:report-editor :dirty?]
         (not= definition (get-in @app-state [:report-editor :original]))))

(defn clear-report-lint-errors! []
  (swap! app-state assoc-in [:report-editor :lint-errors] nil))

(defn set-report-lint-errors! [errors]
  (swap! app-state assoc-in [:report-editor :lint-errors] errors))

(defn set-report-view-mode!
  "Set report view mode - :design or :preview"
  [mode]
  (swap! app-state assoc-in [:report-editor :view-mode] mode)
  (when (= mode :preview)
    (let [record-source (get-in @app-state [:report-editor :current :record-source])]
      (when record-source
        (go
          (let [query-params (build-data-query-params
                               (get-in @app-state [:report-editor :current :order-by])
                               (get-in @app-state [:report-editor :current :filter]))
                response (<! (http/get (str api-base "/api/data/" record-source)
                                       {:query-params query-params
                                        :headers (db-headers)}))]
            (if (:success response)
              (let [data (get-in response [:body :data])]
                (println "Report preview: loaded" (count data) "records from" record-source)
                (swap! app-state assoc-in [:report-editor :records] (vec data)))
              (do (println "Error loading report data:" (:body response))
                  (log-error! "Failed to load report preview data" "set-report-view-mode" {:response (:body response)})))))))))

(defn get-report-view-mode []
  (get-in @app-state [:report-editor :view-mode] :design))

(defn select-report-control!
  "Select a report control or section. Pass nil for report-level, {:section :page-header} for section, {:section :detail :idx 0} for control."
  [selection]
  (swap! app-state assoc-in [:report-editor :selected-control] selection))

(defn update-report-control!
  "Update a property of a control in a report section"
  [section idx prop value]
  (let [current (get-in @app-state [:report-editor :current])
        controls (or (get-in current [section :controls]) [])]
    (when (< idx (count controls))
      (set-report-definition!
       (assoc-in current [section :controls]
                 (update controls idx assoc prop value))))))

(defn delete-report-control!
  "Delete a control from a report section"
  [section idx]
  (let [current (get-in @app-state [:report-editor :current])
        controls (or (get-in current [section :controls]) [])]
    (when (< idx (count controls))
      (let [new-controls (vec (concat (subvec controls 0 idx)
                                      (subvec controls (inc idx))))]
        (swap! app-state assoc-in [:report-editor :selected-control] nil)
        (set-report-definition! (assoc-in current [section :controls] new-controls))))))

;; ============================================================
;; REPORT EDITOR SETUP & LOADING
;; ============================================================

(defn- setup-report-editor!
  "Initialize the report editor state with a definition."
  [report-id definition]
  (swap! app-state assoc :report-editor
         {:report-id report-id
          :dirty? false
          :original definition
          :current definition
          :selected-control nil
          :properties-tab :format
          :view-mode :design
          :records []}))

(defn- parse-report-body
  "Parse API response body into a normalized report definition."
  [body report-name]
  (if (= "edn" (:_format body))
    {:_raw_edn (:_raw_edn body) :_format "edn" :name report-name}
    (normalize-report-definition (dissoc body :id :name))))

(defn load-report-for-editing!
  "Load a report definition for editing"
  [report]
  (when (get-in @app-state [:report-editor :dirty?])
    (save-report!))
  (if (:definition report)
    (do (setup-report-editor! (:id report) (normalize-report-definition (:definition report)))
        (set-report-view-mode! :design))
    (go
      (let [response (<! (http/get (str api-base "/api/reports/" (:filename report))
                                    {:headers (db-headers)}))]
        (if (:success response)
          (let [definition (parse-report-body (:body response) (:name report))]
            (swap! app-state update-in [:objects :reports]
                   (fn [reports]
                     (mapv #(if (= (:id %) (:id report))
                              (assoc % :definition definition) %)
                           reports)))
            (setup-report-editor! (:id report) definition))
          (do (println "Error loading report:" (:filename report))
              (log-error! (str "Failed to load report: " (:filename report)) "load-report-for-editing" {:report (:filename report)})))))))

;; ============================================================
;; REPORT SAVE
;; ============================================================

(defn save-report-to-file!
  "Save a report to the database via backend API"
  [report]
  (let [filename (or (:filename report)
                     (-> (:name report)
                         (str/lower-case)
                         (str/replace #"\s+" "_")))
        report-data (merge {:id (:id report)
                            :name (:name report)}
                           (:definition report))]
    (go
      (let [response (<! (http/put (str api-base "/api/reports/" filename)
                                   {:json-params report-data}))]
        (if (:success response)
          (do
            (println "Saved report:" filename)
            (swap! app-state update-in [:objects :reports]
                   (fn [reports]
                     (mapv (fn [r]
                             (if (= (:id r) (:id report))
                               (assoc r :filename filename)
                               r))
                           reports))))
          (do
            (println "Error saving report:" (:body response))
            (log-error! (str "Failed to save report: " (get-in response [:body :error])) "save-report" {:response (:body response)})))))))

(defn do-save-report!
  "Actually save the report"
  []
  (let [current (get-in @app-state [:report-editor :current])
        report-id (get-in @app-state [:report-editor :report-id])]
    (when (and report-id current)
      ;; Update the report in objects list
      (update-object! :reports report-id {:definition current})
      ;; Update the tab name if report name changed
      (swap! app-state update :open-objects
             (fn [tabs]
               (mapv (fn [tab]
                       (if (and (= (:type tab) :reports)
                                (= (:id tab) report-id))
                         (assoc tab :name (or (:name current) (:name tab)))
                         tab))
                     tabs)))
      ;; Mark as clean
      (swap! app-state assoc-in [:report-editor :dirty?] false)
      (swap! app-state assoc-in [:report-editor :original] current)
      ;; Save to file
      (let [report (first (filter #(= (:id %) report-id)
                                  (get-in @app-state [:objects :reports])))]
        (save-report-to-file! report)))))

(defn save-report!
  "Lint the report and save if valid"
  []
  (let [current (get-in @app-state [:report-editor :current])
        report-id (get-in @app-state [:report-editor :report-id])
        report-obj (first (filter #(= (:id %) report-id)
                                  (get-in @app-state [:objects :reports])))
        report-with-meta (merge {:id report-id :name (:name report-obj)} current)]
    (when (and report-id current)
      (clear-report-lint-errors!)
      (go
        (let [response (<! (http/post (str api-base "/api/lint/report")
                                       {:json-params {:report report-with-meta}}))]
          (if (:success response)
            (let [result (:body response)]
              (if (:valid result)
                (do
                  (do-save-report!)
                  (println "Report saved successfully"))
                (do
                  (set-report-lint-errors! (:errors result))
                  (println "Report has validation errors:" (:errors result)))))
            (do
              ;; Lint endpoint failed, save anyway
              (println "Lint check failed, saving anyway")
              (do-save-report!))))))))
