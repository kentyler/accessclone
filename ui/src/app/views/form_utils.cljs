(ns app.views.form-utils
  "Utility functions for the form editor.
   Shared functions delegated to editor-utils; form-specific functions here."
  (:require [app.views.editor-utils :as eu]))

;; --- Re-export shared functions ---
(def snap-to-grid eu/snap-to-grid)
(def get-record-source-fields eu/get-record-source-fields)
(def get-section-controls eu/get-section-controls)
(def control-style eu/control-style)
(def resolve-control-field eu/resolve-control-field)
(def resolve-field-value eu/resolve-field-value)
(def display-text eu/display-text)
(def format-value eu/format-value)
(def parse-input-mask eu/parse-input-mask)
(def mask-placeholder eu/mask-placeholder)
(def strip-access-hotkey eu/strip-access-hotkey)
(def render-hotkey-text eu/render-hotkey-text)
(def extract-hotkey eu/extract-hotkey)

;; --- Form-specific functions ---

(defn get-section-height
  "Get height of a form section, with form-specific defaults"
  [form-def section]
  (or (get-in form-def [section :height])
      (case section
        :header 40
        :detail 200
        :footer 40)))

