(ns app.views.sidebar
  "Access-style collapsible sidebar with object navigation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.navigation :as nav]
            [app.flows.ui :as ui-flow]
            [app.views.access-database-viewer :as access-db-viewer]
            [app.flows.app :as app-flow]))

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

;; -- File picker modal state & helpers --

(def picker-state
  (r/atom {:open? false
           :dir nil
           :home nil
           :loading? false
           :dirs []
           :files []
           :error nil
           :selected #{}}))

(defn- browse-dir! [dir]
  (swap! picker-state assoc :loading? true :error nil)
  (-> (js/fetch (str "/api/access-import/browse"
                     (when dir (str "?dir=" (js/encodeURIComponent dir)))))
      (.then #(.json %))
      (.then (fn [data]
               (let [d (js->clj data :keywordize-keys true)]
                 (if (:error d)
                   (swap! picker-state assoc :loading? false :error (:error d))
                   (let [current (:current d)
                         updates (cond-> {:loading? false
                                          :dir current
                                          :parent (:parent d)
                                          :dirs (or (:directories d) [])
                                          :files (or (:files d) [])}
                                   ;; Capture home on first browse (no dir arg)
                                   (nil? dir) (assoc :home current))]
                     (swap! picker-state merge updates))))))
      (.catch (fn [err]
                (swap! picker-state assoc :loading? false
                       :error (str "Failed to browse: " (.-message err)))))))

(defn- open-picker! []
  (swap! picker-state assoc :open? true :dir nil :home nil :dirs [] :files [] :error nil :selected #{})
  (browse-dir! nil))

(defn- close-picker! []
  (swap! picker-state assoc :open? false))

(defn file-picker-modal
  "Modal file browser for selecting .accdb/.mdb files (multi-select)"
  []
  (let [path-input (r/atom "")]
    (fn []
      (let [{:keys [open? dir loading? dirs files error parent selected]} @picker-state]
        (when open?
          [:div.file-picker-overlay {:on-click #(when (= (.-target %) (.-currentTarget %))
                                                  (close-picker!))}
           [:div.file-picker-dialog
            [:div.file-picker-header "Browse for Access Databases"]
            [:div.file-picker-path-bar
             [:button.file-picker-up
              {:on-click #(when parent (browse-dir! parent))
               :disabled (or (nil? parent) (= dir parent))}
              "\u2191 Up"]
             [:input.file-picker-path-input
              {:type "text"
               :value (let [v @path-input] (if (seq v) v (or dir "")))
               :on-change #(reset! path-input (.. % -target -value))
               :on-focus #(reset! path-input (or dir ""))
               :on-key-down (fn [e]
                              (when (= (.-key e) "Enter")
                                (let [v (clojure.string/trim @path-input)]
                                  (when (seq v)
                                    (browse-dir! v)
                                    (reset! path-input "")))))
               :on-blur #(reset! path-input "")}]]
            (let [home (:home @picker-state)]
              [:div.file-picker-shortcuts
               [:button.file-picker-shortcut
                {:on-click #(browse-dir! nil)}
                "Home"]
               (when home
                 [:<>
                  [:button.file-picker-shortcut
                   {:on-click #(browse-dir! (str home "\\Desktop"))}
                   "Desktop"]
                  [:button.file-picker-shortcut
                   {:on-click #(browse-dir! (str home "\\Documents"))}
                   "Documents"]])])
            (when error
              [:div.file-picker-error error])
            (when loading?
              [:div.file-picker-loading "Loading..."])
            [:div.file-picker-entries
             (for [d dirs]
               ^{:key (str "d-" d)}
               [:div.file-picker-entry.file-picker-dir
                {:on-click #(browse-dir! (str dir "\\" d))}
                [:span.file-picker-icon "\uD83D\uDCC1"]
                [:span.file-picker-name d]])
             (for [f files]
               (let [fpath (:path f)
                     checked? (contains? selected fpath)]
                 ^{:key (str "f-" (:name f))}
                 [:div.file-picker-entry.file-picker-file
                  {:class (when checked? "selected")
                   :on-click #(swap! picker-state update :selected
                                     (fn [s] (if (contains? s fpath) (disj s fpath) (conj s fpath))))}
                  [:span.file-picker-check {:class (when checked? "checked")}
                   (when checked? "\u2713")]
                  [:span.file-picker-icon
                   (if (clojure.string/ends-with? (clojure.string/lower-case (:name f)) ".mdb")
                     "\uD83D\uDDC3" "\uD83D\uDDD2")]
                  [:span.file-picker-name (:name f)]
                  [:span.file-picker-size (format-file-size (:size f))]]))]
            (when (seq selected)
              [:div.file-picker-selected-summary
               (str (count selected) " database" (when (> (count selected) 1) "s") " selected")])
            [:div.file-picker-actions
             [:button.file-picker-cancel {:on-click close-picker!} "Cancel"]
             [:button.file-picker-confirm
              {:disabled (empty? selected)
               :on-click (fn []
                           (doseq [p selected]
                             (access-db-viewer/toggle-database-selection! p))
                           (close-picker!))}
              (str "Select" (when (seq selected) (str " (" (count selected) ")")))]]]])))))

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
         [:div.find-db-section
          [:div.find-db-option
           [:div.find-db-row
            [:input.browse-input
             {:type "text"
              :placeholder "Folder or file path"
              :value @browse-path
              :on-change #(reset! browse-path (.. % -target -value))
              :on-key-down #(when (= (.-key %) "Enter") (submit-browse!))}]
            [:button.scan-btn {:on-click submit-browse!} "Go"]]
           [:div.find-db-hint "Paste a path to scan for databases"]]
          [:div.find-db-option
           [:button.find-db-btn {:on-click open-picker!} "Browse Files..."]
           [:div.find-db-hint "Navigate folders to pick databases"]]
          [:div.find-db-option
           [:button.find-db-btn.find-db-btn-secondary
            {:on-click (fn [e]
                         (.preventDefault e)
                         (f/run-fire-and-forget! (ui-flow/load-access-databases-flow) {}))}
            "Scan All Locations"]
           [:div.find-db-hint "Search Desktop and Documents"]]]
         [file-picker-modal]
         [:ul.object-list
          (if (empty? databases)
            [:li.empty-list "Use the options above to find databases."]
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
         (let [active-tab (:active-tab @state/app-state)
               app-active? (= (:type active-tab) :app)]
           [:<>
            [:div.app-link
             {:class (when app-active? "active")
              :on-click #(f/run-fire-and-forget! nav/open-app-flow)}
             [:span.app-link-icon "\uD83C\uDFE2"]
             [:span "Application"]]
            [object-type-selector]
            [new-object-button]
            [:div.object-list-container
             [object-list]]])))]))
