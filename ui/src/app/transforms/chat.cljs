(ns app.transforms.chat
  "Pure chat transforms — (state, args) -> state.
   4 transforms covering chat panel visibility, input, messages, and loading.")

(defn toggle-chat-panel [state]
  (update state :chat-panel-open? not))

(defn open-chat-panel [state]
  (assoc state :chat-panel-open? true))

(defn set-chat-input [state text]
  (assoc state :chat-input text))

(defn add-chat-message [state role content]
  (update state :chat-messages conj {:role role :content content}))

(defn set-chat-loading [state loading?]
  (assoc state :chat-loading? loading?))
