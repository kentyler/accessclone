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

(defn tokenize
  "Tokenize an Access expression string into a vector of {:type _ :value _} tokens."
  [expr]
  (let [chars (vec expr)
        len (count chars)]
    (loop [i 0
           tokens []]
      (if (>= i len)
        tokens
        (let [ch (nth chars i)]
          (cond
            ;; Skip whitespace
            (whitespace? ch)
            (recur (inc i) tokens)

            ;; Field reference [FieldName]
            (= ch \[)
            (let [end (loop [j (inc i)]
                        (cond
                          (>= j len) j
                          (= (nth chars j) \]) (inc j)
                          :else (recur (inc j))))
                  name-str (subs expr (inc i) (dec end))]
              (recur end (conj tokens {:type :field-ref :value name-str})))

            ;; String literal "text"
            (= ch \")
            (let [end (loop [j (inc i)]
                        (cond
                          (>= j len) j
                          (= (nth chars j) \") (inc j)
                          :else (recur (inc j))))
                  s (subs expr (inc i) (dec end))]
              (recur end (conj tokens {:type :string :value s})))

            ;; Date literal #date#
            (= ch \#)
            (let [end (loop [j (inc i)]
                        (cond
                          (>= j len) j
                          (= (nth chars j) \#) (inc j)
                          :else (recur (inc j))))
                  d (subs expr (inc i) (dec end))]
              (recur end (conj tokens {:type :date :value d})))

            ;; Number (integer or decimal)
            (or (digit? ch) (and (= ch \.) (digit? (nth chars (inc i) nil))))
            (let [end (loop [j i seen-dot? false]
                        (if (>= j len)
                          j
                          (let [c (nth chars j)]
                            (cond
                              (digit? c) (recur (inc j) seen-dot?)
                              (and (= c \.) (not seen-dot?)) (recur (inc j) true)
                              :else j))))
                  n (js/parseFloat (subs expr i end))]
              (recur end (conj tokens {:type :number :value n})))

            ;; Operators
            (contains? #{\+ \- \* \/ \&} ch)
            (recur (inc i) (conj tokens {:type :operator :value (str ch)}))

            ;; Comparison operators
            (= ch \<)
            (if (and (< (inc i) len) (= (nth chars (inc i)) \>))
              (recur (+ i 2) (conj tokens {:type :operator :value "<>"}))
              (if (and (< (inc i) len) (= (nth chars (inc i)) \=))
                (recur (+ i 2) (conj tokens {:type :operator :value "<="}))
                (recur (inc i) (conj tokens {:type :operator :value "<"}))))

            (= ch \>)
            (if (and (< (inc i) len) (= (nth chars (inc i)) \=))
              (recur (+ i 2) (conj tokens {:type :operator :value ">="}))
              (recur (inc i) (conj tokens {:type :operator :value ">"})))

            (= ch \=)
            (recur (inc i) (conj tokens {:type :operator :value "="}))

            ;; Parentheses
            (= ch \()
            (recur (inc i) (conj tokens {:type :paren-open :value "("}))

            (= ch \))
            (recur (inc i) (conj tokens {:type :paren-close :value ")"}))

            ;; Comma
            (= ch \,)
            (recur (inc i) (conj tokens {:type :comma :value ","}))

            ;; Identifier (function name, True/False, Null)
            (alpha? ch)
            (let [end (loop [j i]
                        (if (and (< j len) (alnum? (nth chars j)))
                          (recur (inc j))
                          j))
                  word (subs expr i end)]
              (recur end (conj tokens {:type :identifier :value word})))

            ;; Unknown character - skip
            :else
            (recur (inc i) tokens)))))))

;; ============================================================
;; PARSER — Recursive Descent
;; ============================================================
;; Precedence (lowest to highest):
;;   comparison (=, <>, <, >, <=, >=)
;;   concat (&)
;;   additive (+, -)
;;   multiplicative (*, /)
;;   unary (-)
;;   primary (literals, field-refs, function calls, parens)

(def ^:private aggregate-fns
  #{"sum" "count" "avg" "min" "max" "dcount" "dsum" "first" "last"})

(declare parse-expression)

(defn- peek-token [tokens pos]
  (when (< pos (count tokens))
    (nth tokens pos)))

(defn- parse-primary
  "Parse a primary expression: literal, field-ref, function call, or parenthesized expr."
  [tokens pos]
  (let [tok (peek-token tokens pos)]
    (when-not tok
      (throw (js/Error. "Unexpected end of expression")))
    (case (:type tok)
      :number   [{:type :literal :value (:value tok)} (inc pos)]
      :string   [{:type :string :value (:value tok)} (inc pos)]
      :date     [{:type :date :value (js/Date. (:value tok))} (inc pos)]
      :field-ref [{:type :field-ref :name (:value tok)} (inc pos)]

      :identifier
      (let [word (:value tok)
            lower (str/lower-case word)
            next-tok (peek-token tokens (inc pos))]
        (cond
          ;; Boolean literals
          (= lower "true")  [{:type :literal :value true} (inc pos)]
          (= lower "false") [{:type :literal :value false} (inc pos)]
          (= lower "null")  [{:type :literal :value nil} (inc pos)]

          ;; Function call: identifier followed by (
          (and next-tok (= (:type next-tok) :paren-open))
          (if (contains? aggregate-fns lower)
            ;; Aggregate function
            (let [arg-start (+ pos 2)
                  ;; Special case: Count(*)
                  star-tok (peek-token tokens arg-start)]
              (if (and (= lower "count")
                       star-tok
                       (= (:type star-tok) :operator)
                       (= (:value star-tok) "*"))
                ;; Count(*)
                (let [close-tok (peek-token tokens (inc arg-start))]
                  (if (and close-tok (= (:type close-tok) :paren-close))
                    [{:type :aggregate :fn lower :arg {:type :literal :value "*"}} (+ arg-start 2)]
                    (throw (js/Error. "Expected ) after Count(*)"))))
                ;; Aggregate with expression arg
                (let [[arg new-pos] (parse-primary tokens arg-start) ;; will call full expression parser
                      ;; Actually need to parse a full expression for the arg
                      [arg2 new-pos2] (let [[a p] (parse-expression tokens arg-start)]
                                        [a p])
                      close-tok (peek-token tokens new-pos2)]
                  (if (and close-tok (= (:type close-tok) :paren-close))
                    [{:type :aggregate :fn lower :arg arg2} (inc new-pos2)]
                    (throw (js/Error. (str "Expected ) after " word "(...)")))))))
            ;; Regular function call
            (let [arg-start (+ pos 2)
                  ;; Parse argument list
                  [args final-pos]
                  (let [first-tok (peek-token tokens arg-start)]
                    (if (and first-tok (= (:type first-tok) :paren-close))
                      ;; No arguments
                      [[] arg-start]
                      ;; Parse comma-separated arguments
                      (loop [args []
                             p arg-start]
                        (let [[arg new-p] (parse-expression tokens p)
                              next (peek-token tokens new-p)]
                          (if (and next (= (:type next) :comma))
                            (recur (conj args arg) (inc new-p))
                            [(conj args arg) new-p])))))
                  close-tok (peek-token tokens final-pos)]
              (if (and close-tok (= (:type close-tok) :paren-close))
                [{:type :call :fn lower :args args} (inc final-pos)]
                (throw (js/Error. (str "Expected ) after " word "(...)"))))))

          ;; Bare identifier (treat as field reference)
          :else [{:type :field-ref :name word} (inc pos)]))

      :paren-open
      (let [[expr new-pos] (parse-expression tokens (inc pos))
            close-tok (peek-token tokens new-pos)]
        (if (and close-tok (= (:type close-tok) :paren-close))
          [expr (inc new-pos)]
          (throw (js/Error. "Expected closing parenthesis"))))

      ;; Default
      (throw (js/Error. (str "Unexpected token: " (pr-str tok)))))))

(defn- parse-unary
  "Parse unary minus: -expr"
  [tokens pos]
  (let [tok (peek-token tokens pos)]
    (if (and tok (= (:type tok) :operator) (= (:value tok) "-"))
      (let [[expr new-pos] (parse-unary tokens (inc pos))]
        [{:type :binary-op :op :* :left {:type :literal :value -1} :right expr} new-pos])
      (parse-primary tokens pos))))

(defn- parse-multiplicative
  "Parse * and / operations"
  [tokens pos]
  (let [[left new-pos] (parse-unary tokens pos)]
    (loop [left left
           p new-pos]
      (let [tok (peek-token tokens p)]
        (if (and tok (= (:type tok) :operator) (contains? #{"*" "/"} (:value tok)))
          (let [op (if (= (:value tok) "*") :* :/)
                [right next-p] (parse-unary tokens (inc p))]
            (recur {:type :binary-op :op op :left left :right right} next-p))
          [left p])))))

(defn- parse-additive
  "Parse + and - operations"
  [tokens pos]
  (let [[left new-pos] (parse-multiplicative tokens pos)]
    (loop [left left
           p new-pos]
      (let [tok (peek-token tokens p)]
        (if (and tok (= (:type tok) :operator) (contains? #{"+" "-"} (:value tok)))
          (let [op (if (= (:value tok) "+") :+ :-)
                [right next-p] (parse-multiplicative tokens (inc p))]
            (recur {:type :binary-op :op op :left left :right right} next-p))
          [left p])))))

(defn- parse-concat
  "Parse & (string concatenation)"
  [tokens pos]
  (let [[left new-pos] (parse-additive tokens pos)]
    (loop [left left
           p new-pos]
      (let [tok (peek-token tokens p)]
        (if (and tok (= (:type tok) :operator) (= (:value tok) "&"))
          (let [[right next-p] (parse-additive tokens (inc p))]
            (recur {:type :concat :left left :right right} next-p))
          [left p])))))

(defn- parse-comparison
  "Parse comparison operators: =, <>, <, >, <=, >="
  [tokens pos]
  (let [[left new-pos] (parse-concat tokens pos)]
    (let [tok (peek-token tokens new-pos)]
      (if (and tok (= (:type tok) :operator)
               (contains? #{"=" "<>" "<" ">" "<=" ">="} (:value tok)))
        (let [op (case (:value tok)
                   "=" :=
                   "<>" :<>
                   "<" :<
                   ">" :>
                   "<=" :<=
                   ">=" :>=)
              [right next-p] (parse-concat tokens (inc new-pos))]
          [{:type :binary-op :op op :left left :right right} next-p])
        [left new-pos]))))

(defn parse-expression
  "Top-level expression parser"
  [tokens pos]
  (parse-comparison tokens pos))

(defn parse
  "Parse a token vector into an AST."
  [tokens]
  (when (seq tokens)
    (let [[ast final-pos] (parse-expression tokens 0)]
      ast)))

;; ============================================================
;; EVALUATOR
;; ============================================================

(defn- to-number
  "Coerce a value to a number for arithmetic. Returns 0 for nil/non-numeric."
  [v]
  (cond
    (nil? v) 0
    (number? v) v
    (boolean? v) (if v 1 0)
    (string? v) (let [n (js/parseFloat v)]
                  (if (js/isNaN n) 0 n))
    :else 0))

(defn- to-string
  "Coerce a value to string for concatenation."
  [v]
  (if (nil? v) "" (str v)))

(defn- truthy? [v]
  (cond
    (nil? v) false
    (boolean? v) v
    (number? v) (not (zero? v))
    (string? v) (not (str/blank? v))
    :else true))

(defn- compare-values [op left right]
  (let [result (case op
                 :=  (= left right)
                 :<> (not= left right)
                 :<  (< (to-number left) (to-number right))
                 :>  (> (to-number left) (to-number right))
                 :<= (<= (to-number left) (to-number right))
                 :>= (>= (to-number left) (to-number right))
                 false)]
    (if result -1 0)))  ;; Access convention: True = -1, False = 0

;; Forward declaration
(declare evaluate)

;; Built-in function implementations
(defn- fn-iif [args ctx]
  (let [[cond-expr then-expr else-expr] args
        cond-val (evaluate cond-expr ctx)]
    (if (truthy? cond-val)
      (evaluate then-expr ctx)
      (evaluate else-expr ctx))))

(defn- fn-nz [args ctx]
  (let [val (evaluate (first args) ctx)
        default (if (second args) (evaluate (second args) ctx) 0)]
    (if (nil? val) default val)))

(defn- fn-now [_args _ctx]
  (js/Date.))

(defn- fn-date [_args _ctx]
  (let [d (js/Date.)]
    (js/Date. (.getFullYear d) (.getMonth d) (.getDate d))))

(defn- fn-format [args ctx]
  (let [val (evaluate (first args) ctx)
        fmt (when (second args) (evaluate (second args) ctx))]
    (cond
      (nil? val) ""
      (inst? val)
      (let [d val
            fmt-lower (when fmt (str/lower-case fmt))]
        (cond
          (= fmt-lower "short date")
          (str (inc (.getMonth d)) "/" (.getDate d) "/" (.getFullYear d))
          (= fmt-lower "long date")
          (.toLocaleDateString d "en-US" #js {:weekday "long" :year "numeric" :month "long" :day "numeric"})
          (= fmt-lower "medium date")
          (.toLocaleDateString d "en-US" #js {:year "numeric" :month "short" :day "numeric"})
          (= fmt-lower "short time")
          (.toLocaleTimeString d "en-US" #js {:hour "2-digit" :minute "2-digit"})
          (= fmt-lower "long time")
          (.toLocaleTimeString d "en-US")
          :else (.toLocaleDateString d)))
      (number? val)
      (let [fmt-lower (when fmt (str/lower-case fmt))]
        (cond
          (= fmt-lower "currency") (str "$" (.toFixed val 2))
          (= fmt-lower "percent") (str (.toFixed (* val 100) 0) "%")
          (= fmt-lower "fixed") (.toFixed val 2)
          (= fmt-lower "standard") (.toLocaleString val)
          :else (str val)))
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
        start (dec (to-number (evaluate (second args) ctx))) ;; Access Mid is 1-based
        length (when (nth args 2 nil) (to-number (evaluate (nth args 2) ctx)))]
    (if length
      (subs s (max 0 (int start)) (min (count s) (+ (int start) (int length))))
      (subs s (max 0 (int start))))))

(defn- fn-len [args ctx]
  (count (to-string (evaluate (first args) ctx))))

(defn- fn-trim [args ctx]
  (str/trim (to-string (evaluate (first args) ctx))))

(defn- fn-ucase [args ctx]
  (str/upper-case (to-string (evaluate (first args) ctx))))

(defn- fn-lcase [args ctx]
  (str/lower-case (to-string (evaluate (first args) ctx))))

(defn- fn-int [args ctx]
  (int (js/Math.floor (to-number (evaluate (first args) ctx)))))

(defn- fn-round [args ctx]
  (let [val (to-number (evaluate (first args) ctx))
        decimals (if (second args) (to-number (evaluate (second args) ctx)) 0)]
    (let [factor (js/Math.pow 10 decimals)]
      (/ (js/Math.round (* val factor)) factor))))

(defn- fn-val [args ctx]
  (let [s (to-string (evaluate (first args) ctx))
        n (js/parseFloat s)]
    (if (js/isNaN n) 0 n)))

(defn- fn-instr [args ctx]
  (let [s1 (to-string (evaluate (first args) ctx))
        s2 (to-string (evaluate (second args) ctx))
        idx (.indexOf (str/lower-case s1) (str/lower-case s2))]
    (if (>= idx 0) (inc idx) 0)))  ;; 1-based, 0 = not found

(defn- fn-replace [args ctx]
  (let [s (to-string (evaluate (first args) ctx))
        find-str (to-string (evaluate (second args) ctx))
        replace-str (to-string (evaluate (nth args 2) ctx))]
    (str/replace s find-str replace-str)))

(defn- fn-abs [args ctx]
  (js/Math.abs (to-number (evaluate (first args) ctx))))

(def ^:private builtin-fns
  {"iif"     fn-iif
   "nz"      fn-nz
   "now"     fn-now
   "date"    fn-date
   "format"  fn-format
   "left"    fn-left
   "right"   fn-right
   "mid"     fn-mid
   "len"     fn-len
   "trim"    fn-trim
   "ucase"   fn-ucase
   "lcase"   fn-lcase
   "int"     fn-int
   "round"   fn-round
   "val"     fn-val
   "instr"   fn-instr
   "replace" fn-replace
   "abs"     fn-abs})

(defn- evaluate-aggregate
  "Evaluate an aggregate function across a set of records."
  [agg-fn arg-ast ctx]
  (let [records (or (:group-records ctx) (:all-records ctx) [])]
    (case agg-fn
      "count"
      (if (= (:value arg-ast) "*")
        (count records)
        (count (filter #(some? (evaluate arg-ast (assoc ctx :record %))) records)))

      "sum"
      (reduce (fn [acc rec]
                (+ acc (to-number (evaluate arg-ast (assoc ctx :record rec)))))
              0 records)

      "avg"
      (if (empty? records)
        0
        (let [sum (reduce (fn [acc rec]
                            (+ acc (to-number (evaluate arg-ast (assoc ctx :record rec)))))
                          0 records)]
          (/ sum (count records))))

      "min"
      (when (seq records)
        (reduce (fn [acc rec]
                  (let [v (to-number (evaluate arg-ast (assoc ctx :record rec)))]
                    (if (nil? acc) v (min acc v))))
                nil records))

      "max"
      (when (seq records)
        (reduce (fn [acc rec]
                  (let [v (to-number (evaluate arg-ast (assoc ctx :record rec)))]
                    (if (nil? acc) v (max acc v))))
                nil records))

      ;; fallback
      nil)))

(defn evaluate
  "Evaluate an AST node in the given context.
   Context: {:record {...} :all-records [...] :group-records [...]}"
  [ast ctx]
  (when ast
    (case (:type ast)
      :literal (:value ast)
      :string  (:value ast)
      :date    (:value ast)

      :field-ref
      (let [name-lower (str/lower-case (:name ast))
            record (:record ctx)]
        (when record
          ;; Try keyword lookup, then string lookup (case-insensitive)
          (or (get record (keyword name-lower))
              (get record name-lower)
              (some (fn [[k v]]
                      (when (= (str/lower-case (name k)) name-lower) v))
                    record))))

      :binary-op
      (let [op (:op ast)]
        (if (contains? #{:= :<> :< :> :<= :>=} op)
          (compare-values op (evaluate (:left ast) ctx) (evaluate (:right ast) ctx))
          (let [left (to-number (evaluate (:left ast) ctx))
                right (to-number (evaluate (:right ast) ctx))]
            (case op
              :+ (+ left right)
              :- (- left right)
              :* (* left right)
              :/ (if (zero? right) nil (/ left right))))))

      :concat
      (str (to-string (evaluate (:left ast) ctx))
           (to-string (evaluate (:right ast) ctx)))

      :call
      (let [fn-name (:fn ast)
            handler (get builtin-fns fn-name)]
        (if handler
          (handler (:args ast) ctx)
          nil))

      :aggregate
      (evaluate-aggregate (:fn ast) (:arg ast) ctx)

      ;; Unknown node type
      nil)))

;; ============================================================
;; PUBLIC API
;; ============================================================

(def ^:private parse-cache (atom {}))

(defn- get-cached-ast
  "Get or compute the AST for an expression string."
  [expr-str]
  (if-let [cached (get @parse-cache expr-str)]
    cached
    (let [tokens (tokenize expr-str)
          ast (parse tokens)]
      (swap! parse-cache assoc expr-str ast)
      ;; Keep cache bounded
      (when (> (count @parse-cache) 500)
        (reset! parse-cache {}))
      ast)))

(defn evaluate-expression
  "Evaluate an Access expression string.
   expr-string should NOT include the leading '='.
   context: {:record {...} :all-records [...] :group-records [...]}
   Returns the computed value, or \"#Error\" on failure."
  [expr-string context]
  (try
    (let [ast (get-cached-ast expr-string)]
      (evaluate ast context))
    (catch :default _e
      "#Error")))

(defn expression?
  "Returns true if the string starts with '=' (is an expression)."
  [s]
  (and (string? s) (str/starts-with? s "=")))
