(ns app.views.form-design
  "Form design surface - drag-drop editor for form controls"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.state-form :as state-form]
            [app.flows.core :as f]
            [app.flows.form :as form-flow]
            [app.flows.navigation :as nav]
            [app.views.form-utils :as form-utils]
            [app.views.control-palette :as palette]))

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
        fields (form-utils/get-record-source-fields record-source)]
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

(defn add-field-control!
  "Add a control for a dropped field.
   ctrl-key? bypasses snap-to-grid for pixel-perfect positioning.
   section specifies which section to add the control to."
  [field-name field-type x y ctrl-key? section]
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        section (or section :detail)
        controls (form-utils/get-section-controls current section)
        snapped-x (form-utils/snap-to-grid x ctrl-key?)
        snapped-y (form-utils/snap-to-grid y ctrl-key?)
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
                       :y (form-utils/snap-to-grid (- y 20) ctrl-key?)
                       :width 150
                       :height 18}
        new-controls (vec (conj controls label-control new-control))]
    (t/dispatch! :set-form-definition
     (assoc-in current [section :controls] new-controls))))

(defn- add-palette-control!
  "Place a new control from the palette tool at click coordinates."
  [control-type section x y ctrl-key?]
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        section (or section :detail)
        controls (form-utils/get-section-controls current section)
        snapped-x (form-utils/snap-to-grid x ctrl-key?)
        snapped-y (form-utils/snap-to-grid y ctrl-key?)
        new-ctrl (palette/control-defaults control-type snapped-x snapped-y)
        new-controls (conj (vec controls) new-ctrl)
        new-idx (dec (count new-controls))]
    (t/dispatch! :set-form-definition
     (assoc-in current [section :controls] new-controls))
    (t/dispatch! :select-control {:section section :idx new-idx})
    (reset! palette/palette-tool nil)))

(defn move-control!
  "Move an existing control to a new position.
   ctrl-key? bypasses snap-to-grid for pixel-perfect positioning.
   section specifies which section the control is in."
  [control-idx new-x new-y ctrl-key? section]
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        section (or section :detail)
        controls (form-utils/get-section-controls current section)
        snapped-x (form-utils/snap-to-grid new-x ctrl-key?)
        snapped-y (form-utils/snap-to-grid new-y ctrl-key?)]
    (when (< control-idx (count controls))
      (t/dispatch! :set-form-definition
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
                     (t/dispatch! :select-control {:section section :idx idx}))
         :on-drag-start (fn [e]
                          (let [rect (.getBoundingClientRect (.-target e))
                                offset-x (- (.-clientX e) (.-left rect))
                                offset-y (- (.-clientY e) (.-top rect))]
                            (.setData (.-dataTransfer e) "application/x-control-idx" (str idx))
                            (.setData (.-dataTransfer e) "application/x-section" (name section))
                            (.setData (.-dataTransfer e) "application/x-offset"
                                      (js/JSON.stringify (clj->js {:x offset-x :y offset-y})))))
         :style (form-utils/control-style ctrl)}
        (form-utils/display-text ctrl)
        [:button.control-delete
         {:on-click (fn [e]
                      (.stopPropagation e)
                      (t/dispatch! :delete-control section idx))
          :title "Delete"}
         "\u00D7"]])]))

(def resize-state (r/atom nil))

(defn start-resize! [section e]
  (.preventDefault e)
  ;; The divider resizes the section ABOVE it
  (when-let [target-section (form-utils/get-section-above section)]
    (reset! resize-state {:section target-section
                          :start-y (.-clientY e)})))

(defn handle-resize! [form-def e]
  (when-let [{:keys [section start-y]} @resize-state]
    (let [current-y (.-clientY e)
          delta (- current-y start-y)
          current-height (form-utils/get-section-height form-def section)
          new-height (max 20 (+ current-height delta))]
      (reset! resize-state {:section section :start-y current-y})
      (t/dispatch! :set-form-definition
       (assoc-in form-def [section :height] new-height)))))

(defn stop-resize! []
  (reset! resize-state nil))

(defn start-resize-direct! [section e]
  "Start resizing the section itself (for footer bottom border)"
  (.preventDefault e)
  (reset! resize-state {:section section
                        :start-y (.-clientY e)}))

(defn- parse-drop-data
  "Extract drop coordinates and data from a drag event."
  [e]
  (let [rect (.getBoundingClientRect (.-currentTarget e))
        raw-x (- (.-clientX e) (.-left rect))
        raw-y (- (.-clientY e) (.-top rect))
        offset-data (.getData (.-dataTransfer e) "application/x-offset")
        offset (when (and offset-data (not= offset-data ""))
                 (js->clj (js/JSON.parse offset-data) :keywordize-keys true))]
    {:x (if offset (- raw-x (:x offset)) raw-x)
     :y (if offset (- raw-y (:y offset)) raw-y)
     :raw-x raw-x :raw-y raw-y
     :ctrl-key? (.-ctrlKey e)
     :control-idx (.getData (.-dataTransfer e) "application/x-control-idx")
     :from-section (keyword (.getData (.-dataTransfer e) "application/x-section"))
     :field-data (.getData (.-dataTransfer e) "application/x-field")
     :palette-type (.getData (.-dataTransfer e) "application/x-palette-type")}))

(defn- handle-section-drop!
  "Handle a drop event on a form section."
  [section e]
  (.preventDefault e)
  (let [{:keys [x y raw-x raw-y ctrl-key? control-idx from-section field-data palette-type]}
        (parse-drop-data e)]
    (cond
      (and control-idx (not= control-idx ""))
      (move-control! (js/parseInt control-idx 10) x y ctrl-key? (or from-section section))

      (and palette-type (not= palette-type ""))
      (add-palette-control! (keyword palette-type) section raw-x raw-y ctrl-key?)

      (and field-data (not= field-data ""))
      (let [parsed (js->clj (js/JSON.parse field-data) :keywordize-keys true)]
        (add-field-control! (:name parsed) (:type parsed) raw-x raw-y ctrl-key? section)))))

(defn- picture-background-size
  "Map picture-size-mode to CSS background-size value."
  [size-mode]
  (case size-mode
    "stretch" "100% 100%"
    "zoom" "contain"
    "auto"))

(defn- section-body-style
  "Build the style map for a section body."
  [height grid-size section-data]
  (let [back-color (:back-color section-data)
        picture (:picture section-data)
        has-picture? (and picture (not= picture ""))]
    (cond-> {:height height}
      (not has-picture?)
      (assoc :background-image (str "radial-gradient(circle, #ccc 1px, transparent 1px)")
             :background-size (str grid-size "px " grid-size "px"))
      has-picture?
      (assoc :background-image (str "url(" picture ")")
             :background-size (picture-background-size (:picture-size-mode section-data))
             :background-repeat "no-repeat"
             :background-position "center")
      (and back-color (not= back-color ""))
      (assoc :background-color back-color))))

(defn form-section
  "A single form section (header, detail, or footer)"
  [section form-def selected grid-size]
  (let [height (form-utils/get-section-height form-def section)
        controls (form-utils/get-section-controls form-def section)
        section-label (case section :header "Form Header" :detail "Detail" :footer "Form Footer")
        can-resize? (not= section :header)
        section-selected? (and selected (:section selected) (nil? (:idx selected))
                               (= (:section selected) section))]
    [:div.form-section {:class (name section)}
     [:div.section-divider
      {:class (when can-resize? "resizable")
       :title (if can-resize? (str "Drag to resize " (name (form-utils/get-section-above section))) section-label)
       :on-click (fn [e] (.stopPropagation e)
                   (t/dispatch! :select-control {:section section}))
       :on-mouse-down (when can-resize? #(start-resize! section %))}
      [:span.section-label section-label]]
     [:div.section-body
      {:class (when section-selected? "selected")
       :style (section-body-style height grid-size (get form-def section))
       :on-drag-over #(.preventDefault %)
       :on-click (fn [e]
                   (when (or (.. e -target -classList (contains "section-body"))
                             (.. e -target -classList (contains "controls-container")))
                     (if-let [tool @palette/palette-tool]
                       (let [rect (.getBoundingClientRect (.-currentTarget e))
                             x (- (.-clientX e) (.-left rect))
                             y (- (.-clientY e) (.-top rect))]
                         (add-palette-control! tool section x y (.-ctrlKey e)))
                       (t/dispatch! :select-control {:section section}))))
       :on-drop #(handle-section-drop! section %)}
      (if (empty? controls)
        [:div.section-empty (if (= section :detail) "Drag fields here" "")]
        [section-controls section controls selected grid-size])]
     (when (= section :footer)
       [:div.section-bottom-resize
        {:on-mouse-down #(do (.preventDefault %)
                             (reset! resize-state {:section :footer :start-y (.-clientY %)}))}])]))

(defn- ctx-menu-item
  "A context menu item that stops propagation and hides menu."
  [label action & [class]]
  [:div.context-menu-item
   {:class class
    :on-click (fn [e] (.stopPropagation e) (t/dispatch! :hide-context-menu) (action))}
   label])

(defn- form-context-menu
  "Context menu for the form canvas header."
  []
  (let [ctx-menu (:context-menu @state/app-state)]
    (when (:visible? ctx-menu)
      [:div.context-menu
       {:style {:left (:x ctx-menu) :top (:y ctx-menu)}}
       [ctx-menu-item "Save" #(if (= (state-form/get-view-mode) :view)
                                (f/run-fire-and-forget! form-flow/save-current-record-flow)
                                (f/run-fire-and-forget! form-flow/save-form-flow))]
       [ctx-menu-item "Close" #(f/run-fire-and-forget! nav/close-current-tab-flow)]
       [ctx-menu-item "Close All" #(f/run-fire-and-forget! nav/close-all-tabs-flow)]
       [:div.context-menu-separator]
       [ctx-menu-item "Form View" #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :view})
        (when (= (state-form/get-view-mode) :view) "active")]
       [ctx-menu-item "Design View" #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :design})
        (when (= (state-form/get-view-mode) :design) "active")]])))

(defn- calc-controls-width
  "Calculate the minimum width needed to show all controls across visible sections."
  [form-def]
  (let [sections (cond-> [:detail]
                   (not= 0 (get-in form-def [:header :visible] 1)) (conj :header)
                   (not= 0 (get-in form-def [:footer :visible] 1)) (conj :footer))
        all-controls (mapcat #(form-utils/get-section-controls form-def %) sections)
        max-right (reduce (fn [mx ctrl]
                            (let [right (+ (or (:x ctrl) 0) (or (:width ctrl) 0))]
                              (max mx right)))
                          0 all-controls)]
    (when (pos? max-right)
      (+ max-right 20))))

(defn form-canvas
  "The design surface where controls are placed"
  []
  (let [form-editor (:form-editor @state/app-state)
        current (:current form-editor)
        selected (:selected-control form-editor)
        grid-size (state/get-grid-size)
        content-width (or (:width current) (calc-controls-width current))]
    [:div.form-canvas
     {:tab-index 0
      :class (when @resize-state "resizing")
      :on-click (fn [_] (t/dispatch! :hide-context-menu))
      :on-mouse-move (fn [e] (when @resize-state (handle-resize! current e)))
      :on-mouse-up (fn [_] (stop-resize!))
      :on-mouse-leave (fn [_] (stop-resize!))
      :on-key-down (fn [e]
                     (t/dispatch! :hide-context-menu)
                     (cond
                       (= (.-key e) "Escape")
                       (reset! palette/palette-tool nil)

                       (and selected (or (= (.-key e) "Delete") (= (.-key e) "Backspace")))
                       (do (.preventDefault e)
                           (t/dispatch! :delete-control (:section selected) (:idx selected)))))}
     [:div.canvas-header
      [:div.form-selector
       {:class (when (nil? selected) "selected")
        :on-click #(do (.stopPropagation %) (t/dispatch! :select-control nil))
        :on-context-menu #(do (.preventDefault %) (.stopPropagation %)
                              (t/dispatch! :show-context-menu (.-clientX %) (.-clientY %)))
        :title "Select form to edit properties (right-click for menu)"}]
      [:span "Form Design View"]
      [form-context-menu]]
     [:div.canvas-body.sections-container
      [:div.sections-inner
       {:style (when content-width {:min-width content-width})}
       (when-not (= 0 (get-in current [:header :visible] 1))
         [form-section :header current selected grid-size])
       [form-section :detail current selected grid-size]
       (when-not (= 0 (get-in current [:footer :visible] 1))
         [form-section :footer current selected grid-size])]]
     (when-not (= 0 (:navigation-buttons current))
       [:div.record-nav-bar
        [:span.nav-label "Record:"]
        [:button.nav-btn {:title "First"} "|◀"]
        [:button.nav-btn {:title "Previous"} "◀"]
        [:span.record-counter "1 of 5"]
        [:button.nav-btn {:title "Next"} "▶"]
        [:button.nav-btn {:title "Last"} "▶|"]
        [:button.nav-btn {:title "New"} "▶*"]])]))
