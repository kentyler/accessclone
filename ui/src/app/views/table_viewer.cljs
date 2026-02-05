(ns app.views.table-viewer
  "Table viewer - datasheet and design views"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.state-table :as state-table]))

;; ============================================================
;; DESIGN VIEW - Show table structure (columns, types, constraints)
;; ============================================================

(defn column-row
  "Single row in the design view showing column info"
  [{:keys [name type pk fk nullable default]}]
  [:tr {:class (when pk "pk-row")}
   [:td.col-name
    (when pk [:span.pk-icon {:title "Primary Key"} "🔑"])
    (when fk [:span.fk-icon {:title (str "Foreign Key to " fk)} "🔗"])
    name]
   [:td.col-type type]
   [:td.col-nullable (if nullable "Yes" "No")]
   [:td.col-default (or default "")]])

(defn design-view
  "Design view showing table structure"
  []
  (let [table-info (get-in @state/app-state [:table-viewer :table-info])
        fields (:fields table-info)]
    [:div.table-design-view
     [:div.design-grid
      [:table.structure-table
       [:thead
        [:tr
         [:th "Column Name"]
         [:th "Data Type"]
         [:th "Nullable"]
         [:th "Default"]]]
       [:tbody
        (if (seq fields)
          (for [field fields]
            ^{:key (:name field)}
            [column-row field])
          [:tr [:td {:col-span 4} "No columns found"]])]]]

     ;; Summary info
     (when table-info
       [:div.table-summary
        [:div.summary-item
         [:span.label "Table:"]
         [:span.value (:name table-info)]]
        [:div.summary-item
         [:span.label "Columns:"]
         [:span.value (count fields)]]
        (when-let [pk-col (first (filter :pk fields))]
          [:div.summary-item
           [:span.label "Primary Key:"]
           [:span.value (:name pk-col)]])])]))

;; ============================================================
;; CONTEXT MENU
;; ============================================================

(defn context-menu
  "Right-click context menu for datasheet"
  []
  (let [menu (get-in @state/app-state [:table-viewer :context-menu])]
    (when (:visible menu)
      [:div.context-menu
       {:style {:left (:x menu) :top (:y menu)}
        :on-mouse-leave #(state-table/hide-table-context-menu!)}
       [:div.menu-item
        {:on-click #(do (state-table/new-table-record!)
                        (state-table/hide-table-context-menu!))}
        "New Record"]
       [:div.menu-divider]
       [:div.menu-item
        {:on-click #(do (state-table/cut-table-cell!)
                        (state-table/hide-table-context-menu!))}
        "Cut"]
       [:div.menu-item
        {:on-click #(do (state-table/copy-table-cell!)
                        (state-table/hide-table-context-menu!))}
        "Copy"]
       [:div.menu-item
        {:on-click #(do (state-table/paste-table-cell!)
                        (state-table/hide-table-context-menu!))}
        "Paste"]
       [:div.menu-divider]
       [:div.menu-item.danger
        {:on-click #(do (when (js/confirm "Delete this record?")
                          (state-table/delete-table-record!))
                        (state-table/hide-table-context-menu!))}
        "Delete Record"]])))

;; ============================================================
;; DATASHEET VIEW - Editable grid of data
;; ============================================================

(defn editable-cell
  "A cell that can be edited on double-click"
  [row-idx col-name value col-type]
  (let [editing? (get-in @state/app-state [:table-viewer :editing])
        is-editing (and editing?
                        (= (:row editing?) row-idx)
                        (= (:col editing?) col-name))]
    (fn [row-idx col-name value col-type]
      (let [editing? (get-in @state/app-state [:table-viewer :editing])
            is-editing (and editing?
                            (= (:row editing?) row-idx)
                            (= (:col editing?) col-name))
            selected (get-in @state/app-state [:table-viewer :selected])
            is-selected (and selected
                             (= (:row selected) row-idx)
                             (= (:col selected) col-name))
            display-value (cond
                            (nil? value) ""
                            (boolean? value) (if value "Yes" "No")
                            :else (str value))]
        (if is-editing
          [:td.editing
           [:input.cell-input
            {:type "text"
             :auto-focus true
             :default-value (if (nil? value) "" (str value))
             :on-blur (fn [e]
                        (let [new-value (.. e -target -value)]
                          (state-table/save-table-cell! new-value)
                          (state-table/stop-editing-cell!)))
             :on-key-down (fn [e]
                            (case (.-key e)
                              "Enter" (do
                                        (let [new-value (.. e -target -value)]
                                          (state-table/save-table-cell! new-value))
                                        (state-table/stop-editing-cell!))
                              "Escape" (state-table/stop-editing-cell!)
                              "Tab" (do
                                      (.preventDefault e)
                                      (let [new-value (.. e -target -value)]
                                        (state-table/save-table-cell! new-value))
                                      (state-table/stop-editing-cell!)
                                      (state-table/move-to-next-cell! (.-shiftKey e)))
                              nil))}]]
          [:td {:class (str (when (nil? value) "null-value ")
                            (when is-selected "selected"))
                :on-click #(state-table/select-table-cell! row-idx col-name)
                :on-double-click #(state-table/start-editing-cell! row-idx col-name)
                :on-context-menu (fn [e]
                                   (.preventDefault e)
                                   (state-table/select-table-cell! row-idx col-name)
                                   (state-table/show-table-context-menu! (.-clientX e) (.-clientY e)))}
           display-value])))))

(defn data-row
  "Single row in the datasheet"
  [record fields row-idx]
  (let [selected-row (get-in @state/app-state [:table-viewer :selected :row])]
    [:tr {:class (str (if (even? row-idx) "even-row " "odd-row ")
                      (when (= selected-row row-idx) "selected-row"))}
     [:td.row-number
      {:on-context-menu (fn [e]
                          (.preventDefault e)
                          (state-table/select-table-row! row-idx)
                          (state-table/show-table-context-menu! (.-clientX e) (.-clientY e)))}
      (inc row-idx)]
     (for [{:keys [name type]} fields]
       ^{:key name}
       [editable-cell row-idx name (get record (keyword name)) type])]))

(defn datasheet-view
  "Datasheet view showing table data with editing"
  []
  (let [table-info (get-in @state/app-state [:table-viewer :table-info])
        fields (:fields table-info)
        records (get-in @state/app-state [:table-viewer :records] [])
        loading? (get-in @state/app-state [:table-viewer :loading?])]
    [:div.table-datasheet-view
     {:on-click #(when (= (.-target %) (.-currentTarget %))
                   (state-table/hide-table-context-menu!))}
     (cond
       loading?
       [:div.loading-data "Loading data..."]

       (empty? fields)
       [:div.no-columns "No columns defined"]

       :else
       [:div.datasheet-container
        [:table.datasheet
         [:thead
          [:tr
           [:th.row-header "#"]
           (for [{:keys [name]} fields]
             ^{:key name}
             [:th name])]]
         [:tbody
          (if (seq records)
            (map-indexed
             (fn [idx record]
               ^{:key idx}
               [data-row record fields idx])
             records)
            [:tr [:td {:col-span (inc (count fields))} "No records"]])]]])

     ;; Context menu
     [context-menu]

     ;; Record count
     [:div.record-count
      (str (count records) " record" (when (not= 1 (count records)) "s"))
      " · Double-click to edit · Right-click for menu"]]))

;; ============================================================
;; TOOLBAR
;; ============================================================

(defn table-toolbar
  "Toolbar with view toggle and new record button"
  []
  (let [view-mode (get-in @state/app-state [:table-viewer :view-mode] :datasheet)]
    [:div.table-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn
       {:class (when (= view-mode :design) "active")
        :title "Design View"
        :on-click #(state-table/set-table-view-mode! :design)}
       "Design"]
      [:button.toolbar-btn
       {:class (when (= view-mode :datasheet) "active")
        :title "Datasheet View"
        :on-click #(state-table/set-table-view-mode! :datasheet)}
       "Datasheet"]]
     [:div.toolbar-right
      (when (= view-mode :datasheet)
        [:button.primary-btn
         {:on-click #(state-table/new-table-record!)}
         "+ New"])
      [:button.secondary-btn
       {:on-click #(state-table/refresh-table-data!)}
       "Refresh"]]]))

;; ============================================================
;; MAIN COMPONENT
;; ============================================================

(defn table-viewer
  "Main table viewer component"
  []
  (let [active-tab (:active-tab @state/app-state)
        current-table-id (get-in @state/app-state [:table-viewer :table-id])
        view-mode (get-in @state/app-state [:table-viewer :view-mode] :datasheet)]
    (when (and active-tab (= (:type active-tab) :tables))
      ;; Load table when tab changes
      (let [table (first (filter #(= (:id %) (:id active-tab))
                                 (get-in @state/app-state [:objects :tables])))]
        (when (and table (not= (:id table) current-table-id))
          (state-table/load-table-for-viewing! table)))
      [:div.table-viewer
       [table-toolbar]
       (case view-mode
         :design [design-view]
         :datasheet [datasheet-view]
         [datasheet-view])])))
