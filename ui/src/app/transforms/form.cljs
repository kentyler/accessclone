(ns app.transforms.form
  "Pure form transforms — (state, args) -> state.
   17 transforms covering form definition, lint, context menu, records,
   controls, caches, clipboard, header/footer toggle, and properties tab."
  (:require [clojure.string :as str]))

;; ============================================================
;; FORM DEFINITION & LINT
;; ============================================================

(defn set-form-definition [state definition]
  (-> state
      (assoc-in [:form-editor :current] definition)
      (assoc-in [:form-editor :dirty?]
                (not= definition (get-in state [:form-editor :original])))))

(defn clear-lint-errors [state]
  (assoc-in state [:form-editor :lint-errors] nil))

(defn set-lint-errors [state errors]
  (assoc-in state [:form-editor :lint-errors] errors))

;; ============================================================
;; FORM VIEW CONTEXT MENU
;; ============================================================

(defn show-form-context-menu [state x y]
  (assoc-in state [:form-editor :context-menu]
            {:visible true :x x :y y}))

(defn hide-form-context-menu [state]
  (assoc-in state [:form-editor :context-menu :visible] false))

;; ============================================================
;; RECORD OPERATIONS
;; ============================================================

(defn- collect-default-values
  "Scan form controls for :default-value and return a map of {field-keyword value}."
  [form-def]
  (let [all-controls (mapcat #(get-in form-def [% :controls] []) [:header :detail :footer])]
    (reduce (fn [m ctrl]
              (let [dv (:default-value ctrl)
                    field (when (and dv (not (str/blank? (str dv))))
                            (or (:control-source ctrl) (:field ctrl)))]
                (if field
                  (assoc m (keyword (str/lower-case field)) dv)
                  m)))
            {} all-controls)))

(defn new-record [state]
  (let [total (get-in state [:form-editor :record-position :total] 0)
        form-def (get-in state [:form-editor :current])
        defaults (collect-default-values form-def)
        new-record (merge defaults {:__new__ true})]
    (-> state
        (update-in [:form-editor :records] #(conj (vec %) new-record))
        (assoc-in [:form-editor :current-record] new-record)
        (assoc-in [:form-editor :record-position] {:current (inc total) :total (inc total)})
        (assoc-in [:form-editor :record-dirty?] true))))

(defn set-current-record [state record]
  (assoc-in state [:form-editor :current-record] record))

(defn set-record-position [state pos total]
  (assoc-in state [:form-editor :record-position] {:current pos :total total}))

;; ============================================================
;; CONTROL OPERATIONS
;; ============================================================

(defn select-control [state idx]
  (assoc-in state [:form-editor :selected-control] idx))

(defn delete-control [state section idx]
  (let [current (get-in state [:form-editor :current])
        controls (or (get-in current [section :controls]) [])]
    (if (< idx (count controls))
      (let [new-controls (vec (concat (subvec controls 0 idx)
                                      (subvec controls (inc idx))))
            new-def (assoc-in current [section :controls] new-controls)]
        (-> state
            (assoc-in [:form-editor :selected-control] nil)
            (assoc-in [:form-editor :current] new-def)
            (assoc-in [:form-editor :dirty?]
                      (not= new-def (get-in state [:form-editor :original])))))
      state)))

(defn update-control [state section idx prop value]
  (let [current (get-in state [:form-editor :current])
        controls (or (get-in current [section :controls]) [])]
    (if (< idx (count controls))
      (let [new-def (assoc-in current [section :controls]
                              (update controls idx assoc prop value))]
        (-> state
            (assoc-in [:form-editor :current] new-def)
            (assoc-in [:form-editor :dirty?]
                      (not= new-def (get-in state [:form-editor :original])))))
      state)))

;; ============================================================
;; CACHES
;; ============================================================

(defn clear-row-source-cache [state]
  (assoc-in state [:form-editor :row-source-cache] {}))

(defn cache-row-source [state row-source data]
  (assoc-in state [:form-editor :row-source-cache row-source] data))

(defn clear-subform-cache [state]
  (assoc-in state [:form-editor :subform-cache] {}))

;; ============================================================
;; CLIPBOARD
;; ============================================================

(defn copy-form-record
  "Copy current record to clipboard. Returns state unchanged since clipboard
   is an external atom. The caller should handle the external clipboard write."
  [state]
  ;; Pure version returns state unchanged — clipboard is a side effect.
  ;; The record to copy is available at [:form-editor :current-record].
  state)

;; ============================================================
;; HEADER/FOOTER TOGGLE
;; ============================================================

(defn toggle-form-header-footer [state]
  (let [current (get-in state [:form-editor :current])
        ;; Header/footer are "visible" if the section exists and isn't hidden
        has-sections? (or (:header current) (:footer current))
        hide-section (fn [def section]
                       (if (get def section)
                         (-> def
                             (assoc-in [section :_saved-height]
                                       (get-in def [section :height] 80))
                             (assoc-in [section :height] 0)
                             (assoc-in [section :visible] 0))
                         def))
        show-section (fn [def section]
                       (let [existing (get def section)]
                         (if existing
                           (-> def
                               (assoc-in [section :height]
                                         (get-in def [section :_saved-height] 80))
                               (assoc-in [section :visible] 1))
                           (assoc def section {:height 80 :controls [] :visible 1}))))]
    (if current
      (let [new-def (if has-sections?
                      (-> current (hide-section :header) (hide-section :footer))
                      (-> current (show-section :header) (show-section :footer)))]
        (-> state
            (assoc-in [:form-editor :current] new-def)
            (assoc-in [:form-editor :dirty?]
                      (not= new-def (get-in state [:form-editor :original])))))
      state)))

;; ============================================================
;; PROPERTIES TAB
;; ============================================================

(defn set-form-properties-tab [state tab]
  (assoc-in state [:form-editor :properties-tab] tab))
