(ns app.views.sidebar
  "Access-style collapsible sidebar with object navigation"
  (:require [reagent.core :as r]
            [app.state :as state]))

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
    (when (= object-type :forms)
      [:button.new-object-btn
       {:on-click #(state/create-new-form!)}
       [:span.icon "+"]
       [:span "New Form"]])))

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
  (let [collapsed? (:sidebar-collapsed? @state/app-state)]
    [:aside.sidebar {:class (when collapsed? "collapsed")}
     [:div.sidebar-header
      [collapse-toggle]
      (when-not collapsed?
        [:span.sidebar-title "Objects"])]
     (when-not collapsed?
       [:<>
        [object-type-selector]
        [new-object-button]
        [:div.object-list-container
         [object-list]]])]))
