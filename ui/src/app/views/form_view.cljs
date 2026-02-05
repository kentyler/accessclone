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
  [ctrl field value on-change {:keys [auto-focus? is-new?]}]
  [:input.view-input
   {:type "text"
    :value value
    :auto-focus (and is-new? auto-focus?)
    :on-change #(when field (on-change field (.. % -target -value)))}])

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
  [ctrl field value on-change _opts]
  [:label.view-checkbox
   [:input {:type "checkbox"
            :checked (boolean value)
            :on-change #(when field (on-change field (.. % -target -checked)))}]
   (or (:text ctrl) (:caption ctrl))])

(defn render-combobox
  "Render a combo box (dropdown) control"
  [_ctrl field value on-change _opts]
  [:select.view-select
   {:value value
    :on-change #(when field (on-change field (.. % -target -value)))}
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
  [ctrl current-record on-change & [{:keys [auto-focus?]}]]
  (let [ctrl-type (fu/normalize-ctrl-type ctrl)
        field (fu/resolve-control-field ctrl)
        value (fu/resolve-field-value field current-record)
        is-new? (:__new__ current-record)
        renderer (get control-renderers ctrl-type render-default)]
    [:div.view-control
     {:style (fu/control-style ctrl)
      :on-context-menu show-record-menu}
     [renderer ctrl field value on-change {:auto-focus? auto-focus? :is-new? is-new?}]]))

;; --- Record context menu ---

(defn show-record-menu [e]
  (.preventDefault e)
  (state/show-form-context-menu! (.-clientX e) (.-clientY e)))

(defn form-record-context-menu
  "Right-click context menu for form view records"
  []
  (let [menu (get-in @state/app-state [:form-editor :context-menu])
        has-clipboard? (some? @state/form-clipboard)
        allow-additions? (not= 0 (get-in @state/app-state [:form-editor :current :allow-additions]))
        has-record? (> (get-in @state/app-state [:form-editor :record-position :total] 0) 0)]
    (when (:visible menu)
      [:div.context-menu
       {:style {:left (:x menu) :top (:y menu)}
        :on-mouse-leave #(state/hide-form-context-menu!)}
       [:div.menu-item
        {:class (when-not has-record? "disabled")
         :on-click #(when has-record?
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
        {:class (when-not has-record? "disabled")
         :on-click #(when has-record?
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
  [section form-def current-record on-field-change & [{:keys [show-selectors?]}]]
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
             [form-view-control ctrl current-record on-field-change])]]]
        [:div.view-section
         {:class (name section)
          :style {:height height}}
         [:div.view-controls-container
          (for [[idx ctrl] (map-indexed vector controls)]
            ^{:key idx}
            [form-view-control ctrl current-record on-field-change])]]))))

(defn form-view-detail-row
  "Render a single detail row for continuous forms"
  [idx record form-def selected? on-select on-field-change & [{:keys [show-selectors?]}]]
  (let [height (fu/get-section-height form-def :detail)
        controls (fu/get-section-controls form-def :detail)
        ;; Find index of first text-box for auto-focus (handle both keyword and string types)
        first-textbox-idx (first (keep-indexed
                                   (fn [i c] (when (= (fu/normalize-ctrl-type c) :text-box) i))
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
         {:auto-focus? (and selected? (= ctrl-idx first-textbox-idx))}])]]))

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
        allow-additions? (not= 0 (:allow-additions current))
        has-new-record? (some :__new__ all-records)
        ;; Check if any section has controls
        has-controls? (or (seq (fu/get-section-controls current :header))
                          (seq (fu/get-section-controls current :detail))
                          (seq (fu/get-section-controls current :footer)))]
    [:div.form-canvas.view-mode
     {:on-click #(state/hide-form-context-menu!)}
     [:div.canvas-header
      [:span "Form View"]
      (when continuous? [:span.view-type-badge " (Continuous)"])
      (when (not record-source)
        [:span.no-source-warning " (No record source selected)"])]
     [:div.canvas-body.view-mode-body
      (if (and record-source (or (> (:total record-pos) 0)
                                  (and continuous? allow-additions?)))
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
                 selected? on-select-record on-field-change
                 {:show-selectors? show-selectors?}]))
            (when (and allow-additions? (not has-new-record?))
              [tentative-new-row current show-selectors?])]
           [form-view-section :footer current current-record on-field-change]]
          ;; Single form - render one record
          [:div.view-sections-container
           [form-view-section :header current current-record on-field-change]
           [form-view-section :detail current current-record on-field-change
            {:show-selectors? show-selectors?}]
           [form-view-section :footer current current-record on-field-change]])
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
            :disabled (< (:total record-pos) 1)
            :on-click #(when (js/confirm "Delete this record?")
                         (state/delete-current-record!))} "✕"]
          [:span.nav-separator]
          [:button.nav-btn.save-btn
           {:title "Save Record"
            :class (when record-dirty? "dirty")
            :disabled (not record-dirty?)
            :on-click #(state/save-current-record!)}
           "Save"]])
     [form-record-context-menu]]))
