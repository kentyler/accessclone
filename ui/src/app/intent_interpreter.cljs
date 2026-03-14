(ns app.intent-interpreter
  "Lightweight interpreter that walks structured intent trees from VBA module
   translation and dispatches to existing framework functions.

   Each intent is a map with :type and type-specific keys. Intents are executed
   sequentially; branching intents (value-switch, branch, confirm-action) may
   contain nested intent lists.

   execute-intents returns a core.async channel (go block). Sync intents execute
   immediately; async intents (dlookup, dcount, dsum, run-sql) await HTTP responses.
   A ctx map threads through the loop for result passing (:last-result)."
  (:require [app.state :as state :refer [app-state api-base db-headers]]
            [app.state-form :as state-form]
            [app.projection :as projection]
            [app.views.expressions :as expr]
            [app.flows.core :as f]
            [app.flows.form :as form-flow]
            [app.flows.navigation :as nav]
            [app.transforms.core :as t]
            [clojure.string :as str]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; HELPERS
;; ============================================================

(defn- find-object-by-name
  "Find an object (form/report) by name in the objects list.
   Matches against :filename and :name (case-insensitive)."
  [object-type target-name]
  (let [objects (get-in @app-state [:objects object-type] [])
        target-lc (str/lower-case (str target-name))]
    (first (filter (fn [obj]
                     (or (= (str/lower-case (str (:filename obj))) target-lc)
                         (= (str/lower-case (str (:name obj))) target-lc)))
                   objects))))

(defn- resolve-intent-value
  "Resolve an intent value — could be a literal, a field reference like [FieldName],
   or {var_name} to read a named result or field from ctx/record."
  [v ctx]
  (cond
    (not (string? v)) v

    ;; {var_name} placeholder — check ctx vars first, then current record
    (re-matches #"\{(.+)\}" v)
    (let [var-name (second (re-matches #"\{(.+)\}" v))
          var-kw (keyword (str/lower-case var-name))]
      (or (get ctx var-kw)
          (get-in @app-state [:form-editor :projection :record var-kw])))

    ;; [FieldName] reference — look up in current record
    (re-matches #"\[(.+)\]" v)
    (let [field-name (second (re-matches #"\[(.+)\]" v))
          field-kw (keyword (str/lower-case field-name))]
      (get-in @app-state [:form-editor :projection :record field-kw]))

    :else v))

(defn- strip-brackets
  "Remove Access-style brackets from a name: [OrderID] → OrderID"
  [s]
  (if (and (string? s) (str/starts-with? s "[") (str/ends-with? s "]"))
    (subs s 1 (dec (count s)))
    s))

(defn- resolve-criteria-placeholders
  "Replace {FieldName} placeholders in criteria with actual values from the
   current record and ctx. Numeric values are inlined; strings are quoted."
  [criteria ctx]
  (if-not (string? criteria)
    criteria
    (str/replace criteria #"\{([^}]+)\}"
      (fn [[_ var-name]]
        (let [var-kw (keyword (str/lower-case var-name))
              val (or (get ctx var-kw)
                      (get-in @app-state [:form-editor :projection :record var-kw]))]
          (cond
            (nil? val)    "NULL"
            (number? val) (str val)
            :else         (str "'" (str/replace (str val) "'" "''") "'")))))))

(defn- convert-criteria
  "Convert Access/intent criteria string to PostgreSQL WHERE clause fragment.
   1. Resolves {FieldName} placeholders to actual values
   2. Converts [field] → \"field\" (Access bracket syntax)
   3. Converts #date# → 'date', True/False → true/false
   4. Converts bare identifiers (FieldName = value) to quoted identifiers"
  [criteria ctx]
  (when (and criteria (string? criteria) (not (str/blank? criteria)))
    (-> criteria
        ;; Resolve {FieldName} placeholders first
        (resolve-criteria-placeholders ctx)
        ;; [FieldName] → "fieldname"
        (str/replace #"\[([^\]]+)\]" (fn [[_ name]] (str "\"" (str/lower-case name) "\"")))
        ;; #date# → 'date'
        (str/replace #"#([^#]+)#" "'$1'")
        ;; True/False → true/false
        (str/replace #"(?i)\bTrue\b" "true")
        (str/replace #"(?i)\bFalse\b" "false"))))

;; ============================================================
;; ASYNC INTENT HELPERS
;; ============================================================

(defn- run-domain-query
  "Run a SQL query via POST /api/queries/run. Returns channel with response."
  [sql]
  (http/post (str api-base "/api/queries/run")
             {:json-params {:sql sql}
              :headers (db-headers)}))

(defn- store-result
  "Store a dlookup/dcount/dsum result in ctx under :last-result and
   optionally under the :result_var name for later {var} references."
  [ctx intent val]
  (let [result-var (:result_var intent)]
    (cond-> (assoc ctx :last-result val)
      result-var (assoc (keyword (str/lower-case result-var)) val))))

(defn- handle-dlookup
  "Execute DLookup: SELECT field FROM table WHERE criteria LIMIT 1.
   Returns channel that yields updated ctx with :last-result."
  [intent ctx]
  (let [field (str/lower-case (strip-brackets (or (:field intent) "*")))
        table (str/lower-case (strip-brackets (or (:table intent) (:domain intent) "")))
        criteria (convert-criteria (:criteria intent) ctx)
        sql (str "SELECT \"" field "\" FROM \"" table "\""
                 (when criteria (str " WHERE " criteria))
                 " LIMIT 1")]
    (go
      (let [response (<! (run-domain-query sql))]
        (if (:success response)
          (let [rows (get-in response [:body :data] [])
                val (when (seq rows) (get (first rows) (keyword field)))]
            (store-result ctx intent val))
          (do (js/console.warn "DLookup failed:" (get-in response [:body :error]) "SQL:" sql)
              (store-result ctx intent nil)))))))

(defn- handle-dcount
  "Execute DCount: SELECT COUNT(field) FROM table WHERE criteria.
   Returns channel that yields updated ctx with :last-result."
  [intent ctx]
  (let [field (str/lower-case (strip-brackets (or (:field intent) "*")))
        table (str/lower-case (strip-brackets (or (:table intent) (:domain intent) "")))
        criteria (convert-criteria (:criteria intent) ctx)
        col-expr (if (= field "*") "*" (str "\"" field "\""))
        sql (str "SELECT COUNT(" col-expr ") AS cnt FROM \"" table "\""
                 (when criteria (str " WHERE " criteria)))]
    (go
      (let [response (<! (run-domain-query sql))]
        (if (:success response)
          (let [rows (get-in response [:body :data] [])
                val (when (seq rows) (get (first rows) :cnt 0))]
            (store-result ctx intent val))
          (do (js/console.warn "DCount failed:" (get-in response [:body :error]) "SQL:" sql)
              (store-result ctx intent 0)))))))

(defn- handle-dsum
  "Execute DSum: SELECT SUM(field) FROM table WHERE criteria.
   Returns channel that yields updated ctx with :last-result."
  [intent ctx]
  (let [field (str/lower-case (strip-brackets (or (:field intent) "0")))
        table (str/lower-case (strip-brackets (or (:table intent) (:domain intent) "")))
        criteria (convert-criteria (:criteria intent) ctx)
        sql (str "SELECT SUM(\"" field "\") AS total FROM \"" table "\""
                 (when criteria (str " WHERE " criteria)))]
    (go
      (let [response (<! (run-domain-query sql))]
        (if (:success response)
          (let [rows (get-in response [:body :data] [])
                val (when (seq rows) (get (first rows) :total 0))]
            (store-result ctx intent val))
          (do (js/console.warn "DSum failed:" (get-in response [:body :error]) "SQL:" sql)
              (store-result ctx intent 0)))))))

(defn- handle-run-sql
  "Execute INSERT/UPDATE/DELETE SQL via POST /api/queries/execute.
   Returns channel that yields updated ctx with :last-result (row count)."
  [intent ctx]
  (let [sql (or (:sql intent) "")]
    (go
      (let [response (<! (http/post (str api-base "/api/queries/execute")
                                     {:json-params {:sql sql}
                                      :headers (db-headers)}))]
        (if (:success response)
          (assoc ctx :last-result (get-in response [:body :rowCount] 0))
          (do (js/console.warn "run-sql failed:" (get-in response [:body :error]))
              (assoc ctx :last-result nil)))))))

;; ============================================================
;; INTENT DISPATCH
;; ============================================================

(declare execute-intents)

(defn- execute-single-intent
  "Execute a single intent. Returns either:
   - nil for sync intents (already executed)
   - a core.async channel yielding updated ctx for async intents"
  [intent ctx]
  (let [intent-type (keyword (:type intent))]
    (case intent-type
      ;; --- Navigation ---
      :open-form
      (let [form-name (or (:form intent) (:name intent))
            form-obj (find-object-by-name :forms form-name)]
        (if form-obj
          (state/open-object! :forms (:id form-obj))
          (js/console.warn "Intent: form not found:" form-name))
        nil)

      :open-report
      (let [report-name (or (:report intent) (:name intent))
            report-obj (find-object-by-name :reports report-name)]
        (if report-obj
          (state/open-object! :reports (:id report-obj))
          (js/console.warn "Intent: report not found:" report-name))
        nil)

      :close-current
      (do (f/run-fire-and-forget! nav/close-current-tab-flow) nil)

      ;; --- Record operations ---
      :goto-record
      (let [target (:target intent)
            records (get-in @app-state [:form-editor :projection :records] [])
            total (count records)
            pos (case (keyword (str target))
                  :first 1
                  :last total
                  :next (min total (inc (get-in @app-state [:form-editor :projection :position] 1)))
                  :previous (max 1 (dec (get-in @app-state [:form-editor :projection :position] 1)))
                  :new-record (inc total)
                  (if (number? target) target 1))]
        (if (= (keyword (str target)) :new-record)
          (t/dispatch! :new-record)
          (state-form/navigate-to-record! pos))
        nil)

      :new-record
      (do (t/dispatch! :new-record) nil)

      :save-record
      (do (f/run-fire-and-forget! form-flow/save-current-record-flow) nil)

      :delete-record
      (do (when (js/confirm "Delete this record?")
            (f/run-fire-and-forget! form-flow/delete-current-record-flow))
          nil)

      :requery
      (do (f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :view}) nil)

      ;; --- Messages ---
      :show-message
      (do (js/alert (str (or (:message intent) (:text intent) ""))) nil)

      :confirm-action
      (let [msg (or (:message intent) (:text intent) "Continue?")
            confirmed? (js/confirm msg)]
        (if confirmed?
          (when-let [then-intents (:then intent)]
            (go (<! (execute-intents then-intents ctx)) nil))
          (when (:else intent)
            (go (<! (execute-intents (:else intent) ctx)) nil))))

      ;; --- Control state ---
      :set-control-visible
      (let [ctrl-kw (projection/ctrl->kw (:control intent))
            val (resolve-intent-value (:value intent) ctx)
            visible? (cond
                       (boolean? val) val
                       (= val -1) true
                       (= val 0) false
                       :else (boolean val))]
        (when ctrl-kw
          (swap! app-state update-in [:form-editor :projection]
                 projection/set-control-state ctrl-kw :visible visible?))
        nil)

      :set-control-enabled
      (let [ctrl-kw (projection/ctrl->kw (:control intent))
            val (resolve-intent-value (:value intent) ctx)
            enabled? (cond
                       (boolean? val) val
                       (= val -1) true
                       (= val 0) false
                       :else (boolean val))]
        (when ctrl-kw
          (swap! app-state update-in [:form-editor :projection]
                 projection/set-control-state ctrl-kw :enabled enabled?))
        nil)

      :set-control-value
      (let [ctrl-kw (projection/ctrl->kw (:control intent))
            val (resolve-intent-value (:value intent) ctx)]
        (when ctrl-kw
          (swap! app-state update-in [:form-editor :projection]
                 projection/set-control-state ctrl-kw :caption (str val)))
        nil)

      ;; --- Field operations ---
      :write-field
      (let [field (or (:field intent) (:target intent))
            val (resolve-intent-value (:value intent) ctx)]
        (when field
          (state-form/update-record-field! field val))
        nil)

      :validate-required
      (let [field (or (:field intent) (:control intent))
            field-kw (keyword (str/lower-case (str field)))
            val (get-in @app-state [:form-editor :projection :record field-kw])
            msg (or (:message intent) (str field " is required."))]
        (when (or (nil? val) (and (string? val) (str/blank? val)))
          (js/alert msg)
          (throw (js/Error. (str "Validation failed: " field))))
        nil)

      ;; --- Branching ---
      :value-switch
      (let [field (or (:field intent) (:control intent))
            field-kw (keyword (str/lower-case (str field)))
            current-val (get-in @app-state [:form-editor :projection :record field-kw])
            cases (:cases intent)
            matching-case (first (filter #(= (:when %) current-val) cases))
            default-case (first (filter #(= (:when %) :default) cases))]
        (when-let [then-intents (:then (or matching-case default-case))]
          (go (<! (execute-intents then-intents ctx)) nil)))

      :branch
      (let [condition (:condition intent)
            record (get-in @app-state [:form-editor :projection :record] {})
            result (cond
                     (string? condition)
                     (expr/truthy?
                      (expr/evaluate-expression condition {:record record}))
                     (boolean? condition) condition
                     :else (expr/truthy? condition))]
        (if result
          (when (:then intent)
            (go (<! (execute-intents (:then intent) ctx)) nil))
          (when (:else intent)
            (go (<! (execute-intents (:else intent) ctx)) nil))))

      :error-handler
      (try
        (when (:body intent)
          (go (<! (execute-intents (:body intent) ctx)) nil))
        (catch :default e
          (js/console.warn "Intent error-handler caught:" (.-message e))
          nil))

      ;; --- Async domain functions ---
      :dlookup  (handle-dlookup intent ctx)
      :dcount   (handle-dcount intent ctx)
      :dsum     (handle-dsum intent ctx)
      :run-sql  (handle-run-sql intent ctx)

      ;; --- Unsupported ---
      (do (js/console.warn "Unsupported intent type:" (name intent-type)
                           (clj->js intent))
          nil))))

(defn execute-intents
  "Execute a sequence of intent maps. Returns a core.async channel.
   Async intents (dlookup, dcount, dsum, run-sql) are awaited before
   continuing to the next intent. A ctx map threads :last-result through."
  ([intents] (execute-intents intents {}))
  ([intents initial-ctx]
   (go
     (loop [remaining (seq intents)
            ctx initial-ctx]
       (if-not remaining
         ctx
         (let [intent (first remaining)
               result (try
                        (execute-single-intent intent ctx)
                        (catch :default e
                          (js/console.warn "Intent execution error:" (.-message e))
                          nil))]
           (if (some? result)
             ;; result is a channel — await it for updated ctx
             (let [new-ctx (<! result)]
               (recur (next remaining)
                      (if (map? new-ctx) new-ctx ctx)))
             ;; sync intent, ctx unchanged
             (recur (next remaining) ctx))))))))
