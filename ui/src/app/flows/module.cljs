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
                                               :cljs-source (:cljs_source data)
                                               :description (:description data)
                                               :status (or (:status data) "pending")
                                               :review-notes (:review_notes data)
                                               :version (:version data)
                                               :created-at (:created_at data)})
                          :intents (:intents data)
                          :loading? false})
                  (state/maybe-auto-analyze!))
                (swap! app-state assoc-in [:module-viewer :loading?] false))
              ctx)))}])

;; ============================================================
;; MODULE SAVE
;; ============================================================

(def save-module-cljs-flow
  "PUT /api/modules/:name — save ClojureScript translation.
   Original: state.cljs/save-module-cljs!"
  [{:step :do
    :fn (fn [ctx]
          (let [module-info (get-in @app-state [:module-viewer :module-info])]
            (assoc ctx :module-info module-info)))}
   {:step :branch
    :test (fn [ctx] (and (:name (:module-info ctx)) (:cljs-source (:module-info ctx))))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [mi (:module-info ctx)]
                    (go
                      (let [response (<! (http/put!
                                           (str api-base "/api/modules/"
                                                (js/encodeURIComponent (:name mi)))
                                           :headers (db-headers)
                                           :json-params {:vba_source (:vba-source mi)
                                                         :cljs_source (:cljs-source mi)
                                                         :status (:status mi)
                                                         :review_notes (:review-notes mi)}))]
                        (if (:ok? response)
                          (do
                            (swap! app-state assoc-in [:module-viewer :cljs-dirty?] false)
                            (swap! app-state assoc-in [:module-viewer :module-info :version]
                                   (get-in response [:data :version])))
                          (state/log-error! "Failed to save module translation" "save-module-cljs"))
                        ctx))))}]}])

;; ============================================================
;; MODULE TRANSLATE
;; ============================================================

(def translate-module-flow
  "POST /api/chat/translate → store translation → send to chat for review.
   Original: state.cljs/translate-module!

   Sequence: set-translating → POST translate → store-cljs → add-to-chat → auto-review"
  [{:step :do
    :fn (fn [ctx]
          (let [module-info (get-in @app-state [:module-viewer :module-info])]
            (swap! app-state assoc-in [:module-viewer :translating?] true)
            (when-not (:chat-panel-open? @app-state)
              (t/dispatch! :toggle-chat-panel))
            (assoc ctx :module-info module-info)))}
   {:step :do
    :fn (fn [ctx]
          (let [mi (:module-info ctx)]
            (go
              (let [response (<! (http/post!
                                   (str api-base "/api/chat/translate")
                                   :headers (db-headers)
                                   :json-params {:vba_source (:vba-source mi)
                                                 :module_name (:name mi)
                                                 :app_objects (state/get-app-objects)
                                                 :database_id (:database_id (:current-database @app-state))}))]
                (swap! app-state assoc-in [:module-viewer :translating?] false)
                (if (:ok? response)
                  (let [cljs-source (get-in response [:data :cljs_source])]
                    (t/dispatch! :update-module-cljs-source cljs-source)
                    (when cljs-source
                      (t/dispatch! :add-chat-message "assistant"
                                   (str "Here is the ClojureScript translation:\n\n" cljs-source))
                      (t/dispatch! :set-chat-input "Please review this translation for issues.")
                      (state/send-chat-message!)))
                  (let [missing (get-in response [:data :missing])
                        error-msg (get-in response [:data :error] "Unknown error")]
                    (if missing
                      (let [parts (keep (fn [[type-key names]]
                                          (when (seq names)
                                            (str (name type-key) ": " (str/join ", " names))))
                                        missing)]
                        (state/set-error! (str "Translation blocked — import these objects first: "
                                               (str/join "; " parts))))
                      (state/log-error! (str "Translation failed: " error-msg) "translate-module"))))
                ctx))))}])

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
                        stats (:stats data)]
                    (t/dispatch! :set-module-intents {:intents intents :mapped mapped :stats stats})
                    ;; Add summary to chat
                    (t/dispatch! :add-chat-message "assistant"
                                 (str "Extracted " (:total stats) " intents from "
                                      (count (:procedures intents)) " procedures:\n"
                                      "- " (:mechanical stats) " mechanical (deterministic)\n"
                                      "- " (:llm_fallback stats) " need LLM assistance\n"
                                      "- " (:gap stats) " gaps (unmappable)\n\n"
                                      "Click \"Generate Code\" to produce ClojureScript.")))
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

(def generate-wiring-flow
  "POST /api/chat/generate-wiring → store CLJS → set dirty → add to chat.
   Generates ClojureScript wiring from previously extracted intents."
  [{:step :do
    :fn (fn [ctx]
          (let [module-info (get-in @app-state [:module-viewer :module-info])
                intents-data (get-in @app-state [:module-viewer :intents])]
            (swap! app-state assoc-in [:module-viewer :translating?] true)
            (when-not (:chat-panel-open? @app-state)
              (t/dispatch! :toggle-chat-panel))
            (assoc ctx :module-info module-info :intents-data intents-data)))}
   {:step :do
    :fn (fn [ctx]
          (let [mi (:module-info ctx)
                intents-data (:intents-data ctx)]
            (go
              (let [response (<! (http/post!
                                   (str api-base "/api/chat/generate-wiring")
                                   :headers (db-headers)
                                   :json-params {:mapped_intents (:mapped intents-data)
                                                 :module_name (:name mi)
                                                 :vba_source (:vba-source mi)
                                                 :database_id (:database_id (:current-database @app-state))}))]
                (swap! app-state assoc-in [:module-viewer :translating?] false)
                (if (:ok? response)
                  (let [cljs-source (get-in response [:data :cljs_source])
                        stats (get-in response [:data :stats])]
                    (t/dispatch! :update-module-cljs-source cljs-source)
                    (when cljs-source
                      (t/dispatch! :add-chat-message "assistant"
                                   (str "Generated ClojureScript from intents:\n"
                                        "- " (:mechanical_count stats) " mechanical templates\n"
                                        "- " (:fallback_count stats) " LLM-assisted\n"
                                        "- " (:gap_count stats) " gaps (marked as comments)\n\n"
                                        cljs-source))))
                  (state/log-error! (str "Code generation failed: "
                                         (get-in response [:data :error] "Unknown error"))
                                    "generate-wiring"))
                ctx))))}])

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
                                              :cljs-source (:cljs_source data)
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
;; MACRO SAVE
;; ============================================================

(def save-macro-cljs-flow
  "PUT /api/macros/:name — save ClojureScript translation.
   Original: state.cljs/save-macro-cljs!"
  [{:step :do
    :fn (fn [ctx]
          (let [macro-info (get-in @app-state [:macro-viewer :macro-info])]
            (assoc ctx :macro-info macro-info)))}
   {:step :branch
    :test (fn [ctx] (and (:name (:macro-info ctx)) (:cljs-source (:macro-info ctx))))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [mi (:macro-info ctx)]
                    (go
                      (let [response (<! (http/put!
                                           (str api-base "/api/macros/"
                                                (js/encodeURIComponent (:name mi)))
                                           :headers (db-headers)
                                           :json-params {:macro_xml (:macro-xml mi)
                                                         :cljs_source (:cljs-source mi)
                                                         :status (:status mi)
                                                         :review_notes (:review-notes mi)}))]
                        (if (:ok? response)
                          (do
                            (swap! app-state assoc-in [:macro-viewer :cljs-dirty?] false)
                            (swap! app-state assoc-in [:macro-viewer :macro-info :version]
                                   (get-in response [:data :version])))
                          (state/log-error! "Failed to save macro translation" "save-macro-cljs"))
                        ctx))))}]}])

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
   Original: state.cljs/set-macro-status!

   Context requires: {:status string}"
  [{:step :do
    :fn (fn [ctx]
          (state/set-macro-status! (:status ctx))
          ctx)}])
