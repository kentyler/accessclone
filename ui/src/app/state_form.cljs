(ns app.state-form
  "Form editor state management - form-specific functions split from state.cljs"
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]
            [app.state :as state :refer [app-state api-base db-headers session-id
                                         set-loading! set-error! log-error! log-event!
                                         build-data-query-params record->api-map detect-pk-field
                                         pk-value-for-record parse-access-filter
                                         update-object! save-ui-state! close-tab!
                                         filename->display-name
                                         coerce-yes-no coerce-to-number coerce-to-keyword
                                         yes-no-control-props yes-no-control-defaults number-control-props
                                         normalize-control
                                         maybe-auto-analyze!]]))

;; Forward declarations for functions used before definition
(declare save-current-record! save-form! save-form-to-file!
         get-record-source-fields delete-current-record! load-form-for-editing!)

;; ============================================================
;; FORM-VIEW RECORD CONTEXT MENU & CLIPBOARD
;; ============================================================

(defonce form-clipboard (atom nil))

(defn show-form-context-menu! [x y]
  (swap! app-state assoc-in [:form-editor :context-menu]
         {:visible true :x x :y y}))

(defn hide-form-context-menu! []
  (swap! app-state assoc-in [:form-editor :context-menu :visible] false))

(defn copy-form-record!
  "Copy the current record to the form clipboard"
  []
  (let [record (get-in @app-state [:form-editor :current-record])]
    (reset! form-clipboard (dissoc record :__new__ :id))))

(defn cut-form-record!
  "Copy the current record to clipboard, then delete it"
  []
  (copy-form-record!)
  (delete-current-record!))

(defn paste-form-record!
  "Create a new record pre-filled with clipboard values"
  []
  (when-let [data @form-clipboard]
    (let [total (get-in @app-state [:form-editor :record-position :total] 0)
          new-record (assoc data :__new__ true)]
      (swap! app-state update-in [:form-editor :records] #(conj (vec %) new-record))
      (swap! app-state assoc-in [:form-editor :current-record] new-record)
      (swap! app-state assoc-in [:form-editor :record-position] {:current (inc total) :total (inc total)})
      (swap! app-state assoc-in [:form-editor :record-dirty?] true))))

;; ============================================================
;; CLOSE TABS (form-aware auto-save)
;; ============================================================

(defn close-all-tabs!
  "Close all open tabs"
  []
  ;; Auto-save dirty record before closing
  (when (get-in @app-state [:form-editor :record-dirty?])
    (save-current-record!))
  ;; Auto-save dirty form definition before closing
  (when (get-in @app-state [:form-editor :dirty?])
    (save-form!))
  (swap! app-state assoc
         :open-objects []
         :active-tab nil
         :form-editor nil))

(defn close-current-tab!
  "Close the currently active tab"
  []
  (let [active (:active-tab @app-state)]
    (when active
      ;; Auto-save dirty record before closing
      (when (get-in @app-state [:form-editor :record-dirty?])
        (save-current-record!))
      ;; Auto-save dirty form definition before closing
      (when (get-in @app-state [:form-editor :dirty?])
        (save-form!))
      (close-tab! (:type active) (:id active)))))

;; ============================================================
;; FORM CREATION
;; ============================================================

(defn create-new-form! []
  (let [existing-forms (get-in @app-state [:objects :forms])
        new-id (inc (reduce max 0 (map :id existing-forms)))
        new-form {:id new-id
                  :name (str "Form" new-id)
                  :definition {:type :form
                               :record-source nil
                               :controls []}}]
    (state/add-object! :forms new-form)
    (state/open-object! :forms new-id)))

;; ============================================================
;; FORM EDITOR - DEFINITION & SAVE
;; ============================================================

(defn set-form-definition! [definition]
  (swap! app-state assoc-in [:form-editor :current] definition)
  (swap! app-state assoc-in [:form-editor :dirty?]
         (not= definition (get-in @app-state [:form-editor :original]))))

(defn clear-lint-errors! []
  (swap! app-state assoc-in [:form-editor :lint-errors] nil))

(defn set-lint-errors! [errors]
  (swap! app-state assoc-in [:form-editor :lint-errors] errors))

(defn save-form-to-file!
  "Save a form to the database via backend API"
  [form]
  (let [filename (or (:filename form)
                     (-> (:name form)
                         (str/lower-case)
                         (str/replace #"\s+" "_")))
        form-data (merge {:id (:id form)
                          :name (:name form)}
                         (:definition form))]
    (go
      (let [response (<! (http/put (str api-base "/api/forms/" filename)
                                   {:json-params form-data}))]
        (if (:success response)
          (do
            ;; Update the form's filename in state
            (swap! app-state update-in [:objects :forms]
                   (fn [forms]
                     (mapv (fn [f]
                             (if (= (:id f) (:id form))
                               (assoc f :filename filename)
                               f))
                           forms))))
          (log-error! (str "Failed to save form: " (get-in response [:body :error])) "save-form" {:response (:body response)}))))))

(defn do-save-form!
  "Actually save the form (called after lint passes)"
  []
  (let [current (get-in @app-state [:form-editor :current])
        form-id (get-in @app-state [:form-editor :form-id])]
    (when (and form-id current)
      ;; Update the form in objects list
      (update-object! :forms form-id {:definition current})
      ;; Update the tab name if form name changed
      (swap! app-state update :open-objects
             (fn [tabs]
               (mapv (fn [tab]
                       (if (and (= (:type tab) :forms)
                                (= (:id tab) form-id))
                         (assoc tab :name (:name current))
                         tab))
                     tabs)))
      ;; Mark as clean
      (swap! app-state assoc-in [:form-editor :dirty?] false)
      (swap! app-state assoc-in [:form-editor :original] current)
      ;; Save to file
      (let [form (first (filter #(= (:id %) form-id)
                                (get-in @app-state [:objects :forms])))]
        (save-form-to-file! form)))))

(defn save-form!
  "Lint the form and save if valid"
  []
  (let [current (get-in @app-state [:form-editor :current])
        form-id (get-in @app-state [:form-editor :form-id])
        ;; Get form name from objects list
        form-obj (first (filter #(= (:id %) form-id)
                                (get-in @app-state [:objects :forms])))
        ;; Merge id and name back into form for lint validation
        form-with-meta (merge {:id form-id :name (:name form-obj)} current)]
    (when (and form-id current)
      (clear-lint-errors!)
      (go
        (let [response (<! (http/post (str api-base "/api/lint/form")
                                      {:json-params {:form form-with-meta}}))]
          (if (:success response)
            (let [result (:body response)]
              (if (:valid result)
                (do-save-form!)
                (set-lint-errors! (:errors result))))
            ;; Lint endpoint failed, save anyway
            (do-save-form!)))))))

;; ============================================================
;; SESSION-STATE FUNCTION CALLING
;; ============================================================

(defn- build-session-state-vars
  "Convert a record to session state vars map for session-state API."
  [record]
  (reduce-kv
    (fn [m k v]
      (if (= k :__new__) m
          (assoc m (if (keyword? k) (name k) (str k))
                 {:value (str v) :type "text"})))
    {} record))

(defn- handle-session-navigate!
  "Handle navigateTo from session function response."
  [navigate-to]
  (let [forms (get-in @app-state [:objects :forms])
        target-form (first (filter #(= (str/lower-case (:name %))
                                       (str/lower-case navigate-to))
                                   forms))]
    (if target-form
      (do (state/open-object! :forms (:id target-form))
          (load-form-for-editing! target-form))
      (log-event! "warning" (str "Navigate target form not found: " navigate-to) "handle-session-navigate"))))

(defn- collect-computed-specs
  "Scan a form definition for controls with :computed-function and build
   the computed column spec array for the data API."
  [form-def]
  (let [sections (keep #(get form-def %) ["header" :header "detail" :detail "footer" :footer])]
    (->> sections
         (mapcat #(get % :controls (get % "controls" [])))
         (keep (fn [ctrl]
                 (when-let [fn-name (or (get ctrl :computed-function)
                                        (get ctrl "computed-function"))]
                   {:fn fn-name
                    :params (or (get ctrl :computed-params)
                                (get ctrl "computed-params") [])
                    :alias (or (get ctrl :computed-alias)
                               (get ctrl "computed-alias")
                               (str "_calc_" (or (:name ctrl) (:id ctrl))))})))
         vec)))

(defn- refresh-form-data!
  "Re-fetch records for the current form and update state. Returns channel."
  []
  (let [form-def (get-in @app-state [:form-editor :current])
        record-source (get form-def :record-source)]
    (when record-source
      (go
        (let [computed (collect-computed-specs form-def)
              query-params (cond-> (build-data-query-params
                                     (get form-def :order-by)
                                     (get form-def :filter))
                             (seq computed)
                             (assoc :computed (.stringify js/JSON (clj->js computed))))
              data-resp (<! (http/get (str api-base "/api/data/" record-source)
                                      {:query-params query-params
                                       :headers (db-headers)}))]
          (when (:success data-resp)
            (let [data (get-in data-resp [:body :data])
                  total (get-in data-resp [:body :pagination :totalCount] (count data))
                  pos (get-in @app-state [:form-editor :record-position :current] 1)
                  safe-pos (min pos (count data))]
              (swap! app-state assoc-in [:form-editor :records] (vec data))
              (swap! app-state assoc-in [:form-editor :record-position] {:current safe-pos :total total})
              (when (and (seq data) (> safe-pos 0))
                (swap! app-state assoc-in [:form-editor :current-record] (nth data (dec safe-pos))))
              (swap! app-state assoc-in [:form-editor :record-dirty?] false))))))))

(defn- handle-session-response!
  "Handle response from a session function call (message, navigate, confirm)."
  [body session-id]
  (go
    (let [{:keys [userMessage navigateTo confirmRequired]} body]
      (when userMessage (js/alert userMessage))
      (when navigateTo (handle-session-navigate! navigateTo))
      (when confirmRequired
        (when (js/confirm "Confirm action?")
          (<! (http/post (str api-base "/api/session/function/confirm_action")
                         {:json-params {:sessionId session-id}}))))
      (refresh-form-data!))))

(defn call-session-function!
  "Call a PostgreSQL function through the session-state pipeline."
  [function-name & [{:keys [on-complete]}]]
  (go
    (let [session-resp (<! (http/post (str api-base "/api/session")))]
      (if-not (:success session-resp)
        (log-event! "error" "Failed to create session" "call-session-function" {:response (:body session-resp)})
        (let [session-id (get-in session-resp [:body :sessionId])
              state-vars (build-session-state-vars
                           (get-in @app-state [:form-editor :current-record] {}))]
          (when (seq state-vars)
            (<! (http/put (str api-base "/api/session/" session-id "/state")
                          {:json-params state-vars})))
          (let [func-resp (<! (http/post (str api-base "/api/session/function/" function-name)
                                         {:json-params {:sessionId session-id}}))]
            (if-not (:success func-resp)
              (do (log-event! "error" (str "Failed to call function: " function-name) "call-session-function" {:response (:body func-resp)})
                  (js/alert (str "Error calling " function-name ": "
                                 (get-in func-resp [:body :details]
                                         (get-in func-resp [:body :error] "Unknown error")))))
              (do
                (<! (handle-session-response! (:body func-resp) session-id))
                (when on-complete (on-complete (:body func-resp))))))
          (<! (http/delete (str api-base "/api/session/" session-id))))))))

(defn fire-form-event!
  "Check if the current form has a function mapped to the given event key,
   and if so, call it via call-session-function!. Returns a channel."
  [event-key & [{:keys [on-complete]}]]
  (let [form-def (get-in @app-state [:form-editor :current])
        function-name (get form-def event-key)]
    (when (and function-name (string? function-name) (not (str/blank? function-name)))
      (call-session-function! function-name {:on-complete on-complete}))))

;; ============================================================
;; FORM STATE SYNC (shared.form_control_state)
;; ============================================================

(defn- build-synced-controls
  "Scan all controls in a form definition for the 'state' tag.
   Returns a map of {control-name {:table-name t :column-name c}} keyed by
   the underlying table.column derived from record-source + field binding.
   Unbound controls use form-name as pseudo-table."
  [definition]
  (let [form-name (str/lower-case (or (:name definition) ""))
        record-source (str/lower-case
                        (str/replace (or (get definition :record-source)
                                        (get definition :record_source)
                                        form-name)
                                     " " "_"))
        sections (keep #(get definition %) [:header :detail :footer])]
    (into {}
          (comp (mapcat :controls)
                (filter #(= "state" (str/lower-case (or (:tag %) ""))))
                (keep (fn [ctrl]
                        (let [ctrl-name (str/lower-case (or (:name ctrl) ""))]
                          (when (not (str/blank? ctrl-name))
                            (if-let [field (:field ctrl)]
                              ;; Bound: table = record-source, column = field
                              [ctrl-name {:table-name record-source
                                          :column-name (str/lower-case (str/replace (str field) " " "_"))}]
                              ;; Unbound: table = form-name, column = control-name
                              [ctrl-name {:table-name form-name
                                          :column-name ctrl-name}]))))))
          sections)))

(defn- sync-form-state!
  "Upsert control values to shared.form_control_state.
   entries-vec is [{:tableName t :columnName c :value v}, ...]."
  [entries-vec]
  (when (seq entries-vec)
    (go
      (let [response (<! (http/put (str api-base "/api/form-state")
                                   {:json-params {:sessionId session-id
                                                  :entries entries-vec}}))]
        (when-not (:success response)
          (log-event! "warning" "Failed to sync form state" "sync-form-state"
                      {:error (get-in response [:body :error])}))))))

(defn- collect-synced-values
  "Given a record and a synced-controls map, return a vector of
   [{:tableName t :columnName c :value v}] for the API."
  [record synced-controls]
  (reduce-kv
    (fn [acc k v]
      (let [field-name (str/lower-case (if (keyword? k) (name k) (str k)))]
        (if-let [mapping (get synced-controls field-name)]
          (conj acc {:tableName (:table-name mapping)
                     :columnName (:column-name mapping)
                     :value (when (some? v) (str v))})
          acc)))
    [] record))

(defn- sync-current-record-state!
  "Sync all tagged control values from the current record to state table."
  []
  (let [synced (get-in @app-state [:form-editor :synced-controls])
        record (get-in @app-state [:form-editor :current-record])]
    (when (and (seq synced) record)
      (sync-form-state! (collect-synced-values record synced)))))

;; ============================================================
;; VIEW MODE & RECORD OPERATIONS
;; ============================================================

(defn- init-data-entry-mode!
  "Initialize form in data-entry mode with a blank new record."
  []
  (let [new-record {:__new__ true}]
    (swap! app-state assoc-in [:form-editor :records] [new-record])
    (swap! app-state assoc-in [:form-editor :current-record] new-record)
    (swap! app-state assoc-in [:form-editor :record-position] {:current 1 :total 1})
    (swap! app-state assoc-in [:form-editor :record-dirty?] true)
    (fire-form-event! :on-load)))

(defn- load-form-records!
  "Fetch records from API for form view mode."
  [record-source]
  (go
    (let [form-def (get-in @app-state [:form-editor :current])
          computed (collect-computed-specs form-def)
          query-params (cond-> (build-data-query-params
                                 (get form-def :order-by)
                                 (get form-def :filter))
                         (seq computed)
                         (assoc :computed (.stringify js/JSON (clj->js computed))))
          response (<! (http/get (str api-base "/api/data/" record-source)
                                 {:query-params query-params
                                  :headers (db-headers)}))]
      (if (:success response)
        (let [data (get-in response [:body :data])
              total (get-in response [:body :pagination :totalCount] (count data))]
          (swap! app-state assoc-in [:form-editor :records] (vec data))
          (swap! app-state assoc-in [:form-editor :record-position] {:current 1 :total total})
          (swap! app-state assoc-in [:form-editor :record-dirty?] false)
          (when (seq data)
            (swap! app-state assoc-in [:form-editor :current-record] (first data))
            ;; Sync initial record state for tagged controls
            (sync-current-record-state!))
          (fire-form-event! :on-load))
        (log-error! "Failed to load form records" "load-form-records" {:response (:body response)})))))

(defn set-view-mode! [mode]
  "Set form view mode - :design or :view"
  (let [current-mode (get-in @app-state [:form-editor :view-mode] :design)]
    (when (and (= current-mode :view) (not= mode :view))
      (when (get-in @app-state [:form-editor :record-dirty?])
        (save-current-record!)))
    (swap! app-state assoc-in [:form-editor :view-mode] mode)
    (when (= mode :view)
      (let [record-source (get-in @app-state [:form-editor :current :record-source])
            data-entry? (not= 0 (get-in @app-state [:form-editor :current :data-entry] 0))]
        (when record-source
          (if data-entry?
            (init-data-entry-mode!)
            (load-form-records! record-source)))))))

(defn get-view-mode []
  (get-in @app-state [:form-editor :view-mode] :design))

;; Record navigation state
(defn set-current-record! [record]
  (swap! app-state assoc-in [:form-editor :current-record] record))

(defn set-record-position! [pos total]
  (swap! app-state assoc-in [:form-editor :record-position] {:current pos :total total}))

(defn update-record-field! [field-name value]
  (swap! app-state assoc-in [:form-editor :current-record (keyword field-name)] value)
  (swap! app-state assoc-in [:form-editor :record-dirty?] true)
  ;; If this field is tagged for state sync, upsert immediately
  (let [synced (get-in @app-state [:form-editor :synced-controls])
        field-lc (str/lower-case (if (keyword? field-name) (name field-name) (str field-name)))]
    (when-let [mapping (and (seq synced) (get synced field-lc))]
      (sync-form-state! [{:tableName (:table-name mapping)
                          :columnName (:column-name mapping)
                          :value (when (some? value) (str value))}]))))

(defn navigate-to-record!
  "Navigate to a specific record by position (1-indexed)"
  [position]
  ;; Auto-save dirty record before navigating
  (when (get-in @app-state [:form-editor :record-dirty?])
    (save-current-record!))
  (let [records (get-in @app-state [:form-editor :records] [])
        total (count records)
        pos (max 1 (min total position))]
    (when (and (> total 0) (<= pos total))
      (swap! app-state assoc-in [:form-editor :record-position] {:current pos :total total})
      (swap! app-state assoc-in [:form-editor :current-record] (nth records (dec pos)))
      (swap! app-state assoc-in [:form-editor :record-dirty?] false)
      ;; Sync tagged control values to state table
      (sync-current-record-state!)
      ;; Fire on-current event after navigating to new record
      (fire-form-event! :on-current))))

(defn- run-before-update-hook!
  "Run before-update function if mapped. Returns channel yielding true to abort."
  [current-record]
  (go
    (let [before-update-fn (get-in @app-state [:form-editor :current :before-update])]
      (if-not (and before-update-fn (string? before-update-fn)
                   (not (str/blank? before-update-fn)))
        false
        (let [sess-resp (<! (http/post (str api-base "/api/session")))]
          (if-not (:success sess-resp)
            false
            (let [session-id (get-in sess-resp [:body :sessionId])
                  state-vars (build-session-state-vars current-record)
                  _ (when (seq state-vars)
                      (<! (http/put (str api-base "/api/session/" session-id "/state")
                                    {:json-params state-vars})))
                  func-resp (<! (http/post (str api-base "/api/session/function/" before-update-fn)
                                           {:json-params {:sessionId session-id}}))
                  user-msg (when (:success func-resp)
                             (get-in func-resp [:body :userMessage]))]
              (<! (http/delete (str api-base "/api/session/" session-id)))
              (when user-msg (js/alert user-msg))
              (boolean user-msg))))))))

(defn- do-insert-record!
  "Insert a new record via API and update state."
  [record-source record-for-api pk-field-name pos]
  (go
    (let [insert-data (if (= pk-field-name "id")
                        (dissoc record-for-api "id") record-for-api)
          response (<! (http/post (str api-base "/api/data/" record-source)
                                  {:json-params insert-data :headers (db-headers)}))]
      (if (:success response)
        (let [new-record (get-in response [:body :data])]
          (swap! app-state assoc-in [:form-editor :records (dec pos)] new-record)
          (swap! app-state assoc-in [:form-editor :current-record] new-record)
          (swap! app-state assoc-in [:form-editor :record-dirty?] false))
        (log-error! "Failed to insert record" "save-record" {:response (:body response)})))))

(defn- do-update-record!
  "Update an existing record via API and update state."
  [record-source record-for-api pk-field-name pk-value pos]
  (go
    (let [update-data (dissoc record-for-api pk-field-name)
          response (<! (http/put (str api-base "/api/data/" record-source "/" pk-value)
                                 {:json-params update-data :headers (db-headers)}))]
      (if (:success response)
        (let [updated-record (get-in response [:body :data])]
          (swap! app-state assoc-in [:form-editor :records (dec pos)] updated-record)
          (swap! app-state assoc-in [:form-editor :current-record] updated-record)
          (swap! app-state assoc-in [:form-editor :record-dirty?] false))
        (log-error! "Failed to update record" "save-record" {:response (:body response)})))))

(defn- check-no-pk?
  "Return true if table has no detectable PK and record isn't explicitly new."
  [pk-from-fields current-record]
  (and (nil? pk-from-fields)
       (not (contains? current-record :id))
       (not (contains? current-record "id"))
       (not (:__new__ current-record))))

(defn save-current-record!
  "Save the current record to the database"
  []
  (let [record-source (get-in @app-state [:form-editor :current :record-source])
        current-record (get-in @app-state [:form-editor :current-record])
        pos (get-in @app-state [:form-editor :record-position :current] 1)
        record-dirty? (get-in @app-state [:form-editor :record-dirty?])]
    (when (and record-source current-record record-dirty?)
      (go
        (let [abort? (<! (run-before-update-hook! current-record))]
          (when-not abort?
            (let [fields (get-record-source-fields record-source)
                  pk-from-fields (some #(when (:pk %) (:name %)) fields)
                  pk-field-name (or pk-from-fields "id")
                  pk-value (pk-value-for-record current-record pk-field-name)
                  is-new? (or (:__new__ current-record) (nil? pk-value) (= pk-value ""))
                  record-for-api (record->api-map current-record)]
              (if (check-no-pk? pk-from-fields current-record)
                (js/alert (str "Cannot save: table \"" record-source "\" has no primary key. "
                               "Add a primary key to this table before editing records."))
                (if is-new?
                  (<! (do-insert-record! record-source record-for-api pk-field-name pos))
                  (<! (do-update-record! record-source record-for-api pk-field-name pk-value pos)))))))))))

(defn new-record!
  "Create a new empty record"
  []
  (let [total (get-in @app-state [:form-editor :record-position :total] 0)
        ;; Mark as new so save knows to INSERT not UPDATE
        new-record {:__new__ true}]
    ;; Add empty record to records array (for continuous forms display)
    (swap! app-state update-in [:form-editor :records] #(conj (vec %) new-record))
    (swap! app-state assoc-in [:form-editor :current-record] new-record)
    (swap! app-state assoc-in [:form-editor :record-position] {:current (inc total) :total (inc total)})
    (swap! app-state assoc-in [:form-editor :record-dirty?] true)))

(defn- update-state-after-delete!
  "Update form state after a record is successfully deleted."
  [new-records pos]
  (let [new-total (count new-records)
        new-pos (min pos new-total)]
    (swap! app-state assoc-in [:form-editor :records] new-records)
    (if (> new-total 0)
      (do
        (swap! app-state assoc-in [:form-editor :record-position] {:current new-pos :total new-total})
        (swap! app-state assoc-in [:form-editor :current-record] (nth new-records (dec new-pos))))
      (do
        (swap! app-state assoc-in [:form-editor :record-position] {:current 0 :total 0})
        (swap! app-state assoc-in [:form-editor :current-record] {})))
    (swap! app-state assoc-in [:form-editor :record-dirty?] false)))

(defn delete-current-record!
  "Delete the current record from the database"
  []
  (let [record-source (get-in @app-state [:form-editor :current :record-source])
        current-record (get-in @app-state [:form-editor :current-record])
        records (get-in @app-state [:form-editor :records] [])
        pos (get-in @app-state [:form-editor :record-position :current] 1)]
    (when (and record-source current-record)
      (let [pk-field-name (detect-pk-field (get-record-source-fields record-source))
            pk-value (pk-value-for-record current-record pk-field-name)]
        (when pk-value
          (go
            (let [response (<! (http/delete (str api-base "/api/data/" record-source "/" pk-value)
                                            {:headers (db-headers)}))]
              (if (:success response)
                (update-state-after-delete!
                  (vec (concat (subvec records 0 (dec pos)) (subvec records pos))) pos)
                (log-error! "Failed to delete record" "delete-record" {:response (:body response)})))))))))

(defn get-record-source-fields
  "Get fields for a record source (table or query)"
  [record-source]
  (when record-source
    (let [tables (get-in @app-state [:objects :tables])
          queries (get-in @app-state [:objects :queries])
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

;; ============================================================
;; ROW-SOURCE CACHE (combobox/listbox population)
;; ============================================================

(defn clear-row-source-cache!
  "Reset the row-source cache. Called when switching forms."
  []
  (swap! app-state assoc-in [:form-editor :row-source-cache] {}))

(defn- cache-row-source! [row-source data]
  (swap! app-state assoc-in [:form-editor :row-source-cache row-source] data))

(defn- parse-value-list
  "Parse semicolon-delimited value list into row-source cache format."
  [trimmed]
  (let [items (->> (str/split trimmed #";")
                   (mapv str/trim)
                   (filterv #(not (str/blank? %)))
                   (mapv #(str/replace % #"^\"|\"$" "")))]
    {:rows (mapv (fn [v] {"value" v}) items) :fields [{:name "value"}]}))

(defn- fetch-sql-row-source!
  "Fetch row-source via SQL query execution."
  [row-source trimmed]
  (go
    (let [response (<! (http/post (str api-base "/api/queries/run")
                                  {:json-params {:sql trimmed} :headers (db-headers)}))]
      (cache-row-source! row-source
        (if (:success response)
          {:rows (or (get-in response [:body :data]) [])
           :fields (or (get-in response [:body :fields]) [])}
          {:rows [] :fields [] :error true})))))

(defn- fetch-table-row-source!
  "Fetch row-source from a table/query name."
  [row-source trimmed]
  (go
    (let [response (<! (http/get (str api-base "/api/data/" trimmed)
                                 {:query-params {:limit 1000} :headers (db-headers)}))]
      (cache-row-source! row-source
        (if (:success response)
          (let [data (get-in response [:body :data] [])]
            {:rows data
             :fields (if (seq data)
                       (mapv (fn [k] {:name (name k)}) (keys (first data)))
                       [])})
          {:rows [] :fields [] :error true})))))

(defn fetch-row-source!
  "Fetch and cache row-source data for a combobox/listbox."
  [row-source]
  (when (and row-source (not (str/blank? row-source)))
    (when-not (get-in @app-state [:form-editor :row-source-cache row-source])
      (cache-row-source! row-source :loading)
      (let [trimmed (str/trim row-source)]
        (cond
          (and (not (re-find #"(?i)^select\s" trimmed))
               (str/includes? trimmed ";"))
          (cache-row-source! row-source (parse-value-list trimmed))

          (re-find #"(?i)^select\s" trimmed)
          (fetch-sql-row-source! row-source trimmed)

          :else
          (fetch-table-row-source! row-source trimmed))))))

(defn get-row-source-options
  "Returns cached row-source data. nil if not loaded, :loading if in-flight,
   {:rows [...] :fields [...]} if ready."
  [row-source]
  (get-in @app-state [:form-editor :row-source-cache row-source]))

;; ============================================================
;; SUBFORM CACHE (child form definition + child records)
;; ============================================================

(defn clear-subform-cache!
  "Reset the subform cache. Called when switching forms."
  []
  (swap! app-state assoc-in [:form-editor :subform-cache] {}))

(defn fetch-subform-definition!
  "Fetch and cache a child form definition for a subform control."
  [source-form-name]
  (when (and source-form-name (not (str/blank? source-form-name)))
    (let [cached (get-in @app-state [:form-editor :subform-cache source-form-name :definition])]
      (when-not cached
        (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :definition] :loading)
        (go
          (let [response (<! (http/get (str api-base "/api/forms/" source-form-name)
                                        {:headers (db-headers)}))]
            (if (:success response)
              (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :definition]
                     (:body response))
              (do
                (log-event! "error" (str "Failed to fetch subform definition: " source-form-name) "fetch-subform-definition")
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :definition]
                       {:error true})))))))))

(defn fetch-subform-records!
  "Fetch and cache child records for a subform, filtered by parent link fields.
   Only re-fetches when the filter key (master field values) changes."
  [source-form-name record-source link-child-fields link-master-fields current-record]
  (when (and source-form-name record-source (seq link-child-fields) (seq link-master-fields))
    (let [;; Build filter from paired child/master fields
          filter-map (reduce (fn [m [child-field master-field]]
                               (let [master-val (or (get current-record (keyword master-field))
                                                    (get current-record master-field))]
                                 (if master-val
                                   (assoc m child-field master-val)
                                   m)))
                             {}
                             (map vector link-child-fields link-master-fields))
          filter-key (pr-str filter-map)
          cached-filter-key (get-in @app-state [:form-editor :subform-cache source-form-name :filter-key])]
      (when (and (seq filter-map) (not= filter-key cached-filter-key))
        (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :filter-key] filter-key)
        (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :records] :loading)
        (go
          (let [response (<! (http/get (str api-base "/api/data/" record-source)
                                        {:query-params {:limit 1000
                                                        :filter (.stringify js/JSON (clj->js filter-map))}
                                         :headers (db-headers)}))]
            (if (:success response)
              (let [data (get-in response [:body :data] [])]
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :records]
                       (vec data)))
              (do
                (log-event! "error" (str "Failed to fetch subform records: " source-form-name) "fetch-subform-records" {:response (:body response)})
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :records]
                       [])))))))))

(defn save-subform-cell!
  "Save an edited cell value in a subform record.
   Optimistic local update, then PUT to API. On error, clear filter-key to force re-fetch."
  [source-form-name row-idx col-name value]
  (let [cache-path [:form-editor :subform-cache source-form-name]
        definition (get-in @app-state (conj cache-path :definition))
        child-record-source (when (map? definition)
                              (or (:record-source definition) (:record_source definition)))
        records (get-in @app-state (conj cache-path :records))]
    (when (and child-record-source (vector? records) (< row-idx (count records)))
      (let [record (nth records row-idx)
            fields (get-record-source-fields child-record-source)
            pk-field-name (or (some #(when (:pk %) (:name %)) fields) "id")
            pk-value (or (get record (keyword pk-field-name))
                         (get record pk-field-name))]
        (when pk-value
          ;; Optimistic local update
          (swap! app-state assoc-in (conj cache-path :records row-idx (keyword col-name)) value)
          (go
            (let [response (<! (http/put (str api-base "/api/data/" child-record-source "/" pk-value)
                                          {:json-params {col-name value}
                                           :headers (db-headers)}))]
              (when-not (:success response)
                (log-event! "error" "Failed to save subform cell" "save-subform-cell" {:response (:body response)})
                ;; Clear filter-key to force re-fetch
                (swap! app-state assoc-in (conj cache-path :filter-key) nil)))))))))

(defn new-subform-record!
  "Create a new child record in a subform, pre-populated with link field values."
  [source-form-name link-child-fields link-master-fields current-record]
  (let [cache-path [:form-editor :subform-cache source-form-name]
        definition (get-in @app-state (conj cache-path :definition))
        child-record-source (when (map? definition)
                              (or (:record-source definition) (:record_source definition)))]
    (when child-record-source
      (let [;; Build new record with link values pre-populated
            new-data (reduce (fn [m [child-field master-field]]
                               (let [master-val (or (get current-record (keyword master-field))
                                                    (get current-record master-field))]
                                 (if master-val
                                   (assoc m child-field master-val)
                                   m)))
                             {}
                             (map vector link-child-fields link-master-fields))]
        (go
          (let [response (<! (http/post (str api-base "/api/data/" child-record-source)
                                         {:json-params new-data
                                          :headers (db-headers)}))]
            (if (:success response)
              ;; Clear filter-key to force re-fetch
              (swap! app-state assoc-in (conj cache-path :filter-key) nil)
              (log-event! "error" "Failed to create subform record" "new-subform-record" {:response (:body response)}))))))))

(defn delete-subform-record!
  "Delete a child record from a subform by row index."
  [source-form-name row-idx]
  (let [cache-path [:form-editor :subform-cache source-form-name]
        definition (get-in @app-state (conj cache-path :definition))
        child-record-source (when (map? definition)
                              (or (:record-source definition) (:record_source definition)))
        records (get-in @app-state (conj cache-path :records))]
    (when (and child-record-source (vector? records) (< row-idx (count records)))
      (let [record (nth records row-idx)
            fields (get-record-source-fields child-record-source)
            pk-field-name (or (some #(when (:pk %) (:name %)) fields) "id")
            pk-value (or (get record (keyword pk-field-name))
                         (get record pk-field-name))]
        (when pk-value
          (go
            (let [response (<! (http/delete (str api-base "/api/data/" child-record-source "/" pk-value)
                                             {:headers (db-headers)}))]
              (if (:success response)
                ;; Clear filter-key to force re-fetch
                (swap! app-state assoc-in (conj cache-path :filter-key) nil)
                (log-event! "error" "Failed to delete subform record" "delete-subform-record" {:response (:body response)})))))))))

;; ============================================================
;; FORM-ONLY CONSTANTS
;; ============================================================

(def ^:private yes-no-form-props
  "Form properties that use yes/no (1/0) values."
  [:popup :modal :allow-additions :allow-deletions :allow-edits
   :navigation-buttons :record-selectors :dividing-lines :data-entry])

(def ^:private yes-no-defaults
  "Default values for yes/no form properties (matching Access defaults)."
  {:popup 0 :modal 0 :allow-additions 1 :allow-deletions 1 :allow-edits 1
   :navigation-buttons 1 :record-selectors 1 :dividing-lines 1 :data-entry 0})

(def ^:private number-form-props
  "Form properties that should be numbers."
  [:width])

;; ============================================================
;; FORM NORMALIZATION & EDITOR SETUP
;; ============================================================

(defn- normalize-section
  "Normalize all controls in a form section (header/detail/footer)."
  [section]
  (if (:controls section)
    (update section :controls #(mapv normalize-control %))
    section))

(defn- normalize-form-definition [definition]
  "Apply defaults and normalize types across the full form tree."
  (-> (reduce (fn [def prop]
                (let [v (get def prop)]
                  (if (nil? v)
                    (assoc def prop (get yes-no-defaults prop 0))
                    (assoc def prop (coerce-yes-no v)))))
              definition
              yes-no-form-props)
      (#(reduce (fn [d prop]
                  (if (contains? d prop)
                    (assoc d prop (coerce-to-number (get d prop)))
                    d))
                % number-form-props))
      (update :header normalize-section)
      (update :detail normalize-section)
      (update :footer normalize-section)))

(defn- setup-form-editor!
  "Initialize the form editor state with a normalized definition."
  [form-id definition]
  (swap! app-state assoc :form-editor
         {:form-id form-id
          :dirty? false
          :original definition
          :current definition
          :selected-control nil
          :synced-controls (build-synced-controls definition)})
  (maybe-auto-analyze!)
  (set-view-mode! :view))

(defn- auto-save-form-state!
  "Auto-save dirty record and/or form definition before switching."
  []
  (when (get-in @app-state [:form-editor :record-dirty?])
    (save-current-record!))
  (when (get-in @app-state [:form-editor :dirty?])
    (save-form!)))

(defn load-form-for-editing! [form]
  (auto-save-form-state!)
  (clear-row-source-cache!)
  (clear-subform-cache!)
  (if (:definition form)
    (setup-form-editor! (:id form) (normalize-form-definition (:definition form)))
    (go
      (let [response (<! (http/get (str api-base "/api/forms/" (:filename form))
                                    {:headers (db-headers)}))]
        (if (:success response)
          (let [definition (normalize-form-definition (dissoc (:body response) :id :name))]
            (swap! app-state update-in [:objects :forms]
                   (fn [forms]
                     (mapv #(if (= (:id %) (:id form))
                              (assoc % :definition definition) %)
                           forms)))
            (setup-form-editor! (:id form) definition))
          (log-error! (str "Failed to load form: " (:filename form)) "load-form-for-editing" {:form (:filename form)}))))))

(defn select-control! [idx]
  (swap! app-state assoc-in [:form-editor :selected-control] idx))

;; ============================================================
;; FORM CONTROL OPERATIONS
;; ============================================================

(defn delete-control!
  "Delete a control from a section"
  [section idx]
  (let [form-editor (:form-editor @app-state)
        current (:current form-editor)
        controls (or (get-in current [section :controls]) [])]
    (when (< idx (count controls))
      (let [new-controls (vec (concat (subvec controls 0 idx)
                                      (subvec controls (inc idx))))]
        (swap! app-state assoc-in [:form-editor :selected-control] nil)
        (set-form-definition! (assoc-in current [section :controls] new-controls))))))

(defn update-control!
  "Update a property of a control in a section"
  [section idx prop value]
  (let [form-editor (:form-editor @app-state)
        current (:current form-editor)
        controls (or (get-in current [section :controls]) [])]
    (when (< idx (count controls))
      (set-form-definition!
       (assoc-in current [section :controls]
                 (update controls idx assoc prop value))))))
