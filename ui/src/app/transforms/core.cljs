(ns app.transforms.core
  "Transform runner and dispatch infrastructure.

   Connects pure transform functions to the app-state atom.
   All transforms are registered by keyword name and can be dispatched
   via (dispatch! :transform-name arg1 arg2 ...).

   Transforms are pure: (state, args) -> state.
   dispatch! applies the transform and swap!s the result into the atom."
  (:require [app.state :refer [app-state]]
            [app.transforms.ui :as ui]
            [app.transforms.chat :as chat]
            [app.transforms.form :as form]
            [app.transforms.report :as report]
            [app.transforms.table :as table]
            [app.transforms.query :as query]
            [app.transforms.module :as module]
            [app.transforms.macro :as macro]
            [app.transforms.logs :as logs]
            [app.transforms.sql-function :as sql-function]
            [app.transforms.app :as app]
            [app.transforms.notes :as notes]))

;; ============================================================
;; TRANSFORM REGISTRY
;; Maps keyword name -> pure function (state, args...) -> state
;; ============================================================

(def registry
  {;; UI domain (16)
   :set-loading             ui/set-loading
   :set-error               ui/set-error
   :clear-error             ui/clear-error
   :set-available-databases ui/set-available-databases
   :set-current-database    ui/set-current-database
   :set-loading-objects     ui/set-loading-objects
   :toggle-sidebar          ui/toggle-sidebar
   :set-sidebar-object-type ui/set-sidebar-object-type
   :set-objects             ui/set-objects
   :add-object              ui/add-object
   :update-object           ui/update-object
   :open-options-dialog     ui/open-options-dialog
   :close-options-dialog    ui/close-options-dialog
   :set-grid-size           ui/set-grid-size
   :show-context-menu       ui/show-context-menu
   :hide-context-menu       ui/hide-context-menu

   ;; Chat domain (5)
   :toggle-chat-panel       chat/toggle-chat-panel
   :open-chat-panel         chat/open-chat-panel
   :set-chat-input          chat/set-chat-input
   :add-chat-message        chat/add-chat-message
   :set-chat-loading        chat/set-chat-loading

   ;; Form domain (17)
   :set-form-definition     form/set-form-definition
   :clear-lint-errors       form/clear-lint-errors
   :set-lint-errors         form/set-lint-errors
   :show-form-context-menu  form/show-form-context-menu
   :hide-form-context-menu  form/hide-form-context-menu
   :new-record              form/new-record
   :set-current-record      form/set-current-record
   :set-record-position     form/set-record-position
   :select-control          form/select-control
   :delete-control          form/delete-control
   :update-control          form/update-control
   :clear-row-source-cache  form/clear-row-source-cache
   :cache-row-source        form/cache-row-source
   :clear-subform-cache     form/clear-subform-cache
   :copy-form-record        form/copy-form-record
   :toggle-form-header-footer form/toggle-form-header-footer

   :set-form-properties-tab   form/set-form-properties-tab

   ;; Report domain (9)
   :set-report-definition     report/set-report-definition
   :clear-report-lint-errors  report/clear-report-lint-errors
   :set-report-lint-errors    report/set-report-lint-errors
   :select-report-control     report/select-report-control
   :update-report-control     report/update-report-control
   :delete-report-control     report/delete-report-control
   :add-group-level           report/add-group-level
   :remove-group-level        report/remove-group-level
   :set-report-properties-tab report/set-report-properties-tab

   ;; Table domain (19)
   :select-table-field       table/select-table-field
   :select-table-cell        table/select-table-cell
   :select-table-row         table/select-table-row
   :start-editing-cell       table/start-editing-cell
   :stop-editing-cell        table/stop-editing-cell
   :move-to-next-cell        table/move-to-next-cell
   :show-table-context-menu  table/show-table-context-menu
   :hide-table-context-menu  table/hide-table-context-menu
   :copy-table-cell          table/copy-table-cell
   :cut-table-cell           table/cut-table-cell
   :set-new-table-name       table/set-new-table-name
   :revert-design            table/revert-design
   :select-design-field      table/select-design-field
   :update-design-field      table/update-design-field
   :add-design-field         table/add-design-field
   :remove-design-field      table/remove-design-field
   :toggle-design-pk         table/toggle-design-pk
   :update-table-description table/update-table-description
   :init-design-editing      table/init-design-editing

   ;; Query domain (2)
   :update-query-sql        query/update-query-sql
   :update-query-name       query/update-query-name

   ;; SQL Function domain (3)
   :update-fn-source          sql-function/update-fn-source
   :update-fn-name            sql-function/update-fn-name
   :track-sql-function        sql-function/track-sql-function

   ;; Module domain (9)
   :update-module-cljs-source module/update-module-cljs-source
   :set-module-status         module/set-module-status
   :update-module-review-notes module/update-module-review-notes
   :set-module-cljs-dirty     module/set-module-cljs-dirty
   :set-module-intents        module/set-module-intents
   :set-extracting-intents    module/set-extracting-intents
   :resolve-gap               module/resolve-gap
   :set-gap-questions         module/set-gap-questions
   :set-gap-selection         module/set-gap-selection

   ;; Macro domain (1)
   :set-macro-status        macro/set-macro-status

   ;; Logs domain (1)
   :set-logs-filter          logs/set-logs-filter

   ;; App Viewer domain (16)
   :set-app-pane             app/set-app-pane
   :set-app-overview         app/set-app-overview
   :set-app-loading          app/set-app-loading
   :set-batch-extracting     app/set-batch-extracting
   :set-batch-progress       app/set-batch-progress
   :set-batch-extract-results app/set-batch-extract-results
   :set-all-gap-questions    app/set-all-gap-questions
   :set-app-gap-selection    app/set-app-gap-selection
   :set-submitting-gaps      app/set-submitting-gaps
   :set-batch-generating     app/set-batch-generating
   :set-batch-gen-progress   app/set-batch-gen-progress
   :set-batch-gen-results    app/set-batch-gen-results
   :set-app-dependencies     app/set-app-dependencies
   :set-app-api-surface      app/set-app-api-surface
   :set-import-mode          app/set-import-mode
   :set-auto-resolving-gaps  app/set-auto-resolving-gaps
   :set-all-gap-selections   app/set-all-gap-selections
   :set-module-pipeline-status   app/set-module-pipeline-status
   :set-module-pipeline-statuses app/set-module-pipeline-statuses
   :set-pipeline-running         app/set-pipeline-running

   ;; Notes/Corpus domain (6)
   :set-notes-entries       notes/set-notes-entries
   :add-notes-entry         notes/add-notes-entry
   :set-notes-selected      notes/set-notes-selected
   :set-notes-input         notes/set-notes-input
   :set-notes-loading       notes/set-notes-loading
   :set-notes-read-entry    notes/set-notes-read-entry})

;; ============================================================
;; DISPATCH
;; ============================================================

(defn apply-transform
  "Apply a named transform to a state value (pure — no atom).
   Returns the new state, or throws if transform not found."
  [transform-name state & args]
  (if-let [f (get registry transform-name)]
    (apply f state args)
    (throw (ex-info (str "Unknown transform: " transform-name)
                    {:transform transform-name}))))

(defn dispatch!
  "Look up a transform by name, apply it to current app-state, and swap! the result.
   Returns the new state value."
  [transform-name & args]
  (if-let [f (get registry transform-name)]
    (apply swap! app-state f args)
    (throw (ex-info (str "Unknown transform: " transform-name)
                    {:transform transform-name}))))

;; ============================================================
;; COMPOSITION HELPERS
;; ============================================================

(defn compose
  "Compose multiple transforms into a single transform function.
   Each step is [transform-name & args].

   (compose [[:set-loading true]
             [:clear-error]])

   Returns a function (state) -> state."
  [steps]
  (fn [state]
    (reduce (fn [s [tname & args]]
              (apply apply-transform tname s args))
            state
            steps)))

(defn dispatch-all!
  "Apply a sequence of transform steps atomically (single swap!).
   Each step is [transform-name & args].

   (dispatch-all! [[:set-loading true]
                   [:clear-error]
                   [:set-form-definition new-def]])"
  [steps]
  (swap! app-state (compose steps)))

(defn transform-names
  "Return sorted vector of all registered transform names."
  []
  (vec (sort (keys registry))))

(defn transform-count
  "Return the number of registered transforms."
  []
  (count registry))
