(ns app.views.email
  (:require [app.state :as state]))

(defn email-page []
  [:div.stub-page
   [:a.back-to-hub {:on-click #(swap! state/app-state assoc :current-page :hub)} "\u2190 Back to Hub"]
   [:h1 "Email"]
   [:p "Coming soon."]])
