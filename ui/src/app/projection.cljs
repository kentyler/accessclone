(ns app.projection
  "Pure data projection for forms. Separates data concerns (record, bindings,
   computed fields, row-sources, events) from UI rendering. The UI binds to
   the projection as its single source of truth for form data."
  (:require [clojure.set :as set]
            [clojure.string :as str]
            [app.views.expressions :as expr]))

;; ============================================================
;; HELPERS
;; ============================================================

(defn ctrl->kw
  "Convert a control name to a keyword using the same algorithm as the
   wiring generator (toClojureName): split camelCase, lowercase, collapse
   non-alphanumeric to hyphens.
   E.g. SubformCustomers → :subform-customers, OptionGroup1 → :option-group1"
  [s]
  (when (seq (str s))
    (-> (str s)
        (str/replace #"([a-z])([A-Z])" "$1-$2")
        str/lower-case
        (str/replace #"[^a-z0-9]+" "-")
        (str/replace #"^-|-$" "")
        keyword)))

(defn- scan-controls
  "Walk header/detail/footer sections, collect all controls into a flat seq."
  [definition]
  (mapcat (fn [section-key]
            (get-in definition [section-key :controls]))
          [:header :detail :footer]))

(defn- extract-field-refs
  "Extract field references from an Access expression string.
   Matches [FieldName] patterns, excluding Forms/TempVars/Form prefixes
   and dotted cross-form references like [sfrmX].[Form].[ctrl].
   Returns set of lowercase keywords."
  [expr-str]
  (let [;; Find all [Name] tokens and their positions for dot-path filtering
        raw-matches (re-seq #"\[([^\]]+)\]" expr-str)
        names (map second raw-matches)]
    (->> names
         ;; Remove known system prefixes
         (remove #(#{"Forms" "TempVars" "Form"} %))
         ;; Remove names that appear before a dot-bracket pattern (cross-form refs)
         ;; e.g. [sfrmOrderLineItems].[Form].[txtSubTotal] — "sfrmOrderLineItems" is a cross-ref
         (remove (fn [name]
                   (let [pattern (str "[" name "].[")]
                     (str/includes? expr-str pattern))))
         (map (comp keyword str/lower-case))
         set)))

;; ============================================================
;; EXTRACTORS
;; ============================================================

(defn- extract-bindings
  "Extract field bindings and computed bindings from controls.
   Returns {:bindings {field-kw nil ...} :computed {ctrl-name-kw {:expression str :deps #{kw ...}} ...}}"
  [controls]
  (reduce
    (fn [acc ctrl]
      (let [raw-field (or (:control-source ctrl) (:field ctrl))]
        (cond
          ;; Computed: control-source starts with =
          (and raw-field (expr/expression? (str raw-field)))
          (let [ctrl-name (keyword (str/lower-case (or (:name ctrl) "")))
                expr-body (subs (str raw-field) 1)]
            (-> acc
                (assoc-in [:computed ctrl-name]
                          {:expression expr-body
                           :deps (extract-field-refs expr-body)})))

          ;; Bound field
          (and raw-field (string? raw-field) (not (str/blank? raw-field)))
          (let [field-kw (keyword (str/lower-case raw-field))]
            (update acc :bindings assoc field-kw nil))

          :else acc)))
    {:bindings {} :computed {}}
    controls))

(defn- extract-row-sources
  "Extract row-source specs from combo-box and list-box controls.
   Returns {field-kw {:source str :type :query|:value-list :bound-col n :col-widths [...] :options nil} ...}"
  [controls]
  (reduce
    (fn [acc ctrl]
      (let [rs (:row-source ctrl)
            field-kw (keyword (str/lower-case (or (:field ctrl) (:name ctrl) "")))
            trimmed (str/trim (str rs))
            rs-type (cond
                      (re-find #"(?i)^select\s" trimmed) :sql
                      (str/includes? trimmed ";")        :value-list
                      :else                              :query)
            col-widths (when-let [cw (:column-widths ctrl)]
                         (mapv #(js/parseInt % 10)
                               (str/split (str cw) #"[;,]")))]
        (assoc acc field-kw
               {:source trimmed
                :type rs-type
                :bound-col (or (:bound-column ctrl) 1)
                :col-widths col-widths
                :options (when (= rs-type :value-list)
                          (let [items (->> (str/split trimmed #";")
                                          (mapv str/trim)
                                          (filterv #(not (str/blank? %)))
                                          (mapv #(str/replace % #"^\"|\"$" "")))]
                            {:rows (mapv (fn [v] {"value" v}) items)
                             :fields [{:name "value"}]}))})))
    {}
    (filter (fn [ctrl]
              (and (:row-source ctrl)
                   (#{:combo-box :list-box "combo-box" "list-box"}
                    (:type ctrl))))
            controls)))

(defn- extract-subforms
  "Extract subform control specs.
   Returns {source-form-str {:link {:master str :child str}} ...}"
  [controls]
  (reduce
    (fn [acc ctrl]
      (let [sf (or (:source-form ctrl) (:source_form ctrl))
            sf-name (str/lower-case (str sf))
            master (or (:link-master-fields ctrl) (:link_master_fields ctrl))
            child (or (:link-child-fields ctrl) (:link_child_fields ctrl))]
        (assoc acc sf-name
               {:link {:master (when master (str master))
                       :child (when child (str child))}})))
    {}
    (filter #(= :subform (keyword (or (:type %) ""))) controls)))

(def ^:private form-event-flags
  "Form-level has-*-event flag keys."
  [:has-load-event :has-open-event :has-close-event :has-current-event
   :has-before-insert-event :has-after-insert-event
   :has-before-update-event :has-after-update-event
   :has-delete-event])

(defn- extract-events
  "Extract form-level event flags from the definition.
   Returns {flag-kw true ...} for any event that is set."
  [definition]
  (into {}
        (keep (fn [k]
                (when (get definition k)
                  [k true])))
        form-event-flags))

(def ^:private control-event-flags
  "Control-level event flag keys to scan for."
  [:has-click-event :has-dblclick-event :has-change-event
   :has-enter-event :has-exit-event
   :has-before-update-event :has-after-update-event
   :has-gotfocus-event :has-lostfocus-event])

(defn- extract-field-triggers
  "Extract control-level event triggers.
   Returns {field-kw {flag-kw true ...} ...} for controls that have events."
  [controls]
  (reduce
    (fn [acc ctrl]
      (let [ctrl-name (keyword (str/lower-case (or (:name ctrl) (:field ctrl) "")))
            flags (into {}
                        (keep (fn [k] (when (get ctrl k) [k true])))
                        control-event-flags)]
        (if (seq flags)
          (assoc acc ctrl-name flags)
          acc)))
    {}
    controls))

(defn- extract-control-state
  "Seed mutable state for every named control from the form definition.
   Invariant: every control with a non-nil ctrl->kw will have an entry here,
   so form-view-control can use ctrl-kw (not cs) as the 'has projection entry?' gate.
   Returns {ctrl-kw {:visible bool :enabled bool :locked bool :caption str-or-nil} ...}"
  [controls]
  (reduce
    (fn [acc ctrl]
      (let [ctrl-name (or (:name ctrl) (:field ctrl))
            ctrl-kw   (ctrl->kw ctrl-name)]
        (if ctrl-kw
          (assoc acc ctrl-kw
                 {:visible (not= 0 (get ctrl :visible 1))
                  :enabled (not= 0 (get ctrl :enabled 1))
                  :locked  (= 1 (:locked ctrl))
                  :caption (when-let [c (or (:caption ctrl) (:text ctrl))] (str c))})
          acc)))
    {}
    controls))

;; ============================================================
;; PUBLIC API
;; ============================================================

(defn- evaluate-computed-for
  "Re-evaluate only computed fields whose :deps intersect changed-fields."
  [projection changed-fields]
  (update projection :computed
          (fn [computed]
            (reduce-kv
              (fn [acc ctrl-kw spec]
                (if (seq (set/intersection (:deps spec) changed-fields))
                  (assoc acc ctrl-kw
                         (assoc spec :value
                                (expr/evaluate-expression
                                  (:expression spec)
                                  {:record (:bindings projection)})))
                  acc))
              computed
              computed))))

(defn- evaluate-computed
  "Evaluate all computed fields using current bindings as record context."
  [projection]
  (update projection :computed
          (fn [computed]
            (reduce-kv
              (fn [acc ctrl-kw spec]
                (assoc acc ctrl-kw
                       (assoc spec :value
                              (expr/evaluate-expression
                                (:expression spec)
                                {:record (:bindings projection)}))))
              computed
              computed))))

(defn- settle-reactions
  "Fire reactions for changed-fields, apply results to projection's control-state.
   Only reactions whose trigger key is in changed-fields are evaluated."
  [projection changed-fields]
  (let [reactions (:reactions projection)]
    (if (empty? reactions)
      projection
      (reduce
        (fn [proj trigger-kw]
          (let [entries   (get reactions trigger-kw)
                field-val (get (:record proj) trigger-kw)]
            (reduce
              (fn [p {:keys [ctrl prop value-fn]}]
                (assoc-in p [:control-state ctrl prop] (value-fn field-val (:record p))))
              proj
              entries)))
        projection
        (filter #(contains? reactions %) changed-fields)))))

(defn register-reaction
  "Register a reaction: when trigger-kw field changes, evaluate
   (value-fn field-val record) and apply the result to ctrl-kw's prop-kw
   in control-state.
   E.g. (register-reaction proj :status :btn-approve :visible #(= % \"Active\"))"
  [projection trigger-kw ctrl-kw prop-kw value-fn]
  (update-in projection [:reactions trigger-kw]
             (fnil conj [])
             {:ctrl ctrl-kw :prop prop-kw :value-fn value-fn}))

(defn update-field
  "Update a field in bindings and record, mark dirty,
   re-evaluate affected computed fields, settle dependent reactions."
  [projection field-kw value]
  (let [proj (-> projection
                 (assoc-in [:bindings field-kw] value)
                 (assoc-in [:record field-kw] value)
                 (assoc :dirty? true))]
    (-> proj
        (evaluate-computed-for #{field-kw})
        (settle-reactions #{field-kw}))))

(defn hydrate-bindings
  "Fill binding values from a record map. Case-insensitive keyword lookup.
   Stores the full record, evaluates all computed fields, and settles all reactions."
  [projection record]
  (if-not (map? record)
    projection
    (let [record-lc (into {}
                          (map (fn [[k v]]
                                 [(keyword (str/lower-case (name k))) v]))
                          record)]
      (-> projection
          (assoc :record record-lc)
          (update :bindings
                  (fn [bindings]
                    (reduce-kv
                      (fn [acc field-kw _]
                        (assoc acc field-kw (get record-lc field-kw)))
                      bindings
                      bindings)))
          evaluate-computed
          (settle-reactions (set (keys (:reactions projection))))))))

(defn sync-records
  "Assoc records, position, total, then hydrate bindings at position."
  [projection records position total]
  (let [proj (assoc projection :records records :position position :total total)
        idx  (dec position)]
    (if (and (pos? position) (< idx (count records)))
      (hydrate-bindings proj (nth records idx))
      proj)))

(defn sync-position
  "Update position and re-hydrate bindings from stored records."
  [projection position]
  (let [proj (assoc projection :position position)
        idx  (dec position)]
    (if (and (pos? position) (< idx (count (:records proj))))
      (hydrate-bindings proj (nth (:records proj) idx))
      proj)))

(defn populate-row-source
  "Set :options on the row-source entry whose :source matches source-str."
  [projection source-str data]
  (let [match-kw (some (fn [[kw spec]]
                          (when (= (:source spec) source-str) kw))
                        (:row-sources projection))]
    (if match-kw
      (assoc-in projection [:row-sources match-kw :options] data)
      projection)))

(defn set-control-state
  "Set a mutable property on a control in the projection.
   prop-kw is one of :visible :enabled :locked :caption.
   E.g. (set-control-state projection :btn-save :visible false)"
  [projection ctrl-kw prop-kw value]
  (assoc-in projection [:control-state ctrl-kw prop-kw] value))

(defn build-projection
  "Build a projection map from a normalized form definition.
   The projection captures all data concerns: bindings, computed fields,
   row-sources, subforms, events, field triggers, and per-control mutable state."
  [definition]
  (let [controls (scan-controls definition)
        {:keys [bindings computed]} (extract-bindings controls)]
    {:record-source (:record-source definition)
     :record {}
     :bindings bindings
     :computed computed
     :row-sources (extract-row-sources controls)
     :subforms (extract-subforms controls)
     :events (extract-events definition)
     :field-triggers (extract-field-triggers controls)
     :control-state (extract-control-state controls)
     :reactions {}
     :records []
     :position 0
     :total 0
     :dirty? false}))
