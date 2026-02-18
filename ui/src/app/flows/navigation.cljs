(ns app.flows.navigation
  "Navigation flows — open/close tabs, create new objects, switch database.

   Thin wrappers around existing state functions, routed through the flow runner."
  (:require [app.state :as state :refer [app-state]]
            [app.state-form :as state-form]
            [app.state-report :as state-report]
            [app.state-query :as state-query]
            [app.state-table :as state-table]
            [app.flows.app :as app-flow]
            [app.flows.core :as f]
            [app.transforms.core :as t]))

;; ============================================================
;; OPEN / CLOSE TABS
;; ============================================================

(defn set-active-tab-flow
  "Switch to an already-open tab.
   Original: state.cljs/set-active-tab!

   Context requires: {:type keyword :id any}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state/set-active-tab! (:type ctx) (:id ctx))
          ctx)}])

(defn close-tab-flow
  "Close a specific tab by type and id.
   Original: state.cljs/close-tab!

   Context requires: {:type keyword :id any}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state/close-tab! (:type ctx) (:id ctx))
          ctx)}])

(defn open-object-flow
  "Open an object in a new tab (or switch to existing).
   Original: state.cljs/open-object!

   Context requires: {:type keyword :id any}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state/open-object! (:type ctx) (:id ctx))
          ctx)}])

(def close-current-tab-flow
  "Close the currently active tab (auto-saves dirty record/form).
   Original: state_form.cljs/close-current-tab!"
  [{:step :do
    :fn (fn [ctx]
          (state-form/close-current-tab!)
          ctx)}])

(def close-all-tabs-flow
  "Close all open tabs (auto-saves dirty record/form).
   Original: state_form.cljs/close-all-tabs!"
  [{:step :do
    :fn (fn [ctx]
          (state-form/close-all-tabs!)
          ctx)}])

;; ============================================================
;; CREATE NEW OBJECTS
;; ============================================================

(def create-new-form-flow
  "Create a blank form and open it.
   Original: state_form.cljs/create-new-form!"
  [{:step :do
    :fn (fn [ctx]
          (state-form/create-new-form!)
          ctx)}])

(def create-new-report-flow
  "Create a blank report and open it.
   Original: state_report.cljs/create-new-report!"
  [{:step :do
    :fn (fn [ctx]
          (state-report/create-new-report!)
          ctx)}])

(def create-new-query-flow
  "Create a blank query and open it in SQL view.
   Original: state_query.cljs/create-new-query!"
  [{:step :do
    :fn (fn [ctx]
          (state-query/create-new-query!)
          ctx)}])

(def create-new-module-flow
  "Create a blank module and open it.
   Original: state.cljs/create-new-module!"
  [{:step :do
    :fn (fn [ctx]
          (state/create-new-module!)
          ctx)}])

(def create-new-function-flow
  "Create a blank function and open it.
   Original: state.cljs/create-new-function!"
  [{:step :do
    :fn (fn [ctx]
          (state/create-new-function!)
          ctx)}])

(def start-new-table-flow
  "Initialize new table creation mode.
   Original: state_table.cljs/start-new-table!"
  [{:step :do
    :fn (fn [ctx]
          (state-table/start-new-table!)
          ctx)}])

;; ============================================================
;; OPEN APP VIEWER
;; ============================================================

(def open-app-flow
  "Open the Application dashboard tab and load overview data."
  [{:step :do
    :fn (fn [ctx]
          (state/open-object! :app :app-main)
          ctx)}
   {:step :do
    :fn (fn [ctx]
          ;; Load overview data via its flow
          (f/run-fire-and-forget! app-flow/load-app-overview-flow)
          ctx)}])

;; ============================================================
;; SWITCH DATABASE
;; ============================================================

(defn switch-database-flow
  "Switch to a different database — reloads all objects.
   Original: state.cljs/switch-database!

   Context requires: {:database-id any}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state/switch-database! (:database-id ctx))
          ctx)}])
