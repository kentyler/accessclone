(ns app.transforms.module
  "Pure module transforms — (state, args) -> state.
   6 transforms covering ClojureScript source editing, module status,
   review notes, dirty flag, intents, and extracting state.")

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

(defn update-module-review-notes [state notes]
  (-> state
      (assoc-in [:module-viewer :module-info :review-notes] notes)
      (assoc-in [:module-viewer :cljs-dirty?] true)))

(defn set-module-cljs-dirty [state dirty?]
  (assoc-in state [:module-viewer :cljs-dirty?] dirty?))

(defn set-module-intents [state intents]
  (assoc-in state [:module-viewer :intents] intents))

(defn set-extracting-intents [state extracting?]
  (assoc-in state [:module-viewer :extracting-intents?] extracting?))
