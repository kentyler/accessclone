(ns app.views.llm-registry
  "LLM Registry — manage registered LLMs, designate secretary.
   Registry stored in config.json under :llm-registry key."
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.ui :as ui-flow]))

;; ============================================================
;; HELPERS
;; ============================================================

(defn- generate-id [name]
  (-> name
      str/lower-case
      str/trim
      (str/replace #"[^a-z0-9]+" "-")
      (str/replace #"^-|-$" "")))

(defn- get-registry []
  (get-in @state/app-state [:config :llm-registry] []))

(defn- save-registry! [registry]
  (swap! state/app-state assoc-in [:config :llm-registry] registry)
  (f/run-fire-and-forget! ui-flow/save-config-flow))

(def empty-form
  {:name ""
   :provider "anthropic"
   :model_id ""
   :description ""
   :max_tokens "2048"
   :temperature "1.0"})

;; ============================================================
;; MODEL CARD
;; ============================================================

(defn- model-card [model editing-id on-edit on-delete on-secretary]
  (let [is-editing? (= (:id model) @editing-id)]
    [:div.llm-card {:class (when (:is_secretary model) "secretary")}
     [:div.llm-card-header
      [:div.llm-card-title
       [:span.llm-card-name (:name model)]
       (when (:is_secretary model)
         [:span.secretary-badge "Secretary"])]
      [:div.llm-card-actions
       (when-not (:is_secretary model)
         [:button.llm-action-btn
          {:on-click #(on-secretary (:id model))
           :title "Make secretary"}
          "\u2606"])
       [:button.llm-action-btn
        {:on-click #(on-edit model)
         :title "Edit"}
        "\u270E"]
       [:button.llm-action-btn.delete
        {:on-click #(on-delete (:id model))
         :title "Delete"}
        "\u00D7"]]]
     [:div.llm-card-body
      [:div.llm-card-detail
       [:span.llm-card-label "Provider"] [:span (:provider model)]]
      [:div.llm-card-detail
       [:span.llm-card-label "Model"] [:span (:model_id model)]]
      (when (seq (:description model))
        [:div.llm-card-detail
         [:span.llm-card-label "Description"] [:span (:description model)]])
      [:div.llm-card-detail
       [:span.llm-card-label "Status"]
       [:span {:class (if (:enabled model) "enabled-text" "disabled-text")}
        (if (:enabled model) "Enabled" "Disabled")]]]]))

;; ============================================================
;; ADD/EDIT FORM
;; ============================================================

(defn- model-form [form-state editing-id on-save on-cancel]
  [:div.llm-form
   [:div.llm-form-header
    (if @editing-id "Edit Model" "Add Model")]
   [:div.llm-form-fields
    [:div.llm-form-row
     [:label "Name"]
     [:input {:type "text"
              :value (:name @form-state)
              :placeholder "e.g. Claude Sonnet"
              :on-change #(swap! form-state assoc :name (.. % -target -value))}]]
    [:div.llm-form-row
     [:label "Provider"]
     [:select {:value (:provider @form-state)
               :on-change #(swap! form-state assoc :provider (.. % -target -value))}
      [:option {:value "anthropic"} "Anthropic"]
      [:option {:value "openai"} "OpenAI"]]]
    [:div.llm-form-row
     [:label "Model ID"]
     [:input {:type "text"
              :value (:model_id @form-state)
              :placeholder "e.g. claude-sonnet-4-20250514"
              :on-change #(swap! form-state assoc :model_id (.. % -target -value))}]]
    [:div.llm-form-row
     [:label "Description"]
     [:input {:type "text"
              :value (:description @form-state)
              :placeholder "What this model is good at"
              :on-change #(swap! form-state assoc :description (.. % -target -value))}]]
    [:div.llm-form-row-pair
     [:div.llm-form-row
      [:label "Max Tokens"]
      [:input {:type "number"
               :value (:max_tokens @form-state)
               :on-change #(swap! form-state assoc :max_tokens (.. % -target -value))}]]
     [:div.llm-form-row
      [:label "Temperature"]
      [:input {:type "number"
               :value (:temperature @form-state)
               :step "0.1"
               :min "0"
               :max "2"
               :on-change #(swap! form-state assoc :temperature (.. % -target -value))}]]]]
   [:div.llm-form-actions
    [:button.primary-btn {:on-click on-save
                          :disabled (or (str/blank? (:name @form-state))
                                        (str/blank? (:model_id @form-state)))}
     (if @editing-id "Update" "Add")]
    [:button.secondary-btn {:on-click on-cancel} "Cancel"]]])

;; ============================================================
;; REGISTRY PAGE
;; ============================================================

(defn llm-registry-page []
  (let [form-state (r/atom empty-form)
        editing-id (r/atom nil)
        show-form? (r/atom false)]
    (fn []
      (let [registry (get-registry)]
        [:div.llm-registry-wrapper
         [:a.back-to-hub {:on-click #(swap! state/app-state assoc :current-page :hub)}
          "\u2190 Back to Hub"]
         [:div.llm-registry-page
          [:div.llm-registry-header
           [:h2 "LLM Registry"]
           [:button.primary-btn
            {:on-click (fn []
                         (reset! form-state empty-form)
                         (reset! editing-id nil)
                         (reset! show-form? true))}
            "Add Model"]]

          ;; Model cards
          [:div.llm-card-list
           (if (empty? registry)
             [:div.llm-empty
              "No models registered. Add a model to enable multi-LLM routing for notes."
              [:div.llm-empty-hint "Without registered models, Notes will use Claude Sonnet as fallback."]]
             (for [model registry]
               ^{:key (:id model)}
               [model-card model editing-id
                ;; on-edit
                (fn [m]
                  (reset! form-state {:name (:name m)
                                      :provider (:provider m)
                                      :model_id (:model_id m)
                                      :description (or (:description m) "")
                                      :max_tokens (str (get-in m [:config :max_tokens] 2048))
                                      :temperature (str (get-in m [:config :temperature] 1.0))})
                  (reset! editing-id (:id m))
                  (reset! show-form? true))
                ;; on-delete
                (fn [id]
                  (save-registry! (vec (remove #(= (:id %) id) registry))))
                ;; on-secretary
                (fn [id]
                  (save-registry!
                   (mapv (fn [m]
                           (assoc m :is_secretary (= (:id m) id)))
                         registry)))]))]

          ;; Add/Edit form
          (when @show-form?
            [model-form form-state editing-id
             ;; on-save
             (fn []
               (let [f @form-state
                     id (or @editing-id (generate-id (:name f)))
                     entry {:id id
                            :name (:name f)
                            :provider (:provider f)
                            :model_id (:model_id f)
                            :description (:description f)
                            :is_secretary (if @editing-id
                                            ;; Preserve existing secretary status on edit
                                            (boolean (:is_secretary (first (filter #(= (:id %) @editing-id) registry))))
                                            ;; First model added becomes secretary
                                            (empty? registry))
                            :enabled true
                            :config {:max_tokens (js/parseInt (:max_tokens f) 10)
                                     :temperature (js/parseFloat (:temperature f))}}
                     new-registry (if @editing-id
                                    (mapv (fn [m] (if (= (:id m) @editing-id) entry m)) registry)
                                    (conj (vec registry) entry))]
                 (save-registry! new-registry)
                 (reset! form-state empty-form)
                 (reset! editing-id nil)
                 (reset! show-form? false)))
             ;; on-cancel
             (fn []
               (reset! form-state empty-form)
               (reset! editing-id nil)
               (reset! show-form? false))])]]))))
