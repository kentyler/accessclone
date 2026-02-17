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
   Optional expr-context provides :group-records and :all-records for aggregates.
   Optional ctrl, if provided, checks for :computed-function (server-side domain functions)."
  ([field record]
   (resolve-field-value field record nil nil))
  ([field record expr-context]
   (resolve-field-value field record expr-context nil))
  ([field record expr-context ctrl]
   (when field
     ;; If this control has a server-side computed function, read the pre-computed alias
     (if-let [alias (when ctrl (get ctrl :computed-alias))]
       (or (get record (keyword alias))
           (get record alias)
           "")
       (if (expr/expression? field)
         (expr/evaluate-expression
           (subs field 1)
           (merge {:record record} expr-context))
         (or (get record (keyword field))
             (get record field)
             ""))))))

(defn- parse-date
  "Try to parse a value as a JS Date. Returns Date or nil."
  [v]
  (when v
    (let [d (js/Date. v)]
      (when-not (js/isNaN (.getTime d)) d))))

(defn- format-date
  "Format a Date with an Access-style date format string."
  [d fmt-lower]
  (case fmt-lower
    "short date"   (.toLocaleDateString d "en-US")
    "medium date"  (let [months ["Jan" "Feb" "Mar" "Apr" "May" "Jun"
                                 "Jul" "Aug" "Sep" "Oct" "Nov" "Dec"]]
                     (str (.getDate d) "-" (nth months (.getMonth d)) "-"
                          (subs (str (.getFullYear d)) 2)))
    "long date"    (.toLocaleDateString d "en-US" #js {:weekday "long" :year "numeric"
                                                       :month "long" :day "numeric"})
    "short time"   (.toLocaleTimeString d "en-US" #js {:hour "numeric" :minute "2-digit"})
    "medium time"  (.toLocaleTimeString d "en-US" #js {:hour "numeric" :minute "2-digit"})
    "long time"    (.toLocaleTimeString d "en-US" #js {:hour "numeric" :minute "2-digit" :second "2-digit"})
    "general date" (str (.toLocaleDateString d "en-US") " "
                        (.toLocaleTimeString d "en-US" #js {:hour "numeric" :minute "2-digit" :second "2-digit"}))
    nil))

(defn- format-number
  "Format a number with an Access-style number format string."
  [n fmt-lower]
  (case fmt-lower
    "currency"       (.toLocaleString n "en-US" #js {:style "currency" :currency "USD"})
    "fixed"          (.toFixed n 2)
    "standard"       (.toLocaleString n "en-US" #js {:minimumFractionDigits 2 :maximumFractionDigits 2})
    "percent"        (str (.toFixed (* n 100) 2) "%")
    "scientific"     (.toExponential n 2)
    "general number" (str n)
    nil))

(defn format-value
  "Apply an Access format string to a value. Returns formatted string or original value."
  [value fmt]
  (if (or (nil? fmt) (str/blank? fmt) (nil? value) (= value ""))
    value
    (let [fmt-lower (str/lower-case (str/trim fmt))
          s (str value)]
      (or
        ;; Try date formats
        (when-let [d (parse-date value)]
          (format-date d fmt-lower))
        ;; Try number formats
        (let [n (js/parseFloat s)]
          (when-not (js/isNaN n)
            (format-number n fmt-lower)))
        ;; Yes/No formats
        (case fmt-lower
          "yes/no"     (if value "Yes" "No")
          "true/false" (if value "True" "False")
          "on/off"     (if value "On" "Off")
          nil)
        ;; Unrecognized format, return as-is
        value))))

(defn parse-input-mask
  "Parse an Access input mask string into its components.
   Access masks have up to 3 parts separated by semicolons:
   1. The mask pattern
   2. Store literals flag (0=store with literals, 1=data only)
   3. Placeholder character (default _)"
  [mask-str]
  (when (and mask-str (not (str/blank? mask-str)))
    (let [parts (str/split mask-str #";")]
      {:pattern (first parts)
       :store-literals? (not= "1" (second parts))
       :placeholder-char (or (first (nth parts 2 nil)) \_)})))

(defn mask-placeholder
  "Convert an Access mask pattern to a placeholder string showing the expected format.
   Mask chars (0, 9, L, ?, A, a, etc.) become the placeholder char.
   Literal chars and escaped chars (\\x) pass through."
  [pattern placeholder-char]
  (let [pc (or placeholder-char \_)]
    (loop [chars (seq pattern) result [] escape? false]
      (if-not (seq chars)
        (apply str result)
        (let [c (first chars)]
          (cond
            escape?
            (recur (rest chars) (conj result c) false)
            (= c \\)
            (recur (rest chars) result true)
            (contains? #{\0 \9 \# \L \? \A \a \& \C} c)
            (recur (rest chars) (conj result pc) false)
            ;; Case conversion and fill-direction markers are not displayed
            (contains? #{\< \> \!} c)
            (recur (rest chars) result false)
            ;; Everything else is a literal separator
            :else
            (recur (rest chars) (conj result c) false)))))))

(defn- strip-access-hotkey
  "Strip Access &-hotkey markers from caption text.
   In Access, '&V' underlines V as a keyboard shortcut."
  [s]
  (str/replace s #"&(.)" "$1"))

(defn- coerce-display-text
  "Ensure a value is a display-safe string. Vectors (e.g. tab page names)
   are joined with commas."
  [v]
  (cond
    (nil? v)     nil
    (string? v)  (strip-access-hotkey v)
    (vector? v)  (str/join ", " (map #(if (string? %) (strip-access-hotkey %) (str %)) v))
    (seq? v)     (str/join ", " (map #(if (string? %) (strip-access-hotkey %) (str %)) v))
    :else        (str v)))

(defn display-text
  "Get display content from a control. Returns an img element for image controls
   with picture data, otherwise text."
  [ctrl]
  (if (and (#{:image :object-frame} (:type ctrl)) (:picture ctrl))
    [:img {:src (:picture ctrl)
           :style {:width "100%" :height "100%" :object-fit "contain"}
           :draggable false}]
    (or (coerce-display-text (:text ctrl))
        (coerce-display-text (:label ctrl))
        (coerce-display-text (:caption ctrl))
        "")))
