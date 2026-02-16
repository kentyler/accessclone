(ns app.effects.http
  "HTTP effect executor.

   Takes an effect descriptor and returns a channel with a normalized result:
   {:ok? boolean :data map :status number}

   Effect descriptor shape:
   {:method  :get|:post|:put|:delete|:patch
    :url     string (full URL)
    :headers map (optional)
    :query-params map (optional, for GET)
    :json-params  map (optional, for POST/PUT/PATCH)}"
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

(defn execute
  "Execute an HTTP effect descriptor. Returns a channel with
   {:ok? boolean :data map :status number :raw response}."
  [{:keys [method url headers query-params json-params]}]
  (go
    (let [opts (cond-> {}
                 headers      (assoc :headers headers)
                 query-params (assoc :query-params query-params)
                 json-params  (assoc :json-params json-params))
          response (<! (case method
                         :get    (http/get url opts)
                         :post   (http/post url opts)
                         :put    (http/put url opts)
                         :delete (http/delete url opts)
                         :patch  (http/patch url opts)
                         (throw (ex-info (str "Unknown HTTP method: " method)
                                         {:method method}))))]
      {:ok?    (:success response)
       :data   (:body response)
       :status (:status response)
       :raw    response})))

(defn get!
  "Convenience: execute a GET request."
  [url & {:keys [headers query-params]}]
  (execute {:method :get :url url :headers headers :query-params query-params}))

(defn post!
  "Convenience: execute a POST request."
  [url & {:keys [headers json-params query-params]}]
  (execute {:method :post :url url :headers headers
            :json-params json-params :query-params query-params}))

(defn put!
  "Convenience: execute a PUT request."
  [url & {:keys [headers json-params]}]
  (execute {:method :put :url url :headers headers :json-params json-params}))

(defn delete!
  "Convenience: execute a DELETE request."
  [url & {:keys [headers]}]
  (execute {:method :delete :url url :headers headers}))

(defn patch!
  "Convenience: execute a PATCH request."
  [url & {:keys [headers json-params]}]
  (execute {:method :patch :url url :headers headers :json-params json-params}))
