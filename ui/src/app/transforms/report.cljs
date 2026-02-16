(ns app.transforms.report
  "Pure report transforms — (state, args) -> state.
   8 transforms covering report definition, lint, controls, and group bands.")

;; ============================================================
;; REPORT DEFINITION & LINT
;; ============================================================

(defn set-report-definition [state definition]
  (-> state
      (assoc-in [:report-editor :current] definition)
      (assoc-in [:report-editor :dirty?]
                (not= definition (get-in state [:report-editor :original])))))

(defn clear-report-lint-errors [state]
  (assoc-in state [:report-editor :lint-errors] nil))

(defn set-report-lint-errors [state errors]
  (assoc-in state [:report-editor :lint-errors] errors))

;; ============================================================
;; CONTROL OPERATIONS
;; ============================================================

(defn select-report-control [state selection]
  (assoc-in state [:report-editor :selected-control] selection))

(defn update-report-control [state section idx prop value]
  (let [current (get-in state [:report-editor :current])
        controls (or (get-in current [section :controls]) [])]
    (if (< idx (count controls))
      (let [new-def (assoc-in current [section :controls]
                              (update controls idx assoc prop value))]
        (-> state
            (assoc-in [:report-editor :current] new-def)
            (assoc-in [:report-editor :dirty?]
                      (not= new-def (get-in state [:report-editor :original])))))
      state)))

(defn delete-report-control [state section idx]
  (let [current (get-in state [:report-editor :current])
        controls (or (get-in current [section :controls]) [])]
    (if (< idx (count controls))
      (let [new-controls (vec (concat (subvec controls 0 idx)
                                      (subvec controls (inc idx))))
            new-def (assoc-in current [section :controls] new-controls)]
        (-> state
            (assoc-in [:report-editor :selected-control] nil)
            (assoc-in [:report-editor :current] new-def)
            (assoc-in [:report-editor :dirty?]
                      (not= new-def (get-in state [:report-editor :original])))))
      state)))

;; ============================================================
;; GROUP BAND MANAGEMENT
;; ============================================================

(defn add-group-level [state]
  (let [current (get-in state [:report-editor :current])
        grouping (or (:grouping current) [])
        new-idx (count grouping)
        hdr-key (keyword (str "group-header-" new-idx))
        ftr-key (keyword (str "group-footer-" new-idx))
        new-def (-> current
                    (assoc :grouping (conj grouping {:field "" :sort-order "ascending"}))
                    (assoc hdr-key {:height 60 :controls []})
                    (assoc ftr-key {:height 60 :controls []}))]
    (-> state
        (assoc-in [:report-editor :current] new-def)
        (assoc-in [:report-editor :dirty?]
                  (not= new-def (get-in state [:report-editor :original]))))))

(defn remove-group-level [state]
  (let [current (get-in state [:report-editor :current])
        grouping (or (:grouping current) [])]
    (if (pos? (count grouping))
      (let [last-idx (dec (count grouping))
            hdr-key (keyword (str "group-header-" last-idx))
            ftr-key (keyword (str "group-footer-" last-idx))
            new-def (-> current
                        (assoc :grouping (pop grouping))
                        (dissoc hdr-key ftr-key))]
        (-> state
            (assoc-in [:report-editor :current] new-def)
            (assoc-in [:report-editor :dirty?]
                      (not= new-def (get-in state [:report-editor :original])))))
      state)))
