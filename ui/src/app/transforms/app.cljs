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

(defn set-batch-extract-results
  "Store batch intent extraction results summary."
  [state results]
  (assoc-in state [:app-viewer :batch-extract-results] results))

;; Phase 5: Dependencies and API surface
(defn set-app-dependencies
  "Store dependency summary data."
  [state deps]
  (assoc-in state [:app-viewer :dependencies] deps))

(defn set-app-api-surface
  "Store API surface data."
  [state surface]
  (assoc-in state [:app-viewer :api-surface] surface))

;; Batch code generation state
(defn set-batch-generating
  "Set whether batch code generation is in progress."
  [state generating?]
  (assoc-in state [:app-viewer :batch-generating?] generating?))

(defn set-batch-gen-progress
  "Update batch code generation progress (pass, current-module, counts)."
  [state progress]
  (assoc-in state [:app-viewer :batch-gen-progress] progress))

(defn set-batch-gen-results
  "Store batch code generation results summary."
  [state results]
  (assoc-in state [:app-viewer :batch-gen-results] results))

;; LLM auto-resolve gaps
(defn set-auto-resolving-gaps
  "Set whether LLM auto-resolve is in progress."
  [state resolving?]
  (assoc-in state [:app-viewer :auto-resolving-gaps?] resolving?))

(defn set-all-gap-selections
  "Bulk-set selections for all gap questions from LLM auto-resolve."
  [state selections]
  (reduce (fn [s {:keys [index selected]}]
            (assoc-in s [:app-viewer :all-gap-questions index :selected] selected))
          state selections))

;; Phase 6: Import mode
(defn set-import-mode
  "Set the import automation mode (:manual, :guided, :autonomous)."
  [state mode]
  (assoc-in state [:app-viewer :import-mode] mode))

;; Per-module pipeline tracking
(defn set-module-pipeline-status
  "Set pipeline status for a single module.
   status: {:step :name :status :pending|:running|:done|:failed :error? :results?}"
  [state module-name status]
  (assoc-in state [:app-viewer :module-pipeline module-name] status))

(defn set-module-pipeline-statuses
  "Bulk-set pipeline statuses for all modules from GET /api/pipeline/status."
  [state modules]
  (reduce (fn [s {:keys [name] :as mod}]
            (assoc-in s [:app-viewer :module-pipeline name] mod))
          state modules))

(defn set-pipeline-running
  "Set whether a pipeline operation is currently running."
  [state running?]
  (assoc-in state [:app-viewer :pipeline-running?] running?))
