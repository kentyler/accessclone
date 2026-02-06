(ns app.views.access-database-viewer
  "Viewer for Access database files - shows forms/reports available for import"
  (:require [reagent.core :as r]
            [app.state :as state]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]))

(def api-base state/api-base)

(declare get-item-name load-access-database-contents! load-target-existing!)

;; ============================================================
;; Access JSON → PolyAccess Form Definition Converter
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

(defn convert-control
  "Convert a single Access control JSON object to PolyAccess format"
  [ctrl]
  (let [base {:type (keyword (:type ctrl))
              :name (:name ctrl)
              :x (twips->px (:left ctrl))
              :y (twips->px (:top ctrl))
              :width (twips->px (:width ctrl))
              :height (twips->px (:height ctrl))}]
    (cond-> base
      ;; Font
      (:fontName ctrl)      (assoc :font-name (:fontName ctrl))
      (:fontSize ctrl)      (assoc :font-size (:fontSize ctrl))
      (:fontBold ctrl)      (assoc :font-bold true)
      (:fontItalic ctrl)    (assoc :font-italic true)
      (:fontUnderline ctrl) (assoc :font-underline true)

      ;; Colors
      (:foreColor ctrl)   (assoc :fore-color (access-color->hex (:foreColor ctrl)))
      (:backColor ctrl)   (assoc :back-color (access-color->hex (:backColor ctrl)))
      (:borderColor ctrl) (assoc :border-color (access-color->hex (:borderColor ctrl)))

      ;; Data binding
      (:controlSource ctrl) (assoc :field (:controlSource ctrl))

      ;; Caption → text (PolyAccess convention)
      (:caption ctrl) (assoc :text (:caption ctrl))

      ;; Other properties
      (:defaultValue ctrl)   (assoc :default-value (:defaultValue ctrl))
      (:format ctrl)         (assoc :format (:format ctrl))
      (:inputMask ctrl)      (assoc :input-mask (:inputMask ctrl))
      (:validationRule ctrl) (assoc :validation-rule (:validationRule ctrl))
      (:validationText ctrl) (assoc :validation-text (:validationText ctrl))
      (:tooltip ctrl)        (assoc :tooltip (:tooltip ctrl))
      (:tag ctrl)            (assoc :tag (:tag ctrl))
      (:tabIndex ctrl)       (assoc :tab-index (:tabIndex ctrl))
      (:parentPage ctrl)     (assoc :parent-page (:parentPage ctrl))

      ;; States
      (false? (:enabled ctrl)) (assoc :enabled false)
      (:locked ctrl)           (assoc :locked true)
      (false? (:visible ctrl)) (assoc :visible false)

      ;; Combo/List box
      (:rowSource ctrl)    (assoc :row-source (:rowSource ctrl))
      (:boundColumn ctrl)  (assoc :bound-column (:boundColumn ctrl))
      (:columnCount ctrl)  (assoc :column-count (:columnCount ctrl))
      (:columnWidths ctrl) (assoc :column-widths (:columnWidths ctrl))
      (:limitToList ctrl)  (assoc :limit-to-list true)

      ;; Subform
      (:sourceForm ctrl)      (assoc :source-form (:sourceForm ctrl))
      (:linkChildFields ctrl) (assoc :link-child-fields [(:linkChildFields ctrl)])
      (:linkMasterFields ctrl)(assoc :link-master-fields [(:linkMasterFields ctrl)])

      ;; Tab control
      (:pages ctrl)     (assoc :pages (:pages ctrl))
      (:pageIndex ctrl) (assoc :page-index (:pageIndex ctrl))

      ;; Image
      (:picture ctrl)  (assoc :picture (:picture ctrl))
      (:sizeMode ctrl) (assoc :size-mode (keyword (:sizeMode ctrl)))

      ;; Events
      (:hasClickEvent ctrl)        (assoc :has-click-event true)
      (:hasDblClickEvent ctrl)     (assoc :has-dblclick-event true)
      (:hasChangeEvent ctrl)       (assoc :has-change-event true)
      (:hasEnterEvent ctrl)        (assoc :has-enter-event true)
      (:hasExitEvent ctrl)         (assoc :has-exit-event true)
      (:hasBeforeUpdateEvent ctrl) (assoc :has-before-update-event true)
      (:hasAfterUpdateEvent ctrl)  (assoc :has-after-update-event true)
      (:hasGotFocusEvent ctrl)     (assoc :has-gotfocus-event true)
      (:hasLostFocusEvent ctrl)    (assoc :has-lostfocus-event true))))

(defn extract-record-source
  "Extract table name from record source (may be a SELECT query)"
  [record-source]
  (when record-source
    (if-let [match (re-find #"(?i)^SELECT .+ FROM (\w+)" record-source)]
      (second match)
      record-source)))

;; ============================================================
;; Access JSON → PolyAccess Report Definition Converter
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

(defn convert-report-control
  "Convert a single Access report control JSON object to PolyAccess format"
  [ctrl]
  (let [base {:type (keyword (:type ctrl))
              :name (:name ctrl)
              :x (twips->px (:left ctrl))
              :y (twips->px (:top ctrl))
              :width (twips->px (:width ctrl))
              :height (twips->px (:height ctrl))}]
    (cond-> base
      ;; Font
      (:fontName ctrl)      (assoc :font-name (:fontName ctrl))
      (:fontSize ctrl)      (assoc :font-size (:fontSize ctrl))
      (:fontBold ctrl)      (assoc :font-bold true)
      (:fontItalic ctrl)    (assoc :font-italic true)
      (:fontUnderline ctrl) (assoc :font-underline true)

      ;; Colors
      (:foreColor ctrl)   (assoc :fore-color (access-color->hex (:foreColor ctrl)))
      (:backColor ctrl)   (assoc :back-color (access-color->hex (:backColor ctrl)))
      (:borderColor ctrl) (assoc :border-color (access-color->hex (:borderColor ctrl)))

      ;; Data binding
      (:controlSource ctrl) (assoc :field (:controlSource ctrl))

      ;; Caption -> text (PolyAccess convention)
      (:caption ctrl) (assoc :text (:caption ctrl))

      ;; Format
      (:format ctrl) (assoc :format (:format ctrl))

      ;; Tooltip / Tag
      (:tooltip ctrl) (assoc :tooltip (:tooltip ctrl))
      (:tag ctrl)     (assoc :tag (:tag ctrl))

      ;; Visibility
      (false? (:visible ctrl)) (assoc :visible false)

      ;; Report-specific control properties
      (:runningSum ctrl)    (assoc :running-sum (get running-sum-map (:runningSum ctrl)))
      (:canGrow ctrl)       (assoc :can-grow true)
      (:canShrink ctrl)     (assoc :can-shrink true)
      (:hideDuplicates ctrl)(assoc :hide-duplicates true)

      ;; Subreport
      (:sourceReport ctrl)     (assoc :source-report (:sourceReport ctrl))
      (:linkChildFields ctrl)  (assoc :link-child-fields [(:linkChildFields ctrl)])
      (:linkMasterFields ctrl) (assoc :link-master-fields [(:linkMasterFields ctrl)])

      ;; Combo/List box
      (:rowSource ctrl)    (assoc :row-source (:rowSource ctrl))
      (:boundColumn ctrl)  (assoc :bound-column (:boundColumn ctrl))
      (:columnCount ctrl)  (assoc :column-count (:columnCount ctrl))
      (:columnWidths ctrl) (assoc :column-widths (:columnWidths ctrl))

      ;; Events
      (:hasFormatEvent ctrl) (assoc :has-format-event true)
      (:hasPrintEvent ctrl)  (assoc :has-print-event true)
      (:hasClickEvent ctrl)  (assoc :has-click-event true))))

(defn convert-report-section
  "Convert a report section JSON object to PolyAccess format"
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

      ;; Section events
      (:hasFormatEvent section)  (assoc :has-format-event true)
      (:hasPrintEvent section)   (assoc :has-print-event true)
      (:hasRetreatEvent section) (assoc :has-retreat-event true))))

(defn convert-access-report
  "Convert Access report JSON metadata to PolyAccess report definition"
  [report-data]
  (let [sections (or (:sections report-data) [])
        ;; Build a map of section-name -> converted section
        section-map (into {} (map (fn [sec]
                                    [(keyword (:name sec))
                                     (convert-report-section sec)])
                                  sections))
        record-source (extract-record-source (:recordSource report-data))
        ;; Convert grouping array
        grouping (mapv (fn [grp]
                         (cond-> {:field (:field grp)
                                  :group-header (boolean (:groupHeader grp))
                                  :group-footer (boolean (:groupFooter grp))
                                  :sort-order (if (= (:sortOrder grp) 1) "descending" "ascending")
                                  :group-on (get group-on-map (:groupOn grp) :each-value)
                                  :group-interval (or (:groupInterval grp) 1)
                                  :keep-together (get keep-together-map (:keepTogether grp) :none)}))
                       (or (:grouping report-data) []))]
    (cond-> {:name (:name report-data)
             :record-source record-source
             :report-width (twips->px (:reportWidth report-data))
             :page-header-option (or (:pageHeader report-data) 0)
             :page-footer-option (or (:pageFooter report-data) 0)
             :grouping grouping
             ;; Standard sections (use empty defaults if missing)
             :report-header (get section-map :report-header {:height 0 :controls []})
             :page-header (get section-map :page-header {:height 0 :controls []})
             :detail (get section-map :detail {:height 0 :controls []})
             :page-footer (get section-map :page-footer {:height 0 :controls []})
             :report-footer (get section-map :report-footer {:height 0 :controls []})}

      ;; Caption
      (:caption report-data) (assoc :caption (:caption report-data))

      ;; Group header/footer sections (dynamic keys)
      ;; Merge in any group-header-N / group-footer-N sections
      (seq (filter #(re-find #"^group-" (name (key %))) section-map))
      (merge (into {} (filter #(re-find #"^group-" (name (key %))) section-map)))

      ;; Report-level events
      (:hasOpenEvent report-data)       (assoc :has-open-event true)
      (:hasCloseEvent report-data)      (assoc :has-close-event true)
      (:hasActivateEvent report-data)   (assoc :has-activate-event true)
      (:hasDeactivateEvent report-data) (assoc :has-deactivate-event true)
      (:hasNoDataEvent report-data)     (assoc :has-no-data-event true)
      (:hasPageEvent report-data)       (assoc :has-page-event true)
      (:hasErrorEvent report-data)      (assoc :has-error-event true))))

;; ============================================================

(defn convert-access-form
  "Convert Access form JSON metadata to PolyAccess form definition"
  [form-data]
  (let [controls (or (:controls form-data) [])
        ;; Group controls by section (0=detail, 1=header, 2=footer)
        by-section (group-by #(or (:section %) 0) controls)
        header-ctrls (mapv convert-control (get by-section 1 []))
        detail-ctrls (mapv convert-control (get by-section 0 []))
        footer-ctrls (mapv convert-control (get by-section 2 []))
        sections (or (:sections form-data) {})
        record-source (extract-record-source (:recordSource form-data))]
    (cond-> {:name (:name form-data)
             :record-source record-source
             :default-view (get default-view-map (:defaultView form-data) "Single Form")
             :form-width (twips->px (:formWidth form-data))
             :header {:height (twips->px (:headerHeight sections))
                      :controls header-ctrls}
             :detail {:height (twips->px (:detailHeight sections))
                      :controls detail-ctrls}
             :footer {:height (twips->px (:footerHeight sections))
                      :controls footer-ctrls}
             :navigation-buttons (if (false? (:navigationButtons form-data)) 0 1)
             :record-selectors (if (false? (:recordSelectors form-data)) 0 1)
             :allow-additions (if (false? (:allowAdditions form-data)) 0 1)
             :allow-deletions (if (false? (:allowDeletions form-data)) 0 1)
             :allow-edits (if (false? (:allowEdits form-data)) 0 1)
             :dividing-lines (if (false? (:dividingLines form-data)) 0 1)}

      ;; Caption
      (:caption form-data) (assoc :text (:caption form-data))

      ;; Filter (only if FilterOn is true)
      (and (:filter form-data) (:filterOn form-data))
      (assoc :filter (:filter form-data))

      ;; Order By (only if OrderByOn is true)
      (and (:orderBy form-data) (:orderByOn form-data))
      (assoc :order-by (:orderBy form-data))

      ;; Scroll bars
      (:scrollBars form-data) (assoc :scroll-bars (get scroll-bars-map (:scrollBars form-data) :both))

      ;; Popup / Modal
      (:popup form-data) (assoc :popup 1)
      (:modal form-data) (assoc :modal 1)

      ;; Data entry
      (:dataEntry form-data) (assoc :data-entry 1)

      ;; Background color
      (:backColor form-data) (assoc :back-color (access-color->hex (:backColor form-data)))

      ;; Events
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
           :loaded-path nil    ;; Track which db path is currently loaded
           :object-type :tables ;; :tables, :queries, :forms, :reports, :modules
           :forms []
           :reports []
           :tables []
           :queries []
           :modules []
           :selected #{}        ;; Set of selected item names for import
           :target-database-id nil ;; Target database to import into
           :target-existing {}   ;; {:forms #{"Form1"} :tables #{"tbl1"} ...}
           :import-log []       ;; Recent import history
           :importing? false})) ;; True while import is in progress

(defn save-import-state!
  "Persist import viewer state to server"
  []
  (let [{:keys [loaded-path object-type target-database-id]} @viewer-state]
    (go
      (<! (http/put (str api-base "/api/session/import-state")
                    {:json-params {:loaded_path loaded-path
                                   :object_type (when object-type (name object-type))
                                   :target_database_id target-database-id}})))))

(defn restore-import-state!
  "Load saved import state from server and restore viewer position"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/session/import-state")))]
      (when (and (:success response) (seq (:body response)))
        (let [{:keys [loaded_path object_type target_database_id]} (:body response)]
          (when object_type
            (swap! viewer-state assoc :object-type (keyword object_type)))
          (when target_database_id
            (swap! viewer-state assoc :target-database-id target_database_id)
            (load-target-existing! target_database_id))
          ;; Load the Access DB contents last (triggers the main view)
          (when loaded_path
            (state/load-access-databases!)
            (load-access-database-contents! loaded_path))
          (println "Import state restored:" loaded_path))))))

(defn load-target-existing!
  "Load existing object names from the target database to flag already-imported items"
  [database-id]
  (when database-id
    (let [headers {"X-Database-ID" database-id}]
      ;; Load forms (API returns plain strings, not objects)
      (go
        (let [response (<! (http/get (str api-base "/api/forms")
                                     {:headers headers}))]
          (when (:success response)
            (let [names (set (get-in response [:body :forms] []))]
              (swap! viewer-state assoc-in [:target-existing :forms] names)))))
      ;; Load tables
      (go
        (let [response (<! (http/get (str api-base "/api/tables")
                                     {:headers headers}))]
          (when (:success response)
            (let [names (->> (get-in response [:body :tables] [])
                             (map :name)
                             set)]
              (swap! viewer-state assoc-in [:target-existing :tables] names)))))
      ;; Load queries
      (go
        (let [response (<! (http/get (str api-base "/api/queries")
                                     {:headers headers}))]
          (when (:success response)
            (let [names (->> (get-in response [:body :queries] [])
                             (map :name)
                             set)]
              (swap! viewer-state assoc-in [:target-existing :queries] names)))))
      ;; Load functions/modules
      (go
        (let [response (<! (http/get (str api-base "/api/functions")
                                     {:headers headers}))]
          (when (:success response)
            (let [names (->> (get-in response [:body :functions] [])
                             (map :name)
                             set)]
              (swap! viewer-state assoc-in [:target-existing :modules] names)))))
      ;; Load reports
      (go
        (let [response (<! (http/get (str api-base "/api/reports")
                                     {:headers headers}))]
          (when (:success response)
            (let [names (->> (get-in response [:body :reports] [])
                             (map :name)
                             set)]
              (swap! viewer-state assoc-in [:target-existing :reports] names))))))))

(defn load-import-history!
  "Load import history for the current Access database"
  [db-path]
  (go
    (let [response (<! (http/get (str api-base "/api/access-import/history")
                                 {:query-params {:source_path db-path :limit 50}}))]
      (when (:success response)
        (swap! viewer-state assoc :import-log (get-in response [:body :history] []))))))

(defn load-access-database-contents!
  "Load forms, reports, tables, queries, and modules from the selected Access database"
  [db-path]
  (swap! viewer-state assoc :loading? true :error nil :loaded-path db-path)
  ;; Persist import state
  (save-import-state!)
  ;; Load history in parallel
  (load-import-history! db-path)
  (go
    (let [response (<! (http/get (str api-base "/api/access-import/database")
                                 {:query-params {:path db-path}}))]
      (if (:success response)
        (let [body (:body response)]
          (swap! viewer-state assoc
                 :loading? false
                 :forms (or (:forms body) [])
                 :reports (or (:reports body) [])
                 :tables (or (:tables body) [])
                 :queries (or (:queries body) [])
                 :modules (or (:modules body) [])
                 :selected #{}))
        (swap! viewer-state assoc
               :loading? false
               :error (or (get-in response [:body :error]) "Failed to load database"))))))

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
        ;; Step 2: Convert JSON to PolyAccess form definition
        (let [form-data (get-in response [:body :formData])
              form-def (convert-access-form form-data)
              _ (println "Converted form:" form-name
                         "- controls:" (+ (count (get-in form-def [:header :controls]))
                                          (count (get-in form-def [:detail :controls]))
                                          (count (get-in form-def [:footer :controls]))))
              ;; Step 3: Save to target database via forms API
              save-response (<! (http/put (str api-base "/api/forms/" form-name)
                                         {:json-params form-def
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            (do (println "Saved form:" form-name "to" target-database-id)
                true)
            (do (println "Failed to save form:" form-name (get-in save-response [:body :error]))
                false)))
        (do (println "Failed to export form:" form-name (get-in response [:body :error]))
            false)))))

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
        ;; Step 2: Convert JSON to PolyAccess report definition
        (let [report-data (get-in response [:body :reportData])
              report-def (convert-access-report report-data)
              _ (println "Converted report:" report-name
                         "- sections:" (count (:sections report-data))
                         "- grouping:" (count (:grouping report-def)))
              ;; Step 3: Save to target database via reports API
              save-response (<! (http/put (str api-base "/api/reports/" report-name)
                                         {:json-params report-def
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            (do (println "Saved report:" report-name "to" target-database-id)
                true)
            (do (println "Failed to save report:" report-name (get-in save-response [:body :error]))
                false)))
        (do (println "Failed to export report:" report-name (get-in response [:body :error]))
            false)))))

(defn import-selected!
  "Import selected forms/reports to the current PolyAccess database"
  [access-db-path target-database-id]
  (let [obj-type (:object-type @viewer-state)
        selected (:selected @viewer-state)]
    (swap! viewer-state assoc :importing? true)
    (go
      (doseq [item-name selected]
        (case obj-type
          :forms   (<! (import-form! access-db-path item-name target-database-id))
          :reports (<! (import-report! access-db-path item-name target-database-id))
          ;; Default: no-op for other types
          nil)
        ;; Refresh history after each import
        (<! (load-import-history! access-db-path)))
      (swap! viewer-state assoc :importing? false :selected #{})
      ;; Refresh badges and the forms/reports list in the target database
      (load-target-existing! target-database-id)
      (state/load-forms!)
      (state/load-reports!))))

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
      [:option {:value "modules"} "Modules"]]]))

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
      nil)))

(defn imported-names
  "Get set of object names (lowercased) that already exist in the target database"
  []
  (let [obj-type (:object-type @viewer-state)
        names (get-in @viewer-state [:target-existing obj-type] #{})]
    (set (map clojure.string/lower-case names))))

(defn object-list []
  (let [{:keys [object-type forms reports tables queries modules selected loading?]} @viewer-state
        items (case object-type
                :forms forms
                :reports reports
                :tables tables
                :queries queries
                :modules modules
                [])
        already-imported (imported-names)]
    [:div.access-object-list
     (if loading?
       [:div.loading "Loading..."]
       (if (empty? items)
         [:div.empty-list (str "No " (name object-type) " found")]
         [:ul.import-list
          (for [item items]
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
               (when imported?
                 [:span.imported-badge "imported"])
               (when item-detail
                 [:span.item-detail item-detail])]))]))]))

(defn format-timestamp [ts]
  (when ts
    (let [d (js/Date. ts)]
      (str (.toLocaleDateString d) " " (.toLocaleTimeString d)))))

(defn import-log-panel []
  (let [{:keys [import-log importing?]} @viewer-state]
    [:div.import-log-panel
     [:div.log-header
      [:h4 "Import Log"]
      (when importing?
        [:span.importing-indicator "Importing..."])]
     [:div.log-entries
      (if (empty? import-log)
        [:div.log-empty "No imports yet"]
        (for [entry import-log]
          ^{:key (:id entry)}
          [:div.log-entry {:class (:status entry)}
           [:div.log-entry-header
            [:span.log-object-type (:source_object_type entry)]
            [:span.log-object-name (:source_object_name entry)]
            [:span.log-status {:class (:status entry)} (:status entry)]]
           [:div.log-entry-details
            [:span.log-target (str "→ " (:target_database_id entry))]
            [:span.log-time (format-timestamp (:created_at entry))]]
           (when (:error_message entry)
             [:div.log-error (:error_message entry)])]))]]))

(defn target-database-selector
  "Dropdown to choose which PolyAccess database to import into"
  []
  (let [available-dbs (filter #(not= (:database_id %) "_access_import")
                              (:available-databases @state/app-state))
        target-id (:target-database-id @viewer-state)
        ;; Default to current database if not set
        effective-id (or target-id
                         (:database_id (:current-database @state/app-state)))]
    ;; Sync effective-id into viewer-state if not set, and load existing objects
    (when (and (nil? target-id) effective-id)
      (swap! viewer-state assoc :target-database-id effective-id)
      (load-target-existing! effective-id))
    [:div.target-db-selector
     [:label "Import into:"]
     [:select
      {:value (or effective-id "")
       :on-change #(let [new-id (.. % -target -value)]
                     (swap! viewer-state assoc :target-database-id new-id)
                     (load-target-existing! new-id)
                     (save-import-state!))}
      (for [db available-dbs]
        ^{:key (:database_id db)}
        [:option {:value (:database_id db)} (:name db)])]]))

(defn toolbar [access-db-path]
  (let [{:keys [selected object-type target-database-id]} @viewer-state]
    [:div.access-toolbar
     [:div.selection-actions
      [:button.btn-link {:on-click select-all!} "Select All"]
      [:button.btn-link {:on-click select-none!} "Select None"]
      [:span.selection-count (str (count selected) " selected")]]
     [:div.import-actions
      (when (seq selected)
        [:button.btn-primary
         {:on-click #(import-selected! access-db-path target-database-id)}
         (str "Import " (count selected) " " (name object-type))])]]))

(defn access-database-viewer
  "Main viewer component for an Access database"
  []
  ;; Restore saved import state on first mount if nothing is loaded
  (let [restored? (r/atom false)]
    (r/create-class
     {:component-did-mount
      (fn [_]
        (when (and (not @restored?) (nil? (:loaded-path @viewer-state)))
          (reset! restored? true)
          (restore-import-state!)))
      :reagent-render
      (fn []
        (let [{:keys [loading? error loaded-path]} @viewer-state
              access-db (when loaded-path
                          (first (filter #(= (:path %) loaded-path)
                                         (get-in @state/app-state [:objects :access_databases]))))]

          [:div.access-database-viewer
     (if-not loaded-path
       [:div.welcome-panel
        [:h2 "Access Database Import"]
        [:p "Select a database from the sidebar, or click Scan to find .accdb files."]]

       [:<>
        [:div.viewer-header
         [:div.viewer-header-top
          [:div
           [:h2 (or (:name access-db) (some-> loaded-path (.split "\\") last))]
           [:div.db-path loaded-path]]
          [target-database-selector]]]

        [:div.viewer-body
         [:div.viewer-main
          (cond
            error
            [:div.error-message error]

            loading?
            [:div.loading-spinner "Loading..."]

            :else
            [:<>
             [object-type-dropdown]
             [toolbar loaded-path]
             [object-list]])]

         [:div.viewer-sidebar
          [import-log-panel]]]])]))})))