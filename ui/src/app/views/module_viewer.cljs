(ns app.views.module-viewer
  "Module viewer - displays VBA source with two-phase intent extraction + code generation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.module :as module-flow]
            [clojure.string :as str]))

;; ============================================================
;; INTENT SUMMARY PANEL
;; ============================================================

(defn- classification-badge [classification]
  (let [cls (case classification
              "mechanical" "badge-mechanical"
              "llm-fallback" "badge-llm"
              "gap" "badge-gap"
              "badge-unknown")]
    [:span {:class (str "intent-badge " cls)}
     classification]))

(defn- intent-item [intent]
  [:div.intent-item
   [:span.intent-type (:type intent)]
   (when (:classification intent)
     [classification-badge (:classification intent)])
   (when-let [field (:field intent)]
     [:span.intent-detail (str "field: " field)])
   (when-let [form (:form intent)]
     [:span.intent-detail (str "form: " form)])
   (when-let [msg (:message intent)]
     [:span.intent-detail (str "\"" (subs msg 0 (min 40 (count msg)))
                                (when (> (count msg) 40) "...") "\"")])
   (when-let [table (:table intent)]
     [:span.intent-detail (str "table: " table)])])

(defn- procedure-summary [proc expanded-atom]
  (let [expanded? (get @expanded-atom (:name proc) false)
        stats (:stats proc)]
    [:div.procedure-summary
     [:div.procedure-header
      {:on-click #(swap! expanded-atom update (:name proc) not)}
      [:span.expand-icon (if expanded? "\u25BC" "\u25B6")]
      [:span.procedure-name (:name proc)]
      (when (:trigger proc)
        [:span.procedure-trigger (str "(" (:trigger proc) ")")])
      [:span.procedure-stats
       (when (pos? (:mechanical stats 0))
         [:span.stat-mechanical (str (:mechanical stats) " mech")])
       (when (pos? (:llm_fallback stats 0))
         [:span.stat-llm (str (:llm_fallback stats) " llm")])
       (when (pos? (:gap stats 0))
         [:span.stat-gap (str (:gap stats) " gap")])]]
     (when expanded?
       [:div.procedure-intents
        (for [[idx intent] (map-indexed vector (:intents proc))]
          ^{:key idx} [intent-item intent])])]))

(defn intent-summary-panel []
  (let [expanded-procs (r/atom {})]
    (fn []
      (let [intents-data (get-in @state/app-state [:module-viewer :intents])
            stats (:stats intents-data)]
        (when intents-data
          [:div.intent-summary-panel
           [:div.intent-summary-header
            [:strong "Intent Analysis"]
            [:span.intent-summary-stats
             (str (count (get-in intents-data [:intents :procedures])) " procedures, "
                  (:total stats 0) " intents")]]
           [:div.intent-stats-bar
            (when (pos? (:mechanical stats 0))
              [:span.stat-bar-mechanical
               (str (:mechanical stats) " mechanical")])
            (when (pos? (:llm_fallback stats 0))
              [:span.stat-bar-llm
               (str (:llm_fallback stats) " LLM-assisted")])
            (when (pos? (:gap stats 0))
              [:span.stat-bar-gap
               (str (:gap stats) " gaps")])]
           [:div.intent-procedures
            (for [proc (get-in intents-data [:mapped :procedures])]
              ^{:key (:name proc)}
              [procedure-summary proc expanded-procs])]])))))

;; ============================================================
;; VBA SOURCE - Read-only display with extraction buttons
;; ============================================================

(defn vba-panel
  "Read-only VBA source display with intent extraction and legacy translate buttons"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        vba-source (or (:vba-source module-info) (:source module-info))
        translating? (get-in @state/app-state [:module-viewer :translating?])
        extracting? (get-in @state/app-state [:module-viewer :extracting-intents?])]
    [:div.module-vba-panel
     [:div.panel-header
      [:span "VBA Source"]
      (when vba-source
        [:div.panel-actions
         [:button.btn-primary.btn-sm
          {:on-click #(f/run-fire-and-forget! module-flow/extract-intents-flow)
           :disabled (or extracting? translating?)}
          (if extracting? "Extracting..." "Extract Intents")]
         [:button.btn-secondary.btn-sm
          {:on-click #(f/run-fire-and-forget! module-flow/translate-module-flow)
           :disabled (or translating? extracting?)
           :title "Direct translation without intent extraction (legacy)"}
          (if translating? "Translating..." "Direct Translate")]])]
     [:div.code-container
      [:pre.code-display
       [:code vba-source]]]]))

;; ============================================================
;; CLJS PANEL - Read-only display of current translation
;; ============================================================

(defn cljs-panel
  "Read-only display of the current ClojureScript translation with generate button"
  []
  (let [module-info (get-in @state/app-state [:module-viewer :module-info])
        cljs-source (:cljs-source module-info)
        dirty? (get-in @state/app-state [:module-viewer :cljs-dirty?])
        translating? (get-in @state/app-state [:module-viewer :translating?])
        intents-data (get-in @state/app-state [:module-viewer :intents])]
    [:div.module-cljs-panel
     [:div.panel-header
      [:span (str "ClojureScript"
                  (when dirty? " (unsaved)"))]
      [:div.panel-actions
       (when intents-data
         [:button.btn-primary.btn-sm
          {:on-click #(f/run-fire-and-forget! module-flow/generate-wiring-flow)
           :disabled translating?}
          (if translating? "Generating..." "Generate Code")])
       (when dirty?
         [:button.btn-secondary.btn-sm
          {:on-click #(f/run-fire-and-forget! module-flow/save-module-cljs-flow)}
          "Save"])]]
     (cond
       translating?
       [:div.translating-indicator "Generating..."]

       cljs-source
       [:div.code-container
        [:pre.code-display.cljs-display
         [:code cljs-source]]]

       :else
       [:div.cljs-empty
        (if intents-data
          "Intents extracted. Click \"Generate Code\" to produce ClojureScript."
          "No translation yet. Extract intents first, or use \"Direct Translate\".")])]))

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
  "Main module viewer component - VBA source with intent extraction + code generation"
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
          [intent-summary-panel]
          [:div.module-split-view
           [vba-panel]
           [cljs-panel]]])])))
