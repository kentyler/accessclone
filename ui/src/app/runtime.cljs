(ns app.runtime
  "JavaScript runtime API (window.AC) for generated event handlers.
   VBA is translated to JS that calls AC.openForm(), AC.closeForm(), etc.
   These functions delegate to the existing ClojureScript framework."
  (:require [app.state :as state :refer [app-state]]
            [app.projection :as projection]
            [app.transforms.core :as t]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

(defn- find-object-by-name [object-type name]
  (let [objects (get-in @app-state [(case object-type
                                      :forms :forms
                                      :reports :reports
                                      :forms) :data])
        name-lower (when name (.toLowerCase name))]
    (first (filter #(= (.toLowerCase (or (:filename %) "")) name-lower) objects))))

(defn open-form [form-name & [where-filter]]
  (let [form-obj (find-object-by-name :forms form-name)]
    (if form-obj
      (state/open-object! :forms (:id form-obj))
      (js/console.warn "AC.openForm: form not found:" form-name))))

(defn open-report [report-name]
  (let [report-obj (find-object-by-name :reports report-name)]
    (if report-obj
      (state/open-object! :reports (:id report-obj))
      (js/console.warn "AC.openReport: report not found:" report-name))))

(defn close-form []
  (state/invoke-callback :close-current-tab))

(defn goto-record [target]
  (let [records (get-in @app-state [:form-editor :projection :records] [])
        total (count records)
        pos (case target
              "new" nil
              "first" 1
              "last" total
              "next" (min total (inc (get-in @app-state [:form-editor :projection :position] 1)))
              "previous" (max 1 (dec (get-in @app-state [:form-editor :projection :position] 1)))
              1)]
    (if (= target "new")
      (t/dispatch! :new-record)
      (state/invoke-callback :navigate-to-record pos))))

(defn save-record []
  (state/invoke-callback :save-current-record))

(defn requery []
  (state/invoke-callback :refresh-form))

(defn set-visible [control-name visible?]
  (let [ctrl-kw (projection/ctrl->kw control-name)]
    (when ctrl-kw
      (swap! app-state update-in [:form-editor :projection]
             projection/set-control-state ctrl-kw :visible visible?))))

(defn set-enabled [control-name enabled?]
  (let [ctrl-kw (projection/ctrl->kw control-name)]
    (when ctrl-kw
      (swap! app-state update-in [:form-editor :projection]
             projection/set-control-state ctrl-kw :enabled enabled?))))

(defn set-value [control-name value]
  (let [ctrl-kw (projection/ctrl->kw control-name)]
    (when ctrl-kw
      (swap! app-state update-in [:form-editor :projection]
             projection/set-control-state ctrl-kw :caption (str value)))))

(defn set-subform-source [subform-control-name source-object]
  (let [ctrl-kw (projection/ctrl->kw subform-control-name)]
    (when ctrl-kw
      (swap! app-state assoc-in
             [:form-editor :projection :subform-sources ctrl-kw] source-object)
      ;; Also update the control definition so the subform re-renders
      (swap! app-state update-in [:form-editor :current]
             (fn [form-def]
               (reduce (fn [fd section-key]
                         (update-in fd [section-key :controls]
                                    (fn [ctrls]
                                      (mapv (fn [c]
                                              (if (= (projection/ctrl->kw (:name c)) ctrl-kw)
                                                (assoc c :source-object source-object)
                                                c))
                                            ctrls))))
                       form-def
                       [:header :detail :footer]))))))

(defn run-sql [sql]
  (go
    (let [resp (<! (http/post (str state/api-base "/api/queries/execute")
                              {:json-params {:sql sql}
                               :headers (state/db-headers)}))]
      (when-not (:success resp)
        (js/console.warn "AC.runSQL failed:" (:body resp))))))

(defn ^:export install!
  "Install the AC runtime on window. Called once at app init."
  []
  (let [api #js {:openForm         open-form
                 :openReport       open-report
                 :closeForm        close-form
                 :gotoRecord       goto-record
                 :saveRecord       save-record
                 :requery          requery
                 :setVisible       set-visible
                 :setEnabled       set-enabled
                 :setValue          set-value
                 :setSubformSource set-subform-source
                 :runSQL           run-sql}]
    (set! (.-AC js/window) api)))
