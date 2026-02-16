(ns app.views.table-viewer
  "Table viewer - datasheet and design views"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.state-table :as state-table]
            [app.flows.core :as f]
            [app.flows.table :as table-flow]))

;; ============================================================
;; TYPE MAPPING CONSTANTS
;; ============================================================

(def data-type-options
  ["Short Text" "Long Text" "Number" "Yes/No" "Date/Time" "Currency" "AutoNumber"])

(def pg-type->display
  {"character varying" "Short Text"
   "text"              "Long Text"
   "integer"           "Number"
   "smallint"          "Number"
   "bigint"            "Number"
   "real"              "Number"
   "double precision"  "Number"
   "numeric"           "Number"
   "boolean"           "Yes/No"
   "timestamp without time zone" "Date/Time"
   "date"              "Date/Time"
   "serial"            "AutoNumber"})

(def number-field-sizes
  ["Byte" "Integer" "Long Integer" "Single" "Double" "Decimal"])

;; ============================================================
;; DESIGN VIEW - Access-style split: column grid + property sheet
;; ============================================================

(defn field-size-display
  "Compute a display string for Field Size from column metadata"
  [field]
  (cond
    (:maxLength field) (str (:maxLength field))
    (:precision field) (str (:precision field))
    :else              ""))

(defn indexed-display
  "Convert indexed value to Access-style display"
  [field]
  (case (:indexed field)
    "unique" "Yes (No Duplicates)"
    "yes"    "Yes (Duplicates OK)"
    "No"))

(defn display-type
  "Get display type name for a field"
  [field]
  (let [raw-type (:type field)]
    (or (pg-type->display raw-type)
        ;; Check if it's already a display name
        (when (some #{raw-type} data-type-options) raw-type)
        raw-type)))

;; ============================================================
;; EDITABLE PROPERTY SHEET (lower pane)
;; ============================================================

(defn property-row
  "A single read-only property row"
  [label value & [na?]]
  [:div.field-property-row
   [:div.field-property-label label]
   [:div.field-property-value {:class (when na? "property-na")}
    (if na? "(N/A)" (or value ""))]])

(defn editable-property-row
  "A property row with an editable input"
  [label value on-change & [{:keys [type options disabled]}]]
  [:div.field-property-row
   [:div.field-property-label label]
   [:div.field-property-value
    (cond
      options
      [:select.design-prop-select
       {:value (or value "")
        :disabled disabled
        :on-change #(on-change (.. % -target -value))}
       (for [opt options]
         ^{:key opt}
         [:option {:value opt} opt])]

      (= type :number)
      [:input.design-prop-input
       {:type "number"
        :value (or value "")
        :disabled disabled
        :on-change #(let [v (.. % -target -value)]
                      (on-change (when (not= "" v) (js/parseInt v 10))))}]

      :else
      [:input.design-prop-input
       {:type "text"
        :value (or value "")
        :disabled disabled
        :on-change #(on-change (.. % -target -value))}])]])

(defn- field-size-property
  "Render the field size property row based on type."
  [field-idx field field-type]
  (cond
    (or (= field-type "Short Text") (= (:type field) "character varying"))
    [editable-property-row "Field Size"
     (or (:maxLength field) 255)
     #(t/dispatch! :update-design-field field-idx :maxLength %)
     {:type :number}]
    (= field-type "Number")
    [editable-property-row "Field Size"
     (or (:fieldSize field) "Long Integer")
     #(t/dispatch! :update-design-field field-idx :fieldSize %)
     {:options number-field-sizes}]
    :else
    [property-row "Field Size" (field-size-display field)]))

(defn- column-data-properties
  "Render data properties (caption, default, validation, required, indexed)."
  [field-idx field]
  [:<>
   [editable-property-row "Caption" (:description field)
    #(t/dispatch! :update-design-field field-idx :description %)]
   [editable-property-row "Default Value" (:default field)
    #(t/dispatch! :update-design-field field-idx :default %)]
   [property-row "Validation Rule" (:checkConstraint field)]
   [property-row "Validation Text" nil true]
   [editable-property-row "Required" (if (:nullable field) "No" "Yes")
    #(t/dispatch! :update-design-field field-idx :nullable (= % "No"))
    {:options ["No" "Yes"]}]
   [property-row "Allow Zero Length" nil true]
   [editable-property-row "Indexed" (indexed-display field)
    #(t/dispatch! :update-design-field field-idx :indexed
       (case % "Yes (Duplicates OK)" "yes" "Yes (No Duplicates)" "unique" nil))
    {:options ["No" "Yes (Duplicates OK)" "Yes (No Duplicates)"]}]])

(defn editable-column-properties
  "Editable property sheet for a selected field in design mode"
  [field-idx field]
  [:div.field-properties
   [:div.field-properties-header "Field Properties"]
   [:div.field-properties-tab "General"]
   [:div.field-properties-body
    [field-size-property field-idx field (display-type field)]
    [property-row "New Values" nil true]
    [property-row "Format" nil true]
    [property-row "Input Mask" nil true]
    [column-data-properties field-idx field]
    [property-row "Primary Key" (if (:isPrimaryKey field) "Yes" "No")]
    (when (:isForeignKey field)
      [property-row "Foreign Key" (str "-> " (:foreignTable field))])
    [property-row "Unicode Compression" nil true]
    [property-row "IME Mode" nil true]
    [property-row "Text Align" nil true]]])

(defn editable-table-properties
  "Editable property sheet for table-level info"
  [fields]
  (let [description (get-in @state/app-state [:table-viewer :table-description])]
    [:div.field-properties
     [:div.field-properties-header "Table Properties"]
     [:div.field-properties-tab "General"]
     [:div.field-properties-body
      [editable-property-row "Description"
       description
       #(t/dispatch! :update-table-description %)]
      [property-row "Primary Key"
       (or (:name (first (filter :isPrimaryKey fields))) "")]
      [property-row "Column Count" (str (count fields))]]]))

;; ============================================================
;; EDITABLE UPPER GRID
;; ============================================================

(defn- design-field-input
  "Inline text input for design grid cell."
  [idx prop value placeholder]
  [:input.design-field-input
   {:type "text" :value (or value "") :placeholder (or placeholder "")
    :on-click #(do (.stopPropagation %) (t/dispatch! :select-design-field idx))
    :on-change #(t/dispatch! :update-design-field idx prop (.. % -target -value))}])

(defn- design-type-select
  "Type dropdown for design grid."
  [idx field]
  (let [dt (display-type field)]
    [:select.design-type-select
     {:value dt :on-click #(.stopPropagation %)
      :on-change #(t/dispatch! :update-design-field idx :type (.. % -target -value))}
     (for [t data-type-options] ^{:key t} [:option {:value t} t])
     (when-not (some #{dt} data-type-options)
       [:option {:value (:type field)} (:type field)])]))

(defn editable-column-row
  "Editable row in the design grid"
  [idx field selected?]
  [:tr {:class (str (when (:isPrimaryKey field) "pk-row ")
                    (when selected? "selected-field"))
        :on-click #(t/dispatch! :select-design-field idx)}
   [:td.col-name
    (when (:isPrimaryKey field) [:span.pk-icon {:title "Primary Key"} "\uD83D\uDD11"])
    (when (:isForeignKey field) [:span.fk-icon {:title (str "Foreign Key to " (:foreignTable field))} "\uD83D\uDD17"])
    [design-field-input idx :name (:name field) "Field Name"]]
   [:td.col-type [design-type-select idx field]]
   [:td.col-description [design-field-input idx :description (:description field) ""]]
   [:td.col-actions
    [:button.delete-field-btn
     {:title "Delete field"
      :on-click #(do (.stopPropagation %)
                     (when (js/confirm (str "Delete field \"" (:name field) "\"?"))
                       (t/dispatch! :remove-design-field idx)))}
     "\u00D7"]]])

(defn new-field-ghost-row
  "Ghost row at bottom for adding new fields"
  []
  [:tr.new-field-row
   [:td.col-name
    [:input.design-field-input
     {:type "text"
      :value ""
      :placeholder "Click to add..."
      :on-focus #(do (t/dispatch! :add-design-field)
                     ;; The new row component will render, so blur this ghost
                     (.. % -target blur))}]]
   [:td.col-type ""]
   [:td.col-description ""]
   [:td.col-actions ""]])

;; ============================================================
;; DESIGN VIEW
;; ============================================================

(defn design-errors-panel
  "Error message panel"
  [errors]
  (when (seq errors)
    [:div.design-errors
     (for [[i err] (map-indexed vector errors)]
       ^{:key i}
       [:div.design-error (:message err)])]))

(defn new-table-name-bar
  "Input bar for naming a new table"
  []
  (let [name (get-in @state/app-state [:table-viewer :new-table-name])]
    [:div.new-table-name-bar
     [:label "Table Name: "]
     [:input.design-field-input
      {:type "text"
       :value (or name "")
       :placeholder "my_table_name"
       :auto-focus true
       :on-change #(t/dispatch! :set-new-table-name (.. % -target -value))}]]))

(defn- design-column-grid
  "Upper pane column grid for design view."
  [fields selected-idx]
  [:div.design-upper-pane
   [:table.structure-table
    [:thead
     [:tr [:th "Field Name"] [:th "Data Type"] [:th "Description"] [:th.col-actions-header ""]]]
    [:tbody
     (if (seq fields)
       (map-indexed (fn [idx field]
                      ^{:key idx}
                      [editable-column-row idx field (= idx selected-idx)])
                    fields)
       [:tr [:td {:col-span 4} "No columns \u2014 click below to add"]])
     [new-field-ghost-row]]]])

(defn design-view
  "Design view showing table structure with editable property sheet"
  []
  (let [table-info (get-in @state/app-state [:table-viewer :table-info])
        _ (when (and (nil? (get-in @state/app-state [:table-viewer :design-fields])) table-info)
            (t/dispatch! :init-design-editing))
        fields (get-in @state/app-state [:table-viewer :design-fields] [])
        selected-idx (get-in @state/app-state [:table-viewer :selected-field])
        selected-field (when (number? selected-idx) (get fields selected-idx))]
    [:div.table-design-view
     (when (get-in @state/app-state [:table-viewer :new-table?]) [new-table-name-bar])
     [design-errors-panel (get-in @state/app-state [:table-viewer :design-errors])]
     [design-column-grid fields selected-idx]
     [:div.design-lower-pane
      (if selected-field
        [editable-column-properties selected-idx selected-field]
        [editable-table-properties fields])]]))

;; ============================================================
;; CONTEXT MENU
;; ============================================================

(defn- menu-action [label action-fn & [class]]
  [(if class :div.menu-item.danger :div.menu-item)
   {:on-click #(do (action-fn) (t/dispatch! :hide-table-context-menu))}
   label])

(defn context-menu
  "Right-click context menu for datasheet"
  []
  (let [menu (get-in @state/app-state [:table-viewer :context-menu])]
    (when (:visible menu)
      [:div.context-menu
       {:style {:left (:x menu) :top (:y menu)}
        :on-mouse-leave #(t/dispatch! :hide-table-context-menu)}
       [menu-action "New Record" #(f/run-fire-and-forget! table-flow/new-table-record-flow)]
       [:div.menu-divider]
       [menu-action "Cut" #(f/run-fire-and-forget! table-flow/cut-table-cell-flow)]
       [menu-action "Copy" #(f/run-fire-and-forget! table-flow/copy-table-cell-flow)]
       [menu-action "Paste" #(f/run-fire-and-forget! table-flow/paste-table-cell-flow)]
       [:div.menu-divider]
       [menu-action "Delete Record"
        #(when (js/confirm "Delete this record?") (f/run-fire-and-forget! table-flow/delete-table-record-flow))
        :danger]])))

;; ============================================================
;; DATASHEET VIEW - Editable grid of data
;; ============================================================

(defn- cell-key-handler
  "Handle keyboard events in an editing cell."
  [e]
  (case (.-key e)
    "Enter" (do (f/run-fire-and-forget! table-flow/save-table-cell-flow {:new-value (.. e -target -value)})
                (t/dispatch! :stop-editing-cell))
    "Escape" (t/dispatch! :stop-editing-cell)
    "Tab" (do (.preventDefault e)
              (f/run-fire-and-forget! table-flow/save-table-cell-flow {:new-value (.. e -target -value)})
              (t/dispatch! :stop-editing-cell)
              (t/dispatch! :move-to-next-cell (.-shiftKey e)))
    nil))

(defn- editing-cell-input
  "Render an input for an actively editing cell."
  [value]
  [:td.editing
   [:input.cell-input
    {:type "text" :auto-focus true
     :default-value (if (nil? value) "" (str value))
     :on-blur #(do (f/run-fire-and-forget! table-flow/save-table-cell-flow {:new-value (.. % -target -value)})
                   (t/dispatch! :stop-editing-cell))
     :on-key-down cell-key-handler}]])

(defn- display-cell
  "Render a read-only cell with selection and context menu support."
  [row-idx col-name value is-selected]
  (let [display-value (cond (nil? value) "" (boolean? value) (if value "Yes" "No") :else (str value))]
    [:td {:class (str (when (nil? value) "null-value ") (when is-selected "selected"))
          :on-click #(t/dispatch! :select-table-cell row-idx col-name)
          :on-double-click #(t/dispatch! :start-editing-cell row-idx col-name)
          :on-context-menu (fn [e]
                             (.preventDefault e)
                             (t/dispatch! :select-table-cell row-idx col-name)
                             (t/dispatch! :show-table-context-menu (.-clientX e) (.-clientY e)))}
     display-value]))

(defn editable-cell
  "A cell that can be edited on double-click"
  [row-idx col-name value col-type]
  (fn [row-idx col-name value col-type]
    (let [editing? (get-in @state/app-state [:table-viewer :editing])
          is-editing (and editing? (= (:row editing?) row-idx) (= (:col editing?) col-name))
          selected (get-in @state/app-state [:table-viewer :selected])
          is-selected (and selected (= (:row selected) row-idx) (= (:col selected) col-name))]
      (if is-editing
        [editing-cell-input value]
        [display-cell row-idx col-name value is-selected]))))

(defn data-row
  "Single row in the datasheet"
  [record fields row-idx]
  (let [selected-row (get-in @state/app-state [:table-viewer :selected :row])]
    [:tr {:class (str (if (even? row-idx) "even-row " "odd-row ")
                      (when (= selected-row row-idx) "selected-row"))}
     [:td.row-number
      {:on-context-menu (fn [e]
                          (.preventDefault e)
                          (t/dispatch! :select-table-row row-idx)
                          (t/dispatch! :show-table-context-menu (.-clientX e) (.-clientY e)))}
      (inc row-idx)]
     (for [{:keys [name type]} fields]
       ^{:key name}
       [editable-cell row-idx name (get record (keyword name)) type])]))

(defn- datasheet-table
  "Render the data table with header and rows."
  [fields records]
  [:div.datasheet-container
   [:table.datasheet
    [:thead
     [:tr [:th.row-header "#"]
      (for [{:keys [name]} fields]
        ^{:key name} [:th name])]]
    [:tbody
     (if (seq records)
       (map-indexed (fn [idx record] ^{:key idx} [data-row record fields idx]) records)
       [:tr [:td {:col-span (inc (count fields))} "No records"]])]]])

(defn datasheet-view
  "Datasheet view showing table data with editing"
  []
  (let [fields (:fields (get-in @state/app-state [:table-viewer :table-info]))
        records (get-in @state/app-state [:table-viewer :records] [])
        loading? (get-in @state/app-state [:table-viewer :loading?])]
    [:div.table-datasheet-view
     {:on-click #(when (= (.-target %) (.-currentTarget %))
                   (t/dispatch! :hide-table-context-menu))}
     (cond loading? [:div.loading-data "Loading data..."]
           (empty? fields) [:div.no-columns "No columns defined"]
           :else [datasheet-table fields records])
     [context-menu]
     [:div.record-count
      (str (count records) " record" (when (not= 1 (count records)) "s"))
      " \u00B7 Double-click to edit \u00B7 Right-click for menu"]]))

;; ============================================================
;; TOOLBAR
;; ============================================================

(defn- toolbar-view-toggle
  "View mode toggle buttons (Design / Datasheet)."
  [view-mode new-table?]
  (when-not new-table?
    [:<>
     [:button.toolbar-btn
      {:class (when (= view-mode :design) "active")
       :on-click #(f/run-fire-and-forget! (table-flow/set-table-view-mode-flow) {:mode :design})} "Design"]
     [:button.toolbar-btn
      {:class (when (= view-mode :datasheet) "active")
       :on-click #(f/run-fire-and-forget! (table-flow/set-table-view-mode-flow) {:mode :datasheet})} "Datasheet"]]))

(defn- toolbar-design-actions
  "Design mode field actions (PK toggle, delete)."
  [selected-idx]
  [:<>
   [:button.toolbar-btn
    {:title "Toggle Primary Key"
     :on-click #(t/dispatch! :toggle-design-pk selected-idx)} "PK"]
   [:button.toolbar-btn
    {:title "Delete Field"
     :on-click #(when (js/confirm "Delete this field?")
                  (t/dispatch! :remove-design-field selected-idx))} "Delete Field"]])

(defn- toolbar-right-buttons
  "Right side toolbar buttons based on view mode."
  [view-mode dirty? new-table?]
  (case view-mode
    :design [:<>
             [:button.secondary-btn {:disabled (not dirty?) :on-click #(t/dispatch! :revert-design)} "Undo All"]
             [:button.primary-btn {:disabled (not dirty?)
                                   :on-click #(if new-table?
                                                (f/run-fire-and-forget! table-flow/save-new-table-flow)
                                                (f/run-fire-and-forget! table-flow/save-table-design-flow))} "Save"]]
    :datasheet [:<>
                [:button.primary-btn {:on-click #(f/run-fire-and-forget! table-flow/new-table-record-flow)} "+ New"]
                [:button.secondary-btn {:on-click #(f/run-fire-and-forget! table-flow/refresh-table-data-flow)} "Refresh"]]
    nil))

(defn table-toolbar
  "Toolbar with view toggle, design actions, and new record button"
  []
  (let [view-mode (get-in @state/app-state [:table-viewer :view-mode] :datasheet)
        dirty? (get-in @state/app-state [:table-viewer :design-dirty?])
        new-table? (get-in @state/app-state [:table-viewer :new-table?])
        selected-idx (get-in @state/app-state [:table-viewer :selected-field])]
    [:div.table-toolbar
     [:div.toolbar-left
      [toolbar-view-toggle view-mode new-table?]
      (when (and (= view-mode :design) (number? selected-idx))
        [toolbar-design-actions selected-idx])]
     [:div.toolbar-right
      [toolbar-right-buttons view-mode dirty? new-table?]]]))

;; ============================================================
;; MAIN COMPONENT
;; ============================================================

(defn table-viewer
  "Main table viewer component"
  []
  (let [active-tab (:active-tab @state/app-state)
        current-table-id (get-in @state/app-state [:table-viewer :table-id])
        new-table? (get-in @state/app-state [:table-viewer :new-table?])
        view-mode (get-in @state/app-state [:table-viewer :view-mode] :datasheet)]
    (when (and active-tab (= (:type active-tab) :tables))
      ;; Load table when tab changes (but not for new table)
      (when-not new-table?
        (let [table (first (filter #(= (:id %) (:id active-tab))
                                   (get-in @state/app-state [:objects :tables])))]
          (when (and table (not= (:id table) current-table-id))
            (f/run-fire-and-forget! (table-flow/load-table-for-viewing-flow) {:table table}))))
      [:div.table-viewer
       [table-toolbar]
       (case view-mode
         :design [design-view]
         :datasheet [datasheet-view]
         [datasheet-view])])))
