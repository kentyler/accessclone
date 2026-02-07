(ns app.state-table
  "Table viewer state management"
  (:require [clojure.string :as str]
            [cljs-http.client :as http]
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

(declare init-design-editing!)

(defn set-table-view-mode!
  "Set table view mode - :datasheet or :design"
  [mode]
  (let [dirty? (get-in @state/app-state [:table-viewer :design-dirty?])]
    (when (or (not dirty?)
              (not= mode :datasheet)
              (js/confirm "You have unsaved changes. Discard and switch to Datasheet?"))
      (swap! state/app-state assoc-in [:table-viewer :view-mode] mode)
      (when (= mode :datasheet)
        (refresh-table-data!))
      (when (= mode :design)
        (init-design-editing!)))))

(defn load-table-for-viewing!
  "Load a table for viewing"
  [table]
  (swap! state/app-state assoc :table-viewer
         {:table-id (:id table)
          :table-info table
          :records []
          :view-mode :datasheet
          :loading? true
          :design-fields nil
          :design-original nil
          :design-dirty? false
          :design-renames {}
          :design-errors nil
          :new-table? false
          :new-table-name ""
          :table-description nil
          :original-description nil
          :selected-field nil})
  ;; Load the data
  (go
    (let [response (<! (http/get (str state/api-base "/api/data/" (:name table))
                                 {:query-params {:limit 1000}
                                  :headers (state/db-headers)}))]
      (swap! state/app-state assoc-in [:table-viewer :loading?] false)
      (if (:success response)
        (let [data (get-in response [:body :data] [])]
          (swap! state/app-state assoc-in [:table-viewer :records] (vec data)))
        (state/log-error! "Failed to load table data" "load-table" {:response (:body response)})))))

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
            (state/log-error! "Failed to refresh table data" "refresh-table" {:response (:body response)})))))))

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
          (when-not (:success response)
            (state/log-error! "Failed to save table cell" "save-table-cell" {:response (:body response)})
            ;; Revert on error
            (refresh-table-data!)))))))

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
    (reset! table-clipboard {:value value :cut? false})))

(defn cut-table-cell!
  "Cut selected cell value"
  []
  (let [selected (get-in @state/app-state [:table-viewer :selected])
        row-idx (:row selected)
        col-name (:col selected)
        records (get-in @state/app-state [:table-viewer :records])
        value (when (and row-idx col-name)
                (get (nth records row-idx) (keyword col-name)))]
    (reset! table-clipboard {:value value :cut? true :row row-idx :col col-name})))

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
          (refresh-table-data!)
          (state/log-error! "Failed to create table record" "new-table-record" {:response (:body response)}))))))

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
              (swap! state/app-state assoc-in [:table-viewer :selected] nil)
              (refresh-table-data!))
            (state/log-error! "Failed to delete table record" "delete-table-record" {:response (:body response)})))))))

;; ============================================================
;; DESIGN EDITING — working copy, dirty tracking, save/revert
;; ============================================================

;; Map PG data_type to Access display type
(def ^:private pg-type->display-type
  {"character varying" "Short Text"
   "text"              "Long Text"
   "integer"           "Number"
   "smallint"          "Number"
   "bigint"            "Number"
   "real"              "Number"
   "double precision"  "Number"
   "numeric"           "Number"
   "boolean"           "Yes/No"
   "timestamp without time zone" "Date/Time"
   "date"              "Date/Time"
   "serial"            "AutoNumber"})

;; Map PG data_type to Number field size
(def ^:private pg-type->field-size
  {"smallint"         "Integer"
   "integer"          "Long Integer"
   "bigint"           "Long Integer"
   "real"             "Single"
   "double precision" "Double"
   "numeric"          "Decimal"})

(defn- normalize-field
  "Normalize a field from server data into design-editing format.
   Converts PG types to Access display names, derives fieldSize,
   detects identity/AutoNumber, and attaches :original-name for rename tracking."
  [field]
  (let [raw-type (:type field)
        is-identity (:isIdentity field false)
        ;; Convert PG type to display type
        display-type (if is-identity
                       "AutoNumber"
                       (or (pg-type->display-type raw-type) raw-type))
        ;; Derive fieldSize for Number types
        field-size (when (= display-type "Number")
                     (or (:fieldSize field)
                         (pg-type->field-size raw-type)
                         "Long Integer"))]
    {:name           (:name field)
     :type           display-type
     :nullable       (:nullable field true)
     :default        (:default field)
     :isPrimaryKey   (:isPrimaryKey field false)
     :isForeignKey   (:isForeignKey field false)
     :foreignTable   (:foreignTable field)
     :maxLength      (:maxLength field)
     :precision      (:precision field)
     :scale          (:scale field)
     :description    (:description field)
     :indexed        (:indexed field)
     :checkConstraint (:checkConstraint field)
     :fieldSize      field-size
     :original-name  (:name field)}))

(defn recompute-design-dirty!
  "Compare design-fields vs design-original to set dirty flag"
  []
  (let [fields (get-in @state/app-state [:table-viewer :design-fields])
        original (get-in @state/app-state [:table-viewer :design-original])
        desc (get-in @state/app-state [:table-viewer :table-description])
        orig-desc (get-in @state/app-state [:table-viewer :original-description])
        dirty? (or (not= fields original)
                   (not= desc orig-desc))]
    (swap! state/app-state assoc-in [:table-viewer :design-dirty?] dirty?)))

(defn init-design-editing!
  "Initialize design editing from current table-info"
  []
  (let [table-info (get-in @state/app-state [:table-viewer :table-info])
        fields (mapv normalize-field (:fields table-info))
        desc (:description table-info)]
    (swap! state/app-state update :table-viewer merge
           {:design-fields fields
            :design-original fields
            :design-dirty? false
            :design-renames {}
            :design-errors nil
            :table-description desc
            :original-description desc})))

(defn select-design-field!
  "Select a field by index in design mode"
  [idx]
  (swap! state/app-state assoc-in [:table-viewer :selected-field] idx))

(defn update-design-field!
  "Update a single property of a design field"
  [idx prop value]
  (let [old-field (get-in @state/app-state [:table-viewer :design-fields idx])]
    ;; Track renames using :original-name (survives deletions/reordering)
    (when (= prop :name)
      (let [orig-name (:original-name old-field)]
        ;; Only track rename if this was an existing field (original-name is non-nil)
        (when orig-name
          (if (not= orig-name value)
            (swap! state/app-state assoc-in [:table-viewer :design-renames orig-name] value)
            ;; If renamed back to original, remove from renames
            (swap! state/app-state update-in [:table-viewer :design-renames] dissoc orig-name)))))
    (swap! state/app-state assoc-in [:table-viewer :design-fields idx prop] value)
    (recompute-design-dirty!)))

(defn add-design-field!
  "Append an empty field to the design"
  []
  (let [new-field {:name "" :type "Short Text" :nullable true :default nil
                   :isPrimaryKey false :isForeignKey false :foreignTable nil
                   :maxLength 255 :precision nil :scale nil
                   :description nil :indexed nil :checkConstraint nil :fieldSize nil
                   :original-name nil}
        fields (get-in @state/app-state [:table-viewer :design-fields])
        new-idx (count fields)]
    (swap! state/app-state update-in [:table-viewer :design-fields] conj new-field)
    (select-design-field! new-idx)
    (recompute-design-dirty!)))

(defn remove-design-field!
  "Remove a field at index"
  [idx]
  (let [fields (get-in @state/app-state [:table-viewer :design-fields])
        selected (get-in @state/app-state [:table-viewer :selected-field])]
    (swap! state/app-state assoc-in [:table-viewer :design-fields]
           (into (subvec fields 0 idx) (subvec fields (inc idx))))
    ;; Adjust selection
    (when (= selected idx)
      (swap! state/app-state assoc-in [:table-viewer :selected-field] nil))
    (when (and (number? selected) (> selected idx))
      (swap! state/app-state assoc-in [:table-viewer :selected-field] (dec selected)))
    (recompute-design-dirty!)))

(defn toggle-design-pk!
  "Toggle isPrimaryKey on a field"
  [idx]
  (let [current (get-in @state/app-state [:table-viewer :design-fields idx :isPrimaryKey])]
    (swap! state/app-state assoc-in [:table-viewer :design-fields idx :isPrimaryKey] (not current))
    (recompute-design-dirty!)))

(defn update-table-description!
  "Update table description in design mode"
  [desc]
  (swap! state/app-state assoc-in [:table-viewer :table-description] desc)
  (recompute-design-dirty!))

(defn revert-design!
  "Reset design to original"
  []
  (let [original (get-in @state/app-state [:table-viewer :design-original])
        orig-desc (get-in @state/app-state [:table-viewer :original-description])]
    (swap! state/app-state update :table-viewer merge
           {:design-fields original
            :design-dirty? false
            :design-renames {}
            :design-errors nil
            :table-description orig-desc
            :selected-field nil})))

(defn- validate-design-fields
  "Validate design fields before save. Returns error messages or nil."
  [fields]
  (let [names (map :name fields)
        empty-names (filter #(or (nil? %) (= "" %)) names)
        dupes (->> names
                   frequencies
                   (filter (fn [[n c]] (and (not= "" n) (> c 1))))
                   (map first))]
    (cond-> []
      (seq empty-names) (conj {:message "All fields must have a name."})
      (seq dupes) (conj {:message (str "Duplicate field names: " (str/join ", " dupes))})
      (empty? fields) (conj {:message "At least one field is required."})
      true seq)))

(defn- strip-internal-keys
  "Remove internal keys before sending to server"
  [field]
  (dissoc field :checkConstraint :isForeignKey :foreignTable :original-name))

(defn- reload-table-after-save!
  "Re-fetch tables metadata and reinitialize design editing for the given table name.
   Uses async fetch instead of fragile setTimeout."
  [table-name]
  (go
    (let [response (<! (http/get (str state/api-base "/api/tables")
                                  {:headers (state/db-headers)}))]
      (when (:success response)
        (let [tables (get-in response [:body :tables])
              table-list (mapv (fn [t] (assoc t :id (:name t))) tables)]
          ;; Update the objects list
          (swap! state/app-state assoc-in [:objects :tables] table-list)
          ;; Find the updated table and reinitialize design
          (let [updated (first (filter #(= (:name %) table-name) table-list))]
            (when updated
              (swap! state/app-state assoc-in [:table-viewer :table-info] updated)
              (init-design-editing!))))))))

(defn- populate-graph!
  "Trigger graph populate after schema changes"
  []
  (go (<! (http/post (str state/api-base "/api/graph/populate")
                      {:headers (state/db-headers)}))))

(defn save-table-design!
  "Save modified table design to server via PUT"
  []
  (let [table-name (get-in @state/app-state [:table-viewer :table-info :name])
        fields (get-in @state/app-state [:table-viewer :design-fields])
        renames (get-in @state/app-state [:table-viewer :design-renames] {})
        description (get-in @state/app-state [:table-viewer :table-description])
        errors (validate-design-fields fields)]
    (swap! state/app-state assoc-in [:table-viewer :design-errors] nil)
    (if errors
      (swap! state/app-state assoc-in [:table-viewer :design-errors] (vec errors))
      (go
        (let [response (<! (http/put (str state/api-base "/api/tables/" table-name)
                                      {:json-params {:fields (mapv strip-internal-keys fields)
                                                     :renames renames
                                                     :description description}
                                       :headers (state/db-headers)}))]
          (if (:success response)
            (do
              (populate-graph!)
              (reload-table-after-save! table-name))
            (do
              (state/log-error! "Failed to save table design" "save-table-design" {:response (:body response)})
              (swap! state/app-state assoc-in [:table-viewer :design-errors]
                     [{:message (get-in response [:body :error] "Failed to save")}]))))))))

(defn start-new-table!
  "Initialize new table creation mode"
  []
  (let [default-pk {:name "id" :type "AutoNumber" :nullable false :default nil
                    :isPrimaryKey true :isForeignKey false :foreignTable nil
                    :maxLength nil :precision nil :scale nil
                    :description nil :indexed nil :checkConstraint nil :fieldSize nil
                    :original-name nil}]
    (swap! state/app-state assoc :table-viewer
           {:table-id nil
            :table-info nil
            :records []
            :view-mode :design
            :loading? false
            :design-fields [default-pk]
            :design-original []
            :design-dirty? true
            :design-renames {}
            :design-errors nil
            :new-table? true
            :new-table-name ""
            :table-description nil
            :original-description nil
            :selected-field 0})
    ;; Open a tab for the new table
    (swap! state/app-state assoc :active-tab {:type :tables :id :new-table})))

(defn- validate-new-table-name
  "Validate a new table name, returning error vector or nil."
  [table-name]
  (seq (cond-> []
         (or (nil? table-name) (= "" table-name))
         (conj {:message "Table name is required."})
         (and (not= "" (or table-name ""))
              (not (re-matches #"^[a-zA-Z_][a-zA-Z0-9_]*$" (or table-name ""))))
         (conj {:message "Invalid table name. Use letters, digits, underscores."}))))

(defn- refresh-tables-and-open!
  "Re-fetch tables from API and open the named table."
  [table-name]
  (go
    (let [response (<! (http/get (str state/api-base "/api/tables")
                                  {:headers (state/db-headers)}))]
      (when (:success response)
        (let [table-list (mapv #(assoc % :id (:name %)) (get-in response [:body :tables]))]
          (swap! state/app-state assoc-in [:objects :tables] table-list)
          (when-let [new-table (first (filter #(= (:name %) table-name) table-list))]
            (state/open-object! :tables (:id new-table))))))))

(defn save-new-table!
  "Create new table via POST"
  []
  (let [table-name (get-in @state/app-state [:table-viewer :new-table-name])
        fields (get-in @state/app-state [:table-viewer :design-fields])
        description (get-in @state/app-state [:table-viewer :table-description])
        all-errors (seq (concat (validate-new-table-name table-name)
                                (validate-design-fields fields)))]
    (swap! state/app-state assoc-in [:table-viewer :design-errors] nil)
    (if all-errors
      (swap! state/app-state assoc-in [:table-viewer :design-errors] (vec all-errors))
      (go
        (let [response (<! (http/post (str state/api-base "/api/tables")
                                       {:json-params {:name table-name
                                                      :fields (mapv strip-internal-keys fields)
                                                      :description description}
                                        :headers (state/db-headers)}))]
          (if (:success response)
            (do (populate-graph!)
                (<! (refresh-tables-and-open! table-name)))
            (swap! state/app-state assoc-in [:table-viewer :design-errors]
                   [{:message (get-in response [:body :error] "Failed to create table")}])))))))

(defn set-new-table-name!
  "Set the name for a new table"
  [name]
  (swap! state/app-state assoc-in [:table-viewer :new-table-name] name))
