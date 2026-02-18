(ns app.flows.app
  "App Viewer flows — load overview, batch operations."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.transforms.core :as t]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; Gap Questions persistence helpers
;; ============================================================

(defn save-gap-questions!
  "Fire-and-forget: PUT current gap questions to the server."
  []
  (go
    (let [db-id (:database_id (:current-database @app-state))
          questions (get-in @app-state [:app-viewer :all-gap-questions])]
      (when db-id
        (<! (http/put (str api-base "/api/app/gap-questions")
                      {:json-params {:database_id db-id
                                     :questions (or questions [])}
                       :headers (db-headers)}))))))

(def load-gap-questions-flow
  "Load persisted gap questions from the server."
  [{:step :do
    :fn (fn [ctx]
          (go
            (let [db-id (:database_id (:current-database @app-state))
                  response (<! (http/get (str api-base "/api/app/gap-questions")
                                          {:query-params {:database_id db-id}
                                           :headers (db-headers)}))]
              (when (:success response)
                (let [questions (get-in response [:body :questions])]
                  (when (some? questions)
                    (t/dispatch! :set-all-gap-questions questions)))))
            ctx))}])

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
            (t/dispatch! :set-batch-extract-results nil)
            (let [db-id (:database_id (:current-database @app-state))
                  modules (get-in @app-state [:objects :modules])
                  total (count modules)]
              (t/dispatch! :set-batch-progress {:total total :completed 0 :current-module nil})
              (let [all-gaps (atom [])
                    completed (atom 0)
                    results (atom {:extracted [] :skipped [] :failed []})]
                (doseq [module modules]
                  (t/dispatch! :set-batch-progress {:total total
                                                    :completed @completed
                                                    :current-module (:name module)})
                  ;; Load module source
                  (let [mod-response (<! (http/get (str api-base "/api/modules/"
                                                       (js/encodeURIComponent (:name module)))
                                                  {:headers (db-headers)}))]
                    (if-not (and (:success mod-response)
                                 (:vba_source (:body mod-response)))
                      ;; No VBA source — skip
                      (swap! results update :skipped conj (:name module))
                      ;; Extract intents via LLM
                      (let [vba-source (:vba_source (:body mod-response))
                            extract-response (<! (http/post (str api-base "/api/chat/extract-intents")
                                                            {:json-params {:vba_source vba-source
                                                                           :module_name (:name module)
                                                                           :database_id db-id}
                                                             :headers (db-headers)}))]
                        (if (:success extract-response)
                          (let [body (:body extract-response)
                                intents-data {:intents (:intents body)
                                              :mapped (:mapped body)
                                              :stats (:stats body)}]
                            ;; Save intents to module
                            (<! (http/put (str api-base "/api/modules/"
                                              (js/encodeURIComponent (:name module)))
                                         {:json-params {:intents intents-data}
                                          :headers (db-headers)}))
                            (swap! results update :extracted conj (:name module))
                            ;; Collect gap questions with module attribution
                            (when (seq (:gap_questions body))
                              (doseq [gq (:gap_questions body)]
                                (swap! all-gaps conj
                                       (assoc gq :module (:name module))))))
                          ;; Extraction failed
                          (swap! results update :failed conj
                                 {:name (:name module)
                                  :error (get-in extract-response [:body :error] "Unknown error")})))))
                  (swap! completed inc))
                (t/dispatch! :set-batch-progress {:total total :completed total :current-module nil})
                (t/dispatch! :set-all-gap-questions (vec @all-gaps))
                (<! (save-gap-questions!))
                (t/dispatch! :set-batch-extract-results @results)
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
            (<! (save-gap-questions!))
            ctx))}])

;; ============================================================
;; LLM auto-resolve gaps
;; ============================================================

(def auto-resolve-gaps-flow
  "Send all gap questions to the LLM to pick the best option for each."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-auto-resolving-gaps true)
            (let [db-id (:database_id (:current-database @app-state))
                  gap-questions (get-in @app-state [:app-viewer :all-gap-questions] [])
                  ;; Convert to plain maps for JSON
                  gq-payload (mapv (fn [gq]
                                     {:module (:module gq)
                                      :procedure (:procedure gq)
                                      :vba_line (:vba_line gq)
                                      :question (:question gq)
                                      :suggestions (vec (:suggestions gq))})
                                   gap-questions)
                  response (<! (http/post (str api-base "/api/chat/auto-resolve-gaps")
                                          {:json-params {:gap_questions gq-payload
                                                         :database_id db-id}
                                           :headers (db-headers)}))]
              (if (:success response)
                (let [selections (get-in response [:body :selections] [])]
                  (t/dispatch! :set-all-gap-selections selections)
                  (<! (save-gap-questions!)))
                (state/log-error! "Auto-resolve failed" "auto-resolve-gaps-flow")))
            (t/dispatch! :set-auto-resolving-gaps false)
            ctx))}])

;; ============================================================
;; Batch code generation — multi-pass retry
;; ============================================================

(def batch-generate-code-flow
  "Batch generate code for all modules with multi-pass dependency retry."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-batch-generating true)
            (t/dispatch! :set-batch-gen-results nil)
            (let [db-id (:database_id (:current-database @app-state))
                  modules (get-in @app-state [:objects :modules])
                  ;; Phase 1: Load each module's intents + VBA source
                  module-data (atom [])]
              (doseq [module modules]
                (let [resp (<! (http/get (str api-base "/api/modules/"
                                              (js/encodeURIComponent (:name module)))
                                         {:headers (db-headers)}))]
                  (when (and (:success resp)
                             (:vba_source (:body resp))
                             (get-in resp [:body :intents :mapped]))
                    (swap! module-data conj
                           {:name (:name module)
                            :intents (:intents (:body resp))
                            :vba-source (:vba_source (:body resp))}))))

              ;; Phase 2: Multi-pass code generation
              (let [results (atom {:generated [] :skipped [] :failed []})
                    loaded-total (count @module-data)]
                (t/dispatch! :set-batch-gen-progress
                  {:total loaded-total :pass 0
                   :current-module nil
                   :generated 0})
                (loop [pass 1
                       pending @module-data]
                  (let [generated-this-pass (atom 0)
                        still-pending (atom [])]
                    (doseq [mod pending]
                      (t/dispatch! :set-batch-gen-progress
                        {:total loaded-total :pass pass
                         :current-module (:name mod)
                         :generated (count (:generated @results))})
                      (let [resp (<! (http/post
                                       (str api-base "/api/chat/generate-wiring")
                                       {:json-params {:mapped_intents (get-in mod [:intents :mapped])
                                                      :module_name (:name mod)
                                                      :vba_source (:vba-source mod)
                                                      :database_id db-id
                                                      :check_deps true}
                                        :headers (db-headers)}))]
                        (cond
                          ;; Skipped due to missing deps
                          (:skipped (:body resp))
                          (swap! still-pending conj mod)

                          ;; Success
                          (:success resp)
                          (do
                            ;; Save CLJS back to module
                            (<! (http/put
                                   (str api-base "/api/modules/"
                                        (js/encodeURIComponent (:name mod)))
                                   {:json-params {:cljs_source (:cljs_source (:body resp))}
                                    :headers (db-headers)}))
                            (swap! generated-this-pass inc)
                            (swap! results update :generated conj (:name mod)))

                          ;; Failed
                          :else
                          (swap! results update :failed conj
                                 {:name (:name mod)
                                  :error (get-in resp [:body :error])}))))
                    ;; Continue if progress + remaining (max 20 passes)
                    (if (and (seq @still-pending)
                             (pos? @generated-this-pass)
                             (< pass 20))
                      (recur (inc pass) @still-pending)
                      ;; Record any remaining as skipped
                      (swap! results assoc :skipped
                             (mapv :name @still-pending)))))
                (t/dispatch! :set-batch-gen-results @results)))
            (t/dispatch! :set-batch-generating false)
            ;; Refresh overview
            (let [db-id (:database_id (:current-database @app-state))
                  resp (<! (http/get (str api-base "/api/app/overview")
                                      {:query-params {:database_id db-id}
                                       :headers (db-headers)}))]
              (when (:success resp)
                (t/dispatch! :set-app-overview (:body resp))))
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

;; ============================================================
;; Per-module pipeline flows (via /api/pipeline)
;; ============================================================

(def load-pipeline-status-flow
  "Load pipeline status for all modules from GET /api/pipeline/status."
  [{:step :do
    :fn (fn [ctx]
          (go
            (let [db-id (:database_id (:current-database @app-state))
                  response (<! (http/get (str api-base "/api/pipeline/status")
                                         {:query-params {:database_id db-id}
                                          :headers (db-headers)}))]
              (when (:success response)
                (t/dispatch! :set-module-pipeline-statuses
                             (get-in response [:body :modules] []))))
            ctx))}])

(defn run-module-step!
  "Run a single pipeline step for one module. Updates per-module status.
   Returns a channel."
  [module-name step & [strategy]]
  (go
    (let [db-id (:database_id (:current-database @app-state))]
      (t/dispatch! :set-module-pipeline-status module-name
                   {:step step :status "running"})
      (let [response (<! (http/post (str api-base "/api/pipeline/step")
                                     {:json-params (cond-> {:module_name module-name
                                                            :step step
                                                            :database_id db-id}
                                                     strategy (assoc :strategy strategy))
                                      :headers (db-headers)}))]
        (if (:success response)
          (let [body (:body response)]
            (t/dispatch! :set-module-pipeline-status module-name
                         (:module_status body))
            body)
          (do
            (t/dispatch! :set-module-pipeline-status module-name
                         {:step step :status "failed"
                          :error (get-in response [:body :error] "Unknown error")})
            nil))))))

(defn run-module-pipeline!
  "Run the full pipeline for one module. Updates per-module status.
   Returns a channel."
  [module-name & [config]]
  (go
    (let [db-id (:database_id (:current-database @app-state))]
      (t/dispatch! :set-module-pipeline-status module-name
                   {:step "extract" :status "running"})
      (let [response (<! (http/post (str api-base "/api/pipeline/run")
                                     {:json-params {:module_name module-name
                                                    :config (or config {})
                                                    :database_id db-id}
                                      :headers (db-headers)}))]
        (if (:success response)
          (let [body (:body response)]
            (t/dispatch! :set-module-pipeline-status module-name
                         (or (:moduleStatus body) (:module_status body)))
            body)
          (do
            (t/dispatch! :set-module-pipeline-status module-name
                         {:step "failed" :status "failed"
                          :error (get-in response [:body :error] "Unknown error")})
            nil))))))

(def batch-pipeline-flow
  "Run full pipeline for all modules sequentially via /api/pipeline/run.
   Updates per-module status as each module completes."
  [{:step :do
    :fn (fn [ctx]
          (go
            (t/dispatch! :set-pipeline-running true)
            (t/dispatch! :set-batch-gen-results nil)
            (t/dispatch! :set-batch-extract-results nil)
            (let [db-id (:database_id (:current-database @app-state))
                  modules (get-in @app-state [:objects :modules])
                  total (count modules)
                  results (atom {:generated [] :skipped [] :failed []})
                  completed (atom 0)]
              (t/dispatch! :set-batch-progress {:total total :completed 0 :current-module nil})
              ;; First pass: run pipeline for each module
              (let [pending (atom [])]
                (doseq [module modules]
                  (t/dispatch! :set-batch-progress
                    {:total total :completed @completed :current-module (:name module)})
                  (let [body (<! (run-module-pipeline! (:name module)
                                   {"gap-questions" "skip"
                                    "resolve-gaps" "skip"}))]
                    (cond
                      (nil? body)
                      (swap! results update :failed conj
                             {:name (:name module)
                              :error (get-in @app-state [:app-viewer :module-pipeline (:name module) :error] "Unknown error")})

                      (= "failed" (:status body))
                      (swap! results update :failed conj
                             {:name (:name module) :error (or (:error body) "Pipeline failed")})

                      :else
                      (swap! results update :generated conj (:name module))))
                  (swap! completed inc))
                (t/dispatch! :set-batch-progress {:total total :completed total :current-module nil})
                (t/dispatch! :set-batch-gen-results @results)))
            (t/dispatch! :set-pipeline-running false)
            ;; Refresh overview + pipeline status
            (let [db-id (:database_id (:current-database @app-state))
                  resp (<! (http/get (str api-base "/api/app/overview")
                                      {:query-params {:database_id db-id}
                                       :headers (db-headers)}))]
              (when (:success resp)
                (t/dispatch! :set-app-overview (:body resp))))
            ctx))}])
