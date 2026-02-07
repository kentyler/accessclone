(ns app.views.form-properties
  "Property sheet panel for the form editor"
  (:require [app.state :as state]
            [app.views.form-utils :as form-utils]))

;; Property definitions for each control type
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
            {:key :font-weight :label "Font Weight" :type :select
             :options ["Normal" "Bold"]}
            {:key :text-align :label "Text Align" :type :select
             :options ["Left" "Center" "Right"]}
            {:key :border-style :label "Border Style" :type :select
             :options ["None" "Solid"]}
            {:key :conditional-formatting :label "Conditional Format" :type :text}]
   :data [{:key :control-source :label "Control Source" :type :field-select}
          {:key :input-mask :label "Input Mask" :type :text}
          {:key :default-value :label "Default Value" :type :text}
          {:key :validation-rule :label "Validation Rule" :type :text}
          {:key :validation-text :label "Validation Text" :type :text}
          {:key :enabled :label "Enabled" :type :yes-no :default true}
          {:key :locked :label "Locked" :type :yes-no :default false}]
   :event [{:key :on-click :label "On Click" :type :event}
           {:key :on-dbl-click :label "On Dbl Click" :type :event}
           {:key :on-change :label "On Change" :type :event}
           {:key :on-got-focus :label "On Got Focus" :type :event}
           {:key :on-lost-focus :label "On Lost Focus" :type :event}
           {:key :on-enter :label "On Enter" :type :event}
           {:key :on-exit :label "On Exit" :type :event}]
   :other [{:key :tab-index :label "Tab Index" :type :number}
           {:key :tab-stop :label "Tab Stop" :type :yes-no :default true}
           {:key :tag :label "Tag" :type :text}
           {:key :control-tip-text :label "ControlTip Text" :type :text}]})

(def section-property-defs
  {:format [{:key :height :label "Height" :type :number}
            {:key :back-color :label "Back Color" :type :text}
            {:key :visible :label "Visible" :type :yes-no :default true}]
   :event  [{:key :on-click :label "On Click" :type :event}]
   :other  [{:key :tag :label "Tag" :type :text}]})

(def section-display-names
  {:header "FormHeader"
   :detail "Detail"
   :footer "FormFooter"})

(def form-property-defs
  {:format [{:key :caption :label "Caption" :type :text}
            {:key :default-view :label "Default View" :type :select
             :options ["Single Form" "Continuous Forms" "Datasheet"]}
            {:key :scroll-bars :label "Scroll Bars" :type :select
             :options ["Neither" "Horizontal" "Vertical" "Both"]}
            {:key :record-selectors :label "Record Selectors" :type :yes-no}
            {:key :navigation-buttons :label "Navigation Buttons" :type :yes-no}
            {:key :dividing-lines :label "Dividing Lines" :type :yes-no}
            {:key :width :label "Width" :type :number}]
   :data [{:key :record-source :label "Record Source" :type :table-select}
          {:key :filter :label "Filter" :type :text}
          {:key :order-by :label "Order By" :type :text}
          {:key :allow-edits :label "Allow Edits" :type :yes-no :default true}
          {:key :allow-deletions :label "Allow Deletions" :type :yes-no :default true}
          {:key :allow-additions :label "Allow Additions" :type :yes-no :default true}
          {:key :data-entry :label "Data Entry" :type :yes-no :default false}]
   :event [{:key :on-load :label "On Load" :type :event}
           {:key :on-unload :label "On Unload" :type :event}
           {:key :on-open :label "On Open" :type :event}
           {:key :on-close :label "On Close" :type :event}
           {:key :on-current :label "On Current" :type :event}
           {:key :before-insert :label "Before Insert" :type :event}
           {:key :after-insert :label "After Insert" :type :event}
           {:key :before-update :label "Before Update" :type :event}
           {:key :after-update :label "After Update" :type :event}]
   :other [{:key :popup :label "Pop Up" :type :yes-no :default false}
           {:key :modal :label "Modal" :type :yes-no :default false}
           {:key :tag :label "Tag" :type :text}]})

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
    (let [record-source (get-in @state/app-state [:form-editor :current :record-source])
          fields (form-utils/get-record-source-fields record-source)]
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

(defn properties-panel
  "Access-style Property Sheet with tabs"
  []
  (let [form-editor (:form-editor @state/app-state)
        selected (:selected-control form-editor)
        active-tab (or (:properties-tab form-editor) :format)
        current (:current form-editor)
        ;; Get controls from the selected section
        section-key (when selected (:section selected))
        idx (when selected (:idx selected))
        controls (when section-key (or (get-in current [section-key :controls]) []))
        selected-control (when (and section-key idx (< idx (count controls)))
                           (get controls idx))
        ;; Determine three selection states: form, section, or control
        is-control? (some? selected-control)
        is-section? (and (some? section-key) (nil? idx))
        is-form? (and (not is-control?) (not is-section?))
        selection-type (cond
                         is-control? (name (:type selected-control))
                         is-section? (get section-display-names section-key (name section-key))
                         :else "Form")
        property-defs (cond
                        is-control? control-property-defs
                        is-section? section-property-defs
                        :else form-property-defs)
        section-data (when is-section? (get current section-key))
        get-value (cond
                    is-control? #(get selected-control %)
                    is-section? #(get section-data %)
                    :else #(get current %))
        on-change (cond
                    is-control? #(state/update-control! section-key idx %1 %2)
                    is-section? #(state/set-form-definition!
                                  (assoc-in current [section-key %1] %2))
                    :else #(state/set-form-definition! (assoc current %1 %2)))]
    [:div.property-sheet
     [:div.property-sheet-header
      [:span.property-sheet-title "Property Sheet"]
      [:span.selection-type (str "Selection type: " selection-type)]]
     [:div.property-sheet-tabs
      (for [tab [:format :data :event :other :all]]
        ^{:key tab}
        [:button.tab-btn
         {:class (when (= tab active-tab) "active")
          :on-click #(swap! state/app-state assoc-in [:form-editor :properties-tab] tab)}
         (case tab
           :format "Format"
           :data "Data"
           :event "Event"
           :other "Other"
           :all "All")])]
     [:div.property-sheet-content
      (if (= active-tab :all)
        ;; Show all properties
        (for [[category props] property-defs]
          ^{:key category}
          [:div
           [:div.property-category (name category)]
           [properties-tab-content props get-value on-change]])
        ;; Show single category
        [properties-tab-content (get property-defs active-tab []) get-value on-change])]]))
