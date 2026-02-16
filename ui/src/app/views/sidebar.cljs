(ns app.views.sidebar
  "Access-style collapsible sidebar with object navigation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.state-form :as state-form]
            [app.state-table :as state-table]
            [app.state-report :as state-report]
            [app.state-query :as state-query]
            [app.flows.core :as f]
            [app.flows.navigation :as nav]
            [app.flows.ui :as ui-flow]
            [app.views.access-database-viewer :as access-db-viewer]))

;; Object types available in the dropdown (like Access navigation pane)
(def object-types
  [{:id :tables         :label "Tables"}
   {:id :queries        :label "Queries"}
   {:id :sql-functions  :label "SQL Functions"}
   {:id :forms          :label "Forms"}
   {:id :reports        :label "Reports"}
   {:id :modules        :label "Modules"}
   {:id :macros         :label "Macros"}])

(defn object-type-selector
  "Dropdown to select which type of objects to display"
  []
  (let [selected (:sidebar-object-type @state/app-state)]
    [:div.object-type-selector
     [:select
      {:value (name (or selected :forms))
       :on-change #(t/dispatch! :set-sidebar-object-type
                    (keyword (.. % -target -value)))}
      (for [{:keys [id label]} object-types]
        ^{:key id}
        [:option {:value (name id)} label])]]))

(defn new-object-button
  "Button to create a new object of the selected type"
  []
  (let [object-type (:sidebar-object-type @state/app-state)]
    (case object-type
      :forms
      [:button.new-object-btn
       {:on-click #(f/run-fire-and-forget! nav/create-new-form-flow)}
       [:span.icon "+"]
       [:span "New Form"]]

      :tables
      [:button.new-object-btn
       {:on-click #(f/run-fire-and-forget! nav/start-new-table-flow)}
       [:span.icon "+"]
       [:span "New Table"]]

      :reports
      [:button.new-object-btn
       {:on-click #(f/run-fire-and-forget! nav/create-new-report-flow)}
       [:span.icon "+"]
       [:span "New Report"]]

      :modules
      [:button.new-object-btn
       {:on-click #(f/run-fire-and-forget! nav/create-new-module-flow)}
       [:span.icon "+"]
       [:span "New Module"]]

      :queries
      [:button.new-object-btn
       {:on-click #(f/run-fire-and-forget! nav/create-new-query-flow)}
       [:span.icon "+"]
       [:span "New Query"]]

      :sql-functions
      [:button.new-object-btn
       {:on-click #(f/run-fire-and-forget! nav/create-new-function-flow)}
       [:span.icon "+"]
       [:span "New Function"]]

      nil)))

(defn object-list-item
  "Single item in the object list"
  [{:keys [id name type]} active?]
  [:li.object-item
   {:class (when active? "active")
    :on-click #(f/run-fire-and-forget! (nav/open-object-flow) {:type type :id id})}
   [:span.object-name name]])

(defn object-list
  "List of objects of the selected type"
  []
  (let [object-type (or (:sidebar-object-type @state/app-state) :forms)
        objects (get-in @state/app-state [:objects object-type] [])
        active-tab (:active-tab @state/app-state)]
    [:ul.object-list
     (if (empty? objects)
       [:li.empty-list "No " (name object-type) " yet"]
       (for [{:keys [id name] :as obj} objects]
         ^{:key id}
         [object-list-item
          (assoc obj :type object-type)
          (and (= (:type active-tab) object-type)
               (= (:id active-tab) id))]))]))

(defn format-file-size [bytes]
  (cond
    (nil? bytes) ""
    (< bytes 1024) (str bytes " B")
    (< bytes (* 1024 1024)) (str (.toFixed (/ bytes 1024) 1) " KB")
    :else (str (.toFixed (/ bytes (* 1024 1024)) 1) " MB")))

(defn access-database-list
  "Browse input + list of Access database files found by scanning.
   Multi-select: clicking toggles a database in/out of selected-paths."
  []
  (let [browse-path (r/atom "")
        submit-browse! (fn []
                         (let [path (clojure.string/trim @browse-path)]
                           (when (seq path)
                             (f/run-fire-and-forget! (ui-flow/load-access-databases-flow) {:locations path}))))]
    (fn []
      (let [databases (sort-by #(clojure.string/lower-case (or (:name %) ""))
                               (get-in @state/app-state [:objects :access_databases] []))
            {:keys [selected-paths active-path]} @access-db-viewer/viewer-state
            selected-set (set selected-paths)]
        [:div
         [:div.browse-row
          [:input.browse-input
           {:type "text"
            :placeholder "Paste folder or file path"
            :value @browse-path
            :on-change #(reset! browse-path (.. % -target -value))
            :on-key-down #(when (= (.-key %) "Enter") (submit-browse!))}]
          [:button.scan-btn
           {:on-click submit-browse!}
           "Browse"]]
         [:div.scan-all-link
          [:a {:href "#"
               :on-click (fn [e]
                           (.preventDefault e)
                           (f/run-fire-and-forget! (ui-flow/load-access-databases-flow) {}))}
           "Or scan all locations"]]
         [:ul.object-list
          (if (empty? databases)
            [:li.empty-list "Paste a path above to find databases."]
            (for [db databases]
              (let [path (:path db)
                    selected? (contains? selected-set path)
                    active? (= path active-path)]
                ^{:key path}
                [:li.object-item
                 {:class (str (when selected? "selected ")
                              (when active? "active"))
                  :on-click #(access-db-viewer/toggle-database-selection! path)}
                 [:span.sidebar-checkbox {:class (when selected? "checked")}
                  (when selected? "\u2713")]
                 [:span.object-name (:name db)]
                 [:span.access-db-detail (format-file-size (:size db))]])))]]))))

(defn collapse-toggle
  "Button to collapse/expand the sidebar"
  []
  (let [collapsed? (:sidebar-collapsed? @state/app-state)]
    [:button.collapse-toggle
     {:on-click #(t/dispatch! :toggle-sidebar)
      :title (if collapsed? "Expand sidebar" "Collapse sidebar")}
     (if collapsed? "\u25B6" "\u25C0")]))

(defn- type-icon [object-type]
  (case object-type
    "table" "\uD83D\uDDD2"
    "query" "\uD83D\uDD0D"
    "form"  "\uD83D\uDCCB"
    "report" "\uD83D\uDCC4"
    "module" "\uD83D\uDCDD"
    "macro" "\u26A1"
    "\uD83D\uDCC1"))

(defn- format-timestamp [ts]
  (when ts
    (let [d (js/Date. ts)]
      (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))))

(defn logs-entry-list
  "Sidebar list of import log entries for Logs mode"
  []
  (let [entries (:logs-entries @state/app-state)
        selected (:logs-selected-entry @state/app-state)
        loading? (:logs-loading? @state/app-state)
        logs-filter (:logs-filter @state/app-state)
        ;; Apply filters
        filtered (cond->> entries
                   (:object-type logs-filter)
                   (filter #(= (:source_object_type %) (:object-type logs-filter)))
                   (= (:status logs-filter) "issues-only")
                   (filter #(pos? (or (:open_issue_count %) 0))))]
    [:div
     ;; Filter bar
     [:div.logs-filter-bar
      [:select
       {:value (or (:object-type logs-filter) "")
        :on-change #(t/dispatch! :set-logs-filter :object-type
                      (let [v (.. % -target -value)]
                        (when (seq v) v)))}
       [:option {:value ""} "All types"]
       [:option {:value "table"} "Tables"]
       [:option {:value "query"} "Queries"]
       [:option {:value "form"} "Forms"]
       [:option {:value "report"} "Reports"]
       [:option {:value "module"} "Modules"]
       [:option {:value "macro"} "Macros"]]
      [:label.logs-issues-toggle
       [:input {:type "checkbox"
                :checked (= (:status logs-filter) "issues-only")
                :on-change #(t/dispatch! :set-logs-filter :status
                              (if (.. % -target -checked) "issues-only" nil))}]
       "Issues only"]]
     ;; Entry list
     (when loading?
       [:div.logs-loading "Loading..."])
     [:ul.object-list
      (if (empty? filtered)
        [:li.empty-list "No import entries"]
        (for [entry filtered]
          (let [entry-id (:id entry)
                selected? (= (:id selected) entry-id)
                issue-count (or (:open_issue_count entry) 0)]
            ^{:key entry-id}
            [:li.log-entry-item
             {:class (when selected? "selected")
              :on-click #(f/run-fire-and-forget! (ui-flow/select-log-entry-flow) {:entry entry})}
             [:span.log-entry-type (type-icon (:source_object_type entry))]
             [:span.log-entry-name (:source_object_name entry)]
             [:span.log-entry-meta
              [:span {:class (str "status-badge " (:status entry))}
               (:status entry)]
              (when (pos? issue-count)
                [:span.issue-badge issue-count])]])))]]))

(defn sidebar
  "Main sidebar component"
  []
  (let [collapsed? (:sidebar-collapsed? @state/app-state)
        app-mode (:app-mode @state/app-state)]
    [:aside.sidebar {:class (when collapsed? "collapsed")}
     [:div.sidebar-header
      [collapse-toggle]
      (when-not collapsed?
        [:span.sidebar-title
         (case app-mode
           :import "Access Databases"
           :logs   "Import History"
           "Objects")])]
     (when-not collapsed?
       (case app-mode
         :import [:<>
                  [:div.object-list-container
                   [access-database-list]]]
         :logs   [:<>
                  [:div.object-list-container
                   [logs-entry-list]]]
         ;; default: :run
         [:<>
          [object-type-selector]
          [new-object-button]
          [:div.object-list-container
           [object-list]]]))]))
