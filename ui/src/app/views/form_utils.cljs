(ns app.views.form-utils
  "Shared utility functions for the form editor"
  (:require [app.state :as state]))

(defn snap-to-grid
  "Snap a coordinate to the nearest grid point.
   If ctrl-key? is true, return the original value (pixel-perfect positioning)."
  [value ctrl-key?]
  (if ctrl-key?
    value
    (let [grid-size (state/get-grid-size)]
      (* grid-size (js/Math.round (/ value grid-size))))))

(defn get-record-source-fields
  "Get fields for the current record source (table or query)"
  [record-source]
  (when record-source
    (let [tables (get-in @state/app-state [:objects :tables])
          queries (get-in @state/app-state [:objects :queries])
          ;; Check if it's a query (ends with " (query)" in display, but stored as just name)
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

(defn get-section-controls
  "Get controls for a specific section (header, detail, or footer)"
  [form-def section]
  (or (get-in form-def [section :controls]) []))

(defn get-section-height
  "Get height of a section, with defaults"
  [form-def section]
  (or (get-in form-def [section :height])
      (case section
        :header 40
        :detail 200
        :footer 40)))

(defn get-section-above
  "Get the section above the given divider"
  [section]
  (case section
    :detail :header
    :footer :detail
    nil))
