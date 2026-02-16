(ns app.flows.form
  "Form flows — load, save, view mode, records, session functions.

   Decomposes async functions from state_form.cljs into transform+effect sequences."
  (:require [app.state :as state :refer [app-state api-base db-headers session-id
                                          build-data-query-params record->api-map
                                          detect-pk-field pk-value-for-record
                                          normalize-control]]
            [app.state-form :as state-form]
            [app.effects.http :as http]
            [app.transforms.core :as t]
            [clojure.string :as str]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; FORM LOAD
;; ============================================================

(defn load-form-for-editing-flow
  "Auto-save → clear caches → fetch definition → normalize → setup editor → auto-analyze.
   Original: state_form.cljs/load-form-for-editing!

   Context requires: {:form {:id :filename :definition?}}"
  []
  [;; Clear caches
   {:step :transform :name :clear-row-source-cache}
   {:step :transform :name :clear-subform-cache}
   ;; Fetch definition if not already present
   {:step :branch
    :test (fn [ctx] (nil? (get-in ctx [:form :definition])))
    :then [{:step :do
            :fn (fn [ctx]
                  (go
                    (let [response (<! (http/get!
                                         (str api-base "/api/forms/"
                                              (get-in ctx [:form :filename]))
                                         :headers (db-headers)))]
                      (if (:ok? response)
                        (assoc ctx :definition
                               (dissoc (:data response) :id :name))
                        (do (state/log-error!
                              (str "Failed to load form: " (get-in ctx [:form :filename]))
                              "load-form-for-editing")
                            (assoc ctx :abort? true))))))}]}
   ;; Setup editor with normalized definition
   {:step :branch
    :test (fn [ctx] (not (:abort? ctx)))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [form (:form ctx)
                        raw-def (or (:definition ctx) (:definition form))
                        definition (app.state-form/normalize-form-definition raw-def)]
                    (swap! app-state assoc :form-editor
                           {:form-id (:id form)
                            :dirty? false
                            :original definition
                            :current definition
                            :selected-control nil
                            :synced-controls (app.state-form/build-synced-controls definition)})
                    (state/maybe-auto-analyze!)
                    ctx))}]}])

;; ============================================================
;; FORM SAVE
;; ============================================================

(def save-form-flow
  "Lint → save if valid → show errors if not.
   Original: state_form.cljs/save-form!

   Sequence: clear-lint-errors → POST lint → branch(valid? → do-save : set-errors)"
  [;; Clear previous errors
   {:step :transform :name :clear-lint-errors}
   ;; Lint the form
   {:step :do
    :fn (fn [ctx]
          (let [state @app-state
                current (get-in state [:form-editor :current])
                form-id (get-in state [:form-editor :form-id])
                form-obj (first (filter #(= (:id %) form-id)
                                        (get-in state [:objects :forms])))
                form-with-meta (merge {:id form-id :name (:name form-obj)} current)]
            (assoc ctx :form-with-meta form-with-meta :form-id form-id :current current)))}
   {:step :effect
    :name :lint-form
    :opts-fn (fn [ctx] {:headers (db-headers) :json-params {:form (:form-with-meta ctx)}})
    :as :lint-response}
   ;; Branch on lint result
   {:step :branch
    :test (fn [ctx]
            (or (not (get-in ctx [:lint-response :ok?]))  ; lint failed — save anyway
                (get-in ctx [:lint-response :data :valid])))
    :then [;; Save: update objects, mark clean, save to file
           {:step :do
            :fn (fn [ctx]
                  (let [current (:current ctx)
                        form-id (:form-id ctx)]
                    (state/update-object! :forms form-id {:definition current})
                    (swap! app-state update :open-objects
                           (fn [tabs]
                             (mapv (fn [tab]
                                     (if (and (= (:type tab) :forms) (= (:id tab) form-id))
                                       (assoc tab :name (:name current))
                                       tab))
                                   tabs)))
                    (swap! app-state assoc-in [:form-editor :dirty?] false)
                    (swap! app-state assoc-in [:form-editor :original] current)
                    ctx))}
           ;; Save to API
           {:step :do
            :fn (fn [ctx]
                  (let [form (first (filter #(= (:id %) (:form-id ctx))
                                            (get-in @app-state [:objects :forms])))]
                    (app.state-form/save-form-to-file! form)
                    ctx))}]
    :else [;; Show lint errors
           {:step :do
            :fn (fn [ctx]
                  (t/dispatch! :set-lint-errors (get-in ctx [:lint-response :data :errors]))
                  ctx)}]}])

;; ============================================================
;; RECORD OPERATIONS
;; ============================================================

(def save-current-record-flow
  "Validate → before-update hook → insert or update.
   Original: state_form.cljs/save-current-record!

   Sequence: validate-record → run-before-update-hook → branch(new? → insert : update)"
  [{:step :do
    :fn (fn [ctx]
          (let [state @app-state
                record-source (get-in state [:form-editor :current :record-source])
                current-record (get-in state [:form-editor :current-record])
                form-def (get-in state [:form-editor :current])
                pos (get-in state [:form-editor :record-position :current] 1)
                record-dirty? (get-in state [:form-editor :record-dirty?])
                fields (app.state-form/get-record-source-fields record-source)
                pk-from-fields (some #(when (:pk %) (:name %)) fields)
                pk-field-name (or pk-from-fields "id")
                pk-value (pk-value-for-record current-record pk-field-name)
                is-new? (or (:__new__ current-record) (nil? pk-value) (= pk-value ""))]
            (assoc ctx
                   :record-source record-source
                   :current-record current-record
                   :form-def form-def
                   :pos pos
                   :record-dirty? record-dirty?
                   :pk-field-name pk-field-name
                   :pk-value pk-value
                   :is-new? is-new?
                   :record-for-api (record->api-map current-record))))}
   {:step :branch
    :test (fn [ctx] (and (:record-source ctx) (:current-record ctx) (:record-dirty? ctx)))
    :then [{:step :branch
            :test (fn [ctx] (:is-new? ctx))
            ;; INSERT
            :then [{:step :do
                    :fn (fn [ctx]
                          (go
                            (let [insert-data (if (= (:pk-field-name ctx) "id")
                                                (dissoc (:record-for-api ctx) "id")
                                                (:record-for-api ctx))
                                  response (<! (http/post!
                                                 (str api-base "/api/data/" (:record-source ctx))
                                                 :headers (db-headers)
                                                 :json-params insert-data))]
                              (if (:ok? response)
                                (let [new-record (:data response)]
                                  (swap! app-state assoc-in [:form-editor :records (dec (:pos ctx))] new-record)
                                  (swap! app-state assoc-in [:form-editor :current-record] new-record)
                                  (swap! app-state assoc-in [:form-editor :record-dirty?] false))
                                (state/log-error! "Failed to insert record" "save-record"))
                              ctx)))}]
            ;; UPDATE
            :else [{:step :do
                    :fn (fn [ctx]
                          (go
                            (let [update-data (dissoc (:record-for-api ctx) (:pk-field-name ctx))
                                  response (<! (http/put!
                                                 (str api-base "/api/data/" (:record-source ctx) "/" (:pk-value ctx))
                                                 :headers (db-headers)
                                                 :json-params update-data))]
                              (if (:ok? response)
                                (let [updated-record (:data response)]
                                  (swap! app-state assoc-in [:form-editor :records (dec (:pos ctx))] updated-record)
                                  (swap! app-state assoc-in [:form-editor :current-record] updated-record)
                                  (swap! app-state assoc-in [:form-editor :record-dirty?] false))
                                (state/log-error! "Failed to update record" "save-record"))
                              ctx)))}]}]}])

(def navigate-to-record-flow
  "Auto-save → move to position → sync state → fire on-current.
   Original: state_form.cljs/navigate-to-record!

   Context requires: {:position number}"
  [{:step :do
    :fn (fn [ctx]
          (let [state @app-state
                records (get-in state [:form-editor :records] [])
                total (count records)
                pos (max 1 (min total (:position ctx)))]
            (when (and (> total 0) (<= pos total))
              (t/dispatch! :set-record-position pos total)
              (t/dispatch! :set-current-record (nth records (dec pos)))
              (swap! app-state assoc-in [:form-editor :record-dirty?] false))
            ctx))}])

(def delete-current-record-flow
  "Delete via API → update state.
   Original: state_form.cljs/delete-current-record!"
  [{:step :do
    :fn (fn [ctx]
          (let [state @app-state
                record-source (get-in state [:form-editor :current :record-source])
                current-record (get-in state [:form-editor :current-record])
                records (get-in state [:form-editor :records] [])
                pos (get-in state [:form-editor :record-position :current] 1)
                fields (app.state-form/get-record-source-fields record-source)
                pk-field-name (detect-pk-field fields)
                pk-value (pk-value-for-record current-record pk-field-name)]
            (assoc ctx :record-source record-source :pk-value pk-value
                   :records records :pos pos)))}
   {:step :branch
    :test (fn [ctx] (:pk-value ctx))
    :then [{:step :do
            :fn (fn [ctx]
                  (go
                    (let [response (<! (http/delete!
                                         (str api-base "/api/data/" (:record-source ctx) "/" (:pk-value ctx))
                                         :headers (db-headers)))]
                      (if (:ok? response)
                        (let [pos (:pos ctx)
                              records (:records ctx)
                              new-records (vec (concat (subvec records 0 (dec pos))
                                                       (subvec records pos)))
                              new-total (count new-records)
                              new-pos (min pos new-total)]
                          (swap! app-state assoc-in [:form-editor :records] new-records)
                          (if (> new-total 0)
                            (do (swap! app-state assoc-in [:form-editor :record-position] {:current new-pos :total new-total})
                                (swap! app-state assoc-in [:form-editor :current-record] (nth new-records (dec new-pos))))
                            (do (swap! app-state assoc-in [:form-editor :record-position] {:current 0 :total 0})
                                (swap! app-state assoc-in [:form-editor :current-record] {})))
                          (swap! app-state assoc-in [:form-editor :record-dirty?] false))
                        (state/log-error! "Failed to delete record" "delete-record"))
                      ctx)))}]}])

;; ============================================================
;; VIEW MODE
;; ============================================================

(def set-view-mode-flow
  "Switch mode → load records if entering view mode.
   Original: state_form.cljs/set-view-mode!

   Context requires: {:mode :design|:view}"
  [{:step :do
    :fn (fn [ctx]
          (swap! app-state assoc-in [:form-editor :view-mode] (:mode ctx))
          ctx)}
   {:step :branch
    :test (fn [ctx] (= (:mode ctx) :view))
    :then [{:step :do
            :fn (fn [ctx]
                  (let [record-source (get-in @app-state [:form-editor :current :record-source])]
                    (when record-source
                      (app.state-form/load-form-records! record-source))
                    ctx))}]}])

;; ============================================================
;; FORM STATE SYNC
;; ============================================================

(def sync-form-state-flow
  "PUT /api/form-state — upsert tagged control values.
   Original: state_form.cljs/sync-form-state!

   Context requires: {:entries [{:tableName :columnName :value}]}"
  [{:step :branch
    :test (fn [ctx] (seq (:entries ctx)))
    :then [{:step :effect
            :name :sync-form-state
            :opts-fn (fn [ctx] {:json-params {:sessionId session-id :entries (:entries ctx)}})
            :as :response}]}])

;; ============================================================
;; ROW-SOURCE & SUBFORM OPERATIONS
;; ============================================================

(defn fetch-row-source-flow
  "Fetch row-source data for a combo/list box.
   Original: state_form.cljs/fetch-row-source!

   Context requires: {:row-source string}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/fetch-row-source! (:row-source ctx))
          ctx)}])

(defn fetch-subform-definition-flow
  "Fetch definition for a subform control.
   Original: state_form.cljs/fetch-subform-definition!

   Context requires: {:source-form string}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/fetch-subform-definition! (:source-form ctx))
          ctx)}])

(defn fetch-subform-records-flow
  "Fetch records for a subform control.
   Original: state_form.cljs/fetch-subform-records!

   Context requires: {:source-form :child-rs :link-child :link-master :current-record}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/fetch-subform-records!
            (:source-form ctx) (:child-rs ctx)
            (:link-child ctx) (:link-master ctx) (:current-record ctx))
          ctx)}])

(defn save-subform-cell-flow
  "Save a single cell edit in a subform.
   Original: state_form.cljs/save-subform-cell!

   Context requires: {:source-form :row :col :new-val}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/save-subform-cell!
            (:source-form ctx) (:row ctx) (:col ctx) (:new-val ctx))
          ctx)}])

(defn new-subform-record-flow
  "Add a new record to a subform.
   Original: state_form.cljs/new-subform-record!

   Context requires: {:source-form :link-child-fields :link-master-fields :current-record}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/new-subform-record!
            (:source-form ctx) (:link-child-fields ctx)
            (:link-master-fields ctx) (:current-record ctx))
          ctx)}])

(defn delete-subform-record-flow
  "Delete a record from a subform.
   Original: state_form.cljs/delete-subform-record!

   Context requires: {:source-form :row}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/delete-subform-record! (:source-form ctx) (:row ctx))
          ctx)}])

;; ============================================================
;; CLIPBOARD OPERATIONS
;; ============================================================

(def cut-form-record-flow
  "Cut the current form record to clipboard.
   Original: state_form.cljs/cut-form-record!"
  [{:step :do
    :fn (fn [ctx]
          (state-form/cut-form-record!)
          ctx)}])

(def copy-form-record-flow
  "Copy the current form record to clipboard.
   Original: state_form.cljs/copy-form-record!"
  [{:step :do
    :fn (fn [ctx]
          (state-form/copy-form-record!)
          ctx)}])

(def paste-form-record-flow
  "Paste record from clipboard into the form.
   Original: state_form.cljs/paste-form-record!"
  [{:step :do
    :fn (fn [ctx]
          (state-form/paste-form-record!)
          ctx)}])

;; ============================================================
;; FIELD UPDATE & SESSION FUNCTIONS
;; ============================================================

(defn update-record-field-flow
  "Update a single field in the current record.
   Original: state_form.cljs/update-record-field!

   Context requires: {:field :value}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/update-record-field! (:field ctx) (:value ctx))
          ctx)}])

(defn call-session-function-flow
  "Call a session function (button on-click handler).
   Original: state_form.cljs/call-session-function!

   Context requires: {:function-name string}"
  []
  [{:step :do
    :fn (fn [ctx]
          (state-form/call-session-function! (:function-name ctx))
          ctx)}])
