(ns app.transforms.module
  "Pure module transforms — (state, args) -> state.
   2 transforms covering ClojureScript source editing and module status.")

(defn update-module-cljs-source [state new-source]
  (-> state
      (assoc-in [:module-viewer :module-info :cljs-source] new-source)
      (assoc-in [:module-viewer :cljs-dirty?] true)))

(defn set-module-status
  "Set translation status and optional review notes for current module."
  ([state status]
   (-> state
       (assoc-in [:module-viewer :module-info :status] status)
       (assoc-in [:module-viewer :cljs-dirty?] true)))
  ([state status review-notes]
   (-> state
       (assoc-in [:module-viewer :module-info :status] status)
       (assoc-in [:module-viewer :module-info :review-notes] review-notes)
       (assoc-in [:module-viewer :cljs-dirty?] true))))
