(ns app.views.module-viewer
  "Module viewer - displays VBA source; translation happens in chat panel"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.module :as module-flow]))

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
         {:on-click #(f/run-fire-and-forget! module-flow/translate-module-flow)
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
          {:on-click #(f/run-fire-and-forget! module-flow/save-module-cljs-flow)}
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
        :on-change #(f/run-fire-and-forget! module-flow/save-module-status-flow {:status (.. % -target -value)})}
       (for [[val label] status-options]
         ^{:key val} [:option {:value val} label])]]
     (when (= status "needs-review")
       [:div.info-row.review-notes-row
        [:span.info-label "Notes:"]
        [:textarea.review-notes-input
         {:value (or (:review-notes module-info) "")
          :placeholder "Why does this need review?"
          :on-change #(t/dispatch! :update-module-review-notes (.. % -target -value))
          :rows 2}]])]))

;; ============================================================
;; IMPORT COMPLETENESS BANNER
;; ============================================================

(defn import-completeness-banner
  "Show amber warning when import is incomplete"
  []
  (let [completeness (:import-completeness @state/app-state)]
    (when (and (:has_discovery completeness) (not (:complete completeness)))
      (let [missing (:missing completeness)]
        [:div.import-completeness-warning
         [:div.warning-header
          [:strong "Import Incomplete"]
          [:span.warning-counts
           (str (:imported_count completeness) " of " (:total_source_count completeness) " objects imported")]]
         [:div.warning-detail
          "Translation is blocked until all objects are imported. Missing:"
          [:ul.missing-list
           (for [[type-key names] missing]
             ^{:key (name type-key)}
             [:li [:strong (name type-key)] (str ": " (clojure.string/join ", " names))])]]]))))

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
         {:on-click #(f/run-fire-and-forget! module-flow/save-module-cljs-flow)}
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
          (f/run-fire-and-forget! (module-flow/load-module-for-viewing-flow) {:module module})))
      [:div.module-viewer
       [module-toolbar]
       (if loading?
         [:div.loading-spinner "Loading module..."]
         [:<>
          [info-panel]
          [import-completeness-banner]
          [:div.module-split-view
           [vba-panel]
           [cljs-panel]]])])))
