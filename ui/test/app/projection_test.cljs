(ns app.projection-test
  "Unit tests for the projection data layer.
   Test shape: build-projection → register-reaction → update-field → assert control-state.
   No UI mounting, no atoms, no Reagent — pure data in, pure data out."
  (:require [cljs.test :refer-macros [deftest is testing run-tests]]
            [app.projection :as projection]))

;; ============================================================
;; Test data — a minimal form definition
;; ============================================================

(def form-with-option-group
  "A form with an option group that controls which subform is visible."
  {:record-source "Orders"
   :header {:controls [{:name "OptionGroup1" :type :option-group :visible 1 :enabled 1}
                        {:name "SubformCustomers" :type :sub-form :visible 0 :enabled 1}
                        {:name "SubformOrders"    :type :sub-form :visible 0 :enabled 1}
                        {:name "SubformProducts"  :type :sub-form :visible 0 :enabled 1}]}
   :detail {:controls [{:name "CustomerID" :type :text-box :field "CustomerID" :visible 1 :enabled 1}
                        {:name "OrderDate"  :type :text-box :field "OrderDate"  :visible 1 :enabled 1}]}
   :footer {:controls []}})

(def form-with-toggle
  "A form where a checkbox toggles detail controls."
  {:record-source "Products"
   :header {:controls [{:name "chkShowPricing" :type :check-box :field "ShowPricing" :visible 1 :enabled 1}]}
   :detail {:controls [{:name "UnitPrice"    :type :text-box :field "UnitPrice"    :visible 0 :enabled 1}
                        {:name "lblPricing"   :type :label   :caption "Pricing"    :visible 0 :enabled 1}]}
   :footer {:controls []}})

;; ============================================================
;; ctrl->kw
;; ============================================================

(deftest ctrl->kw-test
  (testing "splits camelCase"
    (is (= :subform-customers (projection/ctrl->kw "SubformCustomers")))
    (is (= :option-group1     (projection/ctrl->kw "OptionGroup1")))
    (is (= :btn-save          (projection/ctrl->kw "BtnSave"))))

  (testing "lowercases plain names"
    (is (= :details (projection/ctrl->kw "Details")))
    (is (= :id      (projection/ctrl->kw "ID"))))

  (testing "replaces underscores"
    (is (= :btn-save-click (projection/ctrl->kw "btn_save_click"))))

  (testing "returns nil for nil/empty"
    (is (nil? (projection/ctrl->kw nil)))
    (is (nil? (projection/ctrl->kw "")))))

;; ============================================================
;; build-projection — seeds control-state from definition
;; ============================================================

(deftest build-projection-seeds-control-state
  (let [proj (projection/build-projection form-with-option-group)]

    (testing "all named controls have control-state entries"
      (is (some? (get-in proj [:control-state :option-group1])))
      (is (some? (get-in proj [:control-state :subform-customers])))
      (is (some? (get-in proj [:control-state :subform-orders])))
      (is (some? (get-in proj [:control-state :subform-products])))
      (is (some? (get-in proj [:control-state :customer-id])))
      (is (some? (get-in proj [:control-state :order-date]))))

    (testing "visible=1 in definition → :visible true in control-state"
      (is (true? (get-in proj [:control-state :option-group1 :visible]))))

    (testing "visible=0 in definition → :visible false in control-state"
      (is (false? (get-in proj [:control-state :subform-customers :visible])))
      (is (false? (get-in proj [:control-state :subform-orders    :visible])))
      (is (false? (get-in proj [:control-state :subform-products  :visible]))))

    (testing "reactions start empty"
      (is (= {} (:reactions proj))))))

;; ============================================================
;; register-reaction + update-field — the core test
;; ============================================================

(deftest reaction-fires-on-field-change
  (testing "option group → subform visibility"
    (let [proj (-> (projection/build-projection form-with-option-group)
                   ;; Register reactions: OptionGroup1 value controls which subform is visible
                   (projection/register-reaction :option-group1 :subform-customers :visible #(= % 1))
                   (projection/register-reaction :option-group1 :subform-orders    :visible #(= % 2))
                   (projection/register-reaction :option-group1 :subform-products  :visible #(= % 3)))]

      (testing "selecting option 1 shows Customers, hides others"
        (let [settled (projection/update-field proj :option-group1 1)]
          (is (true?  (get-in settled [:control-state :subform-customers :visible])))
          (is (false? (get-in settled [:control-state :subform-orders    :visible])))
          (is (false? (get-in settled [:control-state :subform-products  :visible])))))

      (testing "selecting option 2 shows Orders, hides others"
        (let [settled (projection/update-field proj :option-group1 2)]
          (is (false? (get-in settled [:control-state :subform-customers :visible])))
          (is (true?  (get-in settled [:control-state :subform-orders    :visible])))
          (is (false? (get-in settled [:control-state :subform-products  :visible])))))

      (testing "selecting option 3 shows Products"
        (let [settled (projection/update-field proj :option-group1 3)]
          (is (false? (get-in settled [:control-state :subform-customers :visible])))
          (is (false? (get-in settled [:control-state :subform-orders    :visible])))
          (is (true?  (get-in settled [:control-state :subform-products  :visible]))))))))

(deftest reaction-with-cases-value-fn
  (testing "value-fn derived from cases spec (as client would build it)"
    ;; This simulates what load-reactions-for-form! does with a cases spec:
    ;; {:trigger "option-group1" :ctrl "subform-customers" :prop "visible"
    ;;  :cases [{:when 1 :then true} {:when 2 :then false} {:when 3 :then false}]}
    (let [cases [{:when 1 :then true} {:when 2 :then false} {:when 3 :then false}]
          value-fn (fn [v _]
                     (let [match (first (filter #(= v (:when %)) cases))]
                       (when (some? match) (:then match))))
          proj (-> (projection/build-projection form-with-option-group)
                   (projection/register-reaction :option-group1 :subform-customers :visible value-fn))]

      (is (true?  (get-in (projection/update-field proj :option-group1 1)
                           [:control-state :subform-customers :visible])))
      (is (false? (get-in (projection/update-field proj :option-group1 2)
                           [:control-state :subform-customers :visible]))))))

(deftest checkbox-toggle-reaction
  (testing "checkbox controls multiple control visibilities"
    (let [proj (-> (projection/build-projection form-with-toggle)
                   (projection/register-reaction :chk-show-pricing :unit-price  :visible identity)
                   (projection/register-reaction :chk-show-pricing :lbl-pricing :visible identity))]

      (testing "checking box reveals pricing controls"
        (let [settled (projection/update-field proj :chk-show-pricing true)]
          (is (true? (get-in settled [:control-state :unit-price  :visible])))
          (is (true? (get-in settled [:control-state :lbl-pricing :visible])))))

      (testing "unchecking hides them"
        (let [settled (projection/update-field proj :chk-show-pricing false)]
          (is (false? (get-in settled [:control-state :unit-price  :visible])))
          (is (false? (get-in settled [:control-state :lbl-pricing :visible]))))))))

(deftest field-update-recorded-in-record
  (testing "update-field writes the value into :record"
    (let [proj    (projection/build-projection form-with-option-group)
          settled (projection/update-field proj :customer-id 42)]
      (is (= 42 (get-in settled [:record :customer-id]))))))

;; ============================================================
;; set-control-state — direct projection mutation
;; ============================================================

(deftest set-control-state-test
  (testing "directly set visibility on a control"
    (let [proj    (projection/build-projection form-with-option-group)
          updated (projection/set-control-state proj :subform-customers :visible true)]
      (is (true? (get-in updated [:control-state :subform-customers :visible])))))

  (testing "set caption"
    (let [proj    (projection/build-projection form-with-option-group)
          updated (projection/set-control-state proj :option-group1 :caption "Mode")]
      (is (= "Mode" (get-in updated [:control-state :option-group1 :caption]))))))
