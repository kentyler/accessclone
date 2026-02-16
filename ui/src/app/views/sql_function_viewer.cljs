(ns app.views.sql-function-viewer
  "SQL Function viewer - display of PostgreSQL function source, editable for new functions"
  (:require [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.chat :as chat-flow]
            [clojure.string :as str]))

(defn- update-fn-source! [new-source]
  (t/dispatch! :update-fn-source new-source))

(defn- update-fn-name! [new-name]
  (t/dispatch! :update-fn-name new-name))

(defn- save-function-via-llm!
  "Send the current function SQL to the LLM, asking it to review and save via update_query tool"
  []
  (let [info (get-in @state/app-state [:sql-function-viewer :info])
        source (:source info)
        fn-name (:name info)]
    (when (and fn-name (not (str/blank? source)))
      ;; Open chat panel if closed
      (when-not (:chat-panel-open? @state/app-state)
        (t/dispatch! :open-chat-panel))
      ;; Set chat input with save instruction and send
      (t/dispatch! :set-chat-input
       (str "Please save this as a PostgreSQL function named \"" fn-name "\". "
            "Review the SQL for any issues, then use the update_query tool with ddl_type \"function\" to create it. "
            "Here is the SQL:\n\n" source))
      (f/run-fire-and-forget! chat-flow/send-chat-message-flow))))

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
          (t/dispatch! :track-sql-function func))
        (let [info (or (get-in @state/app-state [:sql-function-viewer :info]) func)
              is-new? (:is-new? info)]
          [:div.sql-function-viewer
           [:div.query-toolbar
            [:div.toolbar-left
             [:span.toolbar-label "SQL Function"]]
            (when is-new?
              [:div.toolbar-right
               [:button.secondary-btn
                {:on-click #(save-function-via-llm!)
                 :disabled (or (str/blank? (:source info))
                               (str/blank? (:name info)))}
                "Save"]])]
           [:div.module-info-panel
            [:div.info-row
             [:span.info-label "Name:"]
             (if is-new?
               [:input.info-input {:type "text"
                                   :value (or (:name info) "")
                                   :placeholder "function_name"
                                   :on-change #(update-fn-name! (.. % -target -value))}]
               [:span.info-value (:name info)])]
            (when (and (not is-new?) (:arguments info))
              [:div.info-row
               [:span.info-label "Arguments:"]
               [:span.info-value (:arguments info)]])
            (when (and (not is-new?) (:return-type info))
              [:div.info-row
               [:span.info-label "Returns:"]
               [:span.info-value (:return-type info)]])
            (when (and (not is-new?) (:description info))
              [:div.info-row
               [:span.info-label "Description:"]
               [:span.info-value (:description info)]])]
           [:div.module-vba-panel
            [:div.panel-header
             [:span "Function Definition"]]
            (if is-new?
              [:div.sql-editor-container
               [:textarea.sql-editor
                {:value (or (:source info) "")
                 :placeholder "CREATE OR REPLACE FUNCTION my_function()\nRETURNS void AS $$\nBEGIN\n  -- function body\nEND;\n$$ LANGUAGE plpgsql;"
                 :on-change #(update-fn-source! (.. % -target -value))}]]
              [:div.code-container
               [:pre.code-display
                [:code (:source info)]]])]])))))
