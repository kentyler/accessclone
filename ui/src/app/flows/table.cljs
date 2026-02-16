(ns app.flows.table
  "Table flows — load, cell save, design save, new table.

   Decomposes async functions from state_table.cljs into transform+effect sequences."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.state-table :as state-table]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; TABLE LOAD
;; ============================================================

(defn load-table-for-viewing-flow
  "Initialize table viewer → fetch records.
   Original: state_table.cljs/load-table-for-viewing!

   Context requires: {:table {:id :name :fields}}"
  []
  [{:step :do
    :fn (fn [ctx]
          (swap! app-state assoc :table-viewer
                 {:table-id (get-in ctx [:table :id])
                  :table-info (:table ctx)
                  :records []
                  :view-mode :datasheet
                  :loading? true
                  :design-fields nil :design-original nil :design-dirty? false
                  :design-renames {} :design-errors nil
                  :new-table? false :new-table-name ""
                  :table-description nil :original-description nil
                  :selected-field nil})
          (state/maybe-auto-analyze!)
          ctx)}
   {:step :do
    :fn (fn [ctx]
          (go
            (let [response (<! (http/get!
                                 (str api-base "/api/data/" (get-in ctx [:table :name]))
                                 :headers (db-headers)
                                 :query-params {:limit 1000}))]
              (swap! app-state assoc-in [:table-viewer :loading?] false)
              (if (:ok? response)
                (swap! app-state assoc-in [:table-viewer :records]
                       (vec (get-in response [:data :data] [])))
                (state/log-error! "Failed to load table data" "load-table"))
              ctx)))}])

;; ============================================================
;; CELL SAVE
;; ============================================================

(def save-table-cell-flow
  "Optimistic local update → PUT to API → revert on error.
   Original: state_table.cljs/save-table-cell!

   Context requires: {:new-value any}"
  [{:step :do
    :fn (fn [ctx]
          (let [state @app-state
                selected (get-in state [:table-viewer :selected])
                row-idx (:row selected)
                col-name (:col selected)
                records (get-in state [:table-viewer :records])
                record (nth records row-idx)
                pk-field (app.state-table/get-pk-field)
                pk-value (get record (keyword pk-field))
                table-name (get-in state [:table-viewer :table-info :name])]
            ;; Optimistic local update
            (swap! app-state assoc-in [:table-viewer :records row-idx (keyword col-name)] (:new-value ctx))
            (assoc ctx :table-name table-name :pk-value pk-value :col-name col-name)))}
   {:step :branch
    :test (fn [ctx] (:pk-value ctx))
    :then [{:step :do
            :fn (fn [ctx]
                  (go
                    (let [response (<! (http/put!
                                         (str api-base "/api/data/" (:table-name ctx) "/" (:pk-value ctx))
                                         :headers (db-headers)
                                         :json-params {(:col-name ctx) (:new-value ctx)}))]
                      (when-not (:ok? response)
                        (state/log-error! "Failed to save table cell" "save-table-cell")
                        (app.state-table/refresh-table-data!))
                      ctx)))}]}])

;; ============================================================
;; DESIGN SAVE
;; ============================================================

(def save-table-design-flow
  "Validate → PUT design → reload table metadata.
   Original: state_table.cljs/save-table-design!"
  [{:step :do
    :fn (fn [ctx]
          (let [state @app-state
                table-name (get-in state [:table-viewer :table-info :name])
                fields (get-in state [:table-viewer :design-fields])
                renames (get-in state [:table-viewer :design-renames] {})
                description (get-in state [:table-viewer :table-description])]
            (swap! app-state assoc-in [:table-viewer :design-errors] nil)
            (assoc ctx :table-name table-name :fields fields
                   :renames renames :description description)))}
   {:step :do
    :fn (fn [ctx]
          (go
            (let [response (<! (http/put!
                                 (str api-base "/api/tables/" (:table-name ctx))
                                 :headers (db-headers)
                                 :json-params {:fields (mapv #(dissoc % :checkConstraint :isForeignKey :foreignTable :original-name)
                                                              (:fields ctx))
                                               :renames (:renames ctx)
                                               :description (:description ctx)}))]
              (if (:ok? response)
                (do (app.state-table/populate-graph!)
                    (app.state-table/reload-table-after-save! (:table-name ctx)))
                (do (state/log-error! "Failed to save table design" "save-table-design")
                    (swap! app-state assoc-in [:table-viewer :design-errors]
                           [{:message (get-in response [:data :error] "Failed to save")}])))
              ctx)))}])

;; ============================================================
;; NEW TABLE
;; ============================================================

(def save-new-table-flow
  "Validate → POST create → refresh tables → open.
   Original: state_table.cljs/save-new-table!"
  [{:step :do
    :fn (fn [ctx]
          (let [state @app-state
                table-name (get-in state [:table-viewer :new-table-name])
                fields (get-in state [:table-viewer :design-fields])
                description (get-in state [:table-viewer :table-description])]
            (swap! app-state assoc-in [:table-viewer :design-errors] nil)
            (assoc ctx :table-name table-name :fields fields :description description)))}
   {:step :do
    :fn (fn [ctx]
          (go
            (let [response (<! (http/post!
                                 (str api-base "/api/tables")
                                 :headers (db-headers)
                                 :json-params {:name (:table-name ctx)
                                               :fields (mapv #(dissoc % :checkConstraint :isForeignKey :foreignTable :original-name)
                                                              (:fields ctx))
                                               :description (:description ctx)}))]
              (if (:ok? response)
                (do (app.state-table/populate-graph!)
                    (app.state-table/refresh-tables-and-open! (:table-name ctx)))
                (swap! app-state assoc-in [:table-viewer :design-errors]
                       [{:message (get-in response [:data :error] "Failed to create table")}]))
              ctx)))}])

;; ============================================================
;; VIEW MODE
;; ============================================================

(defn set-table-view-mode-flow
  "Switch table view mode — refresh data or init design editing.
   Original: state_table.cljs/set-table-view-mode!

   Context requires: {:mode :datasheet|:design}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-table/set-table-view-mode! (:mode ctx))
          ctx)}])

;; ============================================================
;; RECORD OPERATIONS
;; ============================================================

(def new-table-record-flow
  "Add a new empty record to the table.
   Original: state_table.cljs/new-table-record!"
  [{:step :do
    :fn (fn [ctx]
          (state-table/new-table-record!)
          ctx)}])

(def delete-table-record-flow
  "Delete the selected table record.
   Original: state_table.cljs/delete-table-record!"
  [{:step :do
    :fn (fn [ctx]
          (state-table/delete-table-record!)
          ctx)}])

(def refresh-table-data-flow
  "Refresh the current table's data from the server.
   Original: state_table.cljs/refresh-table-data!"
  [{:step :do
    :fn (fn [ctx]
          (state-table/refresh-table-data!)
          ctx)}])
