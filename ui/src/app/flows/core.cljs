(ns app.flows.core
  "Flow runner — executes sequences of transforms and effects.

   A flow is a vector of steps. Each step is a map with :step key:

   :transform — apply a pure state transform via dispatch!
     {:step :transform :name :set-loading :args [true]}
     {:step :transform :name :set-objects :args-fn (fn [ctx] [:tables (:data ctx)])}

   :effect — execute an async effect, store result in context
     {:step :effect :name :fetch-tables :url-params {} :opts {} :as :tables-result}
     {:step :effect :descriptor {:type :http ...} :as :result}

   :branch — conditional execution based on context
     {:step :branch :test (fn [ctx] boolean) :then [steps] :else [steps]}

   :do — escape hatch for complex logic (fn receives ctx, returns ctx or channel of ctx)
     {:step :do :fn (fn [ctx] ...)}

   The runner maintains a context map that accumulates effect results.
   Transforms read/write app-state via the atom. Effects produce data
   stored in the context under their :as key (or :last-result)."
  (:require [app.transforms.core :as transforms]
            [app.effects.core :as effects]
            [cljs.core.async :refer [go <!]]
            [cljs.core.async.impl.protocols :as async-proto]))

(defn- channel? [x]
  (satisfies? async-proto/ReadPort x))

(defn- resolve-args
  "Resolve step arguments: use :args-fn if present (called with ctx),
   otherwise use :args (default [])."
  [step ctx]
  (if-let [f (:args-fn step)]
    (f ctx)
    (or (:args step) [])))

(declare run!)

(defn- execute-step!
  "Execute a single flow step. Returns a channel yielding the updated context."
  [step ctx]
  (go
    (case (:step step)
      ;; Pure state transform — dispatched synchronously
      :transform
      (do (apply transforms/dispatch! (:name step) (resolve-args step ctx))
          ctx)

      ;; Async effect — execute and store result in context
      :effect
      (let [result (if (:descriptor step)
                     (<! (effects/execute! (:descriptor step)))
                     (<! (effects/execute-named!
                           (:name step)
                           (or (:url-params step) {})
                           (let [opts-fn (:opts-fn step)
                                 opts    (:opts step)]
                             (if opts-fn (opts-fn ctx) (or opts {}))))))]
        (cond-> (assoc ctx :last-result result)
          (:as step) (assoc (:as step) result)))

      ;; Conditional branching
      :branch
      (let [test-result ((:test step) ctx)]
        (if test-result
          (<! (run! (or (:then step) []) ctx))
          (<! (run! (or (:else step) []) ctx))))

      ;; Escape hatch — arbitrary function
      :do
      (let [result ((:fn step) ctx)]
        (if (channel? result)
          (<! result)
          result))

      ;; Unknown step type
      (do (js/console.warn "Unknown flow step type:" (:step step))
          ctx))))

(defn run!
  "Execute a flow (vector of steps) sequentially.
   Returns a channel yielding the final context map.

   Usage:
     (go (let [result (<! (run! my-flow))]
           (println :done result)))

     ;; With initial context:
     (run! my-flow {:form-id 42 :filename \"my_form\"})"
  ([flow-steps]
   (run! flow-steps {}))
  ([flow-steps initial-ctx]
   (go
     (loop [steps flow-steps
            ctx   initial-ctx]
       (if (empty? steps)
         ctx
         (let [ctx' (<! (execute-step! (first steps) ctx))]
           (recur (rest steps) ctx')))))))

(defn run-fire-and-forget!
  "Run a flow without waiting for the result.
   Useful for fire-and-forget operations like save-ui-state."
  ([flow-steps]
   (run! flow-steps {}))
  ([flow-steps initial-ctx]
   (run! flow-steps initial-ctx)))
