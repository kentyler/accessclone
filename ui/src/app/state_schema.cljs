(ns app.state-schema
  "Declared schema for the app-state Reagent atom.

   This file is the single source of truth for the shape of app-state.
   Every path that exists in the atom is documented here with its type,
   default value, and a brief description.

   Types use keywords:
     :string, :boolean, :keyword, :number, :map, :vector, :any, :nil
     [:vector :map]   = vector of maps
     [:map :any]      = map with arbitrary keys
     [:or :string :nil] = union type

   This schema is DATA, not code. It can be:
     - Read by LLMs to understand state without archaeology
     - Used to generate validation (malli, spec) if desired
     - Diffed against actual state for drift detection
     - Fed into a transform registry as input/output contracts")

;; ============================================================
;; SCHEMA DEFINITION
;; ============================================================

(def schema
  {;; --------------------------------------------------------
   ;; DATABASE SELECTION
   ;; --------------------------------------------------------
   :available-databases
   {:type [:vector :map]
    :default []
    :desc "List of databases the user can switch between"
    :shape {:database_id :string
            :name :string}}

   :current-database
   {:type [:or :map :nil]
    :default nil
    :desc "Currently selected database"
    :shape {:database_id :string
            :name :string}}

   :loading-objects?
   {:type :boolean
    :default false
    :desc "True while loading all object types after database switch"}

   :saved-database-id
   {:type [:or :string :nil]
    :default nil
    :desc "Temporary: database ID to restore from saved UI state"}

   ;; --------------------------------------------------------
   ;; APP CONFIGURATION
   ;; --------------------------------------------------------
   :config
   {:type :map
    :default {:form-designer {:grid-size 8}}
    :desc "App configuration loaded from settings/config.json"
    :children
    {:form-designer
     {:type :map
      :children
      {:grid-size {:type :number :default 8 :desc "Snap grid size in design mode"}}}
     :capabilities
     {:type :map
      :desc "Server capability flags (file-system, powershell, etc.)"}}}

   ;; --------------------------------------------------------
   ;; GLOBAL UI STATE
   ;; --------------------------------------------------------
   :loading?
   {:type :boolean
    :default false
    :desc "General loading spinner"}

   :error
   {:type [:or :string :nil]
    :default nil
    :desc "Error message displayed in UI banner"}

   :options-dialog-open?
   {:type :boolean
    :default false
    :desc "Whether the options/settings dialog is open"}

   :app-mode
   {:type :keyword
    :default :run
    :desc "Top-level mode: :run (normal), :import (Access import), :logs (event history)"}

   ;; --------------------------------------------------------
   ;; SIDEBAR
   ;; --------------------------------------------------------
   :sidebar-collapsed?
   {:type :boolean
    :default false
    :desc "Whether the object sidebar is collapsed"}

   :sidebar-object-type
   {:type :keyword
    :default :forms
    :desc "Which object type the sidebar is showing: :tables :queries :forms :reports :modules :macros"}

   ;; --------------------------------------------------------
   ;; OBJECTS (loaded from database)
   ;; --------------------------------------------------------
   :objects
   {:type :map
    :desc "All objects indexed by type, loaded on database switch"
    :children
    {:tables
     {:type [:vector :map]
      :default []
      :desc "Table metadata objects"
      :shape {:id :number :name :string :fields [:vector :map]}}

     :queries
     {:type [:vector :map]
      :default []
      :desc "Query/view metadata objects"
      :shape {:id :number :name :string :sql :string :fields [:vector :map]}}

     :forms
     {:type [:vector :map]
      :default []
      :desc "Form objects with definitions"
      :shape {:id :number :name :string :filename :string :definition :map}}

     :reports
     {:type [:vector :map]
      :default []
      :desc "Report objects with definitions"
      :shape {:id :number :name :string :filename :string :definition :map}}

     :modules
     {:type [:vector :map]
      :default []
      :desc "VBA/CLJS module objects"
      :shape {:id :number :name :string :filename :string}}

     :sql-functions
     {:type [:vector :map]
      :default []
      :desc "PostgreSQL function objects"
      :shape {:id :number :name :string :arguments :string :return-type :string}}

     :macros
     {:type [:vector :map]
      :default []
      :desc "Access macro objects"
      :shape {:id :number :name :string}}

     :access_databases
     {:type [:vector :string]
      :default []
      :desc "Access database file paths found by scanning"}}}

   ;; --------------------------------------------------------
   ;; TAB MANAGEMENT
   ;; --------------------------------------------------------
   :open-objects
   {:type [:vector :map]
    :default []
    :desc "Open tabs in the workspace"
    :shape {:type :keyword :id :number :name :string}}

   :active-tab
   {:type [:or :map :nil]
    :default nil
    :desc "Currently focused tab"
    :shape {:type :keyword :id :number}}

   ;; --------------------------------------------------------
   ;; CHAT PANEL
   ;; --------------------------------------------------------
   :chat-messages
   {:type [:vector :map]
    :default []
    :desc "Chat transcript for the active tab"
    :shape {:role :string :content :string}}

   :chat-input
   {:type :string
    :default ""
    :desc "Current text in the chat input box"}

   :chat-loading?
   {:type :boolean
    :default false
    :desc "True while waiting for LLM response"}

   :chat-panel-open?
   {:type :boolean
    :default true
    :desc "Whether the chat panel is visible"}

   :chat-tab
   {:type [:or :map :nil]
    :default nil
    :desc "Tab that owns the current chat transcript"
    :shape {:type :keyword :id :number :name :string}}

   :auto-analyze-pending
   {:type :boolean
    :default false
    :desc "Set when transcript loads empty; cleared after auto-analyze fires"}

   ;; --------------------------------------------------------
   ;; LOGS MODE
   ;; --------------------------------------------------------
   :logs-entries
   {:type [:vector :map]
    :default []
    :desc "Import log entries shown in logs sidebar"}

   :logs-selected-entry
   {:type [:or :map :nil]
    :default nil
    :desc "Currently selected log entry"}

   :logs-issues
   {:type [:vector :map]
    :default []
    :desc "Issues for the selected log entry"}

   :logs-loading?
   {:type :boolean
    :default false
    :desc "True while loading log entries"}

   :logs-filter
   {:type :map
    :default {:object-type nil :status nil}
    :desc "Filters for the logs view"
    :children
    {:object-type {:type [:or :keyword :nil] :default nil :desc "Filter by object type"}
     :status      {:type [:or :keyword :nil] :default nil :desc "Filter by status"}}}

   ;; --------------------------------------------------------
   ;; IMPORT STATUS (Access import progress)
   ;; --------------------------------------------------------
   :import-all-status
   {:type [:or :map :nil]
    :default nil
    :desc "Progress tracker for Import All operation"
    :children
    {:phase    {:type :string  :desc "Current phase description"}
     :current  {:type :number  :desc "Current item index"}
     :imported {:type :number  :desc "Count of successfully imported items"}}}

   :import-completeness
   {:type [:or :map :nil]
    :default nil
    :desc "Missing object inventory from import completeness check"}

   :access-db-cache
   {:type [:map :any]
    :default {}
    :desc "Cache of Access database file listings, keyed by path"}

   ;; --------------------------------------------------------
   ;; FORM RUNTIME (live form data entry)
   ;; --------------------------------------------------------
   :form-data
   {:type :map
    :default {}
    :desc "Runtime form data (control values during data entry)"}

   :form-session
   {:type [:or :string :nil]
    :default nil
    :desc "Session ID for form state sync"}

   ;; --------------------------------------------------------
   ;; FORM EDITOR
   ;; --------------------------------------------------------
   :form-editor
   {:type :map
    :desc "State for the form design/view editor"
    :children
    {:form-id
     {:type [:or :number :nil]
      :default nil
      :desc "ID of the form being edited"}

     :current
     {:type [:or :map :nil]
      :default nil
      :desc "Current form definition (normalized). Contains :header :detail :footer sections, each with :height and :controls"}

     :original
     {:type [:or :map :nil]
      :default nil
      :desc "Last-saved form definition (for dirty detection)"}

     :dirty?
     {:type :boolean
      :default false
      :desc "True if current differs from original"}

     :selected-control
     {:type [:or :number :nil]
      :default nil
      :desc "Index of selected control in current section (nil = section/form-level selection)"}

     :view-mode
     {:type :keyword
      :default :design
      :desc ":design or :view"}

     :properties-tab
     {:type :keyword
      :default :format
      :desc "Active property sheet tab: :format :data :event :other :all"}

     :lint-errors
     {:type [:or [:vector :map] :nil]
      :default nil
      :desc "Validation errors from lint endpoint"}

     ;; Record navigation (view mode)
     :records
     {:type [:vector :map]
      :default []
      :desc "Records loaded from record-source"}

     :current-record
     {:type [:or :map :nil]
      :default nil
      :desc "Current record being viewed/edited. :__new__ true for unsaved new records"}

     :record-position
     {:type :map
      :default {:current 0 :total 0}
      :desc "1-indexed position in records"
      :children
      {:current {:type :number :desc "Current record position (1-indexed)"}
       :total   {:type :number :desc "Total record count"}}}

     :record-dirty?
     {:type :boolean
      :default false
      :desc "True if current record has unsaved field changes"}

     ;; Caches
     :row-source-cache
     {:type [:map :any]
      :default {}
      :desc "Cache of combo/list box data, keyed by row-source SQL string"
      :shape {:rows [:vector :any] :fields [:vector :map]}}

     :subform-cache
     {:type [:map :any]
      :default {}
      :desc "Cache of subform definitions and records, keyed by source form name"
      :shape {:definition :map :records [:vector :map] :filter-key :string}}

     ;; State sync
     :synced-controls
     {:type [:map :any]
      :default {}
      :desc "Map of control-name-lowercase -> {:table-name t :column-name c} for session state sync"}

     ;; Context menu
     :context-menu
     {:type :map
      :default {:visible false}
      :desc "Right-click context menu state"
      :children
      {:visible {:type :boolean :desc "Whether context menu is showing"}
       :x       {:type :number  :desc "Menu X position"}
       :y       {:type :number  :desc "Menu Y position"}}}}}

   ;; --------------------------------------------------------
   ;; REPORT EDITOR
   ;; --------------------------------------------------------
   :report-editor
   {:type :map
    :desc "State for the report design/preview editor"
    :children
    {:report-id
     {:type [:or :number :nil]
      :default nil
      :desc "ID of the report being edited"}

     :current
     {:type [:or :map :nil]
      :default nil
      :desc "Current report definition (normalized). Banded: :report-header :page-header :detail :page-footer :report-footer plus dynamic :group-header-N :group-footer-N"}

     :original
     {:type [:or :map :nil]
      :default nil
      :desc "Last-saved report definition"}

     :dirty?
     {:type :boolean
      :default false
      :desc "True if current differs from original"}

     :selected-control
     {:type [:or :map :nil]
      :default nil
      :desc "nil (report-level), {:section :page-header} (section), or {:section :detail :idx 0} (control)"}

     :view-mode
     {:type :keyword
      :default :design
      :desc ":design or :preview"}

     :properties-tab
     {:type :keyword
      :default :format
      :desc "Active property sheet tab: :format :data :event :other :all"}

     :lint-errors
     {:type [:or [:vector :map] :nil]
      :default nil
      :desc "Validation errors from lint endpoint"}

     :records
     {:type [:vector :map]
      :default []
      :desc "Records loaded for preview rendering"}}}

   ;; --------------------------------------------------------
   ;; TABLE VIEWER
   ;; --------------------------------------------------------
   :table-viewer
   {:type :map
    :desc "State for the table datasheet/design viewer"
    :children
    {:table-id
     {:type [:or :number :nil]
      :default nil
      :desc "ID of the table being viewed"}

     :table-info
     {:type [:or :map :nil]
      :default nil
      :desc "Table metadata: {:name ... :fields [{:name :type :pk ...}]}"}

     :records
     {:type [:vector :map]
      :default []
      :desc "Data records from the table"}

     :view-mode
     {:type :keyword
      :default :datasheet
      :desc ":datasheet or :design"}

     :loading?
     {:type :boolean
      :default false
      :desc "True while loading table data"}

     ;; Datasheet editing
     :selected
     {:type [:or :map :nil]
      :default nil
      :desc "Selected cell: {:row row-idx :col col-name}"
      :children
      {:row {:type :number :desc "Row index"}
       :col {:type :string :desc "Column name"}}}

     :editing
     {:type [:or :map :nil]
      :default nil
      :desc "Cell being edited: {:row row-idx :col col-name}"}

     :context-menu
     {:type :map
      :default {:visible false}
      :desc "Right-click context menu"
      :children
      {:visible {:type :boolean}
       :x       {:type :number}
       :y       {:type :number}}}

     ;; Design mode
     :design-fields
     {:type [:or [:vector :map] :nil]
      :default nil
      :desc "Editable field definitions for design mode"}

     :design-original
     {:type [:or [:vector :map] :nil]
      :default nil
      :desc "Original field definitions (for dirty/revert)"}

     :design-dirty?
     {:type :boolean
      :default false
      :desc "True if design fields differ from original"}

     :design-renames
     {:type :map
      :default {}
      :desc "Map of {original-name -> new-name} for column renames"}

     :design-errors
     {:type [:or [:vector :map] :nil]
      :default nil
      :desc "Validation errors from design save"}

     :selected-field
     {:type [:or :string :nil]
      :default nil
      :desc "Selected field name in design mode (for property sheet)"}

     :table-description
     {:type [:or :string :nil]
      :default nil
      :desc "Current table description (editable in design)"}

     :original-description
     {:type [:or :string :nil]
      :default nil
      :desc "Original table description (for dirty detection)"}

     ;; New table creation
     :new-table?
     {:type :boolean
      :default false
      :desc "True when creating a new table"}

     :new-table-name
     {:type [:or :string :nil]
      :default nil
      :desc "Name for the new table being created"}}}

   ;; --------------------------------------------------------
   ;; QUERY VIEWER
   ;; --------------------------------------------------------
   :query-viewer
   {:type :map
    :desc "State for the query results/SQL/design viewer"
    :children
    {:query-id
     {:type [:or :number :nil]
      :default nil
      :desc "ID of the query being viewed"}

     :query-info
     {:type [:or :map :nil]
      :default nil
      :desc "Query metadata: {:name ... :sql ... :fields [...]}"}

     :sql
     {:type :string
      :default ""
      :desc "Current SQL text (may be user-edited)"}

     :results
     {:type [:vector :map]
      :default []
      :desc "Query result rows"}

     :result-fields
     {:type [:vector :map]
      :default []
      :desc "Field descriptors for result columns"}

     :view-mode
     {:type :keyword
      :default :results
      :desc ":results, :sql, or :design"}

     :loading?
     {:type :boolean
      :default false
      :desc "True while executing query"}

     :error
     {:type [:or :string :nil]
      :default nil
      :desc "Query execution error message"}

     :design-data
     {:type [:or :map :nil]
      :default nil
      :desc "Parsed query structure for design view"}

     :design-loading?
     {:type :boolean
      :default false
      :desc "True while loading design data"}

     :pending-name
     {:type [:or :string :nil]
      :default nil
      :desc "Name for a new query being created"}}}

   ;; --------------------------------------------------------
   ;; MODULE VIEWER
   ;; --------------------------------------------------------
   :module-viewer
   {:type :map
    :desc "State for the VBA/CLJS module viewer"
    :children
    {:module-id
     {:type [:or :number :nil]
      :default nil
      :desc "ID of the module being viewed"}

     :module-info
     {:type [:or :map :nil]
      :default nil
      :desc "Module metadata and source code"
      :shape {:name :string
              :vba-source :string
              :cljs-source :string
              :status :string
              :review-notes :string
              :description :string
              :version :number
              :created-at :string}}

     :loading?
     {:type :boolean
      :default false
      :desc "True while loading module"}

     :translating?
     {:type :boolean
      :default false
      :desc "True while LLM translation is in progress"}

     :cljs-dirty?
     {:type :boolean
      :default false
      :desc "True if ClojureScript source has unsaved edits"}}}

   ;; --------------------------------------------------------
   ;; MACRO VIEWER
   ;; --------------------------------------------------------
   :macro-viewer
   {:type :map
    :desc "State for the Access macro viewer"
    :children
    {:macro-id
     {:type [:or :number :nil]
      :default nil
      :desc "ID of the macro being viewed"}

     :macro-info
     {:type [:or :map :nil]
      :default nil
      :desc "Macro metadata and source"
      :shape {:name :string
              :macro-xml :string
              :cljs-source :string
              :status :string
              :review-notes :string
              :description :string
              :version :number
              :created-at :string}}

     :loading?
     {:type :boolean
      :default false
      :desc "True while loading macro"}

     :cljs-dirty?
     {:type :boolean
      :default false
      :desc "True if ClojureScript translation has unsaved edits"}}}

   ;; --------------------------------------------------------
   ;; SQL FUNCTION VIEWER
   ;; --------------------------------------------------------
   :sql-function-viewer
   {:type :map
    :desc "State for viewing PostgreSQL functions"
    :children
    {:fn-id
     {:type [:or :number :nil]
      :default nil
      :desc "ID of the function being viewed"}

     :info
     {:type [:or :map :nil]
      :default nil
      :desc "Function metadata and source"
      :shape {:name :string
              :arguments :string
              :return-type :string
              :source :string
              :description :string}}}}})

;; ============================================================
;; SCHEMA UTILITIES
;; ============================================================

(defn path-type
  "Look up the declared type for a state path.
   (path-type [:form-editor :dirty?]) => :boolean"
  [path]
  (loop [schema-node schema
         remaining path]
    (when (seq remaining)
      (let [k (first remaining)
            entry (get schema-node k)]
        (if (empty? (rest remaining))
          (:type entry)
          (recur (:children entry) (rest remaining)))))))

(defn path-default
  "Look up the declared default for a state path."
  [path]
  (loop [schema-node schema
         remaining path]
    (when (seq remaining)
      (let [k (first remaining)
            entry (get schema-node k)]
        (if (empty? (rest remaining))
          (:default entry)
          (recur (:children entry) (rest remaining)))))))

(defn path-desc
  "Look up the description for a state path."
  [path]
  (loop [schema-node schema
         remaining path]
    (when (seq remaining)
      (let [k (first remaining)
            entry (get schema-node k)]
        (if (empty? (rest remaining))
          (:desc entry)
          (recur (:children entry) (rest remaining)))))))

(defn all-paths
  "Return a flat sequence of all declared paths (as vectors of keywords)."
  ([] (all-paths schema []))
  ([node prefix]
   (mapcat (fn [[k v]]
             (let [p (conj prefix k)]
               (if (:children v)
                 (cons p (all-paths (:children v) p))
                 [p])))
           node)))
