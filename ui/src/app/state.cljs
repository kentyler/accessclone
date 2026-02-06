(ns app.state
  "Application state management"
  (:require [reagent.core :as r]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]))

(def api-base "http://localhost:3001")

;; Forward declarations for functions used before definition
(declare load-tables! load-queries! load-functions! load-access-databases!
         save-ui-state! save-current-record! save-form! save-form-to-file!
         get-record-source-fields delete-current-record! load-form-for-editing!)

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
  (reset! pending-loads 3)  ; 3 types: tables, queries, functions
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
          (println "Loaded" (count databases) "databases, current:" (:name current-db))
          ;; Now load objects for the current database
          (start-loading-objects!)
          (load-tables!)
          (load-queries!)
          (load-functions!))
        (do
          (println "Error loading databases:" (:body response))
          (log-error! "Failed to load databases" "load-databases" {:response (:body response)}))))))

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
          (println "Switched to database:" (:name new-db)))
        (do
          (println "Error switching database:" (:body response))
          (log-error! "Failed to switch database" "switch-database" {:response (:body response)}))))))

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

;; Context menu
(defn show-context-menu! [x y]
  (swap! app-state assoc :context-menu {:x x :y y :visible? true}))

(defn hide-context-menu! []
  (swap! app-state assoc-in [:context-menu :visible?] false))

;; Form-view record context menu & clipboard
(def form-clipboard (atom nil))

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

;; Form creation
(defn create-new-form! []
  (let [existing-forms (get-in @app-state [:objects :forms])
        new-id (inc (reduce max 0 (map :id existing-forms)))
        new-form {:id new-id
                  :name (str "Form" new-id)
                  :definition {:type :form
                               :record-source nil
                               :controls []}}]
    (add-object! :forms new-form)
    (open-object! :forms new-id)))

;; Form editor
(defn set-form-definition! [definition]
  (swap! app-state assoc-in [:form-editor :current] definition)
  (swap! app-state assoc-in [:form-editor :dirty?]
         (not= definition (get-in @app-state [:form-editor :original]))))

(defn clear-lint-errors! []
  (swap! app-state assoc-in [:form-editor :lint-errors] nil))

(defn set-lint-errors! [errors]
  (swap! app-state assoc-in [:form-editor :lint-errors] errors))

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
                (do
                  (do-save-form!)
                  (println "Form saved successfully"))
                (do
                  (set-lint-errors! (:errors result))
                  (println "Form has validation errors:" (:errors result)))))
            (do
              ;; Lint endpoint failed, save anyway
              (println "Lint check failed, saving anyway")
              (do-save-form!))))))))

;; ============================================================
;; SESSION-STATE FUNCTION CALLING
;; ============================================================

(defn call-session-function!
  "Call a PostgreSQL function through the session-state pipeline.
   1. Create session  2. Set form field values as state vars
   3. Call function    4. Handle response (message/navigate/confirm)
   5. Refresh data     6. Clear session"
  [function-name & [{:keys [on-complete]}]]
  (go
    (println "Calling session function:" function-name)
    ;; 1. Create session
    (let [session-resp (<! (http/post (str api-base "/api/session")))]
      (if-not (:success session-resp)
        (println "Error creating session:" (:body session-resp))
        (let [session-id (get-in session-resp [:body :sessionId])]
          (println "Session created:" session-id)
          ;; 2. Build state vars from current record fields
          (let [current-record (get-in @app-state [:form-editor :current-record] {})
                state-vars (reduce-kv
                            (fn [m k v]
                              (if (= k :__new__)
                                m
                                (assoc m (if (keyword? k) (name k) (str k))
                                       {:value (str v) :type "text"})))
                            {}
                            current-record)]
            ;; Set state vars (only if we have some)
            (when (seq state-vars)
              (<! (http/put (str api-base "/api/session/" session-id "/state")
                            {:json-params state-vars})))
            ;; 3. Call the function
            (let [func-resp (<! (http/post (str api-base "/api/session/function/" function-name)
                                           {:json-params {:sessionId session-id}}))]
              (if-not (:success func-resp)
                (do
                  (println "Error calling function:" (:body func-resp))
                  (js/alert (str "Error calling " function-name ": "
                                 (get-in func-resp [:body :details]
                                         (get-in func-resp [:body :error] "Unknown error")))))
                (let [body (:body func-resp)
                      user-message (:userMessage body)
                      navigate-to (:navigateTo body)
                      confirm-required (:confirmRequired body)]
                  (println "Function response:" body)
                  ;; 4. Handle response
                  (when user-message
                    (js/alert user-message))
                  (when navigate-to
                    ;; Find form in sidebar objects by name, open it
                    (let [forms (get-in @app-state [:objects :forms])
                          target-form (first (filter #(= (str/lower-case (:name %))
                                                         (str/lower-case navigate-to))
                                                     forms))]
                      (if target-form
                        (do
                          (open-object! :forms (:id target-form))
                          (load-form-for-editing! target-form))
                        (println "Navigate target form not found:" navigate-to))))
                  (when confirm-required
                    (when (js/confirm "Confirm action?")
                      ;; Call confirm_action function with the same session
                      (<! (http/post (str api-base "/api/session/function/confirm_action")
                                     {:json-params {:sessionId session-id}}))))
                  ;; 5. Refresh form data if function may have mutated
                  (let [record-source (get-in @app-state [:form-editor :current :record-source])]
                    (when record-source
                      (let [order-by (get-in @app-state [:form-editor :current :order-by])
                            filter-str (get-in @app-state [:form-editor :current :filter])
                            filter-map (when (and filter-str (not (str/blank? filter-str)))
                                         (let [parts (str/split filter-str #"(?i)\s+AND\s+")]
                                           (reduce (fn [m part]
                                                     (if-let [[_ col val] (re-matches #"\s*\[?(\w+)\]?\s*=\s*[\"']?([^\"']*)[\"']?\s*" part)]
                                                       (assoc m col val)
                                                       m))
                                                   {} parts)))
                            query-params (cond-> {:limit 1000}
                                           order-by (merge (let [parts (str/split (str/trim order-by) #"\s+")]
                                                             (cond-> {:orderBy (first parts)}
                                                               (= "DESC" (str/upper-case (or (second parts) "")))
                                                               (assoc :orderDir "desc"))))
                                           (seq filter-map) (assoc :filter (.stringify js/JSON (clj->js filter-map))))
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
                            (swap! app-state assoc-in [:form-editor :record-dirty?] false))))))
                  ;; Callback if provided
                  (when on-complete
                    (on-complete body)))))
            ;; 6. Clear session
            (<! (http/delete (str api-base "/api/session/" session-id)))))))))

(defn fire-form-event!
  "Check if the current form has a function mapped to the given event key,
   and if so, call it via call-session-function!. Returns a channel."
  [event-key & [{:keys [on-complete]}]]
  (let [form-def (get-in @app-state [:form-editor :current])
        function-name (get form-def event-key)]
    (when (and function-name (string? function-name) (not (str/blank? function-name)))
      (println "Firing form event" event-key "→" function-name)
      (call-session-function! function-name {:on-complete on-complete}))))

;; View mode
(defn set-view-mode! [mode]
  "Set form view mode - :design or :view"
  (let [current-mode (get-in @app-state [:form-editor :view-mode] :design)]
    ;; Auto-save dirty record when leaving view mode
    (when (and (= current-mode :view) (not= mode :view))
      (when (get-in @app-state [:form-editor :record-dirty?])
        (save-current-record!)))
    (swap! app-state assoc-in [:form-editor :view-mode] mode)
    ;; When switching to view mode, load data
    (when (= mode :view)
      (let [record-source (get-in @app-state [:form-editor :current :record-source])
            data-entry? (not= 0 (get-in @app-state [:form-editor :current :data-entry] 0))]
        (when record-source
          (if data-entry?
            ;; Data entry mode: start with a blank new record, don't load existing
            (let [new-record {:__new__ true}]
              (swap! app-state assoc-in [:form-editor :records] [new-record])
              (swap! app-state assoc-in [:form-editor :current-record] new-record)
              (swap! app-state assoc-in [:form-editor :record-position] {:current 1 :total 1})
              (swap! app-state assoc-in [:form-editor :record-dirty?] true)
              (fire-form-event! :on-load))
            ;; Normal mode: fetch records from API
            (go
              (let [order-by (get-in @app-state [:form-editor :current :order-by])
                    filter-str (get-in @app-state [:form-editor :current :filter])
                    ;; Parse Access-style filter like "[col]='val' AND col2='val2'" into {col val}
                    filter-map (when (and filter-str (not (str/blank? filter-str)))
                                 (let [parts (str/split filter-str #"(?i)\s+AND\s+")]
                                   (reduce (fn [m part]
                                             (if-let [[_ col val] (re-matches #"\s*\[?(\w+)\]?\s*=\s*[\"']?([^\"']*)[\"']?\s*" part)]
                                               (assoc m col val)
                                               m))
                                           {} parts)))
                    query-params (cond-> {:limit 1000}
                                   order-by (merge (let [parts (str/split (str/trim order-by) #"\s+")]
                                                     (cond-> {:orderBy (first parts)}
                                                       (= "DESC" (str/upper-case (or (second parts) "")))
                                                       (assoc :orderDir "desc"))))
                                   (seq filter-map) (assoc :filter (.stringify js/JSON (clj->js filter-map))))
                    response (<! (http/get (str api-base "/api/data/" record-source)
                                           {:query-params query-params
                                            :headers (db-headers)}))]
                (if (:success response)
                  (let [data (get-in response [:body :data])
                        total (get-in response [:body :pagination :totalCount] (count data))]
                    (println "Loaded" (count data) "records from" record-source)
                    (when (seq data)
                      (println "First record keys:" (keys (first data)))
                      (println "First record:" (first data)))
                    (swap! app-state assoc-in [:form-editor :records] (vec data))
                    (swap! app-state assoc-in [:form-editor :record-position] {:current 1 :total total})
                    (swap! app-state assoc-in [:form-editor :record-dirty?] false)
                    (when (seq data)
                      (swap! app-state assoc-in [:form-editor :current-record] (first data)))
                    ;; Fire on-load event after data is loaded
                    (fire-form-event! :on-load))
                  (println "Error loading data:" (:body response)))))))))))

(defn get-view-mode []
  (get-in @app-state [:form-editor :view-mode] :design))

;; Record navigation state
(defn set-current-record! [record]
  (swap! app-state assoc-in [:form-editor :current-record] record))

(defn set-record-position! [pos total]
  (swap! app-state assoc-in [:form-editor :record-position] {:current pos :total total}))

(defn update-record-field! [field-name value]
  (println "update-record-field!" field-name "=" value)
  (swap! app-state assoc-in [:form-editor :current-record (keyword field-name)] value)
  ;; Mark the record as dirty
  (swap! app-state assoc-in [:form-editor :record-dirty?] true)
  (println "Record marked dirty, current-record:" (get-in @app-state [:form-editor :current-record])))

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
      ;; Fire on-current event after navigating to new record
      (fire-form-event! :on-current))))

(defn save-current-record!
  "Save the current record to the database"
  []
  (println "=== save-current-record! called ===")
  (let [record-source (get-in @app-state [:form-editor :current :record-source])
        current-record (get-in @app-state [:form-editor :current-record])
        records (get-in @app-state [:form-editor :records] [])
        pos (get-in @app-state [:form-editor :record-position :current] 1)
        record-dirty? (get-in @app-state [:form-editor :record-dirty?])]
    (println "Conditions:" {:record-source record-source
                            :current-record current-record
                            :record-dirty? record-dirty?})
    (if (and record-source current-record record-dirty?)
      (go
        ;; Check before-update event — if mapped, run the function first
        (let [before-update-fn (get-in @app-state [:form-editor :current :before-update])
              abort? (when (and before-update-fn (string? before-update-fn)
                                (not (str/blank? before-update-fn)))
                       ;; Create session, set state, call function, check for validation error
                       (let [sess-resp (<! (http/post (str api-base "/api/session")))]
                         (if-not (:success sess-resp)
                           false  ; session failed, proceed with save
                           (let [session-id (get-in sess-resp [:body :sessionId])
                                 state-vars (reduce-kv
                                             (fn [m k v]
                                               (if (= k :__new__) m
                                                   (assoc m (if (keyword? k) (name k) (str k))
                                                          {:value (str v) :type "text"})))
                                             {} current-record)
                                 _ (when (seq state-vars)
                                     (<! (http/put (str api-base "/api/session/" session-id "/state")
                                                   {:json-params state-vars})))
                                 func-resp (<! (http/post (str api-base "/api/session/function/" before-update-fn)
                                                          {:json-params {:sessionId session-id}}))
                                 user-msg (when (:success func-resp)
                                            (get-in func-resp [:body :userMessage]))
                                 should-abort (boolean user-msg)]
                             ;; Clean up session
                             (<! (http/delete (str api-base "/api/session/" session-id)))
                             (when user-msg
                               (js/alert user-msg))
                             should-abort))))]
          (when-not abort?
            ;; Find primary key - check for pk flag or common names
            (let [fields (get-record-source-fields record-source)
                  pk-field-name (or (some #(when (:pk %) (:name %)) fields)
                                    "id")
                  pk-value (or (get current-record (keyword pk-field-name))
                               (get current-record pk-field-name))
                  is-new? (or (:__new__ current-record)
                              (nil? pk-value)
                              (= pk-value ""))
                  record-for-api (reduce-kv
                                  (fn [m k v]
                                    (if (= k :__new__)
                                      m
                                      (assoc m (if (keyword? k) (name k) k) v)))
                                  {}
                                  current-record)]
              (println "Saving record:" {:pk pk-field-name :pk-value pk-value :is-new? is-new? :data record-for-api})
              (if is-new?
                ;; Insert new record
                (let [insert-data (if (= pk-field-name "id")
                                    (dissoc record-for-api "id")
                                    record-for-api)
                      response (<! (http/post (str api-base "/api/data/" record-source)
                                              {:json-params insert-data
                                               :headers (db-headers)}))]
                  (if (:success response)
                    (do
                      (println "Record inserted successfully")
                      (let [new-record (get-in response [:body :data])]
                        (swap! app-state assoc-in [:form-editor :records (dec pos)] new-record)
                        (swap! app-state assoc-in [:form-editor :current-record] new-record)
                        (swap! app-state assoc-in [:form-editor :record-dirty?] false)))
                    (println "Error inserting record:" (:body response))))
                ;; Update existing record
                (let [update-data (dissoc record-for-api pk-field-name)
                      url (str api-base "/api/data/" record-source "/" pk-value)
                      _ (println "PUT URL:" url)
                      _ (println "PUT data:" update-data)
                      _ (println "PUT headers:" (db-headers))
                      response (<! (http/put url {:json-params update-data
                                                  :headers (db-headers)}))]
                  (println "PUT response:" {:success (:success response)
                                            :status (:status response)
                                            :body (:body response)})
                  (if (:success response)
                    (do
                      (println "Record updated successfully")
                      (let [updated-record (get-in response [:body :data])]
                        (swap! app-state assoc-in [:form-editor :records (dec pos)] updated-record)
                        (swap! app-state assoc-in [:form-editor :current-record] updated-record)
                        (swap! app-state assoc-in [:form-editor :record-dirty?] false)))
                    (println "Error updating record:" (:body response)))))))))
      (println "Save skipped - conditions not met"))))

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

(defn delete-current-record!
  "Delete the current record from the database"
  []
  (let [record-source (get-in @app-state [:form-editor :current :record-source])
        current-record (get-in @app-state [:form-editor :current-record])
        records (get-in @app-state [:form-editor :records] [])
        pos (get-in @app-state [:form-editor :record-position :current] 1)]
    (when (and record-source current-record)
      (let [fields (get-record-source-fields record-source)
            pk-field-name (or (some #(when (:pk %) (:name %)) fields) "id")
            pk-value (or (get current-record (keyword pk-field-name))
                         (get current-record pk-field-name))]
        (when pk-value
          (go
            (let [response (<! (http/delete (str api-base "/api/data/" record-source "/" pk-value)
                                            {:headers (db-headers)}))]
              (if (:success response)
                (let [new-records (vec (concat (subvec records 0 (dec pos))
                                               (subvec records pos)))
                      new-total (count new-records)
                      new-pos (min pos new-total)]
                  (swap! app-state assoc-in [:form-editor :records] new-records)
                  (if (> new-total 0)
                    (do
                      (swap! app-state assoc-in [:form-editor :record-position] {:current new-pos :total new-total})
                      (swap! app-state assoc-in [:form-editor :current-record] (nth new-records (dec new-pos)))
                      (swap! app-state assoc-in [:form-editor :record-dirty?] false))
                    (do
                      (swap! app-state assoc-in [:form-editor :record-position] {:current 0 :total 0})
                      (swap! app-state assoc-in [:form-editor :current-record] {})
                      (swap! app-state assoc-in [:form-editor :record-dirty?] false)))
                  (println "Record deleted successfully"))
                (println "Error deleting record:" (:body response))))))))))

(defn get-record-source-fields
  "Get fields for a record source (table or query)"
  [record-source]
  (when record-source
    (let [tables (get-in @app-state [:objects :tables])
          queries (get-in @app-state [:objects :queries])
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

(def ^:private yes-no-form-props
  "Form properties that use yes/no (1/0) values."
  [:popup :modal :allow-additions :allow-deletions :allow-edits
   :navigation-buttons :record-selectors :dividing-lines :data-entry])

(def ^:private yes-no-defaults
  "Default values for yes/no form properties (matching Access defaults)."
  {:popup 0 :modal 0 :allow-additions 1 :allow-deletions 1 :allow-edits 1
   :navigation-buttons 1 :record-selectors 1 :dividing-lines 1 :data-entry 0})

(def ^:private yes-no-control-props
  "Control properties that use yes/no (1/0) values."
  [:visible :enabled :locked :tab-stop])

(def ^:private yes-no-control-defaults
  "Default values for yes/no control properties."
  {:visible 1 :enabled 1 :locked 0 :tab-stop 1})

(def ^:private number-form-props
  "Form properties that should be numbers."
  [:width])

(def ^:private number-control-props
  "Control properties that should be numbers."
  [:width :height :x :y :font-size :tab-index])

(defn- coerce-yes-no
  "Coerce any truthy/falsy value to 1 or 0."
  [v]
  (cond
    (nil? v)             nil
    (number? v)          (if (zero? v) 0 1)
    (boolean? v)         (if v 1 0)
    (string? v)          (if (#{"true" "yes" "1"} (.toLowerCase v)) 1 0)
    :else                1))

(defn- coerce-to-number
  "Coerce a value to number. nil->nil, number->number, string->parseFloat, else->nil."
  [v]
  (cond
    (nil? v)    nil
    (number? v) v
    (string? v) (let [n (js/parseFloat v)]
                  (when-not (js/isNaN n) n))
    :else       nil))

(defn- coerce-to-keyword
  "Coerce a value to keyword. nil->nil, keyword->keyword, string->keyword, else->passthrough."
  [v]
  (cond
    (nil? v)     nil
    (keyword? v) v
    (string? v)  (keyword (clojure.string/replace v #"^:" ""))
    :else        v))

(defn- normalize-control
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

(defn load-form-for-editing! [form]
  ;; Auto-save dirty record before switching forms
  (when (get-in @app-state [:form-editor :record-dirty?])
    (save-current-record!))
  ;; Auto-save current form definition if dirty before loading new one
  (when (get-in @app-state [:form-editor :dirty?])
    (save-form!))
  ;; Check if definition is already loaded
  (if (:definition form)
    ;; Definition already loaded, use it
    (let [def-with-defaults (normalize-form-definition (:definition form))]
      (swap! app-state assoc :form-editor
             {:form-id (:id form)
              :dirty? false
              :original def-with-defaults
              :current def-with-defaults
              :selected-control nil})
      (set-view-mode! :view))
    ;; Need to fetch definition from API
    (go
      (let [response (<! (http/get (str api-base "/api/forms/" (:filename form))
                                    {:headers (db-headers)}))]
        (if (:success response)
          (let [body (:body response)
                definition (normalize-form-definition (dissoc body :id :name))]
            (println "Loaded form definition, keys:" (keys definition))
            (println "default-view:" (:default-view definition))
            ;; Update form in objects list with definition
            (swap! app-state update-in [:objects :forms]
                   (fn [forms]
                     (mapv (fn [f]
                             (if (= (:id f) (:id form))
                               (assoc f :definition definition)
                               f))
                           forms)))
            ;; Set up form editor
            (swap! app-state assoc :form-editor
                   {:form-id (:id form)
                    :dirty? false
                    :original definition
                    :current definition
                    :selected-control nil})
            (set-view-mode! :view))
          (println "Error loading form:" (:filename form)))))))

(defn select-control! [idx]
  (swap! app-state assoc-in [:form-editor :selected-control] idx))

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
          (swap! app-state assoc :config config)
          (println "Config loaded:" config))
        (println "Could not load config - using defaults")))))

(defn save-config!
  "Save app configuration to settings/config.json"
  []
  (go
    (let [config (:config @app-state)
          response (<! (http/put (str api-base "/api/config")
                                 {:json-params config}))]
      (if (:success response)
        (println "Config saved")
        (do
          (println "Error saving config:" (:body response))
          (log-error! "Failed to save configuration" "save-config" {:response (:body response)}))))))

;; Form operations (load from database via API)

(defn- filename->display-name
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
          (println "Loading forms:" forms-data)
          ;; Build forms list from API response
          (swap! app-state assoc-in [:objects :forms]
                 (vec (map-indexed
                        (fn [idx form-name]
                          (let [detail (nth details idx nil)]
                            {:id (inc idx)
                             :name (filename->display-name form-name)
                             :filename form-name
                             :record-source (:record_source detail)}))
                        forms-data))))
        (println "Could not load forms from API")))))

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
            (println "Saved form:" filename)
            ;; Update the form's filename in state
            (swap! app-state update-in [:objects :forms]
                   (fn [forms]
                     (mapv (fn [f]
                             (if (= (:id f) (:id form))
                               (assoc f :filename filename)
                               f))
                           forms))))
          (do
            (println "Error saving form:" (:body response))
            (log-error! (str "Failed to save form: " (get-in response [:body :error])) "save-form" {:response (:body response)})))))))

;; Load tables from database API
(defn load-tables!
  "Load tables from PostgreSQL via backend API"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/tables")
                                 {:headers (db-headers)}))]
      (if (:success response)
        (let [tables (get-in response [:body :tables])
              ;; Add an id to each table for UI compatibility
              tables-with-ids (map-indexed
                               (fn [idx table]
                                 {:id (inc idx)
                                  :name (:name table)
                                  :fields (mapv (fn [field]
                                                  {:name (:name field)
                                                   :type (:type field)
                                                   :pk (:isPrimaryKey field)
                                                   :fk (when (:isForeignKey field)
                                                         (:foreignTable field))
                                                   :nullable (:nullable field)})
                                                (:fields table))})
                               tables)]
          (swap! app-state assoc-in [:objects :tables] (vec tables-with-ids))
          (println "Loaded" (count tables-with-ids) "tables from database")
          (object-load-complete!))
        (do
          (println "Error loading tables:" (:body response))
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
          (println "Loaded" (count queries-with-ids) "queries from database")
          (object-load-complete!))
        (do
          (println "Error loading queries:" (:body response))
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
          (println "Loaded" (count functions-with-ids) "functions from database")
          (object-load-complete!))
        (do
          (println "Error loading functions:" (:body response))
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
          (swap! app-state assoc-in [:objects :access_databases] databases)
          (println "Found" (count databases) "Access databases"))
        (do
          (println "Error scanning for Access databases:" (:body response))
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

(defn navigate-to-record-by-id!
  "Navigate to a record by its primary key ID"
  [record-id]
  (let [records (get-in @app-state [:form-editor :records] [])
        record-source (get-in @app-state [:form-editor :current :record-source])
        fields (get-record-source-fields record-source)
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
      (navigate-to-record! pos))))

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
    (reset! pending-ui-state nil)
    (println "UI state restored")))

;; Initialize - load objects from files and database
(defn init! []
  (go
    ;; First, load saved UI state
    (let [saved-ui-state (<! (load-ui-state!))]
      (when saved-ui-state
        (println "Found saved UI state:" saved-ui-state)
        ;; Store for later restoration
        (reset! pending-ui-state saved-ui-state)
        ;; Restore app mode (import/run)
        (when-let [saved-mode (:app_mode saved-ui-state)]
          (swap! app-state assoc :app-mode (keyword saved-mode)))
        ;; If saved state has a database, switch to it
        (when-let [saved-db-id (:database_id saved-ui-state)]
          ;; We'll handle this after loading databases
          (swap! app-state assoc :saved-database-id saved-db-id))))

    ;; Load available databases (sets current database, then loads objects)
    (load-databases!)

    ;; Load app configuration
    (load-config!)

    ;; Load forms from database
    (load-forms!)

    (println "Application state initialized - loading from database")))
