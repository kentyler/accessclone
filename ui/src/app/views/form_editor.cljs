(ns app.views.form-editor
  "Form editor/designer - replaces Access design view"
  (:require [clojure.string]
            [app.state :as state]
            [app.views.form-properties :as form-properties]
            [app.views.form-design :as form-design]
            [app.views.form-view :as form-view]
            [app.views.table-viewer :as table-viewer]
            [app.views.query-viewer :as query-viewer]
            [app.views.module-viewer :as module-viewer]))

(defn ask-ai-to-fix-errors!
  "Send lint errors to AI for suggestions"
  [errors]
  (let [error-text (str "My form has these validation errors:\n"
                        (clojure.string/join "\n" (map #(str "- " (:location %) ": " (:message %)) errors))
                        "\n\nHow can I fix these issues?")]
    (state/set-chat-input! error-text)
    (state/send-chat-message!)))

(defn lint-errors-panel
  "Display lint errors with Ask AI button"
  []
  (let [errors (get-in @state/app-state [:form-editor :lint-errors])]
    (when (seq errors)
      [:div.lint-errors-panel
       [:div.lint-errors-header
        [:span.lint-errors-title "Form Validation Errors"]
        [:button.lint-errors-close
         {:on-click state/clear-lint-errors!}
         "\u00D7"]]
       [:ul.lint-errors-list
        (for [[idx error] (map-indexed vector errors)]
          ^{:key idx}
          [:li.lint-error
           [:span.error-location (:location error)]
           [:span.error-message (:message error)]])]
       [:div.lint-errors-actions
        [:button.secondary-btn
         {:on-click #(ask-ai-to-fix-errors! errors)}
         "Ask AI to Help Fix"]
        [:button.secondary-btn
         {:on-click state/clear-lint-errors!}
         "Dismiss"]]])))

(defn form-toolbar
  "Toolbar with form actions"
  []
  (let [dirty? (get-in @state/app-state [:form-editor :dirty?])
        view-mode (state/get-view-mode)]
    [:div.form-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn
       {:class (when (= view-mode :design) "active")
        :title "Design View"
        :on-click #(state/set-view-mode! :design)}
       "Design"]
      [:button.toolbar-btn
       {:class (when (= view-mode :view) "active")
        :title "Form View"
        :on-click #(state/set-view-mode! :view)}
       "View"]]
     [:div.toolbar-right
      [:button.secondary-btn
       {:disabled (not dirty?)
        :on-click #(let [original (get-in @state/app-state [:form-editor :original])]
                     (state/set-form-definition! original))}
       "Undo"]
      [:button.primary-btn
       {:disabled (not dirty?)
        :on-click state/save-form!}
       "Save"]]]))

(defn popup-context-menu
  "Context menu for popup title bar and form view canvas header"
  []
  (let [ctx-menu (:context-menu @state/app-state)]
    (when (:visible? ctx-menu)
      [:div.context-menu
       {:style {:left (:x ctx-menu) :top (:y ctx-menu)}}
       [:div.context-menu-item
        {:on-click (fn [e]
                     (.stopPropagation e)
                     (state/hide-context-menu!)
                     (if (= (state/get-view-mode) :view)
                       (state/save-current-record!)
                       (state/save-form!)))}
        "Save"]
       [:div.context-menu-item
        {:on-click (fn [e]
                     (.stopPropagation e)
                     (state/hide-context-menu!)
                     (state/close-current-tab!))}
        "Close"]
       [:div.context-menu-item
        {:on-click (fn [e]
                     (.stopPropagation e)
                     (state/hide-context-menu!)
                     (state/close-all-tabs!))}
        "Close All"]
       [:div.context-menu-separator]
       [:div.context-menu-item
        {:class (when (= (state/get-view-mode) :view) "active")
         :on-click (fn [e]
                     (.stopPropagation e)
                     (state/hide-context-menu!)
                     (state/set-view-mode! :view))}
        "Form View"]
       [:div.context-menu-item
        {:class (when (= (state/get-view-mode) :design) "active")
         :on-click (fn [e]
                     (.stopPropagation e)
                     (state/hide-context-menu!)
                     (state/set-view-mode! :design))}
        "Design View"]])))

(defn form-editor
  "Main form editor component"
  []
  (let [active-tab (:active-tab @state/app-state)
        editing-form-id (get-in @state/app-state [:form-editor :form-id])
        view-mode (state/get-view-mode)]
    (when (and active-tab (= (:type active-tab) :forms))
      ;; Load form data when tab changes to a different form
      (let [form (first (filter #(= (:id %) (:id active-tab))
                                (get-in @state/app-state [:objects :forms])))]
        (when (and form (not= (:id form) editing-form-id))
          (state/load-form-for-editing! form)))
      (let [current-def (get-in @state/app-state [:form-editor :current])
            popup? (and (= view-mode :view)
                        (not= 0 (:popup current-def)))
            modal? (and popup? (not= 0 (:modal current-def)))]
        [:div.form-editor
         [form-toolbar]
         [lint-errors-panel]
         (if (= view-mode :view)
           (if popup?
             ;; Popup view mode - floating window
             [:div.editor-body.view-mode
              [:div.popup-overlay
               {:class (when modal? "modal")
                :on-click #(state/hide-context-menu!)}
               [:div.popup-window
                [:div.popup-title-bar
                 {:on-context-menu (fn [e]
                                     (.preventDefault e)
                                     (.stopPropagation e)
                                     (state/show-context-menu! (.-clientX e) (.-clientY e)))}
                 [:span.popup-title (or (:caption current-def) (:name current-def) "Form")]
                 [:button.popup-close {:on-click #(state/close-current-tab!)} "\u2715"]]
                [form-view/form-view]]
               [popup-context-menu]]]
             ;; Inline view mode
             [:div.editor-body.view-mode
              [:div.editor-center
               [form-view/form-view]]])
           ;; Design mode - form with properties and field panels
           [:div.editor-body
            [:div.editor-center
             [form-design/form-canvas]]
            [:div.editor-right
             [form-properties/properties-panel]
             [form-design/field-list]]])]))))

(defn object-editor
  "Routes to the appropriate editor based on active tab type"
  []
  (let [active-tab (:active-tab @state/app-state)]
    (case (:type active-tab)
      :forms [form-editor]
      :tables [table-viewer/table-viewer]
      :queries [query-viewer/query-viewer]
      :modules [module-viewer/module-viewer]
      [:div.no-editor
       [:p "Select an object to edit"]])))
