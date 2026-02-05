(ns app.views.query-viewer
  "Query viewer - results and SQL views"
  (:require [reagent.core :as r]
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
        loading? (get-in @state/app-state [:query-viewer :loading?])
        error (get-in @state/app-state [:query-viewer :error])]
    [:div.query-sql-view
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
      [:span.hint "Ctrl+Enter to run"]]]))

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
         [results-view])])))
