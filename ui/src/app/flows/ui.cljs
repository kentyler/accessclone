(ns app.flows.ui
  "UI flows — database loading, object loading, UI state persistence.

   Decomposes async functions from state.cljs into transform+effect sequences."
  (:require [app.state :refer [app-state api-base db-headers session-id]]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; OBJECT LOADERS (7 types — each follows the same pattern)
;; ============================================================

(defn load-tables-flow
  "GET /api/tables → set-objects :tables
   Original: state.cljs/load-tables!"
  []
  [{:step :effect
    :name :fetch-tables
    :opts-fn (fn [_] {:headers (db-headers)})
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [tables (get-in ctx [:response :data :tables])
                        tables-with-ids (vec (map-indexed
                                               (fn [idx table]
                                                 {:id (inc idx) :name (:name table)
                                                  :description (:description table)
                                                  :fields (mapv (fn [f]
                                                                  {:name (:name f) :type (:type f)
                                                                   :pk (:isPrimaryKey f) :nullable (:nullable f)
                                                                   :fk (when (:isForeignKey f) (:foreignTable f))
                                                                   :default (:default f) :max-length (:maxLength f)
                                                                   :precision (:precision f) :scale (:scale f)
                                                                   :description (:description f) :indexed (:indexed f)
                                                                   :check-constraint (:checkConstraint f)})
                                                                (:fields table))})
                                               tables))]
                    (t/dispatch! :set-objects :tables tables-with-ids)
                    ctx))}]}])

(defn load-queries-flow
  "GET /api/queries → set-objects :queries
   Original: state.cljs/load-queries!"
  []
  [{:step :effect
    :name :fetch-queries
    :opts-fn (fn [_] {:headers (db-headers)})
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [queries (get-in ctx [:response :data :queries])
                        with-ids (vec (map-indexed
                                        (fn [idx q]
                                          {:id (inc idx)
                                           :name (:name q)
                                           :sql (:sql q)
                                           :fields (mapv (fn [f] {:name (:name f) :type (:type f) :nullable (:nullable f)})
                                                         (:fields q))})
                                        queries))]
                    (t/dispatch! :set-objects :queries with-ids)
                    ctx))}]}])

(defn load-forms-flow
  "GET /api/forms → set-objects :forms
   Original: state.cljs/load-forms!"
  []
  [{:step :effect
    :name :fetch-forms
    :opts-fn (fn [_] {:headers (db-headers)})
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [forms-data (get-in ctx [:response :data :forms] [])
                        details (get-in ctx [:response :data :details] [])
                        forms (vec (map-indexed
                                     (fn [idx form-name]
                                       (let [detail (nth details idx nil)]
                                         {:id (inc idx)
                                          :name (app.state/filename->display-name form-name)
                                          :filename form-name
                                          :record-source (:record_source detail)}))
                                     forms-data))]
                    (t/dispatch! :set-objects :forms forms)
                    ctx))}]}])

(defn load-reports-flow
  "GET /api/reports → set-objects :reports
   Original: state.cljs/load-reports!"
  []
  [{:step :effect
    :name :fetch-reports
    :opts-fn (fn [_] {:headers (db-headers)})
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [reports-data (get-in ctx [:response :data :reports] [])
                        details (get-in ctx [:response :data :details] [])
                        reports (vec (map-indexed
                                       (fn [idx report-name]
                                         (let [detail (nth details idx nil)]
                                           {:id (inc idx)
                                            :name (app.state/filename->display-name report-name)
                                            :filename report-name
                                            :record-source (:record_source detail)}))
                                       reports-data))]
                    (t/dispatch! :set-objects :reports reports)
                    ctx))}]}])

(defn load-modules-flow
  "GET /api/modules → set-objects :modules
   Original: state.cljs/load-functions!"
  []
  [{:step :effect
    :name :fetch-modules
    :opts-fn (fn [_] {:headers (db-headers)})
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [module-names (get-in ctx [:response :data :modules] [])
                        details (get-in ctx [:response :data :details] [])
                        modules (vec (map-indexed
                                       (fn [idx mod-name]
                                         (let [detail (nth details idx nil)]
                                           {:id (inc idx)
                                            :name mod-name
                                            :has-vba-source (:has_vba_source detail)
                                            :has-cljs-source (:has_cljs_source detail)
                                            :description (:description detail)}))
                                       module-names))]
                    (t/dispatch! :set-objects :modules modules)
                    ctx))}]}])

(defn load-sql-functions-flow
  "GET /api/functions → set-objects :sql-functions
   Original: state.cljs/load-sql-functions!"
  []
  [{:step :effect
    :name :fetch-sql-functions
    :opts-fn (fn [_] {:headers (db-headers)})
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [functions (get-in ctx [:response :data :functions] [])
                        with-ids (vec (map-indexed
                                        (fn [idx f]
                                          {:id (inc idx) :name (:name f)
                                           :arguments (:arguments f) :return-type (:returnType f)
                                           :source (:source f) :description (:description f)})
                                        functions))]
                    (t/dispatch! :set-objects :sql-functions with-ids)
                    ctx))}]}])

(defn load-macros-flow
  "GET /api/macros → set-objects :macros
   Original: state.cljs/load-macros!"
  []
  [{:step :effect
    :name :fetch-macros
    :opts-fn (fn [_] {:headers (db-headers)})
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [macro-names (get-in ctx [:response :data :macros] [])
                        details (get-in ctx [:response :data :details] [])
                        macros (vec (map-indexed
                                      (fn [idx macro-name]
                                        (let [detail (nth details idx nil)]
                                          {:id (inc idx)
                                           :name macro-name
                                           :has-macro-xml (:has_macro_xml detail)
                                           :has-cljs-source (:has_cljs_source detail)
                                           :description (:description detail)}))
                                      macro-names))]
                    (t/dispatch! :set-objects :macros macros)
                    ctx))}]}])

;; ============================================================
;; DATABASE FLOWS
;; ============================================================

(def load-databases-flow
  "GET /api/databases → set databases → start loading all 7 object types.
   Original: state.cljs/load-databases!"
  [{:step :effect
    :name :fetch-databases
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [databases (get-in ctx [:response :data :databases])
                        server-current-id (get-in ctx [:response :data :current])
                        saved-db-id (:saved-database-id @app-state)
                        target-id (or saved-db-id server-current-id)
                        current-db (first (filter #(= (:database_id %) target-id) databases))]
                    (t/dispatch! :set-available-databases databases)
                    (t/dispatch! :set-current-database (or current-db (first databases)))
                    (swap! app-state dissoc :saved-database-id)
                    ctx))}]
    :else [{:step :do
            :fn (fn [ctx]
                  (app.state/log-error! "Failed to load databases" "load-databases"
                                        {:response (get-in ctx [:response :data])})
                  ctx)}]}])

(def save-ui-state-flow
  "PUT /api/session/ui-state — save open tabs, active tab, database, app mode.
   Original: state.cljs/save-ui-state!"
  [{:step :do
    :fn (fn [ctx]
          (let [state @app-state
                current-db (:current-database state)
                ui-state {:database_id (:database_id current-db)
                          :open_objects (vec (map #(select-keys % [:type :id :name])
                                                  (:open-objects state)))
                          :active_tab (when-let [at (:active-tab state)]
                                        (select-keys at [:type :id]))
                          :app_mode (name (or (:app-mode state) :run))}]
            (assoc ctx :ui-state ui-state)))}
   {:step :effect
    :name :save-ui-state
    :opts-fn (fn [ctx] {:json-params (:ui-state ctx)})
    :as :response}])

(def load-config-flow
  "GET /api/config → merge into app-state.
   Original: state.cljs/load-config!"
  [{:step :effect
    :name :fetch-config
    :as :response}
   {:step :branch
    :test (fn [ctx] (get-in ctx [:response :ok?]))
    :then [{:step :do
            :fn (fn [ctx]
                  (swap! app-state assoc :config (get-in ctx [:response :data]))
                  ctx)}]}])
