(ns app.transforms.macro
  "Pure macro transforms — (state, args) -> state.
   1 transform covering macro translation status.")

(defn set-macro-status [state status]
  (-> state
      (assoc-in [:macro-viewer :macro-info :status] status)
      (assoc-in [:macro-viewer :cljs-dirty?] true)))
