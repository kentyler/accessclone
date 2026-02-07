(ns app.views.report-view
  "Report preview mode - renders report with live data, page-based layout"
  (:require [clojure.string :as str]
            [app.state :as state]
            [app.views.report-utils :as ru]
            [app.views.expressions :as expr]))

;; ============================================================
;; CONTROL RENDERING
;; ============================================================

(defn- control-font-style
  "Build font/color style map from a control's properties."
  [ctrl]
  (cond-> {}
    (:fore-color ctrl)              (assoc :color (:fore-color ctrl))
    (:back-color ctrl)              (assoc :background-color (:back-color ctrl))
    (:font-name ctrl)               (assoc :font-family (:font-name ctrl))
    (:font-size ctrl)               (assoc :font-size (:font-size ctrl))
    (= 1 (:font-bold ctrl))        (assoc :font-weight "bold")
    (= 1 (:font-italic ctrl))      (assoc :font-style "italic")
    (= 1 (:font-underline ctrl))   (assoc :text-decoration "underline")
    (:text-align ctrl)              (assoc :text-align (str/lower-case (:text-align ctrl)))))

(defn- control-body
  "Render the inner content of a report control by type."
  [ctrl-type text ctrl]
  (case ctrl-type
    :line [:hr.report-line]
    :rectangle [:div.report-rectangle]
    :image (if-let [src (:picture ctrl)]
             [:img.report-image {:src src :alt (or text "Image")}]
             [:span text])
    :tab-control [:span "(tab control)"]
    :subform [:span "(subform)"]
    [:span text]))

(defn render-report-control
  "Render a single control read-only, resolving field values from record."
  [ctrl record expr-context]
  (let [field (ru/resolve-control-field ctrl)
        value (ru/resolve-field-value field record expr-context)
        text (or (when (and field (some? value) (not= value ""))
                   (str value))
                 (ru/display-text ctrl))
        ctrl-type (:type ctrl)
        base-style (merge (ru/control-style ctrl) (control-font-style ctrl))
        cf-style (expr/apply-conditional-formatting ctrl record expr-context)
        style (if cf-style (merge base-style cf-style) base-style)]
    [:div.report-preview-control
     {:class (when ctrl-type (name ctrl-type))
      :style style}
     [control-body ctrl-type text ctrl]]))

(defn render-section
  "Render all controls in a section with proper height and background."
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

;; ============================================================
;; GROUP BREAK DETECTION
;; ============================================================

(defn detect-group-breaks
  "Given grouping definitions and two consecutive records, return which groups broke."
  [grouping prev-record current-record]
  (when (seq grouping)
    (loop [idx 0, broke? false, breaks []]
      (if (>= idx (count grouping))
        breaks
        (let [grp (nth grouping idx)
              field-key (keyword (str/lower-case (or (:field grp) "")))
              prev-val (when prev-record (get prev-record field-key))
              curr-val (get current-record field-key)
              changed? (or broke? (not= prev-val curr-val))]
          (recur (inc idx) changed?
                 (if changed? (conj breaks idx) breaks)))))))

;; ============================================================
;; FLAT ELEMENT BUILDING
;; ============================================================

(defn- get-section-height-val
  "Get the height of a section from the report definition."
  [report-def section-key]
  (or (get-in report-def [section-key :height])
      (ru/get-section-height report-def section-key)))

(defn- section-visible?
  "Check if a section is visible."
  [report-def section-key]
  (not= 0 (get-in report-def [section-key :visible] 1)))

(defn- make-element
  "Create a flat element descriptor."
  [type section-key record report-def expr-context key-str]
  {:type type
   :section-key section-key
   :record record
   :height (get-section-height-val report-def section-key)
   :expr-context expr-context
   :key-str key-str})

(defn- emit-group-footers!
  "Emit group footer elements for broken groups (in reverse order).
   Resets group-records for each broken group level."
  [add! report-def records breaks group-records prev-record idx]
  (doseq [gi (reverse breaks)]
    (let [footer-key (keyword (str "group-footer-" gi))
          grp-recs (nth @group-records gi [])]
      (when (and (get report-def footer-key)
                 (section-visible? report-def footer-key))
        (add! (make-element :group-footer footer-key prev-record report-def
                            {:all-records records :group-records grp-recs}
                            (str "gf-" gi "-" idx))))
      (swap! group-records assoc gi []))))

(defn- emit-group-headers!
  "Emit group header elements for broken groups (or all on first record)."
  [add! report-def records grouping breaks record idx]
  (let [all-ctx {:all-records records}
        indices (if (zero? idx) (range (count grouping)) breaks)]
    (doseq [gi indices]
      (let [header-key (keyword (str "group-header-" gi))]
        (when (and (get report-def header-key)
                   (section-visible? report-def header-key))
          (add! (make-element :group-header header-key record report-def
                              all-ctx (str "gh-" gi "-" idx))))))))

(defn- emit-final-group-footers!
  "Emit group footers at end of all records."
  [add! report-def records grouping group-records prev-record]
  (doseq [gi (reverse (range (count grouping)))]
    (let [footer-key (keyword (str "group-footer-" gi))
          grp-recs (nth @group-records gi [])]
      (when (and (get report-def footer-key)
                 (section-visible? report-def footer-key))
        (add! (make-element :group-footer footer-key prev-record report-def
                            {:all-records records :group-records grp-recs}
                            (str "gf-final-" gi)))))))

(defn build-flat-elements
  "Build a flat list of element descriptors from records and grouping.
   Includes report-header/footer but NOT page-header/footer."
  [report-def records grouping]
  (let [all-ctx {:all-records records}
        elements (atom [])
        add! #(swap! elements conj %)]
    ;; Report Header
    (when (section-visible? report-def :report-header)
      (add! (make-element :report-header :report-header {} report-def all-ctx "rpt-hdr")))
    ;; Data sections with group break detection
    (when (seq records)
      (let [prev-record (atom nil)
            group-records (atom (vec (repeat (max 1 (count grouping)) [])))]
        (doseq [[idx record] (map-indexed vector records)]
          (let [breaks (detect-group-breaks grouping @prev-record record)]
            (when (and (pos? idx) (seq breaks))
              (emit-group-footers! add! report-def records breaks group-records @prev-record idx))
            (when (or (zero? idx) (seq breaks))
              (emit-group-headers! add! report-def records grouping breaks record idx))
            (dotimes [gi (count grouping)]
              (swap! group-records update gi conj record))
            (when (section-visible? report-def :detail)
              (add! (make-element :detail :detail record report-def all-ctx (str "detail-" idx))))
            (reset! prev-record record)))
        (when (seq grouping)
          (emit-final-group-footers! add! report-def records grouping group-records @prev-record))))
    ;; Report Footer
    (when (section-visible? report-def :report-footer)
      (add! (make-element :report-footer :report-footer {} report-def all-ctx "rpt-ftr")))
    @elements))

;; ============================================================
;; PAGE COMPUTATION
;; ============================================================

(defn- section-force-new-page
  "Get the force-new-page setting for a section."
  [report-def section-key]
  (get-in report-def [section-key :force-new-page] "None"))

(defn- usable-page-height
  "Calculate usable content height per page."
  [report-def]
  (let [page-height (or (:page-height report-def) 792)
        margin-top (or (:margin-top report-def) 72)
        margin-bottom (or (:margin-bottom report-def) 72)
        ph-height (if (section-visible? report-def :page-header)
                    (get-section-height-val report-def :page-header) 0)
        pf-height (if (section-visible? report-def :page-footer)
                    (get-section-height-val report-def :page-footer) 0)]
    (max 100 (- page-height margin-top margin-bottom ph-height pf-height))))

(defn- finalize-pages
  "Add the last page to the pages vector, ensuring at least one page exists."
  [pages current-page]
  (if (seq current-page)
    (conj pages current-page)
    (if (empty? pages) [[]] pages)))

(defn compute-pages
  "Split flat element list into pages based on page dimensions.
   Returns [[page1-elements] [page2-elements] ...]."
  [elements report-def]
  (let [usable (usable-page-height report-def)]
    (loop [elems elements, current-page [], current-y 0, pages []]
      (if (empty? elems)
        (finalize-pages pages current-page)
        (let [elem (first elems)
              h (or (:height elem) 0)
              fnp (section-force-new-page report-def (:section-key elem))
              before? (contains? #{"Before Section" "Before & After"} fnp)
              after? (contains? #{"After Section" "Before & After"} fnp)
              ;; Force new page before?
              [cp cy ps] (if (and before? (seq current-page))
                           [[] 0 (conj pages current-page)]
                           [current-page current-y pages])
              ;; Overflow check
              [cp cy ps] (if (and (> (+ cy h) usable) (pos? cy))
                           [[] 0 (conj ps cp)]
                           [cp cy ps])
              ;; Add element
              cp (conj cp elem)
              cy (+ cy h)
              ;; Force new page after?
              [cp cy ps] (if after? [[] 0 (conj ps cp)] [cp cy ps])]
          (recur (rest elems) cp cy ps))))))

;; ============================================================
;; PAGE-BASED RENDERING
;; ============================================================

(defn- should-show-page-header?
  "Determine if page header should be shown on this page."
  [page-num has-report-header? setting]
  (case (or setting "All Pages")
    "All Pages" true
    "Not With Rpt Hdr" (not (and (= page-num 1) has-report-header?))
    "Not With Rpt Ftr" true
    "Not With Rpt Hdr/Ftr" (not (and (= page-num 1) has-report-header?))
    true))

(defn- should-show-page-footer?
  "Determine if page footer should be shown on this page."
  [page-num total-pages has-report-footer? setting]
  (case (or setting "All Pages")
    "All Pages" true
    "Not With Rpt Hdr" true
    "Not With Rpt Ftr" (not (and (= page-num total-pages) has-report-footer?))
    "Not With Rpt Hdr/Ftr" (not (and (= page-num total-pages) has-report-footer?))
    true))

(defn- page-dimensions
  "Extract page dimension style from report definition."
  [report-def]
  (let [page-width (or (:page-width report-def) 612)
        report-width (or (:report-width report-def) 600)]
    {:width (max report-width page-width)
     :min-height (or (:page-height report-def) 792)
     :padding-top (or (:margin-top report-def) 72)
     :padding-bottom (or (:margin-bottom report-def) 72)
     :padding-left (or (:margin-left report-def) 72)
     :padding-right (or (:margin-right report-def) 72)}))

(defn render-page
  "Render a single page with page header, content elements, and page footer."
  [page-num total-pages page-elements report-def show-ph? show-pf?]
  (let [page-ctx {:page page-num :pages total-pages}]
    [:div.report-page
     {:style (page-dimensions report-def)}
     (when show-ph?
       [render-section :page-header report-def {} (merge {:all-records []} page-ctx)])
     (for [elem page-elements]
       ^{:key (:key-str elem)}
       [render-section (:section-key elem) report-def (:record elem)
        (merge (:expr-context elem) page-ctx)])
     (when show-pf?
       [render-section :page-footer report-def {} (merge {:all-records []} page-ctx)])]))

(defn- render-paginated-report
  "Build flat elements, paginate, and render all pages."
  [current records grouping]
  (let [flat-elements (build-flat-elements current records grouping)
        pages (compute-pages flat-elements current)
        total-pages (count pages)
        has-rpt-hdr? (section-visible? current :report-header)
        has-rpt-ftr? (section-visible? current :report-footer)
        ph-setting (:page-header-setting current)
        pf-setting (:page-footer-setting current)]
    [:div.report-pages
     (for [[idx page-elems] (map-indexed vector pages)]
       (let [pn (inc idx)]
         ^{:key (str "page-" idx)}
         [render-page pn total-pages page-elems current
          (should-show-page-header? pn has-rpt-hdr? ph-setting)
          (should-show-page-footer? pn total-pages has-rpt-ftr? pf-setting)]))]))

(defn report-preview
  "Full report preview with live data, paginated."
  []
  (let [report-editor (:report-editor @state/app-state)
        current (:current report-editor)
        records (or (:records report-editor) [])
        record-source (:record-source current)
        grouping (or (:grouping current) [])
        dims (page-dimensions current)]
    [:div.report-preview
     {:style {:max-width (+ (:width dims) 40)}}
     (cond
       (seq records)
       [render-paginated-report current records grouping]
       (not record-source)
       [:div.report-no-data "No record source selected"]
       :else
       [:div.report-no-data "No records found"])]))
