(ns app.views.report-utils
  "Shared utility functions for the report editor"
  (:require [clojure.string :as str]
            [app.state :as state]
            [app.views.expressions :as expr]))

;; Standard report sections in display order
(def standard-sections
  [:report-header :page-header :detail :page-footer :report-footer])

(def section-display-names
  {:report-header "Report Header"
   :page-header   "Page Header"
   :detail        "Detail"
   :page-footer   "Page Footer"
   :report-footer "Report Footer"})

(defn group-section-display-name
  "Parse :group-header-0 to 'GroupHeader0', :group-footer-1 to 'GroupFooter1'"
  [section-key]
  (let [n (name section-key)]
    (cond
      (str/starts-with? n "group-header-")
      (str "Group Header " (subs n (count "group-header-")))
      (str/starts-with? n "group-footer-")
      (str "Group Footer " (subs n (count "group-footer-")))
      :else n)))

(defn parse-group-index
  "Extract the numeric index from :group-header-0 -> 0"
  [section-key]
  (let [n (name section-key)]
    (when-let [m (re-find #"\d+$" n)]
      (js/parseInt m 10))))

(defn get-group-section-keys
  "Get all group-header-N and group-footer-N keys from the report definition, sorted."
  [report-def]
  (let [all-keys (keys report-def)]
    (->> all-keys
         (filter (fn [k]
                   (let [n (name k)]
                     (or (str/starts-with? n "group-header-")
                         (str/starts-with? n "group-footer-")))))
         (sort-by (fn [k]
                    (let [n (name k)
                          idx (parse-group-index k)
                          prefix (if (str/starts-with? n "group-header-") 0 1)]
                      [idx prefix]))))))

(defn get-all-sections
  "Returns ordered section keys: report-header, page-header, group-header-0, detail, group-footer-0, page-footer, report-footer"
  [report-def]
  (let [group-keys (get-group-section-keys report-def)
        group-headers (filter #(str/starts-with? (name %) "group-header-") group-keys)
        group-footers (filter #(str/starts-with? (name %) "group-footer-") group-keys)]
    (vec (concat [:report-header :page-header]
                 group-headers
                 [:detail]
                 (reverse group-footers)
                 [:page-footer :report-footer]))))

(defn section-display-name
  "Get display name for any section key"
  [section-key]
  (or (get section-display-names section-key)
      (group-section-display-name section-key)))

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
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

(defn get-section-controls
  "Get controls for a specific report section"
  [report-def section]
  (or (get-in report-def [section :controls]) []))

(defn get-section-height
  "Get height of a report section, with defaults"
  [report-def section]
  (or (get-in report-def [section :height])
      (case section
        :report-header 80
        :page-header 40
        :detail 200
        :page-footer 40
        :report-footer 80
        ;; group sections
        60)))

(defn control-style
  "Position and size style map for a control"
  [ctrl]
  {:left (:x ctrl)
   :top (:y ctrl)
   :width (:width ctrl)
   :height (:height ctrl)})

(defn resolve-control-field
  "Get the bound field name from a control, normalized to lowercase.
   Returns the raw string (with =) for expressions."
  [ctrl]
  (when-let [raw-field (or (:control-source ctrl) (:field ctrl))]
    (if (expr/expression? raw-field)
      raw-field
      (str/lower-case raw-field))))

(defn resolve-field-value
  "Look up a field's value from a record.
   If field starts with '=', evaluates it as an Access expression.
   Optional expr-context provides :group-records and :all-records for aggregates."
  ([field record]
   (resolve-field-value field record nil))
  ([field record expr-context]
   (when field
     (if (expr/expression? field)
       (expr/evaluate-expression
         (subs field 1)
         (merge {:record record} expr-context))
       (or (get record (keyword field))
           (get record field)
           "")))))

(defn display-text
  "Get display text from a control"
  [ctrl]
  (or (:text ctrl) (:label ctrl) (:caption ctrl) ""))
