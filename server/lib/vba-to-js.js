/**
 * vba-to-js.js — Parse VBA event procedures and generate executable JavaScript.
 *
 * When a form module has VBA source but no pre-extracted intents, this parser
 * reads the VBA directly and produces JS code strings that call the AccessClone
 * runtime API (window.AC). The JS is eval'd client-side and wired to button clicks.
 */

const { toKw } = require('./reactions-extractor');

/**
 * Collect enum member values from VBA source.
 * Parses `Public Enum ... End Enum` blocks and returns a Map of
 * "EnumName.MemberName" → integer value.
 * VBA enums auto-increment from 0 unless explicitly assigned.
 */
function collectEnumValues(vbaSource) {
  const enumMap = new Map();
  if (!vbaSource) return enumMap;

  const lines = vbaSource.split(/\r?\n/);
  let currentEnum = null;
  let nextValue = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Start of enum block
    const enumStart = line.match(/^(?:Public\s+|Private\s+)?Enum\s+(\w+)/i);
    if (enumStart) {
      currentEnum = enumStart[1];
      nextValue = 0;
      continue;
    }

    // End of enum block
    if (currentEnum && /^End\s+Enum$/i.test(line)) {
      currentEnum = null;
      continue;
    }

    // Enum member line
    if (currentEnum) {
      // Skip comments and blank lines
      if (!line || line.startsWith("'")) continue;

      // Match: memberName = value  or  memberName (auto-increment)
      // Strip inline comments first
      const noComment = line.replace(/'.*$/, '').trim();
      const assignMatch = noComment.match(/^(\w+)\s*=\s*(-?\d+)/);
      if (assignMatch) {
        const val = parseInt(assignMatch[2], 10);
        enumMap.set(`${currentEnum}.${assignMatch[1]}`, val);
        enumMap.set(assignMatch[1], val); // bare member name (VBA allows unqualified access)
        nextValue = val + 1;
      } else {
        const nameOnly = noComment.match(/^(\w+)$/);
        if (nameOnly) {
          enumMap.set(`${currentEnum}.${nameOnly[1]}`, nextValue);
          enumMap.set(nameOnly[1], nextValue); // bare member name
          nextValue++;
        }
      }
    }
  }

  return enumMap;
}

/**
 * Parse a generic VBA function call: FuncName(arg1, arg2, ...)
 * Returns { name, args: string[], endIdx } or null if not a function call.
 * Handles nested parens and string literals within arguments.
 */
function parseFunctionCall(expr) {
  const match = expr.match(/^(\w+\$?)\s*\(/);
  if (!match) return null;

  const name = match[1];
  const startIdx = match[0].length;

  // Find matching closing paren, tracking nesting and strings
  let depth = 1;
  let inString = false;
  let i = startIdx;
  for (; i < expr.length && depth > 0; i++) {
    const ch = expr[i];
    if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
  }
  if (depth !== 0) return null;

  const argsStr = expr.substring(startIdx, i - 1);

  // Split arguments on commas, respecting strings and parens
  const args = [];
  let current = '';
  depth = 0;
  inString = false;
  for (const ch of argsStr) {
    if (ch === '"') inString = !inString;
    else if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());

  return { name, args, endIdx: i };
}

/**
 * Translate a VBA expression to JS, recursing into function calls (inside-out).
 * Handles: literals, Me.ctrl, variables, enum values, known function calls,
 * string concatenation (&), and domain aggregates.
 *
 * @param {string} expr - VBA expression
 * @param {Set<string>} [assignedVars]
 * @param {Map<string,number>} [enumMap]
 * @param {Set<string>} [fnRegistry] - Known fn.* procedure names (lowercase)
 * @returns {string|null} JS expression or null if untranslatable
 */
/**
 * Find the index of the first comma at the top level (outside parens and strings).
 * Returns -1 if none found.
 */
function findTopLevelComma(s) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

/**
 * Split a condition string on a keyword (And/Or), respecting parens and strings.
 * Returns array of parts or null if keyword not found at top level.
 */
function splitOnKeyword(cond, keyword) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inString = false;
  const kwLower = keyword.toLowerCase();
  const kwLen = keyword.length;

  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i];
    if (ch === '"') { inString = !inString; current += ch; continue; }
    if (inString) { current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }

    // Check for keyword at top level with word boundaries (whitespace on both sides)
    if (depth === 0 && i > 0 && /\s/.test(cond[i - 1])) {
      const ahead = cond.substring(i, i + kwLen);
      if (ahead.toLowerCase() === kwLower && i + kwLen < cond.length && /\s/.test(cond[i + kwLen])) {
        parts.push(current);
        current = '';
        i += kwLen; // skip keyword (loop will advance past the trailing space)
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.length >= 2 ? parts : null;
}

function translateExpression(expr, assignedVars, enumMap, fnRegistry) {
  if (!expr) return null;
  const s = expr.trim();

  // String literal
  if (/^"[^"]*"$/.test(s)) return s;

  // Numeric literal
  if (/^\d+(\.\d+)?$/.test(s)) return s;

  // Boolean literals
  if (/^True$/i.test(s)) return 'true';
  if (/^False$/i.test(s)) return 'false';

  // Me.OpenArgs
  if (/^Me\.OpenArgs$/i.test(s)) return 'AC.getOpenArgs()';

  // TempVars
  const tvMatch = s.match(/^TempVars[!.](\w+)$/i) || s.match(/^TempVars\s*\(\s*"([^"]+)"\s*\)$/i);
  if (tvMatch) return `AC.getTempVar(${JSON.stringify(tvMatch[1])})`;

  // Me.ControlName
  const meCtrl = s.match(/^Me\.(\w+)$/i);
  if (meCtrl) {
    const name = meCtrl[1];
    if (/^(Name|Caption|RecordSource|Filter|OrderBy|Section|Hwnd|HasModule|CurrentView|DefaultView)$/i.test(name)) {
      return null;
    }
    return `AC.getValue(${JSON.stringify(name)})`;
  }

  // Known variable
  if (/^\w+$/.test(s) && assignedVars && assignedVars.has(s.toLowerCase())) {
    return s;
  }

  // Enum value (qualified EnumName.Member or bare member name)
  if (enumMap && enumMap.has(s)) {
    return String(enumMap.get(s));
  }

  // String concatenation with & — split and recurse
  // Only split on & that's not inside parens or strings
  const concatParts = splitOnOperator(s, '&');
  if (concatParts && concatParts.length >= 2) {
    const jsParts = [];
    for (const part of concatParts) {
      const translated = translateExpression(part.trim(), assignedVars, enumMap, fnRegistry);
      if (translated === null) return null;
      jsParts.push(translated);
    }
    return jsParts.join(' + ');
  }

  // Domain aggregate: DCount/DLookup/DMin/DMax/DSum
  if (/^(DCount|DLookup|DMin|DMax|DSum)\s*\(/i.test(s)) {
    const result = translateDomainCall(s, assignedVars, enumMap, fnRegistry);
    if (result) return result.js;
  }

  // Function call — parse once, check builtins then fnRegistry
  const funcCall = parseFunctionCall(s);
  if (funcCall && funcCall.endIdx >= s.length) {
    // Translate arguments recursively (shared by builtins and fnRegistry)
    const jsArgs = [];
    let allArgsOk = true;
    for (const arg of funcCall.args) {
      const translated = translateExpression(arg, assignedVars, enumMap, fnRegistry);
      if (translated === null) { allArgsOk = false; break; }
      jsArgs.push(translated);
    }

    // VBA built-in function (Nz, Replace, Left$, UBound, etc.)
    if (allArgsOk) {
      const builtinFn = VBA_BUILTINS.get(funcCall.name.toLowerCase());
      if (builtinFn) {
        const result = builtinFn(jsArgs);
        if (result !== null) return result;
      }
    }

    // fn.* registry function call
    if (allArgsOk && fnRegistry && fnRegistry.has(funcCall.name.toLowerCase())) {
      return `await AC.callFn(${JSON.stringify(funcCall.name)}, ${jsArgs.join(', ')})`;
    }
  }

  // Bare function name without parens (VBA allows parameterless calls without ())
  if (/^\w+$/.test(s) && fnRegistry && fnRegistry.has(s.toLowerCase())) {
    return `await AC.callFn(${JSON.stringify(s)})`;
  }

  return null;
}

/**
 * Split a VBA expression on a given operator, respecting parens and strings.
 * Returns array of parts or null if operator not found at top level.
 */
function splitOnOperator(expr, op) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"') {
      inString = !inString;
      current += ch;
    } else if (inString) {
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (depth === 0 && ch === op && (op !== '&' || expr[i+1] !== '&')) {
      // For &, make sure it's not && (though VBA doesn't have &&, be safe)
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);

  return parts.length >= 2 ? parts : null;
}

/**
 * Map of VBA built-in functions to JS translation functions.
 * Each entry takes an array of already-translated JS argument strings
 * and returns a JS expression string, or null if args are insufficient.
 */
const VBA_BUILTINS = new Map([
  // String functions
  ['replace', (args) => args.length >= 3 ? `${args[0]}.replaceAll(${args[1]}, ${args[2]})` : null],
  ['left', (args) => args.length >= 2 ? `${args[0]}.substring(0, ${args[1]})` : null],
  ['left$', (args) => args.length >= 2 ? `${args[0]}.substring(0, ${args[1]})` : null],
  ['right', (args) => args.length >= 2 ? `${args[0]}.slice(-${args[1]})` : null],
  ['right$', (args) => args.length >= 2 ? `${args[0]}.slice(-${args[1]})` : null],
  ['mid', (args) => {
    if (args.length >= 3) return `${args[0]}.substring(${args[1]} - 1, ${args[1]} - 1 + ${args[2]})`;
    if (args.length >= 2) return `${args[0]}.substring(${args[1]} - 1)`;
    return null;
  }],
  ['mid$', (args) => {
    if (args.length >= 3) return `${args[0]}.substring(${args[1]} - 1, ${args[1]} - 1 + ${args[2]})`;
    if (args.length >= 2) return `${args[0]}.substring(${args[1]} - 1)`;
    return null;
  }],
  ['len', (args) => args.length >= 1 ? `${args[0]}.length` : null],
  ['instr', (args) => {
    // VBA InStr: 2-arg = InStr(string, find), 3-arg = InStr(start, string, find) — 1-based
    if (args.length === 2) return `(${args[0]}.indexOf(${args[1]}) + 1)`;
    if (args.length >= 3) return `(${args[1]}.indexOf(${args[2]}, ${args[0]} - 1) + 1)`;
    return null;
  }],
  ['split', (args) => args.length >= 2 ? `${args[0]}.split(${args[1]})` : null],
  ['trim', (args) => args.length >= 1 ? `${args[0]}.trim()` : null],
  ['trim$', (args) => args.length >= 1 ? `${args[0]}.trim()` : null],
  ['ltrim', (args) => args.length >= 1 ? `${args[0]}.trimStart()` : null],
  ['ltrim$', (args) => args.length >= 1 ? `${args[0]}.trimStart()` : null],
  ['rtrim', (args) => args.length >= 1 ? `${args[0]}.trimEnd()` : null],
  ['rtrim$', (args) => args.length >= 1 ? `${args[0]}.trimEnd()` : null],
  ['lcase', (args) => args.length >= 1 ? `${args[0]}.toLowerCase()` : null],
  ['lcase$', (args) => args.length >= 1 ? `${args[0]}.toLowerCase()` : null],
  ['ucase', (args) => args.length >= 1 ? `${args[0]}.toUpperCase()` : null],
  ['ucase$', (args) => args.length >= 1 ? `${args[0]}.toUpperCase()` : null],
  ['string', (args) => args.length >= 2 ? `${args[1]}.repeat(${args[0]})` : null],
  ['space', (args) => args.length >= 1 ? `" ".repeat(${args[0]})` : null],
  // Type conversion
  ['str', (args) => args.length >= 1 ? `String(${args[0]})` : null],
  ['str$', (args) => args.length >= 1 ? `String(${args[0]})` : null],
  ['cstr', (args) => args.length >= 1 ? `String(${args[0]})` : null],
  ['cint', (args) => args.length >= 1 ? `parseInt(${args[0]})` : null],
  ['clng', (args) => args.length >= 1 ? `parseInt(${args[0]})` : null],
  ['cdbl', (args) => args.length >= 1 ? `parseFloat(${args[0]})` : null],
  ['csng', (args) => args.length >= 1 ? `parseFloat(${args[0]})` : null],
  ['cbool', (args) => args.length >= 1 ? `Boolean(${args[0]})` : null],
  ['asc', (args) => args.length >= 1 ? `${args[0]}.charCodeAt(0)` : null],
  ['chr', (args) => args.length >= 1 ? `String.fromCharCode(${args[0]})` : null],
  ['chr$', (args) => args.length >= 1 ? `String.fromCharCode(${args[0]})` : null],
  // Array functions
  ['ubound', (args) => args.length >= 1 ? `(${args[0]}.length - 1)` : null],
  ['lbound', (_args) => '0'],
  ['isarray', (args) => args.length >= 1 ? `Array.isArray(${args[0]})` : null],
  // Math
  ['abs', (args) => args.length >= 1 ? `Math.abs(${args[0]})` : null],
  ['int', (args) => args.length >= 1 ? `Math.floor(${args[0]})` : null],
  ['fix', (args) => args.length >= 1 ? `Math.trunc(${args[0]})` : null],
  // Nz → AC runtime
  ['nz', (args) => {
    if (args.length >= 2) return `AC.nz(${args[0]}, ${args[1]})`;
    if (args.length >= 1) return `AC.nz(${args[0]})`;
    return null;
  }],
]);

// Map VBA event suffixes to our event keys
const EVENT_MAP = {
  'click': 'on-click',
  'dblclick': 'on-dblclick',
  'load': 'on-load',
  'open': 'on-open',
  'close': 'on-close',
  'current': 'on-current',
  'afterupdate': 'after-update',
  'beforeupdate': 'before-update',
  'change': 'on-change',
  'enter': 'on-enter',
  'exit': 'on-exit',
  'gotfocus': 'on-gotfocus',
  'lostfocus': 'on-lostfocus',
  'nodata': 'on-no-data',
  'activate': 'on-activate',
  'deactivate': 'on-deactivate',
  'print': 'on-print',
  'format': 'on-format',
  'retreat': 'on-retreat',
  'page': 'on-page',
};

/**
 * Collect module-level variable names from VBA source.
 * These are Dim/Private/Public declarations outside of Sub/Function bodies.
 * Also collects Const declarations (treated as known variables).
 * Returns a Set of lowercase variable names.
 */
function collectModuleVars(vbaSource) {
  const vars = new Set();
  const lines = vbaSource.split(/\r?\n/);
  let inProc = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Track procedure boundaries
    if (/^(?:Private\s+|Public\s+)?(?:Static\s+)?(?:Sub|Function)\s+\w+\s*\(/i.test(line)) {
      inProc = true;
      continue;
    }
    if (/^End\s+(?:Sub|Function)$/i.test(line)) {
      inProc = false;
      continue;
    }
    if (inProc) continue;

    // Const declarations (check before Dim/Private/Public to avoid false match)
    const constMatch = line.match(/^(?:Private\s+|Public\s+)?Const\s+(\w+)/i);
    if (constMatch) {
      vars.add(constMatch[1].toLowerCase());
      continue;
    }

    // Dim/Private/Public varName As Type  (possibly multiple on one line with commas)
    const declMatch = line.match(/^(?:Dim|Private|Public)\s+(.+)$/i);
    if (declMatch) {
      const parts = declMatch[1].split(',');
      for (const part of parts) {
        const nameMatch = part.trim().match(/^(\w+)/);
        if (nameMatch) {
          vars.add(nameMatch[1].toLowerCase());
        }
      }
    }
  }

  return vars;
}

/**
 * Extract Sub/Function procedures from VBA source.
 * Returns [{name, body}] where body is the lines between Sub...End Sub.
 */
function extractProcedures(vbaSource) {
  const procedures = [];
  const lines = vbaSource.split(/\r?\n/);
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Match: Private Sub/Function cmdClose_Click() or Public Function StringFormatSQL(...)
    const procMatch = line.match(/^(?:Private\s+|Public\s+)?(?:Static\s+)?(Sub|Function)\s+(\w+)\s*\(([^)]*)\)/i);
    if (procMatch && !current) {
      // Extract parameter names from signature
      const params = [];
      if (procMatch[3]) {
        for (const param of procMatch[3].split(',')) {
          const pMatch = param.trim().match(/^(?:Optional\s+)?(?:ByVal\s+|ByRef\s+)?(?:ParamArray\s+)?(\w+)/i);
          if (pMatch) params.push(pMatch[1]);
        }
      }
      current = { name: procMatch[2], kind: procMatch[1].toLowerCase(), bodyLines: [], params };
      continue;
    }

    if (current && new RegExp('^End\\s+' + current.kind + '$', 'i').test(line)) {
      procedures.push({ name: current.name, body: current.bodyLines.join('\n'), kind: current.kind, params: current.params });
      current = null;
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
    }
  }

  return procedures;
}

/**
 * Strip VBA boilerplate from procedure body:
 * - Line continuations (trailing _ merges next line)
 * - Line numbers (10, 20, 30...)
 * - On Error GoTo / Resume / Exit Sub
 * - Error handler blocks (Err_Handler: ... End Sub)
 * - Labels (Exit_Handler:, Err_Handler:)
 * Returns cleaned lines (only the meaningful statements).
 */
function stripBoilerplate(body) {
  const rawLines = body.split(/\r?\n/);

  // Phase 1: merge line continuations (trailing " _")
  const merged = [];
  let accumulator = '';
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (trimmed.endsWith(' _') || trimmed.endsWith('\t_')) {
      // Strip trailing _ and accumulate
      accumulator += (accumulator ? ' ' : '') + trimmed.slice(0, -1).trimEnd();
    } else {
      if (accumulator) {
        accumulator += (accumulator ? ' ' : '') + trimmed;
        merged.push(accumulator);
        accumulator = '';
      } else {
        merged.push(trimmed);
      }
    }
  }
  if (accumulator) merged.push(accumulator);

  // Phase 2: strip boilerplate
  const cleaned = [];
  let inErrorHandler = false;

  for (let line of merged) {
    // Strip line numbers
    line = line.replace(/^\d+\s+/, '');

    // Skip empty lines
    if (!line) continue;

    // Skip VBA comments
    if (line.startsWith("'")) continue;

    // Skip On Error GoTo
    if (/^On\s+Error\s+/i.test(line)) continue;

    // Skip Exit Sub/Function
    if (/^Exit\s+(Sub|Function)/i.test(line)) continue;

    // Skip Resume statements
    if (/^Resume\s+/i.test(line)) continue;

    // Detect error handler label — skip everything after
    if (/^Err_Handler:/i.test(line) || /^Err_\w+:/i.test(line)) {
      inErrorHandler = true;
      continue;
    }

    // Skip other labels (Exit_Handler:, etc.)
    if (/^\w+:$/.test(line)) continue;

    if (inErrorHandler) continue;

    cleaned.push(line);
  }

  return cleaned;
}

/**
 * Translate a VBA criteria string (the third argument to DCount/DLookup/etc.)
 * into a JS expression that builds a SQL WHERE clause at runtime.
 *
 * Common patterns:
 *   "OrderID = " & Me.OrderID        → "OrderID = " + AC.getValue("OrderID")
 *   "ProductID = " & Me.ProductID    → "ProductID = " + AC.getValue("ProductID")
 *   strWhere  (variable)             → strWhere
 *   "StatusID = 1"  (plain string)   → "StatusID = 1"
 *
 * Returns a JS expression string or null if the criteria is too complex.
 */
function translateCriteria(criteriaStr, assignedVars, enumMap, fnRegistry) {
  if (!criteriaStr) return undefined; // no criteria → omit argument
  const s = criteriaStr.trim();

  // Plain string literal: "FieldName = 123"
  if (/^"[^"]*"$/.test(s)) return s;

  // Single variable reference
  if (/^\w+$/.test(s)) {
    if (assignedVars && assignedVars.has(s.toLowerCase())) return s;
    return null;
  }

  // String concatenation with & — use paren-aware splitter and recursive translation
  const concatParts = splitOnOperator(s, '&');
  if (concatParts && concatParts.length >= 2) {
    const jsParts = [];
    for (const part of concatParts) {
      const p = part.trim();
      if (!p) continue;
      // Recursively translate each part (handles function calls, Me.ctrl, literals, etc.)
      const translated = translateExpression(p, assignedVars, enumMap, fnRegistry);
      if (translated === null) return null;
      jsParts.push(translated);
    }
    return jsParts.join(' + ');
  }

  // Fallback: try translateExpression for function calls, etc.
  const exprResult = translateExpression(s, assignedVars, enumMap, fnRegistry);
  if (exprResult !== null) return exprResult;

  return null;
}

/**
 * Parse a VBA domain aggregate function call: DCount("expr", "domain"[, criteria])
 * Returns { func, expr, domain, criteria } or null if not parseable.
 * Handles nested parens and string concatenation in the criteria argument.
 */
function parseDomainCall(vbaExpr) {
  const match = vbaExpr.match(/^(DCount|DLookup|DMin|DMax|DSum)\s*\(/i);
  if (!match) return null;

  const func = match[1];
  const startIdx = match[0].length;

  // Find the matching closing paren, tracking nesting and string literals
  let depth = 1;
  let inString = false;
  let i = startIdx;
  for (; i < vbaExpr.length && depth > 0; i++) {
    const ch = vbaExpr[i];
    if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
  }
  if (depth !== 0) return null;

  const argsStr = vbaExpr.substring(startIdx, i - 1);
  const endIdx = i; // position after closing paren

  // Split arguments on commas, respecting strings and parens
  const args = [];
  let current = '';
  depth = 0;
  inString = false;
  for (const ch of argsStr) {
    if (ch === '"') inString = !inString;
    else if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  args.push(current.trim());

  if (args.length < 2) return null;

  // First arg: expression (typically a string literal like "*" or "FieldName")
  const expr = args[0];
  // Second arg: domain (table/query name, string literal)
  const domain = args[1];
  // Third arg (optional): criteria
  const criteria = args.length >= 3 ? args[2] : null;

  // expr and domain should be string literals
  const exprMatch = expr.match(/^"([^"]*)"$/);
  const domainMatch = domain.match(/^"([^"]*)"$/);
  if (!exprMatch || !domainMatch) return null;

  return {
    func: func,
    expr: exprMatch[1],
    domain: domainMatch[1],
    criteria: criteria,
    endIdx: endIdx,
    fullMatch: vbaExpr.substring(0, endIdx),
  };
}

/**
 * Translate a VBA domain aggregate call (DCount, DLookup, etc.) to a JS expression.
 * Returns a JS expression string or null if untranslatable.
 */
function translateDomainCall(vbaExpr, assignedVars, enumMap, fnRegistry) {
  const parsed = parseDomainCall(vbaExpr);
  if (!parsed) return null;

  const funcName = parsed.func.charAt(0).toLowerCase() + parsed.func.slice(1); // DCount → dCount
  const jsExpr = JSON.stringify(parsed.expr);
  const jsDomain = JSON.stringify(parsed.domain);

  if (parsed.criteria) {
    const jsCriteria = translateCriteria(parsed.criteria, assignedVars, enumMap, fnRegistry);
    if (jsCriteria === null) return null; // can't translate criteria
    return { js: `await AC.${funcName}(${jsExpr}, ${jsDomain}, ${jsCriteria})`, endIdx: parsed.endIdx };
  }

  return { js: `await AC.${funcName}(${jsExpr}, ${jsDomain})`, endIdx: parsed.endIdx };
}

/**
 * Translate the right-hand side of a VBA variable assignment to JS.
 * Returns a JS expression string or null if untranslatable.
 * @param {string} rhs - The RHS of the assignment (already trimmed)
 * @param {Set<string>} [assignedVars]
 * @param {Map<string,number>} [enumMap]
 * @param {Set<string>} [fnRegistry] - Known fn.* procedure names (lowercase)
 */
function translateAssignmentRHS(rhs, assignedVars, enumMap, fnRegistry) {
  if (!rhs) return null;
  const s = rhs.trim();

  // String literal: "text"
  if (/^"[^"]*"$/.test(s)) return s;

  // Numeric literal: 123, 3.14
  if (/^\d+(\.\d+)?$/.test(s)) return s;

  // Boolean literals
  if (/^True$/i.test(s)) return 'true';
  if (/^False$/i.test(s)) return 'false';

  // Me.OpenArgs
  if (/^Me\.OpenArgs$/i.test(s)) return 'AC.getOpenArgs()';

  // TempVars!Name or TempVars("Name")
  const tvRhsMatch = s.match(/^TempVars[!.](\w+)$/i) || s.match(/^TempVars\s*\(\s*"([^"]+)"\s*\)$/i);
  if (tvRhsMatch) return `AC.getTempVar(${JSON.stringify(tvRhsMatch[1])})`;

  // Me.ControlName (simple property read — value)
  const meCtrl = s.match(/^Me\.(\w+)$/i);
  if (meCtrl) {
    const name = meCtrl[1];
    // Skip known non-control properties
    if (/^(Name|Caption|RecordSource|Filter|OrderBy|Section|Hwnd|HasModule|CurrentView|DefaultView)$/i.test(name)) {
      return null;
    }
    return `AC.getValue(${JSON.stringify(name)})`;
  }

  // Nz(inner, default) — use paren-aware parsing for nested calls like Nz(DLookup(...), "")
  if (/^Nz\s*\(/i.test(s)) {
    const nzCall = parseFunctionCall(s);
    if (nzCall && nzCall.endIdx >= s.length && nzCall.args.length >= 1) {
      const inner = translateAssignmentRHS(nzCall.args[0].trim(), assignedVars, enumMap, fnRegistry);
      if (!inner) return null;
      if (nzCall.args.length >= 2) {
        const def = translateAssignmentRHS(nzCall.args[1].trim(), assignedVars, enumMap, fnRegistry);
        if (!def) return null;
        return `AC.nz(${inner}, ${def})`;
      }
      return `AC.nz(${inner})`;
    }
  }

  // Domain aggregate: DCount(...), DLookup(...), DMin(...), DMax(...), DSum(...)
  if (/^(DCount|DLookup|DMin|DMax|DSum)\s*\(/i.test(s)) {
    const result = translateDomainCall(s, assignedVars, enumMap, fnRegistry);
    if (result) return result.js;
  }

  // Fallback: try translateExpression for function calls, concatenation, variables, etc.
  const exprResult = translateExpression(s, assignedVars, enumMap, fnRegistry);
  if (exprResult !== null) return exprResult;

  // Anything else — untranslatable
  return null;
}

/**
 * Translate a single VBA statement to a JS expression calling AC.*.
 * Returns a JS string or null if unrecognized.
 * @param {string} stmt - VBA statement
 * @param {string} [formName] - Form name derived from module (e.g. "frmAbout" from "Form_frmAbout")
 * @param {Map<string,number>} [enumMap] - Enum member → integer value map
 * @param {Set<string>} [assignedVars] - Variables with translatable assignments
 * @param {Set<string>} [fnRegistry] - Known fn.* procedure names (lowercase)
 */
function translateStatement(stmt, formName, enumMap, assignedVars, fnRegistry) {
  // DoCmd.Close acForm, "formName", acSaveNo  or  DoCmd.Close
  const closeFormMatch = stmt.match(/^DoCmd\.Close\s+acForm\s*,\s*"([^"]+)"/i);
  if (closeFormMatch) {
    return `AC.closeForm(${JSON.stringify(closeFormMatch[1])})`;
  }
  if (/^DoCmd\.Close\b/i.test(stmt)) {
    return formName ? `AC.closeForm(${JSON.stringify(formName)})` : 'AC.closeForm()';
  }

  // DoCmd.OpenForm "FormName" [, ...args]
  const openFormMatch = stmt.match(/^DoCmd\.OpenForm\s+"([^"]+)"(.*)$/i);
  if (openFormMatch) {
    const formName = openFormMatch[1];
    const rest = openFormMatch[2].trim();

    // Check for where condition: , , , "filter"  or  , acNormal, , "filter"
    const whereMatch = rest.match(/,\s*(?:acNormal|acDesign|acPreview|acFormDS|acFormPivotChart|acFormPivotTable|[^,]*)?\s*,\s*(?:[^,]*)?\s*,\s*"([^"]+)"/i);
    if (whereMatch) {
      return `AC.openForm(${JSON.stringify(formName)}, ${JSON.stringify(whereMatch[1])})`;
    }
    return `AC.openForm(${JSON.stringify(formName)})`;
  }

  // DoCmd.OpenReport "ReportName"
  const openReportMatch = stmt.match(/^DoCmd\.OpenReport\s+"([^"]+)"/i);
  if (openReportMatch) {
    return `AC.openReport(${JSON.stringify(openReportMatch[1])})`;
  }

  // DoCmd.GoToRecord , , acNewRec
  if (/^DoCmd\.GoToRecord\b.*acNewRec/i.test(stmt)) {
    return 'AC.gotoRecord("new")';
  }
  if (/^DoCmd\.GoToRecord\b.*acFirst/i.test(stmt)) {
    return 'AC.gotoRecord("first")';
  }
  if (/^DoCmd\.GoToRecord\b.*acLast/i.test(stmt)) {
    return 'AC.gotoRecord("last")';
  }
  if (/^DoCmd\.GoToRecord\b.*acNext/i.test(stmt)) {
    return 'AC.gotoRecord("next")';
  }
  if (/^DoCmd\.GoToRecord\b.*acPrevious/i.test(stmt)) {
    return 'AC.gotoRecord("previous")';
  }

  // DoCmd.RunSQL "sql" or DoCmd.RunSQL variable
  const runSqlMatch = stmt.match(/^DoCmd\.RunSQL\s+"([^"]+)"/i);
  if (runSqlMatch) {
    return `AC.runSQL(${JSON.stringify(runSqlMatch[1])})`;
  }
  const runSqlVarMatch = stmt.match(/^DoCmd\.RunSQL\s+(\w+)/i);
  if (runSqlVarMatch && assignedVars && assignedVars.has(runSqlVarMatch[1].toLowerCase())) {
    return `AC.runSQL(${runSqlVarMatch[1]})`;
  }

  // g_dbApp().Execute / CurrentDb.Execute / CurrentDb().Execute — SQL execution
  const dbExecMatch = stmt.match(/^(?:g_dbApp\(\)|CurrentDb(?:\(\))?|db)\.Execute\s+(\w+)/i);
  if (dbExecMatch && assignedVars && assignedVars.has(dbExecMatch[1].toLowerCase())) {
    return `AC.runSQL(${dbExecMatch[1]})`;
  }

  // DoCmd.Quit
  if (/^DoCmd\.Quit\b/i.test(stmt)) {
    return formName ? `AC.closeForm(${JSON.stringify(formName)})` : 'AC.closeForm()';
  }

  // DoCmd.Requery
  if (/^DoCmd\.Requery\b/i.test(stmt)) {
    return 'AC.requery()';
  }

  // DoCmd.Save
  if (/^DoCmd\.Save\b/i.test(stmt)) {
    return 'AC.saveRecord()';
  }

  // DoCmd.RunCommand acCmdSaveRecord
  if (/^DoCmd\.RunCommand\s+acCmdSaveRecord/i.test(stmt)) {
    return 'AC.saveRecord()';
  }

  // MsgBox — multiple patterns
  // MsgBox "text", vbExclamation/etc. → alert("text") (strip icon arg)
  const msgBoxIconMatch = stmt.match(/^MsgBox\s+"([^"]+)"\s*,\s*(?:vb\w+)/i);
  if (msgBoxIconMatch) {
    return `alert(${JSON.stringify(msgBoxIconMatch[1])})`;
  }
  // MsgBox "text"
  const msgBoxMatch = stmt.match(/^MsgBox\s+"([^"]+)"\s*$/i);
  if (msgBoxMatch) {
    return `alert(${JSON.stringify(msgBoxMatch[1])})`;
  }
  // MsgBox variable (where variable is in assignedVars)
  const msgBoxVarMatch = stmt.match(/^MsgBox\s+(\w+)\s*$/i);
  if (msgBoxVarMatch && assignedVars && assignedVars.has(msgBoxVarMatch[1].toLowerCase())) {
    return `alert(${msgBoxVarMatch[1]})`;
  }
  // MsgBox general — use translateExpression for first arg, strip icon/button args
  const msgBoxGeneralMatch = stmt.match(/^MsgBox\s+(.+)$/i);
  if (msgBoxGeneralMatch) {
    let msgExpr = msgBoxGeneralMatch[1].trim();
    // Strip trailing comma + vb* icon/button constants (e.g. ", vbExclamation")
    // Use paren-aware split to find the first top-level comma
    const topCommaIdx = findTopLevelComma(msgExpr);
    if (topCommaIdx >= 0) {
      msgExpr = msgExpr.substring(0, topCommaIdx).trim();
    }
    const translated = translateExpression(msgExpr, assignedVars, enumMap, fnRegistry);
    if (translated) {
      return `alert(${translated})`;
    }
  }

  // Me.Requery
  if (/^Me\.Requery\b/i.test(stmt)) {
    return 'AC.requery()';
  }

  // Me.Refresh
  if (/^Me\.Refresh\b/i.test(stmt)) {
    return 'AC.requery()';
  }

  // Me.Undo
  if (/^Me\.Undo\b/i.test(stmt)) {
    return 'AC.undo()';
  }

  // Me.ctrl.SetFocus
  const setFocusMatch = stmt.match(/^Me\.(\w+)\.SetFocus\s*$/i);
  if (setFocusMatch) {
    return `AC.setFocus(${JSON.stringify(setFocusMatch[1])})`;
  }

  // Me.ctrl.Undo — revert control value
  const undoCtrlMatch = stmt.match(/^Me\.(\w+)\.Undo\s*$/i);
  if (undoCtrlMatch) {
    return `AC.undo()`;
  }

  // Me.ctrl.Requery
  const reqCtrlMatch = stmt.match(/^Me\.(\w+)\.Requery\s*$/i);
  if (reqCtrlMatch) {
    return `AC.requeryControl(${JSON.stringify(reqCtrlMatch[1])})`;
  }

  // Me.controlName.Visible = True/False
  const visMatch = stmt.match(/^Me\.(\w+)\.Visible\s*=\s*(True|False|-1|0)\b/i);
  if (visMatch) {
    const val = /true|-1/i.test(visMatch[2]);
    return `AC.setVisible(${JSON.stringify(visMatch[1])}, ${val})`;
  }

  // Me.controlName.Enabled = True/False
  const enMatch = stmt.match(/^Me\.(\w+)\.Enabled\s*=\s*(True|False|-1|0)\b/i);
  if (enMatch) {
    const val = /true|-1/i.test(enMatch[2]);
    return `AC.setEnabled(${JSON.stringify(enMatch[1])}, ${val})`;
  }

  // controlName.SourceObject = "subformName" (subform source swap)
  const srcObjMatch = stmt.match(/^(?:Me\.)?(\w+)\.SourceObject\s*=\s*"([^"]+)"/i);
  if (srcObjMatch) {
    return `AC.setSubformSource(${JSON.stringify(srcObjMatch[1])}, ${JSON.stringify(srcObjMatch[2])})`;
  }

  // Me.Caption = expr (form caption — must be before generic controlName.Caption)
  const formCaptionMatch = stmt.match(/^Me\.Caption\s*=\s*(.+)$/i);
  if (formCaptionMatch) {
    const raw = formCaptionMatch[1].trim();
    if (/^"[^"]*"$/.test(raw)) {
      return `AC.setFormCaption(${raw})`;
    }
    if (/^\w+$/.test(raw) && assignedVars && assignedVars.has(raw.toLowerCase())) {
      return `AC.setFormCaption(${raw})`;
    }
    return null;
  }

  // controlName.Caption = "text"
  const captionMatch = stmt.match(/^(?:Me\.)?(\w+)\.Caption\s*=\s*"([^"]+)"/i);
  if (captionMatch) {
    return `AC.setValue(${JSON.stringify(captionMatch[1])}, ${JSON.stringify(captionMatch[2])})`;
  }

  // TempVars("Name").Value = value  (set TempVar via .Value property)
  const tvValueSetMatch = stmt.match(/^TempVars[!.](\w+)\.Value\s*=\s*(.+)$/i)
    || stmt.match(/^TempVars\s*\(\s*"([^"]+)"\s*\)\.Value\s*=\s*(.+)$/i);
  if (tvValueSetMatch) {
    const tvName = tvValueSetMatch[1];
    const raw = tvValueSetMatch[2].trim();
    const rhs = translateAssignmentRHS(raw, assignedVars, enumMap, fnRegistry);
    if (rhs !== null) {
      return `AC.setTempVar(${JSON.stringify(tvName)}, ${rhs})`;
    }
    return `AC.setTempVar(${JSON.stringify(tvName)}, ${JSON.stringify(raw)})`;
  }

  // TempVars!Name = value  (set TempVar)
  const tvSetMatch = stmt.match(/^TempVars[!.](\w+)\s*=\s*(.+)$/i)
    || stmt.match(/^TempVars\s*\(\s*"([^"]+)"\s*\)\s*=\s*(.+)$/i);
  if (tvSetMatch) {
    const tvName = tvSetMatch[1];
    const raw = tvSetMatch[2].trim();
    const rhs = translateAssignmentRHS(raw, assignedVars, enumMap, fnRegistry);
    if (rhs !== null) {
      return `AC.setTempVar(${JSON.stringify(tvName)}, ${rhs})`;
    }
    return `AC.setTempVar(${JSON.stringify(tvName)}, ${JSON.stringify(raw)})`;
  }

  // Cancel = True → return false (event cancellation)
  if (/^Cancel\s*=\s*True$/i.test(stmt)) {
    return 'return false';
  }

  // Me.Dirty = False → save the current record
  if (/^Me\.Dirty\s*=\s*False$/i.test(stmt)) {
    return 'await AC.saveRecord()';
  }

  // Me.RecordSource = "..." or Me.RecordSource = variable
  const recSrcMatch = stmt.match(/^Me\.RecordSource\s*=\s*(.+)$/i);
  if (recSrcMatch) {
    const raw = recSrcMatch[1].trim();
    if (/^"[^"]*"$/.test(raw)) {
      return `AC.setRecordSource(${raw})`;
    }
    if (/^\w+$/.test(raw) && assignedVars && assignedVars.has(raw.toLowerCase())) {
      return `AC.setRecordSource(${raw})`;
    }
    return null;
  }

  // Me.Filter = "..."
  const filterMatch = stmt.match(/^Me\.Filter\s*=\s*(.+)$/i);
  if (filterMatch) {
    const raw = filterMatch[1].trim();
    if (/^"[^"]*"$/.test(raw)) {
      return `AC.setFilter(${raw})`;
    }
    if (/^\w+$/.test(raw) && assignedVars && assignedVars.has(raw.toLowerCase())) {
      return `AC.setFilter(${raw})`;
    }
    return null;
  }

  // Me.FilterOn = True/False
  if (/^Me\.FilterOn\s*=\s*True$/i.test(stmt)) {
    return 'AC.setFilterOn(true)';
  }
  if (/^Me\.FilterOn\s*=\s*False$/i.test(stmt)) {
    return 'AC.setFilterOn(false)';
  }

  // Me.controlName = value  (set control value)
  const setValMatch = stmt.match(/^Me\.(\w+)\s*=\s*(.+)$/i);
  if (setValMatch) {
    const ctrl = setValMatch[1];
    const raw = setValMatch[2].trim();
    if (/^"/.test(raw)) {
      return `AC.setValue(${JSON.stringify(ctrl)}, ${raw})`;
    }
    if (/^(True|False)$/i.test(raw)) {
      return `AC.setValue(${JSON.stringify(ctrl)}, ${raw.toLowerCase() === 'true'})`;
    }
    if (/^\d+$/.test(raw)) {
      return `AC.setValue(${JSON.stringify(ctrl)}, ${raw})`;
    }
    // Enum value: Me.StatusID = enumOrderStatus.osClosed → AC.setValue("StatusID", 1)
    if (enumMap && enumMap.has(raw)) {
      return `AC.setValue(${JSON.stringify(ctrl)}, ${enumMap.get(raw)})`;
    }
    // Variable reference: Me.ctrl = someVar
    if (/^\w+$/.test(raw) && assignedVars && assignedVars.has(raw.toLowerCase())) {
      return `AC.setValue(${JSON.stringify(ctrl)}, ${raw})`;
    }
    // Fallback: try translateAssignmentRHS for complex expressions (DLookup, Nz, etc.)
    const rhsJs = translateAssignmentRHS(raw, assignedVars, enumMap, fnRegistry);
    if (rhsJs !== null) {
      return `AC.setValue(${JSON.stringify(ctrl)}, ${rhsJs})`;
    }
  }

  // Bare function/sub call as statement (no parens) — e.g. Ribbon_ShowReportsGroup
  if (/^\w+$/.test(stmt) && fnRegistry && fnRegistry.has(stmt.toLowerCase())) {
    return `await AC.callFn(${JSON.stringify(stmt)})`;
  }

  // Function call with parens as statement — e.g. SomeFunc(arg1, arg2)
  const stmtFuncCall = parseFunctionCall(stmt);
  if (stmtFuncCall && fnRegistry && fnRegistry.has(stmtFuncCall.name.toLowerCase())) {
    const jsArgs = [];
    let allOk = true;
    for (const arg of stmtFuncCall.args) {
      const translated = translateExpression(arg, assignedVars, enumMap, fnRegistry);
      if (translated === null) { allOk = false; break; }
      jsArgs.push(translated);
    }
    if (allOk) {
      return `await AC.callFn(${JSON.stringify(stmtFuncCall.name)}, ${jsArgs.join(', ')})`;
    }
  }

  // Unrecognized — return null
  return null;
}

/**
 * Translate a VBA boolean expression to a JS condition string.
 * Returns null if the condition is untranslatable (conservative — better to
 * skip than to execute the wrong branch).
 * @param {string} vbaCond - VBA condition expression
 * @param {Set<string>} [assignedVars] - Variables that have been assigned translatable values
 * @param {Map<string,number>} [enumMap] - Enum member → integer value map
 */
function translateCondition(vbaCond, assignedVars, enumMap, fnRegistry) {
  if (!vbaCond) return null;
  const cond = vbaCond.trim();

  // Strip outer parentheses: (expr) → expr
  if (cond.startsWith('(') && cond.endsWith(')')) {
    // Verify the parens are matched (not just coincidental start/end)
    let depth = 0;
    let matched = true;
    for (let i = 0; i < cond.length - 1; i++) {
      if (cond[i] === '(') depth++;
      else if (cond[i] === ')') depth--;
      if (depth === 0) { matched = false; break; }
    }
    if (matched) {
      return translateCondition(cond.slice(1, -1).trim(), assignedVars, enumMap, fnRegistry);
    }
  }

  // True / False literals
  if (/^True$/i.test(cond)) return 'true';
  if (/^False$/i.test(cond)) return 'false';

  // Not <condition> — recursive
  const notMatch = cond.match(/^Not\s+(.+)$/i);
  if (notMatch) {
    const inner = translateCondition(notMatch[1], assignedVars, enumMap, fnRegistry);
    return inner ? `!(${inner})` : null;
  }

  // And / Or — paren-aware split and recurse
  // Process Or first (lower precedence), then And
  for (const [keyword, jsOp] of [['Or', ' || '], ['And', ' && ']]) {
    const parts = splitOnKeyword(cond, keyword);
    if (parts && parts.length >= 2) {
      const translated = parts.map(p => translateCondition(p.trim(), assignedVars, enumMap, fnRegistry));
      if (translated.every(t => t !== null)) {
        return translated.join(jsOp);
      }
      return null;
    }
  }

  // Me.NewRecord → AC.isNewRecord()
  if (/^Me\.NewRecord$/i.test(cond)) return 'AC.isNewRecord()';

  // Me.Dirty → AC.isDirty()
  if (/^Me\.Dirty$/i.test(cond)) return 'AC.isDirty()';

  // IsNull(Me.OpenArgs) → AC.getOpenArgs() == null
  if (/^IsNull\s*\(\s*Me\.OpenArgs\s*\)$/i.test(cond)) return 'AC.getOpenArgs() == null';

  // IsNull(TempVars!Name) or IsNull(TempVars("Name"))
  const isNullTvMatch = cond.match(/^IsNull\s*\(\s*TempVars[!.](\w+)\s*\)$/i)
    || cond.match(/^IsNull\s*\(\s*TempVars\s*\(\s*"([^"]+)"\s*\)\s*\)$/i);
  if (isNullTvMatch) {
    return `AC.getTempVar(${JSON.stringify(isNullTvMatch[1])}) == null`;
  }

  // TempVars!Name standalone as boolean (truthy check)
  const tvCondMatch = cond.match(/^TempVars[!.](\w+)$/i) || cond.match(/^TempVars\s*\(\s*"([^"]+)"\s*\)$/i);
  if (tvCondMatch) {
    return `AC.getTempVar(${JSON.stringify(tvCondMatch[1])})`;
  }

  // IsNull(Me.ctrl) → AC.getValue("ctrl") == null
  const isNullMeMatch = cond.match(/^IsNull\s*\(\s*Me\.(\w+)\s*\)$/i);
  if (isNullMeMatch) {
    return `AC.getValue(${JSON.stringify(isNullMeMatch[1])}) == null`;
  }

  // IsNull(variable) where variable is assigned
  const isNullVarMatch = cond.match(/^IsNull\s*\(\s*(\w+)\s*\)$/i);
  if (isNullVarMatch && assignedVars && assignedVars.has(isNullVarMatch[1].toLowerCase())) {
    return `${isNullVarMatch[1]} == null`;
  }

  // Me.ctrl.Visible = True/False
  const visCheck = cond.match(/^Me\.(\w+)\.Visible\s*=\s*(True|False|-1|0)\b/i);
  if (visCheck) {
    const val = /true|-1/i.test(visCheck[2]);
    return val ? `AC.getVisible(${JSON.stringify(visCheck[1])})` : `!(AC.getVisible(${JSON.stringify(visCheck[1])}))`;
  }

  // Me.ctrl.Enabled = True/False
  const enCheck = cond.match(/^Me\.(\w+)\.Enabled\s*=\s*(True|False|-1|0)\b/i);
  if (enCheck) {
    const val = /true|-1/i.test(enCheck[2]);
    return val ? `AC.getEnabled(${JSON.stringify(enCheck[1])})` : `!(AC.getEnabled(${JSON.stringify(enCheck[1])}))`;
  }

  // MsgBox("text"...) = vbYes → confirm("text")
  const msgBoxYesMatch = cond.match(/^MsgBox\s*\(\s*"([^"]+)".*\)\s*=\s*vbYes$/i);
  if (msgBoxYesMatch) {
    return `confirm(${JSON.stringify(msgBoxYesMatch[1])})`;
  }

  // Domain aggregate in comparison: DCount("*", "tbl", criteria) = 0
  if (/^(DCount|DLookup|DMin|DMax|DSum)\s*\(/i.test(cond)) {
    // Find the domain call, then check for trailing comparison operator
    const parsed = parseDomainCall(cond);
    if (parsed) {
      const result = translateDomainCall(cond, assignedVars, enumMap, fnRegistry);
      if (result) {
        const rest = cond.substring(parsed.endIdx).trim();
        if (!rest) {
          // Standalone domain call used as boolean (truthy check)
          return result.js;
        }
        // Check for comparison: = 0, > 5, <> "", etc.
        const cmpRest = rest.match(/^(=|<>|<|>|<=|>=)\s*(.+)$/);
        if (cmpRest) {
          const jsOp = cmpRest[1] === '=' ? '===' : cmpRest[1] === '<>' ? '!==' : cmpRest[1];
          const rhsTrimmed = cmpRest[2].trim();
          const isLit = /^"[^"]*"$/.test(rhsTrimmed) || /^\d+(\.\d+)?$/.test(rhsTrimmed) || /^(True|False)$/i.test(rhsTrimmed);
          if (isLit) {
            const lit = /^True$/i.test(rhsTrimmed) ? 'true' : /^False$/i.test(rhsTrimmed) ? 'false' : rhsTrimmed;
            return `${result.js} ${jsOp} ${lit}`;
          }
        }
      }
    }
  }

  // Comparisons with simple string/number literals: expr = "value", expr > 0, etc.
  const cmpMatch = cond.match(/^(.+?)\s*(=|<>|<|>|<=|>=)\s*(.+)$/);
  if (cmpMatch) {
    const [, lhs, op, rhs] = cmpMatch;
    const jsOp = op === '=' ? '===' : op === '<>' ? '!==' : op;
    const lhsTrimmed = lhs.trim();
    const rhsTrimmed = rhs.trim();

    const isLiteral = (s) => /^"[^"]*"$/.test(s) || /^\d+(\.\d+)?$/.test(s) || /^(True|False)$/i.test(s)
      || (enumMap && enumMap.has(s));
    const toLiteral = (s) => {
      if (/^True$/i.test(s)) return 'true';
      if (/^False$/i.test(s)) return 'false';
      if (enumMap && enumMap.has(s)) return String(enumMap.get(s));
      return s;
    };

    // Variable comparison: x = "Add" where x is in assignedVars
    if (assignedVars && assignedVars.has(lhsTrimmed.toLowerCase()) && isLiteral(rhsTrimmed)) {
      return `${lhsTrimmed} ${jsOp} ${toLiteral(rhsTrimmed)}`;
    }
    if (assignedVars && assignedVars.has(rhsTrimmed.toLowerCase()) && isLiteral(lhsTrimmed)) {
      return `${toLiteral(lhsTrimmed)} ${jsOp} ${rhsTrimmed}`;
    }

    // Me.ctrl compared to literal
    const meLhs = lhsTrimmed.match(/^Me\.(\w+)$/i);
    if (meLhs && isLiteral(rhsTrimmed)) {
      return `AC.getValue(${JSON.stringify(meLhs[1])}) ${jsOp} ${toLiteral(rhsTrimmed)}`;
    }

    // Me.OpenArgs compared to literal
    if (/^Me\.OpenArgs$/i.test(lhsTrimmed) && isLiteral(rhsTrimmed)) {
      return `AC.getOpenArgs() ${jsOp} ${toLiteral(rhsTrimmed)}`;
    }

    // TempVars!Name compared to literal
    const tvLhs = lhsTrimmed.match(/^TempVars[!.](\w+)$/i) || lhsTrimmed.match(/^TempVars\s*\(\s*"([^"]+)"\s*\)$/i);
    if (tvLhs && isLiteral(rhsTrimmed)) {
      return `AC.getTempVar(${JSON.stringify(tvLhs[1])}) ${jsOp} ${toLiteral(rhsTrimmed)}`;
    }

    // General LHS via translateExpression (handles fn calls, variables, etc.)
    const lhsExpr = translateExpression(lhsTrimmed, assignedVars, enumMap, fnRegistry);
    if (lhsExpr && isLiteral(rhsTrimmed)) {
      return `${lhsExpr} ${jsOp} ${toLiteral(rhsTrimmed)}`;
    }

    return null; // Conservative: can't translate unknown comparisons
  }

  // Fallback: standalone expression as boolean (fn calls, variables)
  const exprResult = translateExpression(cond, assignedVars, enumMap, fnRegistry);
  if (exprResult) return exprResult;

  return null;
}

/**
 * Find the matching end keyword for a block construct.
 * Tracks nesting depth to handle nested constructs of the same type.
 * Returns the index of the end line, or lines.length if not found.
 */
function findEndKeyword(lines, startIdx, startWord, endWord) {
  let depth = 1;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    const upper = line.toUpperCase();

    // Check for nested start of same construct
    if (startWord === 'SELECT CASE' && /^SELECT\s+CASE\b/i.test(line)) {
      depth++;
    } else if (startWord === 'FOR' && /^FOR\s+/i.test(line) && !/^FOR\s+EACH\b/i.test(line)) {
      depth++;
    } else if (startWord === 'FOR EACH' && /^FOR\s+EACH\s+/i.test(line)) {
      depth++;
    } else if (startWord === 'DO' && /^DO\b/i.test(line)) {
      depth++;
    } else if (startWord === 'WHILE' && /^WHILE\b/i.test(line) && !/^WEND$/i.test(line)) {
      depth++;
    } else if (startWord === 'WITH' && /^WITH\s+/i.test(line)) {
      depth++;
    }

    // Check for end keyword
    if (endWord && upper === endWord) {
      depth--;
      if (depth === 0) return i;
    } else if (!endWord) {
      // Auto-determine end word based on start
      if (startWord === 'SELECT CASE' && /^END\s+SELECT$/i.test(line)) {
        depth--;
        if (depth === 0) return i;
      } else if ((startWord === 'FOR' || startWord === 'FOR EACH') && /^NEXT\b/i.test(line)) {
        depth--;
        if (depth === 0) return i;
      } else if (startWord === 'DO' && /^LOOP\b/i.test(line)) {
        depth--;
        if (depth === 0) return i;
      } else if (startWord === 'WHILE' && /^WEND$/i.test(line)) {
        depth--;
        if (depth === 0) return i;
      } else if (startWord === 'WITH' && /^END\s+WITH$/i.test(line)) {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length; // Not found — skip to end
}

/**
 * Parse a multi-line If/ElseIf/Else/End If block.
 * Returns { jsLines: string[], endIdx: number } where endIdx is the line
 * index of the End If.
 * @param {string[]} lines
 * @param {number} startIdx
 * @param {string} formName
 * @param {Set<string>} [variables] - Declared variables
 * @param {Set<string>} [assignedVars] - Variables with translatable assignments
 * @param {Map<string,number>} [enumMap] - Enum member → integer value map
 */
function parseIfBlock(lines, startIdx, formName, variables, assignedVars, enumMap, fnRegistry, funcName) {
  // Collect branches: [{condition, bodyLines}]
  const branches = [];
  let depth = 0;
  let currentBranch = null;

  // The startIdx line is the "If ... Then" line
  const ifLine = lines[startIdx];
  const ifMatch = ifLine.match(/^If\s+(.+?)\s+Then\s*$/i);
  if (!ifMatch) {
    // Shouldn't happen — caller verified this is a block If
    return { jsLines: [], endIdx: startIdx };
  }

  currentBranch = { condition: ifMatch[1], bodyLines: [] };
  depth = 1;

  let i = startIdx + 1;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();

    // Nested If ... Then (block form) increases depth
    if (/^If\s+.+\s+Then\s*$/i.test(line)) {
      depth++;
      if (depth > 1 && currentBranch) currentBranch.bodyLines.push(line);
      continue;
    }

    // End If decreases depth
    if (/^End\s+If$/i.test(line)) {
      depth--;
      if (depth === 0) {
        // Save final branch and exit
        if (currentBranch) branches.push(currentBranch);
        break;
      }
      if (currentBranch) currentBranch.bodyLines.push(line);
      continue;
    }

    // ElseIf / Else at our depth level
    if (depth === 1) {
      const elseIfMatch = line.match(/^ElseIf\s+(.+?)\s+Then\s*$/i);
      if (elseIfMatch) {
        if (currentBranch) branches.push(currentBranch);
        currentBranch = { condition: elseIfMatch[1], bodyLines: [] };
        continue;
      }
      if (/^Else$/i.test(line)) {
        if (currentBranch) branches.push(currentBranch);
        currentBranch = { condition: null, bodyLines: [] }; // Else — no condition
        continue;
      }
    }

    if (currentBranch) currentBranch.bodyLines.push(line);
  }

  // If we never found End If, save what we have
  if (depth > 0 && currentBranch) {
    branches.push(currentBranch);
  }

  // Now translate each branch
  const jsLines = [];
  let allTranslatable = true;

  // Check if all conditions are translatable
  const translatedBranches = branches.map(b => {
    const jsCond = b.condition !== null ? translateCondition(b.condition, assignedVars, enumMap, fnRegistry) : null; // null condition = Else branch
    const { jsLines: bodyJs } = translateBlock(b.bodyLines, 0, formName, variables, assignedVars, enumMap, fnRegistry, funcName);
    return { condition: b.condition, jsCond, bodyJs, isElse: b.condition === null };
  });

  // If any non-Else branch has an untranslatable condition, emit entire block as comment
  for (const tb of translatedBranches) {
    if (!tb.isElse && tb.jsCond === null) {
      allTranslatable = false;
      break;
    }
  }

  if (allTranslatable && translatedBranches.length > 0) {
    // Emit proper if/else if/else
    translatedBranches.forEach((tb, idx) => {
      if (idx === 0) {
        jsLines.push(`if (${tb.jsCond}) {`);
      } else if (tb.isElse) {
        jsLines.push(`} else {`);
      } else {
        jsLines.push(`} else if (${tb.jsCond}) {`);
      }
      for (const bodyLine of tb.bodyJs) {
        jsLines.push('  ' + bodyLine);
      }
    });
    jsLines.push('}');
  } else {
    // Emit as comment — safer than executing any branch
    jsLines.push('// [VBA If block - condition not translatable]');
    for (const b of branches) {
      if (b.condition !== null) {
        jsLines.push(`// If ${b.condition} Then`);
      } else {
        jsLines.push('// Else');
      }
      for (const bodyLine of b.bodyLines) {
        jsLines.push(`//   ${bodyLine}`);
      }
    }
    jsLines.push('// End If');
  }

  return { jsLines, endIdx: i };
}

/**
 * Parse a Select Case block into a JS switch statement or if/else chain.
 * Returns { jsLines: string[], endIdx: number }.
 */
function parseSelectCaseBlock(lines, startIdx, formName, variables, assignedVars, enumMap, fnRegistry, funcName) {
  const caseLine = lines[startIdx];
  const caseMatch = caseLine.match(/^Select\s+Case\s+(.+)$/i);
  if (!caseMatch) return { jsLines: [`// [VBA Select Case block skipped]`], endIdx: startIdx };

  const exprRaw = caseMatch[1].trim();
  let jsExpr = null;
  let hasCaseIs = false;

  // Translate the switch expression
  if (assignedVars && assignedVars.has(exprRaw.toLowerCase())) {
    jsExpr = exprRaw;
  } else if (/^Me\.OpenArgs$/i.test(exprRaw)) {
    jsExpr = 'AC.getOpenArgs()';
  } else {
    const meMatch = exprRaw.match(/^Me\.(\w+)$/i);
    if (meMatch && !/^(Name|Caption|RecordSource|Filter|OrderBy)$/i.test(meMatch[1])) {
      jsExpr = `AC.getValue(${JSON.stringify(meMatch[1])})`;
    }
  }

  // Find End Select
  const endIdx = findEndKeyword(lines, startIdx + 1, 'SELECT CASE');

  // If expression is untranslatable, emit as comment
  if (!jsExpr) {
    const jsLines = ['// [VBA Select Case - expression not translatable]'];
    for (let j = startIdx; j <= Math.min(endIdx, lines.length - 1); j++) {
      jsLines.push(`// ${lines[j]}`);
    }
    return { jsLines, endIdx };
  }

  // Parse Case branches between startIdx+1 and endIdx
  const branches = [];
  let currentBranch = null;

  for (let j = startIdx + 1; j < endIdx && j < lines.length; j++) {
    const line = lines[j].trim();

    // Case Is > N, Case Is < N, etc.
    const caseIsMatch = line.match(/^Case\s+Is\s*(>=|<=|<>|>|<|=)\s*(.+)$/i);
    if (caseIsMatch) {
      if (currentBranch) branches.push(currentBranch);
      hasCaseIs = true;
      currentBranch = { type: 'is', op: caseIsMatch[1], value: caseIsMatch[2].trim(), bodyLines: [] };
      continue;
    }

    // Case Else
    if (/^Case\s+Else$/i.test(line)) {
      if (currentBranch) branches.push(currentBranch);
      currentBranch = { type: 'else', bodyLines: [] };
      continue;
    }

    // Case "val1", "val2" or Case 1, 2, 3
    const caseValMatch = line.match(/^Case\s+(.+)$/i);
    if (caseValMatch) {
      if (currentBranch) branches.push(currentBranch);
      // Parse comma-separated values
      const valuesRaw = caseValMatch[1].split(',').map(v => v.trim());
      currentBranch = { type: 'values', values: valuesRaw, bodyLines: [] };
      continue;
    }

    if (currentBranch) currentBranch.bodyLines.push(line);
  }
  if (currentBranch) branches.push(currentBranch);

  const jsLines = [];

  if (hasCaseIs) {
    // Emit as if/else if chain (switch can't handle comparison operators)
    branches.forEach((b, idx) => {
      if (b.type === 'else') {
        jsLines.push('} else {');
      } else if (b.type === 'is') {
        const jsOp = b.op === '=' ? '===' : b.op === '<>' ? '!==' : b.op;
        const lit = /^True$/i.test(b.value) ? 'true' : /^False$/i.test(b.value) ? 'false' : b.value;
        if (idx === 0) {
          jsLines.push(`if (${jsExpr} ${jsOp} ${lit}) {`);
        } else {
          jsLines.push(`} else if (${jsExpr} ${jsOp} ${lit}) {`);
        }
      } else if (b.type === 'values') {
        // Values in an if/else chain: x === "A" || x === "B"
        const conds = b.values.map(v => {
          const lit = /^True$/i.test(v) ? 'true' : /^False$/i.test(v) ? 'false' : v;
          return `${jsExpr} === ${lit}`;
        }).join(' || ');
        if (idx === 0) {
          jsLines.push(`if (${conds}) {`);
        } else {
          jsLines.push(`} else if (${conds}) {`);
        }
      }
      const { jsLines: bodyJs } = translateBlock(b.bodyLines, 0, formName, variables, assignedVars, enumMap, fnRegistry, funcName);
      for (const bodyLine of bodyJs) {
        jsLines.push('  ' + bodyLine);
      }
    });
    jsLines.push('}');
  } else {
    // Emit as switch/case
    jsLines.push(`switch (${jsExpr}) {`);
    for (const b of branches) {
      if (b.type === 'else') {
        jsLines.push('  default:');
      } else if (b.type === 'values') {
        for (const v of b.values) {
          const lit = /^True$/i.test(v) ? 'true' : /^False$/i.test(v) ? 'false' : v;
          jsLines.push(`  case ${lit}:`);
        }
      }
      const { jsLines: bodyJs } = translateBlock(b.bodyLines, 0, formName, variables, assignedVars, enumMap, fnRegistry, funcName);
      for (const bodyLine of bodyJs) {
        jsLines.push('    ' + bodyLine);
      }
      if (b.type !== 'else') {
        jsLines.push('    break;');
      }
    }
    jsLines.push('}');
  }

  return { jsLines, endIdx };
}

/**
 * Parse a numeric For loop into a JS for statement.
 * Returns { jsLines: string[], endIdx: number } or null if non-numeric bounds.
 */
function parseForLoop(lines, startIdx, formName, variables, assignedVars, enumMap, fnRegistry, funcName) {
  const forLine = lines[startIdx];
  const forMatch = forLine.match(/^For\s+(\w+)\s*=\s*(.+?)\s+To\s+(.+?)(?:\s+Step\s+(-?\d+))?$/i);
  if (!forMatch) return null;

  const [, varName, startVal, endVal, stepVal] = forMatch;
  const step = stepVal ? parseInt(stepVal) : 1;

  // Translate bounds — numeric literals or expressions (e.g. UBound(arr))
  let jsStart, jsEnd;
  if (/^-?\d+$/.test(startVal)) {
    jsStart = startVal;
  } else {
    jsStart = translateExpression(startVal.trim(), assignedVars, enumMap, fnRegistry);
    if (!jsStart) return null;
  }
  if (/^-?\d+$/.test(endVal)) {
    jsEnd = endVal;
  } else {
    jsEnd = translateExpression(endVal.trim(), assignedVars, enumMap, fnRegistry);
    if (!jsEnd) return null;
  }

  const endIdx = findEndKeyword(lines, startIdx + 1, 'FOR');
  const bodyLines = lines.slice(startIdx + 1, endIdx);

  // Loop variable is available in body
  const innerVars = new Set(variables || []);
  innerVars.add(varName.toLowerCase());
  const innerAssigned = new Set(assignedVars || []);
  innerAssigned.add(varName.toLowerCase());

  const { jsLines: bodyJs } = translateBlock(bodyLines, 0, formName, innerVars, innerAssigned, enumMap, fnRegistry, funcName);

  const cmp = step > 0 ? '<=' : '>=';
  const inc = step === 1 ? `${varName}++` : step === -1 ? `${varName}--` : `${varName} += ${step}`;
  const jsLines = [`for (let ${varName} = ${jsStart}; ${varName} ${cmp} ${jsEnd}; ${inc}) {`];
  for (const bodyLine of bodyJs) {
    jsLines.push('  ' + bodyLine);
  }
  jsLines.push('}');

  return { jsLines, endIdx };
}

/**
 * Translate a block of VBA lines into JS, recognizing control flow.
 * Handles If/Else, Select Case, numeric For loops, variable tracking.
 * Returns { jsLines: string[], endIdx: number }.
 * @param {string[]} lines
 * @param {number} startIdx
 * @param {string} formName
 * @param {Set<string>} [variables] - Declared variable names (lowercase)
 * @param {Set<string>} [assignedVars] - Variables with translatable RHS values (lowercase)
 * @param {Map<string,number>} [enumMap]
 * @param {Set<string>} [fnRegistry]
 * @param {string} [funcName] - Current Function name (for return value pattern), null for Subs
 */
function translateBlock(lines, startIdx, formName, variables, assignedVars, enumMap, fnRegistry, funcName) {
  const jsLines = [];
  let i = startIdx;

  // Initialize variable tracking Sets (shared across entire procedure)
  if (!variables) variables = new Set();
  if (!assignedVars) assignedVars = new Set();

  while (i < lines.length) {
    const line = lines[i].trim();

    // Dim x As Type → let x; (track variable as assigned — VBA initializes to defaults)
    const dimMatch = line.match(/^Dim\s+(\w+)/i);
    if (dimMatch) {
      const varName = dimMatch[1].toLowerCase();
      variables.add(varName);
      assignedVars.add(varName);
      jsLines.push(`let ${dimMatch[1]};`);
      i++;
      continue;
    }

    // Const x = value → const x = value; (track as known variable)
    const constMatch = line.match(/^(?:Private\s+|Public\s+)?Const\s+(\w+)\s*(?:As\s+\w+\s*)?=\s*(.+)$/i);
    if (constMatch) {
      const varName = constMatch[1];
      variables.add(varName.toLowerCase());
      assignedVars.add(varName.toLowerCase());
      const rhs = translateAssignmentRHS(constMatch[2].trim(), assignedVars, enumMap, fnRegistry);
      if (rhs) {
        jsLines.push(`const ${varName} = ${rhs};`);
      } else {
        jsLines.push(`// ${line}`);
      }
      i++;
      continue;
    }

    // Skip GoTo (VBA-only constructs)
    if (/^GoTo\s+/i.test(line)) {
      i++;
      continue;
    }

    // Strip Set prefix for object assignments: Set x = expr → x = expr
    let assignLine = line;
    if (/^Set\s+/i.test(line)) {
      assignLine = line.replace(/^Set\s+/i, '');
    }

    // Assignment pattern: x = expr (handles both Set and non-Set)
    const assignMatch = assignLine.match(/^(\w+)\s*=\s*(.+)$/);
    if (assignMatch) {
      const varNameLower = assignMatch[1].toLowerCase();

      // Function return value: FuncName = expr → return expr
      if (funcName && varNameLower === funcName.toLowerCase()) {
        const rhs = translateAssignmentRHS(assignMatch[2].trim(), assignedVars, enumMap, fnRegistry);
        if (rhs) {
          jsLines.push(`return ${rhs};`);
        } else {
          jsLines.push(`// ${line}`);
        }
        i++;
        continue;
      }

      // Variable assignment: x = <rhs> where x is a declared variable
      if (variables.has(varNameLower)) {
        const rhs = translateAssignmentRHS(assignMatch[2].trim(), assignedVars, enumMap, fnRegistry);
        if (rhs) {
          assignedVars.add(varNameLower);
          jsLines.push(`${assignMatch[1]} = ${rhs};`);
        } else {
          // Untranslatable RHS — emit as comment but still track the variable
          // so conditions like `If x = 0` remain translatable
          assignedVars.add(varNameLower);
          jsLines.push(`// ${line}`);
        }
        i++;
        continue;
      }
    }

    // Block If ... Then (multi-line — no statement after Then)
    if (/^If\s+.+\s+Then\s*$/i.test(line)) {
      const result = parseIfBlock(lines, i, formName, variables, assignedVars, enumMap, fnRegistry, funcName);
      jsLines.push(...result.jsLines);
      i = result.endIdx + 1;
      continue;
    }

    // Single-line If: If <cond> Then <stmt>
    const singleIfMatch = line.match(/^If\s+(.+?)\s+Then\s+(.+)$/i);
    if (singleIfMatch) {
      const cond = translateCondition(singleIfMatch[1], assignedVars, enumMap, fnRegistry);
      const stmt = translateStatement(singleIfMatch[2].trim(), formName, enumMap, assignedVars, fnRegistry);
      if (cond && stmt) {
        jsLines.push(`if (${cond}) { ${stmt}; }`);
      } else {
        // Emit as comment
        jsLines.push(`// ${line}`);
      }
      i++;
      continue;
    }

    // Select Case — try to translate, fall back to comment
    if (/^Select\s+Case\b/i.test(line)) {
      const result = parseSelectCaseBlock(lines, i, formName, variables, assignedVars, enumMap, fnRegistry, funcName);
      jsLines.push(...result.jsLines);
      i = result.endIdx + 1;
      continue;
    }

    // For Each — still skipped (collection iteration)
    if (/^For\s+Each\s+/i.test(line)) {
      const endIdx = findEndKeyword(lines, i + 1, 'FOR EACH');
      jsLines.push(`// [VBA For Each loop skipped]`);
      i = endIdx + 1;
      continue;
    }

    // Numeric For — try to translate
    if (/^For\s+/i.test(line)) {
      const result = parseForLoop(lines, i, formName, variables, assignedVars, enumMap, fnRegistry, funcName);
      if (result) {
        jsLines.push(...result.jsLines);
        i = result.endIdx + 1;
      } else {
        // Non-numeric or complex bounds — skip
        const endIdx = findEndKeyword(lines, i + 1, 'FOR');
        jsLines.push(`// [VBA For loop skipped]`);
        i = endIdx + 1;
      }
      continue;
    }

    // Do ... Loop
    if (/^Do\b/i.test(line)) {
      const endIdx = findEndKeyword(lines, i + 1, 'DO');
      jsLines.push(`// [VBA Do loop skipped]`);
      i = endIdx + 1;
      continue;
    }

    // While ... Wend
    if (/^While\s+/i.test(line)) {
      const endIdx = findEndKeyword(lines, i + 1, 'WHILE');
      jsLines.push(`// [VBA While loop skipped]`);
      i = endIdx + 1;
      continue;
    }

    // With ... End With
    if (/^With\s+/i.test(line)) {
      const endIdx = findEndKeyword(lines, i + 1, 'WITH');
      jsLines.push(`// [VBA With block skipped]`);
      i = endIdx + 1;
      continue;
    }

    // Regular statement — delegate to translateStatement
    const js = translateStatement(line, formName, enumMap, assignedVars, fnRegistry);
    if (js) {
      jsLines.push(js + ';');
    } else {
      // Untranslatable statement — preserve as comment
      jsLines.push(`// ${line}`);
    }

    i++;
  }

  return { jsLines, endIdx: i };
}

/**
 * Count non-comment lines in a JS output string.
 */
function countCodeLines(js) {
  if (!js) return 0;
  return js.split('\n').filter(l => !l.trim().startsWith('//')).length;
}

/**
 * Parse VBA source and return handler descriptors with JS code.
 * Uses a multi-pass approach: pass 1 translates everything it can and builds
 * a function registry from fn.* procedures. Pass 2+ retries handlers that
 * had comment-only output, now with the full registry available for inside-out
 * resolution of nested function calls.
 *
 * @param {string} vbaSource - VBA module source
 * @param {string} [moduleName] - Module name (e.g. "Form_frmAbout") -- used to derive form name for DoCmd.Close
 * @param {Map<string,number>} [enumMap] - Pre-collected enum map (cross-module)
 * @param {Set<string>} [fnRegistry] - Pre-populated function registry (cross-module)
 * Returns [{key, control, event, procedure, js}]
 */
function parseVbaToHandlers(vbaSource, moduleName, enumMap, fnRegistry) {
  if (!vbaSource) return [];

  // Derive form/report name from module name (Form_frmAbout -> frmAbout, Report_rptSales -> rptSales)
  let objectName = null;
  if (moduleName) {
    const prefixMatch = moduleName.match(/^(?:Form_|Report_)(.+)$/i);
    if (prefixMatch) objectName = prefixMatch[1];
  }

  // Collect enums from this module's own source if no external map provided
  if (!enumMap) {
    enumMap = collectEnumValues(vbaSource);
  }

  // Initialize function registry if not provided (cross-module callers provide one)
  if (!fnRegistry) {
    fnRegistry = new Set();
  }

  // Collect module-level variable names for condition/expression translation
  const moduleVars = collectModuleVars(vbaSource);

  const procedures = extractProcedures(vbaSource);

  // Build procedure metadata (key, control, event) once — reused across passes
  const procMeta = procedures.map(proc => {
    const match = proc.name.match(/^(.+?)_(\w+)$/);
    let key, controlKw, eventKey;

    if (match) {
      const [, rawControl, rawEvent] = match;
      eventKey = EVENT_MAP[rawEvent.toLowerCase()];
      if (eventKey) {
        controlKw = rawControl === 'Form' ? 'form'
          : rawControl === 'Report' ? 'report'
          : toKw(rawControl);
        key = `${controlKw}.${eventKey}`;
      }
    }

    if (!key) {
      controlKw = 'fn';
      eventKey = proc.name;
      key = `fn.${proc.name}`;
    }

    return { proc, key, controlKw, eventKey };
  });

  // Pass 1: translate without fnRegistry, build registry from results
  const handlers = [];
  const retryIndices = []; // indices into procMeta that may benefit from retry

  for (let idx = 0; idx < procMeta.length; idx++) {
    const { proc, key, controlKw, eventKey } = procMeta[idx];
    const cleanLines = stripBoilerplate(proc.body);
    // Seed assignedVars with module vars + procedure parameters
    const initVars = new Set(moduleVars);
    if (proc.params) {
      for (const p of proc.params) initVars.add(p.toLowerCase());
    }
    const funcName = proc.kind === 'function' ? proc.name : null;
    const { jsLines } = translateBlock(cleanLines, 0, objectName, null, initVars, enumMap, fnRegistry, funcName);

    // Register fn.* procedures in the registry
    if (controlKw === 'fn') {
      fnRegistry.add(proc.name.toLowerCase());
    }

    if (jsLines.length > 0) {
      const js = jsLines.join('\n');
      const codeCount = countCodeLines(js);
      const commentCount = jsLines.filter(l => /^\s*\/\//.test(l)).length;
      handlers.push({
        key,
        control: controlKw,
        event: eventKey,
        procedure: proc.name,
        js,
      });
      // If handler has any comment lines, mark for retry (fnRegistry may resolve them)
      if (commentCount > 0) {
        retryIndices.push(handlers.length - 1);
      }
    }
  }

  // Pass 2+: retry handlers that were all-comments, now with fnRegistry populated
  if (fnRegistry.size > 0 && retryIndices.length > 0) {
    const MAX_PASSES = 3;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let improved = false;
      const stillPending = [];

      for (const hIdx of retryIndices) {
        const handler = handlers[hIdx];
        const meta = procMeta.find(m => m.proc.name === handler.procedure);
        if (!meta) continue;

        const cleanLines = stripBoilerplate(meta.proc.body);
        const retryVars = new Set(moduleVars);
        if (meta.proc.params) {
          for (const p of meta.proc.params) retryVars.add(p.toLowerCase());
        }
        const retryFuncName = meta.proc.kind === 'function' ? meta.proc.name : null;
        const { jsLines } = translateBlock(cleanLines, 0, objectName, null, retryVars, enumMap, fnRegistry, retryFuncName);
        const js = jsLines.join('\n');
        const codeCount = countCodeLines(js);

        if (codeCount > countCodeLines(handler.js)) {
          handler.js = js;
          improved = true;
        }
        if (codeCount === 0) {
          stillPending.push(hIdx);
        }
      }

      if (!improved || stillPending.length === 0) break;
      retryIndices.length = 0;
      retryIndices.push(...stillPending);
    }
  }

  return handlers;
}

module.exports = {
  parseVbaToHandlers, extractProcedures, stripBoilerplate, translateStatement,
  translateCondition, translateBlock, parseIfBlock, findEndKeyword,
  translateAssignmentRHS, parseSelectCaseBlock, parseForLoop,
  collectEnumValues, collectModuleVars, translateDomainCall, parseDomainCall, translateCriteria,
  translateExpression, parseFunctionCall, splitOnOperator,
};
