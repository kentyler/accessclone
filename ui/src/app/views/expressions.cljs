(ns app.views.expressions
  "Access-style expression evaluator.
   Supports: [FieldName], math (+,-,*,/), string concat (&),
   built-in functions, aggregate functions, and literals."
  (:require [clojure.string :as str]))

;; ============================================================
;; TOKENIZER
;; ============================================================

(defn- whitespace? [ch]
  (or (= ch \space) (= ch \tab) (= ch \newline) (= ch \return)))

(defn- digit? [ch]
  (and ch (>= (.charCodeAt (str ch) 0) 48) (<= (.charCodeAt (str ch) 0) 57)))

(defn- alpha? [ch]
  (and ch (re-matches #"[a-zA-Z_]" (str ch))))

(defn- alnum? [ch]
  (or (alpha? ch) (digit? ch)))

(defn- scan-until
  "Scan from start until delimiter char is found, returning position after delimiter."
  [chars len start delim]
  (loop [j start]
    (cond (>= j len) j
          (= (nth chars j) delim) (inc j)
          :else (recur (inc j)))))

(defn- scan-number
  "Scan a number token starting at i. Returns end position."
  [chars len i]
  (loop [j i, seen-dot? false]
    (if (>= j len) j
      (let [c (nth chars j)]
        (cond (digit? c) (recur (inc j) seen-dot?)
              (and (= c \.) (not seen-dot?)) (recur (inc j) true)
              :else j)))))

(defn- scan-identifier
  "Scan an identifier starting at i. Returns end position."
  [chars len i]
  (loop [j i]
    (if (and (< j len) (alnum? (nth chars j)))
      (recur (inc j)) j)))

(defn- tokenize-comparison
  "Tokenize < or > with possible = suffix."
  [chars len i ch]
  (let [next-ch (when (< (inc i) len) (nth chars (inc i)))]
    (cond
      (and (= ch \<) (= next-ch \>)) [(+ i 2) {:type :operator :value "<>"}]
      (and (= ch \<) (= next-ch \=)) [(+ i 2) {:type :operator :value "<="}]
      (= ch \<)                       [(inc i) {:type :operator :value "<"}]
      (and (= ch \>) (= next-ch \=)) [(+ i 2) {:type :operator :value ">="}]
      :else                           [(inc i) {:type :operator :value ">"}])))

(defn tokenize
  "Tokenize an Access expression string into a vector of {:type _ :value _} tokens."
  [expr]
  (let [chars (vec expr), len (count chars)]
    (loop [i 0, tokens []]
      (if (>= i len) tokens
        (let [ch (nth chars i)]
          (cond
            (whitespace? ch)
            (recur (inc i) tokens)

            (= ch \[)
            (let [end (scan-until chars len (inc i) \])]
              (recur end (conj tokens {:type :field-ref :value (subs expr (inc i) (dec end))})))

            (= ch \")
            (let [end (scan-until chars len (inc i) \")]
              (recur end (conj tokens {:type :string :value (subs expr (inc i) (dec end))})))

            (= ch \#)
            (let [end (scan-until chars len (inc i) \#)]
              (recur end (conj tokens {:type :date :value (subs expr (inc i) (dec end))})))

            (or (digit? ch) (and (= ch \.) (digit? (nth chars (inc i) nil))))
            (let [end (scan-number chars len i)]
              (recur end (conj tokens {:type :number :value (js/parseFloat (subs expr i end))})))

            (contains? #{\+ \- \* \/ \&} ch)
            (recur (inc i) (conj tokens {:type :operator :value (str ch)}))

            (or (= ch \<) (= ch \>))
            (let [[end tok] (tokenize-comparison chars len i ch)]
              (recur end (conj tokens tok)))

            (= ch \=) (recur (inc i) (conj tokens {:type :operator :value "="}))
            (= ch \() (recur (inc i) (conj tokens {:type :paren-open :value "("}))
            (= ch \)) (recur (inc i) (conj tokens {:type :paren-close :value ")"}))
            (= ch \,) (recur (inc i) (conj tokens {:type :comma :value ","}))

            (alpha? ch)
            (let [end (scan-identifier chars len i)]
              (recur end (conj tokens {:type :identifier :value (subs expr i end)})))

            :else (recur (inc i) tokens)))))))

;; ============================================================
;; PARSER — Recursive Descent
;; ============================================================

(def ^:private aggregate-fns
  #{"sum" "count" "avg" "min" "max" "dcount" "dsum" "first" "last"})

(declare parse-expression)

(defn- peek-token [tokens pos]
  (when (< pos (count tokens)) (nth tokens pos)))

(defn- expect-close-paren [tokens pos context]
  (let [tok (peek-token tokens pos)]
    (if (and tok (= (:type tok) :paren-close))
      (inc pos)
      (throw (js/Error. (str "Expected ) after " context))))))

(defn- parse-count-star
  "Parse Count(*) special case. arg-start points to the * token."
  [tokens arg-start]
  (let [close-pos (expect-close-paren tokens (inc arg-start) "Count(*)")]
    [{:type :aggregate :fn "count" :arg {:type :literal :value "*"}} close-pos]))

(defn- parse-aggregate-call
  "Parse an aggregate function call: fn-name(expr)"
  [lower tokens pos]
  (let [arg-start (+ pos 2)
        star-tok (peek-token tokens arg-start)]
    (if (and (= lower "count") star-tok (= (:type star-tok) :operator) (= (:value star-tok) "*"))
      (parse-count-star tokens arg-start)
      (let [[arg new-pos] (parse-expression tokens arg-start)
            final-pos (expect-close-paren tokens new-pos (str lower "(...)"))]
        [{:type :aggregate :fn lower :arg arg} final-pos]))))

(defn- parse-arg-list
  "Parse a comma-separated argument list. Returns [args-vec final-pos]."
  [tokens arg-start]
  (let [first-tok (peek-token tokens arg-start)]
    (if (and first-tok (= (:type first-tok) :paren-close))
      [[] arg-start]
      (loop [args [], p arg-start]
        (let [[arg new-p] (parse-expression tokens p)
              next-tok (peek-token tokens new-p)]
          (if (and next-tok (= (:type next-tok) :comma))
            (recur (conj args arg) (inc new-p))
            [(conj args arg) new-p]))))))

(defn- parse-function-call
  "Parse a regular function call: fn-name(args...)"
  [lower tokens pos]
  (let [arg-start (+ pos 2)
        [args final-pos] (parse-arg-list tokens arg-start)
        close-pos (expect-close-paren tokens final-pos (str lower "(...)"))]
    [{:type :call :fn lower :args args} close-pos]))

(defn- parse-identifier-expr
  "Parse an identifier: boolean literal, function call, or bare field ref."
  [tokens pos]
  (let [tok (peek-token tokens pos)
        word (:value tok)
        lower (str/lower-case word)
        next-tok (peek-token tokens (inc pos))]
    (cond
      (= lower "true")  [{:type :literal :value true} (inc pos)]
      (= lower "false") [{:type :literal :value false} (inc pos)]
      (= lower "null")  [{:type :literal :value nil} (inc pos)]

      (and next-tok (= (:type next-tok) :paren-open))
      (if (contains? aggregate-fns lower)
        (parse-aggregate-call lower tokens pos)
        (parse-function-call lower tokens pos))

      :else [{:type :field-ref :name word} (inc pos)])))

(defn- parse-primary
  "Parse a primary expression: literal, field-ref, function call, or parenthesized expr."
  [tokens pos]
  (let [tok (peek-token tokens pos)]
    (when-not tok (throw (js/Error. "Unexpected end of expression")))
    (case (:type tok)
      :number   [{:type :literal :value (:value tok)} (inc pos)]
      :string   [{:type :string :value (:value tok)} (inc pos)]
      :date     [{:type :date :value (js/Date. (:value tok))} (inc pos)]
      :field-ref [{:type :field-ref :name (:value tok)} (inc pos)]
      :identifier (parse-identifier-expr tokens pos)
      :paren-open (let [[expr new-pos] (parse-expression tokens (inc pos))
                         close-pos (expect-close-paren tokens new-pos "expression")]
                     [expr close-pos])
      (throw (js/Error. (str "Unexpected token: " (pr-str tok)))))))

(defn- parse-unary [tokens pos]
  (let [tok (peek-token tokens pos)]
    (if (and tok (= (:type tok) :operator) (= (:value tok) "-"))
      (let [[expr new-pos] (parse-unary tokens (inc pos))]
        [{:type :binary-op :op :* :left {:type :literal :value -1} :right expr} new-pos])
      (parse-primary tokens pos))))

(defn- parse-binary-left
  "Generic left-associative binary operator parser."
  [sub-parser op-set op-map tokens pos]
  (let [[left new-pos] (sub-parser tokens pos)]
    (loop [left left, p new-pos]
      (let [tok (peek-token tokens p)]
        (if (and tok (= (:type tok) :operator) (contains? op-set (:value tok)))
          (let [op (get op-map (:value tok))
                [right next-p] (sub-parser tokens (inc p))]
            (recur {:type :binary-op :op op :left left :right right} next-p))
          [left p])))))

(defn- parse-multiplicative [tokens pos]
  (parse-binary-left parse-unary #{"*" "/"} {"*" :* "/" :/} tokens pos))

(defn- parse-additive [tokens pos]
  (parse-binary-left parse-multiplicative #{"+" "-"} {"+" :+ "-" :-} tokens pos))

(defn- parse-concat [tokens pos]
  (let [[left new-pos] (parse-additive tokens pos)]
    (loop [left left, p new-pos]
      (let [tok (peek-token tokens p)]
        (if (and tok (= (:type tok) :operator) (= (:value tok) "&"))
          (let [[right next-p] (parse-additive tokens (inc p))]
            (recur {:type :concat :left left :right right} next-p))
          [left p])))))

(defn- parse-comparison [tokens pos]
  (let [[left new-pos] (parse-concat tokens pos)
        tok (peek-token tokens new-pos)
        cmp-ops #{"=" "<>" "<" ">" "<=" ">="}
        op-map {"=" := "<>" :<> "<" :< ">" :> "<=" :<= ">=" :>=}]
    (if (and tok (= (:type tok) :operator) (contains? cmp-ops (:value tok)))
      (let [op (get op-map (:value tok))
            [right next-p] (parse-concat tokens (inc new-pos))]
        [{:type :binary-op :op op :left left :right right} next-p])
      [left new-pos])))

(defn parse-expression [tokens pos]
  (parse-comparison tokens pos))

(defn parse [tokens]
  (when (seq tokens)
    (let [[ast _] (parse-expression tokens 0)] ast)))

;; ============================================================
;; EVALUATOR
;; ============================================================

(defn- to-number [v]
  (cond (nil? v) 0, (number? v) v, (boolean? v) (if v 1 0)
        (string? v) (let [n (js/parseFloat v)] (if (js/isNaN n) 0 n))
        :else 0))

(defn- to-string [v]
  (if (nil? v) "" (str v)))

(defn- truthy? [v]
  (cond (nil? v) false, (boolean? v) v, (number? v) (not (zero? v))
        (string? v) (not (str/blank? v)), :else true))

(defn- compare-values [op left right]
  (let [result (case op
                 :=  (= left right), :<> (not= left right)
                 :<  (< (to-number left) (to-number right))
                 :>  (> (to-number left) (to-number right))
                 :<= (<= (to-number left) (to-number right))
                 :>= (>= (to-number left) (to-number right))
                 false)]
    (if result -1 0)))

(declare evaluate)

;; --- Built-in functions ---

(defn- fn-iif [args ctx]
  (if (truthy? (evaluate (first args) ctx))
    (evaluate (second args) ctx) (evaluate (nth args 2) ctx)))

(defn- fn-nz [args ctx]
  (let [v (evaluate (first args) ctx)]
    (if (nil? v) (if (second args) (evaluate (second args) ctx) 0) v)))

(defn- fn-now [_ _] (js/Date.))

(defn- fn-date [_ _]
  (let [d (js/Date.)] (js/Date. (.getFullYear d) (.getMonth d) (.getDate d))))

(defn- format-date [d fmt-lower]
  (case fmt-lower
    "short date" (str (inc (.getMonth d)) "/" (.getDate d) "/" (.getFullYear d))
    "long date" (.toLocaleDateString d "en-US" #js {:weekday "long" :year "numeric" :month "long" :day "numeric"})
    "medium date" (.toLocaleDateString d "en-US" #js {:year "numeric" :month "short" :day "numeric"})
    "short time" (.toLocaleTimeString d "en-US" #js {:hour "2-digit" :minute "2-digit"})
    "long time" (.toLocaleTimeString d "en-US")
    (.toLocaleDateString d)))

(defn- format-number [val fmt-lower]
  (case fmt-lower
    "currency" (str "$" (.toFixed val 2))
    "percent"  (str (.toFixed (* val 100) 0) "%")
    "fixed"    (.toFixed val 2)
    "standard" (.toLocaleString val)
    (str val)))

(defn- fn-format [args ctx]
  (let [val (evaluate (first args) ctx)
        fmt (when (second args) (evaluate (second args) ctx))
        fmt-lower (when fmt (str/lower-case fmt))]
    (cond (nil? val) ""
          (inst? val) (format-date val fmt-lower)
          (number? val) (format-number val fmt-lower)
          :else (str val))))

(defn- fn-left [args ctx]
  (let [s (to-string (evaluate (first args) ctx))
        n (to-number (evaluate (second args) ctx))]
    (subs s 0 (min (int n) (count s)))))

(defn- fn-right [args ctx]
  (let [s (to-string (evaluate (first args) ctx))
        n (to-number (evaluate (second args) ctx))]
    (subs s (max 0 (- (count s) (int n))))))

(defn- fn-mid [args ctx]
  (let [s (to-string (evaluate (first args) ctx))
        start (dec (to-number (evaluate (second args) ctx)))
        length (when (nth args 2 nil) (to-number (evaluate (nth args 2) ctx)))]
    (if length
      (subs s (max 0 (int start)) (min (count s) (+ (int start) (int length))))
      (subs s (max 0 (int start))))))

(defn- fn-len [args ctx] (count (to-string (evaluate (first args) ctx))))
(defn- fn-trim [args ctx] (str/trim (to-string (evaluate (first args) ctx))))
(defn- fn-ucase [args ctx] (str/upper-case (to-string (evaluate (first args) ctx))))
(defn- fn-lcase [args ctx] (str/lower-case (to-string (evaluate (first args) ctx))))
(defn- fn-int [args ctx] (int (js/Math.floor (to-number (evaluate (first args) ctx)))))
(defn- fn-abs [args ctx] (js/Math.abs (to-number (evaluate (first args) ctx))))
(defn- fn-val [args ctx]
  (let [n (js/parseFloat (to-string (evaluate (first args) ctx)))]
    (if (js/isNaN n) 0 n)))

(defn- fn-round [args ctx]
  (let [val (to-number (evaluate (first args) ctx))
        dec-places (if (second args) (to-number (evaluate (second args) ctx)) 0)
        factor (js/Math.pow 10 dec-places)]
    (/ (js/Math.round (* val factor)) factor)))

(defn- fn-instr [args ctx]
  (let [idx (.indexOf (str/lower-case (to-string (evaluate (first args) ctx)))
                      (str/lower-case (to-string (evaluate (second args) ctx))))]
    (if (>= idx 0) (inc idx) 0)))

(defn- fn-replace [args ctx]
  (str/replace (to-string (evaluate (first args) ctx))
               (to-string (evaluate (second args) ctx))
               (to-string (evaluate (nth args 2) ctx))))

(def ^:private builtin-fns
  {"iif" fn-iif, "nz" fn-nz, "now" fn-now, "date" fn-date, "format" fn-format
   "left" fn-left, "right" fn-right, "mid" fn-mid, "len" fn-len, "trim" fn-trim
   "ucase" fn-ucase, "lcase" fn-lcase, "int" fn-int, "round" fn-round
   "val" fn-val, "instr" fn-instr, "replace" fn-replace, "abs" fn-abs})

;; --- Aggregates ---

(defn- eval-over-records
  "Evaluate an AST for each record, returning a lazy seq of numeric values."
  [arg-ast ctx records]
  (map #(to-number (evaluate arg-ast (assoc ctx :record %))) records))

(defn- evaluate-aggregate [agg-fn arg-ast ctx]
  (let [records (or (:group-records ctx) (:all-records ctx) [])]
    (case agg-fn
      "count" (if (= (:value arg-ast) "*")
                (count records)
                (count (filter #(some? (evaluate arg-ast (assoc ctx :record %))) records)))
      "sum"   (reduce + 0 (eval-over-records arg-ast ctx records))
      "avg"   (if (empty? records) 0
                (/ (reduce + 0 (eval-over-records arg-ast ctx records)) (count records)))
      "min"   (when (seq records) (apply min (eval-over-records arg-ast ctx records)))
      "max"   (when (seq records) (apply max (eval-over-records arg-ast ctx records)))
      nil)))

;; --- Field ref evaluation ---

(defn- eval-field-ref [name-lower ctx]
  (cond
    (= name-lower "page")  (:page ctx)
    (= name-lower "pages") (:pages ctx)
    :else
    (when-let [record (:record ctx)]
      (or (get record (keyword name-lower))
          (get record name-lower)
          (some (fn [[k v]] (when (= (str/lower-case (name k)) name-lower) v)) record)))))

;; --- Binary op evaluation ---

(defn- eval-binary-op [ast ctx]
  (let [op (:op ast)]
    (if (contains? #{:= :<> :< :> :<= :>=} op)
      (compare-values op (evaluate (:left ast) ctx) (evaluate (:right ast) ctx))
      (let [l (to-number (evaluate (:left ast) ctx))
            r (to-number (evaluate (:right ast) ctx))]
        (case op :+ (+ l r), :- (- l r), :* (* l r), :/ (if (zero? r) nil (/ l r)))))))

(defn evaluate
  "Evaluate an AST node in the given context."
  [ast ctx]
  (when ast
    (case (:type ast)
      :literal   (:value ast)
      :string    (:value ast)
      :date      (:value ast)
      :field-ref (eval-field-ref (str/lower-case (:name ast)) ctx)
      :binary-op (eval-binary-op ast ctx)
      :concat    (str (to-string (evaluate (:left ast) ctx))
                      (to-string (evaluate (:right ast) ctx)))
      :call      (when-let [handler (get builtin-fns (:fn ast))]
                   (handler (:args ast) ctx))
      :aggregate (evaluate-aggregate (:fn ast) (:arg ast) ctx)
      nil)))

;; ============================================================
;; PUBLIC API
;; ============================================================

(def ^:private parse-cache (atom {}))

(defn- get-cached-ast [expr-str]
  (if-let [cached (get @parse-cache expr-str)]
    cached
    (let [ast (parse (tokenize expr-str))]
      (swap! parse-cache assoc expr-str ast)
      (when (> (count @parse-cache) 500) (reset! parse-cache {}))
      ast)))

(defn evaluate-expression
  "Evaluate an Access expression string (without leading '=').
   Returns the computed value, or \"#Error\" on failure."
  [expr-string context]
  (try (evaluate (get-cached-ast expr-string) context)
    (catch :default _ "#Error")))

(defn expression? [s]
  (and (string? s) (str/starts-with? s "=")))

;; --- Conditional formatting ---

(defn- parse-cf-rules [rules]
  (cond
    (sequential? rules) rules
    (string? rules) (try (let [p (.parse js/JSON rules)]
                           (when (array? p) (js->clj p :keywordize-keys true)))
                         (catch :default _ nil))
    :else nil))

(defn- rule-matches? [expr-str ctx]
  (try (let [r (evaluate-expression expr-str ctx)]
         (and (some? r) (not= r 0) (not= r false)))
    (catch :default _ false)))

(defn- rule->style [rule]
  (cond-> {}
    (:fore-color rule)         (assoc :color (:fore-color rule))
    (:back-color rule)         (assoc :background-color (:back-color rule))
    (= 1 (:font-bold rule))   (assoc :font-weight "bold")
    (= 1 (:font-italic rule)) (assoc :font-style "italic")))

(defn apply-conditional-formatting
  "Evaluate conditional formatting rules. Returns style map from first match, or nil."
  [ctrl record expr-context]
  (when-let [rules (parse-cf-rules (:conditional-formatting ctrl))]
    (let [ctx (merge {:record record} expr-context)]
      (loop [rs (seq rules)]
        (when rs
          (let [rule (first rs)
                expr-str (or (:expression rule) (:Expression rule))]
            (if (and (string? expr-str) (not (str/blank? expr-str)) (rule-matches? expr-str ctx))
              (rule->style rule)
              (recur (next rs)))))))))
