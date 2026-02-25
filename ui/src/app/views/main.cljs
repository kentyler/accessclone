(ns app.views.main
  "Main application layout with Access-style navigation"
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.navigation :as nav]
            [app.flows.ui :as ui-flow]
            [app.flows.chat :as chat-flow]
            [app.flows.module :as module-flow]
            [app.views.sidebar :as sidebar]
            [app.views.tabs :as tabs]
            [app.views.form-editor :as form-editor]
            [app.views.access-database-viewer :as access-db-viewer]
            [app.views.logs-viewer :as logs-viewer]
            [app.views.hub :as hub]
            [app.views.notes :as notes]
            [app.views.llm-registry :as llm-registry]
            [app.views.meetings :as meetings]
            [app.views.messaging :as messaging]
            [app.views.email :as email]))

(defn- grid-size-selector [local-grid-size]
  [:div.options-section
   [:h4 "Form Designer"]
   [:div.option-row
    [:label "Grid Size (pixels)"]
    [:select
     {:value @local-grid-size
      :on-change #(reset! local-grid-size (js/parseInt (.. % -target -value) 10))}
     [:option {:value 4} "4"]
     [:option {:value 6} "6"]
     [:option {:value 8} "8 (Access default)"]
     [:option {:value 10} "10"]
     [:option {:value 12} "12"]
     [:option {:value 16} "16"]
     [:option {:value 20} "20"]]]
   [:p.option-hint "Hold Ctrl while dragging for pixel-perfect positioning"]])

(defn options-dialog
  "Tools > Options dialog for app configuration"
  []
  (let [local-grid-size (r/atom (state/get-grid-size))]
    (fn []
      (when (:options-dialog-open? @state/app-state)
        [:div.dialog-overlay
         {:on-click #(t/dispatch! :close-options-dialog)}
         [:div.dialog
          {:on-click #(.stopPropagation %)}
          [:div.dialog-header
           [:h3 "Options"]
           [:button.dialog-close {:on-click #(t/dispatch! :close-options-dialog)} "\u00D7"]]
          [:div.dialog-body [grid-size-selector local-grid-size]]
          [:div.dialog-footer
           [:button.secondary-btn {:on-click #(t/dispatch! :close-options-dialog)} "Cancel"]
           [:button.primary-btn
            {:on-click (fn []
                         (t/dispatch! :set-grid-size @local-grid-size)
                         (f/run-fire-and-forget! ui-flow/save-config-flow)
                         (t/dispatch! :close-options-dialog))}
            "Save"]]]]))))

(defn database-selector
  "Dropdown to select active database"
  []
  (let [databases (:available-databases @state/app-state)
        current (:current-database @state/app-state)
        loading? (:loading-objects? @state/app-state)]
    [:div.database-selector
     [:select.database-dropdown
      {:value (or (:database_id current) "")
       :disabled loading?
       :on-change #(f/run-fire-and-forget! (nav/switch-database-flow) {:database-id (.. % -target -value)})}
      (for [db databases]
        ^{:key (:database_id db)}
        [:option {:value (:database_id db)}
         (:name db)])]
     (when loading?
       [:span.loading-indicator "Loading..."])]))

(defn mode-toggle
  "Radio buttons to switch between Import, Run, and Logs modes"
  []
  (let [mode (:app-mode @state/app-state)]
    [:div.mode-toggle
     [:label.mode-option
      {:class (when (= mode :import) "active")}
      [:input {:type "radio"
               :name "app-mode"
               :checked (= mode :import)
               :on-change #(do (f/run-fire-and-forget! (ui-flow/set-app-mode-flow) {:mode :import})
                               (access-db-viewer/restore-import-state!))}]
      "Import"]
     [:label.mode-option
      {:class (when (= mode :run) "active")}
      [:input {:type "radio"
               :name "app-mode"
               :checked (= mode :run)
               :on-change #(f/run-fire-and-forget! (ui-flow/set-app-mode-flow) {:mode :run})}]
      "Run"]
     [:label.mode-option
      {:class (when (= mode :logs) "active")}
      [:input {:type "radio"
               :name "app-mode"
               :checked (= mode :logs)
               :on-change #(f/run-fire-and-forget! (ui-flow/set-app-mode-flow) {:mode :logs})}]
      "Logs"]]))

(defn header []
  [:header.header
   [:div.header-content
    [database-selector]
    [mode-toggle]
    [:nav.header-nav
     [:div.menu-bar
      [:div.menu-item
       [:span "Tools"]
       [:div.menu-dropdown
        [:button.menu-option
         {:on-click #(t/dispatch! :open-options-dialog)}
         "Options..."]]]]]]])

(defn error-banner []
  (when-let [error (:error @state/app-state)]
    [:div.error-banner
     [:span error]
     [:button {:on-click #(t/dispatch! :clear-error)} "Dismiss"]]))

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
     {:on-click #(f/run-fire-and-forget! nav/create-new-form-flow)}
     "Create New Form"]]])

(defn main-area []
  (let [mode (:app-mode @state/app-state)]
    (case mode
      :import [:div.main-area
               [access-db-viewer/access-database-viewer]]
      :logs   [:div.main-area
               [logs-viewer/log-detail-panel]]
      ;; default :run
      [:div.main-area
       [tabs/tab-bar]
       [:div.editor-container
        (if (:active-tab @state/app-state)
          [form-editor/object-editor]
          [welcome-panel])]])))

(defn chat-message [{:keys [role content]}]
  [:div.chat-message {:class role}
   [:div.message-content content]])

(defn get-chat-context
  "Get context-aware hint and placeholder based on active tab or mode"
  []
  (let [mode (:app-mode @state/app-state)
        active-tab (:active-tab @state/app-state)
        tab-type (:type active-tab)
        tab-name (:name active-tab)]
    (cond
      (= mode :logs)
      (let [entry (:logs-selected-entry @state/app-state)]
        {:empty-hint (if entry
                       (str "I can help you understand and resolve issues for \""
                            (:source_object_name entry) "\".")
                       "Select an import entry to review its issues.")
         :placeholder "Ask about import issues..."})

      (= mode :import)
      (let [chat-tab (:chat-tab @state/app-state)
            db-name (:name chat-tab)]
        {:empty-hint (if db-name
                       (str "I can help with importing into \"" db-name "\". Ask about import progress, object types, or conversion issues.")
                       "Select a target database to start a conversation about this import.")
         :placeholder (if db-name
                        (str "Ask about the " db-name " import...")
                        "Select a target database...")})

      :else
      (case tab-type
        :forms {:empty-hint (str "I can help you find records, analyze data, or modify the form design for \"" tab-name "\".")
                :placeholder "Ask about records or form design..."}
        :tables {:empty-hint (str "I can help you query data, add columns, or modify the \"" tab-name "\" table structure.")
                 :placeholder "Ask about table data or structure..."}
        :queries {:empty-hint (str "I can help you modify the SQL, create new queries, or explain what \"" tab-name "\" does.")
                  :placeholder "Ask about this query or create new ones..."}
        :modules {:empty-hint (str "I can help you edit \"" tab-name "\", create new functions, or explain what this code does.")
                  :placeholder "Ask me to edit or create functions..."}
        :app {:empty-hint "I can see the whole application. Ask me about dependencies, which modules write to a table, or what objects are missing."
              :placeholder "Ask about the whole application..."}
        {:empty-hint "Ask me anything about your database, forms, or code. I can help you find records, write queries, and create functions."
         :placeholder "Type a message..."}))))

(defn- gap-decision-item [idx gq]
  [:div.gap-decision-item
   [:div.gap-decision-question
    [:span.gap-decision-number (str (inc idx) ". ")]
    [:span.gap-decision-proc (:procedure gq)]
    " \u2014 "
    [:span.gap-decision-vba (let [vba (or (:vba_line gq) "")]
                               (if (> (count vba) 60)
                                 (str (subs vba 0 60) "...")
                                 vba))]]
   [:div.gap-decision-text (:question gq)]
   [:div.gap-decision-options
    (for [suggestion (:suggestions gq)]
      ^{:key suggestion}
      [:label.gap-decision-option
       [:input {:type "radio"
                :name (str "gap-decision-" idx)
                :checked (= suggestion (:selected gq))
                :on-change #(t/dispatch! :set-gap-selection idx suggestion)}]
       [:span suggestion]])]])

(defn- gap-decisions-widget []
  (let [gap-questions (get-in @state/app-state [:module-viewer :gap-questions])
        all-answered? (every? :selected gap-questions)
        submitting? (get-in @state/app-state [:module-viewer :submitting-gaps?])]
    (when (seq gap-questions)
      [:div.gap-decisions-panel
       [:div.gap-decisions-header "Gap Decisions"]
       (for [[idx gq] (map-indexed vector gap-questions)]
         ^{:key idx}
         [gap-decision-item idx gq])
       [:div.gap-decisions-actions
        [:button.btn-primary.btn-sm
         {:disabled (or (not all-answered?) submitting?)
          :on-click #(f/run-fire-and-forget! module-flow/submit-gap-decisions-flow)}
         (if submitting? "Submitting..." "Submit Decisions")]
        [:span.gap-decisions-hint
         (if all-answered?
           "All gaps answered. Click Submit to save."
           (let [remaining (count (filter #(nil? (:selected %)) gap-questions))]
             (str remaining " of " (count gap-questions) " remaining")))]]])))

(defn- assessment-finding-row [finding checked?]
  (let [fixable? (:fixable finding)]
    [:div.assessment-finding
     {:class (case (:type finding)
               ("reserved-word" "action-query" "missing-pk") "structural"
               ("wide-table" "empty-table" "missing-relationship" "naming-inconsistency") "design"
               "complexity")}
     (when fixable?
       [:input {:type "checkbox"
                :checked checked?
                :on-change #(t/dispatch! :toggle-assessment-check (:id finding))}])
     [:span.assessment-object (:object finding)]
     [:span.assessment-message " \u2014 " (:message finding)]
     (when (:suggestion finding)
       [:span.assessment-suggestion " (" (:suggestion finding) ")"])]))

(defn- assessment-section [title findings checked-set & [collapsible?]]
  (let [expanded? (r/atom true)]
    (fn [title findings checked-set]
      (when (seq findings)
        [:div.assessment-section
         [:div.assessment-section-header
          {:on-click #(swap! expanded? not)
           :style {:cursor "pointer"}}
          [:span (if @expanded? "\u25BE " "\u25B8 ")]
          [:strong title]
          [:span.assessment-count (str " (" (count findings) ")")]]
         (when @expanded?
           [:div.assessment-section-body
            (for [finding findings]
              ^{:key (:id finding)}
              [assessment-finding-row finding (contains? checked-set (:id finding))])])]))))

(defn- assessment-widget []
  (let [import-mode (r/atom :as-is)]
    (fn []
      (let [findings (:assessment-findings @state/app-state)
            checked (or (:assessment-checked @state/app-state) #{})
            assessing? (:assessing? @state/app-state)
            app-mode (:app-mode @state/app-state)]
        (when (and (= app-mode :import)
                   (or assessing? findings))
          (if assessing?
            [:div.assessment-widget
             [:div.assessment-header "Analyzing database..."]
             [:div.assessment-loading "Checking for structural issues..."]]
            (let [{:keys [structural design complexity summary]} findings
                  fix-count (count checked)
                  has-fixable? (pos? (:fixable_count summary))]
              [:div.assessment-widget
               [:div.assessment-header "Pre-Import Assessment"]
               (when (:recommendation summary)
                 [:div.assessment-summary (:recommendation summary)])
               [assessment-section "Structural" structural checked]
               [assessment-section "Design" design checked]
               [assessment-section "Complexity" complexity checked]
               [:div.assessment-actions
                (when has-fixable?
                  [:div.assessment-mode-choice
                   [:label.assessment-radio
                    [:input {:type "radio" :name "import-mode"
                             :checked (= @import-mode :as-is)
                             :on-change #(reset! import-mode :as-is)}]
                    " Import as-is"]
                   [:label.assessment-radio
                    [:input {:type "radio" :name "import-mode"
                             :checked (= @import-mode :fix)
                             :on-change #(reset! import-mode :fix)}]
                    " Fix if possible"]])
                [:div.assessment-buttons
                 [:button.btn-primary.btn-sm
                  {:on-click #(t/dispatch! :clear-assessment)}
                  (if (and has-fixable? (= @import-mode :fix))
                    (str "Import with Fixes (" fix-count ")")
                    "Import")]]]])))))))

(defn- chat-messages-list [messages loading? empty-hint messages-end]
  [:div.chat-messages
   (if (empty? messages)
     [:div.chat-empty empty-hint]
     (for [[idx msg] (map-indexed vector messages)]
       ^{:key idx}
       [chat-message msg]))
   ;; Interactive gap decisions widget (after chat messages)
   [gap-decisions-widget]
   ;; Pre-import assessment widget (import mode only)
   [assessment-widget]
   (when loading?
     [:div.chat-message.assistant
      [:div.message-content.typing "Thinking..."]])
   [:div {:ref #(reset! messages-end %)}]])

(defn- chat-input-area [input loading? placeholder]
  [:div.chat-input-area
   [:textarea.chat-input
    {:value input
     :placeholder placeholder
     :disabled loading?
     :on-change #(t/dispatch! :set-chat-input (.. % -target -value))
     :on-key-down (fn [e]
                    (when (and (= (.-key e) "Enter")
                               (not (.-shiftKey e)))
                      (.preventDefault e)
                      (f/run-fire-and-forget! chat-flow/send-chat-message-flow)))}]
   [:button.chat-send
    {:on-click #(f/run-fire-and-forget! chat-flow/send-chat-message-flow)
     :disabled (or loading? (empty? (clojure.string/trim input)))}
    "Send"]])

(defn chat-panel []
  (let [messages-end (r/atom nil)
        prev-msg-count (r/atom 0)]
    (r/create-class
     {:component-did-update
      (fn [_this]
        (let [cur-count (count (:chat-messages @state/app-state))]
          (when (not= cur-count @prev-msg-count)
            (reset! prev-msg-count cur-count)
            (when-let [el @messages-end]
              (.scrollIntoView el #js {:behavior "smooth"})))))
      :reagent-render
      (fn []
        (let [messages (:chat-messages @state/app-state)
              input (:chat-input @state/app-state)
              loading? (:chat-loading? @state/app-state)
              open? (:chat-panel-open? @state/app-state)
              {:keys [empty-hint placeholder]} (get-chat-context)]
          [:aside.chat-panel {:class (when-not open? "collapsed")}
           [:div.chat-header
            [:span.chat-title "Assistant"]
            [:button.chat-toggle {:on-click #(t/dispatch! :toggle-chat-panel)}
             (if open? "\u00BB" "\u00AB")]]
           (when open?
             [:<>
              [chat-messages-list messages loading? empty-hint messages-end]
              [chat-input-area input loading? placeholder]])]))})))

(defn- back-to-hub []
  [:a.back-to-hub {:on-click #(swap! state/app-state assoc :current-page :hub)} "\u2190 Back to Hub"])

(defn- accessclone-app []
  [:div.app
   [back-to-hub]
   [header]
   [error-banner]
   [loading-indicator]
   [options-dialog]
   [:div.app-body
    [sidebar/sidebar]
    [main-area]
    [chat-panel]]])

(defn app []
  (let [current-page (:current-page @state/app-state)]
    [:div.app-shell
     (case current-page
       :hub         [hub/hub-page]
       :notes       [notes/notes-page]
       :llm-registry [llm-registry/llm-registry-page]
       :meetings    [meetings/meetings-page]
       :messaging   [messaging/messaging-page]
       :email       [email/email-page]
       [accessclone-app])]))
