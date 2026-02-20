(ns app.views.messaging
  (:require [app.state :as state]))

(defn messaging-page []
  [:div.stub-page
   [:a.back-to-hub {:on-click #(swap! state/app-state assoc :current-page :hub)} "\u2190 Back to Hub"]
   [:h1 "Messaging"]
   [:p "Coming soon."]])
