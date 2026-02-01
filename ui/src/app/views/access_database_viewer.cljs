(ns app.views.access-database-viewer
  "Viewer for Access database files - shows forms/reports available for import"
  (:require [reagent.core :as r]
            [app.state :as state]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

(def api-base "http://localhost:3001")

;; Local state for the viewer
(defonce viewer-state
  (r/atom {:loading? false
           :error nil
           :loaded-path nil    ;; Track which db path is currently loaded
           :object-type :tables ;; :tables, :queries, :forms, :reports, :modules
           :forms []
           :reports []
           :tables []
           :queries []
           :modules []
           :selected #{}        ;; Set of selected item names for import
           :import-log []       ;; Recent import history
           :importing? false})) ;; True while import is in progress

(defn load-import-history!
  "Load import history for the current Access database"
  [db-path]
  (go
    (let [response (<! (http/get (str api-base "/api/access-import/history")
                                 {:query-params {:source_path db-path :limit 50}}))]
      (when (:success response)
        (swap! viewer-state assoc :import-log (get-in response [:body :history] []))))))

(defn load-access-database-contents!
  "Load forms, reports, tables, queries, and modules from the selected Access database"
  [db-path]
  (swap! viewer-state assoc :loading? true :error nil :loaded-path db-path)
  ;; Load history in parallel
  (load-import-history! db-path)
  (go
    (let [response (<! (http/get (str api-base "/api/access-import/database")
                                 {:query-params {:path db-path}}))]
      (if (:success response)
        (let [body (:body response)]
          (swap! viewer-state assoc
                 :loading? false
                 :forms (or (:forms body) [])
                 :reports (or (:reports body) [])
                 :tables (or (:tables body) [])
                 :queries (or (:queries body) [])
                 :modules (or (:modules body) [])
                 :selected #{}))
        (swap! viewer-state assoc
               :loading? false
               :error (or (get-in response [:body :error]) "Failed to load database"))))))

(defn toggle-selection! [item-name]
  (swap! viewer-state update :selected
         (fn [sel]
           (if (contains? sel item-name)
             (disj sel item-name)
             (conj sel item-name)))))

(defn select-all! []
  (let [obj-type (:object-type @viewer-state)
        items (get @viewer-state obj-type [])
        item-names (map get-item-name items)]
    (swap! viewer-state assoc :selected (set item-names))))

(defn select-none! []
  (swap! viewer-state assoc :selected #{}))

(defn import-selected!
  "Import selected forms/reports to the current PolyAccess database"
  [access-db-path target-database-id]
  (let [obj-type (:object-type @viewer-state)
        selected (:selected @viewer-state)
        endpoint (if (= obj-type :forms)
                   "/api/access-import/export-form"
                   "/api/access-import/export-report")]
    (swap! viewer-state assoc :importing? true)
    (go
      (doseq [item-name selected]
        (let [params (if (= obj-type :forms)
                       {:databasePath access-db-path
                        :formName item-name
                        :targetDatabaseId target-database-id}
                       {:databasePath access-db-path
                        :reportName item-name
                        :targetDatabaseId target-database-id})
              response (<! (http/post (str api-base endpoint)
                                      {:json-params params}))]
          ;; Refresh history after each import to show progress
          (<! (load-import-history! access-db-path))
          (if (:success response)
            (println "Imported:" item-name)
            (println "Failed to import:" item-name (get-in response [:body :error])))))
      (swap! viewer-state assoc :importing? false :selected #{})
      ;; Refresh the forms/reports list in the target database
      (state/load-forms!))))

(defn object-type-dropdown []
  (let [obj-type (:object-type @viewer-state)]
    [:div.access-object-type-selector
     [:select
      {:value (name obj-type)
       :on-change #(do
                     (swap! viewer-state assoc
                            :object-type (keyword (.. % -target -value))
                            :selected #{}))}
      [:option {:value "tables"} "Tables"]
      [:option {:value "queries"} "Queries"]
      [:option {:value "forms"} "Forms"]
      [:option {:value "reports"} "Reports"]
      [:option {:value "modules"} "Modules"]]]))

(defn get-item-name
  "Extract name from item - handles both string items and object items"
  [item]
  (if (string? item)
    item
    (or (:name item) (str item))))

(defn get-item-detail
  "Get additional detail to show for an item based on type"
  [object-type item]
  (when-not (string? item)
    (case object-type
      :tables (str (:fieldCount item) " fields, " (:rowCount item) " rows")
      :queries (:type item)
      :modules (str (:lineCount item) " lines")
      nil)))

(defn object-list []
  (let [{:keys [object-type forms reports tables queries modules selected loading?]} @viewer-state
        items (case object-type
                :forms forms
                :reports reports
                :tables tables
                :queries queries
                :modules modules
                [])]
    [:div.access-object-list
     (if loading?
       [:div.loading "Loading..."]
       (if (empty? items)
         [:div.empty-list (str "No " (name object-type) " found")]
         [:ul.import-list
          (for [item items]
            (let [item-name (get-item-name item)
                  item-detail (get-item-detail object-type item)]
              ^{:key item-name}
              [:li.import-item
               {:class (when (contains? selected item-name) "selected")
                :on-click #(toggle-selection! item-name)}
               [:input {:type "checkbox"
                        :checked (contains? selected item-name)
                        :on-change #(toggle-selection! item-name)}]
               [:span.item-name item-name]
               (when item-detail
                 [:span.item-detail item-detail])]))]))]))

(defn format-timestamp [ts]
  (when ts
    (let [d (js/Date. ts)]
      (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))))

(defn import-log-panel []
  (let [{:keys [import-log importing?]} @viewer-state]
    [:div.import-log-panel
     [:div.log-header
      [:h4 "Import Log"]
      (when importing?
        [:span.importing-indicator "Importing..."])]
     [:div.log-entries
      (if (empty? import-log)
        [:div.log-empty "No imports yet"]
        (for [entry import-log]
          ^{:key (:id entry)}
          [:div.log-entry {:class (:status entry)}
           [:div.log-entry-header
            [:span.log-object-type (:source_object_type entry)]
            [:span.log-object-name (:source_object_name entry)]
            [:span.log-status {:class (:status entry)} (:status entry)]]
           [:div.log-entry-details
            [:span.log-target (str "→ " (:target_database_id entry))]
            [:span.log-time (format-timestamp (:created_at entry))]]
           (when (:error_message entry)
             [:div.log-error (:error_message entry)])]))]]))

(defn toolbar [access-db-path]
  (let [{:keys [selected object-type]} @viewer-state
        ;; Get available databases to import into (excluding _access_import)
        available-dbs (filter #(not= (:database_id %) "_access_import")
                              (:available-databases @state/app-state))]
    [:div.access-toolbar
     [:div.selection-actions
      [:button.btn-link {:on-click select-all!} "Select All"]
      [:button.btn-link {:on-click select-none!} "Select None"]
      [:span.selection-count (str (count selected) " selected")]]
     [:div.import-actions
      (when (seq selected)
        [:div.import-to
         [:span "Import to: "]
         [:select#import-target
          (for [db available-dbs]
            ^{:key (:database_id db)}
            [:option {:value (:database_id db)} (:name db)])]
         [:button.btn-primary
          {:on-click #(let [target (.-value (.getElementById js/document "import-target"))]
                        (import-selected! access-db-path target))}
          (str "Import " (count selected) " " (name object-type))]])]]))

(defn access-database-viewer
  "Main viewer component for an Access database"
  []
  (let [active-tab (:active-tab @state/app-state)
        access-db (when (= (:type active-tab) :access_databases)
                    (first (filter #(= (:id %) (:id active-tab))
                                   (get-in @state/app-state [:objects :access_databases]))))
        db-path (:path access-db)
        {:keys [loading? error loaded-path]} @viewer-state]

    ;; Load if path changed or never loaded
    (when (and db-path (not= db-path loaded-path) (not loading?))
      (load-access-database-contents! db-path))

    [:div.access-database-viewer
     [:div.viewer-header
      [:h2 (:name access-db)]
      [:div.db-path db-path]]

     [:div.viewer-body
      [:div.viewer-main
       (cond
         error
         [:div.error-message error]

         loading?
         [:div.loading-spinner "Loading..."]

         :else
         [:<>
          [object-type-dropdown]
          [toolbar db-path]
          [object-list]])]

      [:div.viewer-sidebar
       [import-log-panel]]]]))
