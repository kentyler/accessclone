(ns app.views.report-editor
  "Report editor/designer - replaces Access report design view"
  (:require [clojure.string]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.state-report :as state-report]
            [app.flows.core :as f]
            [app.flows.report :as report-flow]
            [app.flows.chat :as chat-flow]
            [app.views.report-properties :as report-properties]
            [app.views.report-design :as report-design]
            [app.views.report-view :as report-view]
            [app.views.control-palette :as palette]))

(defn ask-ai-to-fix-report-errors!
  "Send report lint errors to AI for suggestions"
  [errors]
  (let [error-text (str "My report has these validation errors:\n"
                        (clojure.string/join "\n" (map #(str "- " (:location %) ": " (:message %)) errors))
                        "\n\nHow can I fix these issues?")]
    (t/dispatch! :set-chat-input error-text)
    (f/run-fire-and-forget! chat-flow/send-chat-message-flow)))

(defn report-lint-errors-panel
  "Display report lint errors with Ask AI button"
  []
  (let [errors (get-in @state/app-state [:report-editor :lint-errors])]
    (when (seq errors)
      [:div.lint-errors-panel
       [:div.lint-errors-header
        [:span.lint-errors-title "Report Validation Errors"]
        [:button.lint-errors-close
         {:on-click #(t/dispatch! :clear-report-lint-errors)}
         "\u00D7"]]
       [:ul.lint-errors-list
        (for [[idx error] (map-indexed vector errors)]
          ^{:key idx}
          [:li.lint-error
           [:span.error-location (:location error)]
           [:span.error-message (:message error)]])]
       [:div.lint-errors-actions
        [:button.secondary-btn
         {:on-click #(ask-ai-to-fix-report-errors! errors)}
         "Ask AI to Help Fix"]
        [:button.secondary-btn
         {:on-click #(t/dispatch! :clear-report-lint-errors)}
         "Dismiss"]]])))

(defn report-toolbar
  "Toolbar with report actions"
  []
  (let [dirty? (get-in @state/app-state [:report-editor :dirty?])
        view-mode (state-report/get-report-view-mode)]
    [:div.form-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn
       {:class (when (= view-mode :design) "active")
        :title "Design View"
        :on-click #(f/run-fire-and-forget! (report-flow/set-report-view-mode-flow) {:mode :design})}
       "Design"]
      [:button.toolbar-btn
       {:class (when (= view-mode :preview) "active")
        :title "Preview"
        :on-click #(f/run-fire-and-forget! (report-flow/set-report-view-mode-flow) {:mode :preview})}
       "Preview"]
      (when (= view-mode :design)
        [:<>
         [:button.toolbar-btn
          {:title "Add Group Level"
           :on-click #(t/dispatch! :add-group-level)}
          "+ Group"]
         [:button.toolbar-btn
          {:title "Remove Group Level"
           :disabled (empty? (get-in @state/app-state [:report-editor :current :grouping]))
           :on-click #(t/dispatch! :remove-group-level)}
          "- Group"]])]
     [:div.toolbar-right
      [:button.secondary-btn
       {:disabled (not dirty?)
        :on-click #(let [original (get-in @state/app-state [:report-editor :original])]
                     (t/dispatch! :set-report-definition original))}
       "Undo"]
      [:button.primary-btn
       {:disabled (not dirty?)
        :on-click #(f/run-fire-and-forget! report-flow/save-report-flow)}
       "Save"]]]))

(defn report-editor
  "Main report editor component"
  []
  (let [active-tab (:active-tab @state/app-state)
        editing-report-id (get-in @state/app-state [:report-editor :report-id])
        view-mode (state-report/get-report-view-mode)]
    (when (and active-tab (= (:type active-tab) :reports))
      ;; Load report data when tab changes to a different report
      (let [report (first (filter #(= (:id %) (:id active-tab))
                                  (get-in @state/app-state [:objects :reports])))]
        (when (and report (not= (:id report) editing-report-id))
          (f/run-fire-and-forget! (report-flow/load-report-for-editing-flow) {:report report})))
      (let [current-def (get-in @state/app-state [:report-editor :current])
            is-edn? (= "edn" (:_format current-def))]
        [:div.form-editor
         [report-toolbar]
         (when (= view-mode :design) [palette/control-palette :report])
         [report-lint-errors-panel]
         (cond
           ;; EDN format - show raw
           is-edn?
           [:div.editor-body
            [:div.editor-center
             [:div.form-canvas
              [:div.canvas-header [:span "Report (EDN format - read only)"]]
              [:div.canvas-body
               [:pre {:style {:padding "1rem" :white-space "pre-wrap" :font-size "12px"}}
                (:_raw_edn current-def)]]]]]

           ;; Preview mode
           (= view-mode :preview)
           [:div.editor-body
            [:div.editor-center
             [report-view/report-preview]]]

           ;; Design mode
           :else
           (let [props-open? (:properties-panel-open? @state/app-state)]
             [:div.editor-body
              [:div.editor-center
               [report-design/report-canvas]]
              [:div.editor-right {:class (when-not props-open? "collapsed")}
               [:div.properties-header
                [:span.properties-header-title "Properties"]
                [:button.properties-toggle
                 {:on-click #(t/dispatch! :toggle-properties-panel)}
                 (if props-open? "\u00BB" "\u00AB")]]
               (when props-open?
                 [:<>
                  [report-properties/properties-panel]
                  [report-design/field-list]])]]))]))))
