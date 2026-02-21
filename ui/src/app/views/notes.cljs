(ns app.views.notes
  "Notes — a corpus that writes back.
   Three-pane layout: sidebar (entry list), center (write), right (read)."
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.notes :as notes-flow]))

;; ============================================================
;; HELPERS
;; ============================================================

(defn- relative-time [timestamp]
  (when timestamp
    (let [now (.now js/Date)
          then (.getTime (js/Date. timestamp))
          diff-ms (- now then)
          diff-s (/ diff-ms 1000)
          diff-m (/ diff-s 60)
          diff-h (/ diff-m 60)
          diff-d (/ diff-h 24)]
      (cond
        (< diff-m 1)  "just now"
        (< diff-m 60) (str (int diff-m) "m ago")
        (< diff-h 24) (str (int diff-h) "h ago")
        (< diff-d 7)  (str (int diff-d) "d ago")
        :else         (let [d (js/Date. timestamp)]
                        (str (.getMonth d) "/" (.getDate d)))))))

(defn- first-line [content]
  (when content
    (let [line (first (str/split-lines content))]
      (if (> (count line) 80)
        (str (subs line 0 80) "...")
        line))))

;; ============================================================
;; SIDEBAR — chronological entry list
;; ============================================================

(defn- notes-sidebar []
  (let [entries (:notes-entries @state/app-state)
        selected-id (:notes-selected-id @state/app-state)]
    [:div.notes-sidebar
     [:div.notes-sidebar-header "Corpus"]
     [:div.notes-sidebar-list
      (if (empty? entries)
        [:div.notes-sidebar-empty "No entries yet. Write something."]
        (for [entry entries]
          ^{:key (:id entry)}
          [:div.notes-sidebar-item
           {:class (str (name (:entry_type entry))
                        (when (= (:id entry) selected-id) " selected"))
            :on-click #(f/run-fire-and-forget! notes-flow/select-entry-flow {:id (:id entry)})}
           [:div.notes-sidebar-preview (first-line (:content entry))]
           [:div.notes-sidebar-time (relative-time (:created_at entry))]]))]]))

;; ============================================================
;; ENTRY PANE — write new entries / view selected prompt
;; ============================================================

(defn- notes-entry-pane []
  (let [input (:notes-input @state/app-state)
        loading? (:notes-loading? @state/app-state)
        selected-entry (:notes-read-entry @state/app-state)
        ;; Show the selected human entry's content when viewing, otherwise the input textarea
        viewing? (and selected-entry (not (str/blank? (:content selected-entry ""))))]
    [:div.notes-entry-pane
     [:div.notes-entry-header
      [:span (if viewing? "Entry" "Write")]
      [:div.notes-header-actions
       (when-not viewing?
         (if loading?
           [:span.notes-loading-indicator "Reading the corpus..."]
           [:button.notes-submit-btn
            {:on-click #(f/run-fire-and-forget! notes-flow/submit-entry-flow)
             :disabled (or loading? (str/blank? input))}
            "Submit (Ctrl+Enter)"]))
       [:button.notes-new-btn
        {:on-click (fn []
                     (t/dispatch! :set-notes-selected nil)
                     (t/dispatch! :set-notes-read-entry nil nil)
                     (t/dispatch! :set-notes-input ""))
         :title "New entry"}
        "+"]]]
     (if viewing?
       [:div.notes-view-content
        [:div.notes-read-text (:content selected-entry)]]
       [:textarea.notes-textarea
        {:value input
         :placeholder "Write an entry..."
         :disabled loading?
         :on-change #(t/dispatch! :set-notes-input (.. % -target -value))
         :on-key-down (fn [e]
                        (when (and (= (.-key e) "Enter")
                                   (.-ctrlKey e))
                          (.preventDefault e)
                          (f/run-fire-and-forget! notes-flow/submit-entry-flow)))}])
     [:div.notes-entry-footer
      (if loading?
        [:span.notes-loading-indicator "Reading the corpus..."]
        (when-not viewing?
          [:button.notes-submit-btn
           {:on-click #(f/run-fire-and-forget! notes-flow/submit-entry-flow)
            :disabled (or loading? (str/blank? input))}
           "Submit (Ctrl+Enter)"]))]]))

;; ============================================================
;; READ PANE — response only
;; ============================================================

(defn- notes-read-pane []
  (let [response (:notes-read-response @state/app-state)]
    [:div.notes-read-pane
     [:div.notes-entry-header "Response"]
     (if response
       [:div.notes-read-content
        [:div.notes-read-entry.llm
         [:div.notes-read-meta
          [:span.notes-read-time (relative-time (:created_at response))]]
         [:div.notes-read-text (:content response)]]]
       [:div.notes-read-placeholder
        "Write an entry to see the corpus respond."])]))

;; ============================================================
;; NOTES PAGE
;; ============================================================

(defn notes-page []
  (r/create-class
    {:component-did-mount
     (fn [_]
       (f/run-fire-and-forget! notes-flow/load-notes-flow))
     :reagent-render
     (fn []
       [:div.notes-page-wrapper
        [:a.back-to-hub {:on-click #(swap! state/app-state assoc :current-page :hub)}
         "\u2190 Back to Hub"]
        [:div.notes-page
         [notes-sidebar]
         [notes-entry-pane]
         [notes-read-pane]]])}))
