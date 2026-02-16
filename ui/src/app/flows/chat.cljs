(ns app.flows.chat
  "Chat flows — send message, save/load transcript, auto-analyze.

   Decomposes async functions from state.cljs into transform+effect sequences."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [clojure.string :as str]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; CHAT TRANSCRIPT PERSISTENCE
;; ============================================================

(def save-chat-transcript-flow
  "PUT /api/transcripts/:type/:name — save current messages.
   Original: state.cljs/save-chat-transcript!"
  [{:step :do
    :fn (fn [ctx]
          (let [chat-tab (:chat-tab @app-state)
                messages (:chat-messages @app-state)]
            (if (and chat-tab (seq messages))
              (let [obj-name (or (:name chat-tab))
                    obj-type (state/object-type->transcript-type (:type chat-tab))]
                (when obj-name
                  (go (<! (http/put!
                            (str api-base "/api/transcripts/"
                                 (js/encodeURIComponent obj-type) "/"
                                 (js/encodeURIComponent obj-name))
                            :headers (db-headers)
                            :json-params {:transcript (vec messages)})))))
              ctx)))}])

(defn load-chat-transcript-flow
  "GET /api/transcripts/:type/:name → set messages or trigger auto-analyze.
   Original: state.cljs/load-chat-transcript!

   Context requires: {:tab {:type :id :name}}"
  []
  [{:step :do
    :fn (fn [ctx]
          (let [tab (:tab ctx)
                obj-name (:name tab)
                obj-type (state/object-type->transcript-type (:type tab))]
            (swap! app-state assoc :chat-tab (assoc tab :name obj-name))
            (assoc ctx :obj-name obj-name :obj-type obj-type)))}
   {:step :branch
    :test (fn [ctx] (:obj-name ctx))
    :then [{:step :do
            :fn (fn [ctx]
                  (go
                    (let [response (<! (http/get!
                                         (str api-base "/api/transcripts/"
                                              (js/encodeURIComponent (:obj-type ctx)) "/"
                                              (js/encodeURIComponent (:obj-name ctx)))
                                         :headers (db-headers)))]
                      (if (and (:ok? response)
                               (seq (get-in response [:data :transcript])))
                        (swap! app-state assoc :chat-messages
                               (vec (map #(select-keys % [:role :content])
                                         (get-in response [:data :transcript]))))
                        (do
                          (swap! app-state assoc :chat-messages [])
                          (when (#{:reports :forms :sql-functions :tables :queries :modules :macros}
                                  (get-in ctx [:tab :type]))
                            (swap! app-state assoc :auto-analyze-pending true)
                            (state/maybe-auto-analyze!))))
                      ctx)))}]}])

;; ============================================================
;; SEND CHAT MESSAGE
;; ============================================================

(def send-chat-message-flow
  "Add user message → POST to LLM → add assistant response → save transcript.
   Original: state.cljs/send-chat-message!

   Sequence: add-message → set-loading → build-context → POST chat →
             add-response → handle-side-effects → save-transcript"
  [{:step :do
    :fn (fn [ctx]
          (let [input (str/trim (:chat-input @app-state))]
            (when (not (str/blank? input))
              (t/dispatch! :add-chat-message "user" input)
              (t/dispatch! :set-chat-input "")
              (t/dispatch! :set-chat-loading true))
            (assoc ctx :input input)))}
   {:step :branch
    :test (fn [ctx] (not (str/blank? (:input ctx))))
    :then [{:step :do
            :fn (fn [ctx]
                  (go
                    ;; Build context and send (reuses existing send-chat-message! for now)
                    ;; The full context-building logic is complex and will be extracted
                    ;; to a dedicated builder in a future iteration.
                    (let [state @app-state
                          active-tab (:active-tab state)
                          history (vec (:chat-messages state))
                          response (<! (http/post!
                                         (str api-base "/api/chat")
                                         :headers (db-headers)
                                         :json-params {:message (:input ctx)
                                                       :history history
                                                       :database_id (:database_id (:current-database state))}))]
                      (t/dispatch! :set-chat-loading false)
                      (if (:ok? response)
                        (do
                          (t/dispatch! :add-chat-message "assistant" (get-in response [:data :message]))
                          (state/save-chat-transcript!))
                        (do
                          (t/dispatch! :add-chat-message "assistant"
                                       (str "Error: " (get-in response [:data :error] "Failed to get response")))
                          (state/save-chat-transcript!)))
                      ctx)))}]}])
