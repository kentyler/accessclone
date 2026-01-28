(ns app.state
  "Application state management"
  (:require [reagent.core :as r]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [cljs.reader :as reader]
            [clojure.string :as str]))

(def api-base "http://localhost:3001")

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

           ;; Form runtime state (when viewing a form)
           :form-data {}
           :form-session nil}))

;; Loading/Error
(defn set-loading! [loading?]
  (swap! app-state assoc :loading? loading?))

(defn set-error! [error]
  (swap! app-state assoc :error error))

(defn clear-error! []
  (swap! app-state assoc :error nil))

;; Database selection
(defn set-available-databases! [databases]
  (swap! app-state assoc :available-databases databases))

(defn set-current-database! [db]
  (swap! app-state assoc :current-database db))

(defn set-loading-objects! [loading?]
  (swap! app-state assoc :loading-objects? loading?))

;; Track pending object loads (tables, queries, functions)
(defonce pending-loads (atom 0))

(defn start-loading-objects! []
  (reset! pending-loads 3)  ; 3 types: tables, queries, functions
  (set-loading-objects! true))

(defn object-load-complete! []
  (swap! pending-loads dec)
  (when (<= @pending-loads 0)
    (set-loading-objects! false)))

(defn load-databases!
  "Load available databases from API and set current, then load objects"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/databases")))]
      (if (:success response)
        (let [databases (get-in response [:body :databases])
              current-id (get-in response [:body :current])
              current-db (first (filter #(= (:database_id %) current-id) databases))]
          (set-available-databases! databases)
          (set-current-database! current-db)
          (println "Loaded" (count databases) "databases, current:" (:name current-db))
          ;; Now load objects for the current database
          (start-loading-objects!)
          (load-tables!)
          (load-queries!)
          (load-functions!))
        (do
          (println "Error loading databases:" (:body response))
          (set-error! "Failed to load databases"))))))

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
          ;; Reload objects for new database
          (start-loading-objects!)
          (load-tables!)
          (load-queries!)
          (load-functions!)
          (println "Switched to database:" (:name new-db)))
        (do
          (println "Error switching database:" (:body response))
          (set-error! "Failed to switch database"))))))

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
    (swap! app-state assoc :active-tab tab)))

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
                :id (:id (last new-open))})))))

(defn set-active-tab! [object-type object-id]
  (swap! app-state assoc :active-tab {:type object-type :id object-id}))

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

(defn save-form! []
  (let [current (get-in @app-state [:form-editor :current])
        active (:active-tab @app-state)]
    (when (and active (= (:type active) :forms))
      ;; Update the form in objects list
      (update-object! :forms (:id active) {:definition current})
      ;; Update the tab name if form name changed
      (swap! app-state update :open-objects
             (fn [tabs]
               (mapv (fn [tab]
                       (if (and (= (:type tab) :forms)
                                (= (:id tab) (:id active)))
                         (assoc tab :name (:name current))
                         tab))
                     tabs)))
      ;; Mark as clean
      (swap! app-state assoc-in [:form-editor :dirty?] false)
      (swap! app-state assoc-in [:form-editor :original] current)
      ;; Save to EDN file (logs for now - needs backend)
      (let [form (first (filter #(= (:id %) (:id active))
                                (get-in @app-state [:objects :forms])))]
        (save-form-to-file! form)))))

(defn load-form-for-editing! [form]
  ;; Auto-save current form if dirty before loading new one
  (when (get-in @app-state [:form-editor :dirty?])
    (save-form!))
  (swap! app-state assoc :form-editor
         {:dirty? false
          :original (:definition form)
          :current (:definition form)
          :selected-control nil}))

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

(defn delete-control! [idx]
  (let [form-editor (:form-editor @app-state)
        current (:current form-editor)
        controls (or (:controls current) [])]
    (when (< idx (count controls))
      (let [new-controls (vec (concat (subvec controls 0 idx)
                                      (subvec controls (inc idx))))]
        (swap! app-state assoc-in [:form-editor :selected-control] nil)
        (set-form-definition! (assoc current :controls new-controls))))))

;; Config file operations
(defn load-config!
  "Load app configuration from settings/config.edn"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/config")))]
      (if (:success response)
        (try
          (let [config (reader/read-string (:body response))]
            (swap! app-state assoc :config config)
            (println "Config loaded:" config))
          (catch :default e
            (println "Error parsing config:" e)))
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
          (set-error! "Failed to save configuration"))))))

;; Form file operations
(defn load-form-file!
  "Load a single form from an EDN file"
  [filename]
  (go
    (let [response (<! (http/get (str "/forms/" filename ".edn")))]
      (when (:success response)
        (try
          (let [form-data (reader/read-string (:body response))]
            ;; Add to forms list, using filename as fallback for missing fields
            (swap! app-state update-in [:objects :forms] conj
                   {:id (:id form-data)
                    :name (:name form-data)
                    :filename filename
                    :definition (dissoc form-data :id :name)}))
          (catch :default e
            (println "Error parsing form" filename ":" e)))))))

(defn load-forms-from-index!
  "Load all forms listed in _index.edn"
  []
  (go
    (let [response (<! (http/get "/forms/_index.edn"))]
      (if (:success response)
        (try
          (let [form-names (reader/read-string (:body response))]
            (println "Loading forms:" form-names)
            (doseq [form-name form-names]
              (load-form-file! form-name)))
          (catch :default e
            (println "Error parsing form index:" e)))
        (println "Could not load form index - using empty forms list")))))

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
            (set-error! (str "Failed to save form: " (get-in response [:body :error])))))))))

;; Helper to get current database headers
(defn- db-headers []
  (when-let [db-id (:database_id (:current-database @app-state))]
    {"X-Database-ID" db-id}))

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
          (set-error! "Failed to load tables from database")
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
          (set-error! "Failed to load queries from database")
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
              ;; Add an id and filter to show only vba_ prefixed functions
              functions-with-ids (map-indexed
                                  (fn [idx func]
                                    {:id (inc idx)
                                     :name (:name func)
                                     :arguments (:arguments func)
                                     :return-type (:returnType func)})
                                  functions)]
          (swap! app-state assoc-in [:objects :modules] (vec functions-with-ids))
          (println "Loaded" (count functions-with-ids) "functions from database")
          (object-load-complete!))
        (do
          (println "Error loading functions:" (:body response))
          (set-error! "Failed to load functions from database")
          (object-load-complete!))))))

;; Initialize - load objects from files and database
(defn init! []
  ;; Load available databases first (sets current database, then loads objects)
  (load-databases!)

  ;; Load app configuration
  (load-config!)

  ;; Load forms from EDN files
  (load-forms-from-index!)

  (println "Application state initialized - loading from database and EDN files"))
