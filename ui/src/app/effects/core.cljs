(ns app.effects.core
  "Effect dispatcher — routes effect descriptors to the appropriate executor.

   Usage:
     (execute! {:type :http :method :get :url \"/api/tables\" :headers (db-headers)})
     ;; => returns channel with {:ok? true :data {...}}

     (execute! {:type :dom :method :alert :message \"Saved!\"})
     ;; => returns nil (synchronous)

   Or use the named convenience function:
     (execute-named! :fetch-tables {:headers (db-headers)})
     ;; => builds the descriptor from the catalog and executes it"
  (:require [app.effects.http :as http]
            [app.effects.dom :as dom]
            [app.effects.catalog :as catalog]
            [app.state :refer [api-base]]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]))

(defn execute!
  "Execute an effect descriptor. HTTP effects return a channel with
   {:ok? :data :status}. DOM effects execute synchronously."
  [{:keys [type method] :as descriptor}]
  (case type
    :http (http/execute descriptor)
    :dom  (case method
            :alert   (dom/alert! (:message descriptor))
            :confirm (dom/confirm! (:message descriptor))
            :prompt  (dom/prompt! (:message descriptor) (:default descriptor)))
    (throw (ex-info (str "Unknown effect type: " type)
                    {:descriptor descriptor}))))

(defn- resolve-url
  "Replace :param placeholders in a URL pattern with actual values.
   E.g. (resolve-url \"/api/forms/:filename\" {:filename \"my_form\"})
        => \"/api/forms/my_form\"
   Values are URI-encoded."
  [url-pattern params]
  (reduce-kv
    (fn [url k v]
      (str/replace url (str ":" (name k)) (js/encodeURIComponent (str v))))
    url-pattern
    params))

(defn execute-named!
  "Execute a named effect from the catalog.

   url-params: map of {:param-name value} for URL :param placeholders
   opts: {:headers map :query-params map :json-params map}

   Returns a channel with {:ok? :data :status}.

   Example:
     (execute-named! :fetch-form {:filename \"my_form\"} {:headers (db-headers)})"
  ([effect-name]
   (execute-named! effect-name {} {}))
  ([effect-name url-params]
   (execute-named! effect-name url-params {}))
  ([effect-name url-params opts]
   (if-let [effect (catalog/effect-by-name effect-name)]
     (let [url (str api-base (resolve-url (:url effect) url-params))]
       (http/execute (merge {:method (:method effect) :url url} opts)))
     (throw (ex-info (str "Unknown effect: " effect-name)
                     {:effect effect-name})))))

(defn effect-count
  "Return the total number of cataloged effects."
  []
  (+ (count catalog/http-effects) (count catalog/dom-effects)))
