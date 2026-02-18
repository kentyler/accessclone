(ns app.views.app-viewer
  "App Viewer — application-level dashboard with multiple panes."
  (:require [clojure.string]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.app :as app-flow]))

;; ============================================================
;; Overview Pane — Phase 1
;; ============================================================

(defn- progress-bar
  "A simple progress bar showing imported/source ratio."
  [imported source]
  (let [pct (if (and source (pos? source))
              (min 100 (Math/round (* 100 (/ imported source))))
              (if (pos? imported) 100 0))]
    [:div.app-progress-bar
     [:div.app-progress-fill {:style {:width (str pct "%")}}]
     [:span.app-progress-text (str imported (when source (str " / " source)))]]))

(defn- status-card
  "Single card in the overview grid."
  [label imported source icon]
  [:div.app-status-card
   [:div.app-card-icon icon]
   [:div.app-card-body
    [:div.app-card-label label]
    [progress-bar imported source]]])

(defn- translation-summary
  "Summary of module translation and intent stats."
  [translation intent-stats]
  (when translation
    [:div.app-translation-summary
     [:h4 "Translation Status"]
     [:div.app-translation-grid
      [:div.app-stat
       [:span.app-stat-value (:pending translation 0)]
       [:span.app-stat-label "Pending"]]
      [:div.app-stat
       [:span.app-stat-value (:draft translation 0)]
       [:span.app-stat-label "Draft"]]
      [:div.app-stat
       [:span.app-stat-value (:reviewed translation 0)]
       [:span.app-stat-label "Reviewed"]]
      [:div.app-stat
       [:span.app-stat-value (:approved translation 0)]
       [:span.app-stat-label "Approved"]]]
     (when (and intent-stats (pos? (:total intent-stats 0)))
       [:div.app-intent-summary
        [:h4 "Intent Analysis"]
        [:div.app-translation-grid
         [:div.app-stat
          [:span.app-stat-value (:modules_with_intents intent-stats 0)]
          [:span.app-stat-label "Modules Analyzed"]]
         [:div.app-stat.mechanical
          [:span.app-stat-value (:mechanical intent-stats 0)]
          [:span.app-stat-label "Mechanical"]]
         [:div.app-stat.llm-fallback
          [:span.app-stat-value (:llm_fallback intent-stats 0)]
          [:span.app-stat-label "LLM Fallback"]]
         [:div.app-stat.gap
          [:span.app-stat-value (:gap intent-stats 0)]
          [:span.app-stat-label "Gaps"]]]])]))

(defn- overview-pane []
  (let [overview (get-in @state/app-state [:app-viewer :overview])
        loading? (get-in @state/app-state [:app-viewer :loading?])]
    [:div.app-overview-pane
     (cond
       loading?
       [:div.app-loading "Loading overview..."]

       (nil? overview)
       [:div.app-loading "No overview data. Select a database first."]

       :else
       [:<>
        [:h3 (str (:database_name overview) " \u2014 Import Progress")]
        [:div.app-status-grid
         [status-card "Tables"
          (get-in overview [:imported :tables] 0)
          (get-in overview [:source :tables])
          "\uD83D\uDDD2"]
         [status-card "Queries"
          (get-in overview [:imported :queries] 0)
          (get-in overview [:source :queries])
          "\uD83D\uDD0D"]
         [status-card "Forms"
          (get-in overview [:imported :forms] 0)
          (get-in overview [:source :forms])
          "\uD83D\uDCCB"]
         [status-card "Reports"
          (get-in overview [:imported :reports] 0)
          (get-in overview [:source :reports])
          "\uD83D\uDCC4"]
         [status-card "Modules"
          (get-in overview [:imported :modules] 0)
          (get-in overview [:source :modules])
          "\uD83D\uDCDD"]
         [status-card "Macros"
          (get-in overview [:imported :macros] 0)
          (get-in overview [:source :macros])
          "\u26A1"]]
        (when-let [comp (:completeness overview)]
          (when (:has_discovery comp)
            [:div.app-completeness
             {:class (if (:complete comp) "complete" "incomplete")}
             (if (:complete comp)
               "All source objects imported."
               (str (:missing_count comp) " source object(s) not yet imported."))]))
        [translation-summary
         (:translation_status overview)
         (:intent_stats overview)]])]))

;; ============================================================
;; Gap Decisions Pane — 3-Step Pipeline
;; ============================================================

(defn- gap-decision-item [idx gq]
  [:div.app-gap-item
   [:div.app-gap-header
    [:span.app-gap-module (:module gq)]
    [:span.app-gap-proc (:procedure gq)]
    (when (:vba_line gq)
      [:span.app-gap-vba (let [v (:vba_line gq)]
                            (if (> (count v) 60) (str (subs v 0 60) "...") v))])]
   [:div.app-gap-question (:question gq)]
   [:div.app-gap-options
    (for [suggestion (:suggestions gq)]
      ^{:key suggestion}
      [:label.app-gap-option
       [:input {:type "radio"
                :name (str "app-gap-" idx)
                :checked (= suggestion (:selected gq))
                :on-change #(t/dispatch! :set-app-gap-selection idx suggestion)}]
       [:span suggestion]])]])

(defn- pipeline-step-header [number title active? complete?]
  [:div.app-pipeline-step
   {:class (str (when active? " active") (when complete? " complete"))}
   [:span.app-pipeline-number (str number)]
   [:span.app-pipeline-title title]
   (when complete?
     [:span.app-pipeline-check "\u2713"])])

(defn- gen-results-summary [results]
  (when results
    [:div.app-gen-results
     (when (seq (:generated results))
       [:div.app-gen-result-group.generated
        [:strong (str (count (:generated results)) " generated")]
        [:span (clojure.string/join ", " (:generated results))]])
     (when (seq (:skipped results))
       [:div.app-gen-result-group.skipped
        [:strong (str (count (:skipped results)) " skipped (missing deps)")]
        [:span (clojure.string/join ", " (:skipped results))]])
     (when (seq (:failed results))
       [:div.app-gen-result-group.failed
        [:strong (str (count (:failed results)) " failed")]
        (for [{:keys [name error]} (:failed results)]
          ^{:key name}
          [:div (str name ": " (or error "unknown error"))])])]))

(defn- gap-decisions-pane []
  (let [extracting? (get-in @state/app-state [:app-viewer :batch-extracting?])
        progress (get-in @state/app-state [:app-viewer :batch-progress])
        gap-questions (get-in @state/app-state [:app-viewer :all-gap-questions] [])
        submitting? (get-in @state/app-state [:app-viewer :submitting-gaps?])
        generating? (get-in @state/app-state [:app-viewer :batch-generating?])
        gen-progress (get-in @state/app-state [:app-viewer :batch-gen-progress])
        gen-results (get-in @state/app-state [:app-viewer :batch-gen-results])
        overview (get-in @state/app-state [:app-viewer :overview])
        has-intents? (pos? (get-in overview [:intent_stats :modules_with_intents] 0))
        all-answered? (and (seq gap-questions)
                           (every? :selected gap-questions))
        gaps-resolved? (and has-intents?
                            (empty? gap-questions)
                            (not extracting?))]
    [:div.app-gaps-pane

     ;; ── Step 1: Extract ──
     [pipeline-step-header 1 "Extract Intents" (not has-intents?) has-intents?]
     [:div.app-pipeline-body
      [:div.app-gaps-actions
       [:button.primary-btn
        {:disabled (or extracting? generating?)
         :on-click #(f/run-fire-and-forget! app-flow/batch-extract-intents-flow)}
        (cond
          extracting? "Extracting..."
          has-intents? "Re-extract All"
          :else "Extract All Intents")]]
      (when extracting?
        [:div.app-gaps-progress
         [:div.app-progress-bar
          [:div.app-progress-fill
           {:style {:width (str (if (pos? (:total progress 0))
                                  (Math/round (* 100 (/ (:completed progress 0)
                                                        (:total progress))))
                                  0) "%")}}]]
         (when (:current-module progress)
           [:div.app-gaps-current (str "Processing: " (:current-module progress))])])]

     ;; ── Step 2: Resolve Gaps ──
     (when has-intents?
       [:<>
        [pipeline-step-header 2 "Resolve Gaps"
         (and has-intents? (seq gap-questions))
         gaps-resolved?]
        [:div.app-pipeline-body
         (cond
           (seq gap-questions)
           [:<>
            [:h4 (str (count gap-questions) " gap question(s) across all modules")]
            (for [[idx gq] (map-indexed vector gap-questions)]
              ^{:key idx}
              [gap-decision-item idx gq])
            [:div.app-gaps-submit
             [:button.primary-btn
              {:disabled (or (not all-answered?) submitting? generating?)
               :on-click #(f/run-fire-and-forget! app-flow/submit-all-gap-decisions-flow)}
              (if submitting? "Submitting..." "Submit All Decisions")]
             [:span.app-gaps-hint
              (if all-answered?
                "All gaps answered. Click Submit to save."
                (let [remaining (count (filter #(nil? (:selected %)) gap-questions))]
                  (str remaining " of " (count gap-questions) " remaining")))]]]

           gaps-resolved?
           [:div.app-gaps-empty "All gaps resolved."])]])

     ;; ── Step 3: Generate Code ──
     (when has-intents?
       [:<>
        [pipeline-step-header 3 "Generate Code"
         (and gaps-resolved? (not gen-results))
         (some? gen-results)]
        [:div.app-pipeline-body
         [:div.app-gaps-actions
          [:button.primary-btn
           {:disabled (or (not gaps-resolved?) generating? extracting?)
            :on-click #(f/run-fire-and-forget! app-flow/batch-generate-code-flow)}
           (cond
             generating? "Generating..."
             gen-results "Regenerate All Code"
             :else "Generate All Code")]]
         (when generating?
           [:div.app-gaps-progress
            [:div.app-progress-bar
             [:div.app-progress-fill
              {:style {:width (str (if (pos? (:total gen-progress 0))
                                     (Math/round (* 100 (/ (:generated gen-progress 0)
                                                           (:total gen-progress))))
                                     0) "%")}}]]
            [:div.app-gaps-current
             (str "Pass " (:pass gen-progress 1)
                  " \u2014 " (:current-module gen-progress "")
                  " (" (:generated gen-progress 0) "/" (:total gen-progress 0) ")")]])
         [gen-results-summary gen-results]]])]))

;; ============================================================
;; Dependencies Pane — Phase 5 (stub)
;; ============================================================

(defn- binding-row [label obj-name source exists?]
  [:tr {:class (when-not exists? "broken")}
   [:td label]
   [:td obj-name]
   [:td source]
   [:td (if exists? "Yes" "Missing")]])

(defn- dependencies-pane []
  (let [deps (get-in @state/app-state [:app-viewer :dependencies])
        loading? (get-in @state/app-state [:app-viewer :loading?])]
    [:div.app-deps-pane
     [:button.secondary-btn
      {:disabled loading?
       :on-click #(f/run-fire-and-forget! app-flow/load-app-dependencies-flow)}
      "Load Dependencies"]
     (if loading?
       [:div.app-loading "Loading..."]
       (when deps
         [:<>
          (let [summary (:summary deps)]
            [:div.app-deps-summary
             (str (:total_tables summary) " tables, "
                  (:total_views summary) " views, "
                  (:total_forms summary) " forms, "
                  (:total_reports summary) " reports")
             (when (pos? (+ (:broken_form_bindings summary 0)
                            (:broken_report_bindings summary 0)))
               [:span.app-deps-warning
                (str " \u2014 " (+ (:broken_form_bindings summary)
                                   (:broken_report_bindings summary))
                     " broken binding(s)")])])
          ;; Form bindings
          (when (seq (:form_bindings deps))
            [:div.app-deps-section
             [:h4 "Form Record Sources"]
             [:table.app-deps-table
              [:thead [:tr [:th "Type"] [:th "Name"] [:th "Record Source"] [:th "Exists?"]]]
              [:tbody
               (for [b (:form_bindings deps)]
                 ^{:key (:form b)}
                 [binding-row "Form" (:form b) (:record_source b) (:source_exists b)])]]])
          ;; Report bindings
          (when (seq (:report_bindings deps))
            [:div.app-deps-section
             [:h4 "Report Record Sources"]
             [:table.app-deps-table
              [:thead [:tr [:th "Type"] [:th "Name"] [:th "Record Source"] [:th "Exists?"]]]
              [:tbody
               (for [b (:report_bindings deps)]
                 ^{:key (:report b)}
                 [binding-row "Report" (:report b) (:record_source b) (:source_exists b)])]]])
          ;; Module → form references
          (when (seq (:module_form_refs deps))
            [:div.app-deps-section
             [:h4 "Module \u2192 Form References"]
             [:table.app-deps-table
              [:thead [:tr [:th "Module"] [:th "Referenced Forms"]]]
              [:tbody
               (for [m (:module_form_refs deps)]
                 ^{:key (:module m)}
                 [:tr
                  [:td (:module m)]
                  [:td (clojure.string/join ", " (:forms m))]])]]])
          ;; Orphaned tables
          (when (seq (:orphaned_tables deps))
            [:div.app-deps-section
             [:h4 "Unreferenced Tables"]
             [:div.app-deps-orphans
              (clojure.string/join ", " (:orphaned_tables deps))]])]))]))

;; ============================================================
;; API Surface Pane — Phase 5 (stub)
;; ============================================================

(defn- api-surface-pane []
  (let [surface (get-in @state/app-state [:app-viewer :api-surface])
        loading? (get-in @state/app-state [:app-viewer :loading?])]
    [:div.app-surface-pane
     [:button.secondary-btn
      {:disabled loading?
       :on-click #(f/run-fire-and-forget! app-flow/load-app-api-surface-flow)}
      "Analyze API Surface"]
     (if loading?
       [:div.app-loading "Loading..."]
       (when surface
         [:<>
          (let [summary (:summary surface)]
            [:div.app-surface-summary
             (str (:total_endpoints_needed summary) " endpoint(s) needed")
             (when (pos? (:missing_tables summary 0))
               [:span.app-deps-warning
                (str " \u2014 " (:missing_tables summary) " missing table(s)")])])
          ;; Module data endpoints
          (when (seq (:module_endpoints surface))
            [:div.app-deps-section
             [:h4 "Module Data Operations"]
             [:table.app-deps-table
              [:thead [:tr [:th "Table/Target"] [:th "Operations"] [:th "Modules"] [:th "Exists?"]]]
              [:tbody
               (for [[idx ep] (map-indexed vector (:module_endpoints surface))]
                 ^{:key idx}
                 [:tr {:class (when-not (:exists ep) "broken")}
                  [:td (:table ep)]
                  [:td (clojure.string/join ", " (:operations ep))]
                  [:td (clojure.string/join ", " (:modules ep))]
                  [:td (if (:exists ep) "Yes" "Missing")]])]]])
          ;; Form data needs
          (when (seq (:form_data_needs surface))
            [:div.app-deps-section
             [:h4 "Form Data Sources"]
             [:table.app-deps-table
              [:thead [:tr [:th "Record Source"] [:th "Used By"] [:th "Exists?"]]]
              [:tbody
               (for [[idx fd] (map-indexed vector (:form_data_needs surface))]
                 ^{:key idx}
                 [:tr {:class (when-not (:exists fd) "broken")}
                  [:td (:table fd)]
                  [:td (:source fd)]
                  [:td (if (:exists fd) "Yes" "Missing")]])]]])]))]))

;; ============================================================
;; Main App Viewer Component
;; ============================================================

(def pane-tabs
  [{:id :overview   :label "Overview"}
   {:id :gaps       :label "Gap Decisions"}
   {:id :deps       :label "Dependencies"}
   {:id :api        :label "API Surface"}])

(defn app-viewer
  "Main app viewer component — tabbed dashboard."
  []
  (let [active-pane (or (get-in @state/app-state [:app-viewer :active-pane]) :overview)]
    [:div.app-viewer
     [:div.app-viewer-tabs
      (for [{:keys [id label]} pane-tabs]
        ^{:key id}
        [:button.app-viewer-tab
         {:class (when (= id active-pane) "active")
          :on-click #(t/dispatch! :set-app-pane id)}
         label])]
     [:div.app-viewer-content
      (case active-pane
        :overview [overview-pane]
        :gaps     [gap-decisions-pane]
        :deps     [dependencies-pane]
        :api      [api-surface-pane]
        [overview-pane])]]))
