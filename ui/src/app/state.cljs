(ns app.state
  "Application state management"
  (:require [reagent.core :as r]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [cljs.reader :as reader]
            [clojure.string :as str]))

;; Application state atom
(defonce app-state
  (r/atom {;; App info (set during deployment)
           :app-name "Application"
           :database-name "app_db"

           ;; UI state
           :loading? false
           :error nil

           ;; Sidebar state
           :sidebar-collapsed? false
           :sidebar-object-type :forms

           ;; Objects by type (loaded from database)
           :objects {:tables []
                     :queries []
                     :forms []
                     :reports []
                     :macros []
                     :modules []}

           ;; Open objects (tabs)
           :open-objects []  ; [{:type :forms :id 1 :name "CustomerForm"} ...]
           :active-tab nil   ; {:type :forms :id 1}

           ;; Form editor state
           :form-editor {:dirty? false
                         :original nil
                         :current nil
                         :selected-control nil}  ; index of selected control

           ;; Form runtime state (when viewing a form)
           :form-data {}
           :form-session nil}))

;; Loading/Error
(defn set-loading! [loading?]
  (swap! app-state assoc :loading? loading?))

(defn set-error! [error]
  (swap! app-state assoc :error error))

(defn clear-error! []
  (swap! app-state assoc :error nil))

;; Sidebar
(defn toggle-sidebar! []
  (swap! app-state update :sidebar-collapsed? not))

(defn set-sidebar-object-type! [object-type]
  (swap! app-state assoc :sidebar-object-type object-type))

;; Objects
(defn set-objects! [object-type objects]
  (swap! app-state assoc-in [:objects object-type] objects))

(defn add-object! [object-type obj]
  (swap! app-state update-in [:objects object-type] conj obj))

(defn update-object! [object-type id updates]
  (swap! app-state update-in [:objects object-type]
         (fn [objects]
           (mapv (fn [obj]
                   (if (= (:id obj) id)
                     (merge obj updates)
                     obj))
                 objects))))

;; Tabs
(defn open-object!
  "Open an object in a new tab (or switch to existing tab)"
  [object-type object-id]
  (let [tab {:type object-type :id object-id}
        current-open (:open-objects @app-state)
        already-open? (some #(and (= (:type %) object-type)
                                  (= (:id %) object-id))
                            current-open)]
    (when-not already-open?
      (let [obj (first (filter #(= (:id %) object-id)
                               (get-in @app-state [:objects object-type])))]
        (swap! app-state update :open-objects conj
               (assoc tab :name (:name obj)))))
    (swap! app-state assoc :active-tab tab)))

(defn close-tab!
  "Close a tab"
  [object-type object-id]
  (let [tab-to-close {:type object-type :id object-id}
        current-open (:open-objects @app-state)
        new-open (vec (remove #(and (= (:type %) object-type)
                                    (= (:id %) object-id))
                              current-open))
        active (:active-tab @app-state)]
    (swap! app-state assoc :open-objects new-open)
    ;; If we closed the active tab, switch to another
    (when (and (= (:type active) object-type)
               (= (:id active) object-id))
      (swap! app-state assoc :active-tab
             (when (seq new-open)
               {:type (:type (last new-open))
                :id (:id (last new-open))})))))

(defn set-active-tab! [object-type object-id]
  (swap! app-state assoc :active-tab {:type object-type :id object-id}))

;; Form creation
(defn create-new-form! []
  (let [existing-forms (get-in @app-state [:objects :forms])
        new-id (inc (reduce max 0 (map :id existing-forms)))
        new-form {:id new-id
                  :name (str "Form" new-id)
                  :definition {:type :form
                               :record-source nil
                               :controls []}}]
    (add-object! :forms new-form)
    (open-object! :forms new-id)))

;; Form editor
(defn set-form-definition! [definition]
  (swap! app-state assoc-in [:form-editor :current] definition)
  (swap! app-state assoc-in [:form-editor :dirty?]
         (not= definition (get-in @app-state [:form-editor :original]))))

(defn save-form! []
  (let [current (get-in @app-state [:form-editor :current])
        active (:active-tab @app-state)]
    (when (and active (= (:type active) :forms))
      ;; Update the form in objects list
      (update-object! :forms (:id active) {:definition current})
      ;; Update the tab name if form name changed
      (swap! app-state update :open-objects
             (fn [tabs]
               (mapv (fn [tab]
                       (if (and (= (:type tab) :forms)
                                (= (:id tab) (:id active)))
                         (assoc tab :name (:name current))
                         tab))
                     tabs)))
      ;; Mark as clean
      (swap! app-state assoc-in [:form-editor :dirty?] false)
      (swap! app-state assoc-in [:form-editor :original] current)
      ;; Save to EDN file (logs for now - needs backend)
      (let [form (first (filter #(= (:id %) (:id active))
                                (get-in @app-state [:objects :forms])))]
        (save-form-to-file! form)))))

(defn load-form-for-editing! [form]
  ;; Auto-save current form if dirty before loading new one
  (when (get-in @app-state [:form-editor :dirty?])
    (save-form!))
  (swap! app-state assoc :form-editor
         {:dirty? false
          :original (:definition form)
          :current (:definition form)
          :selected-control nil}))

(defn select-control! [idx]
  (swap! app-state assoc-in [:form-editor :selected-control] idx))

(defn delete-control! [idx]
  (let [form-editor (:form-editor @app-state)
        current (:current form-editor)
        controls (or (:controls current) [])]
    (when (< idx (count controls))
      (let [new-controls (vec (concat (subvec controls 0 idx)
                                      (subvec controls (inc idx))))]
        (swap! app-state assoc-in [:form-editor :selected-control] nil)
        (set-form-definition! (assoc current :controls new-controls))))))

;; Form file operations
(defn load-form-file!
  "Load a single form from an EDN file"
  [filename]
  (go
    (let [response (<! (http/get (str "/forms/" filename ".edn")))]
      (when (:success response)
        (try
          (let [form-data (reader/read-string (:body response))]
            ;; Add to forms list, using filename as fallback for missing fields
            (swap! app-state update-in [:objects :forms] conj
                   {:id (:id form-data)
                    :name (:name form-data)
                    :filename filename
                    :definition (dissoc form-data :id :name)}))
          (catch :default e
            (println "Error parsing form" filename ":" e)))))))

(defn load-forms-from-index!
  "Load all forms listed in _index.edn"
  []
  (go
    (let [response (<! (http/get "/forms/_index.edn"))]
      (if (:success response)
        (try
          (let [form-names (reader/read-string (:body response))]
            (println "Loading forms:" form-names)
            (doseq [form-name form-names]
              (load-form-file! form-name)))
          (catch :default e
            (println "Error parsing form index:" e)))
        (println "Could not load form index - using empty forms list")))))

(def api-base "http://localhost:3001")

(defn save-form-to-file!
  "Save a form to its EDN file via backend API"
  [form]
  (let [filename (or (:filename form)
                     (-> (:name form)
                         (str/lower-case)
                         (str/replace #"\s+" "_")))
        form-data (merge {:id (:id form)
                          :name (:name form)}
                         (:definition form))]
    (go
      (let [response (<! (http/put (str api-base "/api/forms/" filename)
                                   {:json-params form-data}))]
        (if (:success response)
          (do
            (println "Saved form:" filename)
            ;; Update the form's filename in state
            (swap! app-state update-in [:objects :forms]
                   (fn [forms]
                     (mapv (fn [f]
                             (if (= (:id f) (:id form))
                               (assoc f :filename filename)
                               f))
                           forms))))
          (do
            (println "Error saving form:" (:body response))
            (set-error! (str "Failed to save form: " (get-in response [:body :error])))))))))

;; Initialize - load objects from files and database
(defn init! []
  ;; Load forms from EDN files
  (load-forms-from-index!)

  ;; Tables and queries still come from database metadata (hardcoded for now)
  ;; TODO: Load from PostgreSQL information_schema
  (swap! app-state assoc-in [:objects :tables]
         [{:id 1 :name "recipe"
           :fields [{:name "id" :type "integer" :pk true}
                    {:name "name" :type "text"}
                    {:name "description" :type "text"}
                    {:name "created_at" :type "timestamp"}]}
          {:id 2 :name "recipe_ingredient"
           :fields [{:name "id" :type "integer" :pk true}
                    {:name "recipe_id" :type "integer" :fk "recipe"}
                    {:name "ingredient_id" :type "integer" :fk "ingredient"}
                    {:name "grams" :type "numeric"}
                    {:name "percentage" :type "numeric"}]}
          {:id 3 :name "ingredient"
           :fields [{:name "id" :type "integer" :pk true}
                    {:name "name" :type "text"}
                    {:name "description" :type "text"}
                    {:name "cost_per_gram" :type "numeric"}]}
          {:id 4 :name "ingredient_test"
           :fields [{:name "id" :type "integer" :pk true}
                    {:name "ingredient_id" :type "integer" :fk "ingredient"}
                    {:name "test_date" :type "date"}
                    {:name "potency" :type "numeric"}]}
          {:id 5 :name "product"
           :fields [{:name "id" :type "integer" :pk true}
                    {:name "name" :type "text"}
                    {:name "sku" :type "text"}
                    {:name "price" :type "numeric"}]}
          {:id 6 :name "carrier"
           :fields [{:name "id" :type "integer" :pk true}
                    {:name "name" :type "text"}
                    {:name "type" :type "text"}]}])
  (swap! app-state assoc-in [:objects :queries]
         [{:id 1 :name "ingredient_with_total_grams_on_hand"
           :fields [{:name "id" :type "integer"}
                    {:name "name" :type "text"}
                    {:name "total_grams" :type "numeric"}
                    {:name "cost_per_gram" :type "numeric"}]}
          {:id 2 :name "recipe_candidates_temp"
           :fields [{:name "recipe_id" :type "integer"}
                    {:name "ingredient_combo" :type "text"}
                    {:name "total_cost" :type "numeric"}]}])
  (println "Application state initialized - forms loading from EDN files"))
