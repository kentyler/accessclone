(ns app.state-transforms
  "Data-driven catalog of pure state transforms.

   Every swap! that mutates app-state is cataloged here with:
     - what paths it reads from app-state
     - what paths it writes to app-state
     - argument types and description

   Query utilities answer questions like:
     (writes-to [:form-editor :dirty?])  => #{:set-form-definition! ...}
     (domain-transforms :ui)             => all UI transforms
     (validate-paths!)                   => cross-reference against state-schema

   See also: app.state-schema for the full state shape."
  (:require [app.state-schema :as schema]
            [clojure.set :as set]
            [clojure.string :as str]))

;; ============================================================
;; TRANSFORM REGISTRY
;; ============================================================

(def transforms
  "Registry of pure sync state transforms. Keyword name → descriptor.
   :reads/:writes are path vectors into app-state.
   :* in a path = dynamic key (argument-dependent)."

  {;; ----------------------------------------------------------
   ;; UI domain — state.cljs
   ;; ----------------------------------------------------------

   :set-loading!
   {:fn-ref 'app.state/set-loading!
    :domain :ui
    :args   [{:name 'loading? :type :boolean}]
    :reads  []
    :writes [[:loading?]]
    :desc   "Set the global loading spinner state"}

   :set-error!
   {:fn-ref 'app.state/set-error!
    :domain :ui
    :args   [{:name 'error :type [:or :string :nil]}]
    :reads  []
    :writes [[:error]]
    :desc   "Set the error banner message"}

   :clear-error!
   {:fn-ref 'app.state/clear-error!
    :domain :ui
    :args   []
    :reads  []
    :writes [[:error]]
    :desc   "Clear the error banner (set to nil)"}

   :set-available-databases!
   {:fn-ref 'app.state/set-available-databases!
    :domain :ui
    :args   [{:name 'databases :type [:vector :map]}]
    :reads  []
    :writes [[:available-databases]]
    :desc   "Replace the list of available databases"}

   :set-current-database!
   {:fn-ref 'app.state/set-current-database!
    :domain :ui
    :args   [{:name 'db :type [:or :map :nil]}]
    :reads  []
    :writes [[:current-database]]
    :desc   "Set the currently selected database"}

   :set-loading-objects!
   {:fn-ref 'app.state/set-loading-objects!
    :domain :ui
    :args   [{:name 'loading? :type :boolean}]
    :reads  []
    :writes [[:loading-objects?]]
    :desc   "Set whether object types are being loaded after db switch"}

   :toggle-sidebar!
   {:fn-ref 'app.state/toggle-sidebar!
    :domain :ui
    :args   []
    :reads  [[:sidebar-collapsed?]]
    :writes [[:sidebar-collapsed?]]
    :desc   "Toggle sidebar collapsed/expanded"}

   :set-sidebar-object-type!
   {:fn-ref 'app.state/set-sidebar-object-type!
    :domain :ui
    :args   [{:name 'object-type :type :keyword}]
    :reads  []
    :writes [[:sidebar-object-type]]
    :desc   "Set which object type the sidebar shows"}

   :set-objects!
   {:fn-ref 'app.state/set-objects!
    :domain :ui
    :args   [{:name 'object-type :type :keyword}
             {:name 'objects :type [:vector :map]}]
    :reads  []
    :writes [[:objects :*]]
    :desc   "Replace the full list for one object type"}

   :add-object!
   {:fn-ref 'app.state/add-object!
    :domain :ui
    :args   [{:name 'object-type :type :keyword}
             {:name 'obj :type :map}]
    :reads  [[:objects :*]]
    :writes [[:objects :*]]
    :desc   "Append an object to one type's list"}

   :update-object!
   {:fn-ref 'app.state/update-object!
    :domain :ui
    :args   [{:name 'object-type :type :keyword}
             {:name 'id :type :number}
             {:name 'updates :type :map}]
    :reads  [[:objects :*]]
    :writes [[:objects :*]]
    :desc   "Merge updates into a specific object by id"}

   :open-options-dialog!
   {:fn-ref 'app.state/open-options-dialog!
    :domain :ui
    :args   []
    :reads  []
    :writes [[:options-dialog-open?]]
    :desc   "Open the options/settings dialog"}

   :close-options-dialog!
   {:fn-ref 'app.state/close-options-dialog!
    :domain :ui
    :args   []
    :reads  []
    :writes [[:options-dialog-open?]]
    :desc   "Close the options/settings dialog"}

   :set-grid-size!
   {:fn-ref 'app.state/set-grid-size!
    :domain :ui
    :args   [{:name 'size :type :number}]
    :reads  []
    :writes [[:config :form-designer :grid-size]]
    :desc   "Set the snap grid size for form/report design"}

   :show-context-menu!
   {:fn-ref 'app.state/show-context-menu!
    :domain :ui
    :args   [{:name 'x :type :number}
             {:name 'y :type :number}]
    :reads  []
    :writes [[:context-menu]]
    :desc   "Show sidebar context menu at (x,y). NOTE: top-level :context-menu not in schema"}

   :hide-context-menu!
   {:fn-ref 'app.state/hide-context-menu!
    :domain :ui
    :args   []
    :reads  []
    :writes [[:context-menu :visible?]]
    :desc   "Hide the sidebar context menu"}

   ;; ----------------------------------------------------------
   ;; Chat domain — state.cljs
   ;; ----------------------------------------------------------

   :toggle-chat-panel!
   {:fn-ref 'app.state/toggle-chat-panel!
    :domain :chat
    :args   []
    :reads  [[:chat-panel-open?]]
    :writes [[:chat-panel-open?]]
    :desc   "Toggle the chat panel open/closed"}

   :set-chat-input!
   {:fn-ref 'app.state/set-chat-input!
    :domain :chat
    :args   [{:name 'text :type :string}]
    :reads  []
    :writes [[:chat-input]]
    :desc   "Set the chat input text"}

   :add-chat-message!
   {:fn-ref 'app.state/add-chat-message!
    :domain :chat
    :args   [{:name 'role :type :string}
             {:name 'content :type :string}]
    :reads  [[:chat-messages]]
    :writes [[:chat-messages]]
    :desc   "Append a message to the chat transcript"}

   :set-chat-loading!
   {:fn-ref 'app.state/set-chat-loading!
    :domain :chat
    :args   [{:name 'loading? :type :boolean}]
    :reads  []
    :writes [[:chat-loading?]]
    :desc   "Set whether the LLM is generating a response"}

   ;; ----------------------------------------------------------
   ;; Form domain — state_form.cljs
   ;; ----------------------------------------------------------

   :set-form-definition!
   {:fn-ref 'app.state-form/set-form-definition!
    :domain :form
    :args   [{:name 'definition :type :map}]
    :reads  [[:form-editor :original]]
    :writes [[:form-editor :current] [:form-editor :dirty?]]
    :desc   "Set the form definition and recompute dirty flag"}

   :clear-lint-errors!
   {:fn-ref 'app.state-form/clear-lint-errors!
    :domain :form
    :args   []
    :reads  []
    :writes [[:form-editor :lint-errors]]
    :desc   "Clear form validation errors"}

   :set-lint-errors!
   {:fn-ref 'app.state-form/set-lint-errors!
    :domain :form
    :args   [{:name 'errors :type [:vector :map]}]
    :reads  []
    :writes [[:form-editor :lint-errors]]
    :desc   "Set form validation errors from lint endpoint"}

   :show-form-context-menu!
   {:fn-ref 'app.state-form/show-form-context-menu!
    :domain :form
    :args   [{:name 'x :type :number}
             {:name 'y :type :number}]
    :reads  []
    :writes [[:form-editor :context-menu]]
    :desc   "Show the form record context menu at (x,y)"}

   :hide-form-context-menu!
   {:fn-ref 'app.state-form/hide-form-context-menu!
    :domain :form
    :args   []
    :reads  []
    :writes [[:form-editor :context-menu :visible]]
    :desc   "Hide the form record context menu"}

   :new-record!
   {:fn-ref 'app.state-form/new-record!
    :domain :form
    :args   []
    :reads  [[:form-editor :record-position :total]
             [:form-editor :current]
             [:form-editor :records]]
    :writes [[:form-editor :records]
             [:form-editor :current-record]
             [:form-editor :record-position]
             [:form-editor :record-dirty?]]
    :desc   "Create a new record pre-populated with default values"}

   :set-current-record!
   {:fn-ref 'app.state-form/set-current-record!
    :domain :form
    :args   [{:name 'record :type [:or :map :nil]}]
    :reads  []
    :writes [[:form-editor :current-record]]
    :desc   "Set the current record being viewed/edited"}

   :set-record-position!
   {:fn-ref 'app.state-form/set-record-position!
    :domain :form
    :args   [{:name 'pos :type :number}
             {:name 'total :type :number}]
    :reads  []
    :writes [[:form-editor :record-position]]
    :desc   "Set the record navigation position and total"}

   :select-control!
   {:fn-ref 'app.state-form/select-control!
    :domain :form
    :args   [{:name 'idx :type [:or :number :nil]}]
    :reads  []
    :writes [[:form-editor :selected-control]]
    :desc   "Select a form control by index (nil = deselect)"}

   :delete-control!
   {:fn-ref 'app.state-form/delete-control!
    :domain :form
    :args   [{:name 'section :type :keyword}
             {:name 'idx :type :number}]
    :reads  [[:form-editor :current] [:form-editor :original]]
    :writes [[:form-editor :selected-control]
             [:form-editor :current]
             [:form-editor :dirty?]]
    :desc   "Delete a control from a form section by index"}

   :update-control!
   {:fn-ref 'app.state-form/update-control!
    :domain :form
    :args   [{:name 'section :type :keyword}
             {:name 'idx :type :number}
             {:name 'prop :type :keyword}
             {:name 'value :type :any}]
    :reads  [[:form-editor :current] [:form-editor :original]]
    :writes [[:form-editor :current] [:form-editor :dirty?]]
    :desc   "Update a property of a control in a form section"}

   :clear-row-source-cache!
   {:fn-ref 'app.state-form/clear-row-source-cache!
    :domain :form
    :args   []
    :reads  []
    :writes [[:form-editor :row-source-cache]]
    :desc   "Reset the row-source cache (on form switch)"}

   :cache-row-source!
   {:fn-ref 'app.state-form/cache-row-source!
    :domain :form
    :args   [{:name 'row-source :type :string}
             {:name 'data :type :any}]
    :reads  []
    :writes [[:form-editor :row-source-cache :*]]
    :desc   "Cache row-source data for a combobox/listbox"}

   :clear-subform-cache!
   {:fn-ref 'app.state-form/clear-subform-cache!
    :domain :form
    :args   []
    :reads  []
    :writes [[:form-editor :subform-cache]]
    :desc   "Reset the subform cache (on form switch)"}

   :copy-form-record!
   {:fn-ref 'app.state-form/copy-form-record!
    :domain :form
    :args   []
    :reads  [[:form-editor :current-record]]
    :writes []
    :desc   "Copy the current record to form-clipboard atom (external to app-state)"}

   :toggle-form-header-footer!
   {:fn-ref 'app.state-form/toggle-form-header-footer!
    :domain :form
    :args   []
    :reads  [[:form-editor :current] [:form-editor :original]]
    :writes [[:form-editor :current] [:form-editor :dirty?]]
    :desc   "Toggle header/footer visibility (via set-form-definition!)"}

   ;; ----------------------------------------------------------
   ;; Report domain — state_report.cljs
   ;; ----------------------------------------------------------

   :set-report-definition!
   {:fn-ref 'app.state-report/set-report-definition!
    :domain :report
    :args   [{:name 'definition :type :map}]
    :reads  [[:report-editor :original]]
    :writes [[:report-editor :current] [:report-editor :dirty?]]
    :desc   "Set the report definition and recompute dirty flag"}

   :clear-report-lint-errors!
   {:fn-ref 'app.state-report/clear-report-lint-errors!
    :domain :report
    :args   []
    :reads  []
    :writes [[:report-editor :lint-errors]]
    :desc   "Clear report validation errors"}

   :set-report-lint-errors!
   {:fn-ref 'app.state-report/set-report-lint-errors!
    :domain :report
    :args   [{:name 'errors :type [:vector :map]}]
    :reads  []
    :writes [[:report-editor :lint-errors]]
    :desc   "Set report validation errors from lint endpoint"}

   :select-report-control!
   {:fn-ref 'app.state-report/select-report-control!
    :domain :report
    :args   [{:name 'selection :type [:or :map :nil]}]
    :reads  []
    :writes [[:report-editor :selected-control]]
    :desc   "Select a report control, section, or nil for report-level"}

   :update-report-control!
   {:fn-ref 'app.state-report/update-report-control!
    :domain :report
    :args   [{:name 'section :type :keyword}
             {:name 'idx :type :number}
             {:name 'prop :type :keyword}
             {:name 'value :type :any}]
    :reads  [[:report-editor :current] [:report-editor :original]]
    :writes [[:report-editor :current] [:report-editor :dirty?]]
    :desc   "Update a property of a control in a report section"}

   :delete-report-control!
   {:fn-ref 'app.state-report/delete-report-control!
    :domain :report
    :args   [{:name 'section :type :keyword}
             {:name 'idx :type :number}]
    :reads  [[:report-editor :current] [:report-editor :original]]
    :writes [[:report-editor :selected-control]
             [:report-editor :current]
             [:report-editor :dirty?]]
    :desc   "Delete a control from a report section by index"}

   :add-group-level!
   {:fn-ref 'app.state-report/add-group-level!
    :domain :report
    :args   []
    :reads  [[:report-editor :current] [:report-editor :original]]
    :writes [[:report-editor :current] [:report-editor :dirty?]]
    :desc   "Add a grouping level with header/footer bands"}

   :remove-group-level!
   {:fn-ref 'app.state-report/remove-group-level!
    :domain :report
    :args   []
    :reads  [[:report-editor :current] [:report-editor :original]]
    :writes [[:report-editor :current] [:report-editor :dirty?]]
    :desc   "Remove the last grouping level and its bands"}

   ;; ----------------------------------------------------------
   ;; Table domain — state_table.cljs
   ;; ----------------------------------------------------------

   :select-table-field!
   {:fn-ref 'app.state-table/select-table-field!
    :domain :table
    :args   [{:name 'field-name :type [:or :string :nil]}]
    :reads  []
    :writes [[:table-viewer :selected-field]]
    :desc   "Select a field in design view for the property sheet"}

   :select-table-cell!
   {:fn-ref 'app.state-table/select-table-cell!
    :domain :table
    :args   [{:name 'row-idx :type :number}
             {:name 'col-name :type :string}]
    :reads  []
    :writes [[:table-viewer :selected]
             [:table-viewer :context-menu :visible]]
    :desc   "Select a cell in the datasheet and hide context menu"}

   :select-table-row!
   {:fn-ref 'app.state-table/select-table-row!
    :domain :table
    :args   [{:name 'row-idx :type :number}]
    :reads  []
    :writes [[:table-viewer :selected]]
    :desc   "Select an entire row in the datasheet"}

   :start-editing-cell!
   {:fn-ref 'app.state-table/start-editing-cell!
    :domain :table
    :args   [{:name 'row-idx :type :number}
             {:name 'col-name :type :string}]
    :reads  []
    :writes [[:table-viewer :selected]
             [:table-viewer :editing]]
    :desc   "Start inline editing a cell"}

   :stop-editing-cell!
   {:fn-ref 'app.state-table/stop-editing-cell!
    :domain :table
    :args   []
    :reads  []
    :writes [[:table-viewer :editing]]
    :desc   "Stop editing the current cell"}

   :move-to-next-cell!
   {:fn-ref 'app.state-table/move-to-next-cell!
    :domain :table
    :args   [{:name 'shift? :type :boolean}]
    :reads  [[:table-viewer :selected]
             [:table-viewer :table-info :fields]
             [:table-viewer :records]]
    :writes [[:table-viewer :selected]
             [:table-viewer :editing]]
    :desc   "Tab/Shift+Tab to next/previous cell (delegates to start-editing-cell!)"}

   :show-table-context-menu!
   {:fn-ref 'app.state-table/show-table-context-menu!
    :domain :table
    :args   [{:name 'x :type :number}
             {:name 'y :type :number}]
    :reads  []
    :writes [[:table-viewer :context-menu]]
    :desc   "Show the table context menu at (x,y)"}

   :hide-table-context-menu!
   {:fn-ref 'app.state-table/hide-table-context-menu!
    :domain :table
    :args   []
    :reads  []
    :writes [[:table-viewer :context-menu :visible]]
    :desc   "Hide the table context menu"}

   :copy-table-cell!
   {:fn-ref 'app.state-table/copy-table-cell!
    :domain :table
    :args   []
    :reads  [[:table-viewer :selected]
             [:table-viewer :records]]
    :writes []
    :desc   "Copy selected cell value to table-clipboard atom (external to app-state)"}

   :cut-table-cell!
   {:fn-ref 'app.state-table/cut-table-cell!
    :domain :table
    :args   []
    :reads  [[:table-viewer :selected]
             [:table-viewer :records]]
    :writes []
    :desc   "Cut selected cell value to table-clipboard atom (external to app-state)"}

   :set-new-table-name!
   {:fn-ref 'app.state-table/set-new-table-name!
    :domain :table
    :args   [{:name 'name :type :string}]
    :reads  []
    :writes [[:table-viewer :new-table-name]]
    :desc   "Set the name for a new table being created"}

   :revert-design!
   {:fn-ref 'app.state-table/revert-design!
    :domain :table
    :args   []
    :reads  [[:table-viewer :design-original]
             [:table-viewer :original-description]]
    :writes [[:table-viewer :design-fields]
             [:table-viewer :design-dirty?]
             [:table-viewer :design-renames]
             [:table-viewer :design-errors]
             [:table-viewer :table-description]
             [:table-viewer :selected-field]]
    :desc   "Reset table design to the last-saved original"}

   ;; ----------------------------------------------------------
   ;; Query domain — state_query.cljs
   ;; ----------------------------------------------------------

   :update-query-sql!
   {:fn-ref 'app.state-query/update-query-sql!
    :domain :query
    :args   [{:name 'sql :type :string}]
    :reads  []
    :writes [[:query-viewer :sql]]
    :desc   "Update the SQL text in the query editor"}

   :update-query-name!
   {:fn-ref 'app.state-query/update-query-name!
    :domain :query
    :args   [{:name 'name :type :string}]
    :reads  []
    :writes [[:query-viewer :pending-name]]
    :desc   "Set the pending name for a new query"}

   ;; ----------------------------------------------------------
   ;; Module domain — state.cljs
   ;; ----------------------------------------------------------

   :update-module-cljs-source!
   {:fn-ref 'app.state/update-module-cljs-source!
    :domain :module
    :args   [{:name 'new-source :type :string}]
    :reads  []
    :writes [[:module-viewer :module-info :cljs-source]
             [:module-viewer :cljs-dirty?]]
    :desc   "Update the ClojureScript source and mark dirty"}

   :set-module-status!
   {:fn-ref 'app.state/set-module-status!
    :domain :module
    :args   [{:name 'status :type :string}
             {:name 'review-notes :type [:or :string :nil]}]
    :reads  []
    :writes [[:module-viewer :module-info :status]
             [:module-viewer :module-info :review-notes]
             [:module-viewer :cljs-dirty?]]
    :desc   "Set translation status and optional review notes"}

   ;; ----------------------------------------------------------
   ;; Macro domain — state.cljs
   ;; ----------------------------------------------------------

   :set-macro-status!
   {:fn-ref 'app.state/set-macro-status!
    :domain :macro
    :args   [{:name 'status :type :string}]
    :reads  []
    :writes [[:macro-viewer :macro-info :status]
             [:macro-viewer :cljs-dirty?]]
    :desc   "Set the macro translation status"}

   ;; ----------------------------------------------------------
   ;; Logs domain — state.cljs
   ;; ----------------------------------------------------------

   :set-logs-filter!
   {:fn-ref 'app.state/set-logs-filter!
    :domain :logs
    :args   [{:name 'filter-key :type :keyword}
             {:name 'value :type :any}]
    :reads  []
    :writes [[:logs-filter :*]]
    :desc   "Update a single key in the logs filter map"}})

;; ============================================================
;; READERS REGISTRY
;; ============================================================

(def readers
  "Pure reader functions that derive values from app-state."
  [{:name    :db-headers
    :fn-ref  'app.state/db-headers
    :reads   [[:current-database]]
    :desc    "Build HTTP headers with database ID and session ID"}

   {:name    :get-pk-field
    :fn-ref  'app.state-table/get-pk-field
    :reads   [[:table-viewer :table-info :fields]]
    :desc    "Get the primary key field name for the current table"}

   {:name    :get-app-objects
    :fn-ref  'app.state/get-app-objects
    :reads   [[:objects]]
    :desc    "Compact inventory of all database objects (names only)"}

   {:name    :get-view-mode
    :fn-ref  'app.state-form/get-view-mode
    :reads   [[:form-editor :view-mode]]
    :desc    "Get the form editor view mode (:design or :view)"}

   {:name    :get-report-view-mode
    :fn-ref  'app.state-report/get-report-view-mode
    :reads   [[:report-editor :view-mode]]
    :desc    "Get the report editor view mode (:design or :preview)"}

   {:name    :get-grid-size
    :fn-ref  'app.state/get-grid-size
    :reads   [[:config :form-designer :grid-size]]
    :desc    "Get the snap grid size for form/report design"}

   {:name    :has-capability?
    :fn-ref  'app.state/has-capability?
    :reads   [[:config :capabilities :*]]
    :desc    "Check if a server capability is available"}

   {:name    :get-row-source-options
    :fn-ref  'app.state-form/get-row-source-options
    :reads   [[:form-editor :row-source-cache :*]]
    :desc    "Get cached row-source data for a combobox/listbox"}

   {:name    :get-record-source-fields
    :fn-ref  'app.state-form/get-record-source-fields
    :reads   [[:objects :tables] [:objects :queries]]
    :desc    "Get fields for a record source (table or query name)"}])

;; ============================================================
;; PURE HELPERS REFERENCE
;; ============================================================

(def pure-helpers
  "Pure functions that transform data without reading app-state.
   Listed for completeness — these are the building blocks transforms use."
  [{:name   :parse-access-filter
    :fn-ref 'app.state/parse-access-filter
    :desc   "Parse Access-style filter string into {col val} map"}

   {:name   :build-data-query-params
    :fn-ref 'app.state/build-data-query-params
    :desc   "Build query params from order-by and filter strings"}

   {:name   :record->api-map
    :fn-ref 'app.state/record->api-map
    :desc   "Convert internal record to API-ready map (strip :__new__, keyword→string keys)"}

   {:name   :detect-pk-field
    :fn-ref 'app.state/detect-pk-field
    :desc   "Find primary key field name from fields list, default 'id'"}

   {:name   :pk-value-for-record
    :fn-ref 'app.state/pk-value-for-record
    :desc   "Get the primary key value from a record"}

   {:name   :coerce-yes-no
    :fn-ref 'app.state/coerce-yes-no
    :desc   "Coerce any truthy/falsy value to 1 or 0"}

   {:name   :coerce-to-number
    :fn-ref 'app.state/coerce-to-number
    :desc   "Coerce a value to number (nil-safe, string-safe)"}

   {:name   :coerce-to-keyword
    :fn-ref 'app.state/coerce-to-keyword
    :desc   "Coerce a value to keyword (nil-safe, string-safe)"}

   {:name   :normalize-control
    :fn-ref 'app.state/normalize-control
    :desc   "Normalize a single control: keywordize :type, coerce yes/no and number props"}

   {:name   :filename->display-name
    :fn-ref 'app.state/filename->display-name
    :desc   "Convert snake_case filename to Title Case display name"}

   {:name   :normalize-form-definition
    :fn-ref 'app.state-form/normalize-form-definition
    :desc   "Apply defaults and normalize types across the full form tree"}

   {:name   :normalize-report-definition
    :fn-ref 'app.state-report/normalize-report-definition
    :desc   "Apply defaults and normalize types across the full report definition"}

   {:name   :build-synced-controls
    :fn-ref 'app.state-form/build-synced-controls
    :desc   "Scan form for 'state'-tagged controls, return {ctrl-name -> {table-name, column-name}}"}

   {:name   :collect-synced-values
    :fn-ref 'app.state-form/collect-synced-values
    :desc   "Given record + synced-controls map, return [{tableName, columnName, value}]"}

   {:name   :collect-default-values
    :fn-ref 'app.state-form/collect-default-values
    :desc   "Scan form controls for :default-value, return {field-keyword value}"}])

;; ============================================================
;; QUERY UTILITIES
;; ============================================================

(defn- path-matches?
  "True if transform-path matches target-path, where :* is a wildcard
   that matches any single key at that position."
  [transform-path target-path]
  (and (= (count transform-path) (count target-path))
       (every? (fn [[tp tgt]]
                 (or (= tp :*) (= tgt :*) (= tp tgt)))
               (map vector transform-path target-path))))

(defn- path-prefix-matches?
  "True if short-path is a prefix of long-path (with :* wildcards)."
  [short-path long-path]
  (and (<= (count short-path) (count long-path))
       (every? (fn [[sp lp]]
                 (or (= sp :*) (= lp :*) (= sp lp)))
               (map vector short-path (take (count short-path) long-path)))))

(defn writes-to
  "Set of transform names that write to the given path.
   Matches exact paths and parent paths (e.g., querying [:form-editor :dirty?]
   matches a transform that writes [:form-editor :dirty?])."
  [path]
  (into #{}
        (comp (filter (fn [[_ desc]]
                        (some #(or (path-matches? % path)
                                   (path-prefix-matches? % path)
                                   (path-prefix-matches? path %))
                              (:writes desc))))
              (map key))
        transforms))

(defn reads-from
  "Set of transform names that read from the given path."
  [path]
  (into #{}
        (comp (filter (fn [[_ desc]]
                        (some #(or (path-matches? % path)
                                   (path-prefix-matches? % path)
                                   (path-prefix-matches? path %))
                              (:reads desc))))
              (map key))
        transforms))

(defn domain-transforms
  "All transforms for a given domain keyword."
  [domain]
  (into {}
        (filter (fn [[_ desc]] (= (:domain desc) domain)))
        transforms))

(defn all-written-paths
  "Sorted set of all paths written by any transform."
  []
  (->> (vals transforms)
       (mapcat :writes)
       (into (sorted-set-by #(compare (str %1) (str %2))))))

(defn all-read-paths
  "Sorted set of all paths read by any transform."
  []
  (->> (vals transforms)
       (mapcat :reads)
       (into (sorted-set-by #(compare (str %1) (str %2))))))

(defn- path-covered-by-schema?
  "True if a transform path is covered by the schema — either matching
   a schema path directly, or being a deeper path into a declared map."
  [transform-path schema-paths]
  (boolean
    (some (fn [sp]
            (or
              ;; Exact match (with wildcards)
              (path-matches? transform-path sp)
              ;; Transform path is a prefix of a schema path
              (path-prefix-matches? transform-path sp)
              ;; Schema path is a prefix of transform path (writing into a map)
              (path-prefix-matches? sp transform-path)))
          schema-paths)))

(defn validate-paths!
  "Cross-reference transform paths against state-schema.
   Returns {:missing-from-schema [...] :unwritten-schema-paths [...]}.
   - missing-from-schema: transform paths with no schema coverage
   - unwritten-schema-paths: schema leaf paths no transform writes to"
  []
  (let [schema-paths (vec (schema/all-paths))
        all-writes   (vec (mapcat :writes (vals transforms)))
        all-reads    (vec (mapcat :reads (vals transforms)))
        all-t-paths  (distinct (concat all-writes all-reads))

        missing-from-schema
        (vec (remove #(path-covered-by-schema? % schema-paths) all-t-paths))

        written-schema-paths
        (set (filter (fn [sp]
                       (some (fn [wp]
                               (or (path-matches? wp sp)
                                   (path-prefix-matches? wp sp)
                                   (path-prefix-matches? sp wp)))
                             all-writes))
                     schema-paths))

        unwritten
        (vec (remove written-schema-paths schema-paths))]

    {:missing-from-schema    missing-from-schema
     :unwritten-schema-paths unwritten}))

(defn transform-for-path
  "Alias for writes-to — find which transforms write to a path."
  [path]
  (writes-to path))

(defn transform-summary
  "Compact text overview of the registry for LLM context injection."
  []
  (let [by-domain    (group-by (fn [[_ desc]] (:domain desc)) transforms)
        domain-order [:ui :chat :form :report :table :query :module :macro :logs]
        domain-lines
        (for [d domain-order
              :let [entries (get by-domain d)]
              :when entries]
          (str "  " (name d) " (" (count entries) "): "
               (str/join ", " (sort (map (comp name key) entries)))))]
    (str "=== State Transforms (" (count transforms) " total) ===\n"
         (str/join "\n" domain-lines)
         "\n\n=== Readers (" (count readers) ") ===\n  "
         (str/join ", " (map (comp name :name) readers))
         "\n\n=== Pure Helpers (" (count pure-helpers) ") ===\n  "
         (str/join ", " (map (comp name :name) pure-helpers)))))
