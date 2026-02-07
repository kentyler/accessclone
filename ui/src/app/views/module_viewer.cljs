(ns app.views.module-viewer
  "Module viewer - displays VBA source and editable ClojureScript translation"
  (:require [reagent.core :as r]
            [app.state :as state]))

;; ============================================================
;; VBA SOURCE - Read-only display
;; ============================================================

(defn vba-panel
  "Read-only VBA source display"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        vba-source (or (:vba-source module-info) (:source module-info))]
    [:div.module-vba-panel
     [:div.panel-header "VBA Source"]
     [:div.code-container
      [:pre.code-display
       [:code vba-source]]]]))

;; ============================================================
;; CLJS PANEL - Editable ClojureScript translation
;; ============================================================

(defn cljs-panel
  "Editable ClojureScript translation panel"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        cljs-source (:cljs-source module-info)
        translating? (get-in @state/app-state [:module-viewer :translating?])
        dirty? (get-in @state/app-state [:module-viewer :cljs-dirty?])]
    [:div.module-cljs-panel
     [:div.panel-header
      [:span "ClojureScript"]
      [:div.panel-actions
       (when dirty?
         [:button.btn-primary.btn-sm
          {:on-click state/save-module-cljs!}
          "Save"])]]
     (cond
       translating?
       [:div.translating-indicator "Translating..."]

       cljs-source
       [:textarea.cljs-editor
        {:value cljs-source
         :on-change #(state/update-module-cljs-source! (.. % -target -value))
         :spellCheck false}]

       :else
       [:div.cljs-empty "No translation yet. Click \"Translate\" to generate ClojureScript from the VBA source."])]))

;; ============================================================
;; INFO PANEL - Module metadata
;; ============================================================

(defn info-panel
  "Display module metadata"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])]
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
                            (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))]])]))

;; ============================================================
;; TOOLBAR
;; ============================================================

(defn module-toolbar
  "Toolbar with translate and save actions"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        is-vba? (:vba-source module-info)
        translating? (get-in @state/app-state [:module-viewer :translating?])
        dirty? (get-in @state/app-state [:module-viewer :cljs-dirty?])]
    [:div.module-toolbar
     [:div.toolbar-left
      [:span.toolbar-label (if is-vba? "VBA Module" "Module (Read-only)")]]
     [:div.toolbar-right
      (when is-vba?
        [:<>
         (when dirty?
           [:button.btn-primary
            {:on-click state/save-module-cljs!}
            "Save Translation"])
         [:button.btn-secondary
          {:on-click state/translate-module!
           :disabled translating?}
          (if translating? "Translating..." "Translate to ClojureScript")]])]]))

;; ============================================================
;; MAIN COMPONENT
;; ============================================================

(defn module-viewer
  "Main module viewer component"
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
