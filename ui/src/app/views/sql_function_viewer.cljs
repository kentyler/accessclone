(ns app.views.sql-function-viewer
  "SQL Function viewer - read-only display of PostgreSQL function source"
  (:require [app.state :as state]))

(defn sql-function-viewer
  "Main SQL function viewer component"
  []
  (let [active-tab (:active-tab @state/app-state)
        current-id (get-in @state/app-state [:sql-function-viewer :fn-id])]
    (when (and active-tab (= (:type active-tab) :sql-functions))
      (let [func (first (filter #(= (:id %) (:id active-tab))
                                (get-in @state/app-state [:objects :sql-functions])))]
        ;; Track which function is loaded
        (when (and func (not= (:id func) current-id))
          (swap! state/app-state assoc :sql-function-viewer {:fn-id (:id func) :info func}))
        (let [info (or (get-in @state/app-state [:sql-function-viewer :info]) func)]
          [:div.sql-function-viewer
           [:div.query-toolbar
            [:div.toolbar-left
             [:span.toolbar-label "SQL Function"]]]
           [:div.module-info-panel
            [:div.info-row
             [:span.info-label "Name:"]
             [:span.info-value (:name info)]]
            (when (:arguments info)
              [:div.info-row
               [:span.info-label "Arguments:"]
               [:span.info-value (:arguments info)]])
            (when (:return-type info)
              [:div.info-row
               [:span.info-label "Returns:"]
               [:span.info-value (:return-type info)]])
            (when (:description info)
              [:div.info-row
               [:span.info-label "Description:"]
               [:span.info-value (:description info)]])]
           [:div.module-vba-panel
            [:div.panel-header
             [:span "Function Definition"]]
            [:div.code-container
             [:pre.code-display
              [:code (:source info)]]]]])))))
