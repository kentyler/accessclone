(ns app.flows.app
  "App Viewer flows — load overview, batch operations."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.transforms.core :as t]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; Phase 1: Load overview
;; ============================================================

(def load-app-overview-flow
  "Load app overview data from server."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-app-loading true)
            (let [db-id (:database_id (:current-database @app-state))
                  response (<! (http/get (str api-base "/api/app/overview")
                                         {:query-params {:database_id db-id}
                                          :headers (db-headers)}))]
              (t/dispatch! :set-app-loading false)
              (if (:success response)
                (t/dispatch! :set-app-overview (:body response))
                (state/log-error! "Failed to load app overview" "load-app-overview"))
              ctx)))}])

;; ============================================================
;; Phase 4: Batch extraction (stub — implemented in Phase 4)
;; ============================================================

(def batch-extract-intents-flow
  "Batch extract intents from all modules."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-batch-extracting true)
            (let [db-id (:database_id (:current-database @app-state))
                  modules (get-in @app-state [:objects :modules])
                  total (count modules)]
              (t/dispatch! :set-batch-progress {:total total :completed 0 :current-module nil})
              (let [all-gaps (atom [])
                    completed (atom 0)]
                (doseq [module modules]
                  (t/dispatch! :set-batch-progress {:total total
                                                    :completed @completed
                                                    :current-module (:name module)})
                  ;; Load module source
                  (let [mod-response (<! (http/get (str api-base "/api/modules/"
                                                       (js/encodeURIComponent (:name module)))
                                                  {:headers (db-headers)}))]
                    (when (and (:success mod-response)
                               (:vba_source (:body mod-response)))
                      (let [vba-source (:vba_source (:body mod-response))
                            extract-response (<! (http/post (str api-base "/api/chat/extract-intents")
                                                            {:json-params {:vba_source vba-source
                                                                           :module_name (:name module)
                                                                           :database_id db-id}
                                                             :headers (db-headers)}))]
                        (when (:success extract-response)
                          (let [body (:body extract-response)
                                intents-data {:intents (:intents body)
                                              :mapped (:mapped body)
                                              :stats (:stats body)}]
                            ;; Save intents to module
                            (<! (http/put (str api-base "/api/modules/"
                                              (js/encodeURIComponent (:name module)))
                                         {:json-params {:intents intents-data}
                                          :headers (db-headers)}))
                            ;; Collect gap questions with module attribution
                            (when (seq (:gap_questions body))
                              (doseq [gq (:gap_questions body)]
                                (swap! all-gaps conj
                                       (assoc gq :module (:name module))))))))))
                  (swap! completed inc))
                (t/dispatch! :set-batch-progress {:total total :completed total :current-module nil})
                (t/dispatch! :set-all-gap-questions (vec @all-gaps))
                (t/dispatch! :set-batch-extracting false)
                ;; Refresh overview
                (let [db-id (:database_id (:current-database @app-state))
                      response (<! (http/get (str api-base "/api/app/overview")
                                             {:query-params {:database_id db-id}
                                              :headers (db-headers)}))]
                  (when (:success response)
                    (t/dispatch! :set-app-overview (:body response))))))
            ctx))}])

(def submit-all-gap-decisions-flow
  "Submit all gap decisions from the app viewer."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-submitting-gaps true)
            (let [db-id (:database_id (:current-database @app-state))
                  gap-questions (get-in @app-state [:app-viewer :all-gap-questions])]
              (doseq [gq gap-questions]
                (when (:selected gq)
                  (<! (http/post (str api-base "/api/chat/resolve-gap")
                                {:json-params {:module_name (:module gq)
                                               :gap_id (:gap_id gq)
                                               :answer (:selected gq)
                                               :database_id db-id}
                                 :headers (db-headers)})))))
            (t/dispatch! :set-submitting-gaps false)
            (t/dispatch! :set-all-gap-questions [])
            ctx))}])

;; ============================================================
;; Phase 5: Dependencies + API Surface (stubs)
;; ============================================================

(def load-app-dependencies-flow
  "Load dependency summary from server."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-app-loading true)
            (let [db-id (:database_id (:current-database @app-state))
                  response (<! (http/get (str api-base "/api/app/dependency-summary")
                                         {:query-params {:database_id db-id}
                                          :headers (db-headers)}))]
              (t/dispatch! :set-app-loading false)
              (when (:success response)
                (t/dispatch! :set-app-dependencies (:body response))))
            ctx))}])

(def load-app-api-surface-flow
  "Load API surface analysis from server."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-app-loading true)
            (let [db-id (:database_id (:current-database @app-state))
                  response (<! (http/get (str api-base "/api/app/api-surface")
                                         {:query-params {:database_id db-id}
                                          :headers (db-headers)}))]
              (t/dispatch! :set-app-loading false)
              (when (:success response)
                (t/dispatch! :set-app-api-surface (:body response))))
            ctx))}])
