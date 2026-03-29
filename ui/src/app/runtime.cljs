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

(defn close-form [& [form-name]]
  (if form-name
    ;; Close a specific form by name
    (let [form-obj (find-object-by-name :forms form-name)]
      (if form-obj
        (state/close-tab! :forms (:id form-obj))
        (do (js/console.warn "AC.closeForm: form not found:" form-name)
            (state/invoke-callback :close-current-tab))))
    ;; No name — close the current tab
    (state/invoke-callback :close-current-tab)))

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
      ;; Update :source-form on the control definition so render-subform picks it up
      (swap! app-state update-in [:form-editor :current]
             (fn [form-def]
               (reduce (fn [fd section-key]
                         (update-in fd [section-key :controls]
                                    (fn [ctrls]
                                      (mapv (fn [c]
                                              (if (= (projection/ctrl->kw (:name c)) ctrl-kw)
                                                (assoc c :source-form source-object)
                                                c))
                                            ctrls))))
                       form-def
                       [:header :detail :footer]))))))

(defn get-value [control-name]
  (let [ctrl-kw (projection/ctrl->kw control-name)
        cs (when ctrl-kw (get-in @app-state [:form-editor :projection :control-state ctrl-kw]))
        record (get-in @app-state [:form-editor :projection :record])]
    ;; Try control-state caption first, then bound field value from record
    (or (when cs (:caption cs))
        (when (and ctrl-kw record) (get record ctrl-kw))
        nil)))

(defn get-visible [control-name]
  (let [ctrl-kw (projection/ctrl->kw control-name)
        cs (when ctrl-kw (get-in @app-state [:form-editor :projection :control-state ctrl-kw]))]
    (if cs
      (not= false (:visible cs))
      true)))

(defn get-enabled [control-name]
  (let [ctrl-kw (projection/ctrl->kw control-name)
        cs (when ctrl-kw (get-in @app-state [:form-editor :projection :control-state ctrl-kw]))]
    (if cs
      (not= false (:enabled cs))
      true)))

(defn is-dirty []
  (boolean (get-in @app-state [:form-editor :projection :dirty?])))

(defn is-new-record []
  (let [record (get-in @app-state [:form-editor :projection :record])]
    (boolean (:__new__ record))))

(defn get-open-args []
  ;; Stub — future: thread OpenForm args through form open flow
  nil)

(defn nz [value default-val]
  (if (nil? value)
    (if (nil? default-val) "" default-val)
    value))

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
                 :runSQL           run-sql
                 :getValue         get-value
                 :getVisible       get-visible
                 :getEnabled       get-enabled
                 :isDirty          is-dirty
                 :isNewRecord      is-new-record
                 :getOpenArgs      get-open-args
                 :nz               nz}]
    (set! (.-AC js/window) api)))
