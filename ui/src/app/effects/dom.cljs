(ns app.effects.dom
  "DOM effect executors for browser dialogs.

   These are synchronous side effects that need to be isolated
   from pure transforms. Each returns its result directly
   (not a channel).")

(defn alert!
  "Show a browser alert dialog. Returns nil."
  [message]
  (js/alert message)
  nil)

(defn confirm!
  "Show a browser confirm dialog. Returns true/false."
  [message]
  (js/confirm message))

(defn prompt!
  "Show a browser prompt dialog. Returns string or nil."
  [message & [default-value]]
  (js/prompt message (or default-value "")))
