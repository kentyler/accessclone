(ns app.views.access-database-viewer
  "Viewer for Access database files - shows forms/reports available for import"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.transforms.core :as t]
            [app.flows.core :as f]
            [app.flows.ui :as ui-flows]
            [app.flows.app :as app-flows]
            [app.views.expressions :as expr]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <! chan put!]]
            [clojure.string :as str]))

(def api-base state/api-base)

(declare get-item-name load-access-database-contents! load-target-existing! load-import-history! load-image-status! import-images! import-attachments!)

;; ============================================================
;; Access JSON → AccessClone Form Definition Converter
;; ============================================================

(def twips-per-pixel 15)

(defn twips->px [twips]
  (js/Math.round (/ (or twips 0) twips-per-pixel)))

(defn access-color->hex
  "Convert Access BGR long integer to #RRGGBB hex string"
  [color]
  (when (and color (>= color 0))
    (let [b (bit-and (bit-shift-right color 16) 0xFF)
          g (bit-and (bit-shift-right color 8) 0xFF)
          r (bit-and color 0xFF)]
      (str "#"
           (.padStart (.toString r 16) 2 "0")
           (.padStart (.toString g 16) 2 "0")
           (.padStart (.toString b 16) 2 "0")))))

(def default-view-map
  {0 "Single Form"
   1 "Continuous Forms"
   2 "Datasheet"})

(def scroll-bars-map
  {0 :neither
   1 :horizontal
   2 :vertical
   3 :both})

(defn- apply-control-source
  "Map Access controlSource to :field or :control-source as appropriate."
  [base ctrl]
  (if-let [cs (:controlSource ctrl)]
    (cond
      ;; Expression (e.g. "=IIf(...)") — computed value, not a field binding
      (and (string? cs) (clojure.string/starts-with? cs "="))
      (assoc base :control-source cs)
      ;; Table-qualified field (e.g. "ingredient.ingredient" → "ingredient")
      (and (string? cs) (clojure.string/includes? cs "."))
      (assoc base :field (subs cs (inc (clojure.string/index-of cs "."))))
      ;; Simple field binding
      :else (assoc base :field cs))
    base))

(defn- control-base
  "Build base control map with geometry, font, colors, data binding, caption."
  [ctrl]
  (-> (cond-> {:type (keyword (:type ctrl))
               :name (:name ctrl)
               :x (twips->px (:left ctrl))
               :y (twips->px (:top ctrl))
               :width (twips->px (:width ctrl))
               :height (twips->px (:height ctrl))}
        (:fontName ctrl)      (assoc :font-name (:fontName ctrl))
        (:fontSize ctrl)      (assoc :font-size (:fontSize ctrl))
        (:fontBold ctrl)      (assoc :font-bold true)
        (:fontItalic ctrl)    (assoc :font-italic true)
        (:fontUnderline ctrl) (assoc :font-underline true)
        (:foreColor ctrl)     (assoc :fore-color (access-color->hex (:foreColor ctrl)))
        (:backColor ctrl)     (assoc :back-color (access-color->hex (:backColor ctrl)))
        (:borderColor ctrl)   (assoc :border-color (access-color->hex (:borderColor ctrl)))
        (some? (:backStyle ctrl)) (assoc :back-style (:backStyle ctrl))
        (:caption ctrl)       (assoc :text (:caption ctrl))
        (:format ctrl)        (assoc :format (:format ctrl))
        (:tooltip ctrl)       (assoc :tooltip (:tooltip ctrl))
        (:tag ctrl)           (assoc :tag (:tag ctrl))
        (false? (:visible ctrl)) (assoc :visible false))
      (apply-control-source ctrl)))

(defn- apply-form-control-props
  "Apply form-specific properties to a base control map."
  [base ctrl]
  (cond-> base
    (:defaultValue ctrl)   (assoc :default-value (:defaultValue ctrl))
    (:inputMask ctrl)      (assoc :input-mask (:inputMask ctrl))
    (:validationRule ctrl) (assoc :validation-rule (:validationRule ctrl))
    (:validationText ctrl) (assoc :validation-text (:validationText ctrl))
    (:tabIndex ctrl)       (assoc :tab-index (:tabIndex ctrl))
    (or (:controlTipText ctrl) (:tooltip ctrl))
    (assoc :control-tip-text (or (:controlTipText ctrl) (:tooltip ctrl)))
    (:parentPage ctrl)     (assoc :parent-page (:parentPage ctrl))
    (false? (:enabled ctrl)) (assoc :enabled false)
    (:locked ctrl)           (assoc :locked true)
    (:rowSource ctrl)    (assoc :row-source (:rowSource ctrl))
    (:boundColumn ctrl)  (assoc :bound-column (:boundColumn ctrl))
    (:columnCount ctrl)  (assoc :column-count (:columnCount ctrl))
    (:columnWidths ctrl) (assoc :column-widths (:columnWidths ctrl))
    (:limitToList ctrl)  (assoc :limit-to-list true)
    (:sourceForm ctrl)      (assoc :source-form (str/replace (:sourceForm ctrl) #"^[Ff][Oo][Rr][Mm]\." ""))
    (:linkChildFields ctrl) (assoc :link-child-fields (mapv str/trim (str/split (:linkChildFields ctrl) #";")))
    (:linkMasterFields ctrl)(assoc :link-master-fields (mapv str/trim (str/split (:linkMasterFields ctrl) #";")))
    (:pages ctrl)     (assoc :pages (:pages ctrl))
    (:pageIndex ctrl) (assoc :page-index (:pageIndex ctrl))
    (:picture ctrl)  (assoc :picture (:picture ctrl))
    (:sizeMode ctrl) (assoc :size-mode (keyword (:sizeMode ctrl)))
    (:hasClickEvent ctrl)        (assoc :has-click-event true)
    (:hasDblClickEvent ctrl)     (assoc :has-dblclick-event true)
    (:hasChangeEvent ctrl)       (assoc :has-change-event true)
    (:hasEnterEvent ctrl)        (assoc :has-enter-event true)
    (:hasExitEvent ctrl)         (assoc :has-exit-event true)
    (:hasBeforeUpdateEvent ctrl) (assoc :has-before-update-event true)
    (:hasAfterUpdateEvent ctrl)  (assoc :has-after-update-event true)
    (:hasGotFocusEvent ctrl)     (assoc :has-gotfocus-event true)
    (:hasLostFocusEvent ctrl)    (assoc :has-lostfocus-event true)
    (:events ctrl)               (assoc :events (:events ctrl))))

(defn convert-control
  "Convert a single Access control JSON object to AccessClone format"
  [ctrl]
  (apply-form-control-props (control-base ctrl) ctrl))

(defn extract-record-source
  "Extract table name from record source (may be a SELECT query)"
  [record-source]
  (when record-source
    (if-let [match (re-find #"(?i)^SELECT .+ FROM (\w+)" record-source)]
      (second match)
      record-source)))

;; ============================================================
;; Access JSON → AccessClone Report Definition Converter
;; ============================================================

(def running-sum-map
  {1 :over-group
   2 :over-all})

(def group-on-map
  {0 :each-value
   1 :prefix
   2 :year
   3 :quarter
   4 :month
   5 :week
   6 :day
   7 :hour
   8 :minute
   9 :interval})

(def keep-together-map
  {0 :none
   1 :whole-group
   2 :with-first-detail})

(def picture-size-mode-map
  {0 "clip" 1 "stretch" 3 "zoom"})

(defn convert-report-control
  "Convert a single Access report control JSON object to AccessClone format"
  [ctrl]
  (cond-> (control-base ctrl)
    (:runningSum ctrl)    (assoc :running-sum (get running-sum-map (:runningSum ctrl)))
    (:canGrow ctrl)       (assoc :can-grow true)
    (:canShrink ctrl)     (assoc :can-shrink true)
    (:hideDuplicates ctrl)(assoc :hide-duplicates true)
    (:sourceReport ctrl)     (assoc :source-report (str/replace (:sourceReport ctrl) #"^[Rr][Ee][Pp][Oo][Rr][Tt]\." ""))
    (:linkChildFields ctrl)  (assoc :link-child-fields (mapv str/trim (str/split (:linkChildFields ctrl) #";")))
    (:linkMasterFields ctrl) (assoc :link-master-fields (mapv str/trim (str/split (:linkMasterFields ctrl) #";")))
    (:picture ctrl)      (assoc :picture (:picture ctrl))
    (:sizeMode ctrl)     (assoc :size-mode (keyword (:sizeMode ctrl)))
    (:rowSource ctrl)    (assoc :row-source (:rowSource ctrl))
    (:boundColumn ctrl)  (assoc :bound-column (:boundColumn ctrl))
    (:columnCount ctrl)  (assoc :column-count (:columnCount ctrl))
    (:columnWidths ctrl) (assoc :column-widths (:columnWidths ctrl))
    (:hasFormatEvent ctrl) (assoc :has-format-event true)
    (:hasPrintEvent ctrl)  (assoc :has-print-event true)
    (:hasClickEvent ctrl)  (assoc :has-click-event true)
    (:events ctrl)         (assoc :events (:events ctrl))))

(defn convert-report-section
  "Convert a report section JSON object to AccessClone format"
  [section]
  (let [controls (mapv convert-report-control (or (:controls section) []))]
    (cond-> {:height (twips->px (:height section))
             :controls controls}
      ;; Section properties
      (some? (:visible section))     (assoc :visible (:visible section))
      (:canGrow section)             (assoc :can-grow true)
      (:canShrink section)           (assoc :can-shrink true)
      (and (:forceNewPage section)
           (pos? (:forceNewPage section))) (assoc :force-new-page (:forceNewPage section))
      (some? (:keepTogether section))(assoc :keep-together (:keepTogether section))
      (:backColor section)           (assoc :back-color (access-color->hex (:backColor section)))
      (:picture section)             (assoc :picture (:picture section))
      (some? (:pictureSizeMode section)) (assoc :picture-size-mode (get picture-size-mode-map (:pictureSizeMode section) "clip"))

      ;; Section events
      (:hasFormatEvent section)  (assoc :has-format-event true)
      (:hasPrintEvent section)   (assoc :has-print-event true)
      (:hasRetreatEvent section) (assoc :has-retreat-event true)
      (:events section)          (assoc :events (:events section)))))

(defn- convert-grouping
  "Convert Access grouping array to AccessClone format."
  [grouping-data]
  (mapv (fn [grp]
          {:field (:field grp)
           :group-header (boolean (:groupHeader grp))
           :group-footer (boolean (:groupFooter grp))
           :sort-order (if (= (:sortOrder grp) 1) "descending" "ascending")
           :group-on (get group-on-map (:groupOn grp) :each-value)
           :group-interval (or (:groupInterval grp) 1)
           :keep-together (get keep-together-map (:keepTogether grp) :none)})
        (or grouping-data [])))

(defn- build-report-base
  "Build base report definition with standard sections."
  [report-data section-map]
  (let [empty-section {:height 0 :controls []}]
    {:name (:name report-data)
     :record-source (extract-record-source (:recordSource report-data))
     :report-width (twips->px (:reportWidth report-data))
     :page-header-option (or (:pageHeader report-data) 0)
     :page-footer-option (or (:pageFooter report-data) 0)
     :grouping (convert-grouping (:grouping report-data))
     :report-header (get section-map :report-header empty-section)
     :page-header (get section-map :page-header empty-section)
     :detail (get section-map :detail empty-section)
     :page-footer (get section-map :page-footer empty-section)
     :report-footer (get section-map :report-footer empty-section)}))

(defn convert-access-report
  "Convert Access report JSON metadata to AccessClone report definition"
  [report-data]
  (let [section-map (into {} (map (fn [sec]
                                    [(keyword (:name sec))
                                     (convert-report-section sec)])
                                  (or (:sections report-data) [])))
        group-sections (into {} (filter #(re-find #"^group-" (name (key %))) section-map))]
    (cond-> (build-report-base report-data section-map)
      (:caption report-data)            (assoc :caption (:caption report-data))
      (:picture report-data)            (assoc :picture (:picture report-data))
      (some? (:pictureSizeMode report-data)) (assoc :picture-size-mode (get picture-size-mode-map (:pictureSizeMode report-data) "clip"))
      (seq group-sections)              (merge group-sections)
      (:hasOpenEvent report-data)       (assoc :has-open-event true)
      (:hasCloseEvent report-data)      (assoc :has-close-event true)
      (:hasActivateEvent report-data)   (assoc :has-activate-event true)
      (:hasDeactivateEvent report-data) (assoc :has-deactivate-event true)
      (:hasNoDataEvent report-data)     (assoc :has-no-data-event true)
      (:hasPageEvent report-data)       (assoc :has-page-event true)
      (:hasErrorEvent report-data)      (assoc :has-error-event true)
      (:events report-data)            (assoc :events (:events report-data)))))

;; ============================================================

(defn- pascal->kebab
  "Convert PascalCase to kebab-case: BackColor -> back-color"
  [s]
  (-> s
      (str/replace #"([a-z0-9])([A-Z])" "$1-$2")
      str/lower-case))

(def ^:private section-color-props
  #{"BackColor" "AlternateBackColor" "ForeColor" "BorderColor"})

(defn- extract-section-props
  "Extract all properties for a named section from the flat sections map.
   Keys like :detailBackColor → :back-color in the section map.
   Color properties are converted to hex; PictureSizeMode mapped to strings."
  [sections section-name]
  (let [prefix section-name
        prefix-len (count prefix)]
    (reduce-kv
      (fn [m k v]
        (let [k-str (name k)]
          (if (and (str/starts-with? k-str prefix)
                   (> (count k-str) prefix-len)
                   (not= k-str (str prefix "Height")))
            (let [prop-name (subs k-str prefix-len)
                  kebab-key (keyword (pascal->kebab prop-name))
                  converted-val (cond
                                  (section-color-props prop-name) (access-color->hex v)
                                  (= prop-name "PictureSizeMode") (get picture-size-mode-map v "clip")
                                  :else v)]
              (assoc m kebab-key converted-val))
            m)))
      {}
      sections)))

(defn- build-form-section
  "Build a single form section with all properties from Access export."
  [sections section-name height-key by-section section-idx]
  (merge
    (extract-section-props sections section-name)
    {:height (twips->px (get sections height-key))
     :controls (mapv convert-control (get by-section section-idx []))}))

(defn- build-form-sections
  "Build header/detail/footer sections from Access form data.
   Only includes header/footer if the original Access form had them
   (non-zero height or controls assigned to that section)."
  [form-data]
  (let [by-section (group-by #(or (:section %) 0) (or (:controls form-data) []))
        sections (or (:sections form-data) {})
        has-header? (or (pos? (get sections :headerHeight 0))
                        (seq (get by-section 1)))
        has-footer? (or (pos? (get sections :footerHeight 0))
                        (seq (get by-section 2)))]
    (cond-> {:detail (build-form-section sections "detail" :detailHeight by-section 0)}
      has-header? (assoc :header (build-form-section sections "header" :headerHeight by-section 1))
      has-footer? (assoc :footer (build-form-section sections "footer" :footerHeight by-section 2)))))

(defn- bool->int [v] (if (false? v) 0 1))

(defn convert-access-form
  "Convert Access form JSON metadata to AccessClone form definition"
  [form-data]
  (let [sections (build-form-sections form-data)]
    (cond-> (merge {:name (:name form-data)
                    :record-source (extract-record-source (:recordSource form-data))
                    :default-view (get default-view-map (:defaultView form-data) "Single Form")
                    :form-width (twips->px (:formWidth form-data))
                    :navigation-buttons (bool->int (:navigationButtons form-data))
                    :record-selectors (bool->int (:recordSelectors form-data))
                    :allow-additions (bool->int (:allowAdditions form-data))
                    :allow-deletions (bool->int (:allowDeletions form-data))
                    :allow-edits (bool->int (:allowEdits form-data))
                    :dividing-lines (bool->int (:dividingLines form-data))}
                   sections)
      (:caption form-data) (assoc :text (:caption form-data))
      (and (:filter form-data) (:filterOn form-data)) (assoc :filter (:filter form-data))
      (and (:orderBy form-data) (:orderByOn form-data)) (assoc :order-by (:orderBy form-data))
      (:scrollBars form-data) (assoc :scroll-bars (get scroll-bars-map (:scrollBars form-data) :both))
      (:popup form-data) (assoc :popup 1)
      (:modal form-data) (assoc :modal 1)
      (:dataEntry form-data) (assoc :data-entry 1)
      (:backColor form-data) (assoc :back-color (access-color->hex (:backColor form-data)))
      (:picture form-data) (assoc :picture (:picture form-data))
      (some? (:pictureSizeMode form-data)) (assoc :picture-size-mode (get picture-size-mode-map (:pictureSizeMode form-data) "clip"))
      (:hasLoadEvent form-data)         (assoc :has-load-event true)
      (:hasOpenEvent form-data)         (assoc :has-open-event true)
      (:hasCloseEvent form-data)        (assoc :has-close-event true)
      (:hasCurrentEvent form-data)      (assoc :has-current-event true)
      (:hasBeforeInsertEvent form-data) (assoc :has-before-insert-event true)
      (:hasAfterInsertEvent form-data)  (assoc :has-after-insert-event true)
      (:hasBeforeUpdateEvent form-data) (assoc :has-before-update-event true)
      (:hasAfterUpdateEvent form-data)  (assoc :has-after-update-event true)
      (:hasDeleteEvent form-data)       (assoc :has-delete-event true)
      (:events form-data)              (assoc :events (:events form-data)))))

;; ============================================================
;; Server-side function call rewriting
;; ============================================================

(def ^:private client-side-fns
  "Functions handled client-side by the expression evaluator.
   Any function call NOT in this set is assumed to be a server-side PL/pgSQL function."
  #{"iif" "nz" "now" "date" "format" "left" "right" "mid" "len" "trim"
    "ucase" "lcase" "int" "round" "val" "instr" "replace" "abs"
    "sum" "count" "avg" "min" "max" "dcount" "dsum" "first" "last"})

(defn- server-fn-call?
  "Returns true if the AST is a top-level call to a non-builtin function."
  [ast]
  (and (= (:type ast) :call)
       (not (contains? client-side-fns (:fn ast)))))

(defn- ast->sql
  "Convert a simple expression AST to SQL text. Schema-qualifies function calls."
  [ast schema]
  (case (:type ast)
    :literal (let [v (:value ast)]
               (cond
                 (nil? v) "NULL"
                 (string? v) (str "'" (str/replace v "'" "''") "'")
                 :else (str v)))
    :string  (str "'" (str/replace (:value ast) "'" "''") "'")
    :call    (str schema "." (:fn ast)
                  "(" (str/join ", " (map #(ast->sql % schema) (:args ast))) ")")
    ;; fallback
    (str (:value ast))))

(defn- rewrite-server-fn-controls
  "No-op — previously rewrote VBA function calls in control-sources into synthetic
   SQL record-sources, but this assumed the functions existed as PG functions.
   Now we keep control-source expressions as-is; the expression evaluator or
   JS runtime handles them at display time."
  [form-def _schema]
  form-def)

;; Local state for the viewer
(defonce viewer-state
  (r/atom {:loading? false
           :error nil
           :active-path nil      ;; Which db's objects are currently displayed
           :selected-paths []    ;; Ordered vector of paths included for import
           :object-type nil     ;; nil until user picks a tab; :tables, :queries, :forms, etc.
           :forms []
           :reports []
           :tables []
           :queries []
           :modules []
           :macros []
           :selected #{}        ;; Set of selected item names for import
           :target-database-id nil ;; Target database to import into
           :target-existing {}   ;; {:forms #{"Form1"} :tables #{"tbl1"} ...}
           :import-log []       ;; Recent import history
           :importing? false    ;; True while import is in progress
           :access-db-cache {}  ;; {path {:forms [] :reports [] :tables [] :queries [] :modules [] :macros []}}
           :import-all-active? false ;; True while Import All is running
           :import-all-status nil    ;; {:phase :tables :current "TableName" :imported 0 :total 0 :failed []}
           :image-status nil         ;; {:total N :imported M} from /api/database-import/image-status
           :auto-import-phase nil    ;; nil, :importing, :translating, :complete
           }))

(defn current-target-db-id
  "Get the current target database ID from the global app state (global selector IS the import target)"
  []
  (:database_id (:current-database @state/app-state)))

(defn import-busy?
  "True while an import is in progress"
  []
  (let [{:keys [importing? auto-import-phase]} @viewer-state]
    (or importing? (and auto-import-phase (not= auto-import-phase :complete)))))

(defn source-selected?
  "True when at least one Access database has been scanned/selected for import"
  []
  (seq (:selected-paths @viewer-state)))

;; ============================================================
;; Import Phase Ordering
;; ============================================================

(def import-phases
  [{:phase :tables   :label "Tables"          :types [:tables]          :requires []}
   {:phase :ui       :label "Forms & Reports" :types [:forms :reports]  :requires [:tables]}
   {:phase :modules  :label "Modules"         :types [:modules]         :requires [:tables]}
   {:phase :queries  :label "Queries"         :types [:queries]         :requires [:tables :forms :reports :modules]}
   {:phase :macros   :label "Macros"          :types [:macros]          :requires [:tables :queries :forms :reports :modules]}])

(defn- sanitize-name
  "Lowercase and replace spaces with underscores for comparison"
  [s]
  (-> (str s) str/lower-case (str/replace " " "_")))

(defn type-progress
  "Returns {:total N :imported M} for a given object type, aggregated across all selected databases"
  [obj-type]
  (let [paths (:selected-paths @viewer-state)
        cache (:access-db-cache @viewer-state)
        ;; Collect all unique source item names across all selected databases
        all-names (distinct (mapcat (fn [p]
                                      (map get-item-name (get (get cache p) obj-type [])))
                                    paths))
        existing (get-in @viewer-state [:target-existing obj-type] #{})
        existing-sanitized (set (map sanitize-name existing))
        total (count all-names)
        imported (count (filter #(contains? existing-sanitized (sanitize-name %)) all-names))]
    {:total total :imported imported}))

(defn phase-progress
  "Returns {:total :imported :complete? :empty?} aggregated across all types in a phase"
  [phase-def]
  (let [results (map type-progress (:types phase-def))
        total (reduce + (map :total results))
        imported (reduce + (map :imported results))]
    {:total total
     :imported imported
     :complete? (and (pos? total) (= total imported))
     :empty? (zero? total)}))

(defn phase-ready?
  "Checks if all prerequisite phases are complete (or empty)"
  [phase-def]
  (every? (fn [req-type]
            (let [{:keys [total imported]} (type-progress req-type)]
              (or (zero? total) (= total imported))))
          (:requires phase-def)))

(defn save-source-discovery!
  "Save the Access database discovery inventory to the server for completeness checks.
   Aggregates object names from all selected databases."
  [target-database-id]
  (when target-database-id
    (let [paths (:selected-paths @viewer-state)
          cache (:access-db-cache @viewer-state)]
      (when (seq paths)
        (let [merge-names (fn [obj-type]
                            (vec (distinct (mapcat #(mapv get-item-name (get (get cache %) obj-type []))
                                                   paths))))
              discovery {:tables  (merge-names :tables)
                         :queries (merge-names :queries)
                         :forms   (merge-names :forms)
                         :reports (merge-names :reports)
                         :modules (merge-names :modules)
                         :macros  (merge-names :macros)}]
          (go
            (<! (http/put (str api-base "/api/database-import/source-discovery")
                          {:json-params {:database_id target-database-id
                                         :source_path (first paths)
                                         :discovery discovery}}))))))))

(defn save-import-state!
  "Persist import viewer state to server"
  []
  (let [{:keys [active-path selected-paths object-type]} @viewer-state]
    (go
      (<! (http/put (str api-base "/api/session/import-state")
                    {:json-params {:loaded_path active-path
                                   :selected_paths selected-paths
                                   :object_type (when object-type (name object-type))}})))))

(defn- load-import-chat-for-id!
  "Look up database name from ID and load the import transcript."
  [db-id]
  (when (and db-id (= (:app-mode @state/app-state) :import))
    (let [db (first (filter #(= (:database_id %) db-id)
                            (:available-databases @state/app-state)))]
      (state/load-import-chat! (:name db)))))

(defn restore-import-state!
  "Load saved import state from server and restore viewer position.
   Skips reload if data is already present in viewer-state."
  []
  ;; Always refresh import status for the current database (global selector = import target)
  (let [db-id (current-target-db-id)]
    (when db-id
      (load-target-existing! db-id)
      (load-import-chat-for-id! db-id)))
  ;; If viewer already has loaded data, just restore the sidebar list
  (if (seq (:selected-paths @viewer-state))
    (do
      (when (empty? (get-in @state/app-state [:objects :access_databases]))
        (state/load-access-databases!))
      (when-let [active (:active-path @viewer-state)]
        (load-import-history! active)))
    ;; Otherwise fetch saved state from server
    (go
      (let [response (<! (http/get (str api-base "/api/session/import-state")))]
        (when (and (:success response) (seq (:body response)))
          (let [{:keys [loaded_path selected_paths object_type]} (:body response)
                paths (or (seq selected_paths) (when loaded_path [loaded_path]))]
            (when object_type
              (swap! viewer-state assoc :object-type (keyword object_type)))
            (when (seq paths)
              (when (empty? (get-in @state/app-state [:objects :access_databases]))
                (state/load-access-databases!))
              (swap! viewer-state assoc :selected-paths (vec paths))
              ;; Load contents for all selected paths; the last one loaded becomes active display
              (doseq [p paths]
                (load-access-database-contents! p)))))))))

(defn- fetch-existing-names!
  "Fetch object names from an API endpoint and store in target-existing."
  [headers endpoint body-key obj-type extract-fn]
  (go
    (let [response (<! (http/get (str api-base endpoint) {:headers headers}))]
      (when (:success response)
        (let [names (set (extract-fn (get-in response [:body body-key] [])))]
          (swap! viewer-state assoc-in [:target-existing obj-type] names))))))

(defn load-target-existing!
  "Load existing object names from the target database to flag already-imported items"
  [database-id]
  (when database-id
    (let [headers {"X-Database-ID" database-id}]
      (fetch-existing-names! headers "/api/forms" :forms :forms identity)
      (fetch-existing-names! headers "/api/tables" :tables :tables #(map :name %))
      ;; Queries may be imported as views OR functions (parameterized queries become functions).
      ;; Check both endpoints and merge names.
      (go
        (let [qr (<! (http/get (str api-base "/api/queries") {:headers headers}))
              fr (<! (http/get (str api-base "/api/functions") {:headers headers}))
              view-names (when (:success qr) (map :name (get-in qr [:body :queries] [])))
              func-names (when (:success fr) (map :name (get-in fr [:body :functions] [])))]
          (swap! viewer-state assoc-in [:target-existing :queries]
                 (set (concat view-names func-names)))))
      (fetch-existing-names! headers "/api/modules" :modules :modules identity)
      (fetch-existing-names! headers "/api/macros" :macros :macros identity)
      (fetch-existing-names! headers "/api/reports" :reports :reports identity)
      (load-image-status! database-id))))

(defn load-image-status!
  "Fetch image control list from saved definitions"
  [database-id]
  (when database-id
    (go
      (let [response (<! (http/get (str api-base "/api/database-import/image-status")
                                   {:query-params {:targetDatabaseId database-id}}))]
        (when (:success response)
          (let [body (:body response)]
            (swap! viewer-state assoc
                   :image-status {:total (get body :total 0)
                                  :imported (get body :imported 0)}
                   :images (or (get body :images) []))))))))

(defn load-target-existing-async!
  "Like load-target-existing! but returns a channel that closes when all fetches complete"
  [database-id]
  (let [done (chan)]
    (if-not database-id
      (put! done true)
      (let [headers {"X-Database-ID" database-id}]
        (go
          ;; Run all fetches in parallel, await each
          (<! (fetch-existing-names! headers "/api/forms" :forms :forms identity))
          (<! (fetch-existing-names! headers "/api/tables" :tables :tables #(map :name %)))
          (let [qr (<! (http/get (str api-base "/api/queries") {:headers headers}))
                fr (<! (http/get (str api-base "/api/functions") {:headers headers}))
                view-names (when (:success qr) (map :name (get-in qr [:body :queries] [])))
                func-names (when (:success fr) (map :name (get-in fr [:body :functions] [])))]
            (swap! viewer-state assoc-in [:target-existing :queries]
                   (set (concat view-names func-names))))
          (<! (fetch-existing-names! headers "/api/modules" :modules :modules identity))
          (<! (fetch-existing-names! headers "/api/macros" :macros :macros identity))
          (<! (fetch-existing-names! headers "/api/reports" :reports :reports identity))
          (put! done true))))
    done))

(defn run-assessment!
  "Collect scan data from the access-db-cache and run the pre-import assessment.
   Merges data from all selected databases. Skips if assessment already exists."
  []
  (when-not (:assessment-findings @state/app-state)
    (let [paths (:selected-paths @viewer-state)
          cache (:access-db-cache @viewer-state)]
      (when (and (seq paths)
                 (:target-database-id @viewer-state)
                 ;; Only run if at least one path has cached data
                 (some #(get cache %) paths))
        (let [merge-lists (fn [k] (vec (distinct (mapcat #(get (get cache %) k []) paths))))
              scan-data {:tables        (merge-lists :tables)
                         :queries       (merge-lists :queries)
                         :relationships (merge-lists :relationships)
                         :forms         (merge-lists :forms)
                         :reports       (merge-lists :reports)
                         :modules       (merge-lists :modules)
                         :macros        (merge-lists :macros)}]
          (f/run-fire-and-forget! (ui-flows/run-assessment-flow) {:scan-data scan-data}))))))

(defn load-import-history!
  "Load import history for the target database (all object types, all sources).
   Falls back to source_path filter if no target database is selected."
  [db-path]
  (go
    (let [target-db (:target-database-id @viewer-state)
          query-params (if target-db
                         {:target_database_id target-db :limit 200}
                         {:source_path db-path :limit 200})
          response (<! (http/get (str api-base "/api/database-import/history")
                                 {:query-params query-params}))]
      (when (:success response)
        (let [history (get-in response [:body :history] [])]
          (swap! viewer-state assoc :import-log history)
          (save-import-state!))))))

(defn- apply-cached-contents!
  "Apply cached Access database contents to viewer-state"
  [db-path cached]
  (swap! viewer-state assoc
         :loading? false :error nil :active-path db-path
         :forms (:forms cached)
         :reports (:reports cached)
         :tables (:tables cached)
         :queries (:queries cached)
         :modules (:modules cached)
         :macros (:macros cached)
         :selected #{}))

(defn- fetch-and-cache-contents!
  "Fetch Access database contents from API and store in cache"
  [db-path]
  (go
    (let [response (<! (http/get (str api-base "/api/database-import/database")
                                 {:query-params {:path db-path}}))]
      (if (:success response)
        (let [body (:body response)
              contents {:forms (or (:forms body) [])
                        :reports (or (:reports body) [])
                        :tables (or (:tables body) [])
                        :queries (or (:queries body) [])
                        :modules (or (:modules body) [])
                        :macros (or (:macros body) [])
                        :relationships (or (:relationships body) [])}]
          (swap! viewer-state assoc-in [:access-db-cache db-path] contents)
          (swap! viewer-state assoc
                 :loading? false
                 :forms (:forms contents)
                 :reports (:reports contents)
                 :tables (:tables contents)
                 :queries (:queries contents)
                 :modules (:modules contents)
                 :macros (:macros contents)
                 :selected #{})
          ;; Trigger assessment if target is already selected
          (run-assessment!))
        (swap! viewer-state assoc
               :loading? false
               :error (or (get-in response [:body :error]) "Failed to load database"))))))

(defn load-access-database-contents!
  "Load Access database contents, using cache if available.
   Skips if already loading to prevent concurrent COM requests."
  ([db-path] (load-access-database-contents! db-path false))
  ([db-path force-refresh?]
   (when-not (:loading? @viewer-state)
     (swap! viewer-state assoc :active-path db-path :error nil)
     (save-import-state!)
     (load-import-history! db-path)
     (let [cached (get-in @viewer-state [:access-db-cache db-path])]
       (if (and cached (not force-refresh?))
         (apply-cached-contents! db-path cached)
         (do
           (swap! viewer-state assoc :loading? true)
           (fetch-and-cache-contents! db-path)))))))

(defn set-active-database!
  "Switch which database's objects are displayed, using cached contents."
  [db-path]
  (when (and db-path (some #{db-path} (:selected-paths @viewer-state)))
    (let [cached (get-in @viewer-state [:access-db-cache db-path])]
      (when cached
        (apply-cached-contents! db-path cached)))))

(defn toggle-database-selection!
  "Toggle a database in/out of :selected-paths. Called from sidebar click."
  [db-path]
  (let [{:keys [selected-paths active-path]} @viewer-state]
    ;; Source databases changed — clear stale assessment
    (t/dispatch! :clear-assessment)
    (if (some #{db-path} selected-paths)
      ;; Remove from selection
      (let [new-paths (vec (remove #{db-path} selected-paths))
            new-active (if (= db-path active-path)
                         (first new-paths)
                         active-path)]
        (swap! viewer-state assoc :selected-paths new-paths :active-path new-active)
        (if new-active
          (set-active-database! new-active)
          ;; No databases selected — clear display slots
          (swap! viewer-state assoc
                 :forms [] :reports [] :tables [] :queries []
                 :modules [] :macros [] :selected #{}))
        (save-import-state!))
      ;; Add to selection — clear target so user must choose before importing
      (do
        (swap! viewer-state assoc
               :target-database-id nil
               :target-existing {})
        (swap! viewer-state update :selected-paths conj db-path)
        (load-access-database-contents! db-path)))))

(defn toggle-selection! [item-name]
  (swap! viewer-state update :selected
         (fn [sel]
           (if (contains? sel item-name)
             (disj sel item-name)
             (conj sel item-name)))))

(defn select-all! []
  (let [obj-type (:object-type @viewer-state)
        items (get @viewer-state obj-type [])
        item-names (map get-item-name items)]
    (swap! viewer-state assoc :selected (set item-names))))

(defn select-none! []
  (swap! viewer-state assoc :selected #{}))

(defn import-form!
  "Import a single form: get JSON from Access, convert, save to target database"
  [access-db-path form-name target-database-id]
  (go
    ;; Step 1: Get JSON metadata from Access via PowerShell
    (let [response (<! (http/post (str api-base "/api/database-import/export-form")
                                  {:json-params {:databasePath access-db-path
                                                 :formName form-name
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :formData]))
        ;; Step 2: Convert JSON to AccessClone form definition
        (let [form-data (get-in response [:body :formData])
              import-log-id (get-in response [:body :import_log_id])
              schema (str "db_" target-database-id)
              form-def (-> (convert-access-form form-data)
                           (rewrite-server-fn-controls schema))
              ;; Step 3: Save to target database via forms API (with import source marker)
              save-url (str api-base "/api/forms/" form-name
                            "?source=import"
                            (when import-log-id (str "&import_log_id=" import-log-id)))
              save-response (<! (http/put save-url
                                         {:json-params form-def
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            true
            (let [err (or (get-in save-response [:body :error]) "Unknown error")]
              (state/log-event! "error" (str "Failed to save form: " form-name) "import-form"
                                {:error err})
              {:error err})))
        (let [err (or (get-in response [:body :error]) "Unknown error")]
          (state/log-event! "error" (str "Failed to export form: " form-name) "import-form"
                            {:error err})
          {:error err})))))

(defn import-report!
  "Import a single report: get JSON from Access, convert, save to target database"
  [access-db-path report-name target-database-id]
  (go
    ;; Step 1: Get JSON metadata from Access via PowerShell
    (let [response (<! (http/post (str api-base "/api/database-import/export-report")
                                  {:json-params {:databasePath access-db-path
                                                 :reportName report-name
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :reportData]))
        ;; Step 2: Convert JSON to AccessClone report definition
        (let [report-data (get-in response [:body :reportData])
              import-log-id (get-in response [:body :import_log_id])
              report-def (convert-access-report report-data)
              ;; Step 3: Save to target database via reports API (with import source marker)
              save-url (str api-base "/api/reports/" report-name
                            "?source=import"
                            (when import-log-id (str "&import_log_id=" import-log-id)))
              save-response (<! (http/put save-url
                                         {:json-params report-def
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            true
            (let [err (or (get-in save-response [:body :error]) "Unknown error")]
              (state/log-event! "error" (str "Failed to save report: " report-name) "import-report"
                                {:error err})
              {:error err})))
        (let [err (or (get-in response [:body :error]) "Unknown error")]
          (state/log-event! "error" (str "Failed to export report: " report-name) "import-report"
                            {:error err})
          {:error err})))))

(defn import-module!
  "Import a single module: get VBA source from Access, save to target database"
  [access-db-path module-name target-database-id]
  (go
    ;; Step 1: Get VBA source from Access via PowerShell
    (let [response (<! (http/post (str api-base "/api/database-import/export-module")
                                  {:json-params {:databasePath access-db-path
                                                 :moduleName module-name
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :moduleData]))
        ;; Step 2: Save VBA source to target database via modules API
        (let [module-data (get-in response [:body :moduleData])
              save-response (<! (http/put (str api-base "/api/modules/" module-name)
                                         {:json-params {:vba_source (:code module-data)}
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            true
            (let [err (or (get-in save-response [:body :error]) "Unknown error")]
              (state/log-event! "error" (str "Failed to save module: " module-name) "import-module"
                                {:error err})
              {:error err})))
        (let [err (or (get-in response [:body :error]) "Unknown error")]
          (state/log-event! "error" (str "Failed to export module: " module-name) "import-module"
                            {:error err})
          {:error err})))))

(defn import-macro!
  "Import a single macro: get XML definition from Access, save to target database"
  [access-db-path macro-name target-database-id]
  (go
    ;; Step 1: Get XML definition from Access via PowerShell
    (let [response (<! (http/post (str api-base "/api/database-import/export-macro")
                                  {:json-params {:databasePath access-db-path
                                                 :macroName macro-name
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :macroData]))
        ;; Step 2: Save macro XML to target database via macros API
        (let [macro-data (get-in response [:body :macroData])
              save-response (<! (http/put (str api-base "/api/macros/" macro-name)
                                         {:json-params {:macro_xml (:definition macro-data)}
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            true
            (let [err (or (get-in save-response [:body :error]) "Unknown error")]
              (state/log-event! "error" (str "Failed to save macro: " macro-name) "import-macro"
                                {:error err})
              {:error err})))
        (let [err (or (get-in response [:body :error]) "Unknown error")]
          (state/log-event! "error" (str "Failed to export macro: " macro-name) "import-macro"
                            {:error err})
          {:error err})))))

(defn import-table!
  "Import a single table: server-side pipeline extracts structure + data from Access and creates PG table"
  [access-db-path table-name target-database-id & [{:keys [force?]}]]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/import-table")
                                  {:json-params (cond-> {:databasePath access-db-path
                                                         :tableName table-name
                                                         :targetDatabaseId target-database-id}
                                                  force? (assoc :force true))}))]
      (if (and (:success response) (get-in response [:body :success]))
        true
        (let [err (or (get-in response [:body :error]) "Unknown error")]
          (state/log-event! "error" (str "Failed to import table: " table-name) "import-table"
                            {:error err})
          {:error err})))))

(defn import-query!
  "Import a single query: server-side pipeline extracts SQL from Access, converts to PG view/function"
  [access-db-path query-name target-database-id & [{:keys [force?]}]]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/import-query")
                                  {:json-params (cond-> {:databasePath access-db-path
                                                         :queryName query-name
                                                         :targetDatabaseId target-database-id}
                                                  force? (assoc :force true))}))]
      (if (and (:success response) (get-in response [:body :success]))
        true
        (let [err (or (get-in response [:body :error]) "Unknown error")
              category (get-in response [:body :category])]
          (when-not (= category "missing-dependency")
            ;; Only log non-dependency errors (dependency errors are expected during retry)
            (state/log-event! "error" (str "Failed to import query: " query-name) "import-query"
                              {:error err}))
          {:error err :category category})))))

;; ============================================================
;; Batch Import Functions (single COM session per type)
;; ============================================================

(def batch-eligible-types #{:forms :reports :modules :macros})

(defn import-forms-batch!
  "Batch import forms: single COM session export, then convert + save each.
   Falls back to individual import for any forms missing from the batch result.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path form-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/export-forms-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec form-names)
                                                 :targetDatabaseId target-database-id}}))
          imported (atom [])
          failed (atom [])
          schema (str "db_" target-database-id)]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])]
          (reset! failed (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))
          (doseq [[k form-data] objects]
            (let [form-name (name k)
                  form-def (-> (convert-access-form form-data)
                               (rewrite-server-fn-controls schema))
                  save-url (str api-base "/api/forms/" form-name "?source=import")
                  save-response (<! (http/put save-url
                                             {:json-params form-def
                                              :headers {"X-Database-ID" target-database-id}}))]
              (if (:success save-response)
                (swap! imported conj form-name)
                (swap! failed conj {:name form-name
                                    :error (or (get-in save-response [:body :error]) "Save failed")})))))
        ;; Total batch failure -- all will be retried individually below
        nil)
      ;; Retry any forms missing from both imported and failed (dropped by COM crash)
      (let [handled (set (concat @imported (map :name @failed)))
            missing (remove handled form-names)]
        (when (seq missing)
          (println (str "[BATCH] Retrying " (count missing) " forms individually..."))
          (doseq [form-name missing]
            (let [result (<! (import-form! access-db-path form-name target-database-id))]
              (if (true? result)
                (swap! imported conj form-name)
                (swap! failed conj {:name form-name
                                    :error (if (map? result) (:error result) "Individual import failed")}))))))
      {:imported @imported :failed @failed})))

(defn import-reports-batch!
  "Batch import reports: single COM session export, then convert + save each.
   Falls back to individual import for any reports missing from the batch result.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path report-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/export-reports-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec report-names)
                                                 :targetDatabaseId target-database-id}}))
          imported (atom [])
          failed (atom [])]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])]
          (reset! failed (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))
          (doseq [[k report-data] objects]
            (let [report-name (name k)
                  report-def (convert-access-report report-data)
                  save-url (str api-base "/api/reports/" report-name "?source=import")
                  save-response (<! (http/put save-url
                                             {:json-params report-def
                                              :headers {"X-Database-ID" target-database-id}}))]
              (if (:success save-response)
                (swap! imported conj report-name)
                (swap! failed conj {:name report-name
                                    :error (or (get-in save-response [:body :error]) "Save failed")})))))
        nil)
      ;; Retry any reports missing from both imported and failed
      (let [handled (set (concat @imported (map :name @failed)))
            missing (remove handled report-names)]
        (when (seq missing)
          (println (str "[BATCH] Retrying " (count missing) " reports individually..."))
          (doseq [report-name missing]
            (let [result (<! (import-report! access-db-path report-name target-database-id))]
              (if (true? result)
                (swap! imported conj report-name)
                (swap! failed conj {:name report-name
                                    :error (if (map? result) (:error result) "Individual import failed")}))))))
      {:imported @imported :failed @failed})))

(defn import-modules-batch!
  "Batch import modules: single COM session export, then save each.
   Falls back to individual import for any modules missing from the batch result.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path module-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/export-modules-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec module-names)
                                                 :targetDatabaseId target-database-id}}))
          imported (atom [])
          failed (atom [])]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])]
          (reset! failed (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))
          (doseq [[k module-data] objects]
            (let [module-name (name k)
                  save-response (<! (http/put (str api-base "/api/modules/" module-name)
                                             {:json-params {:vba_source (:code module-data)}
                                              :headers {"X-Database-ID" target-database-id}}))]
              (if (:success save-response)
                (swap! imported conj module-name)
                (swap! failed conj {:name module-name
                                    :error (or (get-in save-response [:body :error]) "Save failed")})))))
        nil)
      ;; Retry any modules missing from both imported and failed
      (let [handled (set (concat @imported (map :name @failed)))
            missing (remove handled module-names)]
        (when (seq missing)
          (println (str "[BATCH] Retrying " (count missing) " modules individually..."))
          (doseq [module-name missing]
            (let [result (<! (import-module! access-db-path module-name target-database-id))]
              (if (true? result)
                (swap! imported conj module-name)
                (swap! failed conj {:name module-name
                                    :error (if (map? result) (:error result) "Individual import failed")}))))))
      {:imported @imported :failed @failed})))

(defn import-macros-batch!
  "Batch import macros: single COM session export, then save each.
   Falls back to individual import for any macros missing from the batch result.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path macro-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/export-macros-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec macro-names)
                                                 :targetDatabaseId target-database-id}}))
          imported (atom [])
          failed (atom [])]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])]
          (reset! failed (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))
          (doseq [[k macro-data] objects]
            (let [macro-name (name k)
                  save-response (<! (http/put (str api-base "/api/macros/" macro-name)
                                             {:json-params {:macro_xml (:definition macro-data)}
                                              :headers {"X-Database-ID" target-database-id}}))]
              (if (:success save-response)
                (swap! imported conj macro-name)
                (swap! failed conj {:name macro-name
                                    :error (or (get-in save-response [:body :error]) "Save failed")})))))
        nil)
      ;; Retry any macros missing from both imported and failed
      (let [handled (set (concat @imported (map :name @failed)))
            missing (remove handled macro-names)]
        (when (seq missing)
          (println (str "[BATCH] Retrying " (count missing) " macros individually..."))
          (doseq [macro-name missing]
            (let [result (<! (import-macro! access-db-path macro-name target-database-id))]
              (if (true? result)
                (swap! imported conj macro-name)
                (swap! failed conj {:name macro-name
                                    :error (if (map? result) (:error result) "Individual import failed")}))))))
      {:imported @imported :failed @failed})))

(defn- batch-import-fn-for-type
  "Return the batch import function for a given object type"
  [obj-type]
  (case obj-type
    :forms   import-forms-batch!
    :reports import-reports-batch!
    :modules import-modules-batch!
    :macros  import-macros-batch!
    nil))

(defn import-selected!
  "Import selected objects to the current AccessClone database.
   Uses batch import for forms/reports/modules/macros when >1 selected."
  [access-db-path target-database-id]
  (let [obj-type (:object-type @viewer-state)
        selected (vec (:selected @viewer-state))]
    (swap! viewer-state assoc :importing? true)
    (go
      (if (= obj-type :images)
        ;; Images: single COM session extracts all image controls + attachment files
        (do (<! (import-images! access-db-path target-database-id))
            (<! (import-attachments! access-db-path target-database-id)))
        (if (and (> (count selected) 1) (contains? batch-eligible-types obj-type))
          ;; Batch import for forms/reports/modules/macros
          (let [batch-fn (batch-import-fn-for-type obj-type)
                result (<! (batch-fn access-db-path selected target-database-id))]
            (doseq [{:keys [name error]} (:failed result)]
              (state/log-event! "error" (str "Failed to import " (clojure.core/name obj-type) ": " name)
                                "import-batch" {:error error})))
          ;; Individual import (single item, or tables/queries)
          ;; Queries use a retry loop to handle dependency ordering (max 20 passes)
          (if (and (= obj-type :queries) (> (count selected) 1))
            (loop [pass 1
                   pending selected]
              (let [imported-this-pass (atom 0)
                    still-pending (atom [])]
                (doseq [item-name pending]
                  (let [result (<! (import-query! access-db-path item-name target-database-id))]
                    (if (true? result)
                      (swap! imported-this-pass inc)
                      (swap! still-pending conj item-name))))
                (<! (load-import-history! access-db-path))
                (when (and (seq @still-pending) (pos? @imported-this-pass) (< pass 20))
                  (recur (inc pass) @still-pending))))
            (doseq [item-name selected]
              (case obj-type
                :forms   (<! (import-form! access-db-path item-name target-database-id))
                :reports (<! (import-report! access-db-path item-name target-database-id))
                :modules (<! (import-module! access-db-path item-name target-database-id))
                :macros  (<! (import-macro! access-db-path item-name target-database-id))
                :tables  (<! (import-table! access-db-path item-name target-database-id))
                :queries (<! (import-query! access-db-path item-name target-database-id))
                nil)
              (<! (load-import-history! access-db-path))))))
      ;; Refresh after completion
      (<! (load-import-history! access-db-path))
      (swap! viewer-state assoc :importing? false :selected #{})
      (save-source-discovery! target-database-id)
      (load-target-existing! target-database-id)
      (state/load-tables!)
      (state/load-queries!)
      (state/load-sql-functions!)
      (state/load-forms!)
      (state/load-reports!)
      (state/load-functions!)
      (state/load-macros!))))

(defn- import-fn-for-type
  "Return the import function for a given object type"
  [obj-type]
  (case obj-type
    :tables  import-table!
    :queries import-query!
    :forms   import-form!
    :reports import-report!
    :modules import-module!
    :macros  import-macro!
    nil))

(defn- not-yet-imported
  "Return [path name] tuples of source objects not yet imported for a given type,
   across all selected databases. Each object name only appears once (first path wins)."
  [obj-type]
  (let [paths (:selected-paths @viewer-state)
        cache (:access-db-cache @viewer-state)
        existing (get-in @viewer-state [:target-existing obj-type] #{})
        existing-sanitized (set (map sanitize-name existing))
        seen (atom #{})]
    (reduce (fn [acc p]
              (let [items (get (get cache p) obj-type [])
                    names (map get-item-name items)
                    pending (remove #(or (contains? existing-sanitized (sanitize-name %))
                                         (contains? @seen (sanitize-name %)))
                                    names)]
                (swap! seen into (map sanitize-name pending))
                (into acc (map (fn [n] [p n]) pending))))
            []
            paths)))

(defn- all-source-objects
  "Return [path name] tuples of ALL source objects for a given type,
   across all selected databases. Each name only appears once (first path wins)."
  [obj-type]
  (let [paths (:selected-paths @viewer-state)
        cache (:access-db-cache @viewer-state)
        seen (atom #{})]
    (reduce (fn [acc p]
              (let [items (get (get cache p) obj-type [])
                    names (map get-item-name items)
                    fresh (remove #(contains? @seen (sanitize-name %)) names)]
                (swap! seen into (map sanitize-name fresh))
                (into acc (map (fn [n] [p n]) fresh))))
            []
            paths)))

(defn- create-function-stubs!
  "Call the server to create PG stub functions from VBA module declarations.
   Returns a channel that closes when done."
  [target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/create-function-stubs")
                                  {:json-params {:targetDatabaseId target-database-id}}))]
      (when (:success response)
        (let [body (:body response)
              created (get body :created [])
              warnings (get body :warnings [])]
          (when (seq created)
            (println (str "[STUBS] Created " (count created) " stub functions: " (str/join ", " created))))
          (when (seq warnings)
            (doseq [w warnings]
              (println (str "[STUBS] Warning: " w)))))))))

(defn import-images!
  "Call the server to extract and embed images from Access form/report image controls.
   Returns a channel that closes when done."
  [access-db-path target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/database-import/import-images")
                                  {:json-params {:databasePath access-db-path
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :success]))
        (let [image-count (get-in response [:body :imageCount] 0)]
          (when (pos? image-count)
            (println (str "[IMAGES] Imported " image-count " images")))
          (load-image-status! target-database-id))
        (let [err (or (get-in response [:body :error]) "Image import failed")]
          (state/log-event! "warning" (str "Image import: " err) "import-images"))))))

(defn import-attachments!
  "Call the server to extract attachment files from Access attachment columns.
   Iterates all tables in the source database and imports any attachment data found.
   Returns a channel that closes when done."
  [access-db-path target-database-id]
  (go
    (let [tables (:tables @viewer-state)
          table-names (map :name tables)]
      (doseq [table-name table-names]
        (let [response (<! (http/post (str api-base "/api/database-import/import-attachments")
                                      {:json-params {:databasePath access-db-path
                                                     :tableName table-name
                                                     :targetDatabaseId target-database-id}}))]
          (when (and (:success response) (get-in response [:body :success]))
            (let [cnt (get-in response [:body :count] 0)]
              (when (pos? cnt)
                (println (str "[ATTACHMENTS] Imported " cnt " attachments from " table-name))))))))))

(defn reimport-object!
  "Re-import a single form or report from the Access source database.
   Reads the Access DB path from viewer-state (falls back to server-saved import state).
   Uses the current database as target. Returns a channel yielding true or {:error msg}.
   On success, also re-converts the record-source query, re-translates the class module,
   and runs repair + validation passes."
  [object-type object-name]
  (go
    (let [;; Try viewer-state first, then fall back to saved import state on the server
          access-db-path (or (first (:selected-paths @viewer-state))
                             (let [resp (<! (http/get (str api-base "/api/session/import-state")))]
                               (first (or (seq (:selected_paths (:body resp)))
                                          (when-let [p (:loaded_path (:body resp))] [p])))))
          target-db-id (:database_id (:current-database @state/app-state))]
      (if (and access-db-path target-db-id)
        (let [result (case object-type
                       :forms (<! (import-form! access-db-path object-name target-db-id))
                       :reports (<! (import-report! access-db-path object-name target-db-id))
                       {:error (str "Unsupported type: " (name object-type))})]
          (when (true? result)
            ;; Targeted image import for just this object
            (let [img-params (cond-> {:databasePath access-db-path
                                      :targetDatabaseId target-db-id}
                               (= object-type :forms) (assoc :formNames [object-name])
                               (= object-type :reports) (assoc :reportNames [object-name]))
                  img-resp (<! (http/post (str api-base "/api/database-import/import-images")
                                          {:json-params img-params}))]
              (when (and (:success img-resp) (pos? (get-in img-resp [:body :imageCount] 0)))
                (println (str "[REIMPORT] Imported images for " object-name))))

            ;; Step A: Re-convert record-source query (if not a raw SELECT or table)
            (let [api-type (if (= object-type :forms) "forms" "reports")
                  def-resp (<! (http/get (str api-base "/api/" api-type "/" object-name)
                                         {:headers {"X-Database-ID" target-db-id}}))
                  record-source (when (:success def-resp)
                                  (get-in def-resp [:body :record-source]))]
              (when (and record-source
                         (not (re-find #"(?i)^\s*SELECT\s" record-source)))
                (println (str "[REIMPORT] Re-converting query: " record-source))
                (let [q-result (<! (import-query! access-db-path record-source target-db-id {:force? true}))]
                  (if (true? q-result)
                    (println (str "[REIMPORT] Query re-converted: " record-source))
                    (println (str "[REIMPORT] Query re-conversion skipped: " record-source))))))

            ;; Step B: Re-translate class module (Form_X or Report_X)
            (let [module-prefix (if (= object-type :forms) "Form_" "Report_")
                  module-name (str module-prefix object-name)
                  translate-resp (<! (http/post (str api-base "/api/database-import/translate-modules")
                                                {:json-params {:database_id target-db-id
                                                               :module_names [module-name]}}))]
              (when (:success translate-resp)
                (println (str "[REIMPORT] Module translated: " module-name))))

            ;; Step B2: Resolve VBA UDF expressions for this specific object
            (let [resolve-resp (<! (http/post (str api-base "/api/database-import/resolve-expressions")
                                              {:json-params {:database_id target-db-id}
                                               :headers {"X-Database-ID" target-db-id}
                                               :timeout 300000}))]
              (when (and (:success resolve-resp)
                         (seq (get-in resolve-resp [:body :translated])))
                (println (str "[REIMPORT] Expressions resolved: "
                              (count (get-in resolve-resp [:body :translated])) " functions"))))

            ;; Step C: Run repair + validation passes
            (<! (http/post (str api-base "/api/database-import/repair-pass")
                           {:json-params {:database_id target-db-id}}))
            (<! (http/post (str api-base "/api/database-import/validation-pass")
                           {:json-params {:database_id target-db-id}}))
            (println "[REIMPORT] Repair + validation complete"))
          result)
        {:error "No Access database configured. Visit the Import tab first."}))))

;; ============================================================
;; Import Phase Functions
;; ============================================================

(defn- collect-phase-items
  "Collect [obj-type path name] tuples for a phase, optionally filtering empty tables."
  [types force? empty-tables]
  (let [raw-items (vec (mapcat (fn [t]
                                 (map (fn [[p n]] [t p n])
                                      (if force? (all-source-objects t) (not-yet-imported t))))
                               types))]
    (if (and (seq empty-tables) (= types [:tables]))
      (vec (remove (fn [[_ _ obj-name]] (contains? empty-tables obj-name)) raw-items))
      raw-items)))

(defn- run-phase-import!
  "Run batch or individual import for a set of items. Returns channel with {:imported N :failed [...]}.
   Updates viewer-state progress along the way."
  [phase-items use-batch? target-database-id force? total-imported]
  (go
    (let [items (atom phase-items)
          phase-failed (atom [])]
      (if use-batch?
        ;; Batch mode: group by [obj-type, db-path], one COM session per group
        (let [groups (group-by (fn [[t p _]] [t p]) @items)]
          (doseq [[[obj-type db-path] group-items] groups]
            (let [names (mapv (fn [[_ _ n]] n) group-items)
                  batch-fn (batch-import-fn-for-type obj-type)]
              (swap! viewer-state assoc-in [:import-all-status :current]
                     (str (count names) " " (clojure.core/name obj-type)))
              (let [result (<! (batch-fn db-path names target-database-id))]
                (swap! total-imported + (count (:imported result)))
                (swap! viewer-state assoc-in [:import-all-status :imported] @total-imported)
                (doseq [{:keys [name error]} (:failed result)]
                  (swap! phase-failed conj {:type obj-type :name name :error error}))))))
        ;; Individual mode with retry loop (max 20 passes)
        (loop [pass 1]
          (let [remaining @items
                imported-this-pass (atom 0)
                still-pending (atom [])
                permanent-failures (atom [])]
            (doseq [[obj-type db-path obj-name] remaining]
              (swap! viewer-state assoc-in [:import-all-status :current] obj-name)
              (let [import-fn (import-fn-for-type obj-type)
                    result (<! (import-fn db-path obj-name target-database-id (when force? {:force? true})))]
                (if (true? result)
                  (do (swap! imported-this-pass inc)
                      (swap! total-imported inc)
                      (swap! viewer-state assoc-in [:import-all-status :imported] @total-imported))
                  ;; Only retry dependency errors; permanent failures go straight to failed
                  (let [category (when (map? result) (:category result))
                        err-msg (if (map? result) (:error result) "Unknown error")]
                    (if (= category "missing-dependency")
                      (swap! still-pending conj [obj-type db-path obj-name err-msg])
                      (swap! permanent-failures conj [obj-type db-path obj-name err-msg]))))))
            ;; Record permanent failures immediately
            (doseq [[obj-type _ obj-name err] @permanent-failures]
              (swap! phase-failed conj {:type obj-type :name obj-name :error err}))
            (reset! items @still-pending)
            (when (and (seq @items) (pos? @imported-this-pass) (< pass 20))
              (recur (inc pass))))))
      ;; Record any remaining as failed (only applies to individual mode)
      (doseq [[obj-type _ obj-name err] @items]
        (swap! phase-failed conj {:type obj-type :name obj-name :error err}))
      {:imported @total-imported :failed @phase-failed})))

(defn- import-tables-phase!
  "Import tables, then apply assessment fixes and extract attachments."
  [{:keys [target-database-id force? total-imported total-failed
           empty-tables all-relationships has-crosstab? reserved-words]}]
  (go
    (let [items (collect-phase-items [:tables] force? empty-tables)]
      (when (seq items)
        (swap! viewer-state assoc-in [:import-all-status :phase] :tables)
        (let [result (<! (run-phase-import! items false target-database-id force? total-imported))]
          (swap! total-failed into (:failed result)))
        (<! (load-target-existing-async! target-database-id)))
      ;; Phase hooks (run regardless of whether items existed)
      (when (or (seq empty-tables) (seq all-relationships)
                has-crosstab? (seq reserved-words))
        (let [resp (<! (http/post (str api-base "/api/database-import/apply-fixes")
                                  {:headers {"X-Database-ID" target-database-id}
                                   :json-params
                                   {:skipEmptyTables (vec empty-tables)
                                    :relationships all-relationships
                                    :installTablefunc (boolean has-crosstab?)
                                    :reservedWords (vec reserved-words)}}))]
          (when (:success resp)
            (.log js/console "Apply-fixes results:" (clj->js (:body resp))))))
      (doseq [p (:selected-paths @viewer-state)]
        (import-attachments! p target-database-id)))))

(defn- import-ui-phase!
  "Import forms & reports, then extract and embed images."
  [{:keys [target-database-id force? total-imported total-failed]}]
  (go
    (let [items (collect-phase-items [:forms :reports] force? nil)]
      (when (seq items)
        (swap! viewer-state assoc-in [:import-all-status :phase] :ui)
        (let [result (<! (run-phase-import! items true target-database-id force? total-imported))]
          (swap! total-failed into (:failed result)))
        (<! (load-target-existing-async! target-database-id)))
      ;; Phase hook: extract images (fire-and-forget — cosmetic, must not block)
      (doseq [p (:selected-paths @viewer-state)]
        (import-images! p target-database-id)))))

(defn- import-modules-phase!
  "Import modules, then create PG stub functions."
  [{:keys [target-database-id force? total-imported total-failed]}]
  (go
    (let [items (collect-phase-items [:modules] force? nil)]
      (when (seq items)
        (swap! viewer-state assoc-in [:import-all-status :phase] :modules)
        (let [result (<! (run-phase-import! items true target-database-id force? total-imported))]
          (swap! total-failed into (:failed result)))
        (<! (load-target-existing-async! target-database-id)))
      ;; Phase hook: create stub functions (always, even if no new modules)
      (<! (create-function-stubs! target-database-id)))))

(defn- import-queries-phase!
  "Import queries, then translate modules server-side (all deps now available)."
  [{:keys [target-database-id force? total-imported total-failed]}]
  (go
    (let [items (collect-phase-items [:queries] force? nil)]
      (when (seq items)
        (swap! viewer-state assoc-in [:import-all-status :phase] :queries)
        (let [result (<! (run-phase-import! items false target-database-id force? total-imported))]
          (swap! total-failed into (:failed result)))
        (<! (load-target-existing-async! target-database-id)))
      ;; Phase hook: translate modules (always, even if no new queries)
      (try
        (swap! viewer-state assoc-in [:import-all-status :phase] :translating)
        (swap! viewer-state assoc-in [:import-all-status :current] "Translating modules...")
        (let [resp (<! (http/post (str api-base "/api/database-import/translate-modules")
                                  {:json-params {:database_id target-database-id}
                                   :headers {"X-Database-ID" target-database-id}}))]
          (when (:success resp)
            (.log js/console "[IMPORT] Module translation:" (clj->js (:body resp)))))
        (catch js/Error e
          (.warn js/console "[IMPORT] Module translation failed (non-fatal):" (.-message e)))))))

(defn- resolve-expressions-phase!
  "Translate VBA UDFs referenced in form/report expressions from stubs to real PG implementations."
  [{:keys [target-database-id]}]
  (go
    (try
      (swap! viewer-state assoc-in [:import-all-status :phase] :resolving-expressions)
      (swap! viewer-state assoc-in [:import-all-status :current] "Resolving VBA expressions...")
      (let [resp (<! (http/post (str api-base "/api/database-import/resolve-expressions")
                                {:json-params {:database_id target-database-id}
                                 :headers {"X-Database-ID" target-database-id}
                                 :timeout 300000}))]
        (when (:success resp)
          (let [body (:body resp)]
            (.log js/console "[IMPORT] Expression resolution:"
                  (count (:translated body)) "translated,"
                  (count (:failed body)) "failed,"
                  (:formsUpdated body) "forms updated,"
                  (:reportsUpdated body) "reports updated"))))
      (catch js/Error e
        (.warn js/console "[IMPORT] Expression resolution failed (non-fatal):" (.-message e))))))

(defn- import-macros-phase!
  "Import macros."
  [{:keys [target-database-id force? total-imported total-failed]}]
  (go
    (let [items (collect-phase-items [:macros] force? nil)]
      (when (seq items)
        (swap! viewer-state assoc-in [:import-all-status :phase] :macros)
        (let [result (<! (run-phase-import! items true target-database-id force? total-imported))]
          (swap! total-failed into (:failed result)))
        (<! (load-target-existing-async! target-database-id))))))

(defn- extract-object-intents-phase!
  "Extract business intents from all forms, reports, and queries."
  [{:keys [target-database-id]}]
  (go
    (swap! viewer-state assoc-in [:import-all-status :phase] :extracting-intents)
    (swap! viewer-state assoc-in [:import-all-status :current] "Extracting business intents...")
    (let [resp (<! (http/post (str api-base "/api/database-import/extract-object-intents")
                              {:json-params {:database_id target-database-id}
                               :headers (state/db-headers)
                               :timeout 600000}))]
      (when (:success resp)
        (let [body (:body resp)]
          (.log js/console "[INTENTS] Extracted:"
                (+ (count (get-in body [:forms :extracted]))
                   (count (get-in body [:reports :extracted]))
                   (count (get-in body [:queries :extracted])))
                "objects"))))))

(defn- wire-events-phase!
  "Populate control_event_map for all forms and reports."
  [{:keys [target-database-id]}]
  (go
    (swap! viewer-state assoc-in [:import-all-status :phase] :wiring-events)
    (swap! viewer-state assoc-in [:import-all-status :current] "Wiring event handlers...")
    (let [resp (<! (http/post (str api-base "/api/database-import/wire-events")
                              {:headers (state/db-headers)
                               :timeout 120000}))]
      (when (:success resp)
        (let [body (:body resp)]
          (.log js/console "[WIRE-EVENTS] Forms:" (:formsWired body)
                "Reports:" (:reportsWired body)
                "Errors:" (count (:errors body))))))))

(defn- run-validation-pipeline!
  "Run multi-pass validation: repair → validate → autofix → design-check."
  [{:keys [target-database-id]}]
  (go
    (.log js/console "[MULTI-PASS] Phase loop complete, starting multi-pass...")
    (let [run-resp (<! (http/post (str api-base "/api/database-import/start-run")
                                   {:json-params {:database_id target-database-id
                                                  :source_paths (vec (:selected-paths @viewer-state))}}))
          run-id (when (:success run-resp) (get-in run-resp [:body :run_id]))]
      (swap! viewer-state assoc :current-run-id run-id)

      ;; Repair
      (.log js/console "[MULTI-PASS] Run ID:" run-id "- starting repair pass")
      (swap! viewer-state assoc-in [:import-all-status :phase] :repairing)
      (swap! viewer-state assoc-in [:import-all-status :current] "Checking bindings & mappings...")
      (let [repair-resp (<! (http/post (str api-base "/api/database-import/repair-pass")
                                        {:json-params {:run_id run-id :database_id target-database-id}}))]
        (when (:success repair-resp)
          (.log js/console "Repair pass:" (clj->js (:body repair-resp)))))

      ;; Validation
      (.log js/console "[MULTI-PASS] Starting validation pass")
      (swap! viewer-state assoc-in [:import-all-status :phase] :validating)
      (swap! viewer-state assoc-in [:import-all-status :current] "Validating forms & reports...")
      (let [val-resp (<! (http/post (str api-base "/api/database-import/validation-pass")
                                     {:json-params {:run_id run-id :database_id target-database-id}}))]
        (when (:success val-resp)
          (.log js/console "Validation pass:" (clj->js (:body val-resp)))))

      ;; Auto-fix
      (.log js/console "[MULTI-PASS] Starting auto-fix pass")
      (swap! viewer-state assoc-in [:import-all-status :phase] :auto-fixing)
      (swap! viewer-state assoc-in [:import-all-status :current] "Applying automated fixes...")
      (let [autofix-resp (<! (http/post (str api-base "/api/database-import/autofix-pass")
                                         {:json-params {:run_id run-id :database_id target-database-id}}))]
        (when (:success autofix-resp)
          (.log js/console "Auto-fix pass:" (clj->js (:body autofix-resp)))))

      ;; Design review
      (.log js/console "[MULTI-PASS] Starting design review")
      (swap! viewer-state assoc-in [:import-all-status :phase] :reviewing)
      (swap! viewer-state assoc-in [:import-all-status :current] "Running design checks...")
      (let [design-resp (<! (http/post (str api-base "/api/design-check/run")
                                        {:json-params {:database_id target-database-id
                                                       :run_id run-id
                                                       :pass_number 5}}))]
        (when (:success design-resp)
          (swap! viewer-state assoc :design-recommendations (get-in design-resp [:body :recommendations]))
          (.log js/console "Design check:" (clj->js (:body design-resp)))))

      run-id)))

(defn- finalize-import!
  "Complete the import run and refresh all app state."
  [{:keys [target-database-id total-imported total-failed]} run-id]
  (let [all-source (reduce + (map (fn [t] (:total (type-progress t)))
                                  [:tables :queries :forms :reports :modules :macros]))
        final-status {:phase :done
                      :current nil
                      :imported @total-imported
                      :total all-source
                      :failed @total-failed}]
    ;; Complete the run on server
    (when run-id
      (http/post (str api-base "/api/database-import/complete-run")
                  {:json-params {:run_id run-id
                                 :summary {:imported @total-imported
                                           :failed (count @total-failed)
                                           :total all-source}}}))
    (swap! viewer-state assoc
           :import-all-status final-status
           :importing? false
           :import-all-active? false
           :selected #{})
    ;; Refresh everything
    (save-source-discovery! target-database-id)
    (load-target-existing! target-database-id)
    (when-let [active (:active-path @viewer-state)]
      (load-import-history! active))
    (state/load-tables!)
    (state/load-queries!)
    (state/load-sql-functions!)
    (state/load-forms!)
    (state/load-reports!)
    (state/load-functions!)
    (state/load-macros!)
    ;; Invalidate module viewer cache so it refetches from DB (translation may have been saved)
    (swap! state/app-state assoc-in [:module-viewer :module-id] nil)))

(defn import-all!
  "Import all objects across all phases from all selected databases.
   Uses batch import for forms/reports/modules/macros (single COM session per type per db).
   Uses individual import with retry loop for tables/queries (server-side pipeline).
   When force? is true, re-imports ALL objects regardless of existing status."
  [target-database-id & [{:keys [force?]}]]
  (if (:import-all-active? @viewer-state)
    (do (println "[IMPORT] import-all! already running, ignoring duplicate call")
        (go nil))
    (do
      (swap! viewer-state assoc
             :import-all-active? true
             :importing? true
             :import-all-status {:phase nil :current nil :imported 0 :total 0 :failed []}
             :target-existing (if force? {} (:target-existing @viewer-state)))
      (go
    (let [findings (:assessment-findings @state/app-state)
          ctx {:target-database-id target-database-id
               :force? force?
               :total-imported (atom 0)
               :total-failed (atom [])
               :empty-tables (set (map :object (filter #(= (:type %) "empty-table")
                                                       (:design findings))))
               :has-crosstab? (some #(= (:type %) "crosstab-query")
                                    (:complexity findings))
               :reserved-words (vec (map #(select-keys % [:object :objectType])
                                         (filter #(= (:type %) "reserved-word")
                                                 (:structural findings))))
               :all-relationships (vec (distinct
                                         (mapcat #(get (get (:access-db-cache @viewer-state) %) :relationships [])
                                                 (:selected-paths @viewer-state))))}]
      (<! (import-tables-phase! ctx))
      (<! (import-ui-phase! ctx))
      (<! (import-modules-phase! ctx))
      (<! (import-queries-phase! ctx))
      (<! (resolve-expressions-phase! ctx))
      (<! (import-macros-phase! ctx))
      (<! (extract-object-intents-phase! ctx))
      (<! (wire-events-phase! ctx))
      (let [run-id (<! (run-validation-pipeline! ctx))]
        (finalize-import! ctx run-id)))))))

(defn auto-import-all!
  "Import all objects, then translate modules server-side."
  [target-database-id]
  (swap! viewer-state assoc :auto-import-phase :importing)
  (go
    ;; Step 1: Import all objects (import-all! already calls translate-modules after queries phase)
    (<! (import-all! target-database-id {:force? true}))
    ;; Done — translation is handled inside import-all! via POST /api/database-import/translate-modules
    (swap! viewer-state assoc :auto-import-phase :complete)))

(defn trigger-import!
  "Import into the currently selected (global) database. Called from the header Import button."
  []
  (cond
    (not (source-selected?))
    (state/set-error! "Select an Access database first (Browse in the import panel)")

    (not (current-target-db-id))
    (state/set-error! "Select a target database from the dropdown")

    :else
    (auto-import-all! (current-target-db-id))))

(defn object-type-dropdown []
  (let [obj-type (:object-type @viewer-state)]
    [:div.access-object-type-selector
     [:select
      {:value (name obj-type)
       :on-change #(do
                     (swap! viewer-state assoc
                            :object-type (keyword (.. % -target -value))
                            :selected #{})
                     (save-import-state!))}
      [:option {:value "tables"} "Tables"]
      [:option {:value "queries"} "Queries"]
      [:option {:value "forms"} "Forms"]
      [:option {:value "reports"} "Reports"]
      [:option {:value "modules"} "Modules"]
      [:option {:value "macros"} "Macros"]]]))

(defn- phase-log-type
  "Map object type keyword to the source_object_type string stored in import_log."
  [obj-type]
  (case obj-type
    :tables "table"
    :queries "query"
    :forms "form"
    :reports "report"
    :modules "module"
    :macros "macro"
    :images nil
    nil))

(defn import-phase-tracker
  "Horizontal row of clickable phase buttons spanning both columns.
   Selected type is highlighted; importing indicator shown on active button."
  []
  (let [obj-type (:object-type @viewer-state)
        importing? (:importing? @viewer-state)
        active-phase (some (fn [p] (when (some #{obj-type} (:types p)) (:phase p)))
                           import-phases)
        ;; Build individual type buttons (not grouped by phase)
        type-buttons [[:tables "Tables"]
                      [:forms "Forms"]
                      [:reports "Reports"]
                      [:modules "Modules"]
                      [:queries "Queries"]
                      [:macros "Macros"]]]
    [:div.import-phase-tracker
     (for [[t label] type-buttons]
       (let [{:keys [total imported complete?]} (type-progress t)
             active? (= t obj-type)]
         ^{:key t}
         [:button.phase-btn
          {:class (str (when active? "active ")
                       (when complete? "complete "))
           :on-click #(do (swap! viewer-state assoc :object-type t :selected #{})
                          (save-import-state!))}
          [:span.phase-btn-label label]
          (when (pos? total)
            [:span.phase-btn-count (str imported "/" total)])
          (when (and active? importing?)
            [:span.phase-btn-spinner])]))
     ;; Images button — shown when images exist
     (let [{img-total :total img-imported :imported} (:image-status @viewer-state)
           has-ui? (or (pos? (:imported (type-progress :forms)))
                       (pos? (:imported (type-progress :reports))))
           img-complete? (and has-ui? img-total (pos? img-total) (= img-imported img-total))
           active? (= obj-type :images)]
       (when (and has-ui? img-total (pos? img-total))
         [:button.phase-btn
          {:class (str (when active? "active ")
                       (when img-complete? "complete "))
           :on-click #(do (swap! viewer-state assoc :object-type :images :selected #{})
                          (save-import-state!))}
          [:span.phase-btn-label "Images"]
          [:span.phase-btn-count (str img-imported "/" img-total)]
          (when (and active? importing?)
            [:span.phase-btn-spinner])]))]))

(defn dependency-warning
  "Informational banner when the selected type has unimported prerequisites.
   Not blocking — user can still import, but results may be incomplete."
  []
  (let [obj-type (:object-type @viewer-state)
        phase-def (some #(when (some #{obj-type} (:types %)) %) import-phases)]
    (when (and phase-def (seq (:requires phase-def)) (not (phase-ready? phase-def)))
      (let [missing (remove (fn [req-type]
                              (let [{:keys [total imported]} (type-progress req-type)]
                                (or (zero? total) (= total imported))))
                            (:requires phase-def))
            type-label (str/join " & " (map #(str/capitalize (name %)) (:types phase-def)))
            missing-labels (map (fn [t]
                                  (let [{:keys [total imported]} (type-progress t)]
                                    (str (str/capitalize (name t)) " (" imported "/" total ")")))
                                missing)]
        (when (seq missing)
          [:div.dependency-warning
           [:div.dep-warn-header
            [:strong "Recommended import order"]]
           [:div.dep-warn-body
            (str type-label " work best when "
                 (str/join ", " missing-labels)
                 " are imported first. You can still import now — or use ")
            [:strong "Auto-Import"]
            " to handle the order automatically."]])))))

(defn next-step-suggestion
  "Green banner shown when the current phase is fully imported"
  []
  (let [obj-type (:object-type @viewer-state)
        current-phase-def (some #(when (some #{obj-type} (:types %)) %) import-phases)
        current-idx (some (fn [[i p]] (when (= (:phase p) (:phase current-phase-def)) i))
                          (map-indexed vector import-phases))]
    (when (and current-phase-def current-idx)
      (let [{:keys [complete?]} (phase-progress current-phase-def)]
        (when complete?
          ;; Find the next non-empty, incomplete phase
          (let [next-phase (some (fn [p]
                                   (let [{:keys [complete? empty?]} (phase-progress p)]
                                     (when (and (not complete?) (not empty?)) p)))
                                 (drop (inc current-idx) import-phases))]
            (when next-phase
              [:div.next-step-suggestion
               {:on-click #(do (swap! viewer-state assoc
                                      :object-type (first (:types next-phase))
                                      :selected #{})
                               (save-import-state!))}
               [:span (str "All " (:label current-phase-def) " imported. Continue to "
                           (:label next-phase) " \u2192")]])))))))
(defn get-item-name
  "Extract name from item - handles both string items and object items"
  [item]
  (if (string? item)
    item
    (or (:name item) (str item))))

(defn get-item-detail
  "Get additional detail to show for an item based on type"
  [object-type item]
  (when-not (string? item)
    (case object-type
      :tables (str (:fieldCount item) " fields, " (:rowCount item) " rows")
      :queries (:type item)
      :modules (str (:lineCount item) " lines")
      :images (:objectType item)
      nil)))

(defn imported-names
  "Get set of object names (lowercased) that already exist in the target database"
  []
  (let [obj-type (:object-type @viewer-state)]
    (if (= obj-type :images)
      ;; Images have :imported flag on each item
      (set (map #(clojure.string/lower-case (:name %))
                (filter :imported (:images @viewer-state))))
      (let [names (get-in @viewer-state [:target-existing obj-type] #{})]
        (set (map clojure.string/lower-case names))))))

(defn- render-import-item
  "Render a single item in the import object list."
  [item object-type selected already-imported]
  (let [item-name (get-item-name item)
        item-detail (get-item-detail object-type item)
        imported? (contains? already-imported (clojure.string/lower-case item-name))]
    ^{:key item-name}
    [:li.import-item
     {:class (str (when (contains? selected item-name) "selected")
                  (when imported? " imported"))
      :on-click #(toggle-selection! item-name)}
     [:input {:type "checkbox"
              :checked (contains? selected item-name)
              :on-click #(.stopPropagation %)
              :on-change #(toggle-selection! item-name)}]
     [:span.item-name item-name]
     (when imported? [:span.imported-badge "imported"])
     (when item-detail [:span.item-detail item-detail])]))

(defn object-list []
  (let [{:keys [object-type selected loading?]} @viewer-state
        items (when object-type (get @viewer-state object-type []))
        already-imported (imported-names)]
    [:div.access-object-list
     (cond
       (nil? object-type) [:div.empty-list "Select an object type above to browse items."]
       loading? [:div.loading "Loading..."]
       (empty? items) [:div.empty-list (str "No " (name object-type) " found")]
       :else [:ul.import-list
              (for [item items]
                [render-import-item item object-type selected already-imported])])]))
(defn format-timestamp [ts]
  (when ts
    (let [d (js/Date. ts)]
      (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))))

(defn import-log-panel []
  (let [{:keys [import-log object-type design-recommendations]} @viewer-state
        filter-type (phase-log-type object-type)
        filtered (if filter-type
                   (filter #(= (:source_object_type %) filter-type) import-log)
                   import-log)
        by-pass (group-by #(or (:pass_number %) 1) filtered)
        pass-label {1 "Pass 1: Import" 2 "Pass 2: Repair" 3 "Pass 3: Validation" 4 "Pass 4: Auto-Fix" 5 "Pass 5: Design Review"}]
    [:div.import-log-panel
     [:div.log-header
      [:h4 "Import Log"]
      (when filter-type
        [:span.log-filter-label filter-type])]
     [:div.log-entries
      (if (empty? filtered)
        [:div.log-empty "No imports yet"]
        (for [[pass entries] (sort-by key by-pass)]
          ^{:key (str "pass-" pass)}
          [:div.log-pass-group
           [:div {:style {:font-weight "600" :padding "6px 0" :border-bottom "1px solid #eee"
                          :display "flex" :justify-content "space-between"}}
            [:span (get pass-label pass (str "Pass " pass))]
            [:span {:style {:font-size "12px" :color "#888"}}
             (let [ok (count (filter #(= "success" (:status %)) entries))
                   warns (count (filter #(= "warning" (:severity %)) entries))
                   errs (count (filter #(= "error" (:severity %)) entries))]
               (str ok " ok"
                    (when (pos? warns) (str ", " warns " warn"))
                    (when (pos? errs) (str ", " errs " err"))))]]
           (for [entry entries]
             ^{:key (:id entry)}
             [:div.log-entry {:class (:status entry)}
              [:div.log-entry-header
               [:span.log-object-type (:source_object_type entry)]
               [:span.log-object-name (:source_object_name entry)]
               [:span.log-status {:class (:status entry)} (:status entry)]
               (when (:severity entry)
                 [:span {:style {:margin-left "4px" :font-size "11px"
                                 :color (case (:severity entry)
                                          "error" "#e74c3c" "warning" "#f39c12" "#888")}}
                  (:severity entry)])]
              [:div.log-entry-details
               [:span.log-time (format-timestamp (:created_at entry))]
               (when (:category entry)
                 [:span {:style {:margin-left "6px" :font-size "11px" :color "#aaa"}} (:category entry)])]
              (when (:error_message entry)
                [:div.log-error (:error_message entry)])
              (when (:message entry)
                [:div {:style {:font-size "12px" :color "#666" :padding "2px 0"}} (:message entry)])
              (when (:suggestion entry)
                [:div {:style {:font-size "12px" :color "#3498db" :padding "2px 0"}} (:suggestion entry)])])]))]
     (when (seq design-recommendations)
       [:div {:style {:margin-top "12px" :border-top "1px solid #ddd" :padding-top "8px"}}
        [:h4 "Design Recommendations"]
        (for [[idx rec] (map-indexed vector design-recommendations)]
          ^{:key (str "rec-" idx)}
          [:div {:style {:padding "6px 0" :border-bottom "1px solid #eee"}}
           [:div {:style {:display "flex" :align-items "center" :gap "8px"}}
            [:span {:style {:font-weight "500" :color "#2c3e50"}} (:check_id rec)]
            [:span {:style {:color "#7f8c8d"}} (str (:object_type rec) ": " (:object_name rec))]]
           [:div {:style {:font-size "12px" :color "#555" :margin-top "2px"}} (:finding rec)]
           (when (:recommendation rec)
             [:div {:style {:font-size "12px" :color "#3498db" :margin-top "2px"}} (:recommendation rec)])])])]))

(defn suggest-name-from-path
  "Derive a suggested database name from the Access file path.
   e.g. 'C:\\...\\Diversity_Dev.accdb' → 'Diversity Dev'"
  []
  (when-let [path (:active-path @viewer-state)]
    (-> path
        (.split "\\")
        last
        (.replace #"\.(accdb|mdb)$" "")
        (.replace #"_" " "))))

(defn import-all-progress
  "Progress display shown during Import All operation"
  []
  (let [{:keys [import-all-active? import-all-status]} @viewer-state]
    (when (or import-all-active? (= (:phase import-all-status) :done))
      (let [{:keys [phase current imported total failed]} import-all-status]
        [:div.import-all-progress
         (if (= phase :done)
           ;; Summary
           [:div.import-all-summary
            [:div {:style {:display "flex" :align-items "center" :gap "8px"}}
             [:strong (str "Import complete: " imported " imported")]
             (when (seq failed)
               [:span.import-all-failed (str ", " (count failed) " failed")])
             [:button.btn-link
              {:on-click #(swap! viewer-state assoc :import-all-status nil)}
              "Dismiss"]]
            (when (seq failed)
              [:div.import-all-failed-details
               {:style {:max-height "200px" :overflow-y "auto" :margin-top "6px"
                        :font-size "12px" :line-height "1.5"}}
               (for [{:keys [type name error]} failed]
                 ^{:key (str (clojure.core/name type) "-" name)}
                 [:div {:style {:padding "2px 0"}}
                  [:span {:style {:font-weight "500"}} (str (clojure.core/name type) " " name)]
                  (when error
                    [:span {:style {:color "#999" :margin-left "6px"}} (str "— " error)])])])]
           ;; In progress
           [:div.import-all-running
            [:span.importing-indicator "Importing... "]
            (when phase
              [:span (str (str/capitalize (name phase)) ": ")])
            (when current
              [:span.import-all-current current])
            (when (pos? imported)
              [:span.import-all-count (str " (" imported " done)")])])]))))

(defn auto-import-phase-status
  "Status display for auto-import pipeline phases"
  []
  (let [phase (:auto-import-phase @viewer-state)]
    (when phase
      [:div.auto-import-phase {:class (when (= phase :complete) "complete")}
       (case phase
         :importing "Importing objects..."
         :extracting "Extracting intents from modules..."
         :resolving-gaps "Resolving gaps via AI..."
         :generating "Generating ClojureScript code..."
         :translating "Translating VBA modules..."
         :extracting-intents "Extracting business intents..."
         :repairing "Repairing bindings & mappings..."
         :validating "Validating forms & reports..."
         :auto-fixing "Applying automated fixes..."
         :reviewing "Running design checks..."
         :complete [:span {:style {:display "flex" :align-items "center" :gap "8px"}}
                    "Auto-import complete"
                    [:button.btn-link
                     {:on-click #(swap! viewer-state assoc :auto-import-phase nil)}
                     "Dismiss"]]
         nil)])))

(defn toolbar [access-db-path]
  (let [{:keys [selected object-type loading? importing?]} @viewer-state
        target-database-id (current-target-db-id)
        cached? (some? (get-in @viewer-state [:access-db-cache access-db-path]))
        ;; Count total un-imported objects across all types
        total-remaining (reduce + (map #(count (not-yet-imported %))
                                       [:tables :queries :forms :reports :modules :macros]))]
    (when object-type
      [:div.access-toolbar
       [:div.selection-actions
        [:button.btn-link {:on-click select-all!} "Select All"]
        [:button.btn-link {:on-click select-none!} "Select None"]
        [:span.selection-count (str (count selected) " selected")]
        [:button.btn-link {:on-click #(load-access-database-contents! access-db-path true)
                           :disabled loading?}
         (if cached? "Refresh" "Load")]]
       [:div.import-actions
        (when (and (not importing?) target-database-id
                   (if (= object-type :images)
                     (let [{:keys [total imported]} (:image-status @viewer-state)]
                       (and total (pos? total) (not= total imported)))
                     (seq selected)))
          [:button.btn-primary
           {:on-click #(import-selected! access-db-path target-database-id)}
           (if (= object-type :images)
             "Import All Images"
             (str "Import " (count selected) " " (name object-type)))])]])))

(defn- db-name-from-path
  "Extract filename from a full path"
  [path]
  (some-> path (.split "\\") last))

(defn- source-databases-list
  "Vertical list of selected databases showing name, size, active indicator, and remove button."
  []
  (let [{:keys [selected-paths active-path]} @viewer-state
        all-access-dbs (get-in @state/app-state [:objects :access_databases] [])]
    [:div.source-db-list
     [:div.source-db-label "Source Databases:"]
     (for [path selected-paths]
       (let [access-db (first (filter #(= (:path %) path) all-access-dbs))
             active? (= path active-path)]
         ^{:key path}
         [:div.source-db-item {:class (when active? "active")
                               :on-click #(set-active-database! path)}
          [:span.source-db-indicator (if active? "\u25B8" "\u00A0\u00A0")]
          [:span.source-db-name (or (:name access-db) (db-name-from-path path))]
          (when-let [size (:size access-db)]
            [:span.source-db-size (str "(" (cond
                                             (< size (* 1024 1024)) (str (.toFixed (/ size 1024) 0) " KB")
                                             :else (str (.toFixed (/ size (* 1024 1024)) 1) " MB"))
                                           ")")])
          [:button.source-db-remove
           {:on-click (fn [e]
                        (.stopPropagation e)
                        (toggle-database-selection! path))}
           "\u00D7"]]))]))

(defn- viewer-loaded-content
  "Render the main viewer content when databases are selected."
  [active-path error loading?]
  [:<>
   [:div.viewer-header
    [:div.viewer-header-top
     [source-databases-list]]]
   (when-not (or error loading?)
     [:div.viewer-phase-bar
      [import-phase-tracker]])
   [:div.viewer-body
    [:div.viewer-main
     (cond
       error [:div.error-message error]
       loading? [:div.loading-spinner "Loading..."]
       :else [:<>
              [import-all-progress]
              [auto-import-phase-status]
              [toolbar active-path]
              [object-list]
              [next-step-suggestion]])]
    [:div.viewer-sidebar [import-log-panel]]]])

(defn access-database-viewer
  "Main viewer component for an Access database"
  []
  (let [restored? (r/atom false)]
    (r/create-class
     {:component-did-mount
      (fn [_]
        (when (and (not @restored?) (empty? (:selected-paths @viewer-state)))
          (reset! restored? true)
          (restore-import-state!))
        ;; When the global database selector changes while in import mode, refresh target-existing
        (add-watch state/app-state ::db-change-watcher
          (fn [_ _ old-state new-state]
            (let [old-id (get-in old-state [:current-database :database_id])
                  new-id (get-in new-state [:current-database :database_id])]
              (when (and (not= old-id new-id)
                         (= :import (:app-mode new-state)))
                (load-target-existing! new-id)
                (load-import-chat-for-id! new-id))))))
      :component-will-unmount
      (fn [_]
        (remove-watch state/app-state ::db-change-watcher))
      :reagent-render
      (fn []
        (let [{:keys [loading? error active-path selected-paths]} @viewer-state]
          [:div.access-database-viewer
           (if-not (seq selected-paths)
             [:div.welcome-panel
              [:h2 "Access Database Import"]
              [:p "Enter the folder path where your Access databases are in the sidebar, or use \"scan all locations\" to search your Desktop and Documents."]]
             [viewer-loaded-content active-path error loading?])]))})))