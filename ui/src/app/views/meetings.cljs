(ns app.views.meetings
  (:require [app.state :as state]))

(defn meetings-page []
  [:div.stub-page
   [:a.back-to-hub {:on-click #(swap! state/app-state assoc :current-page :hub)} "\u2190 Back to Hub"]
   [:h1 "Meetings"]
   [:p "Coming soon."]])
