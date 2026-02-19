(ns app.views.access-database-viewer
  "Viewer for Access database files - shows forms/reports available for import"
  (:require [reagent.core :as r]
            [app.state :as state]
            [app.flows.app :as app-flows]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <! chan put!]]
            [clojure.string :as str]))

(def api-base state/api-base)

(declare get-item-name load-access-database-contents! load-target-existing! load-import-history! load-image-status! import-images!)

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
    (:sourceForm ctrl)      (assoc :source-form (:sourceForm ctrl))
    (:linkChildFields ctrl) (assoc :link-child-fields [(:linkChildFields ctrl)])
    (:linkMasterFields ctrl)(assoc :link-master-fields [(:linkMasterFields ctrl)])
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
    (:hasLostFocusEvent ctrl)    (assoc :has-lostfocus-event true)))

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
    (:sourceReport ctrl)     (assoc :source-report (:sourceReport ctrl))
    (:linkChildFields ctrl)  (assoc :link-child-fields [(:linkChildFields ctrl)])
    (:linkMasterFields ctrl) (assoc :link-master-fields [(:linkMasterFields ctrl)])
    (:picture ctrl)      (assoc :picture (:picture ctrl))
    (:sizeMode ctrl)     (assoc :size-mode (keyword (:sizeMode ctrl)))
    (:rowSource ctrl)    (assoc :row-source (:rowSource ctrl))
    (:boundColumn ctrl)  (assoc :bound-column (:boundColumn ctrl))
    (:columnCount ctrl)  (assoc :column-count (:columnCount ctrl))
    (:columnWidths ctrl) (assoc :column-widths (:columnWidths ctrl))
    (:hasFormatEvent ctrl) (assoc :has-format-event true)
    (:hasPrintEvent ctrl)  (assoc :has-print-event true)
    (:hasClickEvent ctrl)  (assoc :has-click-event true)))

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
      (:hasRetreatEvent section) (assoc :has-retreat-event true))))

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
      (:hasErrorEvent report-data)      (assoc :has-error-event true))))

;; ============================================================

(defn- build-form-section
  "Build a single form section with optional picture properties."
  [sections section-name height-key by-section section-idx]
  (cond-> {:height (twips->px (get sections height-key))
           :controls (mapv convert-control (get by-section section-idx []))}
    (get sections (keyword (str section-name "Picture")))
    (assoc :picture (get sections (keyword (str section-name "Picture"))))
    (some? (get sections (keyword (str section-name "PictureSizeMode"))))
    (assoc :picture-size-mode (get picture-size-mode-map
                                   (get sections (keyword (str section-name "PictureSizeMode"))) "clip"))))

(defn- build-form-sections
  "Build header/detail/footer sections from Access form data."
  [form-data]
  (let [by-section (group-by #(or (:section %) 0) (or (:controls form-data) []))
        sections (or (:sections form-data) {})]
    {:header (build-form-section sections "header" :headerHeight by-section 1)
     :detail (build-form-section sections "detail" :detailHeight by-section 0)
     :footer (build-form-section sections "footer" :footerHeight by-section 2)}))

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
      (:hasDeleteEvent form-data)       (assoc :has-delete-event true))))

;; ============================================================

;; Local state for the viewer
(defonce viewer-state
  (r/atom {:loading? false
           :error nil
           :active-path nil      ;; Which db's objects are currently displayed
           :selected-paths []    ;; Ordered vector of paths included for import
           :object-type :tables ;; :tables, :queries, :forms, :reports, :modules, :macros
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
           :image-status nil         ;; {:total N :imported M} from /api/access-import/image-status
           :auto-import-phase nil    ;; nil, :importing, :extracting, :resolving-gaps, :generating, :complete
           }))

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
            (<! (http/put (str api-base "/api/access-import/source-discovery")
                          {:json-params {:database_id target-database-id
                                         :source_path (first paths)
                                         :discovery discovery}}))))))))

(defn save-import-state!
  "Persist import viewer state to server"
  []
  (let [{:keys [active-path selected-paths object-type target-database-id]} @viewer-state]
    (go
      (<! (http/put (str api-base "/api/session/import-state")
                    {:json-params {:loaded_path active-path
                                   :selected_paths selected-paths
                                   :object_type (when object-type (name object-type))
                                   :target_database_id target-database-id}})))))

(defn restore-import-state!
  "Load saved import state from server and restore viewer position.
   Skips reload if data is already present in viewer-state."
  []
  ;; If viewer already has loaded data, just restore the sidebar list
  (if (seq (:selected-paths @viewer-state))
    (do
      (state/load-access-databases!)
      (when-let [target (:target-database-id @viewer-state)]
        (load-target-existing! target))
      (when-let [active (:active-path @viewer-state)]
        (load-import-history! active)))
    ;; Otherwise fetch saved state from server
    (go
      (let [response (<! (http/get (str api-base "/api/session/import-state")))]
        (when (and (:success response) (seq (:body response)))
          (let [{:keys [loaded_path selected_paths object_type target_database_id]} (:body response)
                paths (or (seq selected_paths) (when loaded_path [loaded_path]))]
            (when object_type
              (swap! viewer-state assoc :object-type (keyword object_type)))
            (when target_database_id
              (swap! viewer-state assoc :target-database-id target_database_id)
              (load-target-existing! target_database_id))
            (when (seq paths)
              (state/load-access-databases!)
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
      (let [response (<! (http/get (str api-base "/api/access-import/image-status")
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

(defn load-import-history!
  "Load import history for the target database (all object types, all sources).
   Falls back to source_path filter if no target database is selected.
   Also sets target-database-id based on prior successful imports."
  [db-path]
  (go
    (let [target-db (:target-database-id @viewer-state)
          query-params (if target-db
                         {:target_database_id target-db :limit 200}
                         {:source_path db-path :limit 200})
          response (<! (http/get (str api-base "/api/access-import/history")
                                 {:query-params query-params}))]
      (when (:success response)
        (let [history (get-in response [:body :history] [])
              ;; Find all distinct target databases from successful imports
              targets (->> history
                           (filter #(= (:status %) "success"))
                           (map :target_database_id)
                           (remove #(= % "_none"))
                           distinct)]
          (swap! viewer-state assoc :import-log history)
          ;; Auto-select if objects were previously imported to a database
          (when-not target-db
            (if (seq targets)
              (let [target (first targets)]
                (swap! viewer-state assoc :target-database-id target)
                (load-target-existing! target))
              (swap! viewer-state assoc :target-database-id nil)))
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
    (let [response (<! (http/get (str api-base "/api/access-import/database")
                                 {:query-params {:path db-path}}))]
      (if (:success response)
        (let [body (:body response)
              contents {:forms (or (:forms body) [])
                        :reports (or (:reports body) [])
                        :tables (or (:tables body) [])
                        :queries (or (:queries body) [])
                        :modules (or (:modules body) [])
                        :macros (or (:macros body) [])}]
          (swap! viewer-state assoc-in [:access-db-cache db-path] contents)
          (swap! viewer-state assoc
                 :loading? false
                 :forms (:forms contents)
                 :reports (:reports contents)
                 :tables (:tables contents)
                 :queries (:queries contents)
                 :modules (:modules contents)
                 :macros (:macros contents)
                 :selected #{}))
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
      ;; Add to selection
      (do
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
    (let [response (<! (http/post (str api-base "/api/access-import/export-form")
                                  {:json-params {:databasePath access-db-path
                                                 :formName form-name
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :formData]))
        ;; Step 2: Convert JSON to AccessClone form definition
        (let [form-data (get-in response [:body :formData])
              import-log-id (get-in response [:body :import_log_id])
              form-def (convert-access-form form-data)
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
    (let [response (<! (http/post (str api-base "/api/access-import/export-report")
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
    (let [response (<! (http/post (str api-base "/api/access-import/export-module")
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
    (let [response (<! (http/post (str api-base "/api/access-import/export-macro")
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
    (let [response (<! (http/post (str api-base "/api/access-import/import-table")
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
    (let [response (<! (http/post (str api-base "/api/access-import/import-query")
                                  {:json-params (cond-> {:databasePath access-db-path
                                                         :queryName query-name
                                                         :targetDatabaseId target-database-id}
                                                  force? (assoc :force true))}))]
      (if (and (:success response) (get-in response [:body :success]))
        true
        (let [err (or (get-in response [:body :error]) "Unknown error")]
          (state/log-event! "error" (str "Failed to import query: " query-name) "import-query"
                            {:error err})
          {:error err})))))

;; ============================================================
;; Batch Import Functions (single COM session per type)
;; ============================================================

(def batch-eligible-types #{:forms :reports :modules :macros})

(defn import-forms-batch!
  "Batch import forms: single COM session export, then convert + save each.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path form-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/access-import/export-forms-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec form-names)
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])
              imported (atom [])
              failed (atom (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))]
          (doseq [[k form-data] objects]
            (let [form-name (name k)
                  form-def (convert-access-form form-data)
                  save-url (str api-base "/api/forms/" form-name "?source=import")
                  save-response (<! (http/put save-url
                                             {:json-params form-def
                                              :headers {"X-Database-ID" target-database-id}}))]
              (if (:success save-response)
                (swap! imported conj form-name)
                (swap! failed conj {:name form-name
                                    :error (or (get-in save-response [:body :error]) "Save failed")}))))
          {:imported @imported :failed @failed})
        (let [err (or (get-in response [:body :error]) "Batch export failed")]
          {:imported [] :failed (mapv (fn [n] {:name n :error err}) form-names)})))))

(defn import-reports-batch!
  "Batch import reports: single COM session export, then convert + save each.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path report-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/access-import/export-reports-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec report-names)
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])
              imported (atom [])
              failed (atom (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))]
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
                                    :error (or (get-in save-response [:body :error]) "Save failed")}))))
          {:imported @imported :failed @failed})
        (let [err (or (get-in response [:body :error]) "Batch export failed")]
          {:imported [] :failed (mapv (fn [n] {:name n :error err}) report-names)})))))

(defn import-modules-batch!
  "Batch import modules: single COM session export, then save each.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path module-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/access-import/export-modules-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec module-names)
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])
              imported (atom [])
              failed (atom (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))]
          (doseq [[k module-data] objects]
            (let [module-name (name k)
                  save-response (<! (http/put (str api-base "/api/modules/" module-name)
                                             {:json-params {:vba_source (:code module-data)}
                                              :headers {"X-Database-ID" target-database-id}}))]
              (if (:success save-response)
                (swap! imported conj module-name)
                (swap! failed conj {:name module-name
                                    :error (or (get-in save-response [:body :error]) "Save failed")}))))
          {:imported @imported :failed @failed})
        (let [err (or (get-in response [:body :error]) "Batch export failed")]
          {:imported [] :failed (mapv (fn [n] {:name n :error err}) module-names)})))))

(defn import-macros-batch!
  "Batch import macros: single COM session export, then save each.
   Returns {:imported [names] :failed [{:name :error}]}"
  [access-db-path macro-names target-database-id]
  (go
    (let [response (<! (http/post (str api-base "/api/access-import/export-macros-batch")
                                  {:json-params {:databasePath access-db-path
                                                 :objectNames (vec macro-names)
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :objects]))
        (let [objects (get-in response [:body :objects] {})
              export-errors (get-in response [:body :errors] [])
              imported (atom [])
              failed (atom (vec (map (fn [e] {:name (:name e) :error (:error e)}) export-errors)))]
          (doseq [[k macro-data] objects]
            (let [macro-name (name k)
                  save-response (<! (http/put (str api-base "/api/macros/" macro-name)
                                             {:json-params {:macro_xml (:definition macro-data)}
                                              :headers {"X-Database-ID" target-database-id}}))]
              (if (:success save-response)
                (swap! imported conj macro-name)
                (swap! failed conj {:name macro-name
                                    :error (or (get-in save-response [:body :error]) "Save failed")}))))
          {:imported @imported :failed @failed})
        (let [err (or (get-in response [:body :error]) "Batch export failed")]
          {:imported [] :failed (mapv (fn [n] {:name n :error err}) macro-names)})))))

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
        ;; Images: single COM session extracts all image controls
        (<! (import-images! access-db-path target-database-id))
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
    (let [response (<! (http/post (str api-base "/api/access-import/create-function-stubs")
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
    (let [response (<! (http/post (str api-base "/api/access-import/import-images")
                                  {:json-params {:databasePath access-db-path
                                                 :targetDatabaseId target-database-id}}))]
      (if (and (:success response) (get-in response [:body :success]))
        (let [image-count (get-in response [:body :imageCount] 0)]
          (when (pos? image-count)
            (println (str "[IMAGES] Imported " image-count " images")))
          (load-image-status! target-database-id))
        (let [err (or (get-in response [:body :error]) "Image import failed")]
          (state/log-event! "warning" (str "Image import: " err) "import-images"))))))

(defn import-all!
  "Import all objects across all phases from all selected databases.
   Uses batch import for forms/reports/modules/macros (single COM session per type per db).
   Uses individual import with retry loop for tables/queries (server-side pipeline).
   When force? is true, re-imports ALL objects regardless of existing status."
  [target-database-id & [{:keys [force?]}]]
  (swap! viewer-state assoc
         :import-all-active? true
         :importing? true
         :import-all-status {:phase nil :current nil :imported 0 :total 0 :failed []}
         ;; Reset progress counters so UI shows 0/N during re-import
         :target-existing (if force? {} (:target-existing @viewer-state)))
  (go
    (let [total-imported (atom 0)
          total-failed (atom [])]
      ;; Process each phase in order
      (doseq [{:keys [phase label types]} import-phases]
        ;; Collect all not-yet-imported objects: [obj-type path name] tuples
        (let [phase-items (atom (vec (mapcat (fn [t]
                                               (map (fn [[p n]] [t p n])
                                                    (if force? (all-source-objects t) (not-yet-imported t))))
                                             types)))
              use-batch? (every? batch-eligible-types types)]
          (when (seq @phase-items)
            (swap! viewer-state assoc-in [:import-all-status :phase] phase)
            (if use-batch?
              ;; Batch mode: group by [obj-type, db-path], one COM session per group
              (let [groups (group-by (fn [[t p _]] [t p]) @phase-items)]
                (doseq [[[obj-type db-path] items] groups]
                  (let [names (mapv (fn [[_ _ n]] n) items)
                        batch-fn (batch-import-fn-for-type obj-type)]
                    (swap! viewer-state assoc-in [:import-all-status :current]
                           (str (count names) " " (clojure.core/name obj-type)))
                    (let [result (<! (batch-fn db-path names target-database-id))]
                      (swap! total-imported + (count (:imported result)))
                      (swap! viewer-state assoc-in [:import-all-status :imported] @total-imported)
                      (doseq [{:keys [name error]} (:failed result)]
                        (swap! total-failed conj {:type obj-type :name name :error error})))))
                ;; Clear phase-items since batch handles all
                (reset! phase-items []))
              ;; Individual mode with retry for tables/queries
              (loop [pass 1]
                (let [remaining @phase-items
                      imported-this-pass (atom 0)
                      still-pending (atom [])]
                  ;; Try each pending object
                  (doseq [[obj-type db-path obj-name] remaining]
                    (swap! viewer-state assoc-in [:import-all-status :current] obj-name)
                    (let [import-fn (import-fn-for-type obj-type)
                          result (<! (import-fn db-path obj-name target-database-id (when force? {:force? true})))]
                      (if (true? result)
                        (do (swap! imported-this-pass inc)
                            (swap! total-imported inc)
                            (swap! viewer-state assoc-in [:import-all-status :imported] @total-imported))
                        (swap! still-pending conj [obj-type db-path obj-name
                                                   (if (map? result) (:error result) "Unknown error")]))))
                  (reset! phase-items @still-pending)
                  ;; Continue if we made progress and still have pending items (max 20 passes)
                  (when (and (seq @phase-items) (pos? @imported-this-pass) (< pass 20))
                    (recur (inc pass))))))
            ;; Record any remaining as failed (only applies to individual mode)
            (doseq [[obj-type _ obj-name err] @phase-items]
              (swap! total-failed conj {:type obj-type :name obj-name :error err}))
            ;; Refresh target-existing after this phase (await completion)
            (<! (load-target-existing-async! target-database-id))
            ;; After modules phase, create PG stub functions from VBA declarations
            (when (= phase :modules)
              (<! (create-function-stubs! target-database-id)))
            ;; After UI phase (forms & reports), extract and embed images
            (when (= phase :ui)
              (doseq [p (:selected-paths @viewer-state)]
                (<! (import-images! p target-database-id)))))))
      ;; Compute total — aggregate across all selected databases
      (let [all-source (reduce + (map (fn [t] (:total (type-progress t)))
                                      [:tables :queries :forms :reports :modules :macros]))
            final-status {:phase :done
                          :current nil
                          :imported @total-imported
                          :total all-source
                          :failed @total-failed}]
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
        (state/load-macros!)))))

(defn auto-import-all!
  "Import all objects, then run the full LLM pipeline (extract, resolve, generate)."
  [target-database-id]
  (swap! viewer-state assoc :auto-import-phase :importing)
  (go
    ;; Step 1: Import all objects
    (<! (import-all! target-database-id {:force? true}))
    ;; Ensure modules list is populated in app-state after import
    (let [resp (<! (http/get (str api-base "/api/modules")
                             {:headers {"X-Database-ID" target-database-id}}))]
      (when (:success resp)
        (swap! state/app-state assoc-in [:objects :modules] (:body resp))))
    ;; Step 2: Extract intents from all modules
    (swap! viewer-state assoc :auto-import-phase :extracting)
    (<! (app-flows/batch-extract-intents!))
    ;; Step 3: Auto-resolve gaps via LLM
    (swap! viewer-state assoc :auto-import-phase :resolving-gaps)
    (<! (app-flows/auto-resolve-gaps!))
    ;; Step 4: Submit gap decisions
    (<! (app-flows/submit-all-gap-decisions!))
    ;; Step 5: Generate code for all modules
    (swap! viewer-state assoc :auto-import-phase :generating)
    (<! (app-flows/batch-generate-code!))
    ;; Done
    (swap! viewer-state assoc :auto-import-phase :complete)))

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
  "Amber banner shown when the selected type has unmet prerequisites"
  []
  (let [obj-type (:object-type @viewer-state)
        phase-def (some #(when (some #{obj-type} (:types %)) %) import-phases)]
    (when (and phase-def (seq (:requires phase-def)) (not (phase-ready? phase-def)))
      (let [missing (remove (fn [req-type]
                              (let [{:keys [total imported]} (type-progress req-type)]
                                (or (zero? total) (= total imported))))
                            (:requires phase-def))]
        (when (seq missing)
          [:div.dependency-warning
           [:strong "Prerequisites not complete: "]
           [:span (str/join ", "
                            (map (fn [t]
                                   (let [{:keys [total imported]} (type-progress t)]
                                     (str (str/capitalize (name t)) " (" imported "/" total ")")))
                                 missing))]])))))

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
        items (get @viewer-state object-type [])
        already-imported (imported-names)]
    [:div.access-object-list
     (cond
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
  (let [{:keys [import-log object-type]} @viewer-state
        filter-type (phase-log-type object-type)
        filtered (if filter-type
                   (filter #(= (:source_object_type %) filter-type) import-log)
                   import-log)]
    [:div.import-log-panel
     [:div.log-header
      [:h4 "Import Log"]
      (when filter-type
        [:span.log-filter-label filter-type])]
     [:div.log-entries
      (if (empty? filtered)
        [:div.log-empty "No imports yet"]
        (for [entry filtered]
          ^{:key (:id entry)}
          [:div.log-entry {:class (:status entry)}
           [:div.log-entry-header
            [:span.log-object-type (:source_object_type entry)]
            [:span.log-object-name (:source_object_name entry)]
            [:span.log-status {:class (:status entry)} (:status entry)]]
           [:div.log-entry-details
            [:span.log-time (format-timestamp (:created_at entry))]]
           (when (:error_message entry)
             [:div.log-error (:error_message entry)])]))]]))

(defn- suggest-name-from-path
  "Derive a suggested database name from the Access file path.
   e.g. 'C:\\...\\Diversity_Dev.accdb' → 'Diversity Dev'"
  []
  (when-let [path (:active-path @viewer-state)]
    (-> path
        (.split "\\")
        last
        (.replace #"\.(accdb|mdb)$" "")
        (.replace #"_" " "))))

(defn target-database-selector
  "Dropdown to choose which AccessClone database to import into"
  []
  (let [creating? (r/atom false)
        new-name (r/atom "")
        create-error (r/atom nil)]
    (fn []
      (let [available-dbs (filter #(not= (:database_id %) "_access_import")
                                  (:available-databases @state/app-state))
            target-id (:target-database-id @viewer-state)]
        [:div.target-db-selector
         [:label "Import into:"]
         [:select
          {:value (or target-id "")
           :on-change #(let [v (.. % -target -value)]
                         (cond
                           (= v "__create_new__")
                           (do (reset! creating? true)
                               (reset! new-name (or (suggest-name-from-path) ""))
                               (reset! create-error nil))
                           (= v "")
                           (do (swap! viewer-state assoc :target-database-id nil)
                               (save-import-state!))
                           :else
                           (do (swap! viewer-state assoc :target-database-id v)
                               (load-target-existing! v)
                               (save-source-discovery! v)
                               (save-import-state!))))}
          [:option {:value ""} "Select a database..."]
          (for [db available-dbs]
            ^{:key (:database_id db)}
            [:option {:value (:database_id db)} (:name db)])
          [:option {:value "__create_new__"} "Create New Database..."]]
         (when @creating?
           [:div.create-db-inline {:style {:margin-top "6px"}}
            [:input {:type "text"
                     :placeholder "Database name"
                     :value @new-name
                     :auto-focus true
                     :on-change #(do (reset! new-name (.. % -target -value))
                                     (reset! create-error nil))
                     :on-key-down #(when (= (.-key %) "Escape")
                                     (reset! creating? false))}]
            [:button.btn-primary
             {:style {:margin-left "4px"}
              :disabled (str/blank? @new-name)
              :on-click #(state/create-database!
                           (str/trim @new-name) nil
                           (fn [new-db]
                             (swap! viewer-state assoc :target-database-id (:database_id new-db))
                             (load-target-existing! (:database_id new-db))
                             (save-source-discovery! (:database_id new-db))
                             (save-import-state!)
                             (reset! creating? false))
                           (fn [err-msg]
                             (reset! create-error err-msg)))}
             "Create"]
            [:button.btn-link
             {:style {:margin-left "4px"}
              :on-click #(reset! creating? false)}
             "Cancel"]
            (when @create-error
              [:div.create-db-error {:style {:color "red" :font-size "12px" :margin-top "2px"}}
               @create-error])])]))))

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
         :complete [:span {:style {:display "flex" :align-items "center" :gap "8px"}}
                    "Auto-import complete"
                    [:button.btn-link
                     {:on-click #(swap! viewer-state assoc :auto-import-phase nil)}
                     "Dismiss"]]
         nil)])))

(defn toolbar [access-db-path]
  (let [{:keys [selected object-type target-database-id loading? importing?]} @viewer-state
        cached? (some? (get-in @viewer-state [:access-db-cache access-db-path]))
        ;; Count total un-imported objects across all types
        total-remaining (reduce + (map #(count (not-yet-imported %))
                                       [:tables :queries :forms :reports :modules :macros]))]
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
           (str "Import " (count selected) " " (name object-type)))])]]))

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
     [source-databases-list]
     [:div.header-actions
      (let [{:keys [target-database-id importing?]} @viewer-state
            auto-phase (:auto-import-phase @viewer-state)
            all-types [:tables :queries :forms :reports :modules :macros]
            total-remaining (reduce + (map #(count (not-yet-imported %)) all-types))
            total-all (reduce + (map #(count (all-source-objects %)) all-types))
            busy? (or importing? (and auto-phase (not= auto-phase :complete)))]
        [:<>
         (when (and target-database-id (pos? total-all) (not busy?) (not error))
           [:button.btn-primary.import-all-btn
            {:on-click #(auto-import-all! target-database-id)}
            (str "Auto-Import (" total-all ")")])
         (when (and target-database-id (pos? total-remaining) (not busy?) (not error))
           [:button.btn-secondary.import-all-btn
            {:on-click #(import-all! target-database-id)}
            (str "Manual Import (" total-remaining ")")])])
      [target-database-selector]]]]
   (when-not (or error loading?)
     [:div.viewer-phase-bar
      [import-phase-tracker]])
   [:div.viewer-body
    [:div.viewer-main
     (cond
       error [:div.error-message error]
       loading? [:div.loading-spinner "Loading..."]
       :else [:<>
              [dependency-warning]
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
          (restore-import-state!)))
      :reagent-render
      (fn []
        (let [{:keys [loading? error active-path selected-paths]} @viewer-state]
          [:div.access-database-viewer
           (if-not (seq selected-paths)
             [:div.welcome-panel
              [:h2 "Access Database Import"]
              [:p "Enter the folder path where your Access databases are in the sidebar, or use \"scan all locations\" to search your Desktop and Documents."]]
             [viewer-loaded-content active-path error loading?])]))})))