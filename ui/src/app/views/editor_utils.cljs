(ns app.views.editor-utils
  "Shared utility functions for both form and report editors.
   Consolidates duplicate functions from form-utils and report-utils."
  (:require [clojure.string :as str]
            [app.state :as state]
            [app.views.expressions :as expr]))

(defn snap-to-grid
  "Snap a coordinate to the nearest grid point.
   If ctrl-key? is true, return the original value (pixel-perfect positioning)."
  [value ctrl-key?]
  (if ctrl-key?
    value
    (let [grid-size (state/get-grid-size)]
      (* grid-size (js/Math.round (/ value grid-size))))))

(defn get-record-source-fields
  "Get fields for a record source (table or query name)"
  [record-source]
  (when record-source
    (let [tables (get-in @state/app-state [:objects :tables])
          queries (get-in @state/app-state [:objects :queries])
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

(defn get-section-controls
  "Get controls for a specific section"
  [def section]
  (or (get-in def [section :controls]) []))

(defn control-style
  "Position and size style map for a control"
  [ctrl]
  {:left (:x ctrl)
   :top (:y ctrl)
   :width (:width ctrl)
   :height (:height ctrl)})

(defn resolve-control-field
  "Get the bound field name from a control, normalized to lowercase.
   Checks :control-source (Property Sheet) then :field (drag-drop).
   Returns the raw string (with =) for expressions."
  [ctrl]
  (when-let [raw-field (or (:control-source ctrl) (:field ctrl))]
    (if (expr/expression? raw-field)
      raw-field
      (str/lower-case raw-field))))

(defn resolve-field-value
  "Look up a field's value from a record.
   If field starts with '=', evaluates it as an Access expression.
   Optional expr-context provides :group-records and :all-records for aggregates."
  ([field record]
   (resolve-field-value field record nil))
  ([field record expr-context]
   (when field
     (if (expr/expression? field)
       (expr/evaluate-expression
         (subs field 1)
         (merge {:record record} expr-context))
       (or (get record (keyword field))
           (get record field)
           "")))))

(defn display-text
  "Get display text from a control, checking common text keys"
  [ctrl]
  (or (:text ctrl) (:label ctrl) (:caption ctrl) ""))
