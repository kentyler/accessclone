(ns app.views.report-view
  "Report preview mode - renders report with live data, page-based layout"
  (:require [clojure.string :as str]
            [app.state :as state]
            [app.views.report-utils :as ru]
            [app.views.expressions :as expr]))

(defn render-report-control
  "Render a single control read-only, resolving field values from record.
   expr-context provides :group-records, :all-records, :page, :pages for expressions."
  [ctrl record expr-context]
  (let [field (ru/resolve-control-field ctrl)
        value (ru/resolve-field-value field record expr-context)
        text (or (when (and field (some? value) (not= value ""))
                   (str value))
                 (ru/display-text ctrl))
        ctrl-type (:type ctrl)
        base-style (merge (ru/control-style ctrl)
                          (when-let [fc (:fore-color ctrl)] {:color fc})
                          (when-let [bc (:back-color ctrl)] {:background-color bc})
                          (when-let [fn (:font-name ctrl)] {:font-family fn})
                          (when-let [fs (:font-size ctrl)] {:font-size fs})
                          (when (= 1 (:font-bold ctrl)) {:font-weight "bold"})
                          (when (= 1 (:font-italic ctrl)) {:font-style "italic"})
                          (when (= 1 (:font-underline ctrl)) {:text-decoration "underline"})
                          (when-let [ta (:text-align ctrl)]
                            {:text-align (str/lower-case ta)}))
        ;; Apply conditional formatting overrides
        cf-style (expr/apply-conditional-formatting ctrl record expr-context)
        style (if cf-style (merge base-style cf-style) base-style)]
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
   expr-context provides :group-records, :all-records, :page, :pages."
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

;; ============================================================
;; PAGE COMPUTATION
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

(defn- section-force-new-page
  "Get the force-new-page setting for a section."
  [report-def section-key]
  (get-in report-def [section-key :force-new-page] "None"))

(defn build-flat-elements
  "Build a flat list of element descriptors from records and grouping.
   Each element is {:type :section-key :record :height :expr-context :key-str}.
   Includes report-header and report-footer but NOT page-header/page-footer
   (those are rendered per-page separately)."
  [report-def records grouping]
  (let [all-ctx {:all-records records}
        elements (atom [])
        add! (fn [elem] (swap! elements conj elem))]
    ;; Report Header
    (when (section-visible? report-def :report-header)
      (add! {:type :report-header
             :section-key :report-header
             :record {}
             :height (get-section-height-val report-def :report-header)
             :expr-context all-ctx
             :key-str "rpt-hdr"}))
    ;; Data sections with group break detection
    (if (seq records)
      (let [prev-record (atom nil)
            group-records (atom (vec (repeat (max 1 (count grouping)) [])))]
        (doseq [[idx record] (map-indexed vector records)]
          (let [breaks (detect-group-breaks grouping @prev-record record)]
            ;; Group footers for previous group (on break, in reverse order)
            (when (and (pos? idx) (seq breaks))
              (doseq [gi (reverse breaks)]
                (let [footer-key (keyword (str "group-footer-" gi))
                      grp-recs (nth @group-records gi [])]
                  (when (and (get report-def footer-key)
                             (section-visible? report-def footer-key))
                    (add! {:type :group-footer
                           :section-key footer-key
                           :record @prev-record
                           :height (get-section-height-val report-def footer-key)
                           :expr-context {:all-records records :group-records grp-recs}
                           :key-str (str "gf-" gi "-" idx)}))
                  (swap! group-records assoc gi []))))
            ;; Group headers on break (or first record)
            (when (or (zero? idx) (seq breaks))
              (doseq [gi (if (zero? idx)
                           (range (count grouping))
                           breaks)]
                (let [header-key (keyword (str "group-header-" gi))]
                  (when (and (get report-def header-key)
                             (section-visible? report-def header-key))
                    (add! {:type :group-header
                           :section-key header-key
                           :record record
                           :height (get-section-height-val report-def header-key)
                           :expr-context all-ctx
                           :key-str (str "gh-" gi "-" idx)})))))
            ;; Accumulate record into all active group levels
            (dotimes [gi (count grouping)]
              (swap! group-records update gi conj record))
            ;; Detail
            (when (section-visible? report-def :detail)
              (add! {:type :detail
                     :section-key :detail
                     :record record
                     :height (get-section-height-val report-def :detail)
                     :expr-context all-ctx
                     :key-str (str "detail-" idx)}))
            (reset! prev-record record)))
        ;; Final group footers
        (when (seq grouping)
          (doseq [gi (reverse (range (count grouping)))]
            (let [footer-key (keyword (str "group-footer-" gi))
                  grp-recs (nth @group-records gi [])]
              (when (and (get report-def footer-key)
                         (section-visible? report-def footer-key))
                (add! {:type :group-footer
                       :section-key footer-key
                       :record @prev-record
                       :height (get-section-height-val report-def footer-key)
                       :expr-context {:all-records records :group-records grp-recs}
                       :key-str (str "gf-final-" gi)}))))))
      nil)
    ;; Report Footer
    (when (section-visible? report-def :report-footer)
      (add! {:type :report-footer
             :section-key :report-footer
             :record {}
             :height (get-section-height-val report-def :report-footer)
             :expr-context all-ctx
             :key-str "rpt-ftr"}))
    @elements))

(defn compute-pages
  "Split flat element list into pages based on page dimensions.
   Returns [[page1-elements] [page2-elements] ...].
   ph-height and pf-height are the page-header and page-footer heights."
  [elements report-def]
  (let [page-height (or (:page-height report-def) 792)
        margin-top (or (:margin-top report-def) 72)
        margin-bottom (or (:margin-bottom report-def) 72)
        ph-height (if (section-visible? report-def :page-header)
                    (get-section-height-val report-def :page-header)
                    0)
        pf-height (if (section-visible? report-def :page-footer)
                    (get-section-height-val report-def :page-footer)
                    0)
        usable (- page-height margin-top margin-bottom ph-height pf-height)
        usable (max usable 100)] ;; safety floor
    (loop [elems elements
           current-page []
           current-y 0
           pages []]
      (if (empty? elems)
        ;; Finalize: add last page if non-empty
        (if (seq current-page)
          (conj pages current-page)
          (if (empty? pages) [[]] pages))
        (let [elem (first elems)
              rest-elems (rest elems)
              elem-height (or (:height elem) 0)
              force-np (section-force-new-page report-def (:section-key elem))
              force-before? (or (= force-np "Before Section")
                                (= force-np "Before & After"))
              force-after? (or (= force-np "After Section")
                               (= force-np "Before & After"))
              ;; Force new page before?
              [current-page current-y pages]
              (if (and force-before? (seq current-page))
                [[] 0 (conj pages current-page)]
                [current-page current-y pages])
              ;; Does element fit on current page?
              [current-page current-y pages]
              (if (and (> (+ current-y elem-height) usable)
                       (pos? current-y))
                ;; Start new page
                [[] 0 (conj pages current-page)]
                [current-page current-y pages])
              ;; Add element to current page
              current-page (conj current-page elem)
              current-y (+ current-y elem-height)
              ;; Force new page after?
              [current-page current-y pages]
              (if force-after?
                [[] 0 (conj pages current-page)]
                [current-page current-y pages])]
          (recur rest-elems current-page current-y pages))))))

;; ============================================================
;; PAGE-BASED RENDERING
;; ============================================================

(defn- should-show-page-header?
  "Determine if page header should be shown on this page."
  [page-num has-report-header? page-header-setting page-elements]
  (let [setting (or page-header-setting "All Pages")]
    (cond
      (= setting "All Pages") true
      (= setting "Not With Rpt Hdr")
      (not (and (= page-num 1) has-report-header?))
      (= setting "Not With Rpt Ftr")
      true ;; only affects page footer display
      (= setting "Not With Rpt Hdr/Ftr")
      (not (and (= page-num 1) has-report-header?))
      :else true)))

(defn- should-show-page-footer?
  "Determine if page footer should be shown on this page."
  [page-num total-pages has-report-footer? page-footer-setting page-elements]
  (let [setting (or page-footer-setting "All Pages")]
    (cond
      (= setting "All Pages") true
      (= setting "Not With Rpt Hdr")
      true ;; only affects page header display
      (= setting "Not With Rpt Ftr")
      (not (and (= page-num total-pages) has-report-footer?))
      (= setting "Not With Rpt Hdr/Ftr")
      (not (and (= page-num total-pages) has-report-footer?))
      :else true)))

(defn render-page
  "Render a single page with page header, content elements, and page footer."
  [page-num total-pages page-elements report-def show-ph? show-pf?]
  (let [page-height (or (:page-height report-def) 792)
        page-width (or (:page-width report-def) 612)
        margin-top (or (:margin-top report-def) 72)
        margin-bottom (or (:margin-bottom report-def) 72)
        margin-left (or (:margin-left report-def) 72)
        margin-right (or (:margin-right report-def) 72)
        report-width (or (:report-width report-def) 600)
        content-width (- page-width margin-left margin-right)
        ;; Use the larger of report-width and content-width for the outer container
        outer-width (max report-width page-width)
        page-ctx {:page page-num :pages total-pages}]
    [:div.report-page
     {:style {:width outer-width
              :min-height page-height
              :padding-top margin-top
              :padding-bottom margin-bottom
              :padding-left margin-left
              :padding-right margin-right}}
     ;; Page Header
     (when show-ph?
       [render-section :page-header report-def {} (merge {:all-records []} page-ctx)])
     ;; Page content
     (for [elem page-elements]
       ^{:key (:key-str elem)}
       [render-section (:section-key elem) report-def (:record elem)
        (merge (:expr-context elem) page-ctx)])
     ;; Page Footer
     (when show-pf?
       [render-section :page-footer report-def {} (merge {:all-records []} page-ctx)])]))

(defn report-preview
  "Full report preview with live data, paginated"
  []
  (let [report-editor (:report-editor @state/app-state)
        current (:current report-editor)
        records (or (:records report-editor) [])
        record-source (:record-source current)
        grouping (or (:grouping current) [])
        report-width (or (:report-width current) 600)
        page-width (or (:page-width current) 612)
        outer-width (max report-width page-width)]
    [:div.report-preview
     {:style {:max-width (+ outer-width 40)}}
     (if (or (seq records) (not record-source))
       (if (seq records)
         ;; Build flat elements, paginate, render pages
         (let [flat-elements (build-flat-elements current records grouping)
               pages (compute-pages flat-elements current)
               total-pages (count pages)
               has-rpt-hdr? (section-visible? current :report-header)
               has-rpt-ftr? (section-visible? current :report-footer)
               ph-setting (:page-header-setting current)
               pf-setting (:page-footer-setting current)]
           [:div.report-pages
            (for [[idx page-elems] (map-indexed vector pages)]
              (let [page-num (inc idx)
                    show-ph? (should-show-page-header?
                               page-num has-rpt-hdr? ph-setting page-elems)
                    show-pf? (should-show-page-footer?
                               page-num total-pages has-rpt-ftr? pf-setting page-elems)]
                ^{:key (str "page-" idx)}
                [render-page page-num total-pages page-elems current show-ph? show-pf?]))])
         [:div.report-no-data
          (if record-source
            "No records found"
            "No record source selected")])
       [:div.report-no-data "No records found"])]))
