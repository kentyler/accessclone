(ns app.views.form-editor
  "Form editor/designer - replaces Access design view"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.views.table-viewer :as table-viewer]
            [app.views.query-viewer :as query-viewer]
            [app.views.module-viewer :as module-viewer]))

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
          ;; Check if it's a query (ends with " (query)" in display, but stored as just name)
          table (first (filter #(= (:name %) record-source) tables))
          query (first (filter #(= (:name %) record-source) queries))]
      (or (:fields table) (:fields query) []))))

(defn field-item
  "A single draggable field item"
  [{:keys [name type pk fk]}]
  [:div.field-item
   {:draggable true
    :on-drag-start (fn [e]
                     (.setData (.-dataTransfer e) "text/plain" name)
                     (.setData (.-dataTransfer e) "application/x-field"
                               (js/JSON.stringify (clj->js {:name name :type type}))))
    :title (str name " (" type ")" (when pk " - Primary Key") (when fk (str " - FK to " fk)))}
   [:span.field-icon
    (cond
      pk "🔑"
      fk "🔗"
      :else "")]
   [:span.field-name name]
   [:span.field-type type]])

(defn field-list
  "Panel showing fields from the record source"
  []
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        record-source (:record-source current)
        fields (get-record-source-fields record-source)]
    [:div.field-list-panel
     [:h4 "Fields"]
     (if (empty? fields)
       [:div.empty-fields
        (if record-source
          "No fields found"
          "Select a record source")]
       [:div.field-list
        (for [field fields]
          ^{:key (:name field)}
          [field-item field])])]))

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
             :options ["None" "Solid"]}]
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
    [:select {:value (if (or value (:default prop)) "Yes" "No")
              :on-change #(on-change (= (.. % -target -value) "Yes"))}
     [:option "Yes"]
     [:option "No"]]

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
          fields (get-record-source-fields record-source)]
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
        section (when selected (:section selected))
        idx (when selected (:idx selected))
        controls (when section (or (get-in current [section :controls]) []))
        selected-control (when (and section idx (< idx (count controls)))
                           (get controls idx))
        ;; Determine if we're showing form or control properties
        is-form? (nil? selected-control)
        selection-type (if is-form? "Form" (name (:type selected-control)))
        property-defs (if is-form? form-property-defs control-property-defs)
        get-value (if is-form?
                    #(get current %)
                    #(get selected-control %))
        on-change (if is-form?
                    #(state/set-form-definition! (assoc current %1 %2))
                    #(state/update-control! section idx %1 %2))]
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

(defn get-section-controls
  "Get controls for a specific section (header, detail, or footer)"
  [form-def section]
  (or (get-in form-def [section :controls]) []))

(defn get-section-height
  "Get height of a section, with defaults"
  [form-def section]
  (or (get-in form-def [section :height])
      (case section
        :header 40
        :detail 200
        :footer 40)))

(defn add-field-control!
  "Add a control for a dropped field.
   ctrl-key? bypasses snap-to-grid for pixel-perfect positioning.
   section specifies which section to add the control to."
  [field-name field-type x y ctrl-key? section]
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        section (or section :detail)
        controls (get-section-controls current section)
        snapped-x (snap-to-grid x ctrl-key?)
        snapped-y (snap-to-grid y ctrl-key?)
        new-control {:type :text-box
                     :field field-name
                     :label field-name
                     :x snapped-x
                     :y snapped-y
                     :width 150
                     :height 24}
        ;; Also add a label above/before the control
        label-control {:type :label
                       :text field-name
                       :x snapped-x
                       :y (snap-to-grid (- y 20) ctrl-key?)
                       :width 150
                       :height 18}
        new-controls (vec (conj controls label-control new-control))]
    (state/set-form-definition!
     (assoc-in current [section :controls] new-controls))))

(defn move-control!
  "Move an existing control to a new position.
   ctrl-key? bypasses snap-to-grid for pixel-perfect positioning.
   section specifies which section the control is in."
  [control-idx new-x new-y ctrl-key? section]
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        section (or section :detail)
        controls (get-section-controls current section)
        snapped-x (snap-to-grid new-x ctrl-key?)
        snapped-y (snap-to-grid new-y ctrl-key?)]
    (when (< control-idx (count controls))
      (state/set-form-definition!
       (assoc-in current [section :controls]
                 (update controls control-idx
                         (fn [ctrl]
                           (assoc ctrl :x snapped-x :y snapped-y))))))))

(defn section-controls
  "Render controls for a specific section"
  [section controls selected grid-size]
  (let [selected-section (:section selected)
        selected-idx (:idx selected)]
    [:div.controls-container
     (for [[idx ctrl] (map-indexed vector controls)]
       ^{:key idx}
       [:div.form-control
        {:class [(name (:type ctrl))
                 (when (and (= section selected-section) (= idx selected-idx)) "selected")]
         :draggable true
         :on-click (fn [e]
                     (.stopPropagation e)
                     (state/select-control! {:section section :idx idx}))
         :on-drag-start (fn [e]
                          (let [rect (.getBoundingClientRect (.-target e))
                                offset-x (- (.-clientX e) (.-left rect))
                                offset-y (- (.-clientY e) (.-top rect))]
                            (.setData (.-dataTransfer e) "application/x-control-idx" (str idx))
                            (.setData (.-dataTransfer e) "application/x-section" (name section))
                            (.setData (.-dataTransfer e) "application/x-offset"
                                      (js/JSON.stringify (clj->js {:x offset-x :y offset-y})))))
         :style {:left (:x ctrl)
                 :top (:y ctrl)
                 :width (:width ctrl)
                 :height (:height ctrl)}}
        (or (:text ctrl) (:label ctrl))
        [:button.control-delete
         {:on-click (fn [e]
                      (.stopPropagation e)
                      (state/delete-control! section idx))
          :title "Delete"}
         "\u00D7"]])]))

(def resize-state (r/atom nil))

(defn get-section-above
  "Get the section above the given divider"
  [section]
  (case section
    :detail :header
    :footer :detail
    nil))

(defn start-resize! [section e]
  (.preventDefault e)
  ;; The divider resizes the section ABOVE it
  (when-let [target-section (get-section-above section)]
    (reset! resize-state {:section target-section
                          :start-y (.-clientY e)})))

(defn handle-resize! [form-def e]
  (when-let [{:keys [section start-y]} @resize-state]
    (let [current-y (.-clientY e)
          delta (- current-y start-y)
          current-height (get-section-height form-def section)
          new-height (max 20 (+ current-height delta))]
      (reset! resize-state {:section section :start-y current-y})
      (state/set-form-definition!
       (assoc-in form-def [section :height] new-height)))))

(defn stop-resize! []
  (reset! resize-state nil))

(defn start-resize-direct! [section e]
  "Start resizing the section itself (for footer bottom border)"
  (.preventDefault e)
  (reset! resize-state {:section section
                        :start-y (.-clientY e)}))

(defn form-section
  "A single form section (header, detail, or footer)"
  [section form-def selected grid-size]
  (let [height (get-section-height form-def section)
        controls (get-section-controls form-def section)
        section-label (case section :header "Form Header" :detail "Detail" :footer "Form Footer")
        can-resize? (not= section :header)]
    [:div.form-section
     {:class (name section)}
     [:div.section-divider
      {:class (when can-resize? "resizable")
       :title (if can-resize?
                (str "Drag to resize " (name (get-section-above section)))
                section-label)
       :on-mouse-down (when can-resize? (fn [e] (start-resize! section e)))}
      [:span.section-label section-label]]
     [:div.section-body
      {:style {:height height
               :background-image (str "radial-gradient(circle, #ccc 1px, transparent 1px)")
               :background-size (str grid-size "px " grid-size "px")}
       :on-drag-over (fn [e] (.preventDefault e))
       :on-click (fn [e]
                   (when (or (.. e -target -classList (contains "section-body"))
                             (.. e -target -classList (contains "controls-container")))
                     (state/select-control! nil)))
       :on-drop (fn [e]
                  (.preventDefault e)
                  (let [rect (.getBoundingClientRect (.-currentTarget e))
                        raw-x (- (.-clientX e) (.-left rect))
                        raw-y (- (.-clientY e) (.-top rect))
                        ctrl-key? (.-ctrlKey e)
                        control-idx (.getData (.-dataTransfer e) "application/x-control-idx")
                        from-section (keyword (.getData (.-dataTransfer e) "application/x-section"))
                        offset-data (.getData (.-dataTransfer e) "application/x-offset")
                        offset (when (and offset-data (not= offset-data ""))
                                 (js->clj (js/JSON.parse offset-data) :keywordize-keys true))
                        x (if offset (- raw-x (:x offset)) raw-x)
                        y (if offset (- raw-y (:y offset)) raw-y)
                        field-data (.getData (.-dataTransfer e) "application/x-field")]
                    (cond
                      ;; Moving existing control (same or different section)
                      (and control-idx (not= control-idx ""))
                      (if (= from-section section)
                        ;; Same section - just move
                        (move-control! (js/parseInt control-idx 10) x y ctrl-key? section)
                        ;; Different section - remove from old, add to new
                        ;; (for now, just move within same section)
                        (move-control! (js/parseInt control-idx 10) x y ctrl-key? (or from-section section)))

                      ;; Adding new field
                      (and field-data (not= field-data ""))
                      (let [parsed (js->clj (js/JSON.parse field-data) :keywordize-keys true)]
                        (add-field-control! (:name parsed) (:type parsed) raw-x raw-y ctrl-key? section)))))}
      (if (empty? controls)
        [:div.section-empty
         (if (= section :detail)
           "Drag fields here"
           "")]
        [section-controls section controls selected grid-size])]
     ;; Footer has a bottom resize edge
     (when (= section :footer)
       [:div.section-bottom-resize
        {:on-mouse-down (fn [e]
                          (.preventDefault e)
                          (reset! resize-state {:section :footer :start-y (.-clientY e)}))}])]))

(defn form-canvas
  "The design surface where controls are placed"
  []
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        selected (:selected-control form-editor)
        grid-size (state/get-grid-size)
        resizing? @resize-state]
    [:div.form-canvas
     {:tab-index 0
      :class (when resizing? "resizing")
      :on-click (fn [_] (state/hide-context-menu!))
      :on-mouse-move (fn [e] (when resizing? (handle-resize! current e)))
      :on-mouse-up (fn [_] (stop-resize!))
      :on-mouse-leave (fn [_] (stop-resize!))
      :on-key-down (fn [e]
                     (state/hide-context-menu!)
                     (when (and selected
                                (or (= (.-key e) "Delete")
                                    (= (.-key e) "Backspace")))
                       (.preventDefault e)
                       (state/delete-control! (:section selected) (:idx selected))))}
     [:div.canvas-header
      [:div.form-selector
       {:class (when (nil? selected) "selected")
        :on-click (fn [e]
                    (.stopPropagation e)
                    (state/select-control! nil))
        :on-context-menu (fn [e]
                           (.preventDefault e)
                           (.stopPropagation e)
                           (state/show-context-menu! (.-clientX e) (.-clientY e)))
        :title "Select form to edit properties (right-click for menu)"}]
      [:span "Form Design View"]
      ;; Context menu
      (let [ctx-menu (:context-menu @state/app-state)]
        (when (:visible? ctx-menu)
          [:div.context-menu
           {:style {:left (:x ctx-menu) :top (:y ctx-menu)}}
           [:div.context-menu-item
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (state/hide-context-menu!)
                         (if (= (state/get-view-mode) :view)
                           (state/save-current-record!)
                           (state/save-form!)))}
            "Save"]
           [:div.context-menu-item
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (state/hide-context-menu!)
                         (state/close-current-tab!))}
            "Close"]
           [:div.context-menu-item
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (state/hide-context-menu!)
                         (state/close-all-tabs!))}
            "Close All"]
           [:div.context-menu-separator]
           [:div.context-menu-item
            {:class (when (= (state/get-view-mode) :view) "active")
             :on-click (fn [e]
                         (.stopPropagation e)
                         (state/hide-context-menu!)
                         (state/set-view-mode! :view))}
            "Form View"]
           [:div.context-menu-item
            {:class (when (= (state/get-view-mode) :design) "active")
             :on-click (fn [e]
                         (.stopPropagation e)
                         (state/hide-context-menu!)
                         (state/set-view-mode! :design))}
            "Design View"]]))]
     [:div.canvas-body.sections-container
      [form-section :header current selected grid-size]
      [form-section :detail current selected grid-size]
      [form-section :footer current selected grid-size]]
     ;; Record navigation bar
     [:div.record-nav-bar
      [:span.nav-label "Record:"]
      [:button.nav-btn {:title "First"} "|◀"]
      [:button.nav-btn {:title "Previous"} "◀"]
      [:span.record-counter "1 of 5"]
      [:button.nav-btn {:title "Next"} "▶"]
      [:button.nav-btn {:title "Last"} "▶|"]
      [:button.nav-btn {:title "New"} "▶*"]]]))

(defn form-view-control
  "Render a single control in view mode"
  [ctrl current-record on-change & [{:keys [auto-focus?]}]]
  (let [;; Check both :control-source (from Property Sheet) or :field (from drag-drop)
        raw-field (or (:control-source ctrl) (:field ctrl))
        ;; Normalize to lowercase to match database column names
        field (when raw-field (clojure.string/lower-case raw-field))
        ;; Try both keyword and string versions of field name
        value (when field
                (or (get current-record (keyword field))
                    (get current-record field)
                    ""))
        ;; Auto-focus new records
        is-new? (:__new__ current-record)
        ;; Normalize type to keyword (jsonToEdn round-trip converts keywords to strings)
        ctrl-type (keyword (clojure.string/replace (str (:type ctrl)) #"^:" ""))]
    [:div.view-control
     {:style {:left (:x ctrl)
              :top (:y ctrl)
              :width (:width ctrl)
              :height (:height ctrl)}}
     (case ctrl-type
       :label
       [:span.view-label (or (:text ctrl) (:label ctrl))]

       :text-box
       [:input.view-input
        {:type "text"
         :value value
         :auto-focus (and is-new? auto-focus?)
         :on-change #(when field (on-change field (.. % -target -value)))}]

       :button
       (let [button-text (or (:text ctrl) (:caption ctrl) "Button")
             on-click (cond
                        ;; Close button - close the current tab
                        (= button-text "Close")
                        #(let [active (:active-tab @state/app-state)]
                           (when active
                             (state/close-tab! (:type active) (:id active))))
                        ;; Default - show alert
                        :else
                        #(js/alert (str "Button clicked: " button-text)))]
         [:button.view-button {:on-click on-click} button-text])

       :check-box
       [:label.view-checkbox
        [:input {:type "checkbox"
                 :checked (boolean value)
                 :on-change #(when field (on-change field (.. % -target -checked)))}]
        (or (:text ctrl) (:caption ctrl))]

       :combo-box
       [:select.view-select
        {:value value
         :on-change #(when field (on-change field (.. % -target -value)))}
        [:option ""]]

       ;; Default - just show text
       [:span (or (:text ctrl) (:label ctrl) "")])]))

(defn form-view-section
  "Render a section in view mode"
  [section form-def current-record on-field-change]
  (let [height (get-section-height form-def section)
        controls (get-section-controls form-def section)]
    (when (seq controls)
      [:div.view-section
       {:class (name section)
        :style {:height height}}
       [:div.view-controls-container
        (for [[idx ctrl] (map-indexed vector controls)]
          ^{:key idx}
          [form-view-control ctrl current-record on-field-change])]])))

(defn form-view-detail-row
  "Render a single detail row for continuous forms"
  [idx record form-def selected? on-select on-field-change]
  (let [height (get-section-height form-def :detail)
        controls (get-section-controls form-def :detail)
        ;; Find index of first text-box for auto-focus (handle both keyword and string types)
        first-textbox-idx (first (keep-indexed
                                   (fn [i c] (when (#{:text-box "text-box"} (:type c)) i))
                                   controls))]
    [:div.view-section.detail.continuous-row
     {:class (when selected? "selected")
      :style {:height height}
      :on-click #(on-select idx)}
     [:div.view-controls-container
      (for [[ctrl-idx ctrl] (map-indexed vector controls)]
        ^{:key ctrl-idx}
        [form-view-control ctrl record on-field-change
         {:auto-focus? (and selected? (= ctrl-idx first-textbox-idx))}])]]))

(defn form-view
  "The form in view/data entry mode"
  []
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        current-record (or (:current-record form-editor) {})
        all-records (or (:records form-editor) [])
        record-pos (or (:record-position form-editor) {:current 0 :total 0})
        record-dirty? (:record-dirty? form-editor)
        record-source (:record-source current)
        default-view (or (:default-view current) "Single Form")
        continuous? (= default-view "Continuous Forms")
        on-field-change (fn [field value] (state/update-record-field! field value))
        on-select-record (fn [idx] (state/navigate-to-record! (inc idx)))
        ;; Check if any section has controls
        has-controls? (or (seq (get-section-controls current :header))
                          (seq (get-section-controls current :detail))
                          (seq (get-section-controls current :footer)))]
    [:div.form-canvas.view-mode
     [:div.canvas-header
      [:span "Form View"]
      (when continuous? [:span.view-type-badge " (Continuous)"])
      (when (not record-source)
        [:span.no-source-warning " (No record source selected)"])]
     [:div.canvas-body.view-mode-body
      (if (and record-source (> (:total record-pos) 0))
        (if continuous?
          ;; Continuous forms - render all records
          [:div.view-sections-container.continuous
           [form-view-section :header current current-record on-field-change]
           [:div.continuous-records-container
            (for [[idx record] (map-indexed vector all-records)]
              (let [selected? (= (inc idx) (:current record-pos))
                    ;; Use current-record for selected row to show live edits
                    display-record (if selected? current-record record)]
                ^{:key (or (:id record) idx)}
                [form-view-detail-row idx display-record current
                 selected? on-select-record on-field-change]))]
           [form-view-section :footer current current-record on-field-change]]
          ;; Single form - render one record
          [:div.view-sections-container
           [form-view-section :header current current-record on-field-change]
           [form-view-section :detail current current-record on-field-change]
           [form-view-section :footer current current-record on-field-change]])
        [:div.no-records
         (if record-source
           (if has-controls?
             "No records found"
             "Add controls in Design View")
           "Select a record source in Design View")])]
     ;; Record navigation bar
     [:div.record-nav-bar
      [:span.nav-label "Record:"]
      [:button.nav-btn {:title "First"
                        :disabled (or (< (:total record-pos) 1) (<= (:current record-pos) 1))
                        :on-click #(state/navigate-to-record! 1)} "|◀"]
      [:button.nav-btn {:title "Previous"
                        :disabled (or (< (:total record-pos) 1) (<= (:current record-pos) 1))
                        :on-click #(state/navigate-to-record! (dec (:current record-pos)))} "◀"]
      [:span.record-counter
       (if (> (:total record-pos) 0)
         (str (:current record-pos) " of " (:total record-pos))
         "0 of 0")]
      [:button.nav-btn {:title "Next"
                        :disabled (or (< (:total record-pos) 1) (>= (:current record-pos) (:total record-pos)))
                        :on-click #(state/navigate-to-record! (inc (:current record-pos)))} "▶"]
      [:button.nav-btn {:title "Last"
                        :disabled (or (< (:total record-pos) 1) (>= (:current record-pos) (:total record-pos)))
                        :on-click #(state/navigate-to-record! (:total record-pos))} "▶|"]
      [:button.nav-btn {:title "New Record"
                        :on-click #(state/new-record!)} "▶*"]
      [:button.nav-btn.delete-btn
       {:title "Delete Record"
        :disabled (< (:total record-pos) 1)
        :on-click #(when (js/confirm "Delete this record?")
                     (state/delete-current-record!))} "✕"]
      [:span.nav-separator]
      [:button.nav-btn.save-btn
       {:title "Save Record"
        :class (when record-dirty? "dirty")
        :disabled (not record-dirty?)
        :on-click #(state/save-current-record!)}
       "Save"]]]))

(defn ask-ai-to-fix-errors!
  "Send lint errors to AI for suggestions"
  [errors]
  (let [error-text (str "My form has these validation errors:\n"
                        (clojure.string/join "\n" (map #(str "- " (:location %) ": " (:message %)) errors))
                        "\n\nHow can I fix these issues?")]
    (state/set-chat-input! error-text)
    (state/send-chat-message!)))

(defn lint-errors-panel
  "Display lint errors with Ask AI button"
  []
  (let [errors (get-in @state/app-state [:form-editor :lint-errors])]
    (when (seq errors)
      [:div.lint-errors-panel
       [:div.lint-errors-header
        [:span.lint-errors-title "Form Validation Errors"]
        [:button.lint-errors-close
         {:on-click state/clear-lint-errors!}
         "\u00D7"]]
       [:ul.lint-errors-list
        (for [[idx error] (map-indexed vector errors)]
          ^{:key idx}
          [:li.lint-error
           [:span.error-location (:location error)]
           [:span.error-message (:message error)]])]
       [:div.lint-errors-actions
        [:button.secondary-btn
         {:on-click #(ask-ai-to-fix-errors! errors)}
         "Ask AI to Help Fix"]
        [:button.secondary-btn
         {:on-click state/clear-lint-errors!}
         "Dismiss"]]])))

(defn form-toolbar
  "Toolbar with form actions"
  []
  (let [dirty? (get-in @state/app-state [:form-editor :dirty?])
        view-mode (state/get-view-mode)]
    [:div.form-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn
       {:class (when (= view-mode :design) "active")
        :title "Design View"
        :on-click #(state/set-view-mode! :design)}
       "Design"]
      [:button.toolbar-btn
       {:class (when (= view-mode :view) "active")
        :title "Form View"
        :on-click #(state/set-view-mode! :view)}
       "View"]]
     [:div.toolbar-right
      [:button.secondary-btn
       {:disabled (not dirty?)
        :on-click #(let [original (get-in @state/app-state [:form-editor :original])]
                     (state/set-form-definition! original))}
       "Undo"]
      [:button.primary-btn
       {:disabled (not dirty?)
        :on-click state/save-form!}
       "Save"]]]))

(defn form-editor
  "Main form editor component"
  []
  (let [active-tab (:active-tab @state/app-state)
        editing-form-id (get-in @state/app-state [:form-editor :form-id])
        view-mode (state/get-view-mode)]
    (when (and active-tab (= (:type active-tab) :forms))
      ;; Load form data when tab changes to a different form
      (let [form (first (filter #(= (:id %) (:id active-tab))
                                (get-in @state/app-state [:objects :forms])))]
        (when (and form (not= (:id form) editing-form-id))
          (state/load-form-for-editing! form)))
      [:div.form-editor
       [form-toolbar]
       [lint-errors-panel]
       (if (= view-mode :view)
         ;; View mode - just the form, no panels
         [:div.editor-body.view-mode
          [:div.editor-center
           [form-view]]]
         ;; Design mode - form with properties and field panels
         [:div.editor-body
          [:div.editor-center
           [form-canvas]]
          [:div.editor-right
           [properties-panel]
           [field-list]]])])))

;; Table viewer moved to app.views.table-viewer

;; Query viewer moved to app.views.query-viewer

(defn object-editor
  "Routes to the appropriate editor based on active tab type"
  []
  (let [active-tab (:active-tab @state/app-state)]
    (case (:type active-tab)
      :forms [form-editor]
      :tables [table-viewer/table-viewer]
      :queries [query-viewer/query-viewer]
      :modules [module-viewer/module-viewer]
      [:div.no-editor
       [:p "Select an object to edit"]])))
