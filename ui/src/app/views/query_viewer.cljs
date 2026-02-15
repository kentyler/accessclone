(ns app.views.query-viewer
  "Query viewer - results, SQL, and design views"
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [app.state :as state]
            [app.state-query :as state-query]))

;; ============================================================
;; RESULTS VIEW - Datasheet showing query output
;; ============================================================

(defn result-cell
  "Single cell in the results grid"
  [value]
  (let [display-value (cond
                        (nil? value) ""
                        (boolean? value) (if value "Yes" "No")
                        :else (str value))]
    [:td {:class (when (nil? value) "null-value")
          :title display-value}
     display-value]))

(defn result-row
  "Single row in the results"
  [record fields row-num]
  [:tr {:class (if (even? row-num) "even-row" "odd-row")}
   [:td.row-number row-num]
   (for [{:keys [name]} fields]
     ^{:key name}
     [result-cell (get record (keyword name))])])

(defn results-view
  "Results view showing query output"
  []
  (let [results (get-in @state/app-state [:query-viewer :results] [])
        fields (get-in @state/app-state [:query-viewer :result-fields] [])
        query-info (get-in @state/app-state [:query-viewer :query-info])
        loading? (get-in @state/app-state [:query-viewer :loading?])
        error (get-in @state/app-state [:query-viewer :error])
        ;; Use query fields if result fields not available
        display-fields (if (seq fields)
                         fields
                         (:fields query-info))]
    [:div.query-results-view
     (cond
       loading?
       [:div.loading-data "Running query..."]

       error
       [:div.query-error
        [:strong "Error: "]
        error]

       (empty? display-fields)
       [:div.no-columns "No columns"]

       :else
       [:div.datasheet-container
        [:table.datasheet
         [:thead
          [:tr
           [:th.row-header "#"]
           (for [{:keys [name]} display-fields]
             ^{:key name}
             [:th name])]]
         [:tbody
          (if (seq results)
            (map-indexed
             (fn [idx record]
               ^{:key idx}
               [result-row record display-fields (inc idx)])
             results)
            [:tr [:td {:col-span (inc (count display-fields))} "No results"]])]]])

     ;; Record count
     [:div.record-count
      (str (count results) " row" (when (not= 1 (count results)) "s"))]]))

;; ============================================================
;; SQL VIEW - SQL editor
;; ============================================================

(defn sql-view
  "SQL view showing and editing the query"
  []
  (let [sql (get-in @state/app-state [:query-viewer :sql] "")
        query-info (get-in @state/app-state [:query-viewer :query-info])
        is-new? (:is-new? query-info)
        pending-name (get-in @state/app-state [:query-viewer :pending-name])
        loading? (get-in @state/app-state [:query-viewer :loading?])
        error (get-in @state/app-state [:query-viewer :error])]
    [:div.query-sql-view
     (when is-new?
       [:div.query-name-input
        [:label "View name: "]
        [:input {:type "text"
                 :value (or pending-name "")
                 :placeholder "my_query_name"
                 :on-change #(state-query/update-query-name! (.. % -target -value))}]])
     [:div.sql-editor-container
      [:textarea.sql-editor
       {:value sql
        :placeholder (str "SELECT * FROM " (:name query-info))
        :on-change #(state-query/update-query-sql! (.. % -target -value))
        :on-key-down (fn [e]
                       ;; Ctrl+Enter or Cmd+Enter to run
                       (when (and (= (.-key e) "Enter")
                                  (or (.-ctrlKey e) (.-metaKey e)))
                         (.preventDefault e)
                         (state-query/run-query!)))}]]

     (when error
       [:div.query-error
        [:strong "Error: "]
        error])

     [:div.sql-toolbar
      [:button.primary-btn
       {:on-click #(state-query/run-query!)
        :disabled loading?}
       (if loading? "Running..." "Run Query")]
      [:button.secondary-btn
       {:on-click #(state-query/save-query-via-llm!)
        :disabled (or (str/blank? sql)
                      (and is-new? (str/blank? pending-name)))}
       "Save"]
      [:span.hint "Ctrl+Enter to run"]]]))

;; ============================================================
;; DESIGN VIEW - Visual QBE grid (read-only)
;; ============================================================

(defn- table-box
  "Renders a single table box in the upper pane"
  [table selected-columns]
  (let [columns (:columns table)
        name (:name table)
        display-name (if (:alias table)
                       (str name " (" (:alias table) ")")
                       name)]
    [:div.qbe-table-box
     [:div.qbe-table-title display-name]
     [:div.qbe-table-columns
      (for [col columns]
        ^{:key col}
        [:div.qbe-table-column
         {:class (when (contains? selected-columns col) "qbe-col-selected")}
         col])]
     (when (empty? columns)
       [:div.qbe-table-column.qbe-col-empty "(no columns loaded)"])]))

(defn- join-lines-svg
  "SVG overlay drawing join lines between tables"
  [tables joins]
  (let [table-count (count tables)
        ;; Each table box is ~180px wide with 20px gap, positioned in a row
        box-width 180
        gap 40
        table-positions (into {}
                              (map-indexed
                               (fn [idx t]
                                 [(str (:name t))
                                  {:x (+ 16 (* idx (+ box-width gap)))
                                   :width box-width}])
                               tables))
        ;; Build column-index map per table for Y positioning
        col-indices (into {}
                          (for [t tables
                                :let [cols (:columns t)]
                                [idx col] (map-indexed vector cols)]
                            [(str (:name t) "." col) {:table (:name t) :idx idx}]))
        svg-width (+ 32 (* table-count (+ box-width gap)))
        ;; Title bar ~28px, each column row ~24px, base offset ~44px from top of box
        title-h 28
        row-h 24
        top-offset 44]
    [:svg.qbe-join-svg
     {:width svg-width
      :height "100%"
      :style {:position "absolute" :top 0 :left 0 :pointer-events "none"}}
     (for [[idx join] (map-indexed vector joins)]
       (let [left-pos (get table-positions (:leftTable join))
             right-pos (get table-positions (:rightTable join))
             left-col-info (get col-indices (str (:leftTable join) "." (:leftColumn join)))
             right-col-info (get col-indices (str (:rightTable join) "." (:rightColumn join)))]
         (when (and left-pos right-pos)
           (let [;; X: connect from right edge of left table to left edge of right table
                 ;; or vice versa depending on position
                 left-x-center (+ (:x left-pos) (/ (:width left-pos) 2))
                 right-x-center (+ (:x right-pos) (/ (:width right-pos) 2))
                 x1 (if (< left-x-center right-x-center)
                       (+ (:x left-pos) (:width left-pos))
                       (:x left-pos))
                 x2 (if (< left-x-center right-x-center)
                       (:x right-pos)
                       (+ (:x right-pos) (:width right-pos)))
                 ;; Y: center on the column row
                 y1 (+ top-offset (* (or (:idx left-col-info) 0) row-h) (/ row-h 2))
                 y2 (+ top-offset (* (or (:idx right-col-info) 0) row-h) (/ row-h 2))
                 ;; Join type label
                 label (case (:type join)
                         "LEFT JOIN" "LEFT"
                         "RIGHT JOIN" "RIGHT"
                         "FULL JOIN" "FULL"
                         "CROSS JOIN" "CROSS"
                         nil)
                 mid-x (/ (+ x1 x2) 2)
                 mid-y (/ (+ y1 y2) 2)]
             ^{:key idx}
             [:g
              [:line {:x1 x1 :y1 y1 :x2 x2 :y2 y2
                      :stroke "#6b7280" :stroke-width 1.5
                      :stroke-dasharray (when (not= (:type join) "INNER JOIN") "4 3")}]
              ;; Small diamonds at endpoints
              [:circle {:cx x1 :cy y1 :r 3 :fill "#6b7280"}]
              [:circle {:cx x2 :cy y2 :r 3 :fill "#6b7280"}]
              (when label
                [:text {:x mid-x :y (- mid-y 6)
                        :text-anchor "middle"
                        :class "qbe-join-label"}
                 label])]))))]))

(defn- design-upper-pane
  "Upper pane showing table boxes with join lines"
  [design-data]
  (let [tables (:tables design-data)
        joins (:joins design-data)
        fields (:fields design-data)
        ;; Collect columns that appear in SELECT for highlighting
        selected-cols (into #{}
                            (keep (fn [f]
                                    (let [expr (:expression f)
                                          ;; Extract column name from "alias.col" or "col"
                                          dot-idx (.lastIndexOf expr ".")]
                                      (if (>= dot-idx 0)
                                        (.replace (.substring expr (inc dot-idx)) #"\"" "")
                                        (.replace expr #"\"" "")))))
                            fields)]
    [:div.query-design-upper
     [:div.qbe-canvas
      {:style {:position "relative"
               :min-width (str (+ 32 (* (count tables) 220)) "px")}}
      [join-lines-svg tables joins]
      [:div.qbe-table-row
       (for [table tables]
         ^{:key (:name table)}
         [table-box table selected-cols])]]]))

(defn- design-lower-pane
  "Lower pane showing QBE field grid"
  [design-data]
  (let [fields (:fields design-data)
        where-text (:where design-data)]
    [:div.query-design-lower
     [:div.qbe-grid-container
      [:table.qbe-grid
       [:thead
        [:tr
         [:th "Field"]
         [:th "Table"]
         [:th "Sort"]
         [:th "Show"]
         [:th "Criteria"]]]
       [:tbody
        (for [[idx field] (map-indexed vector fields)]
          (let [expr (:expression field)
                display-name (or (:alias field) expr)
                table-name (:table field)]
            ^{:key idx}
            [:tr
             [:td.qbe-field-cell {:title expr} display-name]
             [:td.qbe-table-cell (or table-name "")]
             [:td.qbe-sort-cell
              (case (:sort field)
                "ASC" "Ascending"
                "DESC" "Descending"
                "")]
             [:td.qbe-show-cell
              [:span.qbe-checkmark "\u2713"]]
             [:td.qbe-criteria-cell ""]]))
        ;; Show WHERE in a summary row if present
        (when where-text
          [:tr.qbe-criteria-row
           [:td {:col-span 5}
            [:span.qbe-criteria-label "WHERE: "]
            [:span.qbe-criteria-text where-text]]])]]]]))

(defn design-view
  "Design view showing visual query builder (read-only)"
  []
  (let [design-data (get-in @state/app-state [:query-viewer :design-data])
        loading? (get-in @state/app-state [:query-viewer :design-loading?])]
    [:div.query-design-view
     (cond
       loading?
       [:div.loading-data "Loading design view..."]

       (nil? design-data)
       [:div.loading-data "Loading..."]

       (not (:parseable design-data))
       ;; Should have already switched to SQL view, but just in case
       [:div.query-error "Cannot parse this query for design view. Showing SQL instead."]

       :else
       [:<>
        [design-upper-pane design-data]
        [design-lower-pane design-data]])]))

;; ============================================================
;; TOOLBAR
;; ============================================================

(defn query-toolbar
  "Toolbar with view toggle"
  []
  (let [view-mode (get-in @state/app-state [:query-viewer :view-mode] :results)
        loading? (get-in @state/app-state [:query-viewer :loading?])]
    [:div.query-toolbar
     [:div.toolbar-left
      [:button.toolbar-btn
       {:class (when (= view-mode :results) "active")
        :title "Results View"
        :on-click #(state-query/set-query-view-mode! :results)}
       "Results"]
      [:button.toolbar-btn
       {:class (when (= view-mode :design) "active")
        :title "Design View"
        :on-click #(state-query/set-query-view-mode! :design)}
       "Design"]
      [:button.toolbar-btn
       {:class (when (= view-mode :sql) "active")
        :title "SQL View"
        :on-click #(state-query/set-query-view-mode! :sql)}
       "SQL"]]
     [:div.toolbar-right
      [:button.secondary-btn
       {:on-click #(state-query/run-query!)
        :disabled loading?}
       "Run"]]]))

;; ============================================================
;; MAIN COMPONENT
;; ============================================================

(defn query-viewer
  "Main query viewer component"
  []
  (let [active-tab (:active-tab @state/app-state)
        current-query-id (get-in @state/app-state [:query-viewer :query-id])
        view-mode (get-in @state/app-state [:query-viewer :view-mode] :results)]
    (when (and active-tab (= (:type active-tab) :queries))
      ;; Load query when tab changes
      (let [query (first (filter #(= (:id %) (:id active-tab))
                                 (get-in @state/app-state [:objects :queries])))]
        (when (and query (not= (:id query) current-query-id))
          (state-query/load-query-for-viewing! query)))
      [:div.query-viewer
       [query-toolbar]
       (case view-mode
         :results [results-view]
         :sql [sql-view]
         :design [design-view]
         [results-view])])))
