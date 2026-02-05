(ns app.views.form-view
  "Form view mode - live data entry with record navigation"
  (:require [app.state :as state]
            [app.views.form-utils :as fu]))

(declare show-record-menu)

;; --- Individual control renderers ---
;; Each takes the control definition, resolved field name, resolved value,
;; and an on-change callback. Parameters like width/height are already
;; handled by the wrapping div's control-style.

(defn render-label
  "Render a static label control"
  [ctrl _field _value _on-change _opts]
  [:span.view-label (fu/display-text ctrl)])

(defn render-textbox
  "Render a text input control"
  [ctrl field value on-change {:keys [auto-focus? is-new? allow-edits?]}]
  [:input.view-input
   {:type "text"
    :value value
    :read-only (not allow-edits?)
    :auto-focus (and is-new? auto-focus?)
    :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}])

(defn render-button
  "Render a button control"
  [ctrl _field _value _on-change _opts]
  (let [button-text (or (:text ctrl) (:caption ctrl) "Button")
        on-click (if (= button-text "Close")
                   #(let [active (:active-tab @state/app-state)]
                      (when active
                        (state/close-tab! (:type active) (:id active))))
                   #(js/alert (str "Button clicked: " button-text)))]
    [:button.view-button {:on-click on-click} button-text]))

(defn render-checkbox
  "Render a checkbox control"
  [ctrl field value on-change {:keys [allow-edits?]}]
  [:label.view-checkbox
   [:input {:type "checkbox"
            :checked (boolean value)
            :disabled (not allow-edits?)
            :on-change #(when (and field allow-edits?) (on-change field (.. % -target -checked)))}]
   (or (:text ctrl) (:caption ctrl))])

(defn render-combobox
  "Render a combo box (dropdown) control"
  [_ctrl field value on-change {:keys [allow-edits?]}]
  [:select.view-select
   {:value value
    :disabled (not allow-edits?)
    :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}
   [:option ""]])

(defn render-default
  "Render fallback for unknown control types"
  [ctrl _field _value _on-change _opts]
  [:span (fu/display-text ctrl)])

;; --- Control type dispatch ---

(def control-renderers
  {:label     render-label
   :text-box  render-textbox
   :button    render-button
   :check-box render-checkbox
   :combo-box render-combobox})

(defn form-view-control
  "Render a single control in view mode"
  [ctrl current-record on-change & [{:keys [auto-focus? allow-edits?]}]]
  (let [ctrl-type (:type ctrl)
        field (fu/resolve-control-field ctrl)
        value (fu/resolve-field-value field current-record)
        is-new? (:__new__ current-record)
        renderer (get control-renderers ctrl-type render-default)]
    [:div.view-control
     {:style (fu/control-style ctrl)
      :on-context-menu show-record-menu}
     [renderer ctrl field value on-change {:auto-focus? auto-focus? :is-new? is-new? :allow-edits? allow-edits?}]]))

;; --- Record context menu ---

(defn show-record-menu [e]
  (.preventDefault e)
  (state/show-form-context-menu! (.-clientX e) (.-clientY e)))

(defn form-record-context-menu
  "Right-click context menu for form view records"
  []
  (let [menu (get-in @state/app-state [:form-editor :context-menu])
        has-clipboard? (some? @state/form-clipboard)
        allow-edits? (not= 0 (get-in @state/app-state [:form-editor :current :allow-edits]))
        allow-additions? (not= 0 (get-in @state/app-state [:form-editor :current :allow-additions]))
        allow-deletions? (not= 0 (get-in @state/app-state [:form-editor :current :allow-deletions]))
        has-record? (> (get-in @state/app-state [:form-editor :record-position :total] 0) 0)]
    (when (:visible menu)
      [:div.context-menu
       {:style {:left (:x menu) :top (:y menu)}
        :on-mouse-leave #(state/hide-form-context-menu!)}
       [:div.menu-item
        {:class (when-not (and has-record? allow-edits? allow-deletions?) "disabled")
         :on-click #(when (and has-record? allow-edits? allow-deletions?)
                      (state/cut-form-record!)
                      (state/hide-form-context-menu!))}
        "Cut"]
       [:div.menu-item
        {:class (when-not has-record? "disabled")
         :on-click #(when has-record?
                      (state/copy-form-record!)
                      (state/hide-form-context-menu!))}
        "Copy"]
       [:div.menu-item
        {:class (when-not (and has-clipboard? allow-additions?) "disabled")
         :on-click #(when (and has-clipboard? allow-additions?)
                      (state/paste-form-record!)
                      (state/hide-form-context-menu!))}
        "Paste"]
       [:div.menu-divider]
       [:div.menu-item
        {:class (when-not allow-additions? "disabled")
         :on-click #(when allow-additions?
                      (state/new-record!)
                      (state/hide-form-context-menu!))}
        "New Record"]
       [:div.menu-item.danger
        {:class (when-not (and has-record? allow-deletions?) "disabled")
         :on-click #(when (and has-record? allow-deletions?)
                      (when (js/confirm "Delete this record?")
                        (state/delete-current-record!))
                      (state/hide-form-context-menu!))}
        "Delete Record"]])))

;; --- Record selector ---

(defn record-selector [selected? new-record?]
  [:div.record-selector
   {:class [(when selected? "current") (when new-record? "new-record")]
    :on-context-menu show-record-menu}
   (cond
     (and selected? new-record?) "\u25B6*"
     selected? "\u25B6"
     new-record? "*"
     :else "\u00A0")])

;; --- Section and form rendering ---

(defn form-view-section
  "Render a section in view mode"
  [section form-def current-record on-field-change & [{:keys [show-selectors? allow-edits?]}]]
  (let [height (fu/get-section-height form-def section)
        controls (fu/get-section-controls form-def section)]
    (when (seq controls)
      (if (and show-selectors? (= section :detail))
        [:div.single-form-row
         [record-selector true false]
         [:div.view-section
          {:class (name section)
           :style {:height height :flex 1}}
          [:div.view-controls-container
           (for [[idx ctrl] (map-indexed vector controls)]
             ^{:key idx}
             [form-view-control ctrl current-record on-field-change {:allow-edits? allow-edits?}])]]]
        [:div.view-section
         {:class (name section)
          :style {:height height}}
         [:div.view-controls-container
          (for [[idx ctrl] (map-indexed vector controls)]
            ^{:key idx}
            [form-view-control ctrl current-record on-field-change {:allow-edits? allow-edits?}])]]))))

(defn form-view-detail-row
  "Render a single detail row for continuous forms"
  [idx record form-def selected? on-select on-field-change & [{:keys [show-selectors? allow-edits?]}]]
  (let [height (fu/get-section-height form-def :detail)
        controls (fu/get-section-controls form-def :detail)
        first-textbox-idx (first (keep-indexed
                                   (fn [i c] (when (= (:type c) :text-box) i))
                                   controls))]
    [:div.view-section.detail.continuous-row
     {:class (when selected? "selected")
      :style {:height height}
      :on-click #(on-select idx)}
     (when show-selectors?
       [record-selector selected? (:__new__ record)])
     [:div.view-controls-container
      (for [[ctrl-idx ctrl] (map-indexed vector controls)]
        ^{:key ctrl-idx}
        [form-view-control ctrl record on-field-change
         {:auto-focus? (and selected? (= ctrl-idx first-textbox-idx))
          :allow-edits? allow-edits?}])]]))

(defn tentative-new-row
  "Render the * placeholder row at the bottom of continuous forms"
  [form-def show-selectors?]
  (let [height (fu/get-section-height form-def :detail)]
    [:div.view-section.detail.continuous-row.tentative-row
     {:style {:height height}
      :on-click #(state/new-record!)}
     (when show-selectors?
       [record-selector false true])
     [:div.view-controls-container]]))

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
        show-selectors? (not= 0 (:record-selectors current))
        allow-edits? (not= 0 (:allow-edits current))
        allow-additions? (not= 0 (:allow-additions current))
        allow-deletions? (not= 0 (:allow-deletions current))
        dividing-lines? (not= 0 (:dividing-lines current))
        has-new-record? (some :__new__ all-records)
        ;; Check if any section has controls
        back-color (:back-color current)
        scroll-bars (or (:scroll-bars current) :both)
        form-width (or (:width current) (:form-width current))
        has-controls? (or (seq (fu/get-section-controls current :header))
                          (seq (fu/get-section-controls current :detail))
                          (seq (fu/get-section-controls current :footer)))]
    [:div.form-canvas.view-mode
     {:style (when back-color {:background-color back-color})
      :on-click #(do (state/hide-form-context-menu!)
                     (state/hide-context-menu!))}
     [:div.canvas-header
      {:on-context-menu (fn [e]
                          (.preventDefault e)
                          (.stopPropagation e)
                          (state/show-context-menu! (.-clientX e) (.-clientY e)))}
      [:span "Form View"]
      (when continuous? [:span.view-type-badge " (Continuous)"])
      (when (not record-source)
        [:span.no-source-warning " (No record source selected)"])]
     [:div.canvas-body.view-mode-body
      {:style (cond-> {}
                (#{:neither :vertical} scroll-bars) (assoc :overflow-x "hidden")
                (#{:neither :horizontal} scroll-bars) (assoc :overflow-y "hidden"))}
      (if (and record-source (or (> (:total record-pos) 0)
                                  (and continuous? allow-additions?)))
        (if continuous?
          ;; Continuous forms - render all records
          [:div.view-sections-container.continuous
           {:class (when-not dividing-lines? "no-dividing-lines")
            :style (when form-width {:max-width form-width})}
           [form-view-section :header current current-record on-field-change {:allow-edits? allow-edits?}]
           [:div.continuous-records-container
            (for [[idx record] (map-indexed vector all-records)]
              (let [selected? (= (inc idx) (:current record-pos))
                    ;; Use current-record for selected row to show live edits
                    display-record (if selected? current-record record)]
                ^{:key (or (:id record) idx)}
                [form-view-detail-row idx display-record current
                 selected? on-select-record on-field-change
                 {:show-selectors? show-selectors? :allow-edits? allow-edits?}]))
            (when (and allow-additions? (not has-new-record?))
              [tentative-new-row current show-selectors?])]
           [form-view-section :footer current current-record on-field-change {:allow-edits? allow-edits?}]]
          ;; Single form - render one record
          [:div.view-sections-container
           {:style (when form-width {:max-width form-width})}
           [form-view-section :header current current-record on-field-change {:allow-edits? allow-edits?}]
           [form-view-section :detail current current-record on-field-change
            {:show-selectors? show-selectors? :allow-edits? allow-edits?}]
           [form-view-section :footer current current-record on-field-change {:allow-edits? allow-edits?}]])
        [:div.no-records
         (if record-source
           (if has-controls?
             "No records found"
             "Add controls in Design View")
           "Select a record source in Design View")])]
     ;; Record navigation bar (hidden when navigation-buttons is 0)
     (when-not (= 0 (:navigation-buttons current))
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
                            :disabled (not allow-additions?)
                            :on-click #(state/new-record!)} "▶*"]
          [:button.nav-btn.delete-btn
           {:title "Delete Record"
            :disabled (or (< (:total record-pos) 1) (not allow-deletions?))
            :on-click #(when (js/confirm "Delete this record?")
                         (state/delete-current-record!))} "✕"]
          [:span.nav-separator]
          [:button.nav-btn.save-btn
           {:title "Save Record"
            :class (when record-dirty? "dirty")
            :disabled (not record-dirty?)
            :on-click #(state/save-current-record!)}
           "Save"]])
     [form-record-context-menu]
     ;; Canvas header context menu (Save/Close/View switching)
     (let [ctx-menu (:context-menu @state/app-state)]
       (when (:visible? ctx-menu)
         [:div.context-menu
          {:style {:left (:x ctx-menu) :top (:y ctx-menu)}}
          [:div.context-menu-item
           {:on-click (fn [e]
                        (.stopPropagation e)
                        (state/hide-context-menu!)
                        (state/save-current-record!))}
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
           "Design View"]]))]))
