(ns app.state
  "Application state management - core module"
  (:require [reagent.core :as r]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]))

(def api-base (str (.-protocol js/location) "//" (.-host js/location)))

;; Forward declarations for functions used before definition
(declare load-tables! load-queries! load-functions! load-sql-functions! load-macros! load-access-databases!
         save-ui-state! load-forms! load-reports! filename->display-name
         save-chat-transcript! add-chat-message! set-chat-input! send-chat-message!
         maybe-auto-analyze! load-import-completeness! load-log-entries!)

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
           :app-mode :run  ; :run, :import, or :logs

           ;; Logs mode state
           :logs-entries []           ;; Import log entries for sidebar
           :logs-selected-entry nil   ;; Currently selected entry
           :logs-issues []            ;; Issues for selected entry
           :logs-loading? false
           :logs-filter {:object-type nil :status nil}

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
           :chat-panel-open? true
           :chat-tab nil}))  ; {:type :forms :id 1 :name "MyForm"} - tab owning current transcript

;; Loading/Error
(defn set-loading! [loading?]
  (swap! app-state assoc :loading? loading?))

(defn set-error! [error]
  (swap! app-state assoc :error error))

(defn clear-error! []
  (swap! app-state assoc :error nil))

;; Stable session ID for form state sync (generated once on app init)
(defonce session-id (str (random-uuid)))

;; Helper to get current database headers for API calls
(defn db-headers []
  (cond-> {"X-Session-ID" session-id}
    (some? (:database_id (:current-database @app-state)))
    (assoc "X-Database-ID" (:database_id (:current-database @app-state)))))

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
  (reset! pending-loads 7)  ; 7 types: tables, queries, sql-functions, modules, macros, forms, reports
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
          (load-sql-functions!)
          (load-macros!)
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
          ;; Save current transcript before switching databases
          (save-chat-transcript!)
          (set-current-database! new-db)
          ;; Clear open tabs and chat when switching databases
          (swap! app-state assoc :open-objects [] :active-tab nil
                 :chat-messages [] :chat-tab nil)
          ;; Save cleared UI state
          (save-ui-state!)
          ;; Reload objects for new database
          (start-loading-objects!)
          (load-tables!)
          (load-queries!)
          (load-functions!)
          (load-sql-functions!)
          (load-macros!)
          (load-forms!)
          (load-reports!))
        (log-error! "Failed to switch database" "switch-database" {:response (:body response)})))))

;; Sidebar
(defn toggle-sidebar! []
  (swap! app-state update :sidebar-collapsed? not))

(defn set-sidebar-object-type! [object-type]
  (swap! app-state assoc :sidebar-object-type object-type))

;; App mode (Import / Run / Logs)
(defn set-app-mode! [mode]
  (swap! app-state assoc :app-mode mode)
  (when (= mode :logs)
    (load-log-entries!))
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

;; ============================================================
;; CHAT TRANSCRIPT PERSISTENCE
;; ============================================================

(defn- object-type->transcript-type
  "Map object type keyword to transcript API type string."
  [obj-type]
  (case obj-type
    :tables "tables"
    :queries "queries"
    :sql-functions "sql-functions"
    :forms "forms"
    :reports "reports"
    :modules "modules"
    (name obj-type)))

(defn- tab->object-name
  "Get the object name for a tab (looks up from open-objects)."
  [tab]
  (let [open-objects (:open-objects @app-state)
        obj (first (filter #(and (= (:type %) (:type tab))
                                  (= (:id %) (:id tab)))
                           open-objects))]
    (:name obj)))

(defn save-chat-transcript!
  "Save current chat messages to the server for the current chat-tab."
  []
  (when-let [chat-tab (:chat-tab @app-state)]
    (let [messages (:chat-messages @app-state)]
      (when (seq messages)
        (let [obj-name (or (:name chat-tab) (tab->object-name chat-tab))
              obj-type (object-type->transcript-type (:type chat-tab))]
          (when obj-name
            (go
              (<! (http/put (str api-base "/api/transcripts/"
                                 (js/encodeURIComponent obj-type) "/"
                                 (js/encodeURIComponent obj-name))
                            {:json-params {:transcript (vec messages)}
                             :headers (db-headers)})))))))))

(defn load-chat-transcript!
  "Load chat transcript from server for the given tab, set as current chat."
  [tab]
  (let [obj-name (or (:name tab) (tab->object-name tab))
        obj-type (object-type->transcript-type (:type tab))]
    (when obj-name
      (swap! app-state assoc :chat-tab (assoc tab :name obj-name))
      (go
        (let [response (<! (http/get (str api-base "/api/transcripts/"
                                          (js/encodeURIComponent obj-type) "/"
                                          (js/encodeURIComponent obj-name))
                                     {:headers (db-headers)}))]
          (if (and (:success response)
                   (seq (get-in response [:body :transcript])))
            (swap! app-state assoc :chat-messages
                   (vec (map #(select-keys % [:role :content])
                             (get-in response [:body :transcript]))))
            (do
              (swap! app-state assoc :chat-messages [])
              ;; Auto-analyze all object types with no transcript
              (when (#{:reports :forms :sql-functions :tables :queries :modules :macros} (:type tab))
                (swap! app-state assoc :auto-analyze-pending true)
                (maybe-auto-analyze!)))))))))

;; Tabs
(defn open-object!
  "Open an object in a new tab (or switch to existing tab)"
  [object-type object-id]
  (let [tab {:type object-type :id object-id}
        current-open (:open-objects @app-state)
        already-open? (some #(and (= (:type %) object-type)
                                  (= (:id %) object-id))
                            current-open)]
    ;; Save current transcript before switching
    (save-chat-transcript!)
    (when-not already-open?
      (let [obj (first (filter #(= (:id %) object-id)
                               (get-in @app-state [:objects object-type])))]
        (swap! app-state update :open-objects conj
               (assoc tab :name (:name obj)))))
    (swap! app-state assoc :active-tab tab)
    ;; Load transcript for the new tab
    (load-chat-transcript! tab)
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
        active (:active-tab @app-state)
        closing-active? (and (= (:type active) object-type)
                              (= (:id active) object-id))]
    ;; Save transcript before closing if this is the active tab
    (when closing-active?
      (save-chat-transcript!))
    (swap! app-state assoc :open-objects new-open)
    ;; If we closed the active tab, switch to another
    (when closing-active?
      (let [new-tab (when (seq new-open)
                      {:type (:type (last new-open))
                       :id (:id (last new-open))})]
        (swap! app-state assoc :active-tab new-tab)
        (if new-tab
          (load-chat-transcript! new-tab)
          ;; No tabs left - clear chat
          (swap! app-state assoc :chat-messages [] :chat-tab nil))))
    ;; Save UI state
    (save-ui-state!)))

(defn set-active-tab! [object-type object-id]
  ;; Save current transcript before switching
  (save-chat-transcript!)
  (let [tab {:type object-type :id object-id}]
    (swap! app-state assoc :active-tab tab)
    ;; Load transcript for the new tab
    (load-chat-transcript! tab))
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
  "Load a VBA module for viewing - fetches full source from API"
  [module]
  (swap! app-state assoc :module-viewer
         {:module-id (:id module)
          :module-info module
          :loading? true})
  (load-import-completeness!)
  (go
    (let [response (<! (http/get (str api-base "/api/modules/" (js/encodeURIComponent (:name module)))
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [data (:body response)]
          (swap! app-state assoc :module-viewer
                 {:module-id (:id module)
                  :module-info (merge module
                                      {:vba-source (:vba_source data)
                                       :cljs-source (:cljs_source data)
                                       :description (:description data)
                                       :status (or (:status data) "pending")
                                       :review-notes (:review_notes data)
                                       :version (:version data)
                                       :created-at (:created_at data)})
                  :loading? false})
          (maybe-auto-analyze!))
        (swap! app-state assoc-in [:module-viewer :loading?] false)))))

(defn- get-app-objects
  "Build a compact inventory of all database objects (names only) for LLM context."
  []
  (let [objects (:objects @app-state)]
    {:tables  (mapv :name (:tables objects))
     :queries (mapv :name (:queries objects))
     :forms   (mapv :name (:forms objects))
     :reports (mapv :name (:reports objects))
     :modules (mapv :name (:modules objects))
     :macros  (mapv :name (:macros objects))}))

(defn load-import-completeness!
  "Load import completeness status for the current database."
  []
  (when-let [db-id (:database_id (:current-database @app-state))]
    (go
      (let [response (<! (http/get (str api-base "/api/access-import/import-completeness")
                                   {:query-params {:database_id db-id}}))]
        (when (:success response)
          (swap! app-state assoc :import-completeness (:body response)))))))

(defn translate-module!
  "Send VBA source to LLM for translation to ClojureScript.
   Translation appears in the chat panel, not in a separate editor."
  []
  (let [module-info (get-in @app-state [:module-viewer :module-info])
        vba-source (:vba-source module-info)]
    (when vba-source
      (swap! app-state assoc-in [:module-viewer :translating?] true)
      ;; Open chat panel if closed
      (when-not (:chat-panel-open? @app-state)
        (swap! app-state assoc :chat-panel-open? true))
      (go
        (let [response (<! (http/post (str api-base "/api/chat/translate")
                                      {:json-params {:vba_source vba-source
                                                     :module_name (:name module-info)
                                                     :app_objects (get-app-objects)
                                                     :database_id (:database_id (:current-database @app-state))}
                                       :headers (db-headers)}))]
          (swap! app-state assoc-in [:module-viewer :translating?] false)
          (if (:success response)
            (let [cljs-source (get-in response [:body :cljs_source])]
              ;; Store the translation
              (swap! app-state assoc-in [:module-viewer :module-info :cljs-source] cljs-source)
              (swap! app-state assoc-in [:module-viewer :cljs-dirty?] true)
              ;; Show translation in chat and auto-submit for review
              (when cljs-source
                (add-chat-message! "assistant" (str "Here is the ClojureScript translation:\n\n" cljs-source))
                (set-chat-input! "Please review this translation for issues.")
                (send-chat-message!)))
            ;; Handle blocked translation (incomplete import)
            (let [missing (get-in response [:body :missing])
                  error-msg (get-in response [:body :error] "Unknown error")]
              (if missing
                (let [parts (keep (fn [[type-key names]]
                                    (when (seq names)
                                      (str (name type-key) ": " (str/join ", " names))))
                                  missing)]
                  (set-error! (str "Translation blocked — import these objects first: "
                                   (str/join "; " parts))))
                (log-error! (str "Translation failed: " error-msg)
                            "translate-module")))))))))

(defn save-module-cljs!
  "Save the ClojureScript translation to the database"
  []
  (let [module-info (get-in @app-state [:module-viewer :module-info])
        cljs-source (:cljs-source module-info)]
    (when (and (:name module-info) cljs-source)
      (go
        (let [response (<! (http/put (str api-base "/api/modules/" (js/encodeURIComponent (:name module-info)))
                                     {:json-params {:vba_source (:vba-source module-info)
                                                    :cljs_source cljs-source
                                                    :status (:status module-info)
                                                    :review_notes (:review-notes module-info)}
                                      :headers (db-headers)}))]
          (if (:success response)
            (do
              (swap! app-state assoc-in [:module-viewer :cljs-dirty?] false)
              (swap! app-state assoc-in [:module-viewer :module-info :version]
                     (get-in response [:body :version])))
            (log-error! "Failed to save module translation" "save-module-cljs")))))))

(defn update-module-cljs-source!
  "Update the ClojureScript source in the editor (marks dirty)"
  [new-source]
  (swap! app-state assoc-in [:module-viewer :module-info :cljs-source] new-source)
  (swap! app-state assoc-in [:module-viewer :cljs-dirty?] true))

(defn set-module-status!
  "Set the translation status and optional review notes for the current module"
  [status & [review-notes]]
  (swap! app-state assoc-in [:module-viewer :module-info :status] status)
  (when review-notes
    (swap! app-state assoc-in [:module-viewer :module-info :review-notes] review-notes))
  (swap! app-state assoc-in [:module-viewer :cljs-dirty?] true))

;; ============================================================
;; MODULE CREATION
;; ============================================================

(defn create-new-module! []
  (let [existing-modules (get-in @app-state [:objects :modules])
        new-id (inc (reduce max 0 (map :id existing-modules)))
        mod-name (str "Module" new-id)
        new-module {:id new-id
                    :name mod-name
                    :has-vba-source false
                    :has-cljs-source false}]
    (add-object! :modules new-module)
    (open-object! :modules new-id)
    ;; Create on server immediately with draft status
    (go
      (let [response (<! (http/put (str api-base "/api/modules/" (js/encodeURIComponent mod-name))
                                   {:json-params {:cljs_source ""
                                                  :status "draft"}
                                    :headers (db-headers)}))]
        (when-not (:success response)
          (log-error! "Failed to create new module on server" "create-new-module"))))))

;; ============================================================
;; FUNCTION CREATION
;; ============================================================

(defn create-new-function! []
  (let [existing-fns (get-in @app-state [:objects :sql-functions])
        new-id (inc (reduce max 0 (map :id existing-fns)))
        fn-name (str "new_function_" new-id)
        new-fn {:id new-id
                :name fn-name
                :is-new? true
                :arguments ""
                :return-type "void"
                :source ""
                :description ""}]
    (add-object! :sql-functions new-fn)
    (open-object! :sql-functions new-id)))

;; ============================================================
;; MACRO VIEWER
;; ============================================================

(defn load-macro-for-viewing!
  "Load an Access macro for viewing - fetches full XML from API"
  [macro]
  (swap! app-state assoc :macro-viewer
         {:macro-id (:id macro)
          :macro-info macro
          :loading? true})
  (load-import-completeness!)
  (go
    (let [response (<! (http/get (str api-base "/api/macros/" (js/encodeURIComponent (:name macro)))
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [data (:body response)]
          (swap! app-state assoc :macro-viewer
                 {:macro-id (:id macro)
                  :macro-info (merge macro
                                     {:macro-xml (:macro_xml data)
                                      :cljs-source (:cljs_source data)
                                      :description (:description data)
                                      :status (or (:status data) "pending")
                                      :review-notes (:review_notes data)
                                      :version (:version data)
                                      :created-at (:created_at data)})
                  :loading? false})
          (maybe-auto-analyze!))
        (swap! app-state assoc-in [:macro-viewer :loading?] false)))))

(defn save-macro-cljs!
  "Save the ClojureScript translation for a macro"
  []
  (let [macro-info (get-in @app-state [:macro-viewer :macro-info])
        cljs-source (:cljs-source macro-info)]
    (when (and (:name macro-info) cljs-source)
      (go
        (let [response (<! (http/put (str api-base "/api/macros/" (js/encodeURIComponent (:name macro-info)))
                                     {:json-params {:macro_xml (:macro-xml macro-info)
                                                    :cljs_source cljs-source
                                                    :status (:status macro-info)
                                                    :review_notes (:review-notes macro-info)}
                                      :headers (db-headers)}))]
          (if (:success response)
            (do
              (swap! app-state assoc-in [:macro-viewer :cljs-dirty?] false)
              (swap! app-state assoc-in [:macro-viewer :macro-info :version]
                     (get-in response [:body :version])))
            (log-error! "Failed to save macro translation" "save-macro-cljs")))))))

(defn set-macro-status!
  "Set the translation status for the current macro"
  [status]
  (swap! app-state assoc-in [:macro-viewer :macro-info :status] status)
  (swap! app-state assoc-in [:macro-viewer :cljs-dirty?] true))

;; ============================================================
;; LOGS MODE
;; ============================================================

(defn load-log-entries!
  "Load import history for the current database"
  []
  (let [db-id (:database_id (:current-database @app-state))]
    (when db-id
      (swap! app-state assoc :logs-loading? true)
      (go
        (let [response (<! (http/get (str api-base "/api/access-import/history")
                                     {:query-params {:target_database_id db-id
                                                     :limit 200}}))]
          (swap! app-state assoc :logs-loading? false)
          (if (:success response)
            (swap! app-state assoc :logs-entries (get-in response [:body :history] []))
            (log-error! "Failed to load import history" "load-log-entries")))))))

(defn load-issues-for-entry!
  "Load issues for a specific import log entry"
  [entry]
  (let [db-id (:database_id (:current-database @app-state))]
    (when (and db-id (:id entry))
      (swap! app-state assoc :logs-loading? true)
      (go
        (let [response (<! (http/get (str api-base "/api/import-issues")
                                     {:query-params {:database_id db-id
                                                     :import_log_id (:id entry)}}))]
          (swap! app-state assoc :logs-loading? false)
          (if (:success response)
            (swap! app-state assoc :logs-issues (get-in response [:body :issues] []))
            (log-error! "Failed to load issues" "load-issues-for-entry")))))))

(defn load-all-issues!
  "Load all issues for the current database (no entry filter)"
  []
  (let [db-id (:database_id (:current-database @app-state))]
    (when db-id
      (swap! app-state assoc :logs-loading? true)
      (go
        (let [response (<! (http/get (str api-base "/api/import-issues")
                                     {:query-params {:database_id db-id}}))]
          (swap! app-state assoc :logs-loading? false)
          (if (:success response)
            (swap! app-state assoc :logs-issues (get-in response [:body :issues] []))
            (log-error! "Failed to load issues" "load-all-issues")))))))

(defn select-log-entry!
  "Select a log entry and load its issues"
  [entry]
  (swap! app-state assoc :logs-selected-entry entry)
  (if entry
    (load-issues-for-entry! entry)
    (load-all-issues!))
  ;; Load chat transcript for this entry
  (when entry
    (load-chat-transcript! {:type :logs
                            :name (str (:source_object_type entry) "/" (:source_object_name entry))})))

(defn toggle-issue-resolved!
  "Toggle the resolved status of an issue"
  [issue-id currently-resolved?]
  (go
    (let [response (<! (http/patch (str api-base "/api/import-issues/" issue-id)
                                   {:json-params {:resolved (not currently-resolved?)}}))]
      (if (:success response)
        ;; Refresh issues list
        (let [entry (:logs-selected-entry @app-state)]
          (if entry
            (load-issues-for-entry! entry)
            (load-all-issues!))
          ;; Also refresh log entries to update badge counts
          (load-log-entries!))
        (log-error! "Failed to update issue" "toggle-issue-resolved")))))

(defn set-logs-filter!
  "Update logs filter and re-query"
  [filter-key value]
  (swap! app-state assoc-in [:logs-filter filter-key] value))

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
      ;; Restore active tab and load its transcript
      (when active-tab
        (let [tab {:type (keyword (:type active-tab))
                   :id (:id active-tab)}]
          (swap! app-state assoc :active-tab tab)
          (load-chat-transcript! tab))))))

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
    (let [config (dissoc (:config @app-state) :capabilities) ;; Don't persist server-computed capabilities
          response (<! (http/put (str api-base "/api/config")
                                 {:json-params config}))]
      (when-not (:success response)
        (log-error! "Failed to save configuration" "save-config" {:response (:body response)})))))

(defn has-capability?
  "Check if a server capability is available (e.g. :file-system, :powershell, :access-import)"
  [cap]
  (get-in @app-state [:config :capabilities cap]))

(defn require-local!
  "Check if a local capability is available. If not, show a message directing
   the user to accessclone.com for web conversion help. Returns true if available."
  [cap]
  (if (has-capability? cap)
    true
    (do (js/alert "This feature requires a local installation and can't run from the web. Visit accessclone.com for help converting your application to run on the web.")
        false)))

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

;; Load modules (VBA) from shared.modules table
(defn load-functions!
  "Load VBA modules from shared.modules via backend API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/modules")
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [module-names (get-in response [:body :modules] [])
              details (get-in response [:body :details] [])
              modules-with-ids (vec (map-indexed
                                      (fn [idx mod-name]
                                        (let [detail (nth details idx nil)]
                                          {:id (inc idx)
                                           :name mod-name
                                           :has-vba-source (:has_vba_source detail)
                                           :has-cljs-source (:has_cljs_source detail)
                                           :description (:description detail)}))
                                      module-names))]
          (swap! app-state assoc-in [:objects :modules] modules-with-ids)
          (object-load-complete!))
        (do
          (log-event! "warning" "Could not load modules from API" "load-functions")
          (object-load-complete!))))))

;; Load SQL functions (PostgreSQL functions created from imported queries)
(defn load-sql-functions!
  "Load SQL functions from PostgreSQL via backend API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/functions")
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [functions (get-in response [:body :functions] [])
              fns-with-ids (vec (map-indexed
                                  (fn [idx f]
                                    {:id (inc idx)
                                     :name (:name f)
                                     :arguments (:arguments f)
                                     :return-type (:returnType f)
                                     :source (:source f)
                                     :description (:description f)})
                                  functions))]
          (swap! app-state assoc-in [:objects :sql-functions] fns-with-ids)
          (object-load-complete!))
        (do
          (log-event! "warning" "Could not load SQL functions from API" "load-sql-functions")
          (object-load-complete!))))))

;; Load macros from shared.macros via backend API
(defn load-macros!
  "Load Access macros from shared.macros via backend API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/macros")
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [macro-names (get-in response [:body :macros] [])
              details (get-in response [:body :details] [])
              macros-with-ids (vec (map-indexed
                                     (fn [idx macro-name]
                                       (let [detail (nth details idx nil)]
                                         {:id (inc idx)
                                          :name macro-name
                                          :has-macro-xml (:has_macro_xml detail)
                                          :has-cljs-source (:has_cljs_source detail)
                                          :description (:description detail)}))
                                     macro-names))]
          (swap! app-state assoc-in [:objects :macros] macros-with-ids)
          (object-load-complete!))
        (do
          (log-event! "warning" "Could not load macros from API" "load-macros")
          (object-load-complete!))))))

;; Create a new database (schema + shared.databases row)
(defn create-database!
  "Create a new database via POST /api/databases, add to available-databases on success.
   Calls on-success with the new database map, or on-error with error string."
  [name description on-success on-error]
  (go
    (let [response (<! (http/post (str api-base "/api/databases")
                                  {:json-params {:name name :description description}}))]
      (if (:success response)
        (let [new-db (get-in response [:body :database])]
          (swap! app-state update :available-databases conj new-db)
          (when on-success (on-success new-db)))
        (let [err-msg (or (get-in response [:body :error]) "Failed to create database")]
          (log-error! err-msg "create-database!")
          (when on-error (on-error err-msg)))))))

;; Load Access databases (scan for .accdb files)
(defn load-access-databases!
  "Scan for Access database files on disk. When locations is provided, pass it
   as a query param to limit the scan to that path (folder or file)."
  ([] (load-access-databases! nil))
  ([locations]
   (go
     (let [url (cond-> (str api-base "/api/access-import/scan")
                 locations (str "?locations=" (js/encodeURIComponent locations)))
           response (<! (http/get url))]
       (if (:success response)
         (let [databases (get-in response [:body :databases] [])]
           (swap! app-state assoc-in [:objects :access_databases] databases))
         (log-error! "Failed to scan for Access databases" "load-access-databases"))))))

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
        (let [active-tab (:active-tab @app-state)
              ;; Form context: record source + full definition when viewing a form
              form-def (get-in @app-state [:form-editor :current])
              form-context (when (= (:type active-tab) :forms)
                             (cond-> {}
                               (:record-source form-def) (assoc :record_source (:record-source form-def))
                               form-def (assoc :definition (clj->js form-def))))
              ;; Report context when viewing a report
              report-context (when (= (:type active-tab) :reports)
                               (let [rpt (get-in @app-state [:report-editor :current])]
                                 (when rpt
                                   {:report_name (:name rpt)
                                    :record_source (:record-source rpt)
                                    :definition (clj->js rpt)})))
              ;; Module context when viewing a module
              module-info (get-in @app-state [:module-viewer :module-info])
              module-context (when (and (= (:type active-tab) :modules)
                                       (:name module-info))
                               {:module_name (:name module-info)
                                :cljs_source (:cljs-source module-info)
                                :vba_source (:vba-source module-info)
                                :app_objects (get-app-objects)})
              ;; Query context when viewing a query/view
              query-context (when (= (:type active-tab) :queries)
                              (let [qi (get-in @app-state [:query-viewer :query-info])]
                                (when qi
                                  {:query_name (:name qi)
                                   :sql (:sql qi)
                                   :fields (mapv (fn [f] {:name (:name f) :type (:type f)})
                                                 (:fields qi))})))
              ;; Table context when viewing a table
              table-context (when (= (:type active-tab) :tables)
                              (let [tbl (get-in @app-state [:table-viewer :table-info])]
                                (when tbl
                                  {:table_name (:name tbl)
                                   :description (:description tbl)
                                   :fields (mapv (fn [f] {:name (:name f)
                                                          :type (:type f)
                                                          :pk (:pk f)
                                                          :nullable (:nullable f)})
                                                 (:fields tbl))})))
              ;; SQL function context when viewing a SQL function
              sql-fn-context (when (= (:type active-tab) :sql-functions)
                               (let [func (first (filter #(= (:id %) (:id active-tab))
                                                         (get-in @app-state [:objects :sql-functions])))]
                                 (when func
                                   {:function_name (:name func)
                                    :arguments (:arguments func)
                                    :return_type (:return-type func)
                                    :source (:source func)})))
              ;; Macro context when viewing a macro
              macro-info (get-in @app-state [:macro-viewer :macro-info])
              macro-context (when (and (= (:type active-tab) :macros)
                                       (:name macro-info))
                              {:macro_name (:name macro-info)
                               :macro_xml (:macro-xml macro-info)
                               :cljs_source (:cljs-source macro-info)
                               :app_objects (get-app-objects)})
              ;; Issue context when in Logs mode
              logs-entry (:logs-selected-entry @app-state)
              issue-context (when (and (= (:app-mode @app-state) :logs) logs-entry)
                              {:import_log_entry logs-entry
                               :issues (:logs-issues @app-state)
                               :object_name (:source_object_name logs-entry)
                               :object_type (:source_object_type logs-entry)})
              ;; Send full conversation history for context
              history (vec (:chat-messages @app-state))
              response (<! (http/post (str api-base "/api/chat")
                                      {:json-params {:message input
                                                     :history history
                                                     :database_id (:database_id (:current-database @app-state))
                                                     :form_context form-context
                                                     :report_context report-context
                                                     :module_context module-context
                                                     :macro_context macro-context
                                                     :sql_function_context sql-fn-context
                                                     :table_context table-context
                                                     :query_context query-context
                                                     :issue_context issue-context}
                                       :headers (db-headers)}))]
          (set-chat-loading! false)
          (if (:success response)
            (do
              (add-chat-message! "assistant" (get-in response [:body :message]))
              ;; Handle updated code from LLM edits
              (when-let [updated-code (get-in response [:body :updated_code])]
                (swap! app-state assoc-in [:module-viewer :module-info :cljs-source] updated-code)
                (swap! app-state assoc-in [:module-viewer :cljs-dirty?] true))
              ;; Handle updated query/function from LLM DDL execution
              (when-let [uq (get-in response [:body :updated_query])]
                (load-queries!)
                (load-sql-functions!))
              ;; Handle navigation command if present
              (when-let [nav (get-in response [:body :navigation])]
                (when (= (:action nav) "navigate")
                  (navigate-to-record-by-id! (:record_id nav))))
              ;; Auto-save transcript after assistant reply
              (save-chat-transcript!))
            (do
              (add-chat-message! "assistant" (str "Error: " (get-in response [:body :error] "Failed to get response")))
              ;; Save even error responses to preserve context
              (save-chat-transcript!))))))))

(defn maybe-auto-analyze!
  "If auto-analyze is pending and the object definition is loaded, send an
   initial analysis to the chat. Called from load-chat-transcript! (when
   transcript is empty) and from setup-form-editor!/setup-report-editor!
   (when definition finishes loading) — whichever completes second triggers.
   For sql-functions, the definition is already loaded in :objects so it fires immediately."
  []
  (when (:auto-analyze-pending @app-state)
    (let [active-tab (:active-tab @app-state)
          tab-type (:type active-tab)
          has-def? (case tab-type
                     :reports (some? (get-in @app-state [:report-editor :current]))
                     :forms   (some? (get-in @app-state [:form-editor :current]))
                     :sql-functions (some? (first (filter #(= (:id %) (:id active-tab))
                                                         (get-in @app-state [:objects :sql-functions]))))
                     :tables  (some? (get-in @app-state [:table-viewer :table-info]))
                     :queries (some? (get-in @app-state [:query-viewer :query-info]))
                     :modules (and (some? (get-in @app-state [:module-viewer :module-info]))
                                   (not (get-in @app-state [:module-viewer :loading?])))
                     :macros  (and (some? (get-in @app-state [:macro-viewer :macro-info]))
                                   (not (get-in @app-state [:macro-viewer :loading?])))
                     false)]
      (when has-def?
        (swap! app-state dissoc :auto-analyze-pending)
        (let [prompt (case tab-type
                       :reports "Briefly describe this report's structure and purpose. Note any potential issues such as missing field bindings, empty bands, layout problems, or other concerns."
                       :forms   "Briefly describe this form's structure and purpose. Note any potential issues such as missing field bindings, empty sections, layout problems, or other concerns."
                       :sql-functions (let [func (first (filter #(= (:id %) (:id active-tab))
                                                               (get-in @app-state [:objects :sql-functions])))]
                                        (str "Analyze this SQL function and briefly describe its purpose, parameters, and return type. "
                                             "Note any potential issues.\n\n"
                                             (:source func)))
                       :tables (let [tbl (get-in @app-state [:table-viewer :table-info])
                                     fields (:fields tbl)
                                     field-summary (clojure.string/join ", "
                                                     (map (fn [f] (str (:name f) " (" (:type f)
                                                                       (when (:pk f) " PK") ")"))
                                                          fields))]
                                 (str "Briefly describe this table's structure and likely purpose. "
                                      "Note any potential issues such as missing primary keys, unusual data types, or naming concerns.\n\n"
                                      "Table: " (:name tbl) "\n"
                                      (when (:description tbl) (str "Description: " (:description tbl) "\n"))
                                      "Columns: " field-summary))
                       :queries (let [qi (get-in @app-state [:query-viewer :query-info])
                                      fields (:fields qi)
                                      field-summary (clojure.string/join ", " (map :name fields))]
                                  (str "Briefly describe this query/view's purpose. "
                                       "Note any potential issues such as missing joins, performance concerns, or unusual patterns.\n\n"
                                       "Query: " (:name qi) "\n"
                                       "SQL: " (:sql qi) "\n"
                                       (when (seq fields) (str "Fields: " field-summary))))
                       :modules (let [mi (get-in @app-state [:module-viewer :module-info])]
                                  (str "Briefly describe this VBA module's purpose and functionality. "
                                       "Note any potential issues or complexities for translation to ClojureScript.\n\n"
                                       "Module: " (:name mi) "\n"
                                       (when (:vba-source mi) (str "VBA Source:\n" (:vba-source mi)))))
                       :macros (let [mi (get-in @app-state [:macro-viewer :macro-info])]
                                 (str "Briefly describe this Access macro's actions and purpose. "
                                      "Note any potential issues or complexities for conversion to web application event handlers.\n\n"
                                      "Macro: " (:name mi) "\n"
                                      (when (:macro-xml mi) (str "XML Definition:\n" (:macro-xml mi)))))
                       nil)]
          (when prompt
            (set-chat-input! prompt)
            (send-chat-message!)))))))

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
