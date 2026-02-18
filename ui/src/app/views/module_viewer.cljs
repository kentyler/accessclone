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

;; ============================================================
;; GAP RESOLUTION PANEL
;; ============================================================

(defn- count-gaps
  "Count total and resolved gaps across all procedures, recursively."
  [procedures]
  (let [total (atom 0)
        resolved (atom 0)]
    (letfn [(walk [intents]
              (doseq [intent intents]
                (when (= "gap" (:type intent))
                  (swap! total inc)
                  (when (:resolution intent)
                    (swap! resolved inc)))
                (when (:then intent) (walk (:then intent)))
                (when (:else intent) (walk (:else intent)))
                (when (:children intent) (walk (:children intent)))))]
      (doseq [proc procedures]
        (walk (:intents proc))))
    {:total @total :resolved @resolved}))

(defn gap-resolution-panel
  "Interactive panel for resolving a gap intent."
  [intent]
  (let [local-state (r/atom {:selected nil :notes "" :changing? false})]
    (fn [intent]
      (let [resolution (:resolution intent)
            resolved? (and resolution (not (:changing? @local-state)))]
        [:div.gap-resolution
         [:div.gap-question (:question intent)]
         (if resolved?
           ;; Resolved state: compact summary
           [:div.gap-resolved
            [:div.gap-resolved-answer
             [:strong "Resolved: "]
             [:span (:answer resolution)]
             (when (:custom_notes resolution)
               [:span.gap-resolved-notes (str " - " (:custom_notes resolution))])]
            [:a.gap-change-link
             {:href "#"
              :on-click (fn [e]
                          (.preventDefault e)
                          (swap! local-state assoc
                                 :changing? true
                                 :selected (:answer resolution)
                                 :notes (or (:custom_notes resolution) "")))}
             "Change answer"]
            (when (seq (:resolution_history intent))
              [:details.gap-history
               [:summary (str (count (:resolution_history intent)) " previous answer(s)")]
               [:ul
                (for [[idx entry] (map-indexed vector (:resolution_history intent))]
                  ^{:key idx}
                  [:li (str (:answer entry)
                            (when (:custom_notes entry) (str " - " (:custom_notes entry)))
                            " (" (.toLocaleDateString (js/Date. (:resolved_at entry))) ")")])]])]
           ;; Unresolved state: radio buttons + notes + resolve button
           [:div.gap-suggestions
            (for [suggestion (:suggestions intent)]
              ^{:key suggestion}
              [:label.gap-suggestion
               [:input {:type "radio"
                        :name (str "gap-" (:gap_id intent))
                        :value suggestion
                        :checked (= suggestion (:selected @local-state))
                        :on-change #(swap! local-state assoc :selected suggestion)}]
               [:span suggestion]])
            [:textarea.gap-notes
             {:placeholder "Additional notes (optional)"
              :value (:notes @local-state)
              :on-change #(swap! local-state assoc :notes (.. % -target -value))
              :rows 2}]
            [:div.gap-actions
             [:button.btn-primary.btn-sm
              {:disabled (nil? (:selected @local-state))
               :on-click (fn []
                           (f/run-fire-and-forget! module-flow/resolve-gap-flow
                                                   {:gap-id (:gap_id intent)
                                                    :answer (:selected @local-state)
                                                    :custom-notes (let [n (:notes @local-state)]
                                                                    (when (seq n) n))})
                           (swap! local-state assoc :changing? false))}
              "Resolve"]
             (when (:changing? @local-state)
               [:button.btn-secondary.btn-sm
                {:on-click #(swap! local-state assoc :changing? false)}
                "Cancel"])]])]))))

;; ============================================================
;; INTENT ITEMS & PROCEDURES
;; ============================================================

(defn- intent-item [intent]
  [:<>
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
      [:span.intent-detail (str "table: " table)])
    ;; For gaps: show VBA line as detail
    (when (and (= "gap" (:type intent)) (:vba_line intent))
      [:span.intent-detail (str (subs (:vba_line intent) 0 (min 50 (count (:vba_line intent))))
                                (when (> (count (:vba_line intent)) 50) "..."))])]
   ;; Show gap resolution panel for gaps with questions
   (when (and (= "gap" (:type intent)) (:question intent))
     [gap-resolution-panel intent])])

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
            stats (:stats intents-data)
            procedures (get-in intents-data [:mapped :procedures])
            gap-counts (when (seq procedures) (count-gaps procedures))]
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
               (str (:total gap-counts) " gaps"
                    (when (pos? (:resolved gap-counts 0))
                      (str " (" (:resolved gap-counts) " resolved)")))])]
           ;; Unresolved gaps banner
           (when (and gap-counts (pos? (:total gap-counts))
                      (< (:resolved gap-counts 0) (:total gap-counts 0)))
             (let [unresolved (- (:total gap-counts) (:resolved gap-counts 0))]
               [:div.gap-banner
                (str unresolved " unresolved gap(s) \u2014 expand procedures above to answer questions")]))
           [:div.intent-procedures
            (for [proc procedures]
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
          [:div.module-split-view
           [vba-panel]
           [cljs-panel]]])])))
