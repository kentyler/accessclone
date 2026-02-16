(ns app.core
  "Application main entry point"
  (:require [reagent.core :as r]
            [reagent.dom :as rdom]
            [app.state :as state]
            [app.state-transforms]
            [app.views.main :as main]))

(defn ^:dev/after-load mount-root []
  (rdom/render [main/app] (.getElementById js/document "app")))

(defn ^:export init []
  (state/init!)
  (mount-root))
