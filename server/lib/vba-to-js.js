/**
 * vba-to-js.js — Parse VBA event procedures and generate executable JavaScript.
 *
 * When a form module has VBA source but no pre-extracted intents, this parser
 * reads the VBA directly and produces JS code strings that call the AccessClone
 * runtime API (window.AC). The JS is eval'd client-side and wired to button clicks.
 */

const { toKw } = require('./reactions-extractor');

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
};

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

    // Match: Private Sub cmdClose_Click() or Sub Form_Load()
    const subMatch = line.match(/^(?:Private\s+|Public\s+)?Sub\s+(\w+)\s*\(/i);
    if (subMatch && !current) {
      current = { name: subMatch[1], bodyLines: [] };
      continue;
    }

    if (current && /^End\s+Sub/i.test(line)) {
      procedures.push({ name: current.name, body: current.bodyLines.join('\n') });
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
 * Translate a single VBA statement to a JS expression calling AC.*.
 * Returns a JS string or null if unrecognized.
 * @param {string} stmt - VBA statement
 * @param {string} [formName] - Form name derived from module (e.g. "frmAbout" from "Form_frmAbout")
 */
function translateStatement(stmt, formName) {
  // DoCmd.Close acForm, Me.Name  or  DoCmd.Close
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

  // DoCmd.RunSQL "sql"
  const runSqlMatch = stmt.match(/^DoCmd\.RunSQL\s+"([^"]+)"/i);
  if (runSqlMatch) {
    return `AC.runSQL(${JSON.stringify(runSqlMatch[1])})`;
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

  // MsgBox "text"
  const msgBoxMatch = stmt.match(/^MsgBox\s+"([^"]+)"/i);
  if (msgBoxMatch) {
    return `alert(${JSON.stringify(msgBoxMatch[1])})`;
  }

  // Me.Requery
  if (/^Me\.Requery\b/i.test(stmt)) {
    return 'AC.requery()';
  }

  // Me.Refresh
  if (/^Me\.Refresh\b/i.test(stmt)) {
    return 'AC.requery()';
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

  // controlName.Caption = "text"
  const captionMatch = stmt.match(/^(?:Me\.)?(\w+)\.Caption\s*=\s*"([^"]+)"/i);
  if (captionMatch) {
    return `AC.setValue(${JSON.stringify(captionMatch[1])}, ${JSON.stringify(captionMatch[2])})`;
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
  }

  // Unrecognized — return null
  return null;
}

/**
 * Translate a VBA boolean expression to a JS condition string.
 * Returns null if the condition is untranslatable (conservative — better to
 * skip than to execute the wrong branch).
 */
function translateCondition(vbaCond) {
  if (!vbaCond) return null;
  const cond = vbaCond.trim();

  // True / False literals
  if (/^True$/i.test(cond)) return 'true';
  if (/^False$/i.test(cond)) return 'false';

  // Not <condition> — recursive
  const notMatch = cond.match(/^Not\s+(.+)$/i);
  if (notMatch) {
    const inner = translateCondition(notMatch[1]);
    return inner ? `!(${inner})` : null;
  }

  // And / Or — split and recurse (handle simple binary cases)
  // Process Or first (lower precedence), then And
  for (const [vbaOp, jsOp] of [
    [/\s+Or\s+/i, ' || '],
    [/\s+And\s+/i, ' && '],
  ]) {
    const parts = cond.split(vbaOp);
    if (parts.length >= 2) {
      const translated = parts.map(p => translateCondition(p.trim()));
      if (translated.every(t => t !== null)) {
        return translated.join(jsOp);
      }
      return null;
    }
  }

  // IsNull(Me.OpenArgs) — no web equivalent for OpenArgs
  if (/^IsNull\s*\(\s*Me\.OpenArgs\s*\)$/i.test(cond)) return null;

  // IsNull(expr) → expr == null
  const isNullMatch = cond.match(/^IsNull\s*\(\s*(.+)\s*\)$/i);
  if (isNullMatch) {
    const inner = isNullMatch[1].trim();
    // If it references Me.something or a local variable, still try
    if (/^Me\.\w+$/i.test(inner)) {
      return null; // Can't read control values at runtime yet
    }
    return null; // Conservative — most IsNull args reference runtime state
  }

  // Me.NewRecord, Me.Dirty — no JS equivalent
  if (/^Me\.(NewRecord|Dirty)$/i.test(cond)) return null;

  // MsgBox("text"...) = vbYes → confirm("text")
  const msgBoxYesMatch = cond.match(/^MsgBox\s*\(\s*"([^"]+)".*\)\s*=\s*vbYes$/i);
  if (msgBoxYesMatch) {
    return `confirm(${JSON.stringify(msgBoxYesMatch[1])})`;
  }

  // Comparisons with simple string/number literals: expr = "value", expr > 0, etc.
  const cmpMatch = cond.match(/^(.+?)\s*(=|<>|<|>|<=|>=)\s*(.+)$/);
  if (cmpMatch) {
    const [, lhs, op, rhs] = cmpMatch;
    // Only translate if both sides are simple literals or known patterns
    const jsOp = op === '=' ? '===' : op === '<>' ? '!==' : op;

    // Check if lhs/rhs reference local VBA variables or runtime state
    const lhsTrimmed = lhs.trim();
    const rhsTrimmed = rhs.trim();

    // Simple literal on the right: "string", number, True/False
    const isLiteral = (s) => /^"[^"]*"$/.test(s) || /^\d+(\.\d+)?$/.test(s) || /^(True|False)$/i.test(s);

    // We can't translate comparisons involving local VBA variables
    if (!isLiteral(lhsTrimmed) && !isLiteral(rhsTrimmed)) return null;

    return null; // Conservative: most comparisons reference runtime VBA state
  }

  // Anything else — untranslatable
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
 */
function parseIfBlock(lines, startIdx, formName) {
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
    const jsCond = b.condition !== null ? translateCondition(b.condition) : null; // null condition = Else branch
    const { jsLines: bodyJs } = translateBlock(b.bodyLines, 0, formName);
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
 * Translate a block of VBA lines into JS, recognizing control flow.
 * Replaces the flat for loop — handles If/Else, skips Select Case and loops.
 * Returns { jsLines: string[], endIdx: number }.
 */
function translateBlock(lines, startIdx, formName) {
  const jsLines = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip Dim, Set, Const, GoTo (VBA-only constructs)
    if (/^(Dim|Set|Const|GoTo)\s+/i.test(line)) {
      i++;
      continue;
    }

    // Block If ... Then (multi-line — no statement after Then)
    if (/^If\s+.+\s+Then\s*$/i.test(line)) {
      const result = parseIfBlock(lines, i, formName);
      jsLines.push(...result.jsLines);
      i = result.endIdx + 1;
      continue;
    }

    // Single-line If: If <cond> Then <stmt>
    const singleIfMatch = line.match(/^If\s+(.+?)\s+Then\s+(.+)$/i);
    if (singleIfMatch) {
      const cond = translateCondition(singleIfMatch[1]);
      const stmt = translateStatement(singleIfMatch[2].trim(), formName);
      if (cond && stmt) {
        jsLines.push(`if (${cond}) { ${stmt}; }`);
      } else {
        // Emit as comment
        jsLines.push(`// ${line}`);
      }
      i++;
      continue;
    }

    // Select Case — skip to End Select
    if (/^Select\s+Case\b/i.test(line)) {
      const endIdx = findEndKeyword(lines, i + 1, 'SELECT CASE');
      jsLines.push(`// [VBA Select Case block skipped]`);
      i = endIdx + 1;
      continue;
    }

    // For / For Each — skip to Next
    if (/^For\s+Each\s+/i.test(line)) {
      const endIdx = findEndKeyword(lines, i + 1, 'FOR EACH');
      jsLines.push(`// [VBA For Each loop skipped]`);
      i = endIdx + 1;
      continue;
    }
    if (/^For\s+/i.test(line)) {
      const endIdx = findEndKeyword(lines, i + 1, 'FOR');
      jsLines.push(`// [VBA For loop skipped]`);
      i = endIdx + 1;
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
    const js = translateStatement(line, formName);
    if (js) {
      jsLines.push(js + ';');
    }

    i++;
  }

  return { jsLines, endIdx: i };
}

/**
 * Parse VBA source and return handler descriptors with JS code.
 * @param {string} vbaSource - VBA module source
 * @param {string} [moduleName] - Module name (e.g. "Form_frmAbout") — used to derive form name for DoCmd.Close
 * Returns [{key, control, event, procedure, js}]
 */
function parseVbaToHandlers(vbaSource, moduleName) {
  if (!vbaSource) return [];

  // Derive form/report name from module name (Form_frmAbout → frmAbout, Report_rptSales → rptSales)
  let objectName = null;
  if (moduleName) {
    const prefixMatch = moduleName.match(/^(?:Form_|Report_)(.+)$/i);
    if (prefixMatch) objectName = prefixMatch[1];
  }

  const procedures = extractProcedures(vbaSource);
  const handlers = [];

  for (const proc of procedures) {
    // Parse controlName_EventName
    const match = proc.name.match(/^(.+?)_(\w+)$/);
    if (!match) continue;

    const [, rawControl, rawEvent] = match;
    const eventKey = EVENT_MAP[rawEvent.toLowerCase()];
    if (!eventKey) continue;

    const controlKw = rawControl === 'Form' ? 'form'
      : rawControl === 'Report' ? 'report'
      : toKw(rawControl);

    const key = `${controlKw}.${eventKey}`;

    // Parse the VBA body into JS statements (with control flow)
    const cleanLines = stripBoilerplate(proc.body);
    const { jsLines } = translateBlock(cleanLines, 0, objectName);

    // Filter out comment-only lines to check if we have real JS
    const realLines = jsLines.filter(l => !l.trimStart().startsWith('//'));

    // Only emit handler if we could translate at least something
    if (realLines.length > 0) {
      handlers.push({
        key,
        control: controlKw,
        event: eventKey,
        procedure: proc.name,
        js: jsLines.join('\n'),
      });
    }
  }

  return handlers;
}

module.exports = {
  parseVbaToHandlers, extractProcedures, stripBoilerplate, translateStatement,
  translateCondition, translateBlock, parseIfBlock, findEndKeyword,
};
