(ns app.views.report-utils
  "Utility functions for the report editor.
   Shared functions delegated to editor-utils; report-specific functions here."
  (:require [clojure.string :as str]
            [app.views.editor-utils :as eu]))

;; --- Re-export shared functions ---
(def snap-to-grid eu/snap-to-grid)
(def get-record-source-fields eu/get-record-source-fields)
(def get-section-controls eu/get-section-controls)
(def control-style eu/control-style)
(def resolve-control-field eu/resolve-control-field)
(def resolve-field-value eu/resolve-field-value)
(def display-text eu/display-text)
(def format-value eu/format-value)

;; --- Report-specific constants ---

;; Standard report sections in display order
(def standard-sections
  [:report-header :page-header :detail :page-footer :report-footer])

(def section-display-names
  {:report-header "Report Header"
   :page-header   "Page Header"
   :detail        "Detail"
   :page-footer   "Page Footer"
   :report-footer "Report Footer"})

;; --- Report-specific functions ---

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

(defn get-section-height
  "Get height of a report section, with report-specific defaults"
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
