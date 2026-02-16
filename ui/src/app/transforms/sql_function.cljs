(ns app.transforms.sql-function
  "Pure SQL function transforms — (state, args) -> state.
   3 transforms covering source editing, name editing, and function tracking.")

(defn update-fn-source [state source]
  (assoc-in state [:sql-function-viewer :info :source] source))

(defn update-fn-name [state name]
  (assoc-in state [:sql-function-viewer :info :name] name))

(defn track-sql-function [state fn-data]
  (assoc state :sql-function-viewer {:fn-id (:id fn-data) :info fn-data}))
