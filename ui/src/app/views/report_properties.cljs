(ns app.views.report-properties
  "Property sheet panel for the report editor"
  (:require [clojure.string :as str]
            [app.state :as state]
            [app.state-report :as state-report]
            [app.views.report-utils :as ru]))

;; ============================================================
;; PROPERTY DEFINITIONS
;; ============================================================

(def report-property-defs
  {:format [{:key :caption :label "Caption" :type :text}
            {:key :auto-resize :label "Auto Resize" :type :yes-no}
            {:key :auto-center :label "Auto Center" :type :yes-no}
            {:key :report-width :label "Width" :type :number}
            {:key :grid-x :label "Grid X" :type :number}
            {:key :grid-y :label "Grid Y" :type :number}
            {:key :page-header-setting :label "Page Header" :type :select
             :options ["All Pages" "Not With Rpt Hdr" "Not With Rpt Ftr" "Not With Rpt Hdr/Ftr"]}
            {:key :page-footer-setting :label "Page Footer" :type :select
             :options ["All Pages" "Not With Rpt Hdr" "Not With Rpt Ftr" "Not With Rpt Hdr/Ftr"]}
            {:key :grp-keep-together :label "Grp Keep Together" :type :select
             :options ["Per Page" "Per Column"]}
            {:key :fit-to-page :label "Fit To Page" :type :yes-no}
            {:key :page-height :label "Page Height" :type :number :default 792}
            {:key :page-width :label "Page Width" :type :number :default 612}
            {:key :margin-top :label "Margin Top" :type :number :default 72}
            {:key :margin-bottom :label "Margin Bottom" :type :number :default 72}
            {:key :margin-left :label "Margin Left" :type :number :default 72}
            {:key :margin-right :label "Margin Right" :type :number :default 72}]
   :data [{:key :record-source :label "Record Source" :type :table-select}
          {:key :filter :label "Filter" :type :text}
          {:key :filter-on :label "Filter On" :type :yes-no}
          {:key :order-by :label "Order By" :type :text}
          {:key :order-by-on :label "Order By On" :type :yes-no}]
   :event [{:key :on-open :label "On Open" :type :event}
           {:key :on-close :label "On Close" :type :event}
           {:key :on-activate :label "On Activate" :type :event}
           {:key :on-deactivate :label "On Deactivate" :type :event}
           {:key :on-no-data :label "On No Data" :type :event}
           {:key :on-page :label "On Page" :type :event}
           {:key :on-error :label "On Error" :type :event}
           {:key :on-load :label "On Load" :type :event}
           {:key :on-unload :label "On Unload" :type :event}]
   :other [{:key :popup :label "Pop Up" :type :yes-no}
           {:key :modal :label "Modal" :type :yes-no}
           {:key :has-module :label "Has Module" :type :yes-no}
           {:key :tag :label "Tag" :type :text}
           {:key :date-grouping :label "Date Grouping" :type :select
            :options ["US Defaults" "Use System Settings"]}
           {:key :timer-interval :label "Timer Interval" :type :number}]})

(def section-property-defs
  {:format [{:key :height :label "Height" :type :number}
            {:key :visible :label "Visible" :type :yes-no :default true}
            {:key :can-grow :label "Can Grow" :type :yes-no}
            {:key :can-shrink :label "Can Shrink" :type :yes-no}
            {:key :back-color :label "Back Color" :type :text}
            {:key :keep-together :label "Keep Together" :type :yes-no}
            {:key :force-new-page :label "Force New Page" :type :select
             :options ["None" "Before Section" "After Section" "Before & After"]}
            {:key :new-row-or-col :label "New Row Or Col" :type :select
             :options ["None" "Before Section" "After Section" "Before & After"]}
            {:key :repeat-section :label "Repeat Section" :type :yes-no}
            {:key :alternate-back-color :label "Alternate Back Color" :type :text}]
   :event [{:key :on-format :label "On Format" :type :event}
           {:key :on-print :label "On Print" :type :event}
           {:key :on-retreat :label "On Retreat" :type :event}
           {:key :on-click :label "On Click" :type :event}
           {:key :on-dbl-click :label "On Dbl Click" :type :event}]
   :other [{:key :tag :label "Tag" :type :text}]})

(def group-level-property-defs
  {:data [{:key :field :label "Field" :type :field-select}
          {:key :sort-order :label "Sort Order" :type :select
           :options ["Ascending" "Descending"]}
          {:key :group-on :label "Group On" :type :select
           :options ["Each Value" "Prefix" "Year" "Quarter" "Month" "Week" "Day" "Hour" "Minute" "Interval"]}
          {:key :group-interval :label "Group Interval" :type :number}
          {:key :group-header :label "Group Header" :type :yes-no}
          {:key :group-footer :label "Group Footer" :type :yes-no}
          {:key :keep-together :label "Keep Together" :type :select
           :options ["No" "Whole Group" "With First Detail"]}]})

(def control-property-defs
  {:format [{:key :name :label "Name" :type :text}
            {:key :caption :label "Caption" :type :text}
            {:key :visible :label "Visible" :type :yes-no :default true}
            {:key :width :label "Width" :type :number}
            {:key :height :label "Height" :type :number}
            {:key :x :label "Left" :type :number}
            {:key :y :label "Top" :type :number}
            {:key :back-color :label "Back Color" :type :text}
            {:key :fore-color :label "Fore Color" :type :text}
            {:key :font-name :label "Font Name" :type :text}
            {:key :font-size :label "Font Size" :type :number}
            {:key :font-bold :label "Font Bold" :type :yes-no}
            {:key :font-italic :label "Font Italic" :type :yes-no}
            {:key :font-underline :label "Font Underline" :type :yes-no}
            {:key :font-weight :label "Font Weight" :type :select
             :options ["Normal" "Bold"]}
            {:key :text-align :label "Text Align" :type :select
             :options ["Left" "Center" "Right"]}
            {:key :border-style :label "Border Style" :type :select
             :options ["None" "Solid"]}
            {:key :border-color :label "Border Color" :type :text}
            {:key :can-grow :label "Can Grow" :type :yes-no}
            {:key :can-shrink :label "Can Shrink" :type :yes-no}
            {:key :format :label "Format" :type :text}
            {:key :conditional-formatting :label "Conditional Format" :type :text}]
   :data [{:key :control-source :label "Control Source" :type :field-select}
          {:key :input-mask :label "Input Mask" :type :text}
          {:key :default-value :label "Default Value" :type :text}
          {:key :running-sum :label "Running Sum" :type :select
           :options ["No" "Over Group" "Over All"]}
          {:key :hide-duplicates :label "Hide Duplicates" :type :yes-no}]
   :event [{:key :on-click :label "On Click" :type :event}
           {:key :on-dbl-click :label "On Dbl Click" :type :event}
           {:key :on-format :label "On Format" :type :event}
           {:key :on-print :label "On Print" :type :event}
           {:key :on-got-focus :label "On Got Focus" :type :event}
           {:key :on-lost-focus :label "On Lost Focus" :type :event}]
   :other [{:key :tab-index :label "Tab Index" :type :number}
           {:key :tag :label "Tag" :type :text}
           {:key :control-tip-text :label "ControlTip Text" :type :text}]})

;; ============================================================
;; INPUT COMPONENTS (mirror form_properties patterns)
;; ============================================================

(defn property-input
  "Render appropriate input for property type"
  [prop value on-change]
  (case (:type prop)
    :text
    [:input {:type "text"
             :value (or value "")
             :on-change #(on-change (.. % -target -value))}]

    :number
    [:input {:type "number"
             :value (or value (:default prop) 0)
             :on-change #(on-change (js/parseInt (.. % -target -value) 10))}]

    :yes-no
    (let [v (if (some? value) value (:default prop))]
      [:select {:value (if (or (= v 1) (true? v)) "1" "0")
                :on-change #(on-change (js/parseInt (.. % -target -value) 10))}
       [:option {:value "1"} "Yes"]
       [:option {:value "0"} "No"]])

    :select
    [:select {:value (or value (first (:options prop)))
              :on-change #(on-change (.. % -target -value))}
     (for [opt (:options prop)]
       ^{:key opt} [:option opt])]

    :table-select
    [:select {:value (or value "")
              :on-change #(on-change (.. % -target -value))}
     [:option {:value ""} "(none)"]
     (for [{:keys [id name]} (get-in @state/app-state [:objects :tables])]
       ^{:key id} [:option {:value name} name])
     (for [{:keys [id name]} (get-in @state/app-state [:objects :queries])]
       ^{:key (str "q-" id)} [:option {:value name} (str name " (query)")])]

    :field-select
    (let [record-source (get-in @state/app-state [:report-editor :current :record-source])
          fields (ru/get-record-source-fields record-source)]
      [:select {:value (or value "")
                :on-change #(on-change (.. % -target -value))}
       [:option {:value ""} "(none)"]
       (for [field fields]
         ^{:key (:name field)} [:option {:value (:name field)} (:name field)])])

    :event
    [:input {:type "text"
             :value (or value "")
             :placeholder "[Event Procedure]"
             :on-change #(on-change (.. % -target -value))}]

    ;; Default
    [:input {:type "text"
             :value (or value "")
             :on-change #(on-change (.. % -target -value))}]))

(defn property-row
  "Single property row with label and input"
  [prop value on-change]
  [:div.property-row
   [:span.property-label (:label prop)]
   [:span.property-input [property-input prop value on-change]]])

(defn properties-tab-content
  "Content for a properties tab"
  [props get-value on-change]
  [:div.properties-list
   (for [prop props]
     ^{:key (:key prop)}
     [property-row prop (get-value (:key prop)) #(on-change (:key prop) %)])])

;; ============================================================
;; PROPERTIES PANEL
;; ============================================================

(defn- resolve-selection
  "Determine the selection state and return a map of resolved values."
  [report-editor]
  (let [selected (:selected-control report-editor)
        current (:current report-editor)
        section-key (when selected (:section selected))
        idx (when selected (:idx selected))
        controls (when section-key (or (get-in current [section-key :controls]) []))
        selected-control (when (and section-key idx (< idx (count controls)))
                           (get controls idx))
        is-control? (some? selected-control)
        is-section? (and (some? section-key) (nil? idx))
        is-group? (and is-section?
                       (let [n (name section-key)]
                         (or (str/starts-with? n "group-header-")
                             (str/starts-with? n "group-footer-"))))
        group-idx (when is-group? (ru/parse-group-index section-key))
        section-data (when is-section? (get current section-key))]
    {:is-control? is-control? :is-section? is-section? :is-group? is-group?
     :section-key section-key :idx idx :group-idx group-idx
     :selected-control selected-control :section-data section-data
     :selection-type (cond is-control? (name (:type selected-control))
                           is-section? (ru/section-display-name section-key)
                           :else "Report")
     :property-defs (cond is-control? control-property-defs
                          is-section? section-property-defs
                          :else report-property-defs)
     :get-value (cond is-control? #(get selected-control %)
                      is-section? #(get section-data %)
                      :else #(get current %))
     :on-change (cond is-control? #(state-report/update-report-control! section-key idx %1 %2)
                      is-section? #(state-report/set-report-definition! (assoc-in current [section-key %1] %2))
                      :else #(state-report/set-report-definition! (assoc current %1 %2)))
     :grouping-data (when (and is-group? group-idx) (get-in current [:grouping group-idx]))
     :on-group-change (when (and is-group? group-idx)
                        (fn [k v] (state-report/set-report-definition!
                                    (assoc-in current [:grouping group-idx k] v))))}))

(defn- grouping-section
  "Render grouping properties if on a group section."
  [sel]
  (when (and (:is-group? sel) (:grouping-data sel) (:on-group-change sel))
    [:div
     [:div.property-category "Grouping"]
     [properties-tab-content (get group-level-property-defs :data [])
      #(get (:grouping-data sel) %) (:on-group-change sel)]]))

(defn properties-panel
  "Access-style Property Sheet for reports with tabs"
  []
  (let [report-editor (:report-editor @state/app-state)
        active-tab (or (:properties-tab report-editor) :format)
        sel (resolve-selection report-editor)]
    [:div.property-sheet
     [:div.property-sheet-header
      [:span.property-sheet-title "Property Sheet"]
      [:span.selection-type (str "Selection type: " (:selection-type sel))]]
     [:div.property-sheet-tabs
      (for [tab [:format :data :event :other :all]]
        ^{:key tab}
        [:button.tab-btn
         {:class (when (= tab active-tab) "active")
          :on-click #(swap! state/app-state assoc-in [:report-editor :properties-tab] tab)}
         (case tab :format "Format" :data "Data" :event "Event" :other "Other" :all "All")])]
     [:div.property-sheet-content
      (if (= active-tab :all)
        [:div
         (for [[category props] (:property-defs sel)]
           ^{:key category}
           [:div [:div.property-category (name category)]
            [properties-tab-content props (:get-value sel) (:on-change sel)]])
         [grouping-section sel]]
        [:div
         [properties-tab-content (get (:property-defs sel) active-tab [])
          (:get-value sel) (:on-change sel)]
         (when (= active-tab :data) [grouping-section sel])])]]))
