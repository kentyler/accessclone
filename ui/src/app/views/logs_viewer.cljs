(ns app.views.logs-viewer
  "Logs mode center pane — import detail and issue list"
  (:require [app.state :as state]))

(defn- format-timestamp [ts]
  (when ts
    (let [d (js/Date. ts)]
      (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))))

(defn- severity-class [severity]
  (case severity
    "error" "error"
    "warning" "warning"
    "info" "info"
    ""))

(defn- issue-item
  "Single issue row with resolve checkbox"
  [issue]
  (let [resolved? (:resolved issue)]
    [:div.issue-item {:class (str (severity-class (:severity issue))
                                  (when resolved? " resolved"))}
     [:div.issue-item-header
      [:span.issue-severity (:severity issue)]
      (when (:category issue)
        [:span.issue-category (:category issue)])
      (when (:location issue)
        [:span.issue-location (:location issue)])
      [:label.issue-resolve-btn
       [:input {:type "checkbox"
                :checked (boolean resolved?)
                :on-change #(state/toggle-issue-resolved! (:id issue) resolved?)}]
       (if resolved? "Resolved" "Resolve")]]
     [:div.issue-message (:message issue)]
     (when (:suggestion issue)
       [:div.issue-suggestion (:suggestion issue)])]))

(defn- issue-summary-bar
  "Summary counts of issues"
  [issues]
  (let [errors (count (filter #(= (:severity %) "error") issues))
        warnings (count (filter #(= (:severity %) "warning") issues))
        resolved (count (filter :resolved issues))
        total (count issues)]
    [:div.issue-summary-bar
     (when (pos? total)
       [:<>
        (when (pos? errors)
          [:span.summary-errors (str errors " error" (when (> errors 1) "s"))])
        (when (pos? warnings)
          [:span.summary-warnings (str warnings " warning" (when (> warnings 1) "s"))])
        (when (pos? resolved)
          [:span.summary-resolved (str resolved " resolved")])])
     (when (zero? total)
       [:span.summary-clean "No issues"])]))

(defn- log-detail-header
  "Header showing info about the selected import entry"
  [entry]
  [:div.log-detail-header
   [:div.log-detail-title
    [:span.log-detail-type (:source_object_type entry)]
    [:span.log-detail-name (:source_object_name entry)]]
   [:div.log-detail-meta
    [:span {:class (str "status-badge " (:status entry))} (:status entry)]
    [:span.log-detail-time (format-timestamp (:created_at entry))]
    (when (:target_database_id entry)
      [:span.log-detail-db (str "Target: " (:target_database_id entry))])]])

(defn log-detail-panel
  "Center pane: header + summary + issue list, or welcome when nothing selected"
  []
  (let [entry (:logs-selected-entry @state/app-state)
        issues (:logs-issues @state/app-state)
        loading? (:logs-loading? @state/app-state)]
    [:div.log-detail-panel
     (if entry
       ;; Entry selected — show detail
       [:<>
        [log-detail-header entry]
        [issue-summary-bar issues]
        (if loading?
          [:div.logs-loading "Loading issues..."]
          [:div.issue-list
           (if (empty? issues)
             [:div.issue-list-empty "No issues for this import entry."]
             (for [issue issues]
               ^{:key (:id issue)}
               [issue-item issue]))])]
       ;; No entry selected — welcome
       [:div.logs-welcome
        [:h3 "Import Logs"]
        [:p "Select an import entry from the sidebar to view its details and issues."]
        [:p "Issues are detected automatically during import: skipped columns, SQL conversion warnings, broken field bindings, and untranslated VBA/macros."]])]))
