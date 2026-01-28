(ns app.views.main
  "Main application layout with Access-style navigation"
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [app.state :as state]
            [app.views.sidebar :as sidebar]
            [app.views.tabs :as tabs]
            [app.views.form-editor :as form-editor]))

(defn options-dialog
  "Tools > Options dialog for app configuration"
  []
  (let [local-grid-size (r/atom (state/get-grid-size))]
    (fn []
      (when (:options-dialog-open? @state/app-state)
        [:div.dialog-overlay
         {:on-click #(state/close-options-dialog!)}
         [:div.dialog
          {:on-click #(.stopPropagation %)}
          [:div.dialog-header
           [:h3 "Options"]
           [:button.dialog-close
            {:on-click #(state/close-options-dialog!)}
            "\u00D7"]]
          [:div.dialog-body
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
            [:p.option-hint "Hold Ctrl while dragging for pixel-perfect positioning"]]]
          [:div.dialog-footer
           [:button.secondary-btn
            {:on-click #(state/close-options-dialog!)}
            "Cancel"]
           [:button.primary-btn
            {:on-click (fn []
                         (state/set-grid-size! @local-grid-size)
                         (state/save-config!)
                         (state/close-options-dialog!))}
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
       :on-change #(state/switch-database! (.. % -target -value))}
      (for [db databases]
        ^{:key (:database_id db)}
        [:option {:value (:database_id db)}
         (:name db)])]
     (when loading?
       [:span.loading-indicator "Loading..."])]))

(defn header []
  [:header.header
   [:div.header-content
    [database-selector]
    [:nav.header-nav
     [:div.menu-bar
      [:div.menu-item
       [:span "Tools"]
       [:div.menu-dropdown
        [:button.menu-option
         {:on-click #(state/open-options-dialog!)}
         "Options..."]]]]]]])

(defn error-banner []
  (when-let [error (:error @state/app-state)]
    [:div.error-banner
     [:span error]
     [:button {:on-click state/clear-error!} "Dismiss"]]))

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
     {:on-click #(state/create-new-form!)}
     "Create New Form"]]])

(defn main-area []
  [:div.main-area
   [tabs/tab-bar]
   [:div.editor-container
    (if (:active-tab @state/app-state)
      [form-editor/object-editor]
      [welcome-panel])]])

(defn chat-message [{:keys [role content]}]
  [:div.chat-message {:class role}
   [:div.message-content content]])

(defn chat-panel []
  (let [messages (:chat-messages @state/app-state)
        input (:chat-input @state/app-state)
        loading? (:chat-loading? @state/app-state)
        open? (:chat-panel-open? @state/app-state)
        messages-end (r/atom nil)]
    ;; Scroll to bottom when messages change
    (r/create-class
     {:component-did-update
      (fn [this]
        (when-let [el @messages-end]
          (.scrollIntoView el #js {:behavior "smooth"})))
      :reagent-render
      (fn []
        (let [messages (:chat-messages @state/app-state)
              input (:chat-input @state/app-state)
              loading? (:chat-loading? @state/app-state)
              open? (:chat-panel-open? @state/app-state)]
          [:aside.chat-panel {:class (when-not open? "collapsed")}
           [:div.chat-header
            [:span.chat-title "Assistant"]
            [:button.chat-toggle
             {:on-click state/toggle-chat-panel!}
             (if open? "\u00BB" "\u00AB")]]
           (when open?
             [:<>
              [:div.chat-messages
               (if (empty? messages)
                 [:div.chat-empty "Ask me anything about your database or forms."]
                 (for [[idx msg] (map-indexed vector messages)]
                   ^{:key idx}
                   [chat-message msg]))
               (when loading?
                 [:div.chat-message.assistant
                  [:div.message-content.typing "Thinking..."]])
               [:div {:ref #(reset! messages-end %)}]]
              [:div.chat-input-area
               [:textarea.chat-input
                {:value input
                 :placeholder "Type a message..."
                 :disabled loading?
                 :on-change #(state/set-chat-input! (.. % -target -value))
                 :on-key-down (fn [e]
                                (when (and (= (.-key e) "Enter")
                                           (not (.-shiftKey e)))
                                  (.preventDefault e)
                                  (state/send-chat-message!)))}]
               [:button.chat-send
                {:on-click state/send-chat-message!
                 :disabled (or loading? (empty? (clojure.string/trim input)))}
                "Send"]]])]))})))

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
