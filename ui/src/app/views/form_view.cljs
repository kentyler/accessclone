(ns app.views.form-view
  "Form view mode - live data entry with record navigation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.views.form-utils :as fu]
            [clojure.string :as str]))

(declare show-record-menu form-view-control)

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
        click-fn-name (:on-click ctrl)
        on-click (cond
                   ;; Close button special case
                   (= button-text "Close")
                   #(let [active (:active-tab @state/app-state)]
                      (when active
                        (state/close-tab! (:type active) (:id active))))
                   ;; Mapped function name
                   (and click-fn-name (string? click-fn-name)
                        (not (str/blank? click-fn-name)))
                   #(state/call-session-function! click-fn-name)
                   ;; No mapped function
                   :else
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

;; --- Row-source helpers (shared by combobox & listbox) ---

(defn- parse-column-widths
  "Parse column-widths string like '0cm;5cm' into a vector of numbers [0 5].
   Columns with width 0 are hidden from display."
  [col-widths-str]
  (when (and col-widths-str (not (str/blank? col-widths-str)))
    (mapv (fn [s]
            (let [n (js/parseFloat (str/replace (str/trim s) #"[a-zA-Z]+" ""))]
              (if (js/isNaN n) 1 n)))
          (str/split col-widths-str #";"))))

(defn- build-option-display
  "Given a data row, fields list, bound-column (1-based), and column-widths,
   returns [bound-val display-text] where display-text joins visible columns."
  [row fields bound-col col-widths]
  (let [field-names (mapv (fn [f] (or (:name f) (name (first (keys f))))) fields)
        bound-idx (max 0 (dec (or bound-col 1)))
        ;; Get bound value from the bound column
        bound-key (if (< bound-idx (count field-names))
                    (nth field-names bound-idx)
                    (first field-names))
        bound-val (str (or (get row bound-key)
                           (get row (keyword bound-key)) ""))
        ;; Build display text from visible columns
        visible-texts (keep-indexed
                        (fn [i fname]
                          (let [w (when (seq col-widths) (nth col-widths i nil))]
                            ;; Show column if no widths specified, or width > 0
                            (when (or (nil? w) (> w 0))
                              (str (or (get row fname)
                                       (get row (keyword fname)) "")))))
                        field-names)
        display (if (seq visible-texts)
                  (str/join " - " visible-texts)
                  bound-val)]
    [bound-val display]))

(defn render-combobox
  "Render a combo box (dropdown) control - Form-2 component.
   Fetches row-source on mount, populates options from cache."
  [ctrl field value on-change opts]
  ;; Outer function: trigger fetch
  (when-let [row-source (:row-source ctrl)]
    (state/fetch-row-source! row-source))
  ;; Inner render function
  (fn [ctrl field value on-change {:keys [allow-edits?]}]
    (let [row-source (:row-source ctrl)
          cached (when row-source
                   (state/get-row-source-options row-source))
          rows (when (map? cached) (:rows cached))
          fields (when (map? cached) (:fields cached))
          bound-col (:bound-column ctrl)
          col-widths (parse-column-widths (:column-widths ctrl))]
      [:select.view-select
       {:value (str (or value ""))
        :disabled (not allow-edits?)
        :on-change #(when (and field allow-edits?)
                      (on-change field (.. % -target -value)))}
       [:option {:value ""} ""]
       (when (seq rows)
         (for [[idx row] (map-indexed vector rows)]
           (let [[bound-val display] (build-option-display row fields bound-col col-widths)]
             ^{:key idx}
             [:option {:value bound-val} display])))])))

(defn render-line
  "Render a horizontal line control"
  [ctrl _field _value _on-change _opts]
  [:hr.view-line
   {:style (cond-> {}
             (:border-color ctrl) (assoc :border-color (:border-color ctrl))
             (:border-width ctrl) (assoc :border-top-width (:border-width ctrl)))}])

(defn render-rectangle
  "Render a rectangle (box) control"
  [ctrl _field _value _on-change _opts]
  [:div.view-rectangle
   {:style (cond-> {}
             (:back-color ctrl) (assoc :background-color (:back-color ctrl))
             (:border-color ctrl) (assoc :border-color (:border-color ctrl))
             (:border-width ctrl) (assoc :border-width (:border-width ctrl)))}])

(defn render-image
  "Render an image control"
  [ctrl _field _value _on-change _opts]
  (if-let [src (:picture ctrl)]
    [:img.view-image {:src src :alt (or (:text ctrl) "Image")}]
    [:div.view-image-placeholder "\uD83D\uDDBC No Image"]))

(defn render-listbox
  "Render a list box control - Form-2 component.
   Fetches row-source on mount, populates options from cache."
  [ctrl field value on-change opts]
  ;; Outer function: trigger fetch
  (when-let [row-source (:row-source ctrl)]
    (state/fetch-row-source! row-source))
  ;; Inner render function
  (fn [ctrl field value on-change {:keys [allow-edits?]}]
    (let [row-source (:row-source ctrl)
          cached (when row-source
                   (state/get-row-source-options row-source))
          rows (when (map? cached) (:rows cached))
          fields (when (map? cached) (:fields cached))
          bound-col (:bound-column ctrl)
          col-widths (parse-column-widths (:column-widths ctrl))
          list-rows (or (:list-rows ctrl) 5)]
      [:select.view-listbox
       {:multiple true
        :size list-rows
        :value (str (or value ""))
        :disabled (not allow-edits?)
        :on-change #(when (and field allow-edits?)
                      (on-change field (.. % -target -value)))}
       [:option {:value ""} ""]
       (when (seq rows)
         (for [[idx row] (map-indexed vector rows)]
           (let [[bound-val display] (build-option-display row fields bound-col col-widths)]
             ^{:key idx}
             [:option {:value bound-val} display])))])))

(defn render-option-group
  "Render a radio button group control"
  [ctrl field value on-change {:keys [allow-edits?]}]
  (let [options (or (:options ctrl) [])
        group-name (or (:name ctrl) (str "optgrp-" (random-uuid)))]
    [:div.view-option-group
     (if (seq options)
       (for [[idx opt] (map-indexed vector options)]
         ^{:key idx}
         [:label.view-option-item
          [:input {:type "radio"
                   :name group-name
                   :value (or (:value opt) idx)
                   :checked (= value (or (:value opt) idx))
                   :disabled (not allow-edits?)
                   :on-change #(when (and field allow-edits?)
                                 (on-change field (or (:value opt) idx)))}]
          (or (:label opt) (str "Option " (inc idx)))])
       [:span.view-option-placeholder "(No options defined)"])]))

(defn render-tab-control
  "Render a tab control with clickable tab headers and nested child controls"
  [ctrl _field _value _on-change _opts]
  (let [active-tab (r/atom 0)]
    (fn [ctrl _field _value _on-change {:keys [all-controls current-record on-change allow-edits?]}]
      (let [page-names (or (:pages ctrl) [])
            ;; Find :page type controls to get captions for each page name
            page-ctrls (filter #(= :page (:type %)) (or all-controls []))
            page-caption (fn [page-name]
                           (let [pg (first (filter #(= (:name %) page-name) page-ctrls))]
                             (or (:caption pg) page-name)))
            ;; Active page name
            active-page-name (nth page-names @active-tab nil)
            ;; Child controls belonging to the active page
            child-controls (when active-page-name
                             (filter #(= (:parent-page %) active-page-name)
                                     (or all-controls [])))]
        [:div.view-tab-control
         [:div.view-tab-headers
          (if (seq page-names)
            (for [[idx pname] (map-indexed vector page-names)]
              ^{:key idx}
              [:div.view-tab-header
               {:class (when (= idx @active-tab) "active")
                :on-click #(reset! active-tab idx)}
               (page-caption pname)])
            [:div.view-tab-header.active "Page 1"])]
         [:div.view-tab-body
          (if (seq child-controls)
            (for [[idx child] (map-indexed vector child-controls)]
              ^{:key idx}
              [form-view-control child current-record on-change
               {:allow-edits? allow-edits? :all-controls all-controls}])
            (when-not (seq page-names)
              [:span "(Empty tab control)"]))]]))))

(defn render-subform
  "Render a subform with child records as an editable datasheet - Form-2 component.
   Fetches child form definition on mount, then child records filtered by parent link fields."
  [ctrl _field _value _on-change _opts]
  ;; Outer function: trigger definition fetch + local editing state
  (let [source-form (or (:source-form ctrl) (:source_form ctrl))
        selected (r/atom nil)    ;; {:row idx :col "field"} or nil
        editing (r/atom nil)     ;; {:row idx :col "field"} or nil
        edit-value (r/atom "")]
    (when source-form
      (state/fetch-subform-definition! source-form))
    ;; Inner render function
    (fn [ctrl _field _value _on-change _opts]
      (let [source-form (or (:source-form ctrl) (:source_form ctrl))
            link-child-fields (or (:link-child-fields ctrl) (:link_child_fields ctrl))
            link-master-fields (or (:link-master-fields ctrl) (:link_master_fields ctrl))
            ;; Read current-record from app-state so we re-render on parent navigation
            current-record (or (get-in @state/app-state [:form-editor :current-record]) {})
            ;; Get cached definition
            definition (when source-form
                         (get-in @state/app-state [:form-editor :subform-cache source-form :definition]))
            ;; Read permissions from child form definition
            allow-edits? (when (map? definition) (not= 0 (get definition :allow-edits 1)))
            allow-additions? (when (map? definition) (not= 0 (get definition :allow-additions 1)))
            allow-deletions? (when (map? definition) (not= 0 (get definition :allow-deletions 1)))
            ;; Extract record-source from child form definition
            child-record-source (when (map? definition)
                                  (or (:record-source definition) (:record_source definition)))
            ;; Trigger child record fetch when definition is ready and we have link fields
            _ (when (and source-form child-record-source (seq link-child-fields) (seq link-master-fields))
                (state/fetch-subform-records! source-form child-record-source
                                              link-child-fields link-master-fields current-record))
            ;; Get cached records
            records (when source-form
                      (get-in @state/app-state [:form-editor :subform-cache source-form :records]))
            ;; Build column headers from child form's detail section controls
            detail-controls (when (map? definition)
                              (get-in definition [:detail :controls]))
            columns (if (seq detail-controls)
                      (let [bound-ctrls (filter #(or (:control-source %) (:field %)) detail-controls)]
                        (if (seq bound-ctrls)
                          (mapv (fn [c]
                                  {:field (str/lower-case (or (:control-source c) (:field c)))
                                   :caption (or (:caption c) (:label c)
                                                (:control-source c) (:field c))})
                                bound-ctrls)
                          nil))
                      nil)
            ;; Commit edit helper
            commit-edit! (fn []
                           (when-let [{:keys [row col]} @editing]
                             (let [old-val (str (or (get (nth records row) (keyword col))
                                                    (get (nth records row) col) ""))
                                   new-val @edit-value]
                               (when (not= old-val new-val)
                                 (state/save-subform-cell! source-form row col new-val)))
                             (reset! editing nil)))]
        [:div.view-subform
         [:div.view-subform-header
          {:style {:display "flex" :align-items "center"}}
          [:span (if source-form (str "Subform: " source-form) "Subform (no source)")]
          (when (and source-form (map? definition))
            [:div.subform-toolbar
             (when allow-additions?
               [:button {:title "New Record"
                         :on-click #(state/new-subform-record!
                                      source-form link-child-fields link-master-fields current-record)}
                "+"])
             (when (and allow-deletions? @selected)
               [:button.subform-delete-btn
                {:title "Delete Record"
                 :on-click #(when (js/confirm "Delete this record?")
                              (state/delete-subform-record! source-form (:row @selected))
                              (reset! selected nil)
                              (reset! editing nil))}
                "\u2715"])])]
         (cond
           (not source-form)
           nil

           (= definition :loading)
           [:div.subform-datasheet [:span.subform-loading "Loading..."]]

           (:error definition)
           [:div.subform-datasheet [:span.subform-loading "Error loading subform"]]

           (= records :loading)
           [:div.subform-datasheet [:span.subform-loading "Loading records..."]]

           (and (vector? records) (empty? records) (not allow-additions?))
           [:div.subform-datasheet [:span.subform-loading "(No records)"]]

           (and (vector? records) (or (seq records) allow-additions?))
           (let [cols (or columns
                        (when (seq records)
                          (mapv (fn [k] {:field (name k) :caption (name k)})
                                (keys (first records))))
                        [])]
             [:div.subform-datasheet
              (when (seq cols)
                [:table.subform-table
                 [:thead
                  [:tr
                   (for [[i col] (map-indexed vector cols)]
                     ^{:key i}
                     [:th (:caption col)])]]
                 [:tbody
                  (for [[idx rec] (map-indexed vector records)]
                    ^{:key idx}
                    [:tr
                     (for [[ci col] (map-indexed vector cols)]
                       (let [col-field (:field col)
                             is-selected? (and @selected
                                               (= (:row @selected) idx)
                                               (= (:col @selected) col-field))
                             is-editing? (and @editing
                                              (= (:row @editing) idx)
                                              (= (:col @editing) col-field))]
                         ^{:key ci}
                         [:td {:class (str (when is-selected? "selected ")
                                           (when is-editing? "editing"))
                               :on-click (fn [e]
                                           (.stopPropagation e)
                                           (when (not is-editing?)
                                             (commit-edit!)
                                             (reset! selected {:row idx :col col-field})))
                               :on-double-click (fn [e]
                                                  (.stopPropagation e)
                                                  (when allow-edits?
                                                    (reset! selected {:row idx :col col-field})
                                                    (reset! editing {:row idx :col col-field})
                                                    (reset! edit-value
                                                            (str (or (get rec (keyword col-field))
                                                                     (get rec col-field) "")))))}
                          (if is-editing?
                            [:input.subform-cell-input
                             {:type "text"
                              :auto-focus true
                              :value @edit-value
                              :on-change #(reset! edit-value (.. % -target -value))
                              :on-blur #(commit-edit!)
                              :on-key-down (fn [e]
                                             (case (.-key e)
                                               "Enter" (commit-edit!)
                                               "Escape" (reset! editing nil)
                                               nil))}]
                            (str (or (get rec (keyword col-field))
                                     (get rec col-field) "")))]))])]])])

           :else
           [:div.subform-datasheet [:span.subform-loading "Loading..."]])]))))

(defn render-default
  "Render fallback for unknown control types"
  [ctrl _field _value _on-change _opts]
  [:span (fu/display-text ctrl)])

;; --- Control type dispatch ---

(def control-renderers
  {:label        render-label
   :text-box     render-textbox
   :button       render-button
   :check-box    render-checkbox
   :combo-box    render-combobox
   :line         render-line
   :rectangle    render-rectangle
   :image        render-image
   :list-box     render-listbox
   :option-group render-option-group
   :tab-control  render-tab-control
   :subform      render-subform})

(defn form-view-control
  "Render a single control in view mode"
  [ctrl current-record on-change & [{:keys [auto-focus? allow-edits? all-controls]}]]
  (let [ctrl-type (:type ctrl)
        field (fu/resolve-control-field ctrl)
        value (fu/resolve-field-value field current-record)
        is-new? (:__new__ current-record)
        renderer (get control-renderers ctrl-type render-default)]
    [:div.view-control
     {:style (fu/control-style ctrl)
      :on-context-menu show-record-menu}
     [renderer ctrl field value on-change
      {:auto-focus? auto-focus? :is-new? is-new? :allow-edits? allow-edits?
       :all-controls all-controls :current-record current-record :on-change on-change}]]))

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
        all-controls (fu/get-section-controls form-def section)
        ;; Filter out controls that belong to tab pages (rendered inside tab body)
        controls (remove #(or (:parent-page %) (= :page (:type %))) all-controls)]
    (when (seq all-controls)
      (if (and show-selectors? (= section :detail))
        [:div.single-form-row
         [record-selector true false]
         [:div.view-section
          {:class (name section)
           :style {:height height :flex 1}}
          [:div.view-controls-container
           (for [[idx ctrl] (map-indexed vector controls)]
             ^{:key idx}
             [form-view-control ctrl current-record on-field-change
              {:allow-edits? allow-edits? :all-controls all-controls}])]]]
        [:div.view-section
         {:class (name section)
          :style {:height height}}
         [:div.view-controls-container
          (for [[idx ctrl] (map-indexed vector controls)]
            ^{:key idx}
            [form-view-control ctrl current-record on-field-change
             {:allow-edits? allow-edits? :all-controls all-controls}])]]))))

(defn form-view-detail-row
  "Render a single detail row for continuous forms"
  [idx record form-def selected? on-select on-field-change & [{:keys [show-selectors? allow-edits?]}]]
  (let [height (fu/get-section-height form-def :detail)
        all-controls (fu/get-section-controls form-def :detail)
        ;; Filter out controls that belong to tab pages
        controls (vec (remove #(or (:parent-page %) (= :page (:type %))) all-controls))
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
          :allow-edits? allow-edits?
          :all-controls all-controls}])]]))

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
