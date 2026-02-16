(ns app.transforms.table
  "Pure table transforms — (state, args) -> state.
   12 transforms covering field selection, cell editing, context menu,
   clipboard, new table name, and design revert.")

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
