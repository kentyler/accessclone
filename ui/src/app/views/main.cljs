(ns app.views.main
  "Main application layout with Access-style navigation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.views.sidebar :as sidebar]
            [app.views.tabs :as tabs]
            [app.views.form-editor :as form-editor]))

(defn header []
  [:header.header
   [:div.header-content
    [:h1 (:app-name @state/app-state)]
    [:nav
     [:span.db-name (:database-name @state/app-state)]]]])

(defn error-banner []
  (when-let [error (:error @state/app-state)]
    [:div.error-banner
     [:span error]
     [:button {:on-click state/clear-error!} "Dismiss"]]))

(defn loading-indicator []
  (when (:loading? @state/app-state)
    [:div.loading-overlay
     [:div.spinner]]))

(defn welcome-panel []
  [:div.welcome-panel
   [:h2 "Welcome"]
   [:p "Select an object from the sidebar to open it, or create a new form."]
   [:div.quick-actions
    [:button.primary-btn
     {:on-click #(state/create-new-form!)}
     "Create New Form"]]])

(defn main-area []
  [:div.main-area
   [tabs/tab-bar]
   [:div.editor-container
    (if (:active-tab @state/app-state)
      [form-editor/object-editor]
      [welcome-panel])]])

(defn app []
  [:div.app
   [header]
   [error-banner]
   [loading-indicator]
   [:div.app-body
    [sidebar/sidebar]
    [main-area]]])
