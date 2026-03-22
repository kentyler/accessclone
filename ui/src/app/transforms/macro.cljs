(ns app.transforms.macro
  "Pure macro transforms — (state, args) -> state.
   1 transform covering macro translation status.")

(defn set-macro-status [state status]
  (assoc-in state [:macro-viewer :macro-info :status] status))
