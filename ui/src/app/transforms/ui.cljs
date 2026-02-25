(ns app.transforms.ui
  "Pure UI transforms — (state, args) -> state.
   19 transforms covering loading, error, database selection, sidebar, objects, config, context menu, assessment.")

;; Loading / Error
(defn set-loading [state loading?]
  (assoc state :loading? loading?))

(defn set-error [state error]
  (assoc state :error error))

(defn clear-error [state]
  (assoc state :error nil))

;; Database selection
(defn set-available-databases [state databases]
  (assoc state :available-databases databases))

(defn set-current-database [state db]
  (assoc state :current-database db))

(defn set-loading-objects [state loading?]
  (assoc state :loading-objects? loading?))

;; Sidebar
(defn toggle-sidebar [state]
  (update state :sidebar-collapsed? not))

(defn set-sidebar-object-type [state object-type]
  (assoc state :sidebar-object-type object-type))

;; Objects
(defn set-objects [state object-type objects]
  (assoc-in state [:objects object-type] objects))

(defn add-object [state object-type obj]
  (update-in state [:objects object-type] conj obj))

(defn update-object [state object-type id updates]
  (update-in state [:objects object-type]
             (fn [objects]
               (mapv (fn [obj]
                       (if (= (:id obj) id)
                         (merge obj updates)
                         obj))
                     objects))))

;; Options dialog
(defn open-options-dialog [state]
  (assoc state :options-dialog-open? true))

(defn close-options-dialog [state]
  (assoc state :options-dialog-open? false))

;; Config
(defn set-grid-size [state size]
  (assoc-in state [:config :form-designer :grid-size] size))

;; Context menu
(defn show-context-menu [state x y]
  (assoc state :context-menu {:x x :y y :visible? true}))

(defn hide-context-menu [state]
  (assoc-in state [:context-menu :visible?] false))

;; Pre-import assessment
(defn set-assessment [state findings & [scan-summary]]
  (assoc state :assessment-findings findings
               :assessment-checked #{}
               :assessment-scan-summary scan-summary
               :assessing? false))

(defn toggle-assessment-check [state finding-id]
  (update state :assessment-checked
          (fn [checked]
            (let [checked (or checked #{})]
              (if (contains? checked finding-id)
                (disj checked finding-id)
                (conj checked finding-id))))))

(defn clear-assessment [state]
  (assoc state :assessment-findings nil
               :assessment-checked #{}
               :assessment-scan-summary nil
               :assessing? false))
