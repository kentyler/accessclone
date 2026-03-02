(ns app.views.form-editor
  "Form editor/designer - replaces Access design view"
  (:require [clojure.string]
            [cljs.core.async :refer [go <!]]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.state-form :as state-form]
            [app.flows.core :as f]
            [app.flows.form :as form-flow]
            [app.flows.chat :as chat-flow]
            [app.flows.navigation :as nav]
            [app.views.form-properties :as form-properties]
            [app.views.form-design :as form-design]
            [app.views.form-view :as form-view]
            [app.views.control-palette :as palette]
            [app.views.table-viewer :as table-viewer]
            [app.views.query-viewer :as query-viewer]
            [app.views.module-viewer :as module-viewer]
            [app.views.macro-viewer :as macro-viewer]
            [app.views.sql-function-viewer :as sql-fn-viewer]
            [app.views.report-editor :as report-editor]
            [app.views.app-viewer :as app-viewer]
            [app.views.access-database-viewer :as access-viewer]))

(defn ask-ai-to-fix-errors!
  "Send lint errors to AI for suggestions"
  [errors]
  (let [error-text (str "My form has these validation errors:\n"
                        (clojure.string/join "\n" (map #(str "- " (:location %) ": " (:message %)) errors))
                        "\n\nHow can I fix these issues?")]
    (t/dispatch! :set-chat-input error-text)
    (f/run-fire-and-forget! chat-flow/send-chat-message-flow)))

(defn lint-errors-panel
  "Display lint errors with Ask AI button"
  []
  (let [errors (get-in @state/app-state [:form-editor :lint-errors])]
    (when (seq errors)
      [:div.lint-errors-panel
       [:div.lint-errors-header
        [:span.lint-errors-title "Form Validation Errors"]
        [:button.lint-errors-close
         {:on-click #(t/dispatch! :clear-lint-errors)}
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
         {:on-click #(t/dispatch! :clear-lint-errors)}
         "Dismiss"]]])))

(defn form-toolbar
  "Toolbar with form actions"
  []
  (let [dirty? (get-in @state/app-state [:form-editor :dirty?])
        view-mode (state-form/get-view-mode)]
    [:div.form-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn
       {:class (when (= view-mode :design) "active")
        :title "Design View"
        :on-click #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :design})}
       "Design"]
      [:button.toolbar-btn
       {:class (when (= view-mode :view) "active")
        :title "Form View"
        :on-click #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :view})}
       "View"]
      (when (= view-mode :design)
        (let [hdr-visible? (not= 0 (get-in @state/app-state [:form-editor :current :header :visible] 1))]
          [:button.toolbar-btn
           {:class (when hdr-visible? "active")
            :title "Toggle Form Header/Footer"
            :on-click #(t/dispatch! :toggle-form-header-footer)}
           "Header/Footer"]))]
     [:div.toolbar-right
      [:button.secondary-btn
       {:title "Re-import this form from the Access database"
        :on-click (fn []
                    (let [form-id (get-in @state/app-state [:form-editor :form-id])
                          form-obj (first (filter #(= (:id %) form-id)
                                                  (get-in @state/app-state [:objects :forms])))
                          form-name (:name form-obj)]
                      (when form-name
                        (go
                          (t/dispatch! :set-loading true)
                          (let [result (<! (access-viewer/reimport-object! :forms form-name))]
                            (t/dispatch! :set-loading false)
                            (if (true? result)
                              (do (println (str "[REIMPORT] Re-imported form: " form-name))
                                  ;; Reload the form definition in the editor
                                  (state-form/load-form-for-editing! (assoc form-obj :definition nil)))
                              (state/log-error! (str "Re-import failed: " (:error result "Unknown error"))
                                                "reimport-form" {:form form-name})))))))}
       "Re-Import"]
      [:button.secondary-btn
       {:disabled (not dirty?)
        :on-click #(let [original (get-in @state/app-state [:form-editor :original])]
                     (t/dispatch! :set-form-definition original))}
       "Undo"]
      [:button.primary-btn
       {:disabled (not dirty?)
        :on-click #(f/run-fire-and-forget! form-flow/save-form-flow)}
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
                     (t/dispatch! :hide-context-menu)
                     (if (= (state-form/get-view-mode) :view)
                       (f/run-fire-and-forget! form-flow/save-current-record-flow)
                       (f/run-fire-and-forget! form-flow/save-form-flow)))}
        "Save"]
       [:div.context-menu-item
        {:on-click (fn [e]
                     (.stopPropagation e)
                     (t/dispatch! :hide-context-menu)
                     (f/run-fire-and-forget! nav/close-current-tab-flow))}
        "Close"]
       [:div.context-menu-item
        {:on-click (fn [e]
                     (.stopPropagation e)
                     (t/dispatch! :hide-context-menu)
                     (f/run-fire-and-forget! nav/close-all-tabs-flow))}
        "Close All"]
       [:div.context-menu-separator]
       [:div.context-menu-item
        {:class (when (= (state-form/get-view-mode) :view) "active")
         :on-click (fn [e]
                     (.stopPropagation e)
                     (t/dispatch! :hide-context-menu)
                     (f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :view}))}
        "Form View"]
       [:div.context-menu-item
        {:class (when (= (state-form/get-view-mode) :design) "active")
         :on-click (fn [e]
                     (.stopPropagation e)
                     (t/dispatch! :hide-context-menu)
                     (f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :design}))}
        "Design View"]])))

(defn- popup-view [current-def modal?]
  [:div.editor-body.view-mode
   [:div.popup-overlay
    {:class (when modal? "modal")
     :on-click #(t/dispatch! :hide-context-menu)}
    [:div.popup-window
     [:div.popup-title-bar
      {:on-context-menu (fn [e]
                          (.preventDefault e)
                          (.stopPropagation e)
                          (t/dispatch! :show-context-menu (.-clientX e) (.-clientY e)))}
      [:span.popup-title (or (:caption current-def) (:name current-def) "Form")]
      [:button.popup-close {:on-click #(f/run-fire-and-forget! nav/close-current-tab-flow)} "\u2715"]]
     [form-view/form-view]]
    [popup-context-menu]]])

(defn- form-editor-body [view-mode current-def]
  (if (= view-mode :view)
    (let [popup? (not= 0 (:popup current-def))
          modal? (and popup? (not= 0 (:modal current-def)))]
      (if popup?
        [popup-view current-def modal?]
        [:div.editor-body.view-mode
         [:div.editor-center [form-view/form-view]]]))
    (let [props-open? (:properties-panel-open? @state/app-state)]
      [:div.editor-body
       [:div.editor-center [form-design/form-canvas]]
       [:div.editor-right {:class (when-not props-open? "collapsed")}
        [:div.properties-header
         [:span.properties-header-title "Properties"]
         [:button.properties-toggle
          {:on-click #(t/dispatch! :toggle-properties-panel)}
          (if props-open? "\u00BB" "\u00AB")]]
        (when props-open?
          [:<>
           [form-properties/properties-panel]
           [form-design/field-list]])]])))

(defn form-editor
  "Main form editor component"
  []
  (let [active-tab (:active-tab @state/app-state)
        editing-form-id (get-in @state/app-state [:form-editor :form-id])
        view-mode (state-form/get-view-mode)]
    (when (and active-tab (= (:type active-tab) :forms))
      (let [form (first (filter #(= (:id %) (:id active-tab))
                                (get-in @state/app-state [:objects :forms])))]
        (when (and form (not= (:id form) editing-form-id))
          (f/run-fire-and-forget! (form-flow/load-form-for-editing-flow) {:form form})))
      [:div.form-editor
       [form-toolbar]
       (when (= view-mode :design) [palette/control-palette])
       [lint-errors-panel]
       [form-editor-body view-mode (get-in @state/app-state [:form-editor :current])]])))

(defn object-editor
  "Routes to the appropriate editor based on active tab type"
  []
  (let [active-tab (:active-tab @state/app-state)]
    (case (:type active-tab)
      :forms [form-editor]
      :reports [report-editor/report-editor]
      :tables [table-viewer/table-viewer]
      :queries [query-viewer/query-viewer]
      :sql-functions [sql-fn-viewer/sql-function-viewer]
      :modules [module-viewer/module-viewer]
      :macros [macro-viewer/macro-viewer]
      :app [app-viewer/app-viewer]
      [:div.no-editor
       [:p "Select an object to edit"]])))
