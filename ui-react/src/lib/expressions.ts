/**
 * Access-style expression evaluator.
 * Supports: [FieldName], math (+,-,*,/), string concat (&),
 * built-in functions, aggregate functions, and literals.
 *
 * Ported from expressions.cljs (520 lines).
 */

// ============================================================
// TOKEN TYPES
// ============================================================

interface Token {
  type: 'number' | 'string' | 'date' | 'field-ref' | 'identifier' | 'operator' | 'paren-open' | 'paren-close' | 'comma';
  value: string | number;
}

// ============================================================
// AST NODE TYPES
// ============================================================

export type AstNode =
  | { type: 'literal'; value: unknown }
  | { type: 'string'; value: string }
  | { type: 'date'; value: Date }
  | { type: 'field-ref'; name: string }
  | { type: 'binary-op'; op: string; left: AstNode; right: AstNode }
  | { type: 'concat'; left: AstNode; right: AstNode }
  | { type: 'not-op'; operand: AstNode }
  | { type: 'and-op'; left: AstNode; right: AstNode }
  | { type: 'or-op'; left: AstNode; right: AstNode }
  | { type: 'call'; fn: string; args: AstNode[] }
  | { type: 'aggregate'; fn: string; arg: AstNode };

// ============================================================
// EXPRESSION CONTEXT
// ============================================================

export interface ExprContext {
  record?: Record<string, unknown>;
  groupRecords?: Record<string, unknown>[];
  allRecords?: Record<string, unknown>[];
  page?: number;
  pages?: number;
}

// ============================================================
// TOKENIZER
// ============================================================

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isAlpha(ch: string): boolean {
  return /^[a-zA-Z_]$/.test(ch);
}

function isAlnum(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch);
}

function scanUntil(chars: string[], len: number, start: number, delim: string): number {
  let j = start;
  while (j < len) {
    if (chars[j] === delim) return j + 1;
    j++;
  }
  return j;
}

function scanNumber(chars: string[], len: number, i: number): number {
  let j = i;
  let seenDot = false;
  while (j < len) {
    const c = chars[j];
    if (isDigit(c)) { j++; }
    else if (c === '.' && !seenDot) { seenDot = true; j++; }
    else break;
  }
  return j;
}

function scanIdentifier(chars: string[], len: number, i: number): number {
  let j = i;
  while (j < len && isAlnum(chars[j])) j++;
  return j;
}

export function tokenize(expr: string): Token[] {
  const chars = expr.split('');
  const len = chars.length;
  const tokens: Token[] = [];
  let i = 0;

  while (i < len) {
    const ch = chars[i];

    if (isWhitespace(ch)) { i++; continue; }

    if (ch === '[') {
      const end = scanUntil(chars, len, i + 1, ']');
      tokens.push({ type: 'field-ref', value: expr.slice(i + 1, end - 1) });
      i = end; continue;
    }

    if (ch === '"') {
      const end = scanUntil(chars, len, i + 1, '"');
      tokens.push({ type: 'string', value: expr.slice(i + 1, end - 1) });
      i = end; continue;
    }

    if (ch === '#') {
      const end = scanUntil(chars, len, i + 1, '#');
      tokens.push({ type: 'date', value: expr.slice(i + 1, end - 1) });
      i = end; continue;
    }

    if (isDigit(ch) || (ch === '.' && i + 1 < len && isDigit(chars[i + 1]))) {
      const end = scanNumber(chars, len, i);
      tokens.push({ type: 'number', value: parseFloat(expr.slice(i, end)) });
      i = end; continue;
    }

    if ('+-*/&'.includes(ch)) {
      tokens.push({ type: 'operator', value: ch });
      i++; continue;
    }

    if (ch === '<' || ch === '>') {
      const next = i + 1 < len ? chars[i + 1] : '';
      if (ch === '<' && next === '>') { tokens.push({ type: 'operator', value: '<>' }); i += 2; }
      else if (ch === '<' && next === '=') { tokens.push({ type: 'operator', value: '<=' }); i += 2; }
      else if (ch === '>' && next === '=') { tokens.push({ type: 'operator', value: '>=' }); i += 2; }
      else { tokens.push({ type: 'operator', value: ch }); i++; }
      continue;
    }

    if (ch === '=') { tokens.push({ type: 'operator', value: '=' }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'paren-open', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'paren-close', value: ')' }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',' }); i++; continue; }

    if (isAlpha(ch)) {
      const end = scanIdentifier(chars, len, i);
      tokens.push({ type: 'identifier', value: expr.slice(i, end) });
      i = end; continue;
    }

    i++; // skip unknown
  }

  return tokens;
}

// ============================================================
// PARSER — Recursive Descent
// ============================================================

const AGGREGATE_FNS = new Set(['sum', 'count', 'avg', 'min', 'max', 'dcount', 'dsum', 'first', 'last']);

type ParseResult = [AstNode, number];

function peekToken(tokens: Token[], pos: number): Token | null {
  return pos < tokens.length ? tokens[pos] : null;
}

function expectCloseParen(tokens: Token[], pos: number, context: string): number {
  const tok = peekToken(tokens, pos);
  if (tok && tok.type === 'paren-close') return pos + 1;
  throw new Error(`Expected ) after ${context}`);
}

function parseArgList(tokens: Token[], argStart: number): [AstNode[], number] {
  const firstTok = peekToken(tokens, argStart);
  if (firstTok && firstTok.type === 'paren-close') return [[], argStart];

  const args: AstNode[] = [];
  let p = argStart;
  while (true) {
    const [arg, newP] = parseExpression(tokens, p);
    args.push(arg);
    const nextTok = peekToken(tokens, newP);
    if (nextTok && nextTok.type === 'comma') { p = newP + 1; }
    else { p = newP; break; }
  }
  return [args, p];
}

function parseAggregateCall(lower: string, tokens: Token[], pos: number): ParseResult {
  const argStart = pos + 2;
  const starTok = peekToken(tokens, argStart);
  if (lower === 'count' && starTok && starTok.type === 'operator' && starTok.value === '*') {
    const closePos = expectCloseParen(tokens, argStart + 1, 'Count(*)');
    return [{ type: 'aggregate', fn: 'count', arg: { type: 'literal', value: '*' } }, closePos];
  }
  const [arg, newPos] = parseExpression(tokens, argStart);
  const finalPos = expectCloseParen(tokens, newPos, `${lower}(...)`);
  return [{ type: 'aggregate', fn: lower, arg }, finalPos];
}

function parseFunctionCall(lower: string, tokens: Token[], pos: number): ParseResult {
  const argStart = pos + 2;
  const [args, finalPos] = parseArgList(tokens, argStart);
  const closePos = expectCloseParen(tokens, finalPos, `${lower}(...)`);
  return [{ type: 'call', fn: lower, args }, closePos];
}

function parseIdentifierExpr(tokens: Token[], pos: number): ParseResult {
  const tok = peekToken(tokens, pos)!;
  const word = tok.value as string;
  const lower = word.toLowerCase();
  const nextTok = peekToken(tokens, pos + 1);

  if (lower === 'true') return [{ type: 'literal', value: true }, pos + 1];
  if (lower === 'false') return [{ type: 'literal', value: false }, pos + 1];
  if (lower === 'null') return [{ type: 'literal', value: null }, pos + 1];

  if (nextTok && nextTok.type === 'paren-open') {
    if (AGGREGATE_FNS.has(lower)) return parseAggregateCall(lower, tokens, pos);
    return parseFunctionCall(lower, tokens, pos);
  }

  return [{ type: 'field-ref', name: word }, pos + 1];
}

function parsePrimary(tokens: Token[], pos: number): ParseResult {
  const tok = peekToken(tokens, pos);
  if (!tok) throw new Error('Unexpected end of expression');

  switch (tok.type) {
    case 'number': return [{ type: 'literal', value: tok.value }, pos + 1];
    case 'string': return [{ type: 'string', value: tok.value as string }, pos + 1];
    case 'date': return [{ type: 'date', value: new Date(tok.value as string) }, pos + 1];
    case 'field-ref': return [{ type: 'field-ref', name: tok.value as string }, pos + 1];
    case 'identifier': return parseIdentifierExpr(tokens, pos);
    case 'paren-open': {
      const [expr, newPos] = parseExpression(tokens, pos + 1);
      const closePos = expectCloseParen(tokens, newPos, 'expression');
      return [expr, closePos];
    }
    default: throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }
}

function parseUnary(tokens: Token[], pos: number): ParseResult {
  const tok = peekToken(tokens, pos);
  if (tok && tok.type === 'operator' && tok.value === '-') {
    const [expr, newPos] = parseUnary(tokens, pos + 1);
    return [{ type: 'binary-op', op: '*', left: { type: 'literal', value: -1 }, right: expr }, newPos];
  }
  return parsePrimary(tokens, pos);
}

function parseBinaryLeft(
  subParser: (tokens: Token[], pos: number) => ParseResult,
  opSet: Set<string>,
  opMap: Record<string, string>,
  tokens: Token[],
  pos: number,
): ParseResult {
  let [left, p] = subParser(tokens, pos);
  while (true) {
    const tok = peekToken(tokens, p);
    if (tok && tok.type === 'operator' && opSet.has(tok.value as string)) {
      const op = opMap[tok.value as string];
      const [right, nextP] = subParser(tokens, p + 1);
      left = { type: 'binary-op', op, left, right };
      p = nextP;
    } else break;
  }
  return [left, p];
}

function parseMultiplicative(tokens: Token[], pos: number): ParseResult {
  return parseBinaryLeft(parseUnary, new Set(['*', '/']), { '*': '*', '/': '/' }, tokens, pos);
}

function parseAdditive(tokens: Token[], pos: number): ParseResult {
  return parseBinaryLeft(parseMultiplicative, new Set(['+', '-']), { '+': '+', '-': '-' }, tokens, pos);
}

function parseConcat(tokens: Token[], pos: number): ParseResult {
  let [left, p] = parseAdditive(tokens, pos);
  while (true) {
    const tok = peekToken(tokens, p);
    if (tok && tok.type === 'operator' && tok.value === '&') {
      const [right, nextP] = parseAdditive(tokens, p + 1);
      left = { type: 'concat', left, right };
      p = nextP;
    } else break;
  }
  return [left, p];
}

function parseComparison(tokens: Token[], pos: number): ParseResult {
  const [left, newPos] = parseConcat(tokens, pos);
  const tok = peekToken(tokens, newPos);
  const cmpOps = new Set(['=', '<>', '<', '>', '<=', '>=']);
  if (tok && tok.type === 'operator' && cmpOps.has(tok.value as string)) {
    const [right, nextP] = parseConcat(tokens, newPos + 1);
    return [{ type: 'binary-op', op: tok.value as string, left, right }, nextP];
  }
  return [left, newPos];
}

function parseNot(tokens: Token[], pos: number): ParseResult {
  const tok = peekToken(tokens, pos);
  if (tok && tok.type === 'identifier' && (tok.value as string).toLowerCase() === 'not') {
    const [expr, newPos] = parseNot(tokens, pos + 1);
    return [{ type: 'not-op', operand: expr }, newPos];
  }
  return parseComparison(tokens, pos);
}

function parseAnd(tokens: Token[], pos: number): ParseResult {
  let [left, p] = parseNot(tokens, pos);
  while (true) {
    const tok = peekToken(tokens, p);
    if (tok && tok.type === 'identifier' && (tok.value as string).toLowerCase() === 'and') {
      const [right, nextP] = parseNot(tokens, p + 1);
      left = { type: 'and-op', left, right };
      p = nextP;
    } else break;
  }
  return [left, p];
}

function parseOr(tokens: Token[], pos: number): ParseResult {
  let [left, p] = parseAnd(tokens, pos);
  while (true) {
    const tok = peekToken(tokens, p);
    if (tok && tok.type === 'identifier' && (tok.value as string).toLowerCase() === 'or') {
      const [right, nextP] = parseAnd(tokens, p + 1);
      left = { type: 'or-op', left, right };
      p = nextP;
    } else break;
  }
  return [left, p];
}

function parseExpression(tokens: Token[], pos: number): ParseResult {
  return parseOr(tokens, pos);
}

export function parse(tokens: Token[]): AstNode | null {
  if (tokens.length === 0) return null;
  const [ast] = parseExpression(tokens, 0);
  return ast;
}

// ============================================================
// EVALUATOR
// ============================================================

function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  return 0;
}

function toString(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

export function truthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

function compareValues(op: string, left: unknown, right: unknown): number {
  let result: boolean;
  switch (op) {
    case '=': result = left === right; break;
    case '<>': result = left !== right; break;
    case '<': result = toNumber(left) < toNumber(right); break;
    case '>': result = toNumber(left) > toNumber(right); break;
    case '<=': result = toNumber(left) <= toNumber(right); break;
    case '>=': result = toNumber(left) >= toNumber(right); break;
    default: result = false;
  }
  return result ? -1 : 0;
}

// --- Built-in functions ---

function fnIif(args: AstNode[], ctx: ExprContext): unknown {
  return truthy(evaluate(args[0], ctx)) ? evaluate(args[1], ctx) : evaluate(args[2], ctx);
}

function fnNz(args: AstNode[], ctx: ExprContext): unknown {
  const v = evaluate(args[0], ctx);
  return v == null ? (args[1] ? evaluate(args[1], ctx) : 0) : v;
}

function fnNow(): Date { return new Date(); }
function fnDate(): Date { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function formatDateVal(d: Date, fmtLower: string): string {
  switch (fmtLower) {
    case 'short date': return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    case 'long date': return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    case 'medium date': return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    case 'short time': return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    case 'long time': return d.toLocaleTimeString('en-US');
    default: return d.toLocaleDateString();
  }
}

function formatNumberVal(val: number, fmtLower: string): string {
  switch (fmtLower) {
    case 'currency': return `$${val.toFixed(2)}`;
    case 'percent': return `${(val * 100).toFixed(0)}%`;
    case 'fixed': return val.toFixed(2);
    case 'standard': return val.toLocaleString();
    default: return String(val);
  }
}

function fnFormat(args: AstNode[], ctx: ExprContext): unknown {
  const val = evaluate(args[0], ctx);
  const fmt = args[1] ? evaluate(args[1], ctx) : null;
  const fmtLower = fmt ? String(fmt).toLowerCase() : '';
  if (val == null) return '';
  if (val instanceof Date) return formatDateVal(val, fmtLower);
  if (typeof val === 'number') return formatNumberVal(val, fmtLower);
  return String(val);
}

function fnLeft(args: AstNode[], ctx: ExprContext): string {
  const s = toString(evaluate(args[0], ctx));
  const n = toNumber(evaluate(args[1], ctx));
  return s.slice(0, Math.min(Math.floor(n), s.length));
}

function fnRight(args: AstNode[], ctx: ExprContext): string {
  const s = toString(evaluate(args[0], ctx));
  const n = toNumber(evaluate(args[1], ctx));
  return s.slice(Math.max(0, s.length - Math.floor(n)));
}

function fnMid(args: AstNode[], ctx: ExprContext): string {
  const s = toString(evaluate(args[0], ctx));
  const start = Math.floor(toNumber(evaluate(args[1], ctx))) - 1;
  const length = args[2] ? Math.floor(toNumber(evaluate(args[2], ctx))) : undefined;
  const from = Math.max(0, start);
  return length !== undefined ? s.slice(from, Math.min(s.length, from + length)) : s.slice(from);
}

function fnLen(args: AstNode[], ctx: ExprContext): number { return toString(evaluate(args[0], ctx)).length; }
function fnTrim(args: AstNode[], ctx: ExprContext): string { return toString(evaluate(args[0], ctx)).trim(); }
function fnUcase(args: AstNode[], ctx: ExprContext): string { return toString(evaluate(args[0], ctx)).toUpperCase(); }
function fnLcase(args: AstNode[], ctx: ExprContext): string { return toString(evaluate(args[0], ctx)).toLowerCase(); }
function fnInt(args: AstNode[], ctx: ExprContext): number { return Math.floor(toNumber(evaluate(args[0], ctx))); }
function fnAbs(args: AstNode[], ctx: ExprContext): number { return Math.abs(toNumber(evaluate(args[0], ctx))); }
function fnVal(args: AstNode[], ctx: ExprContext): number {
  const n = parseFloat(toString(evaluate(args[0], ctx)));
  return isNaN(n) ? 0 : n;
}

function fnRound(args: AstNode[], ctx: ExprContext): number {
  const val = toNumber(evaluate(args[0], ctx));
  const decPlaces = args[1] ? toNumber(evaluate(args[1], ctx)) : 0;
  const factor = Math.pow(10, decPlaces);
  return Math.round(val * factor) / factor;
}

function fnInstr(args: AstNode[], ctx: ExprContext): number {
  const idx = toString(evaluate(args[0], ctx)).toLowerCase().indexOf(toString(evaluate(args[1], ctx)).toLowerCase());
  return idx >= 0 ? idx + 1 : 0;
}

function fnReplace(args: AstNode[], ctx: ExprContext): string {
  return toString(evaluate(args[0], ctx)).split(toString(evaluate(args[1], ctx))).join(toString(evaluate(args[2], ctx)));
}

function fnIsNull(args: AstNode[], ctx: ExprContext): number {
  return evaluate(args[0], ctx) == null ? -1 : 0;
}

type BuiltinFn = (args: AstNode[], ctx: ExprContext) => unknown;
const BUILTIN_FNS: Record<string, BuiltinFn> = {
  iif: fnIif, nz: fnNz, now: () => fnNow(), date: () => fnDate(), format: fnFormat,
  left: fnLeft, right: fnRight, mid: fnMid, len: fnLen, trim: fnTrim,
  ucase: fnUcase, lcase: fnLcase, int: fnInt, round: fnRound,
  val: fnVal, instr: fnInstr, replace: fnReplace, abs: fnAbs,
  isnull: fnIsNull,
};

// --- Aggregates ---

function evalOverRecords(argAst: AstNode, ctx: ExprContext, records: Record<string, unknown>[]): number[] {
  return records.map(r => toNumber(evaluate(argAst, { ...ctx, record: r })));
}

function evaluateAggregate(aggFn: string, argAst: AstNode, ctx: ExprContext): unknown {
  const records = ctx.groupRecords || ctx.allRecords || [];
  switch (aggFn) {
    case 'count':
      if ((argAst as { value?: unknown }).value === '*') return records.length;
      return records.filter(r => evaluate(argAst, { ...ctx, record: r }) != null).length;
    case 'sum': return evalOverRecords(argAst, ctx, records).reduce((a, b) => a + b, 0);
    case 'avg': {
      if (records.length === 0) return 0;
      return evalOverRecords(argAst, ctx, records).reduce((a, b) => a + b, 0) / records.length;
    }
    case 'min': {
      if (records.length === 0) return null;
      return Math.min(...evalOverRecords(argAst, ctx, records));
    }
    case 'max': {
      if (records.length === 0) return null;
      return Math.max(...evalOverRecords(argAst, ctx, records));
    }
    default: return null;
  }
}

// --- Field ref evaluation ---

function evalFieldRef(nameLower: string, ctx: ExprContext): unknown {
  if (nameLower === 'page') return ctx.page;
  if (nameLower === 'pages') return ctx.pages;
  const record = ctx.record;
  if (!record) return undefined;
  if (nameLower in record) return record[nameLower];
  // Case-insensitive lookup
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === nameLower) return v;
  }
  return undefined;
}

// --- Binary op evaluation ---

function evalBinaryOp(ast: AstNode & { type: 'binary-op' }, ctx: ExprContext): unknown {
  const op = ast.op;
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    return compareValues(op, evaluate(ast.left, ctx), evaluate(ast.right, ctx));
  }
  const l = toNumber(evaluate(ast.left, ctx));
  const r = toNumber(evaluate(ast.right, ctx));
  switch (op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? null : l / r;
    default: return null;
  }
}

export function evaluate(ast: AstNode | null, ctx: ExprContext): unknown {
  if (!ast) return null;
  switch (ast.type) {
    case 'literal': return ast.value;
    case 'string': return ast.value;
    case 'date': return ast.value;
    case 'field-ref': return evalFieldRef(ast.name.toLowerCase(), ctx);
    case 'binary-op': return evalBinaryOp(ast, ctx);
    case 'concat': return toString(evaluate(ast.left, ctx)) + toString(evaluate(ast.right, ctx));
    case 'not-op': return truthy(evaluate(ast.operand, ctx)) ? 0 : -1;
    case 'and-op': return (truthy(evaluate(ast.left, ctx)) && truthy(evaluate(ast.right, ctx))) ? -1 : 0;
    case 'or-op': return (truthy(evaluate(ast.left, ctx)) || truthy(evaluate(ast.right, ctx))) ? -1 : 0;
    case 'call': {
      const handler = BUILTIN_FNS[ast.fn];
      return handler ? handler(ast.args, ctx) : null;
    }
    case 'aggregate': return evaluateAggregate(ast.fn, ast.arg, ctx);
    default: return null;
  }
}

// ============================================================
// PUBLIC API
// ============================================================

const parseCache = new Map<string, AstNode | null>();

function getCachedAst(exprStr: string): AstNode | null {
  const cached = parseCache.get(exprStr);
  if (cached !== undefined) return cached;
  const ast = parse(tokenize(exprStr));
  parseCache.set(exprStr, ast);
  if (parseCache.size > 500) parseCache.clear();
  return ast;
}

/**
 * Evaluate an Access expression string (without leading '=').
 * Returns the computed value, or "#Error" on failure.
 */
export function evaluateExpression(exprString: string, context: ExprContext): unknown {
  try {
    return evaluate(getCachedAst(exprString), context);
  } catch {
    return '#Error';
  }
}

/** Test if a string starts with '=' (Access expression marker). */
export function isExpression(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith('=');
}

// --- Conditional formatting ---

interface CfRule {
  expression?: string;
  Expression?: string;
  'fore-color'?: string;
  'back-color'?: string;
  'font-bold'?: number;
  'font-italic'?: number;
}

function parseCfRules(rules: unknown): CfRule[] | null {
  if (Array.isArray(rules)) return rules;
  if (typeof rules === 'string') {
    try {
      const p = JSON.parse(rules);
      if (Array.isArray(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

function ruleMatches(exprStr: string, ctx: ExprContext): boolean {
  try {
    const r = evaluateExpression(exprStr, ctx);
    return r != null && r !== 0 && r !== false;
  } catch { return false; }
}

function ruleToStyle(rule: CfRule): Record<string, string> {
  const style: Record<string, string> = {};
  if (rule['fore-color']) style.color = rule['fore-color'];
  if (rule['back-color']) style.backgroundColor = rule['back-color'];
  if (rule['font-bold'] === 1) style.fontWeight = 'bold';
  if (rule['font-italic'] === 1) style.fontStyle = 'italic';
  return style;
}

/**
 * Evaluate conditional formatting rules. Returns style object from first match, or null.
 */
export function applyConditionalFormatting(
  ctrl: Record<string, unknown>,
  record: Record<string, unknown>,
  exprContext?: Partial<ExprContext>,
): Record<string, string> | null {
  const rules = parseCfRules(ctrl['conditional-formatting']);
  if (!rules) return null;
  const ctx: ExprContext = { record, ...exprContext };
  for (const rule of rules) {
    const exprStr = rule.expression || rule.Expression;
    if (exprStr && exprStr.trim() && ruleMatches(exprStr, ctx)) {
      return ruleToStyle(rule);
    }
  }
  return null;
}
