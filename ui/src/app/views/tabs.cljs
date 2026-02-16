(ns app.views.tabs
  "Tab bar for open objects"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.flows.core :as f]
            [app.flows.navigation :as nav]))

(defn tab
  "Single tab component"
  [{:keys [type id name]} active?]
  [:div.tab
   {:class (when active? "active")
    :on-click #(f/run-fire-and-forget! (nav/set-active-tab-flow) {:type type :id id})}
   [:span.tab-name name]
   [:button.tab-close
    {:on-click (fn [e]
                 (.stopPropagation e)
                 (f/run-fire-and-forget! (nav/close-tab-flow) {:type type :id id}))
     :title "Close tab"}
    "\u00D7"]])

(defn tab-bar
  "Tab bar showing all open objects"
  []
  (let [open-objects (:open-objects @state/app-state)
        active-tab (:active-tab @state/app-state)]
    [:div.tab-bar
     (if (empty? open-objects)
       [:div.no-tabs "Select an object from the sidebar to open it"]
       (for [{:keys [type id name] :as obj} open-objects]
         ^{:key (str (cljs.core/name type) "-" id)}
         [tab obj (and (= (:type active-tab) type)
                       (= (:id active-tab) id))]))]))
