(ns app.views.main
  "Main application layout with Access-style navigation"
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.state-form :as state-form]
            [app.flows.core :as f]
            [app.flows.navigation :as nav]
            [app.flows.ui :as ui-flow]
            [app.flows.chat :as chat-flow]
            [app.views.sidebar :as sidebar]
            [app.views.tabs :as tabs]
            [app.views.form-editor :as form-editor]
            [app.views.access-database-viewer :as access-db-viewer]
            [app.views.logs-viewer :as logs-viewer]))

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
    (if (= mode :logs)
      (let [entry (:logs-selected-entry @state/app-state)]
        {:empty-hint (if entry
                       (str "I can help you understand and resolve issues for \""
                            (:source_object_name entry) "\".")
                       "Select an import entry to review its issues.")
         :placeholder "Ask about import issues..."})
      (case tab-type
        :forms {:empty-hint (str "I can help you find records, analyze data, or modify the form design for \"" tab-name "\".")
                :placeholder "Ask about records or form design..."}
        :tables {:empty-hint (str "I can help you query data, add columns, or modify the \"" tab-name "\" table structure.")
                 :placeholder "Ask about table data or structure..."}
        :queries {:empty-hint (str "I can help you modify the SQL, create new queries, or explain what \"" tab-name "\" does.")
                  :placeholder "Ask about this query or create new ones..."}
        :modules {:empty-hint (str "I can help you edit \"" tab-name "\", create new functions, or explain what this code does.")
                  :placeholder "Ask me to edit or create functions..."}
        {:empty-hint "Ask me anything about your database, forms, or code. I can help you find records, write queries, and create functions."
         :placeholder "Type a message..."}))))

(defn- chat-messages-list [messages loading? empty-hint messages-end]
  [:div.chat-messages
   (if (empty? messages)
     [:div.chat-empty empty-hint]
     (for [[idx msg] (map-indexed vector messages)]
       ^{:key idx}
       [chat-message msg]))
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
  (let [messages-end (r/atom nil)]
    (r/create-class
     {:component-did-update
      (fn [_this]
        (when-let [el @messages-end]
          (.scrollIntoView el #js {:behavior "smooth"})))
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

(defn app []
  [:div.app
   [header]
   [error-banner]
   [loading-indicator]
   [options-dialog]
   [:div.app-body
    [sidebar/sidebar]
    [main-area]
    [chat-panel]]])
