(ns app.state-form
  "Form editor state management - form-specific functions split from state.cljs"
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]
            [app.state :as state :refer [app-state api-base db-headers session-id
                                         set-loading! set-error! log-error! log-event!
                                         build-data-query-params record->api-map detect-pk-field
                                         pk-value-for-record parse-access-filter
                                         update-object! save-ui-state! close-tab!
                                         filename->display-name
                                         coerce-yes-no coerce-to-number coerce-to-keyword
                                         yes-no-control-props yes-no-control-defaults number-control-props
                                         normalize-control
                                         maybe-auto-analyze!]]
            [app.projection :as projection]))

;; Forward declarations for functions used before definition
(declare save-current-record! save-form! save-form-to-file!
         get-record-source-fields delete-current-record! load-form-for-editing!
         set-form-definition!)

;; ============================================================
;; FORM-VIEW RECORD CONTEXT MENU & CLIPBOARD
;; ============================================================

(defonce form-clipboard (atom nil))

(defn show-form-context-menu! [x y]
  (swap! app-state assoc-in [:form-editor :context-menu]
         {:visible true :x x :y y}))

(defn hide-form-context-menu! []
  (swap! app-state assoc-in [:form-editor :context-menu :visible] false))

(defn copy-form-record!
  "Copy the current record to the form clipboard"
  []
  (let [record (get-in @app-state [:form-editor :projection :record])]
    (reset! form-clipboard (dissoc record :__new__ :id))))

(defn cut-form-record!
  "Copy the current record to clipboard, then delete it"
  []
  (copy-form-record!)
  (delete-current-record!))

(defn paste-form-record!
  "Create a new record pre-filled with clipboard values"
  []
  (when-let [data @form-clipboard]
    (let [total (get-in @app-state [:form-editor :projection :total] 0)
          new-record (assoc data :__new__ true)
          new-pos (inc total)]
      (swap! app-state update-in [:form-editor :projection :records] #(conj (vec %) new-record))
      (swap! app-state update-in [:form-editor :projection]
             projection/hydrate-bindings new-record)
      (swap! app-state assoc-in [:form-editor :projection :position] new-pos)
      (swap! app-state assoc-in [:form-editor :projection :total] new-pos)
      (swap! app-state assoc-in [:form-editor :projection :dirty?] true))))

;; ============================================================
;; CLOSE TABS (form-aware auto-save)
;; ============================================================

(defn close-all-tabs!
  "Close all open tabs"
  []
  ;; Auto-save dirty record before closing
  (when (get-in @app-state [:form-editor :projection :dirty?])
    (save-current-record!))
  ;; Auto-save dirty form definition before closing
  (when (get-in @app-state [:form-editor :dirty?])
    (save-form!))
  (swap! app-state assoc
         :open-objects []
         :active-tab nil
         :form-editor nil))

(defn close-current-tab!
  "Close the currently active tab"
  []
  (let [active (:active-tab @app-state)]
    (when active
      ;; Auto-save dirty record before closing
      (when (get-in @app-state [:form-editor :projection :dirty?])
        (save-current-record!))
      ;; Auto-save dirty form definition before closing
      (when (get-in @app-state [:form-editor :dirty?])
        (save-form!))
      (close-tab! (:type active) (:id active)))))

;; ============================================================
;; FORM CREATION
;; ============================================================

(defn create-new-form! []
  (let [existing-forms (get-in @app-state [:objects :forms])
        new-id (inc (reduce max 0 (map :id existing-forms)))
        new-form {:id new-id
                  :name (str "Form" new-id)
                  :definition {:type :form
                               :record-source nil
                               :controls []}}]
    (state/add-object! :forms new-form)
    (state/open-object! :forms new-id)))

;; ============================================================
;; FORM HEADER/FOOTER TOGGLE
;; ============================================================

(defn toggle-form-header-footer!
  "Toggle header and footer visibility together (like Access View > Form Header/Footer).
   When hiding: saves current height to :_saved-height, sets height to 0, visible to 0.
   When showing: restores from :_saved-height or defaults to 80, visible to 1."
  []
  (let [current (get-in @app-state [:form-editor :current])
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
                       (if (get def section)
                         (-> def
                             (assoc-in [section :height]
                                       (get-in def [section :_saved-height] 80))
                             (assoc-in [section :visible] 1))
                         (assoc def section {:height 80 :controls [] :visible 1})))]
    (when current
      (set-form-definition!
       (if has-sections?
         (-> current (hide-section :header) (hide-section :footer))
         (-> current (show-section :header) (show-section :footer)))))))

;; ============================================================
;; FORM EDITOR - DEFINITION & SAVE
;; ============================================================

(defn set-form-definition! [definition]
  (swap! app-state assoc-in [:form-editor :current] definition)
  (swap! app-state assoc-in [:form-editor :dirty?]
         (not= definition (get-in @app-state [:form-editor :original]))))

(defn clear-lint-errors! []
  (swap! app-state assoc-in [:form-editor :lint-errors] nil))

(defn set-lint-errors! [errors]
  (swap! app-state assoc-in [:form-editor :lint-errors] errors))

(defn save-form-to-file!
  "Save a form to the database via backend API"
  [form]
  (let [filename (or (:filename form)
                     (-> (:name form)
                         (str/lower-case)
                         (str/replace #"\s+" "_")))
        form-data (merge {:id (:id form)
                          :name (:name form)}
                         (:definition form))]
    (go
      (let [response (<! (http/put (str api-base "/api/forms/" filename)
                                   {:json-params form-data
                                    :headers (db-headers)}))]
        (if (:success response)
          (do
            ;; Update the form's filename in state
            (swap! app-state update-in [:objects :forms]
                   (fn [forms]
                     (mapv (fn [f]
                             (if (= (:id f) (:id form))
                               (assoc f :filename filename)
                               f))
                           forms))))
          (log-error! (str "Failed to save form: " (get-in response [:body :error])) "save-form" {:response (:body response)}))))))

(defn do-save-form!
  "Actually save the form (called after lint passes)"
  []
  (let [current (get-in @app-state [:form-editor :current])
        form-id (get-in @app-state [:form-editor :form-id])]
    (when (and form-id current)
      ;; Update the form in objects list
      (update-object! :forms form-id {:definition current})
      ;; Update the tab name if form name changed
      (swap! app-state update :open-objects
             (fn [tabs]
               (mapv (fn [tab]
                       (if (and (= (:type tab) :forms)
                                (= (:id tab) form-id))
                         (assoc tab :name (:name current))
                         tab))
                     tabs)))
      ;; Mark as clean
      (swap! app-state assoc-in [:form-editor :dirty?] false)
      (swap! app-state assoc-in [:form-editor :original] current)
      ;; Save to file
      (let [form (first (filter #(= (:id %) form-id)
                                (get-in @app-state [:objects :forms])))]
        (save-form-to-file! form)))))

(defn save-form!
  "Lint the form and save if valid"
  []
  (let [current (get-in @app-state [:form-editor :current])
        form-id (get-in @app-state [:form-editor :form-id])
        ;; Get form name from objects list
        form-obj (first (filter #(= (:id %) form-id)
                                (get-in @app-state [:objects :forms])))
        ;; Merge id and name back into form for lint validation
        form-with-meta (merge {:id form-id :name (:name form-obj)} current)]
    (when (and form-id current)
      (clear-lint-errors!)
      (go
        (let [response (<! (http/post (str api-base "/api/lint/form")
                                      {:json-params {:form form-with-meta}}))]
          (if (:success response)
            (let [result (:body response)]
              (if (:valid result)
                (do-save-form!)
                (set-lint-errors! (:errors result))))
            ;; Lint endpoint failed, save anyway
            (do-save-form!)))))))

;; ============================================================
;; SESSION-STATE FUNCTION CALLING
;; ============================================================

(defn- build-session-state-vars
  "Convert a record to session state vars map for session-state API."
  [record]
  (reduce-kv
    (fn [m k v]
      (if (= k :__new__) m
          (assoc m (if (keyword? k) (name k) (str k))
                 {:value (str v) :type "text"})))
    {} record))

(defn- handle-session-navigate!
  "Handle navigateTo from session function response."
  [navigate-to]
  (let [forms (get-in @app-state [:objects :forms])
        target-form (first (filter #(= (str/lower-case (:name %))
                                       (str/lower-case navigate-to))
                                   forms))]
    (if target-form
      (do (state/open-object! :forms (:id target-form))
          (load-form-for-editing! target-form))
      (log-event! "warning" (str "Navigate target form not found: " navigate-to) "handle-session-navigate"))))

(defn collect-computed-specs
  "Scan a form definition for controls with :computed-function and build
   the computed column spec array for the data API."
  [form-def]
  (let [sections (keep #(get form-def %) ["header" :header "detail" :detail "footer" :footer])]
    (->> sections
         (mapcat #(get % :controls (get % "controls" [])))
         (keep (fn [ctrl]
                 (when-let [fn-name (or (get ctrl :computed-function)
                                        (get ctrl "computed-function"))]
                   {:fn fn-name
                    :params (or (get ctrl :computed-params)
                                (get ctrl "computed-params") [])
                    :alias (or (get ctrl :computed-alias)
                               (get ctrl "computed-alias")
                               (str "_calc_" (or (:name ctrl) (:id ctrl))))})))
         vec)))

(defn- refresh-form-data!
  "Re-fetch records for the current form and update state. Returns channel."
  []
  (let [form-def (get-in @app-state [:form-editor :current])
        record-source (not-empty (get form-def :record-source))]
    (when record-source
      (go
        (let [computed (collect-computed-specs form-def)
              query-params (cond-> (build-data-query-params
                                     (get form-def :order-by)
                                     (get form-def :filter))
                             (seq computed)
                             (assoc :computed (.stringify js/JSON (clj->js computed))))
              data-resp (<! (http/get (str api-base "/api/data/" record-source)
                                      {:query-params query-params
                                       :headers (db-headers)}))]
          (when (:success data-resp)
            (let [data (get-in data-resp [:body :data])
                  total (get-in data-resp [:body :pagination :totalCount] (count data))
                  pos (get-in @app-state [:form-editor :projection :position] 1)
                  safe-pos (min pos (count data))]
              (swap! app-state update-in [:form-editor :projection]
                     projection/sync-records (vec data) safe-pos total)
              (swap! app-state assoc-in [:form-editor :projection :dirty?] false))))))))

(defn- handle-session-response!
  "Handle response from a session function call (message, navigate, confirm)."
  [body session-id]
  (go
    (let [{:keys [userMessage navigateTo confirmRequired]} body]
      (when userMessage (js/alert userMessage))
      (when navigateTo (handle-session-navigate! navigateTo))
      (when confirmRequired
        (when (js/confirm "Confirm action?")
          (<! (http/post (str api-base "/api/session/function/confirm_action")
                         {:json-params {:sessionId session-id}}))))
      (refresh-form-data!))))

(defn call-session-function!
  "Call a PostgreSQL function through the session-state pipeline."
  [function-name & [{:keys [on-complete]}]]
  (go
    (let [session-resp (<! (http/post (str api-base "/api/session")))]
      (if-not (:success session-resp)
        (log-event! "error" "Failed to create session" "call-session-function" {:response (:body session-resp)})
        (let [session-id (get-in session-resp [:body :sessionId])
              state-vars (build-session-state-vars
                           (get-in @app-state [:form-editor :projection :record] {}))]
          (when (seq state-vars)
            (<! (http/put (str api-base "/api/session/" session-id "/state")
                          {:json-params state-vars})))
          (let [func-resp (<! (http/post (str api-base "/api/session/function/" function-name)
                                         {:json-params {:sessionId session-id}}))]
            (if-not (:success func-resp)
              (do (log-event! "error" (str "Failed to call function: " function-name) "call-session-function" {:response (:body func-resp)})
                  (js/alert (str "Error calling " function-name ": "
                                 (get-in func-resp [:body :details]
                                         (get-in func-resp [:body :error] "Unknown error")))))
              (do
                (<! (handle-session-response! (:body func-resp) session-id))
                (when on-complete (on-complete (:body func-resp))))))
          (<! (http/delete (str api-base "/api/session/" session-id))))))))

(defn fire-form-event!
  "Fire a form-level event handler."
  [event-key & [{:keys [on-complete]}]]
  (let [projection (get-in @app-state [:form-editor :projection])
        event-str (name event-key)
        handler (projection/get-event-handler projection "Form" event-str)]
    (when handler
      (if-let [js-code (:js handler)]
        (try (let [f (js/Function. js-code)] (.call f))
             (when on-complete (on-complete))
             (catch :default e
               (js/console.warn "Error in form event handler" event-str ":" (.-message e))))
        (js/console.warn "Form handler has no :js code:" event-str)))))

;; ============================================================
;; FORM STATE SYNC (shared.form_control_state)
;; ============================================================

(defn- build-synced-controls
  "Scan all controls in a form definition for the 'state' tag.
   Returns a map of {control-name {:table-name t :column-name c}} keyed by
   the underlying table.column derived from record-source + field binding.
   Unbound controls use form-name as pseudo-table."
  [definition]
  (let [form-name (str/lower-case (or (:name definition) ""))
        record-source (str/lower-case
                        (str/replace (or (get definition :record-source)
                                        (get definition :record_source)
                                        form-name)
                                     " " "_"))
        sections (keep #(get definition %) [:header :detail :footer])]
    (into {}
          (comp (mapcat :controls)
                (filter #(= "state" (str/lower-case (or (:tag %) ""))))
                (keep (fn [ctrl]
                        (let [ctrl-name (str/lower-case (or (:name ctrl) ""))]
                          (when (not (str/blank? ctrl-name))
                            (if-let [field (:field ctrl)]
                              ;; Bound: table = record-source, column = field
                              [ctrl-name {:table-name record-source
                                          :column-name (str/lower-case (str/replace (str field) " " "_"))}]
                              ;; Unbound: table = form-name, column = control-name
                              [ctrl-name {:table-name form-name
                                          :column-name ctrl-name}]))))))
          sections)))

(defn sync-form-state!
  "Upsert control values to shared.form_control_state.
   entries-vec is [{:tableName t :columnName c :value v}, ...].
   Optional on-complete callback fires after successful sync."
  [entries-vec & [on-complete]]
  (when (seq entries-vec)
    (go
      (let [response (<! (http/put (str api-base "/api/form-state")
                                   {:json-params {:sessionId session-id
                                                  :entries entries-vec}}))]
        (if (:success response)
          (when on-complete (on-complete))
          (log-event! "warning" "Failed to sync form state" "sync-form-state"
                      {:error (get-in response [:body :error])}))))))

(defn sanitize-name
  "Port of server-side sanitizeName: lowercase, whitespace→underscore, strip non-alnum/underscore."
  [s]
  (when s
    (-> (str/lower-case (str s))
        (str/replace #"\s+" "_")
        (str/replace #"[^a-z0-9_]" ""))))

(defn invalidate-row-source!
  "Remove a specific row-source from the cache, forcing re-fetch on next render."
  [row-source]
  (swap! app-state update-in [:form-editor :row-source-cache] dissoc row-source))

(defn invalidate-query-row-sources!
  "Remove all table/query-name row-source entries from cache (not SQL, not value-lists).
   These are the entries that may reference session_state via cross-joins."
  []
  (swap! app-state update-in [:form-editor :row-source-cache]
    (fn [cache]
      (reduce-kv (fn [acc k v]
                   (let [trimmed (str/trim (str k))]
                     (if (or (re-find #"(?i)^select\s" trimmed)
                             (str/includes? trimmed ";"))
                       ;; SQL or value-list — keep it
                       (assoc acc k v)
                       ;; table/query name — remove it (may depend on session_state)
                       acc)))
                 {} (or cache {})))))

(defn- collect-synced-values
  "Given a record and a synced-controls map, return a vector of
   [{:tableName t :columnName c :value v}] for the API."
  [record synced-controls]
  (reduce-kv
    (fn [acc k v]
      (let [field-name (str/lower-case (if (keyword? k) (name k) (str k)))]
        (if-let [mapping (get synced-controls field-name)]
          (conj acc {:tableName (:table-name mapping)
                     :columnName (:column-name mapping)
                     :value (when (some? v) (str v))})
          acc)))
    [] record))

(defn- sync-current-record-state!
  "Sync all tagged control values from the current record to state table."
  []
  (let [synced (get-in @app-state [:form-editor :synced-controls])
        record (get-in @app-state [:form-editor :projection :record])]
    (when (and (seq synced) record)
      (sync-form-state! (collect-synced-values record synced)))))

;; ============================================================
;; VIEW MODE & RECORD OPERATIONS
;; ============================================================

(defn- init-data-entry-mode!
  "Initialize form in data-entry mode with a blank new record."
  []
  (let [new-record {:__new__ true}]
    (swap! app-state update-in [:form-editor :projection]
           projection/sync-records [new-record] 1 1)
    (swap! app-state assoc-in [:form-editor :projection :dirty?] true)
    (fire-form-event! :on-load)))

(defn- load-form-records!
  "Fetch records from API for form view mode."
  [record-source]
  (go
    (let [form-def (get-in @app-state [:form-editor :current])
          computed (collect-computed-specs form-def)
          sql-source? (str/starts-with? (str/lower-case record-source) "select ")
          query-params (cond-> (build-data-query-params
                                 (get form-def :order-by)
                                 (get form-def :filter))
                         (seq computed)
                         (assoc :computed (.stringify js/JSON (clj->js computed))))
          response (<! (if sql-source?
                         (http/post (str api-base "/api/queries/run")
                                    {:json-params {:sql record-source}
                                     :headers (db-headers)})
                         (http/get (str api-base "/api/data/" record-source)
                                   {:query-params query-params
                                    :headers (db-headers)})))]
      (if (:success response)
        (let [data (get-in response [:body :data])
              total (get-in response [:body :pagination :totalCount] (count data))]
          (swap! app-state update-in [:form-editor :projection]
                 projection/sync-records (vec data) 1 total)
          (swap! app-state assoc-in [:form-editor :projection :dirty?] false)
          (when (seq data) (sync-current-record-state!))
          (fire-form-event! :on-load))
        (log-error! "Failed to load form records" "load-form-records" {:response (:body response)})))))

(defn set-view-mode! [mode]
  "Set form view mode - :design or :view"
  (let [current-mode (get-in @app-state [:form-editor :view-mode] :design)]
    (when (and (= current-mode :view) (not= mode :view))
      (when (get-in @app-state [:form-editor :projection :dirty?])
        (save-current-record!)))
    (swap! app-state assoc-in [:form-editor :view-mode] mode)
    (when (= mode :view)
      (let [record-source (not-empty (get-in @app-state [:form-editor :current :record-source]))
            data-entry? (not= 0 (get-in @app-state [:form-editor :current :data-entry] 0))]
        (when record-source
          (if data-entry?
            (init-data-entry-mode!)
            (load-form-records! record-source)))))))

(defn get-view-mode []
  (get-in @app-state [:form-editor :view-mode] :design))

;; Record navigation state
(defn set-current-record! [record]
  (swap! app-state update-in [:form-editor :projection]
         projection/hydrate-bindings record))

(defn set-record-position! [pos total]
  (swap! app-state assoc-in [:form-editor :projection :position] pos)
  (swap! app-state assoc-in [:form-editor :projection :total] total))

(defn update-record-field! [field-name value]
  (let [field-kw (keyword (str/lower-case (if (keyword? field-name) (name field-name) (str field-name))))]
    (swap! app-state update-in [:form-editor :projection]
           projection/update-field field-kw value)
    ;; If this field is tagged for state sync, upsert immediately
    (let [synced (get-in @app-state [:form-editor :synced-controls])]
      (when-let [mapping (and (seq synced) (get synced (name field-kw)))]
        (sync-form-state! [{:tableName (:table-name mapping)
                            :columnName (:column-name mapping)
                            :value (when (some? value) (str value))}])))
    ;; Fire AfterUpdate handler if registered
    (let [projection (get-in @app-state [:form-editor :projection])
          handler (projection/get-event-handler projection (name field-kw) "after-update")]
      (when handler
        (if-let [js-code (:js handler)]
          (try (let [f (js/Function. js-code)] (.call f))
               (catch :default e
                 (js/console.warn "Error in after-update handler for" (name field-kw) ":" (.-message e))))
          (js/console.warn "AfterUpdate handler has no :js code:" (name field-kw)))))))

(defn navigate-to-record!
  "Navigate to a specific record by position (1-indexed)"
  [position]
  ;; Auto-save dirty record before navigating
  (when (get-in @app-state [:form-editor :projection :dirty?])
    (save-current-record!))
  (let [records (get-in @app-state [:form-editor :projection :records] [])
        total (count records)
        pos (max 1 (min total position))]
    (when (and (> total 0) (<= pos total))
      (swap! app-state update-in [:form-editor :projection]
             projection/sync-position pos)
      (swap! app-state assoc-in [:form-editor :projection :dirty?] false)
      ;; Sync tagged control values to state table
      (sync-current-record-state!)
      ;; Fire on-current event after navigating to new record
      (fire-form-event! :on-current))))

;; Register callbacks for runtime.cljs (breaks circular dep)
(state/register-callback! :navigate-to-record navigate-to-record!)
(state/register-callback! :update-record-field update-record-field!)

(defn- run-before-update-hook!
  "Run before-update function if mapped. Returns channel yielding true to abort."
  [current-record]
  (go
    (let [before-update-fn (get-in @app-state [:form-editor :current :before-update])]
      (if-not (and before-update-fn (string? before-update-fn)
                   (not (str/blank? before-update-fn)))
        false
        (let [sess-resp (<! (http/post (str api-base "/api/session")))]
          (if-not (:success sess-resp)
            false
            (let [session-id (get-in sess-resp [:body :sessionId])
                  state-vars (build-session-state-vars current-record)
                  _ (when (seq state-vars)
                      (<! (http/put (str api-base "/api/session/" session-id "/state")
                                    {:json-params state-vars})))
                  func-resp (<! (http/post (str api-base "/api/session/function/" before-update-fn)
                                           {:json-params {:sessionId session-id}}))
                  user-msg (when (:success func-resp)
                             (get-in func-resp [:body :userMessage]))]
              (<! (http/delete (str api-base "/api/session/" session-id)))
              (when user-msg (js/alert user-msg))
              (boolean user-msg))))))))

(defn- do-insert-record!
  "Insert a new record via API and update state.
   Merges server response into existing record to pick up auto-generated PK
   without losing lookup columns from views."
  [record-source record-for-api pk-field-name pos]
  (go
    (let [insert-data (if (= pk-field-name "id")
                        (dissoc record-for-api "id") record-for-api)
          response (<! (http/post (str api-base "/api/data/" record-source)
                                  {:json-params insert-data :headers (db-headers)}))]
      (if (:success response)
        (let [current-record (get-in @app-state [:form-editor :projection :record])
              server-record (get-in response [:body :data])
              merged (merge current-record server-record)]
          (swap! app-state assoc-in [:form-editor :projection :records (dec pos)] merged)
          (swap! app-state update-in [:form-editor :projection]
                 projection/hydrate-bindings merged)
          (swap! app-state assoc-in [:form-editor :projection :dirty?] false))
        (log-error! "Failed to insert record" "save-record" {:response (:body response)})))))

(defn- do-update-record!
  "Update an existing record via API and update state.
   Does NOT replace the in-memory record with the server response — views return
   only base-table columns, so replacing would wipe lookup columns."
  [record-source record-for-api pk-field-name pk-value pos]
  (go
    (let [update-data (dissoc record-for-api pk-field-name)
          response (<! (http/put (str api-base "/api/data/" record-source "/" pk-value)
                                 {:json-params update-data :headers (db-headers)}))]
      (if (:success response)
        (let [current-record (get-in @app-state [:form-editor :projection :record])]
          (swap! app-state assoc-in [:form-editor :projection :records (dec pos)] current-record)
          (swap! app-state assoc-in [:form-editor :projection :dirty?] false))
        (log-error! "Failed to update record" "save-record" {:response (:body response)})))))

(defn- check-no-pk?
  "Return true if table has no detectable PK and record isn't explicitly new."
  [pk-from-fields current-record]
  (and (nil? pk-from-fields)
       (not (contains? current-record :id))
       (not (contains? current-record "id"))
       (not (:__new__ current-record))))

;; ============================================================
;; VALIDATION RULES
;; ============================================================

(defn- eval-simple-rule
  "Evaluate a single Access validation condition against a value."
  [value rule]
  (let [rule (str/trim rule)
        rule-lower (str/lower-case rule)]
    (cond
      ;; Is Not Null
      (= rule-lower "is not null")
      (and (some? value) (not= (str value) ""))

      ;; Is Null
      (= rule-lower "is null")
      (or (nil? value) (= (str value) ""))

      ;; Between X And Y
      (re-find #"(?i)^between\s+" rule)
      (if-let [[_ lo hi] (re-matches #"(?i)between\s+(.+?)\s+and\s+(.+)" rule)]
        (let [n (js/parseFloat (str value))
              lo-n (js/parseFloat lo)
              hi-n (js/parseFloat hi)]
          (and (not (js/isNaN n)) (<= lo-n n) (<= n hi-n)))
        true)

      ;; Like "pattern" — Access wildcards: * = any chars, ? = one char, # = one digit
      (re-find #"(?i)^like\s+" rule)
      (let [pattern (-> (subs rule 5) str/trim (str/replace #"\"" ""))
            regex-str (-> pattern
                          (str/replace #"\*" ".*")
                          (str/replace #"\?" ".")
                          (str/replace #"#" "\\d"))
            re (js/RegExp. (str "^" regex-str "$") "i")]
        (.test re (str (or value ""))))

      ;; Comparison: >=, <=, <>, >, <, =
      :else
      (if-let [[_ op operand] (re-matches #"^(>=|<=|<>|>|<|=)\s*(.+)$" rule)]
        (let [operand (str/replace operand #"\"" "")
              n-val (js/parseFloat (str value))
              n-op (js/parseFloat operand)
              both-num? (and (not (js/isNaN n-val)) (not (js/isNaN n-op)))]
          (if both-num?
            (case op ">=" (>= n-val n-op) "<=" (<= n-val n-op) "<>" (not= n-val n-op)
                     ">"  (> n-val n-op)  "<"  (< n-val n-op)  "="  (== n-val n-op) true)
            (let [sv (str (or value "")) so operand]
              (case op "<>" (not= sv so) "=" (= sv so) true))))
        ;; Unrecognized — pass
        true))))

(defn- validate-rule
  "Evaluate an Access validation rule (possibly compound with Or/And) against a value."
  [value rule-str]
  (if (or (nil? rule-str) (str/blank? rule-str))
    true
    (let [rule (str/trim rule-str)]
      (cond
        ;; Or — any branch true = valid (split carefully, not inside Between)
        (and (re-find #"(?i)\s+or\s+" rule)
             (not (re-find #"(?i)^between\s+" rule)))
        (boolean (some #(validate-rule value %) (str/split rule #"(?i)\s+or\s+")))

        ;; And — all branches true = valid (but not Between...And...)
        (and (re-find #"(?i)\s+and\s+" rule)
             (not (re-find #"(?i)^between\s+" rule)))
        (every? #(validate-rule value %) (str/split rule #"(?i)\s+and\s+"))

        ;; Single condition
        :else
        (eval-simple-rule value rule)))))

(defn- validate-record
  "Check all controls' validation rules against the current record.
   Returns nil if valid, or {:field name :text message} for the first failure."
  [form-def record]
  (let [all-controls (mapcat #(get-in form-def [% :controls] []) [:header :detail :footer])]
    (some (fn [ctrl]
            (when-let [rule (:validation-rule ctrl)]
              (let [field-name (or (:control-source ctrl) (:field ctrl))
                    field-key (when field-name (keyword (str/lower-case field-name)))
                    value (when field-key (get record field-key))]
                (when (and field-name (not (validate-rule value rule)))
                  {:field (or (:name ctrl) field-name)
                   :text (or (:validation-text ctrl)
                             (str "Validation failed for " (or (:name ctrl) field-name)
                                  ": " rule))}))))
          all-controls)))

(defn save-current-record!
  "Save the current record to the database"
  []
  (let [record-source (get-in @app-state [:form-editor :current :record-source])
        current-record (get-in @app-state [:form-editor :projection :record])
        form-def (get-in @app-state [:form-editor :current])
        pos (get-in @app-state [:form-editor :projection :position] 1)
        record-dirty? (get-in @app-state [:form-editor :projection :dirty?])]
    (when (and record-source current-record record-dirty?)
      (if-let [error (validate-record form-def current-record)]
        (js/alert (:text error))
        (go
          (let [abort? (<! (run-before-update-hook! current-record))]
            (when-not abort?
              (let [fields (get-record-source-fields record-source)
                    pk-from-fields (some #(when (:pk %) (:name %)) fields)
                    pk-field-name (or pk-from-fields "id")
                    pk-value (pk-value-for-record current-record pk-field-name)
                    is-new? (or (:__new__ current-record) (nil? pk-value) (= pk-value ""))
                    record-for-api (record->api-map current-record)]
                (if (check-no-pk? pk-from-fields current-record)
                  (js/alert (str "Cannot save: table \"" record-source "\" has no primary key. "
                                 "Add a primary key to this table before editing records."))
                  (if is-new?
                    (<! (do-insert-record! record-source record-for-api pk-field-name pos))
                    (<! (do-update-record! record-source record-for-api pk-field-name pk-value pos))))))))))))

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

(defn new-record!
  "Create a new record, pre-populated with default values from controls"
  []
  (let [total (get-in @app-state [:form-editor :projection :total] 0)
        form-def (get-in @app-state [:form-editor :current])
        defaults (collect-default-values form-def)
        new-record (merge defaults {:__new__ true})
        new-pos (inc total)]
    ;; Add record to records array (for continuous forms display)
    (swap! app-state update-in [:form-editor :projection :records] #(conj (vec %) new-record))
    (swap! app-state update-in [:form-editor :projection]
           projection/hydrate-bindings new-record)
    (swap! app-state assoc-in [:form-editor :projection :position] new-pos)
    (swap! app-state assoc-in [:form-editor :projection :total] new-pos)
    (swap! app-state assoc-in [:form-editor :projection :dirty?] true)))

(defn- update-state-after-delete!
  "Update form state after a record is successfully deleted."
  [new-records pos]
  (let [new-total (count new-records)
        new-pos (min pos new-total)]
    (swap! app-state update-in [:form-editor :projection]
           projection/sync-records new-records new-pos new-total)
    (swap! app-state assoc-in [:form-editor :projection :dirty?] false)))

(defn delete-current-record!
  "Delete the current record from the database"
  []
  (let [record-source (get-in @app-state [:form-editor :current :record-source])
        current-record (get-in @app-state [:form-editor :projection :record])
        records (get-in @app-state [:form-editor :projection :records] [])
        pos (get-in @app-state [:form-editor :projection :position] 1)]
    (when (and record-source current-record)
      (let [pk-field-name (detect-pk-field (get-record-source-fields record-source))
            pk-value (pk-value-for-record current-record pk-field-name)]
        (when pk-value
          (go
            (let [response (<! (http/delete (str api-base "/api/data/" record-source "/" pk-value)
                                            {:headers (db-headers)}))]
              (if (:success response)
                (update-state-after-delete!
                  (vec (concat (subvec records 0 (dec pos)) (subvec records pos))) pos)
                (log-error! "Failed to delete record" "delete-record" {:response (:body response)})))))))))

(defn get-record-source-fields
  "Get fields for a record source (table or query)"
  [record-source]
  (when record-source
    (let [tables (get-in @app-state [:objects :tables])
          queries (get-in @app-state [:objects :queries])
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

;; ============================================================
;; ROW-SOURCE CACHE (combobox/listbox population)
;; ============================================================

(defn clear-row-source-cache!
  "Reset the row-source cache. Called when switching forms."
  []
  (swap! app-state assoc-in [:form-editor :row-source-cache] {}))

(defn- cache-row-source! [row-source data]
  (when (map? data)
    ;; Try parent projection
    (swap! app-state update-in [:form-editor :projection]
           projection/populate-row-source row-source data)
    ;; Try all subform projections
    (doseq [[sf-name sf-data] (get-in @app-state [:form-editor :subform-cache])]
      (when (:projection sf-data)
        (swap! app-state update-in [:form-editor :subform-cache sf-name :projection]
               projection/populate-row-source row-source data))))
  ;; Keep flat cache for fetch dedup sentinel
  (swap! app-state assoc-in [:form-editor :row-source-cache row-source] data))

(defn- parse-value-list
  "Parse semicolon-delimited value list into row-source cache format."
  [trimmed]
  (let [items (->> (str/split trimmed #";")
                   (mapv str/trim)
                   (filterv #(not (str/blank? %)))
                   (mapv #(str/replace % #"^\"|\"$" "")))]
    {:rows (mapv (fn [v] {"value" v}) items) :fields [{:name "value"}]}))

(defn- fetch-sql-row-source!
  "Fetch row-source via SQL query execution."
  [row-source trimmed]
  (go
    (let [response (<! (http/post (str api-base "/api/queries/run")
                                  {:json-params {:sql trimmed} :headers (db-headers)}))]
      (cache-row-source! row-source
        (if (:success response)
          {:rows (or (get-in response [:body :data]) [])
           :fields (or (get-in response [:body :fields]) [])}
          {:rows [] :fields [] :error true})))))

(defn- fetch-table-row-source!
  "Fetch row-source from a table/query name."
  [row-source trimmed]
  (go
    (let [response (<! (http/get (str api-base "/api/data/" trimmed)
                                 {:query-params {:limit 1000} :headers (db-headers)}))]
      (cache-row-source! row-source
        (if (:success response)
          (let [data (get-in response [:body :data] [])]
            {:rows data
             :fields (if (seq data)
                       (mapv (fn [k] {:name (name k)}) (keys (first data)))
                       [])})
          {:rows [] :fields [] :error true})))))

(defn fetch-row-source!
  "Fetch and cache row-source data for a combobox/listbox."
  [row-source]
  (when (and row-source (not (str/blank? row-source)))
    (when-not (get-in @app-state [:form-editor :row-source-cache row-source])
      (cache-row-source! row-source :loading)
      (let [trimmed (str/trim row-source)]
        (cond
          (and (not (re-find #"(?i)^select\s" trimmed))
               (str/includes? trimmed ";"))
          (cache-row-source! row-source (parse-value-list trimmed))

          (re-find #"(?i)^select\s" trimmed)
          (fetch-sql-row-source! row-source trimmed)

          :else
          (fetch-table-row-source! row-source trimmed))))))

(defn get-row-source-options
  "Returns row-source data from projection (parent or subform).
   Falls back to flat cache for sources not tracked in any projection.
   nil if not loaded, :loading if in-flight, {:rows [...] :fields [...]} if ready."
  [row-source]
  (let [projection (get-in @app-state [:form-editor :projection])
        from-proj (some (fn [[_kw spec]]
                          (when (= (:source spec) row-source)
                            (:options spec)))
                        (:row-sources projection))
        from-subform (when-not from-proj
                       (some (fn [[_sf-name sf-data]]
                               (when-let [sp (:projection sf-data)]
                                 (some (fn [[_kw spec]]
                                         (when (= (:source spec) row-source)
                                           (:options spec)))
                                       (:row-sources sp))))
                             (get-in @app-state [:form-editor :subform-cache])))]
    (or from-proj
        from-subform
        (get-in @app-state [:form-editor :row-source-cache row-source]))))

;; ============================================================
;; SUBFORM CACHE (child form definition + child records)
;; ============================================================

(defn clear-subform-cache!
  "Reset the subform cache. Called when switching forms."
  []
  (swap! app-state assoc-in [:form-editor :subform-cache] {}))

(defn fetch-subform-definition!
  "Fetch and cache a child form definition for a subform control."
  [source-form-name]
  (when (and source-form-name (not (str/blank? source-form-name)))
    (let [cached (get-in @app-state [:form-editor :subform-cache source-form-name :definition])]
      (when-not cached
        (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :definition] :loading)
        (go
          (let [response (<! (http/get (str api-base "/api/forms/" source-form-name)
                                        {:headers (db-headers)}))]
            (if (:success response)
              (let [def (:body response)]
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :definition] def)
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :projection]
                       (projection/build-projection def)))
              (do
                (log-event! "error" (str "Failed to fetch subform definition: " source-form-name) "fetch-subform-definition")
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :definition]
                       {:error true})))))))))

(defn fetch-subform-records!
  "Fetch and cache child records for a subform, filtered by parent link fields.
   When link fields are present, filters by master values. Without link fields, loads all records.
   Only re-fetches when the filter key (master field values) changes."
  [source-form-name record-source link-child-fields link-master-fields current-record]
  (when (and source-form-name record-source)
    (let [;; Build filter from paired child/master fields (empty map if no link fields)
          filter-map (if (and (seq link-child-fields) (seq link-master-fields))
                       (reduce (fn [m [child-field master-field]]
                                 (let [lc-master (str/lower-case master-field)
                                       master-val (or (get current-record (keyword lc-master))
                                                      (get current-record lc-master)
                                                      (get current-record (keyword master-field))
                                                      (get current-record master-field))]
                                   (if master-val
                                     (assoc m (str/lower-case child-field) master-val)
                                     m)))
                               {}
                               (map vector link-child-fields link-master-fields))
                       {})
          filter-key (pr-str filter-map)
          cached-filter-key (get-in @app-state [:form-editor :subform-cache source-form-name :filter-key])]
      ;; Fetch when: no link fields (unfiltered), or link fields with at least one master value matched
      (when (and (or (empty? filter-map) (seq filter-map))
                 (not= filter-key cached-filter-key))
        (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :filter-key] filter-key)
        (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :records] :loading)
        (go
          (let [sub-def (get-in @app-state [:form-editor :subform-cache source-form-name :definition])
                computed (when (map? sub-def) (collect-computed-specs sub-def))
                query-params (cond-> {:limit 1000}
                               (seq filter-map) (assoc :filter (.stringify js/JSON (clj->js filter-map)))
                               (seq computed) (assoc :computed (.stringify js/JSON (clj->js computed))))
                response (<! (http/get (str api-base "/api/data/" record-source)
                                        {:query-params query-params
                                         :headers (db-headers)}))]
            (if (:success response)
              (let [data (get-in response [:body :data] [])]
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :records]
                       (vec data)))
              (do
                (log-event! "error" (str "Failed to fetch subform records: " source-form-name) "fetch-subform-records" {:response (:body response)})
                (swap! app-state assoc-in [:form-editor :subform-cache source-form-name :records]
                       [])))))))))

(defn save-subform-cell!
  "Save an edited cell value in a subform record.
   Optimistic local update, then PUT to API. On error, clear filter-key to force re-fetch."
  [source-form-name row-idx col-name value]
  (let [cache-path [:form-editor :subform-cache source-form-name]
        definition (get-in @app-state (conj cache-path :definition))
        child-record-source (when (map? definition)
                              (or (:record-source definition) (:record_source definition)))
        records (get-in @app-state (conj cache-path :records))]
    (when (and child-record-source (vector? records) (< row-idx (count records)))
      (let [record (nth records row-idx)
            fields (get-record-source-fields child-record-source)
            pk-field-name (or (some #(when (:pk %) (:name %)) fields) "id")
            pk-value (or (get record (keyword pk-field-name))
                         (get record pk-field-name))]
        (when pk-value
          ;; Optimistic local update
          (swap! app-state assoc-in (conj cache-path :records row-idx (keyword col-name)) value)
          (go
            (let [response (<! (http/put (str api-base "/api/data/" child-record-source "/" pk-value)
                                          {:json-params {col-name value}
                                           :headers (db-headers)}))]
              (when-not (:success response)
                (log-event! "error" "Failed to save subform cell" "save-subform-cell" {:response (:body response)})
                ;; Clear filter-key to force re-fetch
                (swap! app-state assoc-in (conj cache-path :filter-key) nil)))))))))

(defn new-subform-record!
  "Create a new child record in a subform, pre-populated with link field values."
  [source-form-name link-child-fields link-master-fields current-record]
  (let [cache-path [:form-editor :subform-cache source-form-name]
        definition (get-in @app-state (conj cache-path :definition))
        child-record-source (when (map? definition)
                              (or (:record-source definition) (:record_source definition)))]
    (when child-record-source
      (let [;; Build new record with link values pre-populated
            new-data (reduce (fn [m [child-field master-field]]
                               (let [master-val (or (get current-record (keyword master-field))
                                                    (get current-record master-field))]
                                 (if master-val
                                   (assoc m child-field master-val)
                                   m)))
                             {}
                             (map vector link-child-fields link-master-fields))]
        (go
          (let [response (<! (http/post (str api-base "/api/data/" child-record-source)
                                         {:json-params new-data
                                          :headers (db-headers)}))]
            (if (:success response)
              ;; Clear filter-key to force re-fetch
              (swap! app-state assoc-in (conj cache-path :filter-key) nil)
              (log-event! "error" "Failed to create subform record" "new-subform-record" {:response (:body response)}))))))))

(defn create-subform-record!
  "Create a new record in a subform with link fields + initial column value.
   On success, appends the server-returned record (with generated ID) to
   the local records cache so the row becomes immediately editable."
  [source-form-name link-data col-name col-value]
  (let [cache-path [:form-editor :subform-cache source-form-name]
        definition (get-in @app-state (conj cache-path :definition))
        child-record-source (when (map? definition)
                              (or (:record-source definition) (:record_source definition)))]
    (when child-record-source
      (let [post-data (cond-> link-data
                        (and col-name (not (str/blank? (str col-value))))
                        (assoc col-name col-value))]
        (go
          (let [response (<! (http/post (str api-base "/api/data/" child-record-source)
                                          {:json-params post-data
                                           :headers (db-headers)}))]
            (if (:success response)
              ;; Append the new record (with generated ID) to the local cache
              (let [new-record (:data (:body response))
                    records (get-in @app-state (conj cache-path :records))]
                (when (vector? records)
                  (swap! app-state assoc-in (conj cache-path :records)
                         (conj records new-record))))
              (log-event! "error" "Failed to create subform record" "create-subform-record"
                          {:response (:body response)}))))))))

(defn delete-subform-record!
  "Delete a child record from a subform by row index."
  [source-form-name row-idx]
  (let [cache-path [:form-editor :subform-cache source-form-name]
        definition (get-in @app-state (conj cache-path :definition))
        child-record-source (when (map? definition)
                              (or (:record-source definition) (:record_source definition)))
        records (get-in @app-state (conj cache-path :records))]
    (when (and child-record-source (vector? records) (< row-idx (count records)))
      (let [record (nth records row-idx)
            fields (get-record-source-fields child-record-source)
            pk-field-name (or (some #(when (:pk %) (:name %)) fields) "id")
            pk-value (or (get record (keyword pk-field-name))
                         (get record pk-field-name))]
        (when pk-value
          (go
            (let [response (<! (http/delete (str api-base "/api/data/" child-record-source "/" pk-value)
                                             {:headers (db-headers)}))]
              (if (:success response)
                ;; Clear filter-key to force re-fetch
                (swap! app-state assoc-in (conj cache-path :filter-key) nil)
                (log-event! "error" "Failed to delete subform record" "delete-subform-record" {:response (:body response)})))))))))

;; ============================================================
;; FORM-ONLY CONSTANTS
;; ============================================================

(def ^:private yes-no-form-props
  "Form properties that use yes/no (1/0) values."
  [:popup :modal :allow-additions :allow-deletions :allow-edits
   :navigation-buttons :record-selectors :dividing-lines :data-entry])

(def ^:private yes-no-defaults
  "Default values for yes/no form properties (matching Access defaults)."
  {:popup 0 :modal 0 :allow-additions 1 :allow-deletions 1 :allow-edits 1
   :navigation-buttons 1 :record-selectors 1 :dividing-lines 1 :data-entry 0})

(def ^:private number-form-props
  "Form properties that should be numbers."
  [:width])

;; ============================================================
;; FORM NORMALIZATION & EDITOR SETUP
;; ============================================================

(defn- normalize-section
  "Normalize all controls in a form section (header/detail/footer)."
  [section]
  (if (:controls section)
    (update section :controls #(mapv normalize-control %))
    section))

(defn- normalize-form-definition [definition]
  "Apply defaults and normalize types across the full form tree."
  (-> (reduce (fn [def prop]
                (let [v (get def prop)]
                  (if (nil? v)
                    (assoc def prop (get yes-no-defaults prop 0))
                    (assoc def prop (coerce-yes-no v)))))
              definition
              yes-no-form-props)
      (#(reduce (fn [d prop]
                  (if (contains? d prop)
                    (assoc d prop (coerce-to-number (get d prop)))
                    d))
                % number-form-props))
      (#(cond-> %
          (:header %) (update :header normalize-section)
          true        (update :detail normalize-section)
          (:footer %) (update :footer normalize-section)))
      (#(if-let [rs (get % :record-source)]
          (assoc % :record-source (str/lower-case rs))
          %))))

(defn build-form-editor-state
  "Build the initial form-editor state map. Pure — no side effects."
  [form-id definition]
  {:form-id form-id
   :dirty? false
   :original definition
   :current definition
   :selected-control nil
   :synced-controls (build-synced-controls definition)
   :projection (projection/build-projection definition)})

(defn load-reactions-for-form!
  "Fetch reaction specs for a form's class module and register them into the projection.
   Handles two spec formats:
   - Simple: {:trigger :ctrl :prop :value} — constant value, flat set-control-* handlers
   - Cases:  {:trigger :ctrl :prop :cases [{:when v :then r}]} — value-switch, lookup by field value"
  [form-name]
  (let [module-name (str "Form_" form-name)]
    (go
      (let [response (<! (http/get (str api-base "/api/modules/" (js/encodeURIComponent module-name) "/reactions")
                                    {:headers (db-headers)}))]
        (when (:success response)
          (let [specs (:body response)]
            (when (seq specs)
              (swap! app-state update-in [:form-editor :projection]
                     (fn [proj]
                       (reduce (fn [p {:keys [trigger ctrl prop value cases]}]
                                 (let [value-fn (if cases
                                                  ;; `some` would swallow false values — use filter+first
                                                  (fn [v _]
                                                    (let [match (first (filter #(= v (:when %)) cases))]
                                                      (when (some? match) (:then match))))
                                                  (constantly value))]
                                   (projection/register-reaction
                                     p
                                     (keyword trigger)
                                     (keyword ctrl)
                                     (keyword prop)
                                     value-fn)))
                               proj
                               specs))))))))))

(defn load-event-handlers-for-form!
  "Fetch event handler descriptors for a form's class module and register them
   into the projection's :event-handlers map."
  [form-name]
  (let [module-name (str "Form_" form-name)]
    (go
      (let [response (<! (http/get (str api-base "/api/modules/" (js/encodeURIComponent module-name) "/handlers")
                                    {:headers (db-headers)}))]
        (when (:success response)
          (let [handlers (:body response)]
            (when (seq handlers)
              (swap! app-state update-in [:form-editor :projection]
                     projection/register-event-handlers handlers))))))))

(defn- setup-form-editor!
  "Initialize the form editor state with a normalized definition."
  [form-id definition & [form-name]]
  (swap! app-state assoc :form-editor (build-form-editor-state form-id definition))
  (when (seq form-name)
    (load-reactions-for-form! form-name)
    (load-event-handlers-for-form! form-name))
  (maybe-auto-analyze!)
  (set-view-mode! :view))

(defn- auto-save-form-state!
  "Auto-save dirty record and/or form definition before switching."
  []
  (when (get-in @app-state [:form-editor :projection :dirty?])
    (save-current-record!))
  (when (get-in @app-state [:form-editor :dirty?])
    (save-form!)))

(defn load-form-for-editing! [form]
  (auto-save-form-state!)
  (clear-row-source-cache!)
  (clear-subform-cache!)
  (let [fname (:filename form)]
    (if (:definition form)
      (setup-form-editor! (:id form) (normalize-form-definition (:definition form)) fname)
      (go
        (let [response (<! (http/get (str api-base "/api/forms/" (js/encodeURIComponent fname))
                                      {:headers (db-headers)}))]
          (if (:success response)
            (let [body (:body response)
                  personalized? (boolean (:_personalized body))
                  definition (normalize-form-definition (dissoc body :id :name :_personalized))]
              (swap! app-state update-in [:objects :forms]
                     (fn [forms]
                       (mapv #(if (= (:id %) (:id form))
                                (assoc % :definition definition) %)
                             forms)))
              (setup-form-editor! (:id form) definition fname)
              (swap! app-state assoc-in [:form-editor :personalized?] personalized?))
            (log-error! (str "Failed to load form: " fname) "load-form-for-editing" {:form fname})))))))

(defn reset-form-personalization!
  "Reset the current form to the standard version by removing personalization."
  []
  (let [form-id (get-in @app-state [:form-editor :form-id])
        form-obj (first (filter #(= (:id %) form-id)
                                (get-in @app-state [:objects :forms])))
        fname (:filename form-obj)]
    (when fname
      (go
        (let [response (<! (http/delete (str api-base "/api/forms/" (js/encodeURIComponent fname) "/personalization")
                                         {:headers (db-headers)}))]
          (if (:success response)
            (load-form-for-editing! (assoc form-obj :definition nil))
            (log-error! "Failed to reset form personalization" "reset-form-personalization" {:form fname})))))))

(defn promote-form-to-standard!
  "Copy the current personalized form as the new standard version."
  []
  (let [form-id (get-in @app-state [:form-editor :form-id])
        form-obj (first (filter #(= (:id %) form-id)
                                (get-in @app-state [:objects :forms])))
        fname (:filename form-obj)]
    (when fname
      (go
        (let [response (<! (http/post (str api-base "/api/forms/" (js/encodeURIComponent fname) "/promote")
                                       {:headers (db-headers)}))]
          (if (:success response)
            (println (str "[PROMOTE] Promoted personalized form to standard: " fname))
            (log-error! "Failed to promote form to standard" "promote-form" {:form fname})))))))

(defn select-control! [idx]
  (swap! app-state assoc-in [:form-editor :selected-control] idx))

;; ============================================================
;; FORM CONTROL OPERATIONS
;; ============================================================

(defn delete-control!
  "Delete a control from a section"
  [section idx]
  (let [form-editor (:form-editor @app-state)
        current (:current form-editor)
        controls (or (get-in current [section :controls]) [])]
    (when (< idx (count controls))
      (let [new-controls (vec (concat (subvec controls 0 idx)
                                      (subvec controls (inc idx))))]
        (swap! app-state assoc-in [:form-editor :selected-control] nil)
        (set-form-definition! (assoc-in current [section :controls] new-controls))))))

(defn update-control!
  "Update a property of a control in a section"
  [section idx prop value]
  (let [form-editor (:form-editor @app-state)
        current (:current form-editor)
        controls (or (get-in current [section :controls]) [])]
    (when (< idx (count controls))
      (set-form-definition!
       (assoc-in current [section :controls]
                 (update controls idx assoc prop value))))))
