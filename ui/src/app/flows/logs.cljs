(ns app.flows.logs
  "Logs flows — import history, issues, toggle resolved.

   Decomposes async functions from state.cljs into transform+effect sequences."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; LOAD LOG ENTRIES
;; ============================================================

(def load-log-entries-flow
  "GET /api/access-import/history → set logs-entries.
   Original: state.cljs/load-log-entries!"
  [{:step :do
    :fn (fn [ctx]
          (let [db-id (:database_id (:current-database @app-state))]
            (when db-id
              (swap! app-state assoc :logs-loading? true))
            (assoc ctx :db-id db-id)))}
   {:step :branch
    :test (fn [ctx] (:db-id ctx))
    :then [{:step :effect
            :name :fetch-import-history
            :opts-fn (fn [ctx] {:query-params {:target_database_id (:db-id ctx) :limit 200}})
            :as :response}
           {:step :do
            :fn (fn [ctx]
                  (swap! app-state assoc :logs-loading? false)
                  (if (get-in ctx [:response :ok?])
                    (swap! app-state assoc :logs-entries
                           (get-in ctx [:response :data :history] []))
                    (state/log-error! "Failed to load import history" "load-log-entries"))
                  ctx)}]}])

;; ============================================================
;; LOAD ISSUES
;; ============================================================

(defn load-issues-flow
  "GET /api/import-issues → set logs-issues.
   Original: state.cljs/load-issues-for-entry! and load-all-issues!

   Context requires: {:entry optional-entry :db-id string}"
  []
  [{:step :do
    :fn (fn [ctx]
          (let [db-id (or (:db-id ctx) (:database_id (:current-database @app-state)))]
            (swap! app-state assoc :logs-loading? true)
            (assoc ctx :db-id db-id)))}
   {:step :effect
    :name :fetch-import-issues
    :opts-fn (fn [ctx]
               {:query-params (cond-> {:database_id (:db-id ctx)}
                                (:entry ctx) (assoc :import_log_id (:id (:entry ctx))))})
    :as :response}
   {:step :do
    :fn (fn [ctx]
          (swap! app-state assoc :logs-loading? false)
          (if (get-in ctx [:response :ok?])
            (swap! app-state assoc :logs-issues
                   (get-in ctx [:response :data :issues] []))
            (state/log-error! "Failed to load issues" "load-issues"))
          ctx)}])

;; ============================================================
;; TOGGLE ISSUE RESOLVED
;; ============================================================

(defn toggle-issue-resolved-flow
  "PATCH /api/import-issues/:id → refresh issues and entries.
   Original: state.cljs/toggle-issue-resolved!

   Context requires: {:issue-id number :currently-resolved? boolean}"
  []
  [{:step :do
    :fn (fn [ctx]
          (go
            (let [response (<! (http/patch!
                                 (str api-base "/api/import-issues/" (:issue-id ctx))
                                 :headers (db-headers)
                                 :json-params {:resolved (not (:currently-resolved? ctx))}))]
              (if (:ok? response)
                (let [entry (:logs-selected-entry @app-state)]
                  (if entry
                    (state/load-issues-for-entry! entry)
                    (state/load-all-issues!))
                  (state/load-log-entries!))
                (state/log-error! "Failed to update issue" "toggle-issue-resolved"))
              ctx)))}])
