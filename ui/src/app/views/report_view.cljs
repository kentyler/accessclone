(ns app.views.report-view
  "Report preview mode - renders report with live data"
  (:require [clojure.string :as str]
            [app.state :as state]
            [app.views.report-utils :as ru]))

(defn render-report-control
  "Render a single control read-only, resolving field values from record"
  [ctrl record]
  (let [field (ru/resolve-control-field ctrl)
        value (ru/resolve-field-value field record)
        text (or (when (and field (some? value) (not= value ""))
                   (str value))
                 (ru/display-text ctrl))
        ctrl-type (:type ctrl)
        style (merge (ru/control-style ctrl)
                     (when-let [fc (:fore-color ctrl)] {:color fc})
                     (when-let [bc (:back-color ctrl)] {:background-color bc})
                     (when-let [fn (:font-name ctrl)] {:font-family fn})
                     (when-let [fs (:font-size ctrl)] {:font-size fs})
                     (when (= 1 (:font-bold ctrl)) {:font-weight "bold"})
                     (when (= 1 (:font-italic ctrl)) {:font-style "italic"})
                     (when (= 1 (:font-underline ctrl)) {:text-decoration "underline"})
                     (when-let [ta (:text-align ctrl)]
                       {:text-align (str/lower-case ta)}))]
    [:div.report-preview-control
     {:class (when ctrl-type (name ctrl-type))
      :style style}
     (case ctrl-type
       :line [:hr.report-line]
       :rectangle [:div.report-rectangle]
       ;; default: render text
       [:span text])]))

(defn render-section
  "Render all controls in a section with proper height and background"
  [section-key report-def record]
  (let [section-data (get report-def section-key)
        height (or (:height section-data) 40)
        controls (or (:controls section-data) [])
        back-color (:back-color section-data)
        visible? (not= 0 (get section-data :visible 1))]
    (when visible?
      [:div.report-preview-section
       {:class (name section-key)
        :style (cond-> {:min-height height :position "relative"}
                 back-color (assoc :background-color back-color))}
       (for [[idx ctrl] (map-indexed vector controls)]
         ^{:key idx}
         [render-report-control ctrl record])])))

(defn detect-group-breaks
  "Given grouping definitions and two consecutive records, return which groups broke.
   Returns a vector of group indices that changed."
  [grouping prev-record current-record]
  (when (seq grouping)
    (loop [idx 0
           broke? false
           breaks []]
      (if (>= idx (count grouping))
        breaks
        (let [grp (nth grouping idx)
              field-key (keyword (str/lower-case (or (:field grp) "")))
              prev-val (when prev-record (get prev-record field-key))
              curr-val (get current-record field-key)
              changed? (or broke? (not= prev-val curr-val))]
          (recur (inc idx)
                 changed?
                 (if changed? (conj breaks idx) breaks)))))))

(defn report-preview
  "Full report preview with live data"
  []
  (let [report-editor (:report-editor @state/app-state)
        current (:current report-editor)
        records (or (:records report-editor) [])
        record-source (:record-source current)
        grouping (or (:grouping current) [])
        report-width (or (:report-width current) 600)]
    [:div.report-preview
     {:style {:max-width (+ report-width 40)}}
     ;; Report Header (once)
     [render-section :report-header current {}]
     ;; Page Header
     [render-section :page-header current {}]
     ;; Data section: iterate records with group break detection
     (if (seq records)
       [:div.report-data-sections
        (let [elements (atom [])
              prev-record (atom nil)]
          (doseq [[idx record] (map-indexed vector records)]
            (let [breaks (detect-group-breaks grouping @prev-record record)]
              ;; Group footers for previous group (on break, in reverse order)
              (when (and (pos? idx) (seq breaks))
                (doseq [gi (reverse breaks)]
                  (let [footer-key (keyword (str "group-footer-" gi))]
                    (when (get current footer-key)
                      (swap! elements conj
                             ^{:key (str "gf-" gi "-" idx)}
                             [render-section footer-key current @prev-record])))))
              ;; Group headers on break (or first record)
              (when (or (zero? idx) (seq breaks))
                (doseq [gi (if (zero? idx)
                             (range (count grouping))
                             breaks)]
                  (let [header-key (keyword (str "group-header-" gi))]
                    (when (get current header-key)
                      (swap! elements conj
                             ^{:key (str "gh-" gi "-" idx)}
                             [render-section header-key current record])))))
              ;; Detail
              (swap! elements conj
                     ^{:key (str "detail-" idx)}
                     [render-section :detail current record])
              (reset! prev-record record)))
          ;; Final group footers
          (when (seq grouping)
            (doseq [gi (reverse (range (count grouping)))]
              (let [footer-key (keyword (str "group-footer-" gi))]
                (when (get current footer-key)
                  (swap! elements conj
                         ^{:key (str "gf-final-" gi)}
                         [render-section footer-key current @prev-record])))))
          @elements)]
       [:div.report-no-data
        (if record-source
          "No records found"
          "No record source selected")])
     ;; Page Footer
     [render-section :page-footer current {}]
     ;; Report Footer (once)
     [render-section :report-footer current {}]]))
