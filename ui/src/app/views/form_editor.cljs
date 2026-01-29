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

(defn form-properties
  "Properties panel for the form itself"
  []
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)]
    [:div.properties-content
     [:div.property-group
      [:label "Record Source"]
      [:select
       {:value (or (:record-source current) "")
        :on-change #(state/set-form-definition!
                     (assoc current :record-source (.. % -target -value)))}
       [:option {:value ""} "(none)"]
       (for [{:keys [id name]} (get-in @state/app-state [:objects :tables])]
         ^{:key id}
         [:option {:value name} name])
       (for [{:keys [id name]} (get-in @state/app-state [:objects :queries])]
         ^{:key (str "q-" id)}
         [:option {:value name} (str name " (query)")])]]
     [:div.property-group
      [:label "Form Type"]
      [:select
       {:value (or (:default-view current) "single")
        :on-change #(state/set-form-definition!
                     (assoc current :default-view (.. % -target -value)))}
       [:option {:value "single"} "Single Record"]
       [:option {:value "continuous"} "List (Paginated)"]]]]))

(defn control-properties
  "Properties panel for a selected control"
  [idx control]
  [:div.properties-content
   [:div.property-group
    [:label "Type"]
    [:span.property-value (name (:type control))]]
   [:div.property-group
    [:label "Text/Label"]
    [:input
     {:type "text"
      :value (or (:text control) (:label control) "")
      :on-change #(state/update-control! idx
                   (if (= (:type control) :label) :text :label)
                   (.. % -target -value))}]]
   (when (:field control)
     [:div.property-group
      [:label "Field"]
      [:span.property-value (:field control)]])
   [:div.property-group
    [:label "X"]
    [:input
     {:type "number"
      :value (or (:x control) 0)
      :on-change #(state/update-control! idx :x (js/parseInt (.. % -target -value) 10))}]]
   [:div.property-group
    [:label "Y"]
    [:input
     {:type "number"
      :value (or (:y control) 0)
      :on-change #(state/update-control! idx :y (js/parseInt (.. % -target -value) 10))}]]
   [:div.property-group
    [:label "Width"]
    [:input
     {:type "number"
      :value (or (:width control) 100)
      :on-change #(state/update-control! idx :width (js/parseInt (.. % -target -value) 10))}]]
   [:div.property-group
    [:label "Height"]
    [:input
     {:type "number"
      :value (or (:height control) 24)
      :on-change #(state/update-control! idx :height (js/parseInt (.. % -target -value) 10))}]]])

(defn properties-panel
  "Properties panel that shows form or control properties based on selection"
  []
  (let [form-editor (:form-editor @state/app-state)
        selected-idx (:selected-control form-editor)
        current (:current form-editor)
        controls (or (:controls current) [])
        selected-control (when selected-idx (get controls selected-idx))]
    [:div.properties-panel
     [:h4 (if selected-control
            (str (name (:type selected-control)) " Properties")
            "Form Properties")]
     (if selected-control
       [control-properties selected-idx selected-control]
       [form-properties])]))

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
      :on-key-down (fn [e]
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
        :title "Select form to edit properties"}]
      [:span "Form Design View"]]
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
                        x (- (.-clientX e) (.-left rect))
                        y (- (.-clientY e) (.-top rect))
                        ctrl-key? (.-ctrlKey e)
                        ;; Check if this is an existing control being moved
                        control-idx (.getData (.-dataTransfer e) "application/x-control-idx")
                        ;; Or a new field being added
                        field-data (.getData (.-dataTransfer e) "application/x-field")]
                    (cond
                      ;; Moving existing control
                      (and control-idx (not= control-idx ""))
                      (move-control! (js/parseInt control-idx 10) x y ctrl-key?)

                      ;; Adding new field
                      (and field-data (not= field-data ""))
                      (let [parsed (js->clj (js/JSON.parse field-data) :keywordize-keys true)]
                        (add-field-control! (:name parsed) (:type parsed) x y ctrl-key?)))))}
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
                              (.setData (.-dataTransfer e) "application/x-control-idx" (str idx)))
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
             "\u00D7"]])])]]))

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
  (let [active-tab (:active-tab @state/app-state)]
    (when (and active-tab (= (:type active-tab) :forms))
      ;; Load form data when tab changes
      (let [form (first (filter #(= (:id %) (:id active-tab))
                                (get-in @state/app-state [:objects :forms])))]
        (when (and form
                   (not= (:definition form)
                         (get-in @state/app-state [:form-editor :original])))
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
