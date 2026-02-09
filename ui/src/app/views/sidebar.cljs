(ns app.views.sidebar
  "Access-style collapsible sidebar with object navigation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.state-form :as state-form]
            [app.state-table :as state-table]
            [app.views.access-database-viewer :as access-db-viewer]))

;; Object types available in the dropdown (like Access navigation pane)
(def object-types
  [{:id :tables   :label "Tables"}
   {:id :queries  :label "Queries"}
   {:id :forms    :label "Forms"}
   {:id :reports  :label "Reports"}
   {:id :modules  :label "Modules"}])

(defn object-type-selector
  "Dropdown to select which type of objects to display"
  []
  (let [selected (:sidebar-object-type @state/app-state)]
    [:div.object-type-selector
     [:select
      {:value (name (or selected :forms))
       :on-change #(state/set-sidebar-object-type!
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
       {:on-click #(state-form/create-new-form!)}
       [:span.icon "+"]
       [:span "New Form"]]

      :tables
      [:button.new-object-btn
       {:on-click #(state-table/start-new-table!)}
       [:span.icon "+"]
       [:span "New Table"]]

      nil)))

(defn object-list-item
  "Single item in the object list"
  [{:keys [id name type]} active?]
  [:li.object-item
   {:class (when active? "active")
    :on-click #(state/open-object! type id)}
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
  "Browse input + list of Access database files found by scanning"
  []
  (let [browse-path (r/atom "")
        submit-browse! (fn []
                         (let [path (clojure.string/trim @browse-path)]
                           (when (seq path)
                             (state/load-access-databases! path))))]
    (fn []
      (let [databases (sort-by #(clojure.string/lower-case (or (:name %) ""))
                               (get-in @state/app-state [:objects :access_databases] []))
            selected-path (:loaded-path @access-db-viewer/viewer-state)]
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
                           (state/load-access-databases!))}
           "Or scan all locations"]]
         [:ul.object-list
          (if (empty? databases)
            [:li.empty-list "Paste a path above to find databases."]
            (for [db databases]
              ^{:key (:path db)}
              [:li.object-item
               {:class (when (= (:path db) selected-path) "active")
                :on-click #(access-db-viewer/load-access-database-contents! (:path db))}
               [:span.object-name (:name db)]
               [:span.access-db-detail (format-file-size (:size db))]]))]]))))

(defn collapse-toggle
  "Button to collapse/expand the sidebar"
  []
  (let [collapsed? (:sidebar-collapsed? @state/app-state)]
    [:button.collapse-toggle
     {:on-click state/toggle-sidebar!
      :title (if collapsed? "Expand sidebar" "Collapse sidebar")}
     (if collapsed? "\u25B6" "\u25C0")]))

(defn sidebar
  "Main sidebar component"
  []
  (let [collapsed? (:sidebar-collapsed? @state/app-state)
        import-mode? (= (:app-mode @state/app-state) :import)]
    [:aside.sidebar {:class (when collapsed? "collapsed")}
     [:div.sidebar-header
      [collapse-toggle]
      (when-not collapsed?
        [:span.sidebar-title (if import-mode? "Access Databases" "Objects")])]
     (when-not collapsed?
       (if import-mode?
         [:<>
          [:div.object-list-container
           [access-database-list]]]
         [:<>
          [object-type-selector]
          [new-object-button]
          [:div.object-list-container
           [object-list]]]))]))
