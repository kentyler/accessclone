(ns app.state
  "Application state management"
  (:require [reagent.core :as r]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [cljs.reader :as reader]
            [clojure.string :as str]))

(def api-base "http://localhost:3001")

;; Forward declarations for functions used before definition
(declare load-tables! load-queries! load-functions! save-ui-state!
         save-current-record! save-form! save-form-to-file!
         get-record-source-fields run-query!)

;; Application state atom
(defonce app-state
  (r/atom {;; Database selection
           :available-databases []
           :current-database nil  ; {:database_id "calculator" :name "Recipe Calculator" ...}
           :loading-objects? false  ; true while loading tables/queries/functions

           ;; App configuration (loaded from settings/config.edn)
           :config {:form-designer {:grid-size 8}}

           ;; UI state
           :loading? false
           :error nil
           :options-dialog-open? false

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
(defn- db-headers []
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
      ;; Save to EDN file
      (let [form (first (filter #(= (:id %) form-id)
                                (get-in @app-state [:objects :forms])))]
        (save-form-to-file! form)))))

(defn save-form!
  "Lint the form and save if valid"
  []
  (let [current (get-in @app-state [:form-editor :current])
        form-id (get-in @app-state [:form-editor :form-id])]
    (when (and form-id current)
      (clear-lint-errors!)
      (go
        (let [response (<! (http/post (str api-base "/api/lint/form")
                                      {:json-params {:form current}}))]
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
      (let [record-source (get-in @app-state [:form-editor :current :record-source])]
        (when record-source
          ;; Trigger data load
          (go
            (let [response (<! (http/get (str api-base "/api/data/" record-source)
                                         {:query-params {:limit 1000}
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
                    (swap! app-state assoc-in [:form-editor :current-record] (first data))))
                (println "Error loading data:" (:body response))))))))))

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
      (swap! app-state assoc-in [:form-editor :record-dirty?] false))))

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
        ;; Find primary key - check for pk flag or common names
        (let [fields (get-record-source-fields record-source)
              pk-field-name (or (some #(when (:pk %) (:name %)) fields)
                                "id")
              ;; Check both string and keyword versions of pk
              pk-value (or (get current-record (keyword pk-field-name))
                           (get current-record pk-field-name))
              ;; Check for __new__ marker (set by new-record!) or missing pk
              is-new? (or (:__new__ current-record)
                          (nil? pk-value)
                          (= pk-value ""))
              ;; Convert record to string keys for API, removing internal markers
              record-for-api (reduce-kv
                              (fn [m k v]
                                (if (= k :__new__)
                                  m  ; skip internal marker
                                  (assoc m (if (keyword? k) (name k) k) v)))
                              {}
                              current-record)]
          (println "Saving record:" {:pk pk-field-name :pk-value pk-value :is-new? is-new? :data record-for-api})
          (if is-new?
            ;; Insert new record - only remove pk if it's auto-increment "id"
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
                    ;; Update the record at current position (already added by new-record!)
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
                (println "Error updating record:" (:body response))))))
      (println "Save skipped - conditions not met")))))

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
    (do
      (swap! app-state assoc :form-editor
             {:form-id (:id form)
              :dirty? false
              :original (:definition form)
              :current (:definition form)
              :selected-control nil})
      (set-view-mode! :view))
    ;; Need to fetch definition from API
    (go
      (let [response (<! (http/get (str api-base "/api/forms/" (:filename form))
                                    {:headers (db-headers)}))]
        (if (:success response)
          (let [body (:body response)
                ;; Parse EDN if string, otherwise use as-is (cljs-http may have parsed it)
                form-data (if (string? body)
                            (reader/read-string body)
                            body)
                definition (dissoc form-data :id :name)]
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
;; TABLE VIEWER
;; ============================================================

(declare refresh-table-data!)

;; Clipboard for cut/copy/paste
(defonce table-clipboard (atom nil))

(defn set-table-view-mode!
  "Set table view mode - :datasheet or :design"
  [mode]
  (swap! app-state assoc-in [:table-viewer :view-mode] mode)
  ;; Load data when switching to datasheet view
  (when (= mode :datasheet)
    (refresh-table-data!)))

(defn load-table-for-viewing!
  "Load a table for viewing"
  [table]
  (swap! app-state assoc :table-viewer
         {:table-id (:id table)
          :table-info table
          :records []
          :view-mode :datasheet
          :loading? true})
  ;; Load the data
  (go
    (let [response (<! (http/get (str api-base "/api/data/" (:name table))
                                 {:query-params {:limit 1000}
                                  :headers (db-headers)}))]
      (swap! app-state assoc-in [:table-viewer :loading?] false)
      (if (:success response)
        (let [data (get-in response [:body :data] [])]
          (swap! app-state assoc-in [:table-viewer :records] (vec data)))
        (println "Error loading table data:" (:body response))))))

(defn refresh-table-data!
  "Refresh the current table's data"
  []
  (let [table-info (get-in @app-state [:table-viewer :table-info])]
    (when table-info
      (swap! app-state assoc-in [:table-viewer :loading?] true)
      (go
        (let [response (<! (http/get (str api-base "/api/data/" (:name table-info))
                                     {:query-params {:limit 1000}
                                      :headers (db-headers)}))]
          (swap! app-state assoc-in [:table-viewer :loading?] false)
          (if (:success response)
            (let [data (get-in response [:body :data] [])]
              (swap! app-state assoc-in [:table-viewer :records] (vec data)))
            (println "Error refreshing table data:" (:body response))))))))

;; Cell selection and editing
(defn select-table-cell!
  "Select a cell in the datasheet"
  [row-idx col-name]
  (swap! app-state assoc-in [:table-viewer :selected] {:row row-idx :col col-name})
  (swap! app-state assoc-in [:table-viewer :context-menu :visible] false))

(defn select-table-row!
  "Select an entire row"
  [row-idx]
  (swap! app-state assoc-in [:table-viewer :selected] {:row row-idx :col nil}))

(defn start-editing-cell!
  "Start editing a cell"
  [row-idx col-name]
  (swap! app-state assoc-in [:table-viewer :selected] {:row row-idx :col col-name})
  (swap! app-state assoc-in [:table-viewer :editing] {:row row-idx :col col-name}))

(defn stop-editing-cell!
  "Stop editing the current cell"
  []
  (swap! app-state assoc-in [:table-viewer :editing] nil))

(defn get-pk-field
  "Get the primary key field name for the current table"
  []
  (let [fields (get-in @app-state [:table-viewer :table-info :fields])]
    (or (:name (first (filter :pk fields))) "id")))

(defn save-table-cell!
  "Save the edited cell value"
  [new-value]
  (let [selected (get-in @app-state [:table-viewer :selected])
        row-idx (:row selected)
        col-name (:col selected)
        records (get-in @app-state [:table-viewer :records])
        record (nth records row-idx)
        pk-field (get-pk-field)
        pk-value (get record (keyword pk-field))
        table-name (get-in @app-state [:table-viewer :table-info :name])]
    (when (and row-idx col-name pk-value)
      ;; Update local state immediately
      (swap! app-state assoc-in [:table-viewer :records row-idx (keyword col-name)] new-value)
      ;; Save to server
      (go
        (let [response (<! (http/put (str api-base "/api/data/" table-name "/" pk-value)
                                     {:json-params {col-name new-value}
                                      :headers (db-headers)}))]
          (if (:success response)
            (println "Cell saved:" col-name "=" new-value)
            (do
              (println "Error saving cell:" (:body response))
              ;; Revert on error
              (refresh-table-data!))))))))

(defn move-to-next-cell!
  "Move to the next cell (Tab) or previous cell (Shift+Tab)"
  [shift?]
  (let [selected (get-in @app-state [:table-viewer :selected])
        fields (get-in @app-state [:table-viewer :table-info :fields])
        records (get-in @app-state [:table-viewer :records])
        col-names (mapv :name fields)
        row-idx (:row selected)
        col-name (:col selected)
        col-idx (.indexOf col-names col-name)]
    (if shift?
      ;; Move backwards
      (if (> col-idx 0)
        (start-editing-cell! row-idx (nth col-names (dec col-idx)))
        (when (> row-idx 0)
          (start-editing-cell! (dec row-idx) (last col-names))))
      ;; Move forwards
      (if (< col-idx (dec (count col-names)))
        (start-editing-cell! row-idx (nth col-names (inc col-idx)))
        (when (< row-idx (dec (count records)))
          (start-editing-cell! (inc row-idx) (first col-names)))))))

;; Context menu
(defn show-table-context-menu!
  "Show context menu at position"
  [x y]
  (swap! app-state assoc-in [:table-viewer :context-menu]
         {:visible true :x x :y y}))

(defn hide-table-context-menu!
  "Hide context menu"
  []
  (swap! app-state assoc-in [:table-viewer :context-menu :visible] false))

;; Cut/Copy/Paste
(defn copy-table-cell!
  "Copy selected cell value to clipboard"
  []
  (let [selected (get-in @app-state [:table-viewer :selected])
        row-idx (:row selected)
        col-name (:col selected)
        records (get-in @app-state [:table-viewer :records])
        value (when (and row-idx col-name)
                (get (nth records row-idx) (keyword col-name)))]
    (reset! table-clipboard {:value value :cut? false})
    (println "Copied:" value)))

(defn cut-table-cell!
  "Cut selected cell value"
  []
  (let [selected (get-in @app-state [:table-viewer :selected])
        row-idx (:row selected)
        col-name (:col selected)
        records (get-in @app-state [:table-viewer :records])
        value (when (and row-idx col-name)
                (get (nth records row-idx) (keyword col-name)))]
    (reset! table-clipboard {:value value :cut? true :row row-idx :col col-name})
    (println "Cut:" value)))

(defn paste-table-cell!
  "Paste clipboard value to selected cell"
  []
  (when-let [clipboard @table-clipboard]
    (let [value (:value clipboard)]
      (save-table-cell! value)
      ;; If it was a cut, clear the original cell
      (when (:cut? clipboard)
        (let [orig-row (:row clipboard)
              orig-col (:col clipboard)]
          (swap! app-state assoc-in [:table-viewer :selected] {:row orig-row :col orig-col})
          (save-table-cell! nil)
          (reset! table-clipboard nil))))))

;; New record
(defn new-table-record!
  "Add a new empty record to the table"
  []
  (let [table-name (get-in @app-state [:table-viewer :table-info :name])
        fields (get-in @app-state [:table-viewer :table-info :fields])
        ;; Create empty record with just non-pk fields
        empty-record (reduce (fn [m field]
                               (if (:pk field)
                                 m
                                 (assoc m (:name field) nil)))
                             {}
                             fields)]
    (go
      (let [response (<! (http/post (str api-base "/api/data/" table-name)
                                    {:json-params empty-record
                                     :headers (db-headers)}))]
        (if (:success response)
          (do
            (println "New record created")
            (refresh-table-data!))
          (println "Error creating record:" (:body response)))))))

;; Delete record
(defn delete-table-record!
  "Delete the selected record"
  []
  (let [selected (get-in @app-state [:table-viewer :selected])
        row-idx (:row selected)
        records (get-in @app-state [:table-viewer :records])
        record (when row-idx (nth records row-idx nil))
        pk-field (get-pk-field)
        pk-value (when record (get record (keyword pk-field)))
        table-name (get-in @app-state [:table-viewer :table-info :name])]
    (when pk-value
      (go
        (let [response (<! (http/delete (str api-base "/api/data/" table-name "/" pk-value)
                                        {:headers (db-headers)}))]
          (if (:success response)
            (do
              (println "Record deleted")
              (swap! app-state assoc-in [:table-viewer :selected] nil)
              (refresh-table-data!))
            (println "Error deleting record:" (:body response))))))))

;; ============================================================
;; QUERY VIEWER
;; ============================================================

(defn set-query-view-mode!
  "Set query view mode - :results or :sql"
  [mode]
  (swap! app-state assoc-in [:query-viewer :view-mode] mode))

(defn load-query-for-viewing!
  "Load a query for viewing"
  [query]
  (swap! app-state assoc :query-viewer
         {:query-id (:id query)
          :query-info query
          :sql (or (:sql query) "")
          :results []
          :result-fields []
          :view-mode :results
          :loading? true
          :error nil})
  ;; Run the query to get results
  (run-query!))

(defn update-query-sql!
  "Update the SQL in the editor"
  [sql]
  (swap! app-state assoc-in [:query-viewer :sql] sql))

(defn run-query!
  "Execute the current SQL and fetch results"
  []
  (let [query-info (get-in @app-state [:query-viewer :query-info])
        sql (get-in @app-state [:query-viewer :sql])
        ;; If no custom SQL, select from the view
        effective-sql (if (str/blank? sql)
                        (str "SELECT * FROM " (:name query-info) " LIMIT 1000")
                        sql)]
    (swap! app-state assoc-in [:query-viewer :loading?] true)
    (swap! app-state assoc-in [:query-viewer :error] nil)
    (go
      (let [response (<! (http/post (str api-base "/api/queries/run")
                                    {:json-params {:sql effective-sql}
                                     :headers (db-headers)}))]
        (swap! app-state assoc-in [:query-viewer :loading?] false)
        (if (:success response)
          (let [data (get-in response [:body :data] [])
                fields (get-in response [:body :fields] [])]
            (swap! app-state assoc-in [:query-viewer :results] (vec data))
            (swap! app-state assoc-in [:query-viewer :result-fields] (vec fields)))
          (do
            (println "Error running query:" (:body response))
            (swap! app-state assoc-in [:query-viewer :error]
                   (get-in response [:body :error] "Query failed"))))))))

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
  "Save current UI state (open tabs, active tab, database) to server"
  []
  (let [current-db (:current-database @app-state)
        open-objects (:open-objects @app-state)
        active-tab (:active-tab @app-state)
        ui-state {:database_id (:database_id current-db)
                  :open_objects (vec (map #(select-keys % [:type :id :name]) open-objects))
                  :active_tab (when active-tab
                                (select-keys active-tab [:type :id]))}]
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
  "Load app configuration from settings/config.edn"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/config")))]
      (if (:success response)
        (let [config (:body response)]  ;; Already parsed by cljs-http
          (swap! app-state assoc :config config)
          (println "Config loaded:" config))
        (println "Could not load config - using defaults")))))

(defn save-config!
  "Save app configuration to settings/config.edn"
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
  "Save a form to its EDN file via backend API"
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
        ;; If saved state has a database, switch to it
        (when-let [saved-db-id (:database_id saved-ui-state)]
          ;; We'll handle this after loading databases
          (swap! app-state assoc :saved-database-id saved-db-id))))

    ;; Load available databases (sets current database, then loads objects)
    (load-databases!)

    ;; Load app configuration
    (load-config!)

    ;; Load forms from EDN files
    (load-forms!)

    (println "Application state initialized - loading from database and EDN files")))
