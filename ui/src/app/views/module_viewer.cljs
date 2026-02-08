(ns app.views.module-viewer
  "Module viewer - displays VBA source; translation happens in chat panel"
  (:require [reagent.core :as r]
            [app.state :as state]))

;; ============================================================
;; VBA SOURCE - Read-only display
;; ============================================================

(defn vba-panel
  "Read-only VBA source display with translate button in header"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        vba-source (or (:vba-source module-info) (:source module-info))
        translating? (get-in @state/app-state [:module-viewer :translating?])]
    [:div.module-vba-panel
     [:div.panel-header
      [:span "VBA Source"]
      (when vba-source
        [:button.btn-secondary.btn-sm
         {:on-click state/translate-module!
          :disabled translating?}
         (if translating? "Translating..." "Translate to ClojureScript")])]
     [:div.code-container
      [:pre.code-display
       [:code vba-source]]]]))

;; ============================================================
;; CLJS PANEL - Read-only display of current translation
;; ============================================================

(defn cljs-panel
  "Read-only display of the current ClojureScript translation"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        cljs-source (:cljs-source module-info)
        dirty? (get-in @state/app-state [:module-viewer :cljs-dirty?])
        translating? (get-in @state/app-state [:module-viewer :translating?])]
    [:div.module-cljs-panel
     [:div.panel-header
      [:span (str "ClojureScript"
                  (when dirty? " (unsaved)"))]
      (when dirty?
        [:div.panel-actions
         [:button.btn-primary.btn-sm
          {:on-click state/save-module-cljs!}
          "Save"]])]
     (cond
       translating?
       [:div.translating-indicator "Translating..."]

       cljs-source
       [:div.code-container
        [:pre.code-display.cljs-display
         [:code cljs-source]]]

       :else
       [:div.cljs-empty "No translation yet. Click \"Translate\" to generate."])]))

;; ============================================================
;; INFO PANEL - Module metadata
;; ============================================================

(def status-options
  [["pending" "Pending"]
   ["translated" "Translated"]
   ["needs-review" "Needs Review"]
   ["complete" "Complete"]])

(defn info-panel
  "Display module metadata with status and review notes"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        status (or (:status module-info) "pending")]
    [:div.module-info-panel
     [:div.info-row
      [:span.info-label "Module:"]
      [:span.info-value (:name module-info)]]
     (when (:version module-info)
       [:div.info-row
        [:span.info-label "Version:"]
        [:span.info-value (:version module-info)]])
     (when (:created-at module-info)
       [:div.info-row
        [:span.info-label "Imported:"]
        [:span.info-value (let [d (js/Date. (:created-at module-info))]
                            (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))]])
     [:div.info-row
      [:span.info-label "Status:"]
      [:select.status-select
       {:value status
        :on-change #(state/set-module-status! (.. % -target -value))}
       (for [[val label] status-options]
         ^{:key val} [:option {:value val} label])]]
     (when (= status "needs-review")
       [:div.info-row.review-notes-row
        [:span.info-label "Notes:"]
        [:textarea.review-notes-input
         {:value (or (:review-notes module-info) "")
          :placeholder "Why does this need review?"
          :on-change #(do (swap! state/app-state assoc-in
                                 [:module-viewer :module-info :review-notes]
                                 (.. % -target -value))
                          (swap! state/app-state assoc-in
                                 [:module-viewer :cljs-dirty?] true))
          :rows 2}]])]))

;; ============================================================
;; TOOLBAR
;; ============================================================

(defn module-toolbar
  "Toolbar with translate and save actions"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        is-vba? (:vba-source module-info)
        dirty? (get-in @state/app-state [:module-viewer :cljs-dirty?])]
    [:div.module-toolbar
     [:div.toolbar-left
      [:span.toolbar-label (if is-vba? "VBA Module" "Module (Read-only)")]]
     [:div.toolbar-right
      (when (and is-vba? dirty?)
        [:button.btn-primary
         {:on-click state/save-module-cljs!}
         "Save Translation"])]]))

;; ============================================================
;; MAIN COMPONENT
;; ============================================================

(defn module-viewer
  "Main module viewer component - VBA source only, translation in chat"
  []
  (let [active-tab (:active-tab @state/app-state)
        current-module-id (get-in @state/app-state [:module-viewer :module-id])
        loading? (get-in @state/app-state [:module-viewer :loading?])]
    (when (and active-tab (= (:type active-tab) :modules))
      ;; Load module when tab changes
      (let [module (first (filter #(= (:id %) (:id active-tab))
                                  (get-in @state/app-state [:objects :modules])))]
        (when (and module (not= (:id module) current-module-id))
          (state/load-module-for-viewing! module)))
      [:div.module-viewer
       [module-toolbar]
       (if loading?
         [:div.loading-spinner "Loading module..."]
         [:<>
          [info-panel]
          [:div.module-split-view
           [vba-panel]
           [cljs-panel]]])])))
