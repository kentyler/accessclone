(ns app.views.notes
  (:require [app.state :as state]))

(defn notes-page []
  [:div.stub-page
   [:a.back-to-hub {:on-click #(swap! state/app-state assoc :current-page :hub)} "\u2190 Back to Hub"]
   [:h1 "Notes"]
   [:p "Coming soon."]])
