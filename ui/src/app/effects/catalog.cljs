(ns app.effects.catalog
  "Data-driven catalog of every atomic effect in the application.

   Each effect descriptor contains:
     :name     - keyword identifier
     :type     - :http or :dom
     :method   - HTTP method (:get :post :put :delete :patch) or DOM method (:alert :confirm)
     :url      - URL pattern string (with :param placeholders)
     :domain   - category (:database :table :query :form :report :module :macro :chat :session :logs :config :graph)
     :headers  - :db (X-Session-ID + X-Database-ID) or :session (X-Session-ID only) or :none
     :params   - description of required parameters
     :produces - description of response data
     :used-by  - vector of function names that use this effect
     :desc     - human-readable description

   This catalog is for LLM context and documentation. The wiring layer
   (Phase 3) will reference these by name when composing flows."
  (:require [clojure.string :as str]))

;; ============================================================
;; HTTP EFFECTS (42 unique endpoints)
;; ============================================================

(def http-effects
  {;; ----------------------------------------------------------
   ;; Database management (3)
   ;; ----------------------------------------------------------
   :fetch-databases
   {:method   :get
    :url      "/api/databases"
    :domain   :database
    :headers  :none
    :params   {}
    :produces {:databases "vector of database maps" :current "current database_id"}
    :used-by  ['load-databases!]
    :desc     "Load available databases and current selection"}

   :switch-database
   {:method   :post
    :url      "/api/databases/switch"
    :domain   :database
    :headers  :none
    :params   {:database_id "target database ID"}
    :produces {}
    :used-by  ['switch-database!]
    :desc     "Switch the active database on the server"}

   :create-database
   {:method   :post
    :url      "/api/databases"
    :domain   :database
    :headers  :none
    :params   {:name "database name" :description "database description"}
    :produces {:database "new database map"}
    :used-by  ['create-database!]
    :desc     "Create a new database (schema + shared.databases row)"}

   ;; ----------------------------------------------------------
   ;; Tables (4)
   ;; ----------------------------------------------------------
   :fetch-tables
   {:method   :get
    :url      "/api/tables"
    :domain   :table
    :headers  :db
    :params   {}
    :produces {:tables "vector of {name, description, fields}"}
    :used-by  ['load-tables! 'reload-table-after-save! 'refresh-tables-and-open!]
    :desc     "Load all tables with column metadata"}

   :save-table-design
   {:method   :put
    :url      "/api/tables/:table-name"
    :domain   :table
    :headers  :db
    :params   {:fields "vector of field descriptors" :renames "map of old->new names" :description "table description"}
    :produces {}
    :used-by  ['save-table-design!]
    :desc     "Save modified table schema (columns, renames, description)"}

   :create-table
   {:method   :post
    :url      "/api/tables"
    :domain   :table
    :headers  :db
    :params   {:name "table name" :fields "vector of field descriptors" :description "table description"}
    :produces {}
    :used-by  ['save-new-table!]
    :desc     "Create a new table"}

   :populate-graph
   {:method   :post
    :url      "/api/graph/populate"
    :domain   :graph
    :headers  :db
    :params   {}
    :produces {}
    :used-by  ['populate-graph!]
    :desc     "Rebuild dependency/intent graph after schema changes"}

   ;; ----------------------------------------------------------
   ;; Data CRUD (4 — parameterized by table/record-source)
   ;; ----------------------------------------------------------
   :fetch-data
   {:method   :get
    :url      "/api/data/:table"
    :domain   :data
    :headers  :db
    :params   {:limit "max rows (default 1000)" :orderBy "column name" :orderDir "asc|desc"
               :filter "JSON map of {col: val}" :computed "JSON array of computed specs"}
    :produces {:data "vector of record maps" :pagination {:totalCount "number"}}
    :used-by  ['load-table-for-viewing! 'refresh-table-data! 'load-form-records!
               'refresh-form-data! 'fetch-table-row-source! 'fetch-subform-records!
               'set-report-view-mode!]
    :desc     "Fetch records from a table or view"}

   :insert-record
   {:method   :post
    :url      "/api/data/:table"
    :domain   :data
    :headers  :db
    :params   {:record "map of field values"}
    :produces {:data "inserted record with generated id"}
    :used-by  ['do-insert-record! 'new-table-record! 'new-subform-record!]
    :desc     "Insert a new record into a table"}

   :update-record
   {:method   :put
    :url      "/api/data/:table/:pk-value"
    :domain   :data
    :headers  :db
    :params   {:fields "map of field values to update"}
    :produces {:data "updated record"}
    :used-by  ['do-update-record! 'save-table-cell! 'save-subform-cell!]
    :desc     "Update an existing record by primary key"}

   :delete-record
   {:method   :delete
    :url      "/api/data/:table/:pk-value"
    :domain   :data
    :headers  :db
    :params   {}
    :produces {}
    :used-by  ['delete-current-record! 'delete-table-record! 'delete-subform-record!]
    :desc     "Delete a record by primary key"}

   ;; ----------------------------------------------------------
   ;; Queries (3)
   ;; ----------------------------------------------------------
   :fetch-queries
   {:method   :get
    :url      "/api/queries"
    :domain   :query
    :headers  :db
    :params   {}
    :produces {:queries "vector of {name, sql, fields}"}
    :used-by  ['load-queries!]
    :desc     "Load all queries/views"}

   :fetch-query-design
   {:method   :get
    :url      "/api/queries/:query-name/design"
    :domain   :query
    :headers  :db
    :params   {}
    :produces {:parseable "boolean" :tables "vector" :columns "vector" :joins "vector"}
    :used-by  ['load-query-design!]
    :desc     "Load parsed query design data"}

   :run-query
   {:method   :post
    :url      "/api/queries/run"
    :domain   :query
    :headers  :db
    :params   {:sql "SELECT statement"}
    :produces {:data "vector of result rows" :fields "vector of {name, type}"}
    :used-by  ['run-query! 'fetch-sql-row-source!]
    :desc     "Execute a SQL SELECT query"}

   ;; ----------------------------------------------------------
   ;; Forms (3)
   ;; ----------------------------------------------------------
   :fetch-forms
   {:method   :get
    :url      "/api/forms"
    :domain   :form
    :headers  :db
    :params   {}
    :produces {:forms "vector of form names" :details "vector of {record_source}"}
    :used-by  ['load-forms!]
    :desc     "List all forms for current database"}

   :fetch-form
   {:method   :get
    :url      "/api/forms/:filename"
    :domain   :form
    :headers  :db
    :params   {}
    :produces {:definition "full form definition map"}
    :used-by  ['load-form-for-editing! 'fetch-subform-definition!]
    :desc     "Load a form definition by filename"}

   :save-form
   {:method   :put
    :url      "/api/forms/:filename"
    :domain   :form
    :headers  :db
    :params   {:form-data "form definition with id and name"}
    :produces {}
    :used-by  ['save-form-to-file!]
    :desc     "Save form definition to database"}

   ;; ----------------------------------------------------------
   ;; Reports (3)
   ;; ----------------------------------------------------------
   :fetch-reports
   {:method   :get
    :url      "/api/reports"
    :domain   :report
    :headers  :db
    :params   {}
    :produces {:reports "vector of report names" :details "vector of {record_source}"}
    :used-by  ['load-reports!]
    :desc     "List all reports for current database"}

   :fetch-report
   {:method   :get
    :url      "/api/reports/:filename"
    :domain   :report
    :headers  :db
    :params   {}
    :produces {:definition "full report definition map"}
    :used-by  ['load-report-for-editing!]
    :desc     "Load a report definition by filename"}

   :save-report
   {:method   :put
    :url      "/api/reports/:filename"
    :domain   :report
    :headers  :db
    :params   {:report-data "report definition with id and name"}
    :produces {}
    :used-by  ['save-report-to-file!]
    :desc     "Save report definition to database"}

   ;; ----------------------------------------------------------
   ;; Lint / Validation (2)
   ;; ----------------------------------------------------------
   :lint-form
   {:method   :post
    :url      "/api/lint/form"
    :domain   :form
    :headers  :db
    :params   {:form "form definition with id and name"}
    :produces {:valid "boolean" :errors "vector of error maps"}
    :used-by  ['save-form!]
    :desc     "Validate form structure and cross-object references"}

   :lint-report
   {:method   :post
    :url      "/api/lint/report"
    :domain   :report
    :headers  :db
    :params   {:report "report definition with id and name"}
    :produces {:valid "boolean" :errors "vector of error maps"}
    :used-by  ['save-report!]
    :desc     "Validate report structure and cross-object references"}

   ;; ----------------------------------------------------------
   ;; Modules (3)
   ;; ----------------------------------------------------------
   :fetch-modules
   {:method   :get
    :url      "/api/modules"
    :domain   :module
    :headers  :db
    :params   {}
    :produces {:modules "vector of module names" :details "vector of {has_vba_source, has_cljs_source, description}"}
    :used-by  ['load-functions!]
    :desc     "List all VBA modules"}

   :fetch-module
   {:method   :get
    :url      "/api/modules/:module-name"
    :domain   :module
    :headers  :db
    :params   {}
    :produces {:vba_source "string" :cljs_source "string" :description "string"
               :status "string" :review_notes "string" :version "number" :created_at "string"}
    :used-by  ['load-module-for-viewing!]
    :desc     "Load full module source (VBA + CLJS translation)"}

   :save-module
   {:method   :put
    :url      "/api/modules/:module-name"
    :domain   :module
    :headers  :db
    :params   {:vba_source "string" :cljs_source "string" :status "string" :review_notes "string"}
    :produces {:version "number"}
    :used-by  ['save-module-cljs! 'create-new-module!]
    :desc     "Save module translation and status"}

   ;; ----------------------------------------------------------
   ;; SQL Functions (1)
   ;; ----------------------------------------------------------
   :fetch-sql-functions
   {:method   :get
    :url      "/api/functions"
    :domain   :function
    :headers  :db
    :params   {}
    :produces {:functions "vector of {name, arguments, returnType, source, description}"}
    :used-by  ['load-sql-functions!]
    :desc     "List all PostgreSQL functions"}

   ;; ----------------------------------------------------------
   ;; Macros (3)
   ;; ----------------------------------------------------------
   :fetch-macros
   {:method   :get
    :url      "/api/macros"
    :domain   :macro
    :headers  :db
    :params   {}
    :produces {:macros "vector of macro names" :details "vector of {has_macro_xml, has_cljs_source, description}"}
    :used-by  ['load-macros!]
    :desc     "List all Access macros"}

   :fetch-macro
   {:method   :get
    :url      "/api/macros/:macro-name"
    :domain   :macro
    :headers  :db
    :params   {}
    :produces {:macro_xml "string" :cljs_source "string" :description "string"
               :status "string" :review_notes "string" :version "number" :created_at "string"}
    :used-by  ['load-macro-for-viewing!]
    :desc     "Load full macro definition (XML + CLJS translation)"}

   :save-macro
   {:method   :put
    :url      "/api/macros/:macro-name"
    :domain   :macro
    :headers  :db
    :params   {:macro_xml "string" :cljs_source "string" :status "string" :review_notes "string"}
    :produces {:version "number"}
    :used-by  ['save-macro-cljs!]
    :desc     "Save macro translation and status"}

   ;; ----------------------------------------------------------
   ;; Chat & Transcripts (3)
   ;; ----------------------------------------------------------
   :send-chat-message
   {:method   :post
    :url      "/api/chat"
    :domain   :chat
    :headers  :db
    :params   {:message "user input" :history "conversation history"
               :database_id "current database" :form_context "optional" :report_context "optional"
               :module_context "optional" :macro_context "optional"
               :sql_function_context "optional" :table_context "optional"
               :query_context "optional" :issue_context "optional"}
    :produces {:message "LLM response" :updated_code "optional CLJS" :updated_query "optional"
               :navigation "optional {action, record_id}"}
    :used-by  ['send-chat-message!]
    :desc     "Send message to LLM with object context"}

   :translate-module
   {:method   :post
    :url      "/api/chat/translate"
    :domain   :chat
    :headers  :db
    :params   {:vba_source "VBA code" :module_name "string" :app_objects "inventory" :database_id "string"}
    :produces {:cljs_source "translated code"}
    :used-by  ['translate-module!]
    :desc     "Translate VBA module to ClojureScript via LLM"}

   :save-transcript
   {:method   :put
    :url      "/api/transcripts/:type/:name"
    :domain   :chat
    :headers  :db
    :params   {:transcript "vector of {role, content}"}
    :produces {}
    :used-by  ['save-chat-transcript!]
    :desc     "Save chat transcript for an object"}

   :fetch-transcript
   {:method   :get
    :url      "/api/transcripts/:type/:name"
    :domain   :chat
    :headers  :db
    :params   {}
    :produces {:transcript "vector of {role, content}"}
    :used-by  ['load-chat-transcript!]
    :desc     "Load saved chat transcript for an object"}

   ;; ----------------------------------------------------------
   ;; Session functions (5)
   ;; ----------------------------------------------------------
   :create-session
   {:method   :post
    :url      "/api/session"
    :domain   :session
    :headers  :none
    :params   {}
    :produces {:sessionId "string"}
    :used-by  ['call-session-function! 'run-before-update-hook!]
    :desc     "Create a new session context for function calls"}

   :set-session-state
   {:method   :put
    :url      "/api/session/:session-id/state"
    :domain   :session
    :headers  :none
    :params   {:state-vars "map of {field: {value, type}}"}
    :produces {}
    :used-by  ['call-session-function! 'run-before-update-hook!]
    :desc     "Populate session state variables before function execution"}

   :call-session-function
   {:method   :post
    :url      "/api/session/function/:function-name"
    :domain   :session
    :headers  :none
    :params   {:sessionId "string"}
    :produces {:userMessage "optional string" :navigateTo "optional form name" :confirmRequired "optional boolean"}
    :used-by  ['call-session-function! 'run-before-update-hook!]
    :desc     "Call a PostgreSQL function in session context"}

   :confirm-session-action
   {:method   :post
    :url      "/api/session/function/confirm_action"
    :domain   :session
    :headers  :none
    :params   {:sessionId "string"}
    :produces {}
    :used-by  ['handle-session-response!]
    :desc     "Confirm a user action requested by session function"}

   :delete-session
   {:method   :delete
    :url      "/api/session/:session-id"
    :domain   :session
    :headers  :none
    :params   {}
    :produces {}
    :used-by  ['call-session-function! 'run-before-update-hook!]
    :desc     "Clean up session after function execution"}

   ;; ----------------------------------------------------------
   ;; Form state sync (1)
   ;; ----------------------------------------------------------
   :sync-form-state
   {:method   :put
    :url      "/api/form-state"
    :domain   :form
    :headers  :none
    :params   {:sessionId "string" :entries "vector of {tableName, columnName, value}"}
    :produces {}
    :used-by  ['sync-form-state!]
    :desc     "Upsert tagged control values to shared.form_control_state"}

   ;; ----------------------------------------------------------
   ;; UI state persistence (2)
   ;; ----------------------------------------------------------
   :save-ui-state
   {:method   :put
    :url      "/api/session/ui-state"
    :domain   :config
    :headers  :session
    :params   {:database_id "string" :open_objects "vector" :active_tab "map" :app_mode "string"}
    :produces {}
    :used-by  ['save-ui-state!]
    :desc     "Save current UI state (open tabs, database, mode)"}

   :fetch-ui-state
   {:method   :get
    :url      "/api/session/ui-state"
    :domain   :config
    :headers  :session
    :params   {}
    :produces {:database_id "string" :open_objects "vector" :active_tab "map" :app_mode "string"}
    :used-by  ['load-ui-state!]
    :desc     "Load saved UI state"}

   ;; ----------------------------------------------------------
   ;; App configuration (2)
   ;; ----------------------------------------------------------
   :fetch-config
   {:method   :get
    :url      "/api/config"
    :domain   :config
    :headers  :session
    :params   {}
    :produces {:config "full config map"}
    :used-by  ['load-config!]
    :desc     "Load app configuration"}

   :save-config
   {:method   :put
    :url      "/api/config"
    :domain   :config
    :headers  :session
    :params   {:config "config map (capabilities stripped)"}
    :produces {}
    :used-by  ['save-config!]
    :desc     "Save app configuration"}

   ;; ----------------------------------------------------------
   ;; Events / Logging (1)
   ;; ----------------------------------------------------------
   :log-event
   {:method   :post
    :url      "/api/events"
    :domain   :logs
    :headers  :db
    :params   {:event_type "string" :source "string" :message "string" :details "map"}
    :produces {}
    :used-by  ['log-event!]
    :desc     "Log an event to shared.events"}

   ;; ----------------------------------------------------------
   ;; Import / Issues (4)
   ;; ----------------------------------------------------------
   :fetch-import-completeness
   {:method   :get
    :url      "/api/access-import/import-completeness"
    :domain   :logs
    :headers  :none
    :params   {:database_id "target database ID"}
    :produces {:missing "map of {type: [names]}"}
    :used-by  ['load-import-completeness!]
    :desc     "Check which Access objects have been imported"}

   :fetch-import-history
   {:method   :get
    :url      "/api/access-import/history"
    :domain   :logs
    :headers  :db
    :params   {:target_database_id "string" :limit "number"}
    :produces {:history "vector of import log entries"}
    :used-by  ['load-log-entries!]
    :desc     "Load import history for Logs mode"}

   :fetch-import-issues
   {:method   :get
    :url      "/api/import-issues"
    :domain   :logs
    :headers  :db
    :params   {:database_id "string" :import_log_id "optional number"}
    :produces {:issues "vector of issue maps"}
    :used-by  ['load-issues-for-entry! 'load-all-issues!]
    :desc     "Load import issues (optionally filtered by log entry)"}

   :toggle-issue-resolved
   {:method   :patch
    :url      "/api/import-issues/:issue-id"
    :domain   :logs
    :headers  :db
    :params   {:resolved "boolean"}
    :produces {}
    :used-by  ['toggle-issue-resolved!]
    :desc     "Toggle resolved status of an import issue"}

   ;; ----------------------------------------------------------
   ;; Access database scan (1)
   ;; ----------------------------------------------------------
   :scan-access-databases
   {:method   :get
    :url      "/api/access-import/scan"
    :domain   :database
    :headers  :none
    :params   {:locations "optional path to scan"}
    :produces {:databases "vector of Access database file info"}
    :used-by  ['load-access-databases!]
    :desc     "Scan for Access database files on disk"}})

;; ============================================================
;; DOM EFFECTS (8 call sites → 2 types)
;; ============================================================

(def dom-effects
  {:alert
   {:type    :dom
    :method  :alert
    :domain  :ui
    :desc    "Show a browser alert dialog"
    :used-by ['require-local! 'handle-session-response! 'call-session-function!
              'save-current-record! 'run-before-update-hook!]}

   :confirm
   {:type    :dom
    :method  :confirm
    :domain  :ui
    :desc    "Show a browser confirm dialog (returns true/false)"
    :used-by ['handle-session-response! 'set-table-view-mode!]}})

;; ============================================================
;; QUERY UTILITIES
;; ============================================================

(defn effect-by-name
  "Look up an HTTP effect by keyword name."
  [name]
  (get http-effects name))

(defn effects-for-domain
  "Return all HTTP effects for a given domain keyword."
  [domain]
  (into {}
        (filter (fn [[_ e]] (= (:domain e) domain)))
        http-effects))

(defn effects-used-by
  "Return all HTTP effect names used by a given function symbol."
  [fn-sym]
  (into #{}
        (comp (filter (fn [[_ e]] (some #(= % fn-sym) (:used-by e))))
              (map first))
        http-effects))

(defn all-effect-names
  "Return sorted vector of all HTTP effect names."
  []
  (vec (sort (keys http-effects))))

(defn effect-summary
  "Compact text overview of all effects for LLM context."
  []
  (let [by-domain (group-by :domain (vals http-effects))
        domain-order [:database :table :data :query :form :report :module :function
                      :macro :chat :session :config :logs :graph]]
    (str
     (str/join
      "\n\n"
      (for [d domain-order
            :let [effs (get by-domain d)]
            :when effs]
        (str "## " (str/upper-case (name d)) " (" (count effs) ")\n"
             (str/join
              "\n"
              (for [e (sort-by :url effs)]
                (str "  " (str/upper-case (name (:method e))) " " (:url e)
                     " — " (:desc e)))))))
     "\n\n## DOM (2)\n"
     "  alert — Show browser alert dialog\n"
     "  confirm — Show browser confirm dialog")))
