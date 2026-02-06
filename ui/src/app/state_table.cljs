(ns app.state-table
  "Table viewer state management"
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [app.state :as state]))

(declare refresh-table-data!)

;; Clipboard for cut/copy/paste
(defonce table-clipboard (atom nil))

(defn get-pk-field
  "Get the primary key field name for the current table"
  []
  (let [fields (get-in @state/app-state [:table-viewer :table-info :fields])]
    (or (:name (first (filter :pk fields))) "id")))

(defn select-table-field!
  "Select a field in design view for the property sheet"
  [field-name]
  (swap! state/app-state assoc-in [:table-viewer :selected-field] field-name))

(defn set-table-view-mode!
  "Set table view mode - :datasheet or :design"
  [mode]
  (swap! state/app-state assoc-in [:table-viewer :view-mode] mode)
  ;; Load data when switching to datasheet view
  (when (= mode :datasheet)
    (refresh-table-data!)))

(defn load-table-for-viewing!
  "Load a table for viewing"
  [table]
  (swap! state/app-state assoc :table-viewer
         {:table-id (:id table)
          :table-info table
          :records []
          :view-mode :datasheet
          :loading? true})
  ;; Load the data
  (go
    (let [response (<! (http/get (str state/api-base "/api/data/" (:name table))
                                 {:query-params {:limit 1000}
                                  :headers (state/db-headers)}))]
      (swap! state/app-state assoc-in [:table-viewer :loading?] false)
      (if (:success response)
        (let [data (get-in response [:body :data] [])]
          (swap! state/app-state assoc-in [:table-viewer :records] (vec data)))
        (println "Error loading table data:" (:body response))))))

(defn refresh-table-data!
  "Refresh the current table's data"
  []
  (let [table-info (get-in @state/app-state [:table-viewer :table-info])]
    (when table-info
      (swap! state/app-state assoc-in [:table-viewer :loading?] true)
      (go
        (let [response (<! (http/get (str state/api-base "/api/data/" (:name table-info))
                                     {:query-params {:limit 1000}
                                      :headers (state/db-headers)}))]
          (swap! state/app-state assoc-in [:table-viewer :loading?] false)
          (if (:success response)
            (let [data (get-in response [:body :data] [])]
              (swap! state/app-state assoc-in [:table-viewer :records] (vec data)))
            (println "Error refreshing table data:" (:body response))))))))

;; Cell selection and editing
(defn select-table-cell!
  "Select a cell in the datasheet"
  [row-idx col-name]
  (swap! state/app-state assoc-in [:table-viewer :selected] {:row row-idx :col col-name})
  (swap! state/app-state assoc-in [:table-viewer :context-menu :visible] false))

(defn select-table-row!
  "Select an entire row"
  [row-idx]
  (swap! state/app-state assoc-in [:table-viewer :selected] {:row row-idx :col nil}))

(defn start-editing-cell!
  "Start editing a cell"
  [row-idx col-name]
  (swap! state/app-state assoc-in [:table-viewer :selected] {:row row-idx :col col-name})
  (swap! state/app-state assoc-in [:table-viewer :editing] {:row row-idx :col col-name}))

(defn stop-editing-cell!
  "Stop editing the current cell"
  []
  (swap! state/app-state assoc-in [:table-viewer :editing] nil))

(defn save-table-cell!
  "Save the edited cell value"
  [new-value]
  (let [selected (get-in @state/app-state [:table-viewer :selected])
        row-idx (:row selected)
        col-name (:col selected)
        records (get-in @state/app-state [:table-viewer :records])
        record (nth records row-idx)
        pk-field (get-pk-field)
        pk-value (get record (keyword pk-field))
        table-name (get-in @state/app-state [:table-viewer :table-info :name])]
    (when (and row-idx col-name pk-value)
      ;; Update local state immediately
      (swap! state/app-state assoc-in [:table-viewer :records row-idx (keyword col-name)] new-value)
      ;; Save to server
      (go
        (let [response (<! (http/put (str state/api-base "/api/data/" table-name "/" pk-value)
                                     {:json-params {col-name new-value}
                                      :headers (state/db-headers)}))]
          (if (:success response)
            (println "Cell saved:" col-name "=" new-value)
            (do
              (println "Error saving cell:" (:body response))
              ;; Revert on error
              (refresh-table-data!))))))))

(defn move-to-next-cell!
  "Move to the next cell (Tab) or previous cell (Shift+Tab)"
  [shift?]
  (let [selected (get-in @state/app-state [:table-viewer :selected])
        fields (get-in @state/app-state [:table-viewer :table-info :fields])
        records (get-in @state/app-state [:table-viewer :records])
        col-names (mapv :name fields)
        row-idx (:row selected)
        col-name (:col selected)
        col-idx (.indexOf col-names col-name)]
    (if shift?
      ;; Move backwards
      (if (> col-idx 0)
        (start-editing-cell! row-idx (nth col-names (dec col-idx)))
        (when (> row-idx 0)
          (start-editing-cell! (dec row-idx) (last col-names))))
      ;; Move forwards
      (if (< col-idx (dec (count col-names)))
        (start-editing-cell! row-idx (nth col-names (inc col-idx)))
        (when (< row-idx (dec (count records)))
          (start-editing-cell! (inc row-idx) (first col-names)))))))

;; Context menu
(defn show-table-context-menu!
  "Show context menu at position"
  [x y]
  (swap! state/app-state assoc-in [:table-viewer :context-menu]
         {:visible true :x x :y y}))

(defn hide-table-context-menu!
  "Hide context menu"
  []
  (swap! state/app-state assoc-in [:table-viewer :context-menu :visible] false))

;; Cut/Copy/Paste
(defn copy-table-cell!
  "Copy selected cell value to clipboard"
  []
  (let [selected (get-in @state/app-state [:table-viewer :selected])
        row-idx (:row selected)
        col-name (:col selected)
        records (get-in @state/app-state [:table-viewer :records])
        value (when (and row-idx col-name)
                (get (nth records row-idx) (keyword col-name)))]
    (reset! table-clipboard {:value value :cut? false})
    (println "Copied:" value)))

(defn cut-table-cell!
  "Cut selected cell value"
  []
  (let [selected (get-in @state/app-state [:table-viewer :selected])
        row-idx (:row selected)
        col-name (:col selected)
        records (get-in @state/app-state [:table-viewer :records])
        value (when (and row-idx col-name)
                (get (nth records row-idx) (keyword col-name)))]
    (reset! table-clipboard {:value value :cut? true :row row-idx :col col-name})
    (println "Cut:" value)))

(defn paste-table-cell!
  "Paste clipboard value to selected cell"
  []
  (when-let [clipboard @table-clipboard]
    (let [value (:value clipboard)]
      (save-table-cell! value)
      ;; If it was a cut, clear the original cell
      (when (:cut? clipboard)
        (let [orig-row (:row clipboard)
              orig-col (:col clipboard)]
          (swap! state/app-state assoc-in [:table-viewer :selected] {:row orig-row :col orig-col})
          (save-table-cell! nil)
          (reset! table-clipboard nil))))))

;; New record
(defn new-table-record!
  "Add a new empty record to the table"
  []
  (let [table-name (get-in @state/app-state [:table-viewer :table-info :name])
        fields (get-in @state/app-state [:table-viewer :table-info :fields])
        ;; Create empty record with just non-pk fields
        empty-record (reduce (fn [m field]
                               (if (:pk field)
                                 m
                                 (assoc m (:name field) nil)))
                             {}
                             fields)]
    (go
      (let [response (<! (http/post (str state/api-base "/api/data/" table-name)
                                    {:json-params empty-record
                                     :headers (state/db-headers)}))]
        (if (:success response)
          (do
            (println "New record created")
            (refresh-table-data!))
          (println "Error creating record:" (:body response)))))))

;; Delete record
(defn delete-table-record!
  "Delete the selected record"
  []
  (let [selected (get-in @state/app-state [:table-viewer :selected])
        row-idx (:row selected)
        records (get-in @state/app-state [:table-viewer :records])
        record (when row-idx (nth records row-idx nil))
        pk-field (get-pk-field)
        pk-value (when record (get record (keyword pk-field)))
        table-name (get-in @state/app-state [:table-viewer :table-info :name])]
    (when pk-value
      (go
        (let [response (<! (http/delete (str state/api-base "/api/data/" table-name "/" pk-value)
                                        {:headers (state/db-headers)}))]
          (if (:success response)
            (do
              (println "Record deleted")
              (swap! state/app-state assoc-in [:table-viewer :selected] nil)
              (refresh-table-data!))
            (println "Error deleting record:" (:body response))))))))
