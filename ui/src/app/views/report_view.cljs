(ns app.views.report-view
  "Report preview mode - renders report with live data"
  (:require [clojure.string :as str]
            [app.state :as state]
            [app.views.report-utils :as ru]))

(defn render-report-control
  "Render a single control read-only, resolving field values from record.
   expr-context provides :group-records and :all-records for aggregate expressions."
  [ctrl record expr-context]
  (let [field (ru/resolve-control-field ctrl)
        value (ru/resolve-field-value field record expr-context)
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
       :image (if-let [src (:picture ctrl)]
                [:img.report-image {:src src :alt (or text "Image")}]
                [:span text])
       :tab-control [:span "(tab control)"]
       :subform [:span "(subform)"]
       ;; default: render text (list-box, option-group show bound value)
       [:span text])]))

(defn render-section
  "Render all controls in a section with proper height and background.
   expr-context provides :group-records and :all-records for aggregate expressions."
  ([section-key report-def record]
   (render-section section-key report-def record nil))
  ([section-key report-def record expr-context]
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
          [render-report-control ctrl record expr-context])]))))

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
        report-width (or (:report-width current) 600)
        all-ctx {:all-records records}]
    [:div.report-preview
     {:style {:max-width (+ report-width 40)}}
     ;; Report Header (once)
     [render-section :report-header current {} all-ctx]
     ;; Page Header
     [render-section :page-header current {} all-ctx]
     ;; Data section: iterate records with group break detection
     (if (seq records)
       [:div.report-data-sections
        (let [elements (atom [])
              prev-record (atom nil)
              ;; Track records in the current group (per group level)
              group-records (atom (vec (repeat (max 1 (count grouping)) [])))]
          (doseq [[idx record] (map-indexed vector records)]
            (let [breaks (detect-group-breaks grouping @prev-record record)]
              ;; Group footers for previous group (on break, in reverse order)
              (when (and (pos? idx) (seq breaks))
                (doseq [gi (reverse breaks)]
                  (let [footer-key (keyword (str "group-footer-" gi))
                        grp-recs (nth @group-records gi [])]
                    (when (get current footer-key)
                      (swap! elements conj
                             ^{:key (str "gf-" gi "-" idx)}
                             [render-section footer-key current @prev-record
                              {:all-records records :group-records grp-recs}]))
                    ;; Reset this group level's accumulated records
                    (swap! group-records assoc gi []))))
              ;; Group headers on break (or first record)
              (when (or (zero? idx) (seq breaks))
                (doseq [gi (if (zero? idx)
                             (range (count grouping))
                             breaks)]
                  (let [header-key (keyword (str "group-header-" gi))]
                    (when (get current header-key)
                      (swap! elements conj
                             ^{:key (str "gh-" gi "-" idx)}
                             [render-section header-key current record all-ctx])))))
              ;; Accumulate record into all active group levels
              (dotimes [gi (count grouping)]
                (swap! group-records update gi conj record))
              ;; Detail
              (swap! elements conj
                     ^{:key (str "detail-" idx)}
                     [render-section :detail current record all-ctx])
              (reset! prev-record record)))
          ;; Final group footers
          (when (seq grouping)
            (doseq [gi (reverse (range (count grouping)))]
              (let [footer-key (keyword (str "group-footer-" gi))
                    grp-recs (nth @group-records gi [])]
                (when (get current footer-key)
                  (swap! elements conj
                         ^{:key (str "gf-final-" gi)}
                         [render-section footer-key current @prev-record
                          {:all-records records :group-records grp-recs}])))))
          @elements)]
       [:div.report-no-data
        (if record-source
          "No records found"
          "No record source selected")])
     ;; Page Footer
     [render-section :page-footer current {} all-ctx]
     ;; Report Footer (once)
     [render-section :report-footer current {} all-ctx]]))
