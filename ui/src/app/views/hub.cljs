(ns app.views.hub
  "Hub home page — 3-column layout with left menu, center content, right panel, and chat"
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.chat :as chat-flow]
            [app.flows.notes :as notes-flow]))

;; ============================================================
;; LEFT MENU
;; ============================================================

(defn- hub-left-menu []
  (let [selected (:hub-selected @state/app-state)]
    [:nav.hub-left
     [:div.hub-logo "Hub"]
     (for [[id label] [[:home "Home"] [:notes "Notes"] [:llm-registry "LLMs"]
                       [:meetings "Meetings"] [:messaging "Messages"] [:email "Email"]
                       [:accessclone "AccessClone"]]]
       ^{:key id}
       [:div.hub-menu-item {:class (when (= id selected) "active")
                            :on-click #(swap! state/app-state assoc :hub-selected id)}
        [:span.hub-menu-label label]
        (when (not= id :home)
          [:button.hub-open-btn
           {:on-click (fn [e]
                        (.stopPropagation e)
                        (swap! state/app-state assoc :current-page id))}
           "Open"])])]))

;; ============================================================
;; CENTER CONTENT
;; ============================================================

(defn- home-content []
  [:div.hub-home-content
   [:h2 "The Three-Layer Architecture"]
   [:p.hub-home-subtitle "A Deleuzian Reading"]

   [:div.hub-layers
    [:div.hub-layer
     [:div.hub-layer-header
      [:span.hub-layer-icon "C"]
      [:h3 "Could Do"]]
     [:p.hub-layer-deleuze [:em "The virtual \u2014 the plane of consistency."] " Think of it as your wildest dreams."]
     [:p "Not a list of insights waiting to be surfaced. The full differential field of everything an organization's body of work implies, real but not actualized, containing all the variations, all the connections, all the patterns the work has ever enacted or could enact."]
     [:p "This is " [:em "puissance"] " \u2014 capacity that exists as intensity, not as enumerated possibility. It's the Body without Organs of organizational thinking: unorganized potential that resists premature stratification into any single interpretation. The virtual is not vague \u2014 it's maximally determined as a field of differential relations. Every unrealized implication stands in relation to every other, and those relations constitute the topology of the space."]]

    [:div.hub-layer-arrow
     [:span "\u2193 selects from"] [:span "\u2191 abstracts to"]]

    [:div.hub-layer
     [:div.hub-layer-header
      [:span.hub-layer-icon "S"]
      [:h3 "Should Do"]]
     [:p.hub-layer-deleuze [:em "The abstract machine \u2014 the diagram."] " Think of it as the sketches on the back of an envelope."]
     [:p "The selective principle that draws from the virtual and orients actualization without yet being actual itself. It's what Deleuze and Guattari call the " [:em "diagrammatic function"] ": it doesn't represent a pre-existing reality and it doesn't produce a finished one. It pilots the process of stratification."]
     [:p "In the system, this is where intellectual operations live \u2014 the acts of distinguishing, connecting, reframing, converging, bounding that recur across expressions without being named. An organization argues about scope in three meetings using different vocabulary; the should-do layer is where \"bounding\" exists as an operation independent of any particular instance."]
     [:p "The abstract machine is what makes " [:em "this"] " expression " [:em "this"] " expression rather than some other equally possible one. It's " [:em "pouvoir"] " operating on " [:em "puissance"] " \u2014 power exercised as selection from capacity."]]

    [:div.hub-layer-arrow
     [:span "\u2193 actualizes as"] [:span "\u2191 virtualizes as"]]

    [:div.hub-layer
     [:div.hub-layer-header
      [:span.hub-layer-icon "D"]
      [:h3 "Doing Now"]]
     [:p.hub-layer-deleuze [:em "The concrete assemblage \u2014 the stratum."] " Think of it as the hurly-burly, the daily grind."]
     [:p "The actual note, transcript, message, or email with its specific wording, specific context, specific audience. What has been captured from the flows of the virtual and organized into a functioning arrangement of bodies (participants), tools (communication platforms), statements (arguments, claims, proposals), and practices (workflows, correspondence patterns)."]
     [:p "It's " [:em "molar"] " \u2014 organized at scale, recognizable, repeatable. It's also, crucially, " [:em "territorial"] " \u2014 it has a boundary, a channel, a thread, a specific population of readers and respondents it operates within."]]]

   [:div.hub-key-properties
    [:h4 "Why Three Layers"]
    [:p "Every existing communication tool collapses the distinction \u2014 it only shows you what the organization " [:em "is doing now"] " and you have to imagine what it " [:em "could do"] " or " [:em "should do"] ". This architecture makes the virtual legible (through the AI's reading of could-do across the full corpus), the diagrammatic function explicit (through the AI's recognition of should-do \u2014 the intellectual operations that select which potentials get actualized in which expressions), and the actual inspectable (through the doing-now layer across every interface)."]
    [:p "The three layers don't just describe different kinds of content. They describe a " [:em "process"] " \u2014 stratification, the ongoing capture and organization of virtual intensity into actual configuration."]]

   [:div.hub-key-properties
    [:h4 "Bidirectional Movement"]
    [:p [:strong "Actualization"] " moves from could-do through should-do to doing-now \u2014 an unrealized potential, shaped by an intellectual operation, becomes a specific expression in a specific medium."]
    [:p [:strong "Deterritorialization"] " moves back \u2014 when the AI extracts an intention from a particular expression and recognizes it as an operation recurring across many expressions, it's freeing the pattern from its territorial binding. The act of \"reframing feature requests as workflow problems\" extracted from one person's Slack messages is deterritorialized \u2014 released from that context and available for reterritorialization anywhere in the organization's thinking."]
    [:p "The system is literally a " [:strong "deterritorialization engine"] ". It takes stratified, territorialized communication \u2014 notes locked in notebooks, conversations locked in transcripts, messages locked in channels, correspondence locked in inboxes \u2014 and extracts their virtual content, making visible what the organization " [:em "could do"] " and " [:em "should do"] " that was always real but never perceptible from inside what it " [:em "is doing now"] "."]
    [:p.hub-read-more [:a {:href "/architecture.html" :target "_blank"} "Read the full explanation \u2192"]]]])

(defn- preview-content [title description]
  [:div.hub-preview
   [:h2 title]
   [:p description]])

(defn- hub-center-content []
  (let [selected (:hub-selected @state/app-state)]
    [:div.hub-center
     (case selected
       :home         [home-content]
       :notes        [preview-content "Notes" "A corpus that writes back. Write entries and an LLM reads each one against everything that came before."]
       :llm-registry (let [registry (get-in @state/app-state [:config :llm-registry] [])
                           secretary (first (filter :is_secretary registry))]
                       [:div.hub-preview
                        [:h2 "LLM Registry"]
                        [:p (str (count registry) " model" (when (not= 1 (count registry)) "s") " registered"
                             (when secretary (str ", secretary: " (:name secretary))))]
                        (when (seq registry)
                          [:ul.hub-right-list
                           (for [m registry]
                             ^{:key (:id m)}
                             [:li (str (:name m) " (" (:provider m) ")"
                                       (when (:is_secretary m) " \u2605")
                                       (when-not (:enabled m) " [disabled]"))])])])
       :meetings     [preview-content "Meetings" "Schedule, agenda, and meeting notes. Open to manage your calendar."]
       :messaging    [preview-content "Messages" "Direct and group messaging. Open for the full messaging interface."]
       :email        [preview-content "Email" "Email inbox and composition. Open for the full email client."]
       :accessclone  [preview-content "AccessClone" "Convert MS Access databases to web applications. Open to work with your databases."]
       [home-content])]))

;; ============================================================
;; RIGHT PANEL
;; ============================================================

(defn- hub-right-panel []
  (let [selected (:hub-selected @state/app-state)]
    [:aside.hub-right
     (case selected
       :home [:div
              [:h4 "Quick Start"]
              [:p "Select a section from the menu to preview it, or click Open to go to its full page."]]
       :llm-registry [:div
                      [:h4 "Secretary"]
                      (let [registry (get-in @state/app-state [:config :llm-registry] [])
                            secretary (first (filter :is_secretary registry))]
                        (if secretary
                          [:div
                           [:p [:strong (:name secretary)]]
                           [:p.hub-right-placeholder (:description secretary)]]
                          [:p.hub-right-placeholder "No secretary designated. Open to configure."]))]
       :notes [:div
               [:h4 "Recent Notes"]
               (let [entries (take 5 (:notes-entries @state/app-state))]
                 (if (seq entries)
                   [:ul.hub-recent-notes-list
                    (for [entry entries]
                      ^{:key (:id entry)}
                      [:li.hub-recent-note
                       {:class (name (:entry_type entry))
                        :on-click (fn []
                                    (swap! state/app-state assoc :current-page :notes)
                                    (f/run-fire-and-forget! notes-flow/select-entry-flow {:id (:id entry)}))}
                       (let [line (first (str/split-lines (or (:content entry) "")))]
                         (if (> (count line) 50)
                           (str (subs line 0 50) "...")
                           line))])]
                   [:p.hub-right-placeholder "No recent notes."]))]
       :meetings [:div
                  [:h4 "Upcoming"]
                  [:p.hub-right-placeholder "No upcoming meetings."]]
       :messaging [:div
                   [:h4 "Unread"]
                   [:p.hub-right-placeholder "No unread messages."]]
       :email [:div
               [:h4 "Inbox"]
               [:p.hub-right-placeholder "No new emails."]]
       :accessclone [:div
                     [:h4 "Databases"]
                     (let [dbs (:available-databases @state/app-state)]
                       (if (seq dbs)
                         [:ul.hub-right-list
                          (for [db dbs]
                            ^{:key (:database_id db)}
                            [:li (:name db)])]
                         [:p.hub-right-placeholder "No databases loaded."]))]
       [:div
        [:h4 "Quick Start"]
        [:p "Select a section from the menu."]])]))

;; ============================================================
;; CHAT PANEL (reuses same state keys as main chat)
;; ============================================================

(defn- hub-chat-message [{:keys [role content]}]
  [:div.chat-message {:class role}
   [:div.message-content content]])

(defn- hub-chat-panel []
  (let [messages-end (r/atom nil)
        prev-msg-count (r/atom 0)]
    (r/create-class
     {:component-did-update
      (fn [_this]
        (let [cur-count (count (:chat-messages @state/app-state))]
          (when (not= cur-count @prev-msg-count)
            (reset! prev-msg-count cur-count)
            (when-let [el @messages-end]
              (.scrollIntoView el #js {:behavior "smooth"})))))
      :reagent-render
      (fn []
        (let [messages (:chat-messages @state/app-state)
              input (:chat-input @state/app-state)
              loading? (:chat-loading? @state/app-state)
              open? (:chat-panel-open? @state/app-state)]
          [:aside.hub-chat {:class (when-not open? "collapsed")}
           [:div.chat-header
            [:span.chat-title "Assistant"]
            [:button.chat-toggle {:on-click #(t/dispatch! :toggle-chat-panel)}
             (if open? "\u00BB" "\u00AB")]]
           (when open?
             [:<>
              [:div.chat-messages
               (if (empty? messages)
                 [:div.chat-empty "Ask me anything about the hub or your projects."]
                 (for [[idx msg] (map-indexed vector messages)]
                   ^{:key idx}
                   [hub-chat-message msg]))
               (when loading?
                 [:div.chat-message.assistant
                  [:div.message-content.typing "Thinking..."]])
               [:div {:ref #(reset! messages-end %)}]]
              [:div.chat-input-area
               [:textarea.chat-input
                {:value input
                 :placeholder "Type a message..."
                 :disabled loading?
                 :on-change #(t/dispatch! :set-chat-input (.. % -target -value))
                 :on-key-down (fn [e]
                                (when (and (= (.-key e) "Enter")
                                           (not (.-shiftKey e)))
                                  (.preventDefault e)
                                  (f/run-fire-and-forget! chat-flow/send-chat-message-flow)))}]
               [:button.chat-send
                {:on-click #(f/run-fire-and-forget! chat-flow/send-chat-message-flow)
                 :disabled (or loading? (empty? (str/trim input)))}
                "Send"]]])]))})))

;; ============================================================
;; HUB PAGE (assembles all panels)
;; ============================================================

(defn hub-page []
  (r/create-class
    {:component-did-mount
     (fn [_]
       ;; Load notes so "Recent Notes" panel has data
       (f/run-fire-and-forget! notes-flow/load-notes-flow))
     :reagent-render
     (fn []
       [:div.hub-page
        [hub-left-menu]
        [hub-center-content]
        [hub-right-panel]
        [hub-chat-panel]])}))
