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
        (for [entry (filter #(= "human" (:entry_type %)) entries)]
          ^{:key (:id entry)}
          [:div.notes-sidebar-item
           {:class (str "human"
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
                     (t/dispatch! :set-notes-read-entry nil [])
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
;; RESPONSE CONDITIONS — model, temperature, sampling dropdowns + retry
;; ============================================================

(def temperature-presets [0 0.25 0.5 0.75 1.0])

(def sampling-options ["similarity" "distance" "random" "time_range" "mixed"])

(defn- condition-select
  "Editable select dropdown. Calls on-change with new string value."
  [label value options on-change]
  [:div.notes-condition-row
   [:span.notes-condition-label label]
   [:select.notes-condition-select
    {:value (str value)
     :on-change #(on-change (.. % -target -value))}
    (for [opt options]
      ^{:key opt}
      [:option {:value (str opt)} (str opt)])
    ;; Include actual value if not in presets
    (when (and value (not (some #(= (str %) (str value)) options)))
      [:option {:value (str value)} (str value)])]])

(defn- response-conditions
  "Conditions bar under a response card with editable dropdowns and Retry button.
   Uses local ratoms to track user overrides."
  [response human-entry registry-models]
  (let [model-override (r/atom nil)
        temp-override (r/atom nil)
        sampling-override (r/atom nil)]
    (fn [response human-entry registry-models]
      (let [orig-model (:model_name response)
            orig-temp (:temperature response)
            orig-sampling (:sampling_strategy human-entry)
            reasoning (:routing_reasoning human-entry)
            ;; Current values (override or original)
            cur-model (or @model-override orig-model)
            cur-temp (or @temp-override (str orig-temp))
            cur-sampling (or @sampling-override orig-sampling)
            has-conditions? (or orig-temp orig-model orig-sampling)
            regenerating? (:notes-regenerating? @state/app-state)]
        (when has-conditions?
          [:div.notes-response-conditions
           ;; Model
           (when orig-model
             (let [model-names (mapv :name registry-models)
                   opts (if (some #(= % orig-model) model-names)
                          model-names
                          (conj model-names orig-model))]
               [condition-select "Model" cur-model opts
                #(reset! model-override %)]))
           ;; Temperature
           (when orig-temp
             (let [temp-strs (mapv str temperature-presets)
                   orig-str (str orig-temp)]
               [condition-select "Temp" cur-temp
                (if (some #(= % orig-str) temp-strs) temp-strs (conj temp-strs orig-str))
                #(reset! temp-override %)]))
           ;; Sampling
           (when orig-sampling
             [condition-select "Sampling" cur-sampling sampling-options
              #(reset! sampling-override %)])
           ;; Retry button
           [:button.notes-retry-btn
            {:disabled regenerating?
             :on-click (fn []
                         (let [entry-id (:id human-entry)]
                           (when entry-id
                             (f/run-fire-and-forget!
                               notes-flow/regenerate-entry-flow
                               {:entry-id entry-id
                                :model-name cur-model
                                :temperature (js/parseFloat cur-temp)
                                :sampling cur-sampling}))))}
            (if regenerating? "Retrying..." "Retry")]
           ;; Reasoning
           (when (and reasoning (not (str/blank? reasoning)))
             [:div.notes-routing-reasoning reasoning])])))))

;; ============================================================
;; READ PANE — responses (supports multiple)
;; ============================================================

(defn- notes-read-pane []
  (let [responses (:notes-read-responses @state/app-state)
        human-entry (:notes-read-entry @state/app-state)
        registry-models (get-in @state/app-state [:config :llm-registry] [])]
    [:div.notes-read-pane
     [:div.notes-entry-header "Responses"]
     (if (seq responses)
       [:div.notes-read-content
        (for [response responses]
          ^{:key (:id response)}
          [:div.notes-response-card
           [:div.notes-read-entry.llm
            [:div.notes-read-meta
             (when (:model_name response)
               [:span.model-label (:model_name response)])
             [:span.notes-read-time (relative-time (:created_at response))]]
            [:div.notes-read-text (:content response)]]
           [response-conditions response human-entry registry-models]])]
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
