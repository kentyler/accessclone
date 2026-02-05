(ns app.views.form-view
  "Form view mode - live data entry with record navigation"
  (:require [clojure.string]
            [app.state :as state]
            [app.views.form-utils :as form-utils]))

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
  (let [height (form-utils/get-section-height form-def section)
        controls (form-utils/get-section-controls form-def section)]
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
  (let [height (form-utils/get-section-height form-def :detail)
        controls (form-utils/get-section-controls form-def :detail)
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
        has-controls? (or (seq (form-utils/get-section-controls current :header))
                          (seq (form-utils/get-section-controls current :detail))
                          (seq (form-utils/get-section-controls current :footer)))]
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
           "Save"]])]))
