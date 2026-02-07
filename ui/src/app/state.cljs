(ns app.state
  "Application state management - core module"
  (:require [reagent.core :as r]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]))

(def api-base (str (.-protocol js/location) "//" (.-host js/location)))

;; Forward declarations for functions used before definition
(declare load-tables! load-queries! load-functions! load-access-databases!
         save-ui-state! load-forms! load-reports! filename->display-name)

;; Application state atom
(defonce app-state
  (r/atom {;; Database selection
           :available-databases []
           :current-database nil  ; {:database_id "calculator" :name "Recipe Calculator" ...}
           :loading-objects? false  ; true while loading tables/queries/functions

           ;; App configuration (loaded from settings/config.json)
           :config {:form-designer {:grid-size 8}}

           ;; UI state
           :loading? false
           :error nil
           :options-dialog-open? false
           :app-mode :run  ; :run or :import

           ;; Sidebar state
           :sidebar-collapsed? false
           :sidebar-object-type :forms

           ;; Objects by type (loaded from database)
           :objects {:tables []
                     :queries []
                     :forms []
                     :reports []
                     :modules []}

           ;; Open objects (tabs)
           :open-objects []  ; [{:type :forms :id 1 :name "CustomerForm"} ...]
           :active-tab nil   ; {:type :forms :id 1}

           ;; Form editor state
           :form-editor {:dirty? false
                         :original nil
                         :current nil
                         :selected-control nil}  ; index of selected control

           ;; Report editor state
           :report-editor {:dirty? false
                           :original nil
                           :current nil
                           :selected-control nil
                           :properties-tab :format
                           :view-mode :design
                           :records []}

           ;; Table viewer state
           :table-viewer {:table-id nil
                          :table-info nil  ; {:name "..." :fields [...]}
                          :records []
                          :view-mode :datasheet  ; :datasheet or :design
                          :loading? false}

           ;; Query viewer state
           :query-viewer {:query-id nil
                          :query-info nil  ; {:name "..." :sql "..." :fields [...]}
                          :sql ""          ; Current SQL (may be edited)
                          :results []
                          :result-fields []
                          :view-mode :results  ; :results or :sql
                          :loading? false
                          :error nil}

           ;; Module viewer state
           :module-viewer {:module-id nil
                           :module-info nil}  ; {:name "..." :source "..." :arguments "..." :return-type "..."}

           ;; Form runtime state (when viewing a form)
           :form-data {}
           :form-session nil

           ;; Chat panel state
           :chat-messages []  ; [{:role "user" :content "..."} {:role "assistant" :content "..."}]
           :chat-input ""
           :chat-loading? false
           :chat-panel-open? true}))

;; Loading/Error
(defn set-loading! [loading?]
  (swap! app-state assoc :loading? loading?))

(defn set-error! [error]
  (swap! app-state assoc :error error))

(defn clear-error! []
  (swap! app-state assoc :error nil))

;; Helper to get current database headers for API calls
(defn db-headers []
  (when-let [db-id (:database_id (:current-database @app-state))]
    {"X-Database-ID" db-id}))

;; ============================================================
;; SHARED HELPERS (used by form/report modules)
;; ============================================================

(defn parse-access-filter
  "Parse Access-style filter like \"[col]='val' AND col2='val2'\" into {col val}."
  [filter-str]
  (when (and filter-str (not (str/blank? filter-str)))
    (let [parts (str/split filter-str #"(?i)\s+AND\s+")]
      (reduce (fn [m part]
                (if-let [[_ col val] (re-matches #"\s*\[?(\w+)\]?\s*=\s*[\"']?([^\"']*)[\"']?\s*" part)]
                  (assoc m col val)
                  m))
              {} parts))))

(defn build-data-query-params
  "Build query params map from order-by and filter strings."
  [order-by filter-str]
  (let [filter-map (parse-access-filter filter-str)]
    (cond-> {:limit 1000}
      order-by (merge (let [parts (str/split (str/trim order-by) #"\s+")]
                        (cond-> {:orderBy (first parts)}
                          (= "DESC" (str/upper-case (or (second parts) "")))
                          (assoc :orderDir "desc"))))
      (seq filter-map) (assoc :filter (.stringify js/JSON (clj->js filter-map))))))

(defn record->api-map
  "Convert internal record to API-ready map: strip :__new__, keyword keys to strings."
  [record]
  (reduce-kv
    (fn [m k v]
      (if (= k :__new__) m
          (assoc m (if (keyword? k) (name k) k) v)))
    {} record))

(defn detect-pk-field
  "Find primary key field name from fields list, defaulting to 'id'."
  [fields]
  (or (some #(when (:pk %) (:name %)) fields) "id"))

(defn pk-value-for-record
  "Get the primary key value from a record."
  [record pk-field-name]
  (or (get record (keyword pk-field-name))
      (get record pk-field-name)))

;; Event logging
(defn log-event!
  "Log an event to the server"
  ([event-type message] (log-event! event-type message nil nil))
  ([event-type message source] (log-event! event-type message source nil))
  ([event-type message source details]
   (go
     (<! (http/post (str api-base "/api/events")
                    {:json-params {:event_type event-type
                                   :source (or source "ui")
                                   :message message
                                   :details details}
                     :headers (db-headers)})))))

(defn log-error!
  "Log an error and display it in the UI"
  ([message] (log-error! message nil nil))
  ([message source] (log-error! message source nil))
  ([message source details]
   (set-error! message)
   (log-event! "error" message source details)))

;; Database selection
(defn set-available-databases! [databases]
  (swap! app-state assoc :available-databases databases))

(defn set-current-database! [db]
  (swap! app-state assoc :current-database db))

(defn set-loading-objects! [loading?]
  (swap! app-state assoc :loading-objects? loading?))

;; Track pending object loads (tables, queries, functions)
(defonce pending-loads (atom 0))

;; Forward declarations for UI state restoration
(declare check-restore-ui-state!)

;; Pending UI state to restore after objects load
(defonce pending-ui-state (atom nil))

(defn start-loading-objects! []
  (reset! pending-loads 5)  ; 5 types: tables, queries, functions, forms, reports
  (set-loading-objects! true))

(defn object-load-complete! []
  (swap! pending-loads dec)
  (when (<= @pending-loads 0)
    (set-loading-objects! false)
    ;; Check if we should restore UI state
    (check-restore-ui-state!)))

(defn load-databases!
  "Load available databases from API and set current, then load objects"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/databases")))]
      (if (:success response)
        (let [databases (get-in response [:body :databases])
              server-current-id (get-in response [:body :current])
              ;; Use saved database ID if available, otherwise server's current
              saved-db-id (:saved-database-id @app-state)
              target-id (or saved-db-id server-current-id)
              current-db (first (filter #(= (:database_id %) target-id) databases))]
          (set-available-databases! databases)
          (set-current-database! (or current-db (first databases)))
          ;; Clear the saved-database-id now that we've used it
          (swap! app-state dissoc :saved-database-id)
          ;; Now load objects for the current database
          (start-loading-objects!)
          (load-tables!)
          (load-queries!)
          (load-functions!)
          (load-forms!)
          (load-reports!))
        (log-error! "Failed to load databases" "load-databases" {:response (:body response)})))))

(defn switch-database!
  "Switch to a different database"
  [database-id]
  (go
    (set-loading! true)
    (let [response (<! (http/post (str api-base "/api/databases/switch")
                                  {:json-params {:database_id database-id}}))]
      (set-loading! false)
      (if (:success response)
        (let [new-db (first (filter #(= (:database_id %) database-id)
                                    (:available-databases @app-state)))]
          (set-current-database! new-db)
          ;; Clear open tabs when switching databases
          (swap! app-state assoc :open-objects [] :active-tab nil)
          ;; Save cleared UI state
          (save-ui-state!)
          ;; Reload objects for new database
          (start-loading-objects!)
          (load-tables!)
          (load-queries!)
          (load-functions!)
          (load-forms!)
          (load-reports!)
)
        (log-error! "Failed to switch database" "switch-database" {:response (:body response)})))))

;; Sidebar
(defn toggle-sidebar! []
  (swap! app-state update :sidebar-collapsed? not))

(defn set-sidebar-object-type! [object-type]
  (swap! app-state assoc :sidebar-object-type object-type))

;; App mode (Import / Run)
(defn set-app-mode! [mode]
  (swap! app-state assoc :app-mode mode)
  (save-ui-state!))

;; Objects
(defn set-objects! [object-type objects]
  (swap! app-state assoc-in [:objects object-type] objects))

(defn add-object! [object-type obj]
  (swap! app-state update-in [:objects object-type] conj obj))

(defn update-object! [object-type id updates]
  (swap! app-state update-in [:objects object-type]
         (fn [objects]
           (mapv (fn [obj]
                   (if (= (:id obj) id)
                     (merge obj updates)
                     obj))
                 objects))))

;; Tabs
(defn open-object!
  "Open an object in a new tab (or switch to existing tab)"
  [object-type object-id]
  (let [tab {:type object-type :id object-id}
        current-open (:open-objects @app-state)
        already-open? (some #(and (= (:type %) object-type)
                                  (= (:id %) object-id))
                            current-open)]
    (when-not already-open?
      (let [obj (first (filter #(= (:id %) object-id)
                               (get-in @app-state [:objects object-type])))]
        (swap! app-state update :open-objects conj
               (assoc tab :name (:name obj)))))
    (swap! app-state assoc :active-tab tab)
    ;; Save UI state
    (save-ui-state!)))

(defn close-tab!
  "Close a tab"
  [object-type object-id]
  (let [tab-to-close {:type object-type :id object-id}
        current-open (:open-objects @app-state)
        new-open (vec (remove #(and (= (:type %) object-type)
                                    (= (:id %) object-id))
                              current-open))
        active (:active-tab @app-state)]
    (swap! app-state assoc :open-objects new-open)
    ;; If we closed the active tab, switch to another
    (when (and (= (:type active) object-type)
               (= (:id active) object-id))
      (swap! app-state assoc :active-tab
             (when (seq new-open)
               {:type (:type (last new-open))
                :id (:id (last new-open))})))
    ;; Save UI state
    (save-ui-state!)))

(defn set-active-tab! [object-type object-id]
  (swap! app-state assoc :active-tab {:type object-type :id object-id})
  ;; Save UI state
  (save-ui-state!))

;; Context menu
(defn show-context-menu! [x y]
  (swap! app-state assoc :context-menu {:x x :y y :visible? true}))

(defn hide-context-menu! []
  (swap! app-state assoc-in [:context-menu :visible?] false))

;; ============================================================
;; SHARED NORMALIZATION HELPERS (used by state_form & state_report)
;; ============================================================

(def yes-no-control-props
  "Control properties that use yes/no (1/0) values."
  [:visible :enabled :locked :tab-stop])

(def yes-no-control-defaults
  "Default values for yes/no control properties."
  {:visible 1 :enabled 1 :locked 0 :tab-stop 1})

(def number-control-props
  "Control properties that should be numbers."
  [:width :height :x :y :font-size :tab-index])

(defn coerce-yes-no
  "Coerce any truthy/falsy value to 1 or 0."
  [v]
  (cond
    (nil? v)             nil
    (number? v)          (if (zero? v) 0 1)
    (boolean? v)         (if v 1 0)
    (string? v)          (if (#{"true" "yes" "1"} (.toLowerCase v)) 1 0)
    :else                1))

(defn coerce-to-number
  "Coerce a value to number. nil->nil, number->number, string->parseFloat, else->nil."
  [v]
  (cond
    (nil? v)    nil
    (number? v) v
    (string? v) (let [n (js/parseFloat v)]
                  (when-not (js/isNaN n) n))
    :else       nil))

(defn coerce-to-keyword
  "Coerce a value to keyword. nil->nil, keyword->keyword, string->keyword, else->passthrough."
  [v]
  (cond
    (nil? v)     nil
    (keyword? v) v
    (string? v)  (keyword (clojure.string/replace v #"^:" ""))
    :else        v))

(defn normalize-control
  "Normalize a single control: keywordize :type, coerce yes/no and number props."
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

;; Options dialog
(defn open-options-dialog! []
  (swap! app-state assoc :options-dialog-open? true))

(defn close-options-dialog! []
  (swap! app-state assoc :options-dialog-open? false))

;; Config
(defn get-grid-size []
  (get-in @app-state [:config :form-designer :grid-size] 8))

(defn set-grid-size! [size]
  (swap! app-state assoc-in [:config :form-designer :grid-size] size))

;; ============================================================
;; LOAD REPORTS (stays in core - called by load-databases!)
;; ============================================================

(defn load-reports!
  "Load all reports for current database from API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/reports")
                                  {:headers (db-headers)}))]
      (if (:success response)
        (let [reports-data (get-in response [:body :reports] [])
              details (get-in response [:body :details] [])]
          (swap! app-state assoc-in [:objects :reports]
                 (vec (map-indexed
                        (fn [idx report-name]
                          (let [detail (nth details idx nil)]
                            {:id (inc idx)
                             :name (filename->display-name report-name)
                             :filename report-name
                             :record-source (:record_source detail)}))
                        reports-data)))
          (object-load-complete!))
        (do
          (log-event! "warning" "Could not load reports from API" "load-reports")
          (object-load-complete!))))))

;; ============================================================
;; MODULE VIEWER
;; ============================================================

(defn load-module-for-viewing!
  "Load a module/function for viewing"
  [module]
  (swap! app-state assoc :module-viewer
         {:module-id (:id module)
          :module-info module}))

;; ============================================================
;; UI STATE PERSISTENCE
;; ============================================================

(defn save-ui-state!
  "Save current UI state (open tabs, active tab, database, app mode) to server"
  []
  (let [current-db (:current-database @app-state)
        open-objects (:open-objects @app-state)
        active-tab (:active-tab @app-state)
        ui-state {:database_id (:database_id current-db)
                  :open_objects (vec (map #(select-keys % [:type :id :name]) open-objects))
                  :active_tab (when active-tab
                                (select-keys active-tab [:type :id]))
                  :app_mode (name (or (:app-mode @app-state) :run))}]
    (go
      (<! (http/put (str api-base "/api/session/ui-state")
                    {:json-params ui-state})))))

(defn restore-ui-state!
  "Restore UI state after objects are loaded"
  [ui-state]
  (when ui-state
    (let [open-objects (:open_objects ui-state)
          active-tab (:active_tab ui-state)]
      ;; Restore open tabs - match against loaded objects to get full info
      (when (seq open-objects)
        (let [restored-tabs
              (vec (keep (fn [tab]
                           (let [obj-type (keyword (:type tab))
                                 obj-id (:id tab)
                                 objects (get-in @app-state [:objects obj-type])
                                 obj (first (filter #(= (:id %) obj-id) objects))]
                             (when obj
                               {:type obj-type
                                :id obj-id
                                :name (:name obj)})))
                         open-objects))]
          (swap! app-state assoc :open-objects restored-tabs)))
      ;; Restore active tab
      (when active-tab
        (swap! app-state assoc :active-tab
               {:type (keyword (:type active-tab))
                :id (:id active-tab)})))))

(defn load-ui-state!
  "Load saved UI state from server"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/session/ui-state")))]
      (when (:success response)
        (:body response)))))

;; Config file operations
(defn load-config!
  "Load app configuration from settings/config.json"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/config")))]
      (if (:success response)
        (let [config (:body response)]  ;; Already parsed by cljs-http
          (swap! app-state assoc :config config))
        (log-event! "warning" "Could not load config - using defaults" "load-config")))))

(defn save-config!
  "Save app configuration to settings/config.json"
  []
  (go
    (let [config (:config @app-state)
          response (<! (http/put (str api-base "/api/config")
                                 {:json-params config}))]
      (when-not (:success response)
        (log-error! "Failed to save configuration" "save-config" {:response (:body response)})))))

;; Form operations (load from database via API)

(defn filename->display-name
  "Convert filename to display name: recipe_calculator -> Recipe Calculator"
  [filename]
  (->> (str/split filename #"_")
       (map str/capitalize)
       (str/join " ")))

(defn load-forms!
  "Load all forms for current database from API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/forms")
                                  {:headers (db-headers)}))]
      (if (:success response)
        (let [forms-data (get-in response [:body :forms] [])
              details (get-in response [:body :details] [])]
          ;; Build forms list from API response
          (swap! app-state assoc-in [:objects :forms]
                 (vec (map-indexed
                        (fn [idx form-name]
                          (let [detail (nth details idx nil)]
                            {:id (inc idx)
                             :name (filename->display-name form-name)
                             :filename form-name
                             :record-source (:record_source detail)}))
                        forms-data)))
          (object-load-complete!))
        (do
          (log-event! "warning" "Could not load forms from API" "load-forms")
          (object-load-complete!))))))

(defn- transform-api-field
  "Transform a single API field into internal format."
  [field]
  {:name (:name field) :type (:type field)
   :pk (:isPrimaryKey field) :nullable (:nullable field)
   :fk (when (:isForeignKey field) (:foreignTable field))
   :default (:default field) :max-length (:maxLength field)
   :precision (:precision field) :scale (:scale field)
   :description (:description field) :indexed (:indexed field)
   :check-constraint (:checkConstraint field)})

(defn load-tables!
  "Load tables from PostgreSQL via backend API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/tables")
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [tables (get-in response [:body :tables])
              tables-with-ids (vec (map-indexed
                                    (fn [idx table]
                                      {:id (inc idx) :name (:name table)
                                       :description (:description table)
                                       :fields (mapv transform-api-field (:fields table))})
                                    tables))]
          (swap! app-state assoc-in [:objects :tables] tables-with-ids)
          (object-load-complete!))
        (do
          (log-error! "Failed to load tables from database" "load-tables" {:response (:body response)})
          (object-load-complete!))))))

;; Load queries (views) from database API
(defn load-queries!
  "Load queries/views from PostgreSQL via backend API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/queries")
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [queries (get-in response [:body :queries])
              ;; Add an id to each query for UI compatibility
              queries-with-ids (map-indexed
                                (fn [idx query]
                                  {:id (inc idx)
                                   :name (:name query)
                                   :sql (:sql query)
                                   :fields (mapv (fn [field]
                                                   {:name (:name field)
                                                    :type (:type field)
                                                    :nullable (:nullable field)})
                                                 (:fields query))})
                                queries)]
          (swap! app-state assoc-in [:objects :queries] (vec queries-with-ids))
          (object-load-complete!))
        (do
          (log-error! "Failed to load queries from database" "load-queries" {:response (:body response)})
          (object-load-complete!))))))

;; Load functions from database API
(defn load-functions!
  "Load functions from PostgreSQL via backend API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/functions")
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [functions (get-in response [:body :functions])
              ;; Add an id to each function
              functions-with-ids (map-indexed
                                  (fn [idx func]
                                    {:id (inc idx)
                                     :name (:name func)
                                     :arguments (:arguments func)
                                     :return-type (:returnType func)
                                     :source (:source func)
                                     :description (:description func)})
                                  functions)]
          (swap! app-state assoc-in [:objects :modules] (vec functions-with-ids))
          (object-load-complete!))
        (do
          (log-error! "Failed to load functions from database" "load-functions" {:response (:body response)})
          (object-load-complete!))))))

;; Load Access databases (scan for .accdb files)
(defn load-access-databases!
  "Scan for Access database files on disk"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/access-import/scan")))]
      (if (:success response)
        (let [databases (get-in response [:body :databases] [])]
          (swap! app-state assoc-in [:objects :access_databases] databases))
        (log-error! "Failed to scan for Access databases" "load-access-databases")))))

;; Chat panel
(defn toggle-chat-panel! []
  (swap! app-state update :chat-panel-open? not))

(defn set-chat-input! [text]
  (swap! app-state assoc :chat-input text))

(defn add-chat-message! [role content]
  (swap! app-state update :chat-messages conj {:role role :content content}))

(defn set-chat-loading! [loading?]
  (swap! app-state assoc :chat-loading? loading?))

(defn- get-record-source-fields-for-chat
  "Inline field lookup for chat navigation (avoids circular dep with state_form)."
  [record-source]
  (when record-source
    (let [tables (get-in @app-state [:objects :tables])
          queries (get-in @app-state [:objects :queries])
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

(defn navigate-to-record-by-id!
  "Navigate to a record by its primary key ID (used by chat)"
  [record-id]
  (let [records (get-in @app-state [:form-editor :records] [])
        record-source (get-in @app-state [:form-editor :current :record-source])
        fields (get-record-source-fields-for-chat record-source)
        pk-field-name (or (some #(when (:pk %) (:name %)) fields) "id")
        ;; Find the position of the record with this ID
        pos (first (keep-indexed
                    (fn [idx rec]
                      (when (= (or (get rec (keyword pk-field-name))
                                   (get rec pk-field-name))
                               record-id)
                        (inc idx)))
                    records))]
    (when pos
      ;; Inline navigate logic (avoids circular dep with state_form/navigate-to-record!)
      (let [total (count records)]
        (when (and (> total 0) (<= pos total))
          (swap! app-state assoc-in [:form-editor :record-position] {:current pos :total total})
          (swap! app-state assoc-in [:form-editor :current-record] (nth records (dec pos)))
          (swap! app-state assoc-in [:form-editor :record-dirty?] false))))))

(defn send-chat-message!
  "Send a message to the LLM and get a response"
  []
  (let [input (str/trim (:chat-input @app-state))]
    (when (not (str/blank? input))
      (add-chat-message! "user" input)
      (set-chat-input! "")
      (set-chat-loading! true)
      (go
        (let [record-source (get-in @app-state [:form-editor :current :record-source])
              form-context (when record-source
                             {:record_source record-source})
              response (<! (http/post (str api-base "/api/chat")
                                      {:json-params {:message input
                                                     :database_id (:database_id (:current-database @app-state))
                                                     :form_context form-context}
                                       :headers (db-headers)}))]
          (set-chat-loading! false)
          (if (:success response)
            (do
              (add-chat-message! "assistant" (get-in response [:body :message]))
              ;; Handle navigation command if present
              (when-let [nav (get-in response [:body :navigation])]
                (when (= (:action nav) "navigate")
                  (navigate-to-record-by-id! (:record_id nav)))))
            (add-chat-message! "assistant" (str "Error: " (get-in response [:body :error] "Failed to get response")))))))))

(defn check-restore-ui-state!
  "Check if we should restore UI state (called after each object type loads)"
  []
  (when (and @pending-ui-state (not (:loading-objects? @app-state)))
    ;; All objects loaded, now restore UI state
    (restore-ui-state! @pending-ui-state)
    (reset! pending-ui-state nil)))

;; Initialize - load objects from files and database
(defn init! []
  (go
    ;; First, load saved UI state
    (let [saved-ui-state (<! (load-ui-state!))]
      (when saved-ui-state
        ;; Store for later restoration
        (reset! pending-ui-state saved-ui-state)
        ;; Restore app mode (import/run)
        (when-let [saved-mode (:app_mode saved-ui-state)]
          (swap! app-state assoc :app-mode (keyword saved-mode)))
        ;; If saved state has a database, switch to it
        (when-let [saved-db-id (:database_id saved-ui-state)]
          ;; We'll handle this after loading databases
          (swap! app-state assoc :saved-database-id saved-db-id))))

    ;; Load available databases (sets current database, then loads all objects)
    (load-databases!)

    ;; Load app configuration
    (load-config!)

))
