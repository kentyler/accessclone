(ns app.state-transforms
  "Data-driven catalog of every pure state transform in the app-state atom.

   This file is the single source of truth for what reads/writes each path.
   An LLM can answer questions like 'what writes to [:form-editor :dirty?]?'
   without reading 3000+ lines of code.

   Each transform descriptor contains:
     :name    - keyword identifier
     :fn-ref  - quoted symbol pointing to the function
     :domain  - category (:ui :chat :form :report :table :query :module :macro :logs)
     :args    - vector of {:name symbol :type keyword} argument descriptions
     :reads   - vector of state paths read from app-state
     :writes  - vector of state paths written to app-state
     :desc    - human-readable description"
  (:require [app.state-schema :as schema]
            [clojure.set :as set]
            [clojure.string :as str]))

;; ============================================================
;; TRANSFORM REGISTRY
;; ============================================================

(def transforms
  {;; ----------------------------------------------------------
   ;; UI domain (16) — from state.cljs
   ;; ----------------------------------------------------------
   :set-loading!
   {:name    :set-loading!
    :fn-ref  'app.state/set-loading!
    :domain  :ui
    :args    [{:name 'loading? :type :boolean}]
    :reads   []
    :writes  [[:loading?]]
    :desc    "Set the global loading spinner state"}

   :set-error!
   {:name    :set-error!
    :fn-ref  'app.state/set-error!
    :domain  :ui
    :args    [{:name 'error :type [:or :string :nil]}]
    :reads   []
    :writes  [[:error]]
    :desc    "Set the global error banner message"}

   :clear-error!
   {:name    :clear-error!
    :fn-ref  'app.state/clear-error!
    :domain  :ui
    :args    []
    :reads   []
    :writes  [[:error]]
    :desc    "Clear the global error banner"}

   :set-available-databases!
   {:name    :set-available-databases!
    :fn-ref  'app.state/set-available-databases!
    :domain  :ui
    :args    [{:name 'databases :type [:vector :map]}]
    :reads   []
    :writes  [[:available-databases]]
    :desc    "Replace the list of available databases"}

   :set-current-database!
   {:name    :set-current-database!
    :fn-ref  'app.state/set-current-database!
    :domain  :ui
    :args    [{:name 'db :type [:or :map :nil]}]
    :reads   []
    :writes  [[:current-database]]
    :desc    "Set the currently selected database"}

   :set-loading-objects!
   {:name    :set-loading-objects!
    :fn-ref  'app.state/set-loading-objects!
    :domain  :ui
    :args    [{:name 'loading? :type :boolean}]
    :reads   []
    :writes  [[:loading-objects?]]
    :desc    "Set whether objects are loading after database switch"}

   :toggle-sidebar!
   {:name    :toggle-sidebar!
    :fn-ref  'app.state/toggle-sidebar!
    :domain  :ui
    :args    []
    :reads   [[:sidebar-collapsed?]]
    :writes  [[:sidebar-collapsed?]]
    :desc    "Toggle the sidebar collapsed state"}

   :set-sidebar-object-type!
   {:name    :set-sidebar-object-type!
    :fn-ref  'app.state/set-sidebar-object-type!
    :domain  :ui
    :args    [{:name 'object-type :type :keyword}]
    :reads   []
    :writes  [[:sidebar-object-type]]
    :desc    "Set which object type the sidebar shows"}

   :set-objects!
   {:name    :set-objects!
    :fn-ref  'app.state/set-objects!
    :domain  :ui
    :args    [{:name 'object-type :type :keyword}
              {:name 'objects :type [:vector :map]}]
    :reads   []
    :writes  [[:objects :*]]
    :desc    "Replace all objects of a given type"}

   :add-object!
   {:name    :add-object!
    :fn-ref  'app.state/add-object!
    :domain  :ui
    :args    [{:name 'object-type :type :keyword}
              {:name 'obj :type :map}]
    :reads   []
    :writes  [[:objects :*]]
    :desc    "Append an object to a type's collection"}

   :update-object!
   {:name    :update-object!
    :fn-ref  'app.state/update-object!
    :domain  :ui
    :args    [{:name 'object-type :type :keyword}
              {:name 'id :type :number}
              {:name 'updates :type :map}]
    :reads   [[:objects :*]]
    :writes  [[:objects :*]]
    :desc    "Merge updates into an object by type and id"}

   :open-options-dialog!
   {:name    :open-options-dialog!
    :fn-ref  'app.state/open-options-dialog!
    :domain  :ui
    :args    []
    :reads   []
    :writes  [[:options-dialog-open?]]
    :desc    "Open the options/settings dialog"}

   :close-options-dialog!
   {:name    :close-options-dialog!
    :fn-ref  'app.state/close-options-dialog!
    :domain  :ui
    :args    []
    :reads   []
    :writes  [[:options-dialog-open?]]
    :desc    "Close the options/settings dialog"}

   :set-grid-size!
   {:name    :set-grid-size!
    :fn-ref  'app.state/set-grid-size!
    :domain  :ui
    :args    [{:name 'size :type :number}]
    :reads   []
    :writes  [[:config :form-designer :grid-size]]
    :desc    "Set the snap grid size in form design mode"}

   :show-context-menu!
   {:name    :show-context-menu!
    :fn-ref  'app.state/show-context-menu!
    :domain  :ui
    :args    [{:name 'x :type :number}
              {:name 'y :type :number}]
    :reads   []
    :writes  [[:context-menu]]
    :desc    "Show the sidebar context menu at position"}

   :hide-context-menu!
   {:name    :hide-context-menu!
    :fn-ref  'app.state/hide-context-menu!
    :domain  :ui
    :args    []
    :reads   []
    :writes  [[:context-menu]]
    :desc    "Hide the sidebar context menu"}

   ;; ----------------------------------------------------------
   ;; Chat domain (4) — from state.cljs
   ;; ----------------------------------------------------------
   :toggle-chat-panel!
   {:name    :toggle-chat-panel!
    :fn-ref  'app.state/toggle-chat-panel!
    :domain  :chat
    :args    []
    :reads   [[:chat-panel-open?]]
    :writes  [[:chat-panel-open?]]
    :desc    "Toggle the chat panel visibility"}

   :set-chat-input!
   {:name    :set-chat-input!
    :fn-ref  'app.state/set-chat-input!
    :domain  :chat
    :args    [{:name 'text :type :string}]
    :reads   []
    :writes  [[:chat-input]]
    :desc    "Set the chat input text"}

   :add-chat-message!
   {:name    :add-chat-message!
    :fn-ref  'app.state/add-chat-message!
    :domain  :chat
    :args    [{:name 'role :type :string}
              {:name 'content :type :string}]
    :reads   []
    :writes  [[:chat-messages]]
    :desc    "Append a message to the chat transcript"}

   :set-chat-loading!
   {:name    :set-chat-loading!
    :fn-ref  'app.state/set-chat-loading!
    :domain  :chat
    :args    [{:name 'loading? :type :boolean}]
    :reads   []
    :writes  [[:chat-loading?]]
    :desc    "Set whether the chat is waiting for LLM response"}

   ;; ----------------------------------------------------------
   ;; Form domain (16) — from state_form.cljs
   ;; ----------------------------------------------------------
   :set-form-definition!
   {:name    :set-form-definition!
    :fn-ref  'app.state-form/set-form-definition!
    :domain  :form
    :args    [{:name 'definition :type :map}]
    :reads   [[:form-editor :original]]
    :writes  [[:form-editor :current] [:form-editor :dirty?]]
    :desc    "Replace current form definition and recompute dirty flag"}

   :clear-lint-errors!
   {:name    :clear-lint-errors!
    :fn-ref  'app.state-form/clear-lint-errors!
    :domain  :form
    :args    []
    :reads   []
    :writes  [[:form-editor :lint-errors]]
    :desc    "Clear form lint validation errors"}

   :set-lint-errors!
   {:name    :set-lint-errors!
    :fn-ref  'app.state-form/set-lint-errors!
    :domain  :form
    :args    [{:name 'errors :type [:vector :map]}]
    :reads   []
    :writes  [[:form-editor :lint-errors]]
    :desc    "Set form lint validation errors"}

   :show-form-context-menu!
   {:name    :show-form-context-menu!
    :fn-ref  'app.state-form/show-form-context-menu!
    :domain  :form
    :args    [{:name 'x :type :number}
              {:name 'y :type :number}]
    :reads   []
    :writes  [[:form-editor :context-menu]]
    :desc    "Show form view context menu at position"}

   :hide-form-context-menu!
   {:name    :hide-form-context-menu!
    :fn-ref  'app.state-form/hide-form-context-menu!
    :domain  :form
    :args    []
    :reads   []
    :writes  [[:form-editor :context-menu]]
    :desc    "Hide form view context menu"}

   :new-record!
   {:name    :new-record!
    :fn-ref  'app.state-form/new-record!
    :domain  :form
    :args    []
    :reads   [[:form-editor :record-position] [:form-editor :current]]
    :writes  [[:form-editor :records] [:form-editor :current-record]
              [:form-editor :record-position] [:form-editor :record-dirty?]]
    :desc    "Create a new record pre-populated with default values from controls"}

   :set-current-record!
   {:name    :set-current-record!
    :fn-ref  'app.state-form/set-current-record!
    :domain  :form
    :args    [{:name 'record :type [:or :map :nil]}]
    :reads   []
    :writes  [[:form-editor :current-record]]
    :desc    "Set the current record being viewed/edited"}

   :set-record-position!
   {:name    :set-record-position!
    :fn-ref  'app.state-form/set-record-position!
    :domain  :form
    :args    [{:name 'pos :type :number}
              {:name 'total :type :number}]
    :reads   []
    :writes  [[:form-editor :record-position]]
    :desc    "Set the record navigation position"}

   :select-control!
   {:name    :select-control!
    :fn-ref  'app.state-form/select-control!
    :domain  :form
    :args    [{:name 'idx :type [:or :number :nil]}]
    :reads   []
    :writes  [[:form-editor :selected-control]]
    :desc    "Select a control by index in the form editor"}

   :delete-control!
   {:name    :delete-control!
    :fn-ref  'app.state-form/delete-control!
    :domain  :form
    :args    [{:name 'section :type :keyword}
              {:name 'idx :type :number}]
    :reads   [[:form-editor :current] [:form-editor :original]]
    :writes  [[:form-editor :selected-control] [:form-editor :current] [:form-editor :dirty?]]
    :desc    "Delete a control from a form section by index"}

   :update-control!
   {:name    :update-control!
    :fn-ref  'app.state-form/update-control!
    :domain  :form
    :args    [{:name 'section :type :keyword}
              {:name 'idx :type :number}
              {:name 'prop :type :keyword}
              {:name 'value :type :any}]
    :reads   [[:form-editor :current] [:form-editor :original]]
    :writes  [[:form-editor :current] [:form-editor :dirty?]]
    :desc    "Update a property of a control in a form section"}

   :clear-row-source-cache!
   {:name    :clear-row-source-cache!
    :fn-ref  'app.state-form/clear-row-source-cache!
    :domain  :form
    :args    []
    :reads   []
    :writes  [[:form-editor :row-source-cache]]
    :desc    "Reset the combo/list box row-source cache"}

   :cache-row-source!
   {:name    :cache-row-source!
    :fn-ref  'app.state-form/cache-row-source!
    :domain  :form
    :args    [{:name 'row-source :type :string}
              {:name 'data :type :any}]
    :reads   []
    :writes  [[:form-editor :row-source-cache]]
    :desc    "Cache row-source data for a combo/list box (private helper)"}

   :clear-subform-cache!
   {:name    :clear-subform-cache!
    :fn-ref  'app.state-form/clear-subform-cache!
    :domain  :form
    :args    []
    :reads   []
    :writes  [[:form-editor :subform-cache]]
    :desc    "Reset the subform definition/records cache"}

   :copy-form-record!
   {:name    :copy-form-record!
    :fn-ref  'app.state-form/copy-form-record!
    :domain  :form
    :args    []
    :reads   [[:form-editor :current-record]]
    :writes  []
    :desc    "Copy the current record to the form clipboard (external atom, not app-state)"}

   :toggle-form-header-footer!
   {:name    :toggle-form-header-footer!
    :fn-ref  'app.state-form/toggle-form-header-footer!
    :domain  :form
    :args    []
    :reads   [[:form-editor :current] [:form-editor :original]]
    :writes  [[:form-editor :current] [:form-editor :dirty?]]
    :desc    "Toggle form header/footer visibility (saves height when hiding, restores when showing)"}

   ;; ----------------------------------------------------------
   ;; Report domain (8) — from state_report.cljs
   ;; ----------------------------------------------------------
   :set-report-definition!
   {:name    :set-report-definition!
    :fn-ref  'app.state-report/set-report-definition!
    :domain  :report
    :args    [{:name 'definition :type :map}]
    :reads   [[:report-editor :original]]
    :writes  [[:report-editor :current] [:report-editor :dirty?]]
    :desc    "Replace current report definition and recompute dirty flag"}

   :clear-report-lint-errors!
   {:name    :clear-report-lint-errors!
    :fn-ref  'app.state-report/clear-report-lint-errors!
    :domain  :report
    :args    []
    :reads   []
    :writes  [[:report-editor :lint-errors]]
    :desc    "Clear report lint validation errors"}

   :set-report-lint-errors!
   {:name    :set-report-lint-errors!
    :fn-ref  'app.state-report/set-report-lint-errors!
    :domain  :report
    :args    [{:name 'errors :type [:vector :map]}]
    :reads   []
    :writes  [[:report-editor :lint-errors]]
    :desc    "Set report lint validation errors"}

   :select-report-control!
   {:name    :select-report-control!
    :fn-ref  'app.state-report/select-report-control!
    :domain  :report
    :args    [{:name 'selection :type [:or :map :nil]}]
    :reads   []
    :writes  [[:report-editor :selected-control]]
    :desc    "Select a report control, section, or report-level (nil)"}

   :update-report-control!
   {:name    :update-report-control!
    :fn-ref  'app.state-report/update-report-control!
    :domain  :report
    :args    [{:name 'section :type :keyword}
              {:name 'idx :type :number}
              {:name 'prop :type :keyword}
              {:name 'value :type :any}]
    :reads   [[:report-editor :current] [:report-editor :original]]
    :writes  [[:report-editor :current] [:report-editor :dirty?]]
    :desc    "Update a property of a control in a report section"}

   :delete-report-control!
   {:name    :delete-report-control!
    :fn-ref  'app.state-report/delete-report-control!
    :domain  :report
    :args    [{:name 'section :type :keyword}
              {:name 'idx :type :number}]
    :reads   [[:report-editor :current] [:report-editor :original]]
    :writes  [[:report-editor :selected-control] [:report-editor :current] [:report-editor :dirty?]]
    :desc    "Delete a control from a report section by index"}

   :add-group-level!
   {:name    :add-group-level!
    :fn-ref  'app.state-report/add-group-level!
    :domain  :report
    :args    []
    :reads   [[:report-editor :current] [:report-editor :original]]
    :writes  [[:report-editor :current] [:report-editor :dirty?]]
    :desc    "Add a new grouping level with header/footer bands"}

   :remove-group-level!
   {:name    :remove-group-level!
    :fn-ref  'app.state-report/remove-group-level!
    :domain  :report
    :args    []
    :reads   [[:report-editor :current] [:report-editor :original]]
    :writes  [[:report-editor :current] [:report-editor :dirty?]]
    :desc    "Remove the last grouping level and its bands"}

   ;; ----------------------------------------------------------
   ;; Table domain (12) — from state_table.cljs
   ;; ----------------------------------------------------------
   :select-table-field!
   {:name    :select-table-field!
    :fn-ref  'app.state-table/select-table-field!
    :domain  :table
    :args    [{:name 'field-name :type [:or :string :nil]}]
    :reads   []
    :writes  [[:table-viewer :selected-field]]
    :desc    "Select a field in design view for the property sheet"}

   :select-table-cell!
   {:name    :select-table-cell!
    :fn-ref  'app.state-table/select-table-cell!
    :domain  :table
    :args    [{:name 'row-idx :type :number}
              {:name 'col-name :type :string}]
    :reads   []
    :writes  [[:table-viewer :selected] [:table-viewer :context-menu]]
    :desc    "Select a cell in the datasheet and hide context menu"}

   :select-table-row!
   {:name    :select-table-row!
    :fn-ref  'app.state-table/select-table-row!
    :domain  :table
    :args    [{:name 'row-idx :type :number}]
    :reads   []
    :writes  [[:table-viewer :selected]]
    :desc    "Select an entire row in the datasheet"}

   :start-editing-cell!
   {:name    :start-editing-cell!
    :fn-ref  'app.state-table/start-editing-cell!
    :domain  :table
    :args    [{:name 'row-idx :type :number}
              {:name 'col-name :type :string}]
    :reads   []
    :writes  [[:table-viewer :selected] [:table-viewer :editing]]
    :desc    "Start editing a cell (sets both selected and editing)"}

   :stop-editing-cell!
   {:name    :stop-editing-cell!
    :fn-ref  'app.state-table/stop-editing-cell!
    :domain  :table
    :args    []
    :reads   []
    :writes  [[:table-viewer :editing]]
    :desc    "Stop editing the current cell"}

   :move-to-next-cell!
   {:name    :move-to-next-cell!
    :fn-ref  'app.state-table/move-to-next-cell!
    :domain  :table
    :args    [{:name 'shift? :type :boolean}]
    :reads   [[:table-viewer :selected] [:table-viewer :table-info] [:table-viewer :records]]
    :writes  [[:table-viewer :selected] [:table-viewer :editing]]
    :desc    "Move to next (Tab) or previous (Shift+Tab) cell"}

   :show-table-context-menu!
   {:name    :show-table-context-menu!
    :fn-ref  'app.state-table/show-table-context-menu!
    :domain  :table
    :args    [{:name 'x :type :number}
              {:name 'y :type :number}]
    :reads   []
    :writes  [[:table-viewer :context-menu]]
    :desc    "Show table context menu at position"}

   :hide-table-context-menu!
   {:name    :hide-table-context-menu!
    :fn-ref  'app.state-table/hide-table-context-menu!
    :domain  :table
    :args    []
    :reads   []
    :writes  [[:table-viewer :context-menu]]
    :desc    "Hide table context menu"}

   :copy-table-cell!
   {:name    :copy-table-cell!
    :fn-ref  'app.state-table/copy-table-cell!
    :domain  :table
    :args    []
    :reads   [[:table-viewer :selected] [:table-viewer :records]]
    :writes  []
    :desc    "Copy selected cell value to clipboard (external atom, not app-state)"}

   :cut-table-cell!
   {:name    :cut-table-cell!
    :fn-ref  'app.state-table/cut-table-cell!
    :domain  :table
    :args    []
    :reads   [[:table-viewer :selected] [:table-viewer :records]]
    :writes  []
    :desc    "Cut selected cell value to clipboard (external atom, not app-state)"}

   :set-new-table-name!
   {:name    :set-new-table-name!
    :fn-ref  'app.state-table/set-new-table-name!
    :domain  :table
    :args    [{:name 'name :type :string}]
    :reads   []
    :writes  [[:table-viewer :new-table-name]]
    :desc    "Set the name for a new table being created"}

   :revert-design!
   {:name    :revert-design!
    :fn-ref  'app.state-table/revert-design!
    :domain  :table
    :args    []
    :reads   [[:table-viewer :design-original] [:table-viewer :original-description]]
    :writes  [[:table-viewer :design-fields] [:table-viewer :design-dirty?]
              [:table-viewer :design-renames] [:table-viewer :design-errors]
              [:table-viewer :table-description] [:table-viewer :selected-field]]
    :desc    "Reset table design to last-saved state"}

   ;; ----------------------------------------------------------
   ;; Query domain (2) — from state_query.cljs
   ;; ----------------------------------------------------------
   :update-query-sql!
   {:name    :update-query-sql!
    :fn-ref  'app.state-query/update-query-sql!
    :domain  :query
    :args    [{:name 'sql :type :string}]
    :reads   []
    :writes  [[:query-viewer :sql]]
    :desc    "Update the SQL in the query editor"}

   :update-query-name!
   {:name    :update-query-name!
    :fn-ref  'app.state-query/update-query-name!
    :domain  :query
    :args    [{:name 'name :type :string}]
    :reads   []
    :writes  [[:query-viewer :pending-name]]
    :desc    "Set the pending name for a new query"}

   ;; ----------------------------------------------------------
   ;; Module domain (2) — from state.cljs
   ;; ----------------------------------------------------------
   :update-module-cljs-source!
   {:name    :update-module-cljs-source!
    :fn-ref  'app.state/update-module-cljs-source!
    :domain  :module
    :args    [{:name 'new-source :type :string}]
    :reads   []
    :writes  [[:module-viewer :module-info] [:module-viewer :cljs-dirty?]]
    :desc    "Update the ClojureScript source in the module editor (marks dirty)"}

   :set-module-status!
   {:name    :set-module-status!
    :fn-ref  'app.state/set-module-status!
    :domain  :module
    :args    [{:name 'status :type :string}
              {:name 'review-notes :type [:or :string :nil] :optional true}]
    :reads   []
    :writes  [[:module-viewer :module-info] [:module-viewer :cljs-dirty?]]
    :desc    "Set translation status and optional review notes for current module"}

   ;; ----------------------------------------------------------
   ;; Macro domain (1) — from state.cljs
   ;; ----------------------------------------------------------
   :set-macro-status!
   {:name    :set-macro-status!
    :fn-ref  'app.state/set-macro-status!
    :domain  :macro
    :args    [{:name 'status :type :string}]
    :reads   []
    :writes  [[:macro-viewer :macro-info] [:macro-viewer :cljs-dirty?]]
    :desc    "Set the translation status for the current macro"}

   ;; ----------------------------------------------------------
   ;; Logs domain (1) — from state.cljs
   ;; ----------------------------------------------------------
   :set-logs-filter!
   {:name    :set-logs-filter!
    :fn-ref  'app.state/set-logs-filter!
    :domain  :logs
    :args    [{:name 'filter-key :type :keyword}
              {:name 'value :type :any}]
    :reads   []
    :writes  [[:logs-filter]]
    :desc    "Update a logs filter field (object-type or status)"}})

;; ============================================================
;; READERS REGISTRY
;; ============================================================

(def readers
  "Pure reader functions — derive values from app-state without mutation."
  {:db-headers
   {:fn-ref 'app.state/db-headers
    :reads  [[:current-database]]
    :desc   "Build HTTP headers with session ID and database ID"}

   :get-pk-field
   {:fn-ref 'app.state-table/get-pk-field
    :reads  [[:table-viewer :table-info]]
    :desc   "Get primary key field name for the current table"}

   :get-app-objects
   {:fn-ref 'app.state/get-app-objects
    :reads  [[:objects]]
    :desc   "Build compact inventory of all database objects (names only)"}

   :get-view-mode
   {:fn-ref 'app.state-form/get-view-mode
    :reads  [[:form-editor :view-mode]]
    :desc   "Get the form editor view mode (:design or :view)"}

   :get-report-view-mode
   {:fn-ref 'app.state-report/get-report-view-mode
    :reads  [[:report-editor :view-mode]]
    :desc   "Get the report editor view mode (:design or :preview)"}

   :get-grid-size
   {:fn-ref 'app.state/get-grid-size
    :reads  [[:config :form-designer :grid-size]]
    :desc   "Get the snap grid size for form design mode"}

   :has-capability?
   {:fn-ref 'app.state/has-capability?
    :reads  [[:config :capabilities]]
    :desc   "Check if a server capability is available"}

   :get-row-source-options
   {:fn-ref 'app.state-form/get-row-source-options
    :reads  [[:form-editor :row-source-cache]]
    :desc   "Returns cached row-source data (nil, :loading, or {:rows :fields})"}

   :get-record-source-fields
   {:fn-ref 'app.state-form/get-record-source-fields
    :reads  [[:objects :tables] [:objects :queries]]
    :desc   "Get fields for a record source (table or query) by name"}})

;; ============================================================
;; PURE HELPERS (no state access — operate on arguments only)
;; ============================================================

(def pure-helpers
  "Functions that take arguments and return values with no state access.
   Listed here for completeness — they are building blocks used by transforms."
  [{:name 'parse-access-filter        :fn-ref 'app.state/parse-access-filter
    :desc "Parse Access-style filter string into {col val} map"}
   {:name 'build-data-query-params    :fn-ref 'app.state/build-data-query-params
    :desc "Build query params from order-by and filter strings"}
   {:name 'record->api-map            :fn-ref 'app.state/record->api-map
    :desc "Convert internal record to API-ready map (strip :__new__, keyword keys to strings)"}
   {:name 'detect-pk-field            :fn-ref 'app.state/detect-pk-field
    :desc "Find primary key field name from fields list, defaulting to 'id'"}
   {:name 'pk-value-for-record        :fn-ref 'app.state/pk-value-for-record
    :desc "Get the primary key value from a record"}
   {:name 'coerce-yes-no              :fn-ref 'app.state/coerce-yes-no
    :desc "Coerce any truthy/falsy value to 1 or 0"}
   {:name 'coerce-to-number           :fn-ref 'app.state/coerce-to-number
    :desc "Coerce a value to number (nil-safe)"}
   {:name 'coerce-to-keyword          :fn-ref 'app.state/coerce-to-keyword
    :desc "Coerce a value to keyword (nil-safe)"}
   {:name 'normalize-control          :fn-ref 'app.state/normalize-control
    :desc "Normalize a single control: keywordize type, coerce yes/no and number props"}
   {:name 'filename->display-name     :fn-ref 'app.state/filename->display-name
    :desc "Convert underscore_name to Display Name"}
   {:name 'normalize-form-definition  :fn-ref 'app.state-form/normalize-form-definition
    :desc "Apply defaults and normalize types across the full form tree"}
   {:name 'normalize-report-definition :fn-ref 'app.state-report/normalize-report-definition
    :desc "Apply defaults and normalize types across the full report tree"}
   {:name 'build-synced-controls      :fn-ref 'app.state-form/build-synced-controls
    :desc "Scan controls for 'state' tag, return {ctrl-name {:table-name :column-name}} map"}
   {:name 'collect-synced-values      :fn-ref 'app.state-form/collect-synced-values
    :desc "Given record + synced-controls map, return [{:tableName :columnName :value}] for API"}
   {:name 'collect-default-values     :fn-ref 'app.state-form/collect-default-values
    :desc "Scan form controls for :default-value, return {field-keyword value} map"}])

;; ============================================================
;; QUERY UTILITIES
;; ============================================================

(defn writes-to
  "Return set of transform names that write to the given path.
   Matches exact paths and wildcard :* paths."
  [path]
  (into #{}
        (comp (filter (fn [[_ t]]
                        (some (fn [w]
                                (or (= w path)
                                    ;; Wildcard match: [:objects :*] matches [:objects :tables]
                                    (and (= (count w) (count path))
                                         (every? identity
                                                 (map (fn [a b] (or (= a b) (= a :*)))
                                                      w path)))
                                    ;; Prefix match: [:objects :*] matches [:objects :tables :0 :name]
                                    (and (< (count w) (count path))
                                         (every? identity
                                                 (map (fn [a b] (or (= a b) (= a :*)))
                                                      w (take (count w) path))))))
                              (:writes t))))
              (map first))
        transforms))

(defn reads-from
  "Return set of transform names that read from the given path.
   Matches exact paths, wildcards, and prefix paths."
  [path]
  (into #{}
        (comp (filter (fn [[_ t]]
                        (some (fn [r]
                                (or (= r path)
                                    ;; Wildcard match
                                    (and (= (count r) (count path))
                                         (every? identity
                                                 (map (fn [a b] (or (= a b) (= a :*)))
                                                      r path)))
                                    ;; Prefix match: [:table-viewer :table-info] matches [:table-viewer :table-info :fields]
                                    (and (< (count r) (count path))
                                         (every? identity
                                                 (map (fn [a b] (or (= a b) (= a :*)))
                                                      r (take (count r) path))))))
                              (:reads t))))
              (map first))
        transforms))

(defn domain-transforms
  "Return all transforms for a given domain keyword."
  [domain]
  (into {}
        (filter (fn [[_ t]] (= (:domain t) domain)))
        transforms))

(def all-written-paths
  "Sorted vector of all distinct paths written by any transform."
  (vec (sort-by str (distinct (mapcat :writes (vals transforms))))))

(def all-read-paths
  "Sorted vector of all distinct paths read by any transform."
  (vec (sort-by str (distinct (mapcat :reads (vals transforms))))))

(defn- path-in-schema?
  "Check if a path (or any prefix of it) exists in the schema paths set."
  [path schema-set]
  (or (contains? schema-set path)
      (some #(contains? schema-set (vec (take % path)))
            (range 1 (count path)))))

(defn validate-paths!
  "Cross-reference transform paths against state_schema.
   Returns {:missing-from-schema [...] :unwritten-in-schema [...]}.

   missing-from-schema: paths used in transforms with no matching schema entry
     (skips wildcard :* paths; checks parent prefixes for nested maps).
   unwritten-in-schema: schema paths not written by any transform
     (informational — may be set by async functions or initialization)."
  []
  (let [schema-set    (set (schema/all-paths))
        concrete?     (fn [p] (not-any? #{:*} p))
        xf-writes     (filter concrete? all-written-paths)
        xf-reads      (filter concrete? all-read-paths)
        all-xf-paths  (distinct (concat xf-writes xf-reads))
        missing       (vec (sort-by str
                                    (remove #(path-in-schema? % schema-set) all-xf-paths)))
        ;; Schema paths not covered by any write (exact or wildcard prefix)
        written-set   (set all-written-paths)
        covered?      (fn [sp]
                        (some (fn [w]
                                (or (= w sp)
                                    ;; Exact wildcard: [:objects :*] covers [:objects :tables]
                                    (and (= (count w) (count sp))
                                         (every? identity
                                                 (map (fn [a b] (or (= a b) (= a :*)))
                                                      w sp)))
                                    ;; Written path is parent of schema path
                                    (and (< (count w) (count sp))
                                         (= w (vec (take (count w) sp))))))
                              written-set))
        unwritten     (vec (sort-by str (remove covered? schema-set)))]
    {:missing-from-schema  missing
     :unwritten-in-schema  unwritten}))

(def transform-for-path
  "Alias for writes-to (debugging helper)."
  writes-to)

(defn transform-summary
  "Compact text overview for LLM context. Groups transforms by domain."
  []
  (let [by-domain    (group-by :domain (vals transforms))
        domain-order [:ui :chat :form :report :table :query :module :macro :logs]]
    (str
     (str/join
      "\n\n"
      (for [d domain-order
            :let [xfs (get by-domain d)]
            :when xfs]
        (str "## " (str/upper-case (name d)) " (" (count xfs) ")\n"
             (str/join
              "\n"
              (for [x (sort-by :name xfs)]
                (str "  " (name (:name x))
                     " -> writes " (pr-str (:writes x))
                     (when (seq (:reads x))
                       (str " | reads " (pr-str (:reads x))))))))))
     "\n\n## READERS (" (count readers) ")\n"
     (str/join
      "\n"
      (for [[k r] (sort-by first readers)]
        (str "  " (name k) " -> reads " (pr-str (:reads r)))))
     "\n\n## PURE HELPERS (" (count pure-helpers) ")\n"
     (str/join
      "\n"
      (for [h pure-helpers]
        (str "  " (:name h) " - " (:desc h)))))))
