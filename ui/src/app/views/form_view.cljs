(ns app.views.form-view
  "Form view mode - live data entry with record navigation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.state-form :as state-form]
            [app.views.form-utils :as fu]
            [app.views.expressions :as expr]
            [clojure.string :as str]))

(declare show-record-menu form-view-control)

;; ============================================================
;; INDIVIDUAL CONTROL RENDERERS
;; ============================================================

(defn render-label [ctrl _field _value _on-change _opts]
  [:span.view-label (fu/display-text ctrl)])

(defn render-textbox [ctrl field value on-change {:keys [auto-focus? is-new? allow-edits?]}]
  [:input.view-input
   {:type "text" :value value :read-only (not allow-edits?)
    :auto-focus (and is-new? auto-focus?)
    :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}])

;; --- Button action resolution ---

(defn- resolve-action-from-prop
  "Resolve on-click from an explicit :on-click property (map or string)."
  [on-click-prop]
  (cond
    (and (map? on-click-prop) (:action on-click-prop))
    (case (keyword (:action on-click-prop))
      :save-record   #(state-form/save-current-record!)
      :new-record    #(state-form/new-record!)
      :delete-record #(when (js/confirm "Delete this record?") (state-form/delete-current-record!))
      :close-form    #(state-form/close-current-tab!)
      :refresh       #(state-form/set-view-mode! :view)
      #(js/alert (str "Unknown action: " (:action on-click-prop))))

    (and (map? on-click-prop) (:function on-click-prop))
    #(state-form/call-session-function! (:function on-click-prop))

    (and (string? on-click-prop) (not (str/blank? on-click-prop)))
    #(state-form/call-session-function! on-click-prop)

    :else nil))

(defn- resolve-action-from-caption
  "Resolve on-click from button caption text as a fallback."
  [text-lower button-text]
  (cond
    (or (= text-lower "close") (str/includes? text-lower "close form"))
    #(state-form/close-current-tab!)
    (or (= text-lower "save") (str/includes? text-lower "save record"))
    #(state-form/save-current-record!)
    (or (= text-lower "new record") (= text-lower "new") (str/includes? text-lower "add new"))
    #(state-form/new-record!)
    (or (= text-lower "delete") (= text-lower "delete record"))
    #(when (js/confirm "Delete this record?") (state-form/delete-current-record!))
    (or (= text-lower "refresh") (= text-lower "requery"))
    #(state-form/set-view-mode! :view)
    :else
    #(js/alert (str "Button clicked: " button-text))))

(defn- resolve-button-action [ctrl]
  (let [button-text (or (:text ctrl) (:caption ctrl) "Button")]
    (or (resolve-action-from-prop (:on-click ctrl))
        (resolve-action-from-caption (str/lower-case button-text) button-text))))

(defn render-button [ctrl _field _value _on-change _opts]
  (let [text (or (:text ctrl) (:caption ctrl) "Button")]
    [:button.view-button {:on-click (resolve-button-action ctrl)} text]))

(defn render-checkbox [ctrl field value on-change {:keys [allow-edits?]}]
  [:label.view-checkbox
   [:input {:type "checkbox" :checked (boolean value) :disabled (not allow-edits?)
            :on-change #(when (and field allow-edits?) (on-change field (.. % -target -checked)))}]
   (or (:text ctrl) (:caption ctrl))])

;; --- Row-source helpers (shared by combobox & listbox) ---

(defn- parse-column-widths [col-widths-str]
  (when (and col-widths-str (not (str/blank? col-widths-str)))
    (mapv (fn [s]
            (let [n (js/parseFloat (str/replace (str/trim s) #"[a-zA-Z]+" ""))]
              (if (js/isNaN n) 1 n)))
          (str/split col-widths-str #";"))))

(defn- build-option-display [row fields bound-col col-widths]
  (let [field-names (mapv (fn [f] (or (:name f) (name (first (keys f))))) fields)
        bound-idx (max 0 (dec (or bound-col 1)))
        bound-key (if (< bound-idx (count field-names))
                    (nth field-names bound-idx) (first field-names))
        bound-val (str (or (get row bound-key) (get row (keyword bound-key)) ""))
        visible-texts (keep-indexed
                        (fn [i fname]
                          (let [w (when (seq col-widths) (nth col-widths i nil))]
                            (when (or (nil? w) (> w 0))
                              (str (or (get row fname) (get row (keyword fname)) "")))))
                        field-names)]
    [bound-val (if (seq visible-texts) (str/join " - " visible-texts) bound-val)]))

(defn- row-source-options
  "Build option elements from cached row-source data."
  [ctrl]
  (let [cached (when-let [rs (:row-source ctrl)] (state-form/get-row-source-options rs))
        rows (when (map? cached) (:rows cached))
        fields (when (map? cached) (:fields cached))
        bound-col (:bound-column ctrl)
        col-widths (parse-column-widths (:column-widths ctrl))]
    (when (seq rows)
      (for [[idx row] (map-indexed vector rows)]
        (let [[bv display] (build-option-display row fields bound-col col-widths)]
          ^{:key idx} [:option {:value bv} display])))))

(defn render-combobox [ctrl field value on-change opts]
  (when-let [rs (:row-source ctrl)] (state-form/fetch-row-source! rs))
  (fn [ctrl field value on-change {:keys [allow-edits?]}]
    [:select.view-select
     {:value (str (or value "")) :disabled (not allow-edits?)
      :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}
     [:option {:value ""} ""]
     (row-source-options ctrl)]))

(defn render-line [ctrl _field _value _on-change _opts]
  [:hr.view-line
   {:style (cond-> {}
             (:border-color ctrl) (assoc :border-color (:border-color ctrl))
             (:border-width ctrl) (assoc :border-top-width (:border-width ctrl)))}])

(defn render-rectangle [ctrl _field _value _on-change _opts]
  [:div.view-rectangle
   {:style (cond-> {}
             (:back-color ctrl) (assoc :background-color (:back-color ctrl))
             (:border-color ctrl) (assoc :border-color (:border-color ctrl))
             (:border-width ctrl) (assoc :border-width (:border-width ctrl)))}])

(defn render-image [ctrl _field _value _on-change _opts]
  (if-let [src (:picture ctrl)]
    [:img.view-image {:src src :alt (or (:text ctrl) "Image")}]
    [:div.view-image-placeholder "\uD83D\uDDBC No Image"]))

(defn render-listbox [ctrl field value on-change opts]
  (when-let [rs (:row-source ctrl)] (state-form/fetch-row-source! rs))
  (fn [ctrl field value on-change {:keys [allow-edits?]}]
    [:select.view-listbox
     {:multiple true :size (or (:list-rows ctrl) 5)
      :value (str (or value "")) :disabled (not allow-edits?)
      :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}
     [:option {:value ""} ""]
     (row-source-options ctrl)]))

(defn render-option-group [ctrl field value on-change {:keys [allow-edits?]}]
  (let [options (or (:options ctrl) [])
        group-name (or (:name ctrl) (str "optgrp-" (random-uuid)))]
    [:div.view-option-group
     (if (seq options)
       (for [[idx opt] (map-indexed vector options)]
         ^{:key idx}
         [:label.view-option-item
          [:input {:type "radio" :name group-name
                   :value (or (:value opt) idx)
                   :checked (= value (or (:value opt) idx))
                   :disabled (not allow-edits?)
                   :on-change #(when (and field allow-edits?)
                                 (on-change field (or (:value opt) idx)))}]
          (or (:label opt) (str "Option " (inc idx)))])
       [:span.view-option-placeholder "(No options defined)"])]))

(defn render-option-button [ctrl field value on-change {:keys [allow-edits?]}]
  (let [opt-val (or (:option-value ctrl) (:value ctrl) 1)
        grp (or (:group-name ctrl) (:name ctrl) (str "opt-" (random-uuid)))]
    [:label.view-option-item
     [:input {:type "radio" :name grp :value opt-val
              :checked (= (str value) (str opt-val)) :disabled (not allow-edits?)
              :on-change #(when (and field allow-edits?) (on-change field opt-val))}]
     (or (:text ctrl) (:caption ctrl) "")]))

(defn render-toggle-button [ctrl field value on-change {:keys [allow-edits?]}]
  (let [pressed? (boolean value)]
    [:button.view-toggle-button
     {:class (when pressed? "pressed") :disabled (not allow-edits?)
      :on-click #(when (and field allow-edits?) (on-change field (not pressed?)))}
     (or (:text ctrl) (:caption ctrl) "Toggle")]))

;; --- Tab control ---

(defn- tab-page-caption [page-name all-controls]
  (let [pg (first (filter #(and (= :page (:type %)) (= (:name %) page-name))
                          (or all-controls [])))]
    (or (:caption pg) page-name)))

(defn render-tab-control [ctrl _field _value _on-change _opts]
  (let [active-tab (r/atom 0)]
    (fn [ctrl _field _value _on-change {:keys [all-controls current-record on-change allow-edits?]}]
      (let [page-names (or (:pages ctrl) [])
            active-page-name (nth page-names @active-tab nil)
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
               (tab-page-caption pname all-controls)])
            [:div.view-tab-header.active "Page 1"])]
         [:div.view-tab-body
          (if (seq child-controls)
            (for [[idx child] (map-indexed vector child-controls)]
              ^{:key idx}
              [form-view-control child current-record on-change
               {:allow-edits? allow-edits? :all-controls all-controls}])
            (when-not (seq page-names)
              [:span "(Empty tab control)"]))]]))))

;; --- Subform ---

(defn- subform-columns
  "Extract column definitions from child form's detail controls."
  [definition]
  (when-let [detail-ctrls (when (map? definition)
                            (get-in definition [:detail :controls]))]
    (let [bound (filter #(or (:control-source %) (:field %)) detail-ctrls)]
      (when (seq bound)
        (mapv (fn [c]
                {:field (str/lower-case (or (:control-source c) (:field c)))
                 :caption (or (:caption c) (:label c) (:control-source c) (:field c))})
              bound)))))

(defn- subform-toolbar
  "Render subform header with add/delete buttons."
  [source-form definition allow-additions? allow-deletions?
   link-child-fields link-master-fields current-record selected editing]
  [:div.view-subform-header
   {:style {:display "flex" :align-items "center"}}
   [:span (if source-form (str "Subform: " source-form) "Subform (no source)")]
   (when (and source-form (map? definition))
     [:div.subform-toolbar
      (when allow-additions?
        [:button {:title "New Record"
                  :on-click #(state-form/new-subform-record!
                               source-form link-child-fields link-master-fields current-record)}
         "+"])
      (when (and allow-deletions? @selected)
        [:button.subform-delete-btn
         {:title "Delete Record"
          :on-click #(when (js/confirm "Delete this record?")
                       (state-form/delete-subform-record! source-form (:row @selected))
                       (reset! selected nil)
                       (reset! editing nil))}
         "\u2715"])])])

(defn- subform-cell
  "Render a single cell in the subform datasheet."
  [rec idx col-field selected editing edit-value allow-edits? commit-edit!]
  (let [is-selected? (and @selected (= (:row @selected) idx) (= (:col @selected) col-field))
        is-editing? (and @editing (= (:row @editing) idx) (= (:col @editing) col-field))]
    [:td {:class (str (when is-selected? "selected ") (when is-editing? "editing"))
          :on-click (fn [e]
                      (.stopPropagation e)
                      (when-not is-editing? (commit-edit!) (reset! selected {:row idx :col col-field})))
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
        {:type "text" :auto-focus true :value @edit-value
         :on-change #(reset! edit-value (.. % -target -value))
         :on-blur #(commit-edit!)
         :on-key-down (fn [e]
                        (case (.-key e)
                          "Enter" (commit-edit!)
                          "Escape" (reset! editing nil)
                          nil))}]
       (str (or (get rec (keyword col-field)) (get rec col-field) "")))]))

(defn- subform-table
  "Render the datasheet table for a subform."
  [cols records selected editing edit-value allow-edits? commit-edit!]
  (when (seq cols)
    [:table.subform-table
     [:thead
      [:tr (for [[i col] (map-indexed vector cols)]
             ^{:key i} [:th (:caption col)])]]
     [:tbody
      (for [[idx rec] (map-indexed vector records)]
        ^{:key idx}
        [:tr (for [[ci col] (map-indexed vector cols)]
               ^{:key ci}
               [subform-cell rec idx (:field col) selected editing edit-value allow-edits? commit-edit!])])]]))

(defn- subform-status-view
  "Render the loading/error/empty status for a subform."
  [definition records allow-additions?]
  (cond
    (= definition :loading)
    [:div.subform-datasheet [:span.subform-loading "Loading..."]]
    (:error definition)
    [:div.subform-datasheet [:span.subform-loading "Error loading subform"]]
    (= records :loading)
    [:div.subform-datasheet [:span.subform-loading "Loading records..."]]
    (and (vector? records) (empty? records) (not allow-additions?))
    [:div.subform-datasheet [:span.subform-loading "(No records)"]]
    :else nil))

(defn- subform-definition-props
  "Extract permission flags and record source from a subform definition."
  [definition]
  {:allow-edits?     (when (map? definition) (not= 0 (get definition :allow-edits 1)))
   :allow-additions? (when (map? definition) (not= 0 (get definition :allow-additions 1)))
   :allow-deletions? (when (map? definition) (not= 0 (get definition :allow-deletions 1)))
   :child-rs         (when (map? definition)
                       (or (:record-source definition) (:record_source definition)))})

(defn- subform-records-view
  "Render records grid or status for a subform."
  [definition records columns allow-additions? allow-edits? selected editing edit-value commit-edit!]
  (or (subform-status-view definition records allow-additions?)
      (when (and (vector? records) (or (seq records) allow-additions?))
        (let [cols (or columns
                       (when (seq records)
                         (mapv (fn [k] {:field (name k) :caption (name k)})
                               (keys (first records))))
                       [])]
          [:div.subform-datasheet
           [subform-table cols records selected editing edit-value allow-edits? commit-edit!]]))
      [:div.subform-datasheet [:span.subform-loading "Loading..."]]))

(defn render-subform [ctrl _field _value _on-change _opts]
  (let [source-form (or (:source-form ctrl) (:source_form ctrl))
        selected (r/atom nil)
        editing (r/atom nil)
        edit-value (r/atom "")]
    (when source-form (state-form/fetch-subform-definition! source-form))
    (fn [ctrl _field _value _on-change _opts]
      (let [source-form (or (:source-form ctrl) (:source_form ctrl))
            link-child (or (:link-child-fields ctrl) (:link_child_fields ctrl))
            link-master (or (:link-master-fields ctrl) (:link_master_fields ctrl))
            current-record (or (get-in @state/app-state [:form-editor :current-record]) {})
            definition (when source-form
                         (get-in @state/app-state [:form-editor :subform-cache source-form :definition]))
            {:keys [allow-edits? allow-additions? allow-deletions? child-rs]}
            (subform-definition-props definition)
            _ (when (and source-form child-rs (seq link-child) (seq link-master))
                (state-form/fetch-subform-records! source-form child-rs link-child link-master current-record))
            records (when source-form
                      (get-in @state/app-state [:form-editor :subform-cache source-form :records]))
            commit-edit! (fn []
                           (when-let [{:keys [row col]} @editing]
                             (let [old-val (str (or (get (nth records row) (keyword col))
                                                    (get (nth records row) col) ""))
                                   new-val @edit-value]
                               (when (not= old-val new-val)
                                 (state-form/save-subform-cell! source-form row col new-val)))
                             (reset! editing nil)))]
        [:div.view-subform
         [subform-toolbar source-form definition allow-additions? allow-deletions?
          link-child link-master current-record selected editing]
         (when source-form
           [subform-records-view definition records (subform-columns definition)
            allow-additions? allow-edits? selected editing edit-value commit-edit!])]))))

(defn render-default [ctrl _field _value _on-change _opts]
  [:span (fu/display-text ctrl)])

;; ============================================================
;; CONTROL DISPATCH
;; ============================================================

(def control-renderers
  {:label render-label, :text-box render-textbox, :button render-button
   :check-box render-checkbox, :combo-box render-combobox, :line render-line
   :rectangle render-rectangle, :image render-image, :object-frame render-image, :list-box render-listbox
   :option-group render-option-group, :option-button render-option-button
   :toggle-button render-toggle-button, :tab-control render-tab-control
   :subform render-subform})

(defn form-view-control
  "Render a single control in view mode"
  [ctrl current-record on-change & [{:keys [auto-focus? allow-edits? all-controls]}]]
  (let [ctrl-type (:type ctrl)
        field (fu/resolve-control-field ctrl)
        value (fu/resolve-field-value field current-record nil ctrl)
        renderer (get control-renderers ctrl-type render-default)
        base-style (fu/control-style ctrl)
        cf-style (expr/apply-conditional-formatting ctrl current-record nil)
        style (if cf-style (merge base-style cf-style) base-style)]
    [:div.view-control
     {:style style :on-context-menu show-record-menu}
     [renderer ctrl field value on-change
      {:auto-focus? auto-focus? :is-new? (:__new__ current-record)
       :allow-edits? allow-edits? :all-controls all-controls
       :current-record current-record :on-change on-change}]]))

;; ============================================================
;; RECORD CONTEXT MENU
;; ============================================================

(defn show-record-menu [e]
  (.preventDefault e)
  (state-form/show-form-context-menu! (.-clientX e) (.-clientY e)))

(defn- context-menu-item
  "Render a single context menu item with enabled/disabled logic."
  [label enabled? on-click & [class]]
  [:div.menu-item
   {:class (str (when class (str class " ")) (when-not enabled? "disabled"))
    :on-click #(when enabled? (on-click) (state-form/hide-form-context-menu!))}
   label])

(defn form-record-context-menu []
  (let [menu (get-in @state/app-state [:form-editor :context-menu])
        has-clip? (some? @state-form/form-clipboard)
        can-edit? (not= 0 (get-in @state/app-state [:form-editor :current :allow-edits]))
        can-add? (not= 0 (get-in @state/app-state [:form-editor :current :allow-additions]))
        can-del? (not= 0 (get-in @state/app-state [:form-editor :current :allow-deletions]))
        has-rec? (> (get-in @state/app-state [:form-editor :record-position :total] 0) 0)]
    (when (:visible menu)
      [:div.context-menu
       {:style {:left (:x menu) :top (:y menu)}
        :on-mouse-leave #(state-form/hide-form-context-menu!)}
       [context-menu-item "Cut" (and has-rec? can-edit? can-del?) state-form/cut-form-record!]
       [context-menu-item "Copy" has-rec? state-form/copy-form-record!]
       [context-menu-item "Paste" (and has-clip? can-add?) state-form/paste-form-record!]
       [:div.menu-divider]
       [context-menu-item "New Record" can-add? state-form/new-record!]
       [context-menu-item "Delete Record" (and has-rec? can-del?)
        #(when (js/confirm "Delete this record?") (state-form/delete-current-record!)) "danger"]])))

;; ============================================================
;; RECORD SELECTOR & SECTIONS
;; ============================================================

(defn record-selector [selected? new-record?]
  [:div.record-selector
   {:class [(when selected? "current") (when new-record? "new-record")]
    :on-context-menu show-record-menu}
   (cond (and selected? new-record?) "\u25B6*"
         selected? "\u25B6"
         new-record? "*"
         :else "\u00A0")])

(defn form-view-section
  "Render a section in view mode"
  [section form-def current-record on-field-change & [{:keys [show-selectors? allow-edits?]}]]
  (let [height (fu/get-section-height form-def section)
        all-controls (fu/get-section-controls form-def section)
        controls (remove #(or (:parent-page %) (= :page (:type %))) all-controls)]
    (when (seq all-controls)
      (if (and show-selectors? (= section :detail))
        [:div.single-form-row
         [record-selector true false]
         [:div.view-section {:class (name section) :style {:height height :flex 1}}
          [:div.view-controls-container
           (for [[idx ctrl] (map-indexed vector controls)]
             ^{:key idx}
             [form-view-control ctrl current-record on-field-change
              {:allow-edits? allow-edits? :all-controls all-controls}])]]]
        [:div.view-section {:class (name section) :style {:height height}}
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
        controls (vec (remove #(or (:parent-page %) (= :page (:type %))) all-controls))
        first-tb (first (keep-indexed (fn [i c] (when (= (:type c) :text-box) i)) controls))]
    [:div.view-section.detail.continuous-row
     {:class (when selected? "selected") :style {:height height} :on-click #(on-select idx)}
     (when show-selectors? [record-selector selected? (:__new__ record)])
     [:div.view-controls-container
      (for [[ci ctrl] (map-indexed vector controls)]
        ^{:key ci}
        [form-view-control ctrl record on-field-change
         {:auto-focus? (and selected? (= ci first-tb))
          :allow-edits? allow-edits? :all-controls all-controls}])]]))

(defn tentative-new-row [form-def show-selectors?]
  [:div.view-section.detail.continuous-row.tentative-row
   {:style {:height (fu/get-section-height form-def :detail)}
    :on-click #(state-form/new-record!)}
   (when show-selectors? [record-selector false true])
   [:div.view-controls-container]])

;; ============================================================
;; FORM VIEW — MAIN COMPONENT (broken into sub-components)
;; ============================================================

(defn- form-canvas-header [continuous? record-source]
  [:div.canvas-header
   {:on-context-menu (fn [e]
                       (.preventDefault e)
                       (.stopPropagation e)
                       (state/show-context-menu! (.-clientX e) (.-clientY e)))}
   [:span "Form View"]
   (when continuous? [:span.view-type-badge " (Continuous)"])
   (when-not record-source [:span.no-source-warning " (No record source selected)"])])

(defn- nav-btn [title disabled? on-click label]
  [:button.nav-btn {:title title :disabled disabled? :on-click on-click} label])

(defn- record-nav-bar
  "The record navigation bar at the bottom of the form."
  [record-pos allow-additions? allow-deletions? record-dirty?]
  (let [cur (:current record-pos)
        total (:total record-pos)
        no-recs? (< total 1)
        at-first? (<= cur 1)
        at-last? (>= cur total)]
    [:div.record-nav-bar
     [:span.nav-label "Record:"]
     [nav-btn "First" (or no-recs? at-first?) #(state-form/navigate-to-record! 1) "|◀"]
     [nav-btn "Previous" (or no-recs? at-first?) #(state-form/navigate-to-record! (dec cur)) "◀"]
     [:span.record-counter (if (pos? total) (str cur " of " total) "0 of 0")]
     [nav-btn "Next" (or no-recs? at-last?) #(state-form/navigate-to-record! (inc cur)) "▶"]
     [nav-btn "Last" (or no-recs? at-last?) #(state-form/navigate-to-record! total) "▶|"]
     [nav-btn "New Record" (not allow-additions?) state-form/new-record! "▶*"]
     [:button.nav-btn.delete-btn
      {:title "Delete Record" :disabled (or no-recs? (not allow-deletions?))
       :on-click #(when (js/confirm "Delete this record?") (state-form/delete-current-record!))} "✕"]
     [:span.nav-separator]
     [:button.nav-btn.save-btn
      {:title "Save Record" :class (when record-dirty? "dirty")
       :disabled (not record-dirty?) :on-click state-form/save-current-record!}
      "Save"]]))

(defn- canvas-context-menu
  "Right-click context menu on the canvas header (Save/Close/View switching)."
  []
  (let [ctx-menu (:context-menu @state/app-state)]
    (when (:visible? ctx-menu)
      (let [dismiss-and (fn [action]
                          (fn [e] (.stopPropagation e) (state/hide-context-menu!) (action)))]
        [:div.context-menu
         {:style {:left (:x ctx-menu) :top (:y ctx-menu)}}
         [:div.context-menu-item {:on-click (dismiss-and state-form/save-current-record!)} "Save"]
         [:div.context-menu-item {:on-click (dismiss-and state-form/close-current-tab!)} "Close"]
         [:div.context-menu-item {:on-click (dismiss-and state-form/close-all-tabs!)} "Close All"]
         [:div.context-menu-separator]
         [:div.context-menu-item
          {:class (when (= (state-form/get-view-mode) :view) "active")
           :on-click (dismiss-and #(state-form/set-view-mode! :view))} "Form View"]
         [:div.context-menu-item
          {:class (when (= (state-form/get-view-mode) :design) "active")
           :on-click (dismiss-and #(state-form/set-view-mode! :design))} "Design View"]]))))

(defn- continuous-form-body
  "Render the continuous form body with header, scrolling detail rows, and footer."
  [current current-record all-records record-pos on-field-change on-select-record opts]
  (let [{:keys [show-selectors? allow-edits? allow-additions? dividing-lines? form-width]} opts]
    [:div.view-sections-container.continuous
     {:class (when-not dividing-lines? "no-dividing-lines")
      :style (when form-width {:max-width form-width})}
     [form-view-section :header current current-record on-field-change {:allow-edits? allow-edits?}]
     [:div.continuous-records-container
      (for [[idx record] (map-indexed vector all-records)]
        (let [sel? (= (inc idx) (:current record-pos))
              disp (if sel? current-record record)]
          ^{:key (or (:id record) idx)}
          [form-view-detail-row idx disp current sel? on-select-record on-field-change
           {:show-selectors? show-selectors? :allow-edits? allow-edits?}]))
      (when (and allow-additions? (not (some :__new__ all-records)))
        [tentative-new-row current show-selectors?])]
     [form-view-section :footer current current-record on-field-change {:allow-edits? allow-edits?}]]))

(defn- single-form-body
  "Render the single-form body with header, detail, and footer."
  [current current-record on-field-change opts]
  (let [{:keys [show-selectors? allow-edits? form-width]} opts]
    [:div.view-sections-container
     {:style (when form-width {:max-width form-width})}
     [form-view-section :header current current-record on-field-change {:allow-edits? allow-edits?}]
     [form-view-section :detail current current-record on-field-change
      {:show-selectors? show-selectors? :allow-edits? allow-edits?}]
     [form-view-section :footer current current-record on-field-change {:allow-edits? allow-edits?}]]))

(defn- form-view-opts [current]
  {:show-selectors?  (not= 0 (:record-selectors current))
   :allow-edits?     (not= 0 (:allow-edits current))
   :allow-additions? (not= 0 (:allow-additions current))
   :allow-deletions? (not= 0 (:allow-deletions current))
   :dividing-lines?  (not= 0 (:dividing-lines current))
   :form-width       (or (:width current) (:form-width current))})

(defn- no-records-message [record-source current]
  (cond (not record-source) "Select a record source in Design View"
        (or (seq (fu/get-section-controls current :header))
            (seq (fu/get-section-controls current :detail))
            (seq (fu/get-section-controls current :footer))) "No records found"
        :else "Add controls in Design View"))

(defn form-view
  "The form in view/data entry mode"
  []
  (let [fe (:form-editor @state/app-state)
        current (:current fe)
        current-record (or (:current-record fe) {})
        all-records (or (:records fe) [])
        record-pos (or (:record-position fe) {:current 0 :total 0})
        record-source (:record-source current)
        continuous? (= (or (:default-view current) "Single Form") "Continuous Forms")
        on-change (fn [field value] (state-form/update-record-field! field value))
        on-select (fn [idx] (state-form/navigate-to-record! (inc idx)))
        opts (form-view-opts current)
        scroll-bars (or (:scroll-bars current) :both)
        has-data? (and record-source
                       (or (pos? (:total record-pos))
                           (and continuous? (:allow-additions? opts))))]
    [:div.form-canvas.view-mode
     {:style (when-let [bc (:back-color current)] {:background-color bc})
      :on-click #(do (state-form/hide-form-context-menu!) (state/hide-context-menu!))}
     [form-canvas-header continuous? record-source]
     [:div.canvas-body.view-mode-body
      {:style (cond-> {}
                (#{:neither :vertical} scroll-bars) (assoc :overflow-x "hidden")
                (#{:neither :horizontal} scroll-bars) (assoc :overflow-y "hidden"))}
      (if has-data?
        (if continuous?
          [continuous-form-body current current-record all-records record-pos on-change on-select opts]
          [single-form-body current current-record on-change opts])
        [:div.no-records (no-records-message record-source current)])]
     (when-not (= 0 (:navigation-buttons current))
       [record-nav-bar record-pos (:allow-additions? opts) (:allow-deletions? opts) (:record-dirty? fe)])
     [form-record-context-menu]
     [canvas-context-menu]]))
