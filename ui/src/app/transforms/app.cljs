(ns app.transforms.app
  "Pure transforms for app-viewer state — (state, args) -> state.")

(defn set-app-pane
  "Switch the active pane in the App Viewer."
  [state pane]
  (assoc-in state [:app-viewer :active-pane] pane))

(defn set-app-overview
  "Store the overview data from GET /api/app/overview."
  [state overview]
  (assoc-in state [:app-viewer :overview] overview))

(defn set-app-loading
  "Set loading state for the App Viewer."
  [state loading?]
  (assoc-in state [:app-viewer :loading?] loading?))

;; Phase 4: Batch extraction state
(defn set-batch-extracting
  "Set whether batch intent extraction is in progress."
  [state extracting?]
  (assoc-in state [:app-viewer :batch-extracting?] extracting?))

(defn set-batch-progress
  "Update batch extraction progress."
  [state progress]
  (assoc-in state [:app-viewer :batch-progress] progress))

(defn set-all-gap-questions
  "Store collected gap questions from batch extraction."
  [state questions]
  (assoc-in state [:app-viewer :all-gap-questions] questions))

(defn set-app-gap-selection
  "Set the user's selection for a gap question by index."
  [state idx suggestion]
  (assoc-in state [:app-viewer :all-gap-questions idx :selected] suggestion))

(defn set-submitting-gaps
  "Set whether gap decisions are being submitted."
  [state submitting?]
  (assoc-in state [:app-viewer :submitting-gaps?] submitting?))

;; Phase 5: Dependencies and API surface
(defn set-app-dependencies
  "Store dependency summary data."
  [state deps]
  (assoc-in state [:app-viewer :dependencies] deps))

(defn set-app-api-surface
  "Store API surface data."
  [state surface]
  (assoc-in state [:app-viewer :api-surface] surface))

;; Phase 6: Import mode
(defn set-import-mode
  "Set the import automation mode (:manual, :guided, :autonomous)."
  [state mode]
  (assoc-in state [:app-viewer :import-mode] mode))
