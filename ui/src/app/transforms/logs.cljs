(ns app.transforms.logs
  "Pure logs transforms — (state, args) -> state.
   1 transform covering log filter updates.")

(defn set-logs-filter [state filter-key value]
  (assoc-in state [:logs-filter filter-key] value))
