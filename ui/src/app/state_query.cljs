(ns app.state-query
  "Query viewer state management"
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]
            [app.state :as state]))

(declare run-query!)

(defn set-query-view-mode!
  "Set query view mode - :results or :sql"
  [mode]
  (swap! state/app-state assoc-in [:query-viewer :view-mode] mode))

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
          :error nil})
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
            (println "Error running query:" (:body response))
            (state/log-event! "error" "Query execution failed" "run-query" {:response (:body response)})
            (swap! state/app-state assoc-in [:query-viewer :error]
                   (get-in response [:body :error] "Query failed"))))))))
