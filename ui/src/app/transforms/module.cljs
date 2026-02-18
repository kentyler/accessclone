(ns app.transforms.module
  "Pure module transforms — (state, args) -> state.
   9 transforms covering ClojureScript source editing, module status,
   review notes, dirty flag, intents, extracting state, gap resolution,
   gap questions, and gap selections.")

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

(defn set-gap-questions
  "Store gap questions from extraction response. Each entry gets a :selected key."
  [state gap-questions]
  (assoc-in state [:module-viewer :gap-questions]
            (mapv #(assoc % :selected nil) gap-questions)))

(defn set-gap-selection
  "Set the selected suggestion for a gap question by index."
  [state idx selection]
  (assoc-in state [:module-viewer :gap-questions idx :selected] selection))

(defn- resolve-gap-in-list
  "Walk an intent list recursively, setting resolution on the gap matching gap-id."
  [intents gap-id resolution]
  (mapv (fn [intent]
          (if (and (= "gap" (:type intent)) (= gap-id (:gap_id intent)))
            (-> intent
                (assoc :resolution resolution)
                (update :resolution_history (fnil conj []) resolution))
            (cond-> intent
              (:then intent)     (update :then resolve-gap-in-list gap-id resolution)
              (:else intent)     (update :else resolve-gap-in-list gap-id resolution)
              (:children intent) (update :children resolve-gap-in-list gap-id resolution))))
        intents))

(defn resolve-gap
  "Resolve a gap intent by gap_id with the given resolution map."
  [state gap-id resolution]
  (update-in state [:module-viewer :intents :mapped :procedures]
             (fn [procs]
               (mapv (fn [proc]
                       (update proc :intents resolve-gap-in-list gap-id resolution))
                     procs))))
