(ns app.views.report-editor
  "Report editor/designer - replaces Access report design view"
  (:require [app.state :as state]
            [app.views.report-properties :as report-properties]
            [app.views.report-design :as report-design]
            [app.views.report-view :as report-view]))

(defn report-toolbar
  "Toolbar with report actions"
  []
  (let [dirty? (get-in @state/app-state [:report-editor :dirty?])
        view-mode (state/get-report-view-mode)]
    [:div.form-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn
       {:class (when (= view-mode :design) "active")
        :title "Design View"
        :on-click #(state/set-report-view-mode! :design)}
       "Design"]
      [:button.toolbar-btn
       {:class (when (= view-mode :preview) "active")
        :title "Preview"
        :on-click #(state/set-report-view-mode! :preview)}
       "Preview"]]
     [:div.toolbar-right
      [:button.secondary-btn
       {:disabled (not dirty?)
        :on-click #(let [original (get-in @state/app-state [:report-editor :original])]
                     (state/set-report-definition! original))}
       "Undo"]
      [:button.primary-btn
       {:disabled (not dirty?)
        :on-click state/save-report!}
       "Save"]]]))

(defn report-editor
  "Main report editor component"
  []
  (let [active-tab (:active-tab @state/app-state)
        editing-report-id (get-in @state/app-state [:report-editor :report-id])
        view-mode (state/get-report-view-mode)]
    (when (and active-tab (= (:type active-tab) :reports))
      ;; Load report data when tab changes to a different report
      (let [report (first (filter #(= (:id %) (:id active-tab))
                                  (get-in @state/app-state [:objects :reports])))]
        (when (and report (not= (:id report) editing-report-id))
          (state/load-report-for-editing! report)))
      (let [current-def (get-in @state/app-state [:report-editor :current])
            is-edn? (= "edn" (:_format current-def))]
        [:div.form-editor
         [report-toolbar]
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
           [:div.editor-body
            [:div.editor-center
             [report-design/report-canvas]]
            [:div.editor-right
             [report-properties/properties-panel]
             [report-design/field-list]]])]))))
