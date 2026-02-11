(ns app.views.macro-viewer
  "Macro viewer - displays Access macro XML; translation happens in chat panel"
  (:require [reagent.core :as r]
            [app.state :as state]))

;; ============================================================
;; MACRO XML - Read-only display
;; ============================================================

(defn xml-panel
  "Read-only macro XML display"
  []
  (let [macro-info (get-in @state/app-state [:macro-viewer :macro-info])
        macro-xml (:macro-xml macro-info)]
    [:div.module-vba-panel
     [:div.panel-header
      [:span "Macro XML"]]
     [:div.code-container
      [:pre.code-display
       [:code macro-xml]]]]))

;; ============================================================
;; CLJS PANEL - Read-only display of current translation
;; ============================================================

(defn cljs-panel
  "Read-only display of the current ClojureScript translation"
  []
  (let [macro-info (get-in @state/app-state [:macro-viewer :macro-info])
        cljs-source (:cljs-source macro-info)
        dirty? (get-in @state/app-state [:macro-viewer :cljs-dirty?])]
    [:div.module-cljs-panel
     [:div.panel-header
      [:span (str "ClojureScript"
                  (when dirty? " (unsaved)"))]
      (when dirty?
        [:div.panel-actions
         [:button.btn-primary.btn-sm
          {:on-click state/save-macro-cljs!}
          "Save"]])]
     (if cljs-source
       [:div.code-container
        [:pre.code-display.cljs-display
         [:code cljs-source]]]
       [:div.cljs-empty "No translation yet. Use the chat panel to translate this macro."])]))

;; ============================================================
;; INFO PANEL - Macro metadata
;; ============================================================

(def status-options
  [["pending" "Pending"]
   ["translated" "Translated"]
   ["needs-review" "Needs Review"]
   ["complete" "Complete"]])

(defn info-panel
  "Display macro metadata with status"
  []
  (let [macro-info (get-in @state/app-state [:macro-viewer :macro-info])
        status (or (:status macro-info) "pending")]
    [:div.module-info-panel
     [:div.info-row
      [:span.info-label "Macro:"]
      [:span.info-value (:name macro-info)]]
     (when (:version macro-info)
       [:div.info-row
        [:span.info-label "Version:"]
        [:span.info-value (:version macro-info)]])
     (when (:created-at macro-info)
       [:div.info-row
        [:span.info-label "Imported:"]
        [:span.info-value (let [d (js/Date. (:created-at macro-info))]
                            (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))]])
     [:div.info-row
      [:span.info-label "Status:"]
      [:select.status-select
       {:value status
        :on-change #(state/set-macro-status! (.. % -target -value))}
       (for [[val label] status-options]
         ^{:key val} [:option {:value val} label])]]]))

;; ============================================================
;; TOOLBAR
;; ============================================================

(defn macro-toolbar
  "Toolbar for the macro viewer"
  []
  (let [macro-info (get-in @state/app-state [:macro-viewer :macro-info])
        dirty? (get-in @state/app-state [:macro-viewer :cljs-dirty?])]
    [:div.module-toolbar
     [:div.toolbar-left
      [:span.toolbar-label "Access Macro"]]
     [:div.toolbar-right
      (when dirty?
        [:button.btn-primary
         {:on-click state/save-macro-cljs!}
         "Save Translation"])]]))

;; ============================================================
;; MAIN COMPONENT
;; ============================================================

(defn macro-viewer
  "Main macro viewer component - macro XML + optional CLJS translation"
  []
  (let [active-tab (:active-tab @state/app-state)
        current-macro-id (get-in @state/app-state [:macro-viewer :macro-id])
        loading? (get-in @state/app-state [:macro-viewer :loading?])]
    (when (and active-tab (= (:type active-tab) :macros))
      ;; Load macro when tab changes
      (let [macro (first (filter #(= (:id %) (:id active-tab))
                                 (get-in @state/app-state [:objects :macros])))]
        (when (and macro (not= (:id macro) current-macro-id))
          (state/load-macro-for-viewing! macro)))
      [:div.module-viewer
       [macro-toolbar]
       (if loading?
         [:div.loading-spinner "Loading macro..."]
         [:<>
          [info-panel]
          [:div.module-split-view
           [xml-panel]
           [cljs-panel]]])])))
