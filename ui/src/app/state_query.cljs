(ns app.state-query
  "Query viewer state management"
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]
            [app.state :as state]))

(declare run-query!)

(defn set-query-view-mode!
  "Set query view mode - :results, :sql, or :design"
  [mode]
  (swap! state/app-state assoc-in [:query-viewer :view-mode] mode)
  (when (= mode :design)
    ;; Load design data if not already loaded for this query
    (let [query-info (get-in @state/app-state [:query-viewer :query-info])
          design-data (get-in @state/app-state [:query-viewer :design-data])]
      (when (and query-info (nil? design-data))
        (load-query-design! (:name query-info))))))

(defn load-query-design!
  "Fetch parsed query design from the server"
  [query-name]
  (swap! state/app-state assoc-in [:query-viewer :design-loading?] true)
  (go
    (let [response (<! (http/get (str state/api-base "/api/queries/"
                                      (js/encodeURIComponent query-name) "/design")
                                 {:headers (state/db-headers)}))]
      (swap! state/app-state assoc-in [:query-viewer :design-loading?] false)
      (if (:success response)
        (let [data (:body response)]
          (swap! state/app-state assoc-in [:query-viewer :design-data] data)
          ;; If not parseable, switch to SQL view
          (when (not (:parseable data))
            (swap! state/app-state assoc-in [:query-viewer :view-mode] :sql)))
        (do
          (state/log-event! "error" "Failed to load query design" "load-query-design"
                            {:response (:body response)})
          ;; Fall back to SQL view on error
          (swap! state/app-state assoc-in [:query-viewer :view-mode] :sql))))))

(defn load-query-for-viewing!
  "Load a query for viewing"
  [query]
  (swap! state/app-state assoc :query-viewer
         {:query-id (:id query)
          :query-info query
          :sql (or (:sql query) "")
          :results []
          :result-fields []
          :view-mode :results
          :loading? true
          :error nil
          :design-data nil
          :design-loading? false})
  ;; Trigger auto-analyze if pending (query-info is set synchronously above)
  (state/maybe-auto-analyze!)
  ;; Run the query to get results
  (run-query!))

(defn update-query-sql!
  "Update the SQL in the editor"
  [sql]
  (swap! state/app-state assoc-in [:query-viewer :sql] sql))

(defn run-query!
  "Execute the current SQL and fetch results"
  []
  (let [query-info (get-in @state/app-state [:query-viewer :query-info])
        sql (get-in @state/app-state [:query-viewer :sql])
        ;; If no custom SQL, select from the view
        effective-sql (if (str/blank? sql)
                        (str "SELECT * FROM " (:name query-info) " LIMIT 1000")
                        sql)]
    (swap! state/app-state assoc-in [:query-viewer :loading?] true)
    (swap! state/app-state assoc-in [:query-viewer :error] nil)
    (go
      (let [response (<! (http/post (str state/api-base "/api/queries/run")
                                    {:json-params {:sql effective-sql}
                                     :headers (state/db-headers)}))]
        (swap! state/app-state assoc-in [:query-viewer :loading?] false)
        (if (:success response)
          (let [data (get-in response [:body :data] [])
                fields (get-in response [:body :fields] [])]
            (swap! state/app-state assoc-in [:query-viewer :results] (vec data))
            (swap! state/app-state assoc-in [:query-viewer :result-fields] (vec fields)))
          (do
            (state/log-event! "error" "Query execution failed" "run-query" {:response (:body response)})
            (swap! state/app-state assoc-in [:query-viewer :error]
                   (get-in response [:body :error] "Query failed"))))))))

;; ============================================================
;; QUERY CREATION & SAVE VIA LLM
;; ============================================================

(defn update-query-name!
  "Set the pending name for a new query"
  [name]
  (swap! state/app-state assoc-in [:query-viewer :pending-name] name))

(defn create-new-query!
  "Create a placeholder new query and open it in SQL view"
  []
  (let [existing-queries (get-in @state/app-state [:objects :queries])
        new-id (inc (reduce max 0 (map :id existing-queries)))
        new-query {:id new-id
                   :name (str "new_query_" new-id)
                   :is-new? true
                   :sql ""
                   :fields []}]
    (state/add-object! :queries new-query)
    (state/open-object! :queries new-id)
    ;; Switch to SQL view for editing
    (swap! state/app-state assoc-in [:query-viewer :view-mode] :sql)
    (swap! state/app-state assoc-in [:query-viewer :pending-name] (:name new-query))))

(defn save-query-via-llm!
  "Send the current SQL to the LLM, asking it to review and save via update_query tool"
  []
  (let [query-info (get-in @state/app-state [:query-viewer :query-info])
        sql (get-in @state/app-state [:query-viewer :sql])
        pending-name (get-in @state/app-state [:query-viewer :pending-name])
        query-name (or pending-name (:name query-info))]
    (when (and query-name (not (str/blank? sql)))
      ;; Update query-info name if we have a pending name
      (when pending-name
        (swap! state/app-state assoc-in [:query-viewer :query-info :name] pending-name))
      ;; Open chat panel if closed
      (when-not (:chat-panel-open? @state/app-state)
        (swap! state/app-state assoc :chat-panel-open? true))
      ;; Set chat input with save instruction and send
      (state/set-chat-input!
       (str "Please save this as a view named \"" query-name "\". "
            "Review the SQL for any issues, then use the update_query tool to create it. "
            "Here is the SQL:\n\n" sql))
      (state/send-chat-message!))))
