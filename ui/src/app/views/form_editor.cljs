(ns app.views.form-editor
  "Form editor/designer - replaces Access design view"
  (:require [reagent.core :as r]
            [app.state :as state]))

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
        selected-idx (:selected-control form-editor)
        active-tab (or (:properties-tab form-editor) :format)
        current (:current form-editor)
        controls (or (:controls current) [])
        selected-control (when selected-idx (get controls selected-idx))
        ;; Determine if we're showing form or control properties
        is-form? (nil? selected-control)
        selection-type (if is-form? "Form" (name (:type selected-control)))
        property-defs (if is-form? form-property-defs control-property-defs)
        get-value (if is-form?
                    #(get current %)
                    #(get selected-control %))
        on-change (if is-form?
                    #(state/set-form-definition! (assoc current %1 %2))
                    #(state/update-control! selected-idx %1 %2))]
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

(defn add-field-control!
  "Add a control for a dropped field.
   ctrl-key? bypasses snap-to-grid for pixel-perfect positioning."
  [field-name field-type x y ctrl-key?]
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        controls (or (:controls current) [])
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
                       :height 18}]
    (state/set-form-definition!
     (assoc current :controls (conj controls label-control new-control)))))

(defn move-control!
  "Move an existing control to a new position.
   ctrl-key? bypasses snap-to-grid for pixel-perfect positioning."
  [control-idx new-x new-y ctrl-key?]
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        controls (or (:controls current) [])
        snapped-x (snap-to-grid new-x ctrl-key?)
        snapped-y (snap-to-grid new-y ctrl-key?)]
    (when (< control-idx (count controls))
      (state/set-form-definition!
       (assoc current :controls
              (update controls control-idx
                      (fn [ctrl]
                        (assoc ctrl :x snapped-x :y snapped-y))))))))

(defn form-canvas
  "The design surface where controls are placed"
  []
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        controls (or (:controls current) [])
        selected-idx (:selected-control form-editor)
        grid-size (state/get-grid-size)]
    [:div.form-canvas
     {:tab-index 0
      :on-click (fn [_] (state/hide-context-menu!))
      :on-key-down (fn [e]
                     (state/hide-context-menu!)
                     (when (and selected-idx
                                (or (= (.-key e) "Delete")
                                    (= (.-key e) "Backspace")))
                       (.preventDefault e)
                       (state/delete-control! selected-idx)))}
     [:div.canvas-header
      [:div.form-selector
       {:class (when (nil? selected-idx) "selected")
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
                         (state/save-form!))}
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
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (state/hide-context-menu!)
                         (js/alert "Form View - coming soon"))}
            "Form View"]
           [:div.context-menu-item.active
            {:on-click (fn [e]
                         (.stopPropagation e)
                         (state/hide-context-menu!))}
            "Design View"]]))]
     [:div.canvas-body
      {:style {:background-image (str "radial-gradient(circle, #ccc 1px, transparent 1px)")
               :background-size (str grid-size "px " grid-size "px")}
       :on-drag-over (fn [e] (.preventDefault e))
       :on-click (fn [e]
                   (when (or (.. e -target -classList (contains "canvas-body"))
                             (.. e -target -classList (contains "controls-container")))
                     (state/select-control! nil)))
       :on-drop (fn [e]
                  (.preventDefault e)
                  (let [rect (.getBoundingClientRect (.-currentTarget e))
                        raw-x (- (.-clientX e) (.-left rect))
                        raw-y (- (.-clientY e) (.-top rect))
                        ctrl-key? (.-ctrlKey e)
                        ;; Check if this is an existing control being moved
                        control-idx (.getData (.-dataTransfer e) "application/x-control-idx")
                        ;; Get drag offset if moving existing control
                        offset-data (.getData (.-dataTransfer e) "application/x-offset")
                        offset (when (and offset-data (not= offset-data ""))
                                 (js->clj (js/JSON.parse offset-data) :keywordize-keys true))
                        ;; Adjust position by drag offset
                        x (if offset (- raw-x (:x offset)) raw-x)
                        y (if offset (- raw-y (:y offset)) raw-y)
                        ;; Or a new field being added
                        field-data (.getData (.-dataTransfer e) "application/x-field")]
                    (cond
                      ;; Moving existing control
                      (and control-idx (not= control-idx ""))
                      (move-control! (js/parseInt control-idx 10) x y ctrl-key?)

                      ;; Adding new field
                      (and field-data (not= field-data ""))
                      (let [parsed (js->clj (js/JSON.parse field-data) :keywordize-keys true)]
                        (add-field-control! (:name parsed) (:type parsed) raw-x raw-y ctrl-key?)))))}
      (if (empty? controls)
        [:div.canvas-empty
         [:p "Drag fields here or use the AI assistant"]
         [:p.hint "Drag fields from the right panel, or describe what you want: \"Create a form to edit recipes with fields for name, description, and a subform for ingredients\""]]
        [:div.controls-container
         (for [[idx ctrl] (map-indexed vector controls)]
           ^{:key idx}
           [:div.form-control
            {:class [(name (:type ctrl)) (when (= idx selected-idx) "selected")]
             :draggable true
             :on-click (fn [e]
                         (.stopPropagation e)
                         (state/select-control! idx))
             :on-drag-start (fn [e]
                              ;; Store the offset from mouse to control's top-left
                              (let [rect (.getBoundingClientRect (.-target e))
                                    offset-x (- (.-clientX e) (.-left rect))
                                    offset-y (- (.-clientY e) (.-top rect))]
                                (.setData (.-dataTransfer e) "application/x-control-idx" (str idx))
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
                          (state/delete-control! idx))
              :title "Delete"}
             "\u00D7"]])])]
     ;; Record navigation bar (footer)
     [:div.record-nav-bar
      [:span.nav-label "Record:"]
      [:button.nav-btn {:title "First"} "|◀"]
      [:button.nav-btn {:title "Previous"} "◀"]
      [:span.record-counter "1 of 5"]
      [:button.nav-btn {:title "Next"} "▶"]
      [:button.nav-btn {:title "Last"} "▶|"]
      [:button.nav-btn {:title "New"} "▶*"]
      [:span.nav-separator]
      [:span.filter-indicator "No Filter"]
      [:input.search-box {:type "text" :placeholder "Search"}]]]))

(defn form-toolbar
  "Toolbar with form actions"
  []
  (let [dirty? (get-in @state/app-state [:form-editor :dirty?])]
    [:div.form-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn.active {:title "Design View"} "Design"]
      [:button.toolbar-btn {:title "Form View"} "View"]]
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
        editing-form-id (get-in @state/app-state [:form-editor :form-id])]
    (when (and active-tab (= (:type active-tab) :forms))
      ;; Load form data when tab changes to a different form
      (let [form (first (filter #(= (:id %) (:id active-tab))
                                (get-in @state/app-state [:objects :forms])))]
        (when (and form (not= (:id form) editing-form-id))
          (state/load-form-for-editing! form)))
      [:div.form-editor
       [form-toolbar]
       [:div.editor-body
        [:div.editor-center
         [form-canvas]]
        [:div.editor-right
         [properties-panel]
         [field-list]]]])))

(defn table-viewer
  "Simple table viewer for tables"
  []
  (let [active-tab (:active-tab @state/app-state)
        table-name (when active-tab
                     (:name (first (filter #(= (:id %) (:id active-tab))
                                           (get-in @state/app-state [:objects :tables])))))]
    [:div.table-viewer
     [:h3 (str "Table: " table-name)]
     [:p "Table viewer coming soon..."]]))

(defn query-viewer
  "Simple query viewer"
  []
  (let [active-tab (:active-tab @state/app-state)
        query-name (when active-tab
                     (:name (first (filter #(= (:id %) (:id active-tab))
                                           (get-in @state/app-state [:objects :queries])))))]
    [:div.query-viewer
     [:h3 (str "Query: " query-name)]
     [:p "Query viewer coming soon..."]]))

(defn object-editor
  "Routes to the appropriate editor based on active tab type"
  []
  (let [active-tab (:active-tab @state/app-state)]
    (case (:type active-tab)
      :forms [form-editor]
      :tables [table-viewer]
      :queries [query-viewer]
      [:div.no-editor
       [:p "Select an object to edit"]])))
