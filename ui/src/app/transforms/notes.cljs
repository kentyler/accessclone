(ns app.transforms.notes
  "Pure notes/corpus transforms — (state, args) -> state.
   6 transforms for the append-only corpus UI.")

(defn set-notes-entries [state entries]
  (assoc state :notes-entries entries))

(defn add-notes-entry [state entry]
  (update state :notes-entries #(into [entry] %)))

(defn set-notes-selected [state id]
  (assoc state :notes-selected-id id))

(defn set-notes-input [state text]
  (assoc state :notes-input text))

(defn set-notes-loading [state loading?]
  (assoc state :notes-loading? loading?))

(defn set-notes-read-entry [state entry response]
  (assoc state
         :notes-read-entry entry
         :notes-read-response response))
