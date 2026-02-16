(ns app.views.report-design
  "Report design surface - drag-drop editor for report controls"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.state-report :as state-report]
            [app.views.report-utils :as ru]
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
  (let [report-editor (:report-editor @state/app-state)
        current (:current report-editor)
        record-source (:record-source current)
        fields (ru/get-record-source-fields record-source)]
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
  "Add a control for a dropped field in a report section"
  [field-name field-type x y ctrl-key? section]
  (let [current (get-in @state/app-state [:report-editor :current])
        section (or section :detail)
        controls (ru/get-section-controls current section)
        snapped-x (ru/snap-to-grid x ctrl-key?)
        snapped-y (ru/snap-to-grid y ctrl-key?)
        new-control {:type :text-box
                     :field field-name
                     :label field-name
                     :x snapped-x
                     :y snapped-y
                     :width 150
                     :height 24}
        label-control {:type :label
                       :text field-name
                       :x snapped-x
                       :y (ru/snap-to-grid (- y 20) ctrl-key?)
                       :width 150
                       :height 18}
        new-controls (vec (conj controls label-control new-control))]
    (state-report/set-report-definition!
     (assoc-in current [section :controls] new-controls))))

(defn- add-palette-control!
  "Place a new control from the palette tool at click coordinates in a report section."
  [control-type section x y ctrl-key?]
  (let [current (get-in @state/app-state [:report-editor :current])
        section (or section :detail)
        controls (ru/get-section-controls current section)
        snapped-x (ru/snap-to-grid x ctrl-key?)
        snapped-y (ru/snap-to-grid y ctrl-key?)
        new-ctrl (palette/control-defaults control-type snapped-x snapped-y)
        new-controls (conj (vec controls) new-ctrl)
        new-idx (dec (count new-controls))]
    (state-report/set-report-definition!
     (assoc-in current [section :controls] new-controls))
    (state-report/select-report-control! {:section section :idx new-idx})
    (reset! palette/palette-tool nil)))

(defn move-control!
  "Move an existing control to a new position in a report section"
  [control-idx new-x new-y ctrl-key? section]
  (let [current (get-in @state/app-state [:report-editor :current])
        section (or section :detail)
        controls (ru/get-section-controls current section)
        snapped-x (ru/snap-to-grid new-x ctrl-key?)
        snapped-y (ru/snap-to-grid new-y ctrl-key?)]
    (when (< control-idx (count controls))
      (state-report/set-report-definition!
       (assoc-in current [section :controls]
                 (update controls control-idx
                         (fn [ctrl]
                           (assoc ctrl :x snapped-x :y snapped-y))))))))

(defn section-controls
  "Render controls for a specific report section"
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
                     (state-report/select-report-control! {:section section :idx idx}))
         :on-drag-start (fn [e]
                          (let [rect (.getBoundingClientRect (.-target e))
                                offset-x (- (.-clientX e) (.-left rect))
                                offset-y (- (.-clientY e) (.-top rect))]
                            (.setData (.-dataTransfer e) "application/x-control-idx" (str idx))
                            (.setData (.-dataTransfer e) "application/x-section" (name section))
                            (.setData (.-dataTransfer e) "application/x-offset"
                                      (js/JSON.stringify (clj->js {:x offset-x :y offset-y})))))
         :style (ru/control-style ctrl)}
        (ru/display-text ctrl)
        [:button.control-delete
         {:on-click (fn [e]
                      (.stopPropagation e)
                      (state-report/delete-report-control! section idx))
          :title "Delete"}
         "\u00D7"]])]))

(def resize-state (r/atom nil))

(defn start-resize! [section e]
  (.preventDefault e)
  (reset! resize-state {:section section :start-y (.-clientY e)}))

(defn handle-resize! [report-def e]
  (when-let [{:keys [section start-y]} @resize-state]
    (let [current-y (.-clientY e)
          delta (- current-y start-y)
          current-height (ru/get-section-height report-def section)
          new-height (max 20 (+ current-height delta))]
      (reset! resize-state {:section section :start-y current-y})
      (state-report/set-report-definition!
       (assoc-in report-def [section :height] new-height)))))

(defn stop-resize! []
  (reset! resize-state nil))

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
  "Handle a drop event on a report section."
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
  "Build the style map for a report section body."
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

(defn report-section
  "A single report section (report-header, page-header, detail, etc.)"
  [section report-def selected grid-size]
  (let [height (ru/get-section-height report-def section)
        controls (ru/get-section-controls report-def section)
        section-label (ru/section-display-name section)
        section-data (get report-def section)
        section-selected? (and selected (:section selected) (nil? (:idx selected))
                               (= (:section selected) section))]
    [:div.form-section {:class (name section)}
     [:div.section-divider
      {:class "resizable" :title (str "Drag to resize " section-label)
       :on-click (fn [e] (.stopPropagation e)
                   (state-report/select-report-control! {:section section}))
       :on-mouse-down #(start-resize! section %)}
      [:span.section-label section-label]]
     [:div.section-body
      {:class (when section-selected? "selected")
       :style (section-body-style height grid-size section-data)
       :on-drag-over #(.preventDefault %)
       :on-click (fn [e]
                   (when (or (.. e -target -classList (contains "section-body"))
                             (.. e -target -classList (contains "controls-container")))
                     (if-let [tool @palette/palette-tool]
                       (let [rect (.getBoundingClientRect (.-currentTarget e))
                             x (- (.-clientX e) (.-left rect))
                             y (- (.-clientY e) (.-top rect))]
                         (add-palette-control! tool section x y (.-ctrlKey e)))
                       (state-report/select-report-control! {:section section}))))
       :on-drop #(handle-section-drop! section %)}
      (if (empty? controls)
        [:div.section-empty (if (= section :detail) "Drag fields here" "")]
        [section-controls section controls selected grid-size])]]))

(defn report-canvas
  "The design surface for reports"
  []
  (let [report-editor (:report-editor @state/app-state)
        current (:current report-editor)
        selected (:selected-control report-editor)
        grid-size (state/get-grid-size)
        resizing? @resize-state
        all-sections (ru/get-all-sections current)]
    [:div.form-canvas
     {:tab-index 0
      :class (when resizing? "resizing")
      :on-mouse-move (fn [e] (when resizing? (handle-resize! current e)))
      :on-mouse-up (fn [_] (stop-resize!))
      :on-mouse-leave (fn [_] (stop-resize!))
      :on-key-down (fn [e]
                     (cond
                       (= (.-key e) "Escape")
                       (reset! palette/palette-tool nil)

                       (and selected (:idx selected)
                            (or (= (.-key e) "Delete")
                                (= (.-key e) "Backspace")))
                       (do (.preventDefault e)
                           (state-report/delete-report-control! (:section selected) (:idx selected)))))}
     [:div.canvas-header
      [:div.form-selector
       {:class (when (nil? selected) "selected")
        :on-click (fn [e]
                    (.stopPropagation e)
                    (state-report/select-report-control! nil))
        :title "Select report to edit properties"}]
      [:span "Report Design View"]]
     [:div.canvas-body.sections-container
      (for [section-key all-sections]
        ^{:key section-key}
        [report-section section-key current selected grid-size])]]))
