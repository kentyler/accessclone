(ns app.state-spec
  "Spec definitions for the app-state atom.
   Validates state shape at dev time to catch path typos and missing keys.

   Usage (from REPL or dev init):
     (require '[app.state-spec :as ss])
     (ss/enable-validation!)   ; adds watch that validates on every swap!
     (ss/disable-validation!)  ; removes watch
     (ss/validate-now!)        ; one-shot check"
  (:require [clojure.spec.alpha :as s]
            [app.state :as state]))

;; ============================================================
;; PRIMITIVE SPECS
;; ============================================================

(s/def ::yes-no #{0 1})
(s/def ::optional-yes-no (s/nilable ::yes-no))
(s/def ::keyword-or-nil (s/nilable keyword?))
(s/def ::string-or-nil (s/nilable string?))
(s/def ::number-or-nil (s/nilable number?))
(s/def ::boolean-or-nil (s/nilable boolean?))
(s/def ::map-or-nil (s/nilable map?))
(s/def ::vector-or-nil (s/nilable vector?))

;; ============================================================
;; CONTROL SPEC (shared by forms and reports)
;; ============================================================

(s/def :control/type keyword?)
(s/def :control/name string?)
(s/def :control/x number?)
(s/def :control/y number?)
(s/def :control/width number?)
(s/def :control/height number?)
(s/def :control/visible ::yes-no)
(s/def :control/enabled ::yes-no)
(s/def :control/locked ::yes-no)
(s/def :control/tab-stop ::yes-no)
(s/def :control/field ::string-or-nil)
(s/def :control/control-source ::string-or-nil)
(s/def :control/font-size ::number-or-nil)
(s/def :control/tab-index ::number-or-nil)

(s/def ::control
  (s/keys :req-un [:control/type]
          :opt-un [:control/name :control/x :control/y
                   :control/width :control/height
                   :control/visible :control/enabled
                   :control/locked :control/tab-stop
                   :control/field :control/control-source
                   :control/font-size :control/tab-index]))

;; ============================================================
;; FORM SECTION SPEC (header, detail, footer)
;; ============================================================

(s/def :section/controls (s/coll-of ::control :kind vector?))
(s/def :section/height ::number-or-nil)
(s/def :section/visible ::optional-yes-no)

(s/def ::form-section
  (s/keys :opt-un [:section/controls :section/height :section/visible]))

;; ============================================================
;; FORM DEFINITION SPEC (the :current/:original in :form-editor)
;; ============================================================

(s/def :form-def/name ::string-or-nil)
(s/def :form-def/record-source ::string-or-nil)
(s/def :form-def/order-by ::string-or-nil)
(s/def :form-def/filter ::string-or-nil)
(s/def :form-def/default-view ::string-or-nil)
(s/def :form-def/before-update ::string-or-nil)
(s/def :form-def/width ::number-or-nil)
(s/def :form-def/popup ::yes-no)
(s/def :form-def/modal ::yes-no)
(s/def :form-def/allow-additions ::yes-no)
(s/def :form-def/allow-deletions ::yes-no)
(s/def :form-def/allow-edits ::yes-no)
(s/def :form-def/navigation-buttons ::yes-no)
(s/def :form-def/record-selectors ::yes-no)
(s/def :form-def/dividing-lines ::yes-no)
(s/def :form-def/data-entry ::yes-no)
(s/def :form-def/header ::form-section)
(s/def :form-def/detail ::form-section)
(s/def :form-def/footer ::form-section)

(s/def ::form-definition
  (s/keys :opt-un [:form-def/name :form-def/record-source :form-def/order-by
                   :form-def/filter :form-def/default-view :form-def/before-update
                   :form-def/width
                   :form-def/popup :form-def/modal
                   :form-def/allow-additions :form-def/allow-deletions :form-def/allow-edits
                   :form-def/navigation-buttons :form-def/record-selectors
                   :form-def/dividing-lines :form-def/data-entry
                   :form-def/header :form-def/detail :form-def/footer]))

;; ============================================================
;; REPORT SECTION SPEC (banded: report-header, page-header, etc.)
;; ============================================================

(s/def ::report-section
  (s/keys :opt-un [:section/controls :section/height :section/visible]))

;; ============================================================
;; REPORT DEFINITION SPEC
;; ============================================================

(s/def :report-def/name ::string-or-nil)
(s/def :report-def/record-source ::string-or-nil)
(s/def :report-def/order-by ::string-or-nil)
(s/def :report-def/filter ::string-or-nil)
(s/def :report-def/grouping (s/nilable (s/coll-of map? :kind vector?)))
(s/def :report-def/report-header ::report-section)
(s/def :report-def/page-header ::report-section)
(s/def :report-def/detail ::report-section)
(s/def :report-def/page-footer ::report-section)
(s/def :report-def/report-footer ::report-section)

;; Note: group-header-N and group-footer-N are dynamic keys
;; validated separately via ::report-definition-dynamic
(s/def ::report-definition
  (s/keys :opt-un [:report-def/name :report-def/record-source :report-def/order-by
                   :report-def/filter :report-def/grouping
                   :report-def/report-header :report-def/page-header
                   :report-def/detail
                   :report-def/page-footer :report-def/report-footer]))

;; ============================================================
;; ROW-SOURCE CACHE (combo/listbox options)
;; ============================================================

;; Cache values: nil (not fetched), :loading, or {:rows [...] :fields [...]}
(s/def ::row-source-entry
  (s/or :loading #{:loading}
        :data (s/keys :req-un [:section/controls])  ; has :rows and :fields
        :any map?))

(s/def ::row-source-cache
  (s/nilable (s/map-of string? any?)))

;; ============================================================
;; SUBFORM CACHE
;; ============================================================

(s/def :subform-entry/definition ::map-or-nil)
(s/def :subform-entry/records ::vector-or-nil)
(s/def :subform-entry/filter-key ::string-or-nil)

(s/def ::subform-entry
  (s/keys :opt-un [:subform-entry/definition :subform-entry/records :subform-entry/filter-key]))

(s/def ::subform-cache
  (s/nilable (s/map-of string? ::subform-entry)))

;; ============================================================
;; FORM EDITOR STATE
;; ============================================================

(s/def :form-editor/form-id any?)
(s/def :form-editor/dirty? boolean?)
(s/def :form-editor/original (s/nilable ::form-definition))
(s/def :form-editor/current (s/nilable ::form-definition))
(s/def :form-editor/selected-control any?)  ; index, nil, or map
(s/def :form-editor/view-mode #{:design :view})
(s/def :form-editor/records (s/nilable vector?))
(s/def :form-editor/current-record ::map-or-nil)
(s/def :form-editor/record-position (s/nilable (s/keys :opt-un [::current ::total])))
(s/def :form-editor/record-dirty? boolean?)
(s/def :form-editor/lint-errors ::vector-or-nil)
(s/def :form-editor/row-source-cache ::row-source-cache)
(s/def :form-editor/subform-cache ::subform-cache)
(s/def :form-editor/context-menu ::map-or-nil)

(s/def ::form-editor
  (s/keys :opt-un [:form-editor/form-id :form-editor/dirty?
                   :form-editor/original :form-editor/current
                   :form-editor/selected-control :form-editor/view-mode
                   :form-editor/records :form-editor/current-record
                   :form-editor/record-position :form-editor/record-dirty?
                   :form-editor/lint-errors
                   :form-editor/row-source-cache :form-editor/subform-cache
                   :form-editor/context-menu]))

;; ============================================================
;; REPORT EDITOR STATE
;; ============================================================

(s/def :report-editor/report-id any?)
(s/def :report-editor/dirty? boolean?)
(s/def :report-editor/original (s/nilable ::report-definition))
(s/def :report-editor/current (s/nilable ::report-definition))
(s/def :report-editor/selected-control any?)  ; nil, {:section ...}, or {:section ... :idx ...}
(s/def :report-editor/properties-tab keyword?)
(s/def :report-editor/view-mode #{:design :preview})
(s/def :report-editor/records (s/nilable vector?))
(s/def :report-editor/lint-errors ::vector-or-nil)

(s/def ::report-editor
  (s/keys :opt-un [:report-editor/report-id :report-editor/dirty?
                   :report-editor/original :report-editor/current
                   :report-editor/selected-control :report-editor/properties-tab
                   :report-editor/view-mode :report-editor/records
                   :report-editor/lint-errors]))

;; ============================================================
;; TABLE VIEWER STATE
;; ============================================================

(s/def :table-field/name string?)
(s/def :table-field/type string?)
(s/def :table-field/isPrimaryKey (s/nilable boolean?))

(s/def ::table-field
  (s/keys :req-un [:table-field/name :table-field/type]
          :opt-un [:table-field/isPrimaryKey]))

(s/def :table-info/name string?)
(s/def :table-info/fields (s/coll-of map? :kind vector?))

(s/def ::table-info
  (s/keys :req-un [:table-info/name]
          :opt-un [:table-info/fields]))

(s/def :cell-ref/row nat-int?)
(s/def :cell-ref/col nat-int?)

(s/def ::cell-ref
  (s/keys :req-un [:cell-ref/row :cell-ref/col]))

(s/def :table-viewer/table-id any?)
(s/def :table-viewer/table-info (s/nilable ::table-info))
(s/def :table-viewer/records (s/nilable vector?))
(s/def :table-viewer/view-mode #{:datasheet :design})
(s/def :table-viewer/loading? boolean?)
(s/def :table-viewer/selected (s/nilable ::cell-ref))
(s/def :table-viewer/editing (s/nilable ::cell-ref))
(s/def :table-viewer/context-menu ::map-or-nil)
(s/def :table-viewer/design-fields (s/nilable (s/coll-of map? :kind vector?)))
(s/def :table-viewer/design-original (s/nilable vector?))
(s/def :table-viewer/design-dirty? boolean?)
(s/def :table-viewer/design-renames (s/nilable map?))
(s/def :table-viewer/design-errors ::vector-or-nil)
(s/def :table-viewer/selected-field (s/nilable nat-int?))
(s/def :table-viewer/table-description ::string-or-nil)
(s/def :table-viewer/original-description ::string-or-nil)
(s/def :table-viewer/new-table? boolean?)
(s/def :table-viewer/new-table-name ::string-or-nil)

(s/def ::table-viewer
  (s/keys :opt-un [:table-viewer/table-id :table-viewer/table-info
                   :table-viewer/records :table-viewer/view-mode
                   :table-viewer/loading?
                   :table-viewer/selected :table-viewer/editing
                   :table-viewer/context-menu
                   :table-viewer/design-fields :table-viewer/design-original
                   :table-viewer/design-dirty? :table-viewer/design-renames
                   :table-viewer/design-errors :table-viewer/selected-field
                   :table-viewer/table-description :table-viewer/original-description
                   :table-viewer/new-table? :table-viewer/new-table-name]))

;; ============================================================
;; QUERY VIEWER STATE
;; ============================================================

(s/def :query-viewer/query-id any?)
(s/def :query-viewer/query-info ::map-or-nil)
(s/def :query-viewer/sql string?)
(s/def :query-viewer/results (s/nilable vector?))
(s/def :query-viewer/result-fields (s/nilable vector?))
(s/def :query-viewer/view-mode #{:results :sql})
(s/def :query-viewer/loading? boolean?)
(s/def :query-viewer/error ::string-or-nil)

(s/def ::query-viewer
  (s/keys :opt-un [:query-viewer/query-id :query-viewer/query-info
                   :query-viewer/sql :query-viewer/results :query-viewer/result-fields
                   :query-viewer/view-mode :query-viewer/loading? :query-viewer/error]))

;; ============================================================
;; MODULE VIEWER STATE
;; ============================================================

(s/def :module-viewer/module-id any?)
(s/def :module-viewer/module-info ::map-or-nil)

(s/def ::module-viewer
  (s/keys :opt-un [:module-viewer/module-id :module-viewer/module-info]))

;; ============================================================
;; OBJECTS MAP (sidebar listing)
;; ============================================================

(s/def :objects/tables (s/nilable vector?))
(s/def :objects/queries (s/nilable vector?))
(s/def :objects/forms (s/nilable vector?))
(s/def :objects/reports (s/nilable vector?))
(s/def :objects/modules (s/nilable vector?))
(s/def :objects/access_databases (s/nilable vector?))

(s/def ::objects
  (s/keys :opt-un [:objects/tables :objects/queries :objects/forms
                   :objects/reports :objects/modules :objects/access_databases]))

;; ============================================================
;; TAB / OPEN OBJECT
;; ============================================================

(s/def :tab/type #{:tables :queries :forms :reports :modules})
(s/def :tab/id any?)
(s/def :tab/name string?)

(s/def ::tab
  (s/keys :req-un [:tab/type :tab/name]
          :opt-un [:tab/id]))

(s/def ::open-objects (s/coll-of ::tab :kind vector?))

;; ============================================================
;; CONFIG
;; ============================================================

(s/def :grid/grid-size pos-int?)
(s/def :config/form-designer (s/keys :opt-un [:grid/grid-size]))

(s/def ::config
  (s/keys :opt-un [:config/form-designer]))

;; ============================================================
;; DATABASE
;; ============================================================

(s/def :db/database_id string?)
(s/def :db/name string?)

(s/def ::database
  (s/keys :req-un [:db/database_id :db/name]))

;; ============================================================
;; TOP-LEVEL APP STATE
;; ============================================================

(s/def ::available-databases (s/coll-of ::database :kind vector?))
(s/def ::current-database (s/nilable ::database))
(s/def ::loading-objects? boolean?)
(s/def ::loading? boolean?)
(s/def ::error ::string-or-nil)
(s/def ::options-dialog-open? boolean?)
(s/def ::app-mode #{:run :import})
(s/def ::sidebar-collapsed? boolean?)
(s/def ::sidebar-object-type #{:tables :queries :forms :reports :modules})
(s/def ::active-tab (s/nilable ::tab))
(s/def ::form-data map?)
(s/def ::form-session ::map-or-nil)
(s/def ::chat-messages (s/nilable vector?))
(s/def ::chat-input string?)
(s/def ::chat-loading? boolean?)
(s/def ::chat-panel-open? boolean?)
(s/def ::context-menu ::map-or-nil)

(s/def ::app-state
  (s/keys :opt-un [::available-databases ::current-database ::loading-objects?
                   ::config
                   ::loading? ::error ::options-dialog-open? ::app-mode
                   ::sidebar-collapsed? ::sidebar-object-type
                   ::objects ::open-objects ::active-tab
                   ::form-editor ::report-editor
                   ::table-viewer ::query-viewer ::module-viewer
                   ::form-data ::form-session
                   ::chat-messages ::chat-input ::chat-loading? ::chat-panel-open?
                   ::context-menu]))

;; ============================================================
;; VALIDATION HELPERS
;; ============================================================

(defn validate-now!
  "Validate current app-state against spec. Returns nil if valid,
   or prints explanation and returns the explain-data."
  []
  (let [data @state/app-state]
    (if (s/valid? ::app-state data)
      (do (println "app-state is valid")
          nil)
      (do (println "app-state INVALID:")
          (s/explain ::app-state data)
          (s/explain-data ::app-state data)))))

(defn- validation-watcher [_key _ref old-state new-state]
  (when-not (s/valid? ::app-state new-state)
    (println "SPEC VIOLATION after state change:")
    (s/explain ::app-state new-state)))

(defn enable-validation!
  "Add a watch that validates app-state on every mutation.
   Use during development only — adds overhead to every swap!."
  []
  (add-watch state/app-state ::spec-validator validation-watcher)
  (println "State spec validation enabled"))

(defn disable-validation!
  "Remove the validation watch."
  []
  (remove-watch state/app-state ::spec-validator)
  (println "State spec validation disabled"))
