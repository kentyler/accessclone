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
  "Clear input, set loading, POST content, add both entries, show in read pane"
  [{:step :do
    :fn (fn [ctx]
          (let [content (:notes-input @app-state)]
            (when (and content (not (clojure.string/blank? content)))
              (t/dispatch! :set-notes-input "")
              (t/dispatch! :set-notes-loading true)
              (go
                (let [response (<! (http/post! (str api-base "/api/notes")
                                               :json-params {:content content}))]
                  (t/dispatch! :set-notes-loading false)
                  (when (:ok? response)
                    (let [entry (get-in response [:data :entry])
                          llm-response (get-in response [:data :response])]
                      ;; Add to sidebar (most recent first)
                      (when llm-response
                        (t/dispatch! :add-notes-entry llm-response))
                      (t/dispatch! :add-notes-entry entry)
                      ;; Show in read pane
                      (t/dispatch! :set-notes-selected (:id entry))
                      (t/dispatch! :set-notes-read-entry entry llm-response)))))))
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
                                 (get-in response [:data :response])))))))
          ctx)}])
