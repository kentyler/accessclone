(ns app.views.form-view
  "Form view mode - live data entry with record navigation"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.state-form :as state-form]
            [app.flows.core :as f]
            [app.flows.form :as form-flow]
            [app.flows.navigation :as nav]
            [app.views.form-utils :as fu]
            [app.views.expressions :as expr]
            [app.projection :as projection]
            [clojure.string :as str]))

(declare show-record-menu form-view-control)

(defn- sort-by-tab-index
  "Sort controls by :tab-index for correct tab order.
   Controls with :tab-index come first (ascending), then those without."
  [controls]
  (sort-by (fn [c] (or (:tab-index c) 99999)) controls))

;; ============================================================
;; INDIVIDUAL CONTROL RENDERERS
;; ============================================================

(defn render-label [ctrl _field _value _on-change _opts]
  [:span.view-label (fu/display-text ctrl)])

(defn render-textbox [ctrl field value on-change {:keys [auto-focus? is-new? allow-edits? tab-idx]}]
  (let [mask (fu/parse-input-mask (:input-mask ctrl))
        password? (= "password" (some-> (:input-mask ctrl) str/lower-case str/trim))
        placeholder (when mask (fu/mask-placeholder (:pattern mask) (:placeholder-char mask)))
        max-len (when placeholder (count placeholder))]
    [:input.view-input
     (cond-> {:type (if password? "password" "text")
              :value value :read-only (not allow-edits?)
              :auto-focus (and is-new? auto-focus?)
              :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}
       tab-idx (assoc :tab-index tab-idx)
       placeholder (assoc :placeholder placeholder)
       max-len (assoc :max-length max-len))]))

;; --- Button action resolution ---

(defn- resolve-action-from-prop
  "Resolve on-click from an explicit :on-click property (map or string)."
  [on-click-prop]
  (cond
    (and (map? on-click-prop) (:action on-click-prop))
    (case (keyword (:action on-click-prop))
      :save-record   #(f/run-fire-and-forget! form-flow/save-current-record-flow)
      :new-record    #(t/dispatch! :new-record)
      :delete-record #(when (js/confirm "Delete this record?") (f/run-fire-and-forget! form-flow/delete-current-record-flow))
      :close-form    #(f/run-fire-and-forget! nav/close-current-tab-flow)
      :refresh       #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :view})
      #(js/alert (str "Unknown action: " (:action on-click-prop))))

    (and (map? on-click-prop) (:function on-click-prop))
    #(f/run-fire-and-forget! (form-flow/call-session-function-flow) {:function-name (:function on-click-prop)})

    (and (string? on-click-prop) (not (str/blank? on-click-prop)))
    #(f/run-fire-and-forget! (form-flow/call-session-function-flow) {:function-name on-click-prop})

    :else nil))

(defn- resolve-action-from-caption
  "Resolve on-click from button caption text as a fallback."
  [text-lower button-text]
  (cond
    (or (= text-lower "close") (str/includes? text-lower "close form"))
    #(f/run-fire-and-forget! nav/close-current-tab-flow)
    (or (= text-lower "save") (str/includes? text-lower "save record"))
    #(f/run-fire-and-forget! form-flow/save-current-record-flow)
    (or (= text-lower "new record") (= text-lower "new") (str/includes? text-lower "add new"))
    #(t/dispatch! :new-record)
    (or (= text-lower "delete") (= text-lower "delete record"))
    #(when (js/confirm "Delete this record?") (f/run-fire-and-forget! form-flow/delete-current-record-flow))
    (or (= text-lower "refresh") (= text-lower "requery"))
    #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :view})
    :else
    #(js/alert (str "Button clicked: " button-text))))

(defn- resolve-button-action [ctrl]
  (let [button-text (fu/strip-access-hotkey (or (:text ctrl) (:caption ctrl) "Button"))]
    (or (resolve-action-from-prop (:on-click ctrl))
        (resolve-action-from-caption (str/lower-case button-text) button-text))))

(defn render-button [ctrl _field _value _on-change {:keys [tab-idx]}]
  [:button.view-button
   (cond-> {:on-click (resolve-button-action ctrl)}
     tab-idx (assoc :tab-index tab-idx))
   (fu/render-hotkey-text (or (:text ctrl) (:caption ctrl) "Button"))])

(defn render-checkbox [ctrl field value on-change {:keys [allow-edits? tab-idx]}]
  [:label.view-checkbox
   [:input (cond-> {:type "checkbox" :checked (boolean value) :disabled (not allow-edits?)
                    :on-change #(when (and field allow-edits?) (on-change field (.. % -target -checked)))}
             tab-idx (assoc :tab-index tab-idx))]
   (fu/render-hotkey-text (or (:text ctrl) (:caption ctrl) ""))])

;; --- Row-source helpers (shared by combobox & listbox) ---

(defn- parse-column-widths [col-widths-str]
  (when (and col-widths-str (not (str/blank? col-widths-str)))
    (mapv (fn [s]
            (let [n (js/parseFloat (str/replace (str/trim s) #"[a-zA-Z]+" ""))]
              (if (js/isNaN n) 1 n)))
          (str/split col-widths-str #";"))))

(defn- build-option-display [row fields bound-col col-widths]
  (let [field-names (mapv (fn [f] (or (:name f) (name (first (keys f))))) fields)
        bound-idx (max 0 (dec (or bound-col 1)))
        bound-key (if (< bound-idx (count field-names))
                    (nth field-names bound-idx) (first field-names))
        bound-val (str (or (get row bound-key) (get row (keyword bound-key)) ""))
        visible-texts (keep-indexed
                        (fn [i fname]
                          (let [w (when (seq col-widths) (nth col-widths i nil))]
                            (when (or (nil? w) (> w 0))
                              (str (or (get row fname) (get row (keyword fname)) "")))))
                        field-names)]
    [bound-val (if (seq visible-texts) (str/join " - " visible-texts) bound-val)]))

(defn- row-source-options
  "Build option elements from cached row-source data."
  [ctrl]
  (let [cached (when-let [rs (:row-source ctrl)] (state-form/get-row-source-options rs))
        rows (when (map? cached) (:rows cached))
        fields (when (map? cached) (:fields cached))
        bound-col (:bound-column ctrl)
        col-widths (parse-column-widths (:column-widths ctrl))]
    (when (seq rows)
      (for [[idx row] (map-indexed vector rows)]
        (let [[bv display] (build-option-display row fields bound-col col-widths)]
          ^{:key idx} [:option {:value bv} display])))))

(defn render-combobox [ctrl field value on-change opts]
  (when-let [rs (:row-source ctrl)] (f/run-fire-and-forget! (form-flow/fetch-row-source-flow) {:row-source rs}))
  (fn [ctrl field value on-change {:keys [allow-edits? tab-idx]}]
    [:select.view-select
     (cond-> {:value (str (or value "")) :disabled (not allow-edits?)
              :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}
       tab-idx (assoc :tab-index tab-idx))
     [:option {:value ""} ""]
     (row-source-options ctrl)]))

(defn render-line [ctrl _field _value _on-change _opts]
  [:hr.view-line
   {:style (cond-> {}
             (:border-color ctrl) (assoc :border-color (:border-color ctrl))
             (:border-width ctrl) (assoc :border-top-width (:border-width ctrl)))}])

(defn render-rectangle [ctrl _field _value _on-change _opts]
  [:div.view-rectangle
   {:style (cond-> {}
             (:back-color ctrl) (assoc :background-color (:back-color ctrl))
             (:border-color ctrl) (assoc :border-color (:border-color ctrl))
             (:border-width ctrl) (assoc :border-width (:border-width ctrl)))}])

(defn render-image [ctrl _field _value _on-change _opts]
  (if-let [src (:picture ctrl)]
    [:img.view-image {:src src :alt (or (:text ctrl) "Image")}]
    [:div.view-image-placeholder "\uD83D\uDDBC No Image"]))

(defn render-attachment [ctrl field _value _on-change opts]
  (let [cache (r/atom {:pk nil :files nil :loading? false})]
    (fn [ctrl field _value _on-change opts]
      (let [current-record (:current-record opts)
            fe (:form-editor @state/app-state)
            record-source (:record-source (:current fe))
            db-id (:database_id (:current-database @state/app-state))
            rs-fields (state-form/get-record-source-fields record-source)
            pk-field (state/detect-pk-field (or rs-fields []))
            pk-val (state/pk-value-for-record current-record pk-field)
            col-name (or field (:control-source ctrl) (:name ctrl))]
        ;; Fetch attachment metadata when PK changes
        (when (and db-id record-source pk-val col-name
                   (not= pk-val (:pk @cache)))
          (reset! cache {:pk pk-val :files nil :loading? true})
          (-> (js/fetch (str "/api/attachments/" (js/encodeURIComponent db-id)
                             "/" (js/encodeURIComponent record-source)
                             "/" (js/encodeURIComponent (str pk-val))
                             "/" (js/encodeURIComponent col-name)))
              (.then #(.json %))
              (.then (fn [data]
                       (let [files (js->clj data :keywordize-keys true)]
                         (swap! cache assoc :files files :loading? false))))
              (.catch (fn [_] (swap! cache assoc :files [] :loading? false)))))
        (let [{:keys [files loading?]} @cache
              first-file (first files)]
          (cond
            loading? [:div.view-attachment-placeholder "Loading..."]
            (and first-file (str/starts-with? (or (:mimeType first-file) "") "image/"))
            [:img.view-attachment-image {:src (:url first-file)
                                         :alt (or (:fileName first-file) "Attachment")}]
            first-file [:a.view-attachment-file {:href (:url first-file) :target "_blank"}
                        (:fileName first-file)]
            :else [:div.view-attachment-placeholder "No attachment"]))))))

(defn render-listbox [ctrl field value on-change opts]
  (when-let [rs (:row-source ctrl)] (f/run-fire-and-forget! (form-flow/fetch-row-source-flow) {:row-source rs}))
  (fn [ctrl field value on-change {:keys [allow-edits? tab-idx]}]
    [:select.view-listbox
     (cond-> {:multiple true :size (or (:list-rows ctrl) 5)
              :value (str (or value "")) :disabled (not allow-edits?)
              :on-change #(when (and field allow-edits?) (on-change field (.. % -target -value)))}
       tab-idx (assoc :tab-index tab-idx))
     [:option {:value ""} ""]
     (row-source-options ctrl)]))

(defn render-option-group [ctrl field value on-change {:keys [allow-edits? tab-idx]}]
  (let [options (or (:options ctrl) [])
        group-name (or (:name ctrl) (str "optgrp-" (random-uuid)))]
    [:div.view-option-group
     (if (seq options)
       (for [[idx opt] (map-indexed vector options)]
         ^{:key idx}
         [:label.view-option-item
          [:input (cond-> {:type "radio" :name group-name
                           :value (or (:value opt) idx)
                           :checked (= value (or (:value opt) idx))
                           :disabled (not allow-edits?)
                           :on-change #(when (and field allow-edits?)
                                         (on-change field (or (:value opt) idx)))}
                    tab-idx (assoc :tab-index tab-idx))]
          (or (:label opt) (str "Option " (inc idx)))])
       [:span.view-option-placeholder "(No options defined)"])]))

(defn render-option-button [ctrl field value on-change {:keys [allow-edits? tab-idx]}]
  (let [opt-val (or (:option-value ctrl) (:value ctrl) 1)
        grp (or (:group-name ctrl) (:name ctrl) (str "opt-" (random-uuid)))]
    [:label.view-option-item
     [:input (cond-> {:type "radio" :name grp :value opt-val
                      :checked (= (str value) (str opt-val)) :disabled (not allow-edits?)
                      :on-change #(when (and field allow-edits?) (on-change field opt-val))}
               tab-idx (assoc :tab-index tab-idx))]
     (fu/render-hotkey-text (or (:text ctrl) (:caption ctrl) ""))]))

(defn render-toggle-button [ctrl field value on-change {:keys [allow-edits? tab-idx]}]
  (let [pressed? (boolean value)]
    [:button.view-toggle-button
     (cond-> {:class (when pressed? "pressed") :disabled (not allow-edits?)
              :on-click #(when (and field allow-edits?) (on-change field (not pressed?)))}
       tab-idx (assoc :tab-index tab-idx))
     (fu/render-hotkey-text (or (:text ctrl) (:caption ctrl) "Toggle"))]))

;; --- Tab control ---

(defn- tab-page-caption [page-name all-controls]
  (let [pg (first (filter #(and (= :page (:type %)) (= (:name %) page-name))
                          (or all-controls [])))
        raw (or (:caption pg) page-name)]
    (if (string? raw) (fu/render-hotkey-text raw) [:span (str raw)])))

(defn- tab-page-hotkey [page-name all-controls]
  (let [pg (first (filter #(and (= :page (:type %)) (= (:name %) page-name))
                          (or all-controls [])))
        raw (or (:caption pg) page-name)]
    (when (string? raw) (fu/extract-hotkey raw))))

(defn render-tab-control [ctrl _field _value _on-change _opts]
  (let [active-tab (r/atom 0)]
    (fn [ctrl _field _value _on-change {:keys [all-controls current-record on-change allow-edits?]}]
      (let [page-names (or (:pages ctrl) [])
            active-page-name (nth page-names @active-tab nil)
            child-controls (when active-page-name
                             (filter #(= (:parent-page %) active-page-name)
                                     (or all-controls [])))]
        [:div.view-tab-control
         [:div.view-tab-headers
          (if (seq page-names)
            (for [[idx pname] (map-indexed vector page-names)]
              (let [hk (tab-page-hotkey pname all-controls)]
                ^{:key idx}
                [:div.view-tab-header
                 (cond-> {:class (when (= idx @active-tab) "active")
                          :on-click #(reset! active-tab idx)}
                   hk (assoc :data-hotkey hk))
                 (tab-page-caption pname all-controls)]))
            [:div.view-tab-header.active "Page 1"])]
         [:div.view-tab-body
          (if (seq child-controls)
            (for [[idx child] (map-indexed vector child-controls)]
              ^{:key idx}
              [form-view-control child current-record on-change
               {:allow-edits? allow-edits? :all-controls all-controls}])
            (when-not (seq page-names)
              [:span "(Empty tab control)"]))]]))))

;; --- Subform ---

(defn- match-header-label
  "Find the header label closest to a detail control's x position.
   In Access, header labels are positioned above their corresponding detail controls."
  [header-labels ctrl-x]
  (when (seq header-labels)
    (let [threshold 20
          best (apply min-key #(js/Math.abs (- (or (:x %) 0) ctrl-x)) header-labels)]
      (when (<= (js/Math.abs (- (or (:x best) 0) ctrl-x)) threshold)
        (or (:text best) (:caption best))))))

(defn- subform-columns
  "Extract column definitions from child form's detail controls.
   Sorted by tab-index (then x position), excludes hidden controls,
   preserves control type and combo-box properties.
   Column captions matched from header labels by x-position proximity.
   Access overlay pattern: when a combo-box sits at the same x as a text-box,
   the combo takes visual priority. If the combo has its own field, the text-box
   is redundant and skipped. If the combo is unbound, its combo properties
   (row-source, bound-column, etc.) merge onto the text-box.
   When form-name and record-source are provided, combo columns get a :state-mapping
   for cascading session-state sync."
  [definition & [{:keys [form-name record-source]}]]
  (when-let [detail-ctrls (when (map? definition)
                            (get-in definition [:detail :controls]))]
    (let [header-labels (->> (get-in definition [:header :controls])
                             (filter #(= (keyword (or (:type %) "")) :label)))
          ;; Build lookup: x-position -> combo with row-source (bound or unbound)
          combo-by-x (->> detail-ctrls
                          (filter #(and (= :combo-box (keyword (or (:type %) "")))
                                        (:row-source %)))
                          (reduce (fn [m c] (assoc m (or (:x c) 0) c)) {}))
          ;; x positions where a BOUND combo exists (has :field) — text-boxes here are redundant
          bound-combo-xs (->> (vals combo-by-x)
                              (filter :field)
                              (map #(or (:x %) 0))
                              set)
          bound (->> detail-ctrls
                     (filter #(and (or (:control-source %) (:field %))
                                   (not= 0 (get % :visible 1))
                                   (not (false? (:visible %)))))
                     ;; Skip text-boxes where a bound combo already covers the same x
                     (remove #(and (not= :combo-box (keyword (or (:type %) "")))
                                   (contains? bound-combo-xs (or (:x %) 0))))
                     (sort-by (fn [c] [(or (:tab-index c) 999) (or (:x c) 0)])))]
      (when (seq bound)
        (mapv (fn [c]
                (let [cs (:control-source c)
                      calculated? (and cs (str/starts-with? cs "="))
                      ;; Check for combo overlay at this x (only applies to non-combo controls)
                      overlay (when (not= :combo-box (keyword (or (:type c) "")))
                                (get combo-by-x (or (:x c) 0)))
                      effective-type (if overlay :combo-box (keyword (or (:type c) "text-box")))
                      field-name (if calculated?
                                   (or (:computed-alias c)
                                       (str "_calc_" (str/lower-case (or (:name c) (:id c) "expr"))))
                                   (str/lower-case (or cs (:field c))))
                      header-text (match-header-label header-labels (or (:x c) 0))
                      ;; State mapping for cascading combos (session_state sync)
                      combo-ctrl (or overlay (when (= :combo-box effective-type) c))
                      state-map (when (and combo-ctrl (or (:row-source c) (:row-source overlay)))
                                  (if (and (:field combo-ctrl) record-source)
                                    ;; Bound combo: use record-source as table, field as column
                                    {:table-name (state-form/sanitize-name record-source)
                                     :column-name (state-form/sanitize-name (:field combo-ctrl))}
                                    ;; Overlay/unbound combo: use form-name as table, control name as column
                                    (when form-name
                                      {:table-name (state-form/sanitize-name form-name)
                                       :column-name (state-form/sanitize-name (or (:name combo-ctrl) (:id combo-ctrl)))})))]
                  (cond-> {:field field-name
                           :caption (or header-text
                                        (:caption c) (:label c) (:name c)
                                        (:control-source c) (:field c))
                           :type effective-type}
                    ;; Combo properties: from the control itself or from an overlay combo
                    (or (:row-source c) (:row-source overlay))
                    (assoc :row-source (or (:row-source c) (:row-source overlay)))
                    (or (:bound-column c) (:bound-column overlay))
                    (assoc :bound-column (or (:bound-column c) (:bound-column overlay)))
                    (or (:column-count c) (:column-count overlay))
                    (assoc :column-count (or (:column-count c) (:column-count overlay)))
                    (or (:column-widths c) (:column-widths overlay))
                    (assoc :column-widths (or (:column-widths c) (:column-widths overlay)))
                    state-map (assoc :state-mapping state-map)
                    calculated? (assoc :locked true)
                    ;; For overlay combos, use the overlay's locked status (the text-box
                    ;; underneath may be locked as a display-only field, but the combo itself
                    ;; should remain interactive unless the combo is explicitly locked)
                    (let [lock-source (if overlay overlay c)]
                      (or (:locked lock-source)
                          (= true (:locked lock-source))
                          (= 1 (:locked lock-source))))
                    (assoc :locked true))))
              bound)))))

(defn- subform-toolbar
  "Render subform header with add/delete buttons."
  [source-form definition allow-additions? allow-deletions?
   link-child-fields link-master-fields current-record selected editing]
  [:div.view-subform-header
   {:style {:display "flex" :align-items "center"}}
   (when-not source-form [:span "Subform (no source)"])
   (when (and source-form (map? definition))
     [:div.subform-toolbar
      (when allow-additions?
        [:button {:title "New Record"
                  :on-click #(f/run-fire-and-forget! (form-flow/new-subform-record-flow)
                               {:source-form source-form :link-child-fields link-child-fields
                                :link-master-fields link-master-fields :current-record current-record})}
         "+"])
      (when (and allow-deletions? @selected)
        [:button.subform-delete-btn
         {:title "Delete Record"
          :on-click #(when (js/confirm "Delete this record?")
                       (f/run-fire-and-forget! (form-flow/delete-subform-record-flow)
                         {:source-form source-form :row (:row @selected)})
                       (reset! selected nil)
                       (reset! editing nil))}
         "\u2715"])])])

(defn- subform-combo-display
  "Get display text for a combo-box value using cached row-source data."
  [col raw-val]
  (if-let [cached (when (:row-source col) (state-form/get-row-source-options (:row-source col)))]
    (let [rows (:rows cached)
          fields (:fields cached)
          bound-col (:bound-column col)
          col-widths (parse-column-widths (:column-widths col))
          match (some (fn [row]
                        (let [[bv display] (build-option-display row fields bound-col col-widths)]
                          (when (= (str bv) (str raw-val)) display)))
                      rows)]
      (or match (str raw-val)))
    (str raw-val)))

(defn- combo-bound-field
  "Resolve the bound field name for a combo column from its cached row-source.
   Returns the field name that option values correspond to (e.g. 'productcategoryid'),
   so we can read the correct value from the record."
  [col]
  (when-let [cached (when (:row-source col) (state-form/get-row-source-options (:row-source col)))]
    (when (map? cached)
      (let [fields (:fields cached)
            field-names (mapv (fn [f] (or (:name f) (name (first (keys f))))) fields)
            bound-idx (max 0 (dec (or (:bound-column col) 1)))]
        (when (< bound-idx (count field-names))
          (str/lower-case (nth field-names bound-idx)))))))

(defn- combo-display-value
  "Resolve display text for a combo cell. Tries multiple strategies:
   1. If the column's field differs from the bound field (overlay pattern),
      the column field IS the display column - use it directly.
   2. Look up display text from cached row-source data.
   3. If field ends with 'id', look for a companion Xname field in the record.
   4. Fall back to raw value."
  [rec col col-field val-field raw-val]
  ;; Strategy 1: overlay pattern — col-field is the display column
  (or (when (not= col-field val-field)
        (let [v (or (get rec (keyword col-field)) (get rec col-field))]
          (when v (str v))))
      ;; Strategy 2: cached row-source lookup
      (let [cached-display (subform-combo-display col raw-val)]
        (when (not= cached-display (str raw-val))
          cached-display))
      ;; Strategy 3: companion Xname field in record
      (let [field-lc (str/lower-case (or val-field ""))]
        (when (str/ends-with? field-lc "id")
          (let [base (subs field-lc 0 (- (count field-lc) 2))
                name-field (str base "name")
                display (or (get rec (keyword name-field)) (get rec name-field))]
            (when display (str display)))))
      ;; Strategy 4: raw value
      (str (or raw-val ""))))

(defn- subform-cell
  "Render a single cell in the subform datasheet."
  [rec idx col selected editing edit-value allow-edits? commit-edit! active-combo cols]
  (let [col-field (:field col)
        is-combo? (= :combo-box (:type col))
        is-locked? (:locked col)
        editable? (and allow-edits? (not is-locked?))
        is-selected? (and @selected (= (:row @selected) idx) (= (:col @selected) col-field))
        is-editing? (and @editing (= (:row @editing) idx) (= (:col @editing) col-field))
        ;; For combos, resolve the bound field from row-source to match option values
        combo-field (when is-combo? (combo-bound-field col))
        val-field (or combo-field col-field)
        raw-val (or (get rec (keyword val-field)) (get rec val-field))]
    [:td {:class (str (when is-selected? "selected ") (when is-editing? "editing"))
          :on-click (fn [e]
                      (.stopPropagation e)
                      (if (and is-combo? editable?)
                        ;; Combo click: open dropdown overlay
                        (let [rect (.getBoundingClientRect (.. e -currentTarget))]
                          (reset! active-combo {:row idx :col col :rect rect :rec rec :cols cols})
                          ;; Check for cascading: collect parent combo values from this row
                          (let [parent-entries (->> cols
                                                    (keep (fn [c]
                                                            (when-let [sm (:state-mapping c)]
                                                              (let [cf (or (combo-bound-field c) (:field c))
                                                                    v (or (get rec (keyword cf)) (get rec cf))]
                                                                {:tableName (:table-name sm)
                                                                 :columnName (:column-name sm)
                                                                 :value (when (some? v) (str v))}))))
                                                    vec)]
                            (if (seq parent-entries)
                              ;; Cascading: sync state, invalidate, then fetch
                              (state-form/sync-form-state! parent-entries
                                (fn []
                                  (when-let [rs (:row-source col)]
                                    (state-form/invalidate-row-source! rs)
                                    (f/run-fire-and-forget! (form-flow/fetch-row-source-flow) {:row-source rs}))))
                              ;; Non-cascading: just fetch
                              (when-let [rs (:row-source col)]
                                (f/run-fire-and-forget! (form-flow/fetch-row-source-flow) {:row-source rs})))))
                        ;; Non-combo click
                        (when-not is-editing? (commit-edit!) (reset! selected {:row idx :col col-field}))))
          :on-double-click (fn [e]
                             (.stopPropagation e)
                             (when (and editable? (not is-combo?))
                               (reset! selected {:row idx :col col-field})
                               (reset! editing {:row idx :col col-field})
                               (reset! edit-value (str (or raw-val "")))))}
     (cond
       ;; Combo-box: display mode — text + dropdown arrow
       is-combo?
       [:div.subform-combo-display
        [:span.combo-display-text (combo-display-value rec col col-field val-field raw-val)]
        (when editable? [:span.combo-display-arrow "\u25BC"])]

       ;; Text: editable input
       is-editing?
       [:input.subform-cell-input
        {:type "text" :auto-focus true :value @edit-value
         :on-change #(reset! edit-value (.. % -target -value))
         :on-blur #(commit-edit!)
         :on-key-down (fn [e]
                        (case (.-key e)
                          "Enter" (commit-edit!)
                          "Escape" (reset! editing nil)
                          nil))}]

       :else
       (str (or raw-val "")))]))

(defn- new-row-cell
  "Render a single cell in the tentative new-record row.
   On first value commit, creates the record server-side (with generated ID),
   appends it to the records list, and the new row resets to blank."
  [col selected editing edit-value commit-new-row! active-combo cols]
  (let [col-field (:field col)
        is-combo? (= :combo-box (:type col))
        is-locked? (:locked col)
        new-idx :new
        is-selected? (and @selected (= (:row @selected) new-idx) (= (:col @selected) col-field))
        is-editing? (and @editing (= (:row @editing) new-idx) (= (:col @editing) col-field))]
    [:td {:class (str "new-row-cell " (when is-selected? "selected ") (when is-editing? "editing"))
          :on-click (fn [e]
                      (.stopPropagation e)
                      (if (and is-combo? (not is-locked?))
                        ;; Combo click: open dropdown overlay for new row
                        (let [rect (.getBoundingClientRect (.. e -currentTarget))]
                          (reset! active-combo {:row :new :col col :rect rect :rec {} :cols cols})
                          (when-let [rs (:row-source col)]
                            (f/run-fire-and-forget! (form-flow/fetch-row-source-flow) {:row-source rs})))
                        ;; Text click (or locked combo — no action)
                        (when-not (or is-combo? is-locked?)
                          (reset! selected {:row new-idx :col col-field})
                          (reset! editing {:row new-idx :col col-field})
                          (reset! edit-value ""))))}
     (cond
       is-combo?
       [:div.subform-combo-display
        [:span.combo-display-text ""]
        (when-not is-locked? [:span.combo-display-arrow "\u25BC"])]

       is-editing?
       [:input.subform-cell-input
        {:type "text" :auto-focus true :value @edit-value
         :on-change #(reset! edit-value (.. % -target -value))
         :on-blur #(commit-new-row! col-field @edit-value)
         :on-key-down (fn [e]
                        (case (.-key e)
                          "Enter" (commit-new-row! col-field @edit-value)
                          "Escape" (do (reset! editing nil) (reset! selected nil))
                          nil))}]

       :else "")]))

(defn- subform-table
  "Render the datasheet table for a subform."
  [cols records selected editing edit-value allow-edits? commit-edit! show-selectors?
   active-combo & [allow-additions? commit-new-row!]]
  (when (seq cols)
    (let [header-row (into [:tr]
                       (concat
                         (when show-selectors? [[:th.selector-col ""]])
                         (for [[i col] (map-indexed vector cols)]
                           ^{:key i} [:th (:caption col)])))]
      [:table.subform-table
       [:thead header-row]
       [:tbody
        (for [[idx rec] (map-indexed vector records)]
          (let [is-sel? (and @selected (= (:row @selected) idx))]
            ^{:key idx}
            (into [:tr {:class (when is-sel? "selected-row")}]
              (concat
                (when show-selectors?
                  [[:td.subform-selector
                    {:on-click #(reset! selected {:row idx :col (:field (first cols))})}
                    (if is-sel? "\u25B6" "")]])
                (for [[ci col] (map-indexed vector cols)]
                  ^{:key ci}
                  [subform-cell rec idx col selected editing edit-value allow-edits? commit-edit! active-combo cols])))))
        (when (and allow-additions? commit-new-row!)
          ^{:key :new}
          (into [:tr.new-record-row {:class (when (= (:row @selected) :new) "selected-row")}]
            (concat
              (when show-selectors?
                [[:td.subform-selector
                  {:on-click #(reset! selected {:row :new :col (:field (first cols))})}
                  "*"]])
              (for [[ci col] (map-indexed vector cols)]
                ^{:key ci}
                [new-row-cell col selected editing edit-value commit-new-row! active-combo cols]))))]])))


(defn- subform-status-view
  "Render the loading/error/empty status for a subform."
  [definition records allow-additions?]
  (cond
    (= definition :loading)
    [:div.subform-datasheet [:span.subform-loading "Loading..."]]
    (:error definition)
    [:div.subform-datasheet [:span.subform-loading "Error loading subform"]]
    (= records :loading)
    [:div.subform-datasheet [:span.subform-loading "Loading records..."]]
    (and (vector? records) (empty? records) (not allow-additions?))
    [:div.subform-datasheet [:span.subform-loading "(No records)"]]
    :else nil))

(defn- subform-definition-props
  "Extract permission flags and record source from a subform definition."
  [definition]
  {:allow-edits?       (when (map? definition) (not= 0 (get definition :allow-edits 1)))
   :allow-additions?   (when (map? definition) (not= 0 (get definition :allow-additions 1)))
   :allow-deletions?   (when (map? definition) (not= 0 (get definition :allow-deletions 1)))
   :show-nav-buttons?  (when (map? definition) (not= 0 (get definition :navigation-buttons 1)))
   :show-selectors?    (when (map? definition) (not= 0 (get definition :record-selectors 1)))
   :child-rs           (when (map? definition)
                         (or (:record-source definition) (:record_source definition)))})

(defn- subform-nav-btn [title disabled? on-click label]
  [:button.nav-btn {:title title :disabled disabled? :on-click on-click} label])

(defn- subform-nav-bar
  "Record navigation bar for the subform footer — mirrors Access's subform nav bar."
  [records source-form allow-additions? allow-deletions? selected editing
   link-child-fields link-master-fields current-record]
  (let [total (if (vector? records) (count records) 0)
        cur (if @selected (inc (:row @selected)) 0)
        no-recs? (< total 1)
        at-first? (<= cur 1)
        at-last? (or (zero? cur) (>= cur total))
        select-row! (fn [idx]
                      (reset! selected {:row idx :col nil})
                      (reset! editing nil))]
    [:div.subform-nav-bar
     [:span.nav-label "Record:"]
     [subform-nav-btn "First" (or no-recs? at-first?) #(select-row! 0) "|◀"]
     [subform-nav-btn "Previous" (or no-recs? at-first?) #(select-row! (dec (dec cur))) "◀"]
     [:span.record-counter (if (pos? cur) (str cur " of " total) (str "0 of " total))]
     [subform-nav-btn "Next" (or no-recs? at-last?) #(select-row! cur) "▶"]
     [subform-nav-btn "Last" (or no-recs? at-last?) #(select-row! (dec total)) "▶|"]
     (when allow-additions?
       [:button.nav-btn {:title "New Record"
                         :on-click #(f/run-fire-and-forget! (form-flow/new-subform-record-flow)
                                      {:source-form source-form :link-child-fields link-child-fields
                                       :link-master-fields link-master-fields :current-record current-record})}
        "▶*"])
     (when allow-deletions?
       [:button.nav-btn.delete-btn
        {:title "Delete Record" :disabled (zero? cur)
         :on-click #(when (and (pos? cur) (js/confirm "Delete this record?"))
                      (f/run-fire-and-forget! (form-flow/delete-subform-record-flow)
                        {:source-form source-form :row (:row @selected)})
                      (reset! selected nil)
                      (reset! editing nil))}
        "\u2715"])]))

(defn- subform-records-view
  "Render records grid or status for a subform."
  [definition records columns allow-additions? allow-edits? selected editing edit-value commit-edit! show-selectors?
   active-combo & [commit-new-row!]]
  (or (subform-status-view definition records allow-additions?)
      (when (and (vector? records) (or (seq records) allow-additions?))
        (let [cols (or columns
                       (when (seq records)
                         (mapv (fn [k] {:field (name k) :caption (name k)})
                               (keys (first records))))
                       [])]
          [:div.subform-datasheet
           [subform-table cols records selected editing edit-value allow-edits? commit-edit! show-selectors?
            active-combo allow-additions? commit-new-row!]]))
      [:div.subform-datasheet [:span.subform-loading "Loading..."]]))

(defn- normalize-source-form
  "Strip 'Form.' prefix from source-form name (Access SourceObject convention)"
  [s]
  (when s (clojure.string/replace s #"^[Ff][Oo][Rr][Mm]\." "")))

(defn- split-link-fields
  "Ensure link fields are a vector of field names (split semicolons if string)"
  [v]
  (cond
    (nil? v) nil
    (string? v) (mapv clojure.string/trim (clojure.string/split v #";"))
    (sequential? v) (vec (mapcat #(if (string? %)
                                     (mapv clojure.string/trim (clojure.string/split % #";"))
                                     [%]) v))
    :else nil))

(defn render-subform [ctrl _field _value _on-change _opts]
  (let [source-form (normalize-source-form (or (:source-form ctrl) (:source_form ctrl)))
        selected (r/atom nil)
        editing (r/atom nil)
        edit-value (r/atom "")
        active-combo (r/atom nil)]
    (when source-form (f/run-fire-and-forget! (form-flow/fetch-subform-definition-flow) {:source-form source-form}))
    (fn [ctrl _field _value _on-change _opts]
      (let [source-form (normalize-source-form (or (:source-form ctrl) (:source_form ctrl)))
            link-child (split-link-fields (or (:link-child-fields ctrl) (:link_child_fields ctrl)))
            link-master (split-link-fields (or (:link-master-fields ctrl) (:link_master_fields ctrl)))
            current-record (or (get-in @state/app-state [:form-editor :projection :record]) {})
            definition (when source-form
                         (get-in @state/app-state [:form-editor :subform-cache source-form :definition]))
            {:keys [allow-edits? allow-additions? allow-deletions? show-nav-buttons? show-selectors? child-rs]}
            (subform-definition-props definition)
            _ (when (and source-form child-rs)
                (f/run-fire-and-forget! (form-flow/fetch-subform-records-flow)
                  {:source-form source-form :child-rs child-rs :link-child link-child
                   :link-master link-master :current-record current-record}))
            records (when source-form
                      (get-in @state/app-state [:form-editor :subform-cache source-form :records]))
            ;; Compute columns with state-mapping for cascading combos
            cols (when (map? definition)
                   (subform-columns definition
                     {:form-name source-form
                      :record-source (or (:record-source definition) (:record_source definition))}))
            ;; Pre-fetch row-sources for locked combos (needed for display text only)
            _ (doseq [col cols]
                (when (and (= :combo-box (:type col)) (:locked col) (:row-source col))
                  (f/run-fire-and-forget! (form-flow/fetch-row-source-flow) {:row-source (:row-source col)})))
            ;; Build link-data once for new record creation
            link-data (reduce (fn [m [child-field master-field]]
                                (let [lc-master (str/lower-case master-field)
                                      master-val (or (get current-record (keyword lc-master))
                                                     (get current-record lc-master)
                                                     (get current-record (keyword master-field))
                                                     (get current-record master-field))]
                                  (if master-val
                                    (assoc m (str/lower-case child-field) master-val)
                                    m)))
                              {}
                              (map vector (or link-child []) (or link-master [])))
            commit-edit! (fn []
                           (when-let [{:keys [row col]} @editing]
                             (when (not= row :new)
                               (let [old-val (str (or (get (nth records row) (keyword col))
                                                      (get (nth records row) col) ""))
                                     new-val @edit-value]
                                 (when (not= old-val new-val)
                                   (f/run-fire-and-forget! (form-flow/save-subform-cell-flow)
                                    {:source-form source-form :row row :col col :new-val new-val}))))
                             (reset! editing nil)))
            commit-new-row! (fn [col-name col-value]
                              (reset! editing nil)
                              (when (and col-value (not (str/blank? (str col-value))))
                                (f/run-fire-and-forget! (form-flow/create-subform-record-flow)
                                  {:source-form source-form
                                   :link-data link-data
                                   :col-name col-name
                                   :col-value col-value})))
            ;; Inline dropdown rendering (avoids Form-2 component lifecycle issues)
            close-combo! #(reset! active-combo nil)
            dropdown-hiccup
            (when-let [{:keys [row col rect rec]} @active-combo]
              (let [rs (:row-source col)
                    cached (when rs (state-form/get-row-source-options rs))
                    loading? (or (nil? cached) (= cached :loading))
                    rows (when (map? cached) (:rows cached))
                    fields (when (map? cached) (:fields cached))
                    bound-col (:bound-column col)
                    col-widths (parse-column-widths (:column-widths col))
                    combo-field (combo-bound-field col)
                    val-field (or combo-field (:field col))
                    current-val (str (or (get rec (keyword val-field)) (get rec val-field) ""))
                    top (when rect (+ (.-bottom rect) 1))
                    left (when rect (.-left rect))
                    width (when rect (max 200 (.-width rect)))]
                [:<>
                 [:div.combo-backdrop {:on-mouse-down (fn [e] (.preventDefault e) (close-combo!))}]
                 [:div.subform-combo-overlay
                  {:style (cond-> {}
                            top (assoc :top (str top "px"))
                            left (assoc :left (str left "px"))
                            width (assoc :width (str width "px")))
                   :on-key-down (fn [e] (when (= (.-key e) "Escape") (close-combo!)))}
                  (if loading?
                    [:div.combo-loading "Loading..."]
                    (when (seq rows)
                      (into [:<>]
                        (for [[idx r] (map-indexed vector rows)]
                          (let [[bv display] (build-option-display r fields bound-col col-widths)
                                selected? (= (str bv) current-val)]
                            ^{:key idx}
                            [:div.combo-option
                             {:class (when selected? "selected")
                              :on-click (fn [_e]
                                          (if (= row :new)
                                            (commit-new-row! (:field col) (str bv))
                                            (let [edit-col (or combo-field (:field col))]
                                              (reset! edit-value (str bv))
                                              (reset! editing {:row row :col edit-col})
                                              (commit-edit!)
                                              ;; Update display field in local cache
                                              (let [field-lc (str/lower-case (or (:field col) ""))]
                                                (when (str/ends-with? field-lc "id")
                                                  (let [base (subs field-lc 0 (- (count field-lc) 2))
                                                        name-field (keyword (str base "name"))
                                                        display-name (some (fn [fname]
                                                                             (when (str/ends-with? (str/lower-case (str fname)) "name")
                                                                               (or (get r fname) (get r (keyword fname)))))
                                                                           (mapv (fn [f] (or (:name f) (name (first (keys f))))) fields))]
                                                    (when display-name
                                                      (swap! state/app-state assoc-in
                                                        [:form-editor :subform-cache source-form :records row name-field]
                                                        display-name)))))
                                              ;; Cascading combo: sync state after change
                                              (when-let [sm (:state-mapping col)]
                                                (state-form/sync-form-state!
                                                  [{:tableName (:table-name sm)
                                                    :columnName (:column-name sm)
                                                    :value (when (some? bv) (str bv))}]
                                                  state-form/invalidate-query-row-sources!))))
                                          (close-combo!))}
                             display])))))]]))]
        [:div.view-subform
         (when source-form
           [subform-records-view definition records cols
            allow-additions? allow-edits? selected editing edit-value commit-edit! show-selectors?
            active-combo commit-new-row!])
         dropdown-hiccup
         (when (and source-form show-nav-buttons?)
           [subform-nav-bar records source-form allow-additions? allow-deletions?
            selected editing link-child link-master current-record])]))))

(defn render-default [ctrl _field _value _on-change _opts]
  [:span (fu/display-text ctrl)])

;; ============================================================
;; CONTROL DISPATCH
;; ============================================================

(def control-renderers
  {:label render-label, :text-box render-textbox, :button render-button
   :check-box render-checkbox, :combo-box render-combobox, :line render-line
   :rectangle render-rectangle, :image render-image, :object-frame render-image, :list-box render-listbox
   :option-group render-option-group, :option-button render-option-button
   :toggle-button render-toggle-button, :tab-control render-tab-control
   :subform render-subform, :attachment render-attachment})

(defn form-view-control
  "Render a single control in view mode"
  [ctrl current-record on-change & [{:keys [auto-focus? allow-edits? all-controls]}]]
  (let [ctrl-name     (or (:name ctrl) (:field ctrl))
        ctrl-kw       (projection/ctrl->kw ctrl-name)
        ;; Named controls: cs is always non-nil (extract-control-state seeds all named controls).
        ;; Unnamed controls (decorative labels etc.): cs is nil, use static definition as fallback.
        cs            (when ctrl-kw (get-in @state/app-state [:form-editor :projection :control-state ctrl-kw]))
        ctrl-visible? (if ctrl-kw (:visible cs) (not= 0 (get ctrl :visible 1)))]
    (when ctrl-visible?
      (let [ctrl-type  (:type ctrl)
            ;; Overlay mutable caption/text from control-state onto ctrl
            ctrl       (if (and cs (:caption cs)) (assoc ctrl :caption (:caption cs) :text (:caption cs)) ctrl)
            field      (fu/resolve-control-field ctrl)
            raw-value  (fu/resolve-field-value field current-record nil ctrl)
            value      (if-let [fmt (:format ctrl)]
                         (fu/format-value raw-value fmt)
                         raw-value)
            renderer   (get control-renderers ctrl-type render-default)
            base-style (fu/control-style ctrl)
            cf-style   (expr/apply-conditional-formatting ctrl current-record nil)
            ;; Check if this field is writable (for view record-sources)
            record-source (get-in @state/app-state [:form-editor :current :record-source])
            rs-fields  (when (and field record-source)
                         (state-form/get-record-source-fields record-source))
            field-meta (when rs-fields
                         (first (filter #(= (:name %) (str/lower-case (or field ""))) rs-fields)))
            field-writable? (if field-meta (:writable field-meta true) true)
            is-lookup? (and field (not field-writable?))
            style      (if cf-style (merge base-style cf-style) base-style)
            tab-idx    (if (= 0 (:tab-stop ctrl)) -1 (:tab-index ctrl))
            tip        (:control-tip-text ctrl)
            ctrl-enabled? (if ctrl-kw (:enabled cs) (not= 0 (get ctrl :enabled 1)))
            ctrl-locked?  (if ctrl-kw (:locked cs)  (= 1 (:locked ctrl)))
            effective-edits? (and allow-edits? ctrl-enabled? (not ctrl-locked?) field-writable?)
            hotkey     (fu/extract-hotkey (or (:text ctrl) (:caption ctrl)))]
        [:div.view-control
         (let [cls (str (name ctrl-type)
                        (when (not ctrl-enabled?) " disabled")
                        (when is-lookup? " readonly-lookup"))]
           (cond-> {:class cls :style style :on-context-menu show-record-menu}
             tip (assoc :title tip)
             hotkey (assoc :data-hotkey hotkey)
             (= ctrl-type :label) (assoc :data-hotkey-label "true")
             is-lookup? (assoc :title (str (or tip "") (when tip " ") "(lookup field - read only)"))))
         [renderer ctrl field value on-change
          {:auto-focus? auto-focus? :is-new? (:__new__ current-record)
           :allow-edits? effective-edits? :all-controls all-controls
           :current-record current-record :on-change on-change
           :tab-idx tab-idx}]]))))

;; ============================================================
;; RECORD CONTEXT MENU
;; ============================================================

(defn show-record-menu [e]
  (.preventDefault e)
  (t/dispatch! :show-form-context-menu (.-clientX e) (.-clientY e)))

(defn- context-menu-item
  "Render a single context menu item with enabled/disabled logic."
  [label enabled? on-click & [class]]
  [:div.menu-item
   {:class (str (when class (str class " ")) (when-not enabled? "disabled"))
    :on-click #(when enabled? (on-click) (t/dispatch! :hide-form-context-menu))}
   label])

(defn form-record-context-menu []
  (let [menu (get-in @state/app-state [:form-editor :context-menu])
        has-clip? (some? @state-form/form-clipboard)
        can-edit? (not= 0 (get-in @state/app-state [:form-editor :current :allow-edits]))
        can-add? (not= 0 (get-in @state/app-state [:form-editor :current :allow-additions]))
        can-del? (not= 0 (get-in @state/app-state [:form-editor :current :allow-deletions]))
        has-rec? (> (or (get-in @state/app-state [:form-editor :projection :total]) 0) 0)]
    (when (:visible menu)
      [:div.context-menu
       {:style {:left (:x menu) :top (:y menu)}
        :on-mouse-leave #(t/dispatch! :hide-form-context-menu)}
       [context-menu-item "Cut" (and has-rec? can-edit? can-del?) #(f/run-fire-and-forget! form-flow/cut-form-record-flow)]
       [context-menu-item "Copy" has-rec? #(f/run-fire-and-forget! form-flow/copy-form-record-flow)]
       [context-menu-item "Paste" (and has-clip? can-add?) #(f/run-fire-and-forget! form-flow/paste-form-record-flow)]
       [:div.menu-divider]
       [context-menu-item "New Record" can-add? #(t/dispatch! :new-record)]
       [context-menu-item "Delete Record" (and has-rec? can-del?)
        #(when (js/confirm "Delete this record?") (f/run-fire-and-forget! form-flow/delete-current-record-flow)) "danger"]])))

;; ============================================================
;; RECORD SELECTOR & SECTIONS
;; ============================================================

(defn record-selector [selected? new-record?]
  [:div.record-selector
   {:class [(when selected? "current") (when new-record? "new-record")]
    :on-context-menu show-record-menu}
   (cond (and selected? new-record?) "\u25B6*"
         selected? "\u25B6"
         new-record? "*"
         :else "\u00A0")])

(defn- section-view-style
  "Build style map for a section in view mode, including background color/image."
  [height section-data]
  (let [picture (:picture section-data)
        has-picture? (and picture (not= picture ""))]
    (cond-> {:height height}
      (:back-color section-data)
      (assoc :background-color (:back-color section-data))
      has-picture?
      (assoc :background-image (str "url(" picture ")")
             :background-size (case (:picture-size-mode section-data)
                                "stretch" "100% 100%" "zoom" "contain" "auto")
             :background-repeat "no-repeat"
             :background-position "center"))))

(defn form-view-section
  "Render a section in view mode"
  [section form-def current-record on-field-change & [{:keys [show-selectors? allow-edits?]}]]
  (let [height (fu/get-section-height form-def section)
        section-data (get form-def section)
        style (section-view-style height section-data)
        all-controls (fu/get-section-controls form-def section)
        controls (sort-by-tab-index (remove #(or (:parent-page %) (= :page (:type %))) all-controls))]
    (when (seq all-controls)
      (if (and show-selectors? (= section :detail))
        [:div.single-form-row
         [record-selector true false]
         [:div.view-section {:class (name section) :style (assoc style :flex 1)}
          [:div.view-controls-container
           (for [[idx ctrl] (map-indexed vector controls)]
             ^{:key idx}
             [form-view-control ctrl current-record on-field-change
              {:allow-edits? allow-edits? :all-controls all-controls}])]]]
        [:div.view-section {:class (name section) :style style}
         [:div.view-controls-container
          (for [[idx ctrl] (map-indexed vector controls)]
            ^{:key idx}
            [form-view-control ctrl current-record on-field-change
             {:allow-edits? allow-edits? :all-controls all-controls}])]]))))

(defn form-view-detail-row
  "Render a single detail row for continuous forms"
  [idx record form-def selected? on-select on-field-change & [{:keys [show-selectors? allow-edits?]}]]
  (let [height (fu/get-section-height form-def :detail)
        all-controls (fu/get-section-controls form-def :detail)
        controls (vec (sort-by-tab-index (remove #(or (:parent-page %) (= :page (:type %))) all-controls)))
        first-tb (first (keep-indexed (fn [i c] (when (= (:type c) :text-box) i)) controls))]
    [:div.view-section.detail.continuous-row
     {:class (when selected? "selected") :style {:height height} :on-click #(on-select idx)}
     (when show-selectors? [record-selector selected? (:__new__ record)])
     [:div.view-controls-container
      (for [[ci ctrl] (map-indexed vector controls)]
        ^{:key ci}
        [form-view-control ctrl record on-field-change
         {:auto-focus? (and selected? (= ci first-tb))
          :allow-edits? allow-edits? :all-controls all-controls}])]]))

(defn tentative-new-row [form-def show-selectors?]
  [:div.view-section.detail.continuous-row.tentative-row
   {:style {:height (fu/get-section-height form-def :detail)}
    :on-click #(t/dispatch! :new-record)}
   (when show-selectors? [record-selector false true])
   [:div.view-controls-container]])

;; ============================================================
;; FORM VIEW — MAIN COMPONENT (broken into sub-components)
;; ============================================================

(defn- form-canvas-header [continuous? record-source]
  [:div.canvas-header
   {:on-context-menu (fn [e]
                       (.preventDefault e)
                       (.stopPropagation e)
                       (t/dispatch! :show-context-menu (.-clientX e) (.-clientY e)))}
   [:span "Form View"]
   (when continuous? [:span.view-type-badge " (Continuous)"])
   (when-not record-source [:span.no-source-warning " (No record source selected)"])])

(defn- nav-btn [title disabled? on-click label]
  [:button.nav-btn {:title title :disabled disabled? :on-click on-click} label])

(defn- record-nav-bar
  "The record navigation bar at the bottom of the form."
  [record-pos allow-additions? allow-deletions? record-dirty?]
  (let [cur (:current record-pos)
        total (:total record-pos)
        no-recs? (< total 1)
        at-first? (<= cur 1)
        at-last? (>= cur total)]
    [:div.record-nav-bar
     [:span.nav-label "Record:"]
     [nav-btn "First" (or no-recs? at-first?) #(f/run-fire-and-forget! form-flow/navigate-to-record-flow {:position 1}) "|◀"]
     [nav-btn "Previous" (or no-recs? at-first?) #(f/run-fire-and-forget! form-flow/navigate-to-record-flow {:position (dec cur)}) "◀"]
     [:span.record-counter (if (pos? total) (str cur " of " total) "0 of 0")]
     [nav-btn "Next" (or no-recs? at-last?) #(f/run-fire-and-forget! form-flow/navigate-to-record-flow {:position (inc cur)}) "▶"]
     [nav-btn "Last" (or no-recs? at-last?) #(f/run-fire-and-forget! form-flow/navigate-to-record-flow {:position total}) "▶|"]
     [nav-btn "New Record" (not allow-additions?) #(t/dispatch! :new-record) "▶*"]
     [:button.nav-btn.delete-btn
      {:title "Delete Record" :disabled (or no-recs? (not allow-deletions?))
       :on-click #(when (js/confirm "Delete this record?") (f/run-fire-and-forget! form-flow/delete-current-record-flow))} "✕"]
     [:span.nav-separator]
     [:button.nav-btn.save-btn
      {:title "Save Record" :class (when record-dirty? "dirty")
       :disabled (not record-dirty?) :on-click #(f/run-fire-and-forget! form-flow/save-current-record-flow)}
      "Save"]]))

(defn- canvas-context-menu
  "Right-click context menu on the canvas header (Save/Close/View switching)."
  []
  (let [ctx-menu (:context-menu @state/app-state)]
    (when (:visible? ctx-menu)
      (let [dismiss-and (fn [action]
                          (fn [e] (.stopPropagation e) (t/dispatch! :hide-context-menu) (action)))]
        [:div.context-menu
         {:style {:left (:x ctx-menu) :top (:y ctx-menu)}}
         [:div.context-menu-item {:on-click (dismiss-and #(f/run-fire-and-forget! form-flow/save-current-record-flow))} "Save"]
         [:div.context-menu-item {:on-click (dismiss-and #(f/run-fire-and-forget! nav/close-current-tab-flow))} "Close"]
         [:div.context-menu-item {:on-click (dismiss-and #(f/run-fire-and-forget! nav/close-all-tabs-flow))} "Close All"]
         [:div.context-menu-separator]
         [:div.context-menu-item
          {:class (when (= (state-form/get-view-mode) :view) "active")
           :on-click (dismiss-and #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :view}))} "Form View"]
         [:div.context-menu-item
          {:class (when (= (state-form/get-view-mode) :design) "active")
           :on-click (dismiss-and #(f/run-fire-and-forget! form-flow/set-view-mode-flow {:mode :design}))} "Design View"]]))))

(defn- continuous-form-body
  "Render the continuous form body with header, scrolling detail rows, and footer."
  [current current-record all-records record-pos on-field-change on-select-record opts]
  (let [{:keys [show-selectors? allow-edits? allow-additions? dividing-lines? form-width]} opts
        show-header? (and (:header current) (not= 0 (get-in current [:header :visible] 1)))
        show-footer? (and (:footer current) (not= 0 (get-in current [:footer :visible] 1)))]
    [:div.view-sections-container.continuous
     {:class (when-not dividing-lines? "no-dividing-lines")
      :style (when form-width {:max-width form-width})}
     (when show-header?
       [form-view-section :header current current-record on-field-change {:allow-edits? allow-edits?}])
     [:div.continuous-records-container
      (for [[idx record] (map-indexed vector all-records)]
        (let [sel? (= (inc idx) (:current record-pos))
              disp (if sel? current-record record)]
          ^{:key (or (:id record) idx)}
          [form-view-detail-row idx disp current sel? on-select-record on-field-change
           {:show-selectors? show-selectors? :allow-edits? allow-edits?}]))
      (when (and allow-additions? (not (some :__new__ all-records)))
        [tentative-new-row current show-selectors?])]
     (when show-footer?
       [form-view-section :footer current current-record on-field-change {:allow-edits? allow-edits?}])]))

(defn- single-form-body
  "Render the single-form body with header, detail, and footer."
  [current current-record on-field-change opts]
  (let [{:keys [show-selectors? allow-edits? form-width]} opts
        show-header? (and (:header current) (not= 0 (get-in current [:header :visible] 1)))
        show-footer? (and (:footer current) (not= 0 (get-in current [:footer :visible] 1)))]
    [:div.view-sections-container
     {:style (when form-width {:max-width form-width})}
     (when show-header?
       [form-view-section :header current current-record on-field-change {:allow-edits? allow-edits?}])
     [form-view-section :detail current current-record on-field-change
      {:show-selectors? show-selectors? :allow-edits? allow-edits?}]
     (when show-footer?
       [form-view-section :footer current current-record on-field-change {:allow-edits? allow-edits?}])]))

(defn- form-view-opts [current]
  {:show-selectors?  (not= 0 (:record-selectors current))
   :allow-edits?     (not= 0 (:allow-edits current))
   :allow-additions? (not= 0 (:allow-additions current))
   :allow-deletions? (not= 0 (:allow-deletions current))
   :dividing-lines?  (not= 0 (:dividing-lines current))
   :form-width       (or (:width current) (:form-width current))})

(defn- no-records-message [record-source current]
  (cond (not record-source) "Select a record source in Design View"
        (or (seq (fu/get-section-controls current :header))
            (seq (fu/get-section-controls current :detail))
            (seq (fu/get-section-controls current :footer))) "No records found"
        :else "Add controls in Design View"))

(defn- handle-hotkey
  "Handle Alt+letter hotkey: find the control with matching data-hotkey and focus/click it.
   For labels, focus the next sibling control's focusable element."
  [e canvas-el]
  (when (and (.-altKey e) (not (.-ctrlKey e)) (not (.-metaKey e))
             (= 1 (count (.-key e))))
    (let [letter (str/lower-case (.-key e))
          target (.querySelector canvas-el (str "[data-hotkey=\"" letter "\"]"))]
      (when target
        (.preventDefault e)
        (.stopPropagation e)
        (if (= "true" (.getAttribute target "data-hotkey-label"))
          ;; Label hotkey: focus the next sibling control's focusable element
          (when-let [next-ctrl (.-nextElementSibling target)]
            (let [focusable (or (.querySelector next-ctrl "input, select, button, textarea") next-ctrl)]
              (.focus focusable)))
          ;; Non-label: click the first button/input, or focus the first focusable element
          (let [btn (.querySelector target "button")
                focusable (or btn (.querySelector target "input, select, textarea"))]
            (if btn
              (.click btn)
              (when focusable (.focus focusable)))))))))

(defn form-view
  "The form in view/data entry mode"
  []
  (let [fe (:form-editor @state/app-state)
        current (:current fe)
        projection (:projection fe)
        current-record (or (:record projection) {})
        all-records (or (:records projection) [])
        record-pos {:current (or (:position projection) 0) :total (or (:total projection) 0)}
        record-source (:record-source current)
        continuous? (= (or (:default-view current) "Single Form") "Continuous Forms")
        on-change (fn [field value] (f/run-fire-and-forget! (form-flow/update-record-field-flow) {:field field :value value}))
        on-select (fn [idx] (f/run-fire-and-forget! form-flow/navigate-to-record-flow {:position (inc idx)}))
        opts (form-view-opts current)
        scroll-bars (or (:scroll-bars current) :both)
        has-controls? (or (seq (fu/get-section-controls current :header))
                          (seq (fu/get-section-controls current :detail))
                          (seq (fu/get-section-controls current :footer)))
        has-data? (and record-source
                       (or (pos? (:total record-pos))
                           (and continuous? (:allow-additions? opts))))]
    [:div.form-canvas.view-mode
     {:style (when-let [bc (:back-color current)] {:background-color bc})
      :tab-index -1
      :on-key-down (fn [e] (handle-hotkey e (.. e -currentTarget)))
      :on-click #(do (t/dispatch! :hide-form-context-menu) (t/dispatch! :hide-context-menu))}
     [form-canvas-header continuous? record-source]
     [:div.canvas-body.view-mode-body
      {:style (cond-> {}
                (#{:neither :vertical} scroll-bars) (assoc :overflow-x "hidden")
                (#{:neither :horizontal} scroll-bars) (assoc :overflow-y "hidden"))}
      (cond
        has-data?
        (if continuous?
          [continuous-form-body current current-record all-records record-pos on-change on-select opts]
          [single-form-body current current-record on-change opts])
        (and (not record-source) has-controls?)
        [single-form-body current current-record on-change (assoc opts :allow-edits? false)]
        :else
        [:div.no-records (no-records-message record-source current)])]
     (when-not (= 0 (:navigation-buttons current))
       [record-nav-bar record-pos (:allow-additions? opts) (:allow-deletions? opts) (:dirty? projection)])
     [form-record-context-menu]
     [canvas-context-menu]]))
