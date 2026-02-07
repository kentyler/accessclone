(ns app.views.access-database-viewer
  "Viewer for Access database files - shows forms/reports available for import"
  (:require [reagent.core :as r]
            [app.state :as state]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]
            [clojure.string :as str]))

(def api-base state/api-base)

(declare get-item-name load-access-database-contents! load-target-existing! load-import-history!)

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

(defn- control-base
  "Build base control map with geometry, font, colors, data binding, caption."
  [ctrl]
  (cond-> {:type (keyword (:type ctrl))
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
    (:controlSource ctrl) (assoc :field (:controlSource ctrl))
    (:caption ctrl)       (assoc :text (:caption ctrl))
    (:format ctrl)        (assoc :format (:format ctrl))
    (:tooltip ctrl)       (assoc :tooltip (:tooltip ctrl))
    (:tag ctrl)           (assoc :tag (:tag ctrl))
    (false? (:visible ctrl)) (assoc :visible false)))

(defn- apply-form-control-props
  "Apply form-specific properties to a base control map."
  [base ctrl]
  (cond-> base
    (:defaultValue ctrl)   (assoc :default-value (:defaultValue ctrl))
    (:inputMask ctrl)      (assoc :input-mask (:inputMask ctrl))
    (:validationRule ctrl) (assoc :validation-rule (:validationRule ctrl))
    (:validationText ctrl) (assoc :validation-text (:validationText ctrl))
    (:tabIndex ctrl)       (assoc :tab-index (:tabIndex ctrl))
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
  "Convert a single Access control JSON object to PolyAccess format"
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
  (cond-> (control-base ctrl)
    (:runningSum ctrl)    (assoc :running-sum (get running-sum-map (:runningSum ctrl)))
    (:canGrow ctrl)       (assoc :can-grow true)
    (:canShrink ctrl)     (assoc :can-shrink true)
    (:hideDuplicates ctrl)(assoc :hide-duplicates true)
    (:sourceReport ctrl)     (assoc :source-report (:sourceReport ctrl))
    (:linkChildFields ctrl)  (assoc :link-child-fields [(:linkChildFields ctrl)])
    (:linkMasterFields ctrl) (assoc :link-master-fields [(:linkMasterFields ctrl)])
    (:rowSource ctrl)    (assoc :row-source (:rowSource ctrl))
    (:boundColumn ctrl)  (assoc :bound-column (:boundColumn ctrl))
    (:columnCount ctrl)  (assoc :column-count (:columnCount ctrl))
    (:columnWidths ctrl) (assoc :column-widths (:columnWidths ctrl))
    (:hasFormatEvent ctrl) (assoc :has-format-event true)
    (:hasPrintEvent ctrl)  (assoc :has-print-event true)
    (:hasClickEvent ctrl)  (assoc :has-click-event true)))

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

(defn- convert-grouping
  "Convert Access grouping array to PolyAccess format."
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
  "Convert Access report JSON metadata to PolyAccess report definition"
  [report-data]
  (let [section-map (into {} (map (fn [sec]
                                    [(keyword (:name sec))
                                     (convert-report-section sec)])
                                  (or (:sections report-data) [])))
        group-sections (into {} (filter #(re-find #"^group-" (name (key %))) section-map))]
    (cond-> (build-report-base report-data section-map)
      (:caption report-data)            (assoc :caption (:caption report-data))
      (seq group-sections)              (merge group-sections)
      (:hasOpenEvent report-data)       (assoc :has-open-event true)
      (:hasCloseEvent report-data)      (assoc :has-close-event true)
      (:hasActivateEvent report-data)   (assoc :has-activate-event true)
      (:hasDeactivateEvent report-data) (assoc :has-deactivate-event true)
      (:hasNoDataEvent report-data)     (assoc :has-no-data-event true)
      (:hasPageEvent report-data)       (assoc :has-page-event true)
      (:hasErrorEvent report-data)      (assoc :has-error-event true))))

;; ============================================================

(defn- build-form-sections
  "Build header/detail/footer sections from Access form data."
  [form-data]
  (let [by-section (group-by #(or (:section %) 0) (or (:controls form-data) []))
        sections (or (:sections form-data) {})]
    {:header {:height (twips->px (:headerHeight sections))
              :controls (mapv convert-control (get by-section 1 []))}
     :detail {:height (twips->px (:detailHeight sections))
              :controls (mapv convert-control (get by-section 0 []))}
     :footer {:height (twips->px (:footerHeight sections))
              :controls (mapv convert-control (get by-section 2 []))}}))

(defn- bool->int [v] (if (false? v) 0 1))

(defn convert-access-form
  "Convert Access form JSON metadata to PolyAccess form definition"
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
           :importing? false    ;; True while import is in progress
           :access-db-cache {}  ;; {path {:forms [] :reports [] :tables [] :queries [] :modules []}}
           }))

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
  "Load saved import state from server and restore viewer position.
   Skips reload if data is already present in viewer-state."
  []
  ;; If viewer already has loaded data, just restore the sidebar list
  (if (:loaded-path @viewer-state)
    (do
      (state/load-access-databases!)
      (when-let [target (:target-database-id @viewer-state)]
        (load-target-existing! target))
      (load-import-history! (:loaded-path @viewer-state)))
    ;; Otherwise fetch saved state from server
    (go
      (let [response (<! (http/get (str api-base "/api/session/import-state")))]
        (when (and (:success response) (seq (:body response)))
          (let [{:keys [loaded_path object_type target_database_id]} (:body response)]
            (when object_type
              (swap! viewer-state assoc :object-type (keyword object_type)))
            (when target_database_id
              (swap! viewer-state assoc :target-database-id target_database_id)
              (load-target-existing! target_database_id))
            (when loaded_path
              (state/load-access-databases!)
              (load-access-database-contents! loaded_path))))))))

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
      (fetch-existing-names! headers "/api/queries" :queries :queries #(map :name %))
      (fetch-existing-names! headers "/api/modules" :modules :modules identity)
      (fetch-existing-names! headers "/api/reports" :reports :reports identity))))

(defn load-import-history!
  "Load import history for the current Access database"
  [db-path]
  (go
    (let [response (<! (http/get (str api-base "/api/access-import/history")
                                 {:query-params {:source_path db-path :limit 50}}))]
      (when (:success response)
        (swap! viewer-state assoc :import-log (get-in response [:body :history] []))))))

(defn- apply-cached-contents!
  "Apply cached Access database contents to viewer-state"
  [db-path cached]
  (swap! viewer-state assoc
         :loading? false :error nil :loaded-path db-path
         :forms (:forms cached)
         :reports (:reports cached)
         :tables (:tables cached)
         :queries (:queries cached)
         :modules (:modules cached)
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
                        :modules (or (:modules body) [])}]
          (swap! viewer-state assoc-in [:access-db-cache db-path] contents)
          (swap! viewer-state assoc
                 :loading? false
                 :forms (:forms contents)
                 :reports (:reports contents)
                 :tables (:tables contents)
                 :queries (:queries contents)
                 :modules (:modules contents)
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
     (swap! viewer-state assoc :loaded-path db-path :error nil)
     (save-import-state!)
     (load-import-history! db-path)
     (let [cached (get-in @viewer-state [:access-db-cache db-path])]
       (if (and cached (not force-refresh?))
         (apply-cached-contents! db-path cached)
         (do
           (swap! viewer-state assoc :loading? true)
           (fetch-and-cache-contents! db-path)))))))

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
              ;; Step 3: Save to target database via forms API
              save-response (<! (http/put (str api-base "/api/forms/" form-name)
                                         {:json-params form-def
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            true
            (do (state/log-event! "error" (str "Failed to save form: " form-name) "import-form"
                                  {:error (get-in save-response [:body :error])})
                false)))
        (do (state/log-event! "error" (str "Failed to export form: " form-name) "import-form"
                              {:error (get-in response [:body :error])})
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
              ;; Step 3: Save to target database via reports API
              save-response (<! (http/put (str api-base "/api/reports/" report-name)
                                         {:json-params report-def
                                          :headers {"X-Database-ID" target-database-id}}))]
          (if (:success save-response)
            true
            (do (state/log-event! "error" (str "Failed to save report: " report-name) "import-report"
                                  {:error (get-in save-response [:body :error])})
                false)))
        (do (state/log-event! "error" (str "Failed to export report: " report-name) "import-report"
                              {:error (get-in response [:body :error])})
            false)))))

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
            (do (state/log-event! "error" (str "Failed to save module: " module-name) "import-module"
                                  {:error (get-in save-response [:body :error])})
                false)))
        (do (state/log-event! "error" (str "Failed to export module: " module-name) "import-module"
                              {:error (get-in response [:body :error])})
            false)))))

(defn import-selected!
  "Import selected forms/reports/modules to the current PolyAccess database"
  [access-db-path target-database-id]
  (let [obj-type (:object-type @viewer-state)
        selected (:selected @viewer-state)]
    (swap! viewer-state assoc :importing? true)
    (go
      (doseq [item-name selected]
        (case obj-type
          :forms   (<! (import-form! access-db-path item-name target-database-id))
          :reports (<! (import-report! access-db-path item-name target-database-id))
          :modules (<! (import-module! access-db-path item-name target-database-id))
          nil)
        ;; Refresh history after each import
        (<! (load-import-history! access-db-path)))
      (swap! viewer-state assoc :importing? false :selected #{})
      ;; Refresh badges and the object lists in the target database
      (load-target-existing! target-database-id)
      (state/load-forms!)
      (state/load-reports!)
      (state/load-functions!))))

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

(defn- suggest-name-from-path
  "Derive a suggested database name from the Access file path.
   e.g. 'C:\\...\\Diversity_Dev.accdb' → 'Diversity Dev'"
  []
  (when-let [path (:loaded-path @viewer-state)]
    (-> path
        (.split "\\")
        last
        (.replace #"\.accdb$" "")
        (.replace #"_" " "))))

(defn target-database-selector
  "Dropdown to choose which PolyAccess database to import into"
  []
  (let [creating? (r/atom false)
        new-name (r/atom "")
        create-error (r/atom nil)]
    (fn []
      (let [available-dbs (filter #(not= (:database_id %) "_access_import")
                                  (:available-databases @state/app-state))
            target-id (:target-database-id @viewer-state)
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
           :on-change #(let [v (.. % -target -value)]
                         (if (= v "__create_new__")
                           (do (reset! creating? true)
                               (reset! new-name (or (suggest-name-from-path) ""))
                               (reset! create-error nil))
                           (do (swap! viewer-state assoc :target-database-id v)
                               (load-target-existing! v)
                               (save-import-state!))))}
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

(defn toolbar [access-db-path]
  (let [{:keys [selected object-type target-database-id loading?]} @viewer-state
        cached? (some? (get-in @viewer-state [:access-db-cache access-db-path]))]
    [:div.access-toolbar
     [:div.selection-actions
      [:button.btn-link {:on-click select-all!} "Select All"]
      [:button.btn-link {:on-click select-none!} "Select None"]
      [:span.selection-count (str (count selected) " selected")]
      [:button.btn-link {:on-click #(load-access-database-contents! access-db-path true)
                         :disabled loading?}
       (if cached? "Refresh" "Load")]]
     [:div.import-actions
      (when (seq selected)
        [:button.btn-primary
         {:on-click #(import-selected! access-db-path target-database-id)}
         (str "Import " (count selected) " " (name object-type))])]]))

(defn- viewer-loaded-content
  "Render the main viewer content when a database is loaded."
  [loaded-path error loading?]
  (let [access-db (first (filter #(= (:path %) loaded-path)
                                  (get-in @state/app-state [:objects :access_databases])))]
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
         error [:div.error-message error]
         loading? [:div.loading-spinner "Loading..."]
         :else [:<> [object-type-dropdown] [toolbar loaded-path] [object-list]])]
      [:div.viewer-sidebar [import-log-panel]]]]))

(defn access-database-viewer
  "Main viewer component for an Access database"
  []
  (let [restored? (r/atom false)]
    (r/create-class
     {:component-did-mount
      (fn [_]
        (when (and (not @restored?) (nil? (:loaded-path @viewer-state)))
          (reset! restored? true)
          (restore-import-state!)))
      :reagent-render
      (fn []
        (let [{:keys [loading? error loaded-path]} @viewer-state]
          [:div.access-database-viewer
           (if-not loaded-path
             [:div.welcome-panel
              [:h2 "Access Database Import"]
              [:p "Select a database from the sidebar, or click Scan to find .accdb files."]]
             [viewer-loaded-content loaded-path error loading?])]))})))