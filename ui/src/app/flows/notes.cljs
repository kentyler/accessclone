(ns app.flows.notes
  "Notes/corpus flows — load, submit, select entries."
  (:require [app.state :as state :refer [app-state api-base]]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [cljs.core.async :refer [go <!]]))

(def load-notes-flow
  "GET /api/notes → set entries in state"
  [{:step :do
    :fn (fn [ctx]
          (go
            (let [response (<! (http/get! (str api-base "/api/notes")))]
              (when (:ok? response)
                (t/dispatch! :set-notes-entries (get-in response [:data :entries]))))
            ctx))}])

(def submit-entry-flow
  "Clear input, set loading, POST content, add all response entries, show in read pane"
  [{:step :do
    :fn (fn [ctx]
          (let [content (:notes-input @app-state)]
            (when (and content (not (clojure.string/blank? content)))
              (t/dispatch! :set-notes-loading true)
              (go
                (let [response (<! (http/post! (str api-base "/api/notes")
                                               :json-params {:content content}))]
                  (t/dispatch! :set-notes-loading false)
                  (t/dispatch! :set-notes-input "")
                  (when (:ok? response)
                    (let [entry (get-in response [:data :entry])
                          responses (get-in response [:data :responses] [])
                          routing (get-in response [:data :routing])
                          ;; Merge routing metadata onto the human entry
                          entry (cond-> entry
                                  (:sampling routing)
                                  (assoc :sampling_strategy (:sampling routing))
                                  (:reasoning routing)
                                  (assoc :routing_reasoning (:reasoning routing)))]
                      ;; Add to sidebar (most recent first) — responses then entry
                      (doseq [r (reverse responses)]
                        (t/dispatch! :add-notes-entry r))
                      (t/dispatch! :add-notes-entry entry)
                      ;; Show in read pane
                      (t/dispatch! :set-notes-selected (:id entry))
                      (t/dispatch! :set-notes-read-entry entry responses)))))))
          ctx)}])

(def select-entry-flow
  "GET /api/notes/:id → set read pane content"
  [{:step :do
    :fn (fn [ctx]
          (let [id (:id ctx)]
            (when id
              (t/dispatch! :set-notes-selected id)
              (go
                (let [response (<! (http/get! (str api-base "/api/notes/" id)))]
                  (when (:ok? response)
                    (t/dispatch! :set-notes-read-entry
                                 (get-in response [:data :entry])
                                 (get-in response [:data :responses] [])))))))
          ctx)}])

(def regenerate-entry-flow
  "POST /api/notes/:id/regenerate with user-chosen model/temp/sampling → append new response"
  [{:step :do
    :fn (fn [ctx]
          (let [{:keys [entry-id model-name temperature sampling]} ctx]
            (when entry-id
              (t/dispatch! :set-notes-regenerating true)
              (go
                (let [response (<! (http/post! (str api-base "/api/notes/" entry-id "/regenerate")
                                               :json-params {:model_name model-name
                                                              :temperature temperature
                                                              :sampling sampling}))]
                  (t/dispatch! :set-notes-regenerating false)
                  (if (:ok? response)
                    (let [new-response (get-in response [:data :response])]
                      (t/dispatch! :append-notes-response new-response))
                    (let [err-msg (or (get-in response [:data :error]) "Regenerate failed")]
                      (t/dispatch! :set-error err-msg)))))))
          ctx)}])
