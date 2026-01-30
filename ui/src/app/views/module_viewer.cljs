(ns app.views.module-viewer
  "Module viewer - read-only code display for database functions"
  (:require [reagent.core :as r]
            [app.state :as state]))

;; ============================================================
;; CODE VIEW - Read-only display of function source
;; ============================================================

(defn code-view
  "Read-only code display"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        source (:source module-info)]
    [:div.module-code-view
     [:div.code-container
      [:pre.code-display
       [:code source]]]]))

;; ============================================================
;; INFO PANEL - Function signature and description
;; ============================================================

(defn info-panel
  "Display function metadata"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])]
    [:div.module-info-panel
     [:div.info-row
      [:span.info-label "Function:"]
      [:span.info-value (:name module-info)]]
     [:div.info-row
      [:span.info-label "Arguments:"]
      [:span.info-value (or (:arguments module-info) "(none)")]]
     [:div.info-row
      [:span.info-label "Returns:"]
      [:span.info-value (:return-type module-info)]]
     (when (:description module-info)
       [:div.info-row
        [:span.info-label "Description:"]
        [:span.info-value (:description module-info)]])]))

;; ============================================================
;; TOOLBAR
;; ============================================================

(defn module-toolbar
  "Toolbar - minimal for read-only view"
  []
  [:div.module-toolbar
   [:div.toolbar-left
    [:span.toolbar-label "Module (Read-only)"]]
   [:div.toolbar-right
    [:span.toolbar-hint "Use chat to edit"]]])

;; ============================================================
;; MAIN COMPONENT
;; ============================================================

(defn module-viewer
  "Main module viewer component"
  []
  (let [active-tab (:active-tab @state/app-state)
        current-module-id (get-in @state/app-state [:module-viewer :module-id])]
    (when (and active-tab (= (:type active-tab) :modules))
      ;; Load module when tab changes
      (let [module (first (filter #(= (:id %) (:id active-tab))
                                  (get-in @state/app-state [:objects :modules])))]
        (when (and module (not= (:id module) current-module-id))
          (state/load-module-for-viewing! module)))
      [:div.module-viewer
       [module-toolbar]
       [info-panel]
       [code-view]])))
