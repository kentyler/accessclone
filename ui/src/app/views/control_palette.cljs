(ns app.views.control-palette
  "Shared control palette toolbar for form and report Design Views.
   Provides a horizontal toolbar of control-type buttons. Clicking a button
   sets an active tool; clicking in a section body places a new control.
   Forms and reports have different tool sets — reports are display-only
   and don't include interactive controls like buttons or combo boxes."
  (:require [reagent.core :as r]))

;; nil = select/pointer mode; :text-box, :label, etc = placement mode
(def palette-tool (r/atom nil))

(def ^:private pointer-item
  {:type nil :icon "\u2196" :label "Select (Pointer)" :group :select})

(def form-palette-items
  "Control types for form Design View."
  [pointer-item
   ;; Text & Input
   {:type :label     :icon "Aa"      :label "Label"         :group :text}
   {:type :text-box  :icon "ab|"     :label "Text Box"      :group :text}
   {:type :combo-box :icon "\u25BE"  :label "Combo Box"     :group :text}
   {:type :list-box  :icon "\u2261"  :label "List Box"      :group :text}
   ;; Buttons & Toggles
   {:type :button        :icon "\u25A2" :label "Button"        :group :buttons}
   {:type :check-box     :icon "\u2610" :label "Check Box"     :group :buttons}
   {:type :option-group  :icon "\u25C9" :label "Option Group"  :group :buttons}
   {:type :option-button :icon "\u25CB" :label "Option Button" :group :buttons}
   {:type :toggle-button :icon "\u229E" :label "Toggle Button" :group :buttons}
   ;; Containers & Layout
   {:type :tab-control :icon "\u25AD" :label "Tab Control" :group :containers}
   {:type :subform     :icon "\u22A1" :label "Subform"     :group :containers}
   ;; Graphics
   {:type :image     :icon "\uD83D\uDDBC" :label "Image"     :group :graphics}
   {:type :line      :icon "\u2500"        :label "Line"      :group :graphics}
   {:type :rectangle :icon "\u25A1"        :label "Rectangle" :group :graphics}])

(def report-palette-items
  "Control types for report Design View.
   Reports are display-only — no buttons, combo/list boxes, option groups, etc."
  [pointer-item
   ;; Text
   {:type :label    :icon "Aa"      :label "Label"    :group :text}
   {:type :text-box :icon "ab|"     :label "Text Box" :group :text}
   ;; Display-only controls
   {:type :check-box :icon "\u2610" :label "Check Box" :group :display}
   ;; Graphics
   {:type :image     :icon "\uD83D\uDDBC" :label "Image"     :group :graphics}
   {:type :line      :icon "\u2500"        :label "Line"      :group :graphics}
   {:type :rectangle :icon "\u25A1"        :label "Rectangle" :group :graphics}
   ;; Report-specific
   {:type :page-break :icon "\u2507" :label "Page Break" :group :report}
   {:type :subreport  :icon "\u22A1" :label "Subreport"  :group :report}])

(defn control-defaults
  "Return a blank control map with type-specific default properties."
  [control-type x y]
  (let [base {:type control-type :x x :y y}]
    (case control-type
      :label         (merge base {:width 100 :height 18 :text "Label"})
      :text-box      (merge base {:width 150 :height 24})
      :combo-box     (merge base {:width 150 :height 24})
      :list-box      (merge base {:width 150 :height 80})
      :button        (merge base {:width 80  :height 28 :caption "Button"})
      :check-box     (merge base {:width 80  :height 20})
      :option-group  (merge base {:width 150 :height 80})
      :option-button (merge base {:width 80  :height 20})
      :toggle-button (merge base {:width 80  :height 24})
      :tab-control   (merge base {:width 300 :height 200})
      :subform       (merge base {:width 300 :height 200})
      :subreport     (merge base {:width 300 :height 200})
      :image         (merge base {:width 100 :height 100})
      :line          (merge base {:width 150 :height 2})
      :rectangle     (merge base {:width 150 :height 80})
      :page-break    (merge base {:width 150 :height 2})
      ;; fallback
      (merge base {:width 150 :height 24}))))

(defn- palette-btn
  "A single palette button. Clicking selects the tool; dragging onto a
   section body places a new control at the drop point."
  [{:keys [type icon label]}]
  (let [active? (= type @palette-tool)]
    [:button.palette-btn
     {:class (when active? "active")
      :title label
      :draggable (some? type)
      :on-drag-start (fn [e]
                       (when type
                         (.setData (.-dataTransfer e) "application/x-palette-type" (name type))))
      :on-click (fn [e]
                  (.stopPropagation e)
                  (reset! palette-tool (when-not active? type)))}
     [:span.palette-icon icon]]))

(defn control-palette
  "Horizontal toolbar of control-type buttons for Design View.
   mode — :form (default) or :report — selects which tool set to show."
  ([] (control-palette :form))
  ([mode]
   (let [items (if (= mode :report) report-palette-items form-palette-items)
         groups (partition-by :group items)]
     [:div.control-palette
      (for [[gi group] (map-indexed vector groups)]
        ^{:key gi}
        [:<>
         (when (pos? gi) [:span.palette-separator])
         (for [item group]
           ^{:key (or (:type item) :select)}
           [palette-btn item])])])))
