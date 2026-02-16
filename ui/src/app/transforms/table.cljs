(ns app.transforms.table
  "Pure table transforms — (state, args) -> state.
   19 transforms covering field selection, cell editing, context menu,
   clipboard, new table name, design revert, and design editing.")

;; ============================================================
;; FIELD & CELL SELECTION
;; ============================================================

(defn select-table-field [state field-name]
  (assoc-in state [:table-viewer :selected-field] field-name))

(defn select-table-cell [state row-idx col-name]
  (-> state
      (assoc-in [:table-viewer :selected] {:row row-idx :col col-name})
      (assoc-in [:table-viewer :context-menu :visible] false)))

(defn select-table-row [state row-idx]
  (assoc-in state [:table-viewer :selected] {:row row-idx :col nil}))

;; ============================================================
;; CELL EDITING
;; ============================================================

(defn start-editing-cell [state row-idx col-name]
  (-> state
      (assoc-in [:table-viewer :selected] {:row row-idx :col col-name})
      (assoc-in [:table-viewer :editing] {:row row-idx :col col-name})))

(defn stop-editing-cell [state]
  (assoc-in state [:table-viewer :editing] nil))

(defn move-to-next-cell [state shift?]
  (let [selected (get-in state [:table-viewer :selected])
        fields (get-in state [:table-viewer :table-info :fields])
        records (get-in state [:table-viewer :records])
        col-names (mapv :name fields)
        row-idx (:row selected)
        col-name (:col selected)
        col-idx (.indexOf col-names col-name)
        [new-row new-col]
        (if shift?
          ;; Move backwards
          (if (> col-idx 0)
            [row-idx (nth col-names (dec col-idx))]
            (when (> row-idx 0)
              [(dec row-idx) (last col-names)]))
          ;; Move forwards
          (if (< col-idx (dec (count col-names)))
            [row-idx (nth col-names (inc col-idx))]
            (when (< row-idx (dec (count records)))
              [(inc row-idx) (first col-names)])))]
    (if (and new-row new-col)
      (-> state
          (assoc-in [:table-viewer :selected] {:row new-row :col new-col})
          (assoc-in [:table-viewer :editing] {:row new-row :col new-col}))
      state)))

;; ============================================================
;; CONTEXT MENU
;; ============================================================

(defn show-table-context-menu [state x y]
  (assoc-in state [:table-viewer :context-menu]
            {:visible true :x x :y y}))

(defn hide-table-context-menu [state]
  (assoc-in state [:table-viewer :context-menu :visible] false))

;; ============================================================
;; CLIPBOARD
;; ============================================================

(defn copy-table-cell
  "Pure version returns state unchanged — clipboard is an external atom."
  [state]
  state)

(defn cut-table-cell
  "Pure version returns state unchanged — clipboard is an external atom."
  [state]
  state)

;; ============================================================
;; NEW TABLE & DESIGN
;; ============================================================

(defn set-new-table-name [state name]
  (assoc-in state [:table-viewer :new-table-name] name))

(defn revert-design [state]
  (let [original (get-in state [:table-viewer :design-original])
        orig-desc (get-in state [:table-viewer :original-description])]
    (update state :table-viewer merge
            {:design-fields original
             :design-dirty? false
             :design-renames {}
             :design-errors nil
             :table-description orig-desc
             :selected-field nil})))

;; ============================================================
;; DESIGN EDITING
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
  "Normalize a field from server data into design-editing format."
  [field]
  (let [raw-type (:type field)
        is-identity (:isIdentity field false)
        display-type (if is-identity
                       "AutoNumber"
                       (or (pg-type->display-type raw-type) raw-type))
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

(defn- recompute-design-dirty
  "Compare design-fields vs design-original to set dirty flag (pure)."
  [state]
  (let [fields (get-in state [:table-viewer :design-fields])
        original (get-in state [:table-viewer :design-original])
        desc (get-in state [:table-viewer :table-description])
        orig-desc (get-in state [:table-viewer :original-description])
        dirty? (or (not= fields original) (not= desc orig-desc))]
    (assoc-in state [:table-viewer :design-dirty?] dirty?)))

(defn init-design-editing [state]
  (let [table-info (get-in state [:table-viewer :table-info])
        fields (mapv normalize-field (:fields table-info))
        desc (:description table-info)]
    (update state :table-viewer merge
            {:design-fields fields
             :design-original fields
             :design-dirty? false
             :design-renames {}
             :design-errors nil
             :table-description desc
             :original-description desc})))

(defn select-design-field [state idx]
  (assoc-in state [:table-viewer :selected-field] idx))

(defn update-design-field [state idx prop value]
  (let [old-field (get-in state [:table-viewer :design-fields idx])
        ;; Track renames using :original-name
        state (if (= prop :name)
                (let [orig-name (:original-name old-field)]
                  (if orig-name
                    (if (not= orig-name value)
                      (assoc-in state [:table-viewer :design-renames orig-name] value)
                      (update-in state [:table-viewer :design-renames] dissoc orig-name))
                    state))
                state)]
    (-> state
        (assoc-in [:table-viewer :design-fields idx prop] value)
        (recompute-design-dirty))))

(defn add-design-field [state]
  (let [new-field {:name "" :type "Short Text" :nullable true :default nil
                   :isPrimaryKey false :isForeignKey false :foreignTable nil
                   :maxLength 255 :precision nil :scale nil
                   :description nil :indexed nil :checkConstraint nil :fieldSize nil
                   :original-name nil}
        fields (get-in state [:table-viewer :design-fields])
        new-idx (count fields)]
    (-> state
        (update-in [:table-viewer :design-fields] conj new-field)
        (assoc-in [:table-viewer :selected-field] new-idx)
        (recompute-design-dirty))))

(defn remove-design-field [state idx]
  (let [fields (get-in state [:table-viewer :design-fields])
        selected (get-in state [:table-viewer :selected-field])
        state (-> state
                  (assoc-in [:table-viewer :design-fields]
                            (into (subvec fields 0 idx) (subvec fields (inc idx))))
                  (recompute-design-dirty))]
    (cond
      (= selected idx)
      (assoc-in state [:table-viewer :selected-field] nil)

      (and (number? selected) (> selected idx))
      (assoc-in state [:table-viewer :selected-field] (dec selected))

      :else state)))

(defn toggle-design-pk [state idx]
  (let [current (get-in state [:table-viewer :design-fields idx :isPrimaryKey])]
    (-> state
        (assoc-in [:table-viewer :design-fields idx :isPrimaryKey] (not current))
        (recompute-design-dirty))))

(defn update-table-description [state desc]
  (-> state
      (assoc-in [:table-viewer :table-description] desc)
      (recompute-design-dirty)))
