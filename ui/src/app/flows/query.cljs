(ns app.flows.query
  "Query flows — load, run, design.

   Decomposes async functions from state_query.cljs into transform+effect sequences."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [clojure.string :as str]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; QUERY LOAD
;; ============================================================

(defn load-query-for-viewing-flow
  "Setup viewer state → run query.
   Original: state_query.cljs/load-query-for-viewing!

   Context requires: {:query {:id :name :sql :fields}}"
  []
  [{:step :do
    :fn (fn [ctx]
          (let [query (:query ctx)]
            (swap! app-state assoc :query-viewer
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
            (state/maybe-auto-analyze!)
            ctx))}
   ;; Run the query
   {:step :do
    :fn (fn [ctx]
          (let [query-info (get-in @app-state [:query-viewer :query-info])
                sql (get-in @app-state [:query-viewer :sql])
                effective-sql (if (str/blank? sql)
                                (str "SELECT * FROM " (:name query-info) " LIMIT 1000")
                                sql)]
            (assoc ctx :effective-sql effective-sql)))}
   {:step :effect
    :name :run-query
    :opts-fn (fn [ctx] {:headers (db-headers) :json-params {:sql (:effective-sql ctx)}})
    :as :query-response}
   {:step :do
    :fn (fn [ctx]
          (swap! app-state assoc-in [:query-viewer :loading?] false)
          (if (get-in ctx [:query-response :ok?])
            (do
              (swap! app-state assoc-in [:query-viewer :results]
                     (vec (get-in ctx [:query-response :data :data] [])))
              (swap! app-state assoc-in [:query-viewer :result-fields]
                     (vec (get-in ctx [:query-response :data :fields] []))))
            (do
              (state/log-event! "error" "Query execution failed" "run-query")
              (swap! app-state assoc-in [:query-viewer :error]
                     (get-in ctx [:query-response :data :error] "Query failed"))))
          ctx)}])

;; ============================================================
;; RUN QUERY
;; ============================================================

(def run-query-flow
  "Execute current SQL and update results.
   Original: state_query.cljs/run-query!"
  [{:step :do
    :fn (fn [ctx]
          (let [query-info (get-in @app-state [:query-viewer :query-info])
                sql (get-in @app-state [:query-viewer :sql])
                effective-sql (if (str/blank? sql)
                                (str "SELECT * FROM " (:name query-info) " LIMIT 1000")
                                sql)]
            (swap! app-state assoc-in [:query-viewer :loading?] true)
            (swap! app-state assoc-in [:query-viewer :error] nil)
            (assoc ctx :effective-sql effective-sql)))}
   {:step :effect
    :name :run-query
    :opts-fn (fn [ctx] {:headers (db-headers) :json-params {:sql (:effective-sql ctx)}})
    :as :query-response}
   {:step :do
    :fn (fn [ctx]
          (swap! app-state assoc-in [:query-viewer :loading?] false)
          (if (get-in ctx [:query-response :ok?])
            (do
              (swap! app-state assoc-in [:query-viewer :results]
                     (vec (get-in ctx [:query-response :data :data] [])))
              (swap! app-state assoc-in [:query-viewer :result-fields]
                     (vec (get-in ctx [:query-response :data :fields] []))))
            (do
              (state/log-event! "error" "Query execution failed" "run-query")
              (swap! app-state assoc-in [:query-viewer :error]
                     (get-in ctx [:query-response :data :error] "Query failed"))))
          ctx)}])
