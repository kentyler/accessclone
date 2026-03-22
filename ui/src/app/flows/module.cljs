(ns app.flows.module
  "Module and macro flows — load, save, translate.

   Decomposes async functions from state.cljs into transform+effect sequences."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [clojure.string :as str]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; MODULE LOAD
;; ============================================================

(defn load-module-for-viewing-flow
  "Initialize viewer → fetch full source → auto-analyze.
   Original: state.cljs/load-module-for-viewing!

   Context requires: {:module {:id :name}}"
  []
  [{:step :do
    :fn (fn [ctx]
          (let [module (:module ctx)]
            (swap! app-state assoc :module-viewer
                   {:module-id (:id module) :module-info module :loading? true})
            (state/load-import-completeness!)
            ctx))}
   {:step :do
    :fn (fn [ctx]
          (go
            (let [response (<! (http/get!
                                 (str api-base "/api/modules/"
                                      (js/encodeURIComponent (get-in ctx [:module :name])))
                                 :headers (db-headers)))]
              (if (:ok? response)
                (let [data (:data response)
                      module (:module ctx)]
                  (swap! app-state assoc :module-viewer
                         {:module-id (:id module)
                          :module-info (merge module
                                              {:vba-source (:vba_source data)
                                               :description (:description data)
                                               :status (or (:status data) "pending")
                                               :review-notes (:review_notes data)
                                               :version (:version data)
                                               :created-at (:created_at data)})
                          :intents (:intents data)
                          :js-handlers (:js_handlers data)
                          :loading? false})
                  (state/maybe-auto-analyze!))
                (swap! app-state assoc-in [:module-viewer :loading?] false))
              ctx)))}])

;; ============================================================
;; INTENT EXTRACTION
;; ============================================================

(def extract-intents-flow
  "POST /api/chat/extract-intents → store intents in state → add summary to chat.
   Extracts structured intents from VBA source using LLM."
  [{:step :do
    :fn (fn [ctx]
          (let [module-info (get-in @app-state [:module-viewer :module-info])]
            (t/dispatch! :set-extracting-intents true)
            (when-not (:chat-panel-open? @app-state)
              (t/dispatch! :toggle-chat-panel))
            (assoc ctx :module-info module-info)))}
   {:step :do
    :fn (fn [ctx]
          (let [mi (:module-info ctx)]
            (go
              (let [response (<! (http/post!
                                   (str api-base "/api/chat/extract-intents")
                                   :headers (db-headers)
                                   :json-params {:vba_source (:vba-source mi)
                                                 :module_name (:name mi)
                                                 :app_objects (state/get-app-objects)
                                                 :database_id (:database_id (:current-database @app-state))}))]
                (t/dispatch! :set-extracting-intents false)
                (if (:ok? response)
                  (let [data (:data response)
                        intents (:intents data)
                        mapped (:mapped data)
                        stats (:stats data)
                        gap-questions (:gap_questions data)]
                    (t/dispatch! :set-module-intents {:intents intents :mapped mapped :stats stats})
                    ;; Store gap questions for interactive widget
                    (when (seq gap-questions)
                      (t/dispatch! :set-gap-questions gap-questions))
                    ;; Add summary to chat
                    (t/dispatch! :add-chat-message "assistant"
                                 (str "Extracted " (:total stats) " intents from "
                                      (count (:procedures intents)) " procedures:\n"
                                      "- " (:mechanical stats) " mechanical (deterministic)\n"
                                      "- " (:llm_fallback stats) " need LLM assistance\n"
                                      "- " (:gap stats) " gaps (unmappable)"
                                      (when (pos? (:gap stats 0))
                                        "\n\nPlease review the gap decisions below."))))
                  (let [missing (get-in response [:data :missing])
                        error-msg (get-in response [:data :error] "Unknown error")]
                    (if missing
                      (let [parts (keep (fn [[type-key names]]
                                          (when (seq names)
                                            (str (name type-key) ": " (str/join ", " names))))
                                        missing)]
                        (state/set-error! (str "Intent extraction blocked — import these objects first: "
                                               (str/join "; " parts))))
                      (state/log-error! (str "Intent extraction failed: " error-msg) "extract-intents"))))
                ctx))))}])

;; ============================================================
;; GAP RESOLUTION
;; ============================================================

(def resolve-gap-flow
  "POST /api/chat/resolve-gap → update intents in state.
   Context requires: {:gap-id string, :answer string, :custom-notes string?}"
  [{:step :do
    :fn (fn [ctx]
          (let [module-info (get-in @app-state [:module-viewer :module-info])]
            (assoc ctx :module-info module-info)))}
   {:step :do
    :fn (fn [ctx]
          (let [mi (:module-info ctx)]
            (go
              (let [response (<! (http/post!
                                   (str api-base "/api/chat/resolve-gap")
                                   :headers (db-headers)
                                   :json-params {:module_name (:name mi)
                                                 :gap_id (:gap-id ctx)
                                                 :answer (:answer ctx)
                                                 :custom_notes (:custom-notes ctx)
                                                 :database_id (:database_id (:current-database @app-state))}))]
                (if (:ok? response)
                  (let [updated-intents (get-in response [:data :updated_intents])]
                    (t/dispatch! :set-module-intents updated-intents))
                  (state/log-error! (str "Gap resolution failed: "
                                         (get-in response [:data :error] "Unknown error"))
                                    "resolve-gap")))
              ctx)))}])

;; ============================================================
;; GAP DECISIONS SUBMIT
;; ============================================================

(def submit-gap-decisions-flow
  "Resolve all selected gap decisions via POST /api/chat/resolve-gap for each.
   Reads gap-questions from state, submits each selection, clears gap-questions when done."
  [{:step :do
    :fn (fn [ctx]
          (let [module-info (get-in @app-state [:module-viewer :module-info])
                gap-questions (get-in @app-state [:module-viewer :gap-questions])]
            (swap! app-state assoc-in [:module-viewer :submitting-gaps?] true)
            (assoc ctx :module-info module-info :gap-questions gap-questions)))}
   {:step :do
    :fn (fn [ctx]
          (let [mi (:module-info ctx)
                gqs (filter :selected (:gap-questions ctx))]
            (go
              (doseq [gq gqs]
                (let [response (<! (http/post!
                                     (str api-base "/api/chat/resolve-gap")
                                     :headers (db-headers)
                                     :json-params {:module_name (:name mi)
                                                   :gap_id (:gap_id gq)
                                                   :answer (:selected gq)
                                                   :database_id (:database_id (:current-database @app-state))}))]
                  (when (:ok? response)
                    (let [updated-intents (get-in response [:data :updated_intents])]
                      (t/dispatch! :set-module-intents updated-intents)))))
              (swap! app-state assoc-in [:module-viewer :submitting-gaps?] false)
              (swap! app-state assoc-in [:module-viewer :gap-questions] nil)
              (t/dispatch! :add-chat-message "assistant" "Gap decisions saved.")
              ctx)))}])

;; ============================================================
;; MACRO LOAD
;; ============================================================

(defn load-macro-for-viewing-flow
  "Initialize viewer → fetch full XML → auto-analyze.
   Original: state.cljs/load-macro-for-viewing!

   Context requires: {:macro {:id :name}}"
  []
  [{:step :do
    :fn (fn [ctx]
          (let [macro (:macro ctx)]
            (swap! app-state assoc :macro-viewer
                   {:macro-id (:id macro) :macro-info macro :loading? true})
            (state/load-import-completeness!)
            ctx))}
   {:step :do
    :fn (fn [ctx]
          (go
            (let [response (<! (http/get!
                                 (str api-base "/api/macros/"
                                      (js/encodeURIComponent (get-in ctx [:macro :name])))
                                 :headers (db-headers)))]
              (if (:ok? response)
                (let [data (:data response)
                      macro (:macro ctx)]
                  (swap! app-state assoc :macro-viewer
                         {:macro-id (:id macro)
                          :macro-info (merge macro
                                             {:macro-xml (:macro_xml data)
                                              :description (:description data)
                                              :status (or (:status data) "pending")
                                              :review-notes (:review_notes data)
                                              :version (:version data)
                                              :created-at (:created_at data)})
                          :loading? false})
                  (state/maybe-auto-analyze!))
                (swap! app-state assoc-in [:macro-viewer :loading?] false))
              ctx)))}])

;; ============================================================
;; STATUS UPDATES
;; ============================================================

(def save-module-status-flow
  "Set module translation status.
   Original: state.cljs/set-module-status!

   Context requires: {:status string}"
  [{:step :do
    :fn (fn [ctx]
          (state/set-module-status! (:status ctx))
          ctx)}])

(def save-macro-status-flow
  "Set macro translation status.

   Context requires: {:status string}"
  [{:step :do
    :fn (fn [ctx]
          (t/dispatch! :set-macro-status (:status ctx))
          ctx)}])
