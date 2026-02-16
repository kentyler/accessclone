(ns app.transforms.query
  "Pure query transforms — (state, args) -> state.
   2 transforms covering SQL editing and query naming.")

(defn update-query-sql [state sql]
  (assoc-in state [:query-viewer :sql] sql))

(defn update-query-name [state name]
  (assoc-in state [:query-viewer :pending-name] name))
