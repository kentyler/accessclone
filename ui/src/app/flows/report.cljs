(ns app.flows.report
  "Report flows — load, save, preview.

   Decomposes async functions from state_report.cljs into transform+effect sequences."
  (:require [app.state :as state :refer [app-state api-base db-headers
                                          build-data-query-params]]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [clojure.string :as str]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; REPORT LOAD
;; ============================================================

(defn load-report-for-editing-flow
  "Auto-save → fetch definition → normalize → setup editor → auto-analyze.
   Original: state_report.cljs/load-report-for-editing!

   Context requires: {:report {:id :filename :definition?}}"
  []
  [{:step :branch
    :test (fn [ctx] (nil? (get-in ctx [:report :definition])))
    :then [{:step :do
            :fn (fn [ctx]
                  (go
                    (let [response (<! (http/get!
                                         (str api-base "/api/reports/" (get-in ctx [:report :filename]))
                                         :headers (db-headers)))]
                      (if (:ok? response)
                        (let [definition (app.state-report/parse-report-body
                                           (:data response)
                                           (get-in ctx [:report :name]))]
                          (assoc ctx :definition definition))
                        (do (state/log-error!
                              (str "Failed to load report: " (get-in ctx [:report :filename]))
                              "load-report-for-editing")
                            (assoc ctx :abort? true))))))}]
    :else [{:step :do
            :fn (fn [ctx]
                  (assoc ctx :definition
                         (app.state-report/normalize-report-definition
                           (get-in ctx [:report :definition]))))}]}
   ;; Setup editor
   {:step :branch
    :test (fn [ctx] (not (:abort? ctx)))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [definition (:definition ctx)
                        report-id (get-in ctx [:report :id])]
                    (swap! app-state assoc :report-editor
                           {:report-id report-id
                            :dirty? false
                            :original definition
                            :current definition
                            :selected-control nil
                            :properties-tab :format
                            :view-mode :design
                            :records []})
                    (state/maybe-auto-analyze!)
                    ctx))}]}])

;; ============================================================
;; REPORT SAVE
;; ============================================================

(def save-report-flow
  "Lint → save if valid → show errors if not.
   Original: state_report.cljs/save-report!

   Sequence: clear-lint-errors → POST lint → branch(valid? → do-save : set-errors)"
  [{:step :transform :name :clear-report-lint-errors}
   {:step :do
    :fn (fn [ctx]
          (let [state @app-state
                current (get-in state [:report-editor :current])
                report-id (get-in state [:report-editor :report-id])
                report-obj (first (filter #(= (:id %) report-id)
                                          (get-in state [:objects :reports])))
                report-with-meta (merge {:id report-id :name (:name report-obj)} current)]
            (assoc ctx :report-with-meta report-with-meta :report-id report-id :current current)))}
   {:step :effect
    :name :lint-report
    :opts-fn (fn [ctx] {:headers (db-headers) :json-params {:report (:report-with-meta ctx)}})
    :as :lint-response}
   {:step :branch
    :test (fn [ctx]
            (or (not (get-in ctx [:lint-response :ok?]))
                (get-in ctx [:lint-response :data :valid])))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [current (:current ctx)
                        report-id (:report-id ctx)]
                    (state/update-object! :reports report-id {:definition current})
                    (swap! app-state update :open-objects
                           (fn [tabs]
                             (mapv (fn [tab]
                                     (if (and (= (:type tab) :reports) (= (:id tab) report-id))
                                       (assoc tab :name (or (:name current) (:name tab)))
                                       tab))
                                   tabs)))
                    (swap! app-state assoc-in [:report-editor :dirty?] false)
                    (swap! app-state assoc-in [:report-editor :original] current)
                    (let [report (first (filter #(= (:id %) report-id)
                                                (get-in @app-state [:objects :reports])))]
                      (app.state-report/save-report-to-file! report))
                    ctx))}]
    :else [{:step :do
            :fn (fn [ctx]
                  (t/dispatch! :set-report-lint-errors (get-in ctx [:lint-response :data :errors]))
                  ctx)}]}])

;; ============================================================
;; REPORT PREVIEW
;; ============================================================

(def set-report-view-mode-flow
  "Switch mode → load data if entering preview.
   Original: state_report.cljs/set-report-view-mode!

   Context requires: {:mode :design|:preview}"
  [{:step :do
    :fn (fn [ctx]
          (swap! app-state assoc-in [:report-editor :view-mode] (:mode ctx))
          ctx)}
   {:step :branch
    :test (fn [ctx] (= (:mode ctx) :preview))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [record-source (get-in @app-state [:report-editor :current :record-source])]
                    (when record-source
                      (go
                        (let [query-params (build-data-query-params
                                             (get-in @app-state [:report-editor :current :order-by])
                                             (get-in @app-state [:report-editor :current :filter]))
                              response (<! (http/get!
                                             (str api-base "/api/data/" record-source)
                                             :headers (db-headers)
                                             :query-params query-params))]
                          (if (:ok? response)
                            (swap! app-state assoc-in [:report-editor :records]
                                   (vec (get-in response [:data :data])))
                            (state/log-error! "Failed to load report preview data"
                                              "set-report-view-mode")))))
                    ctx))}]}])
