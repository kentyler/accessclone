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
 * Translate the right-hand side of a VBA variable assignment to JS.
 * Returns a JS expression string or null if untranslatable.
 * @param {string} rhs - The RHS of the assignment (already trimmed)
 */
function translateAssignmentRHS(rhs) {
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

  // Nz(Me.OpenArgs, default) or Nz(Me.OpenArgs)
  const nzMatch = s.match(/^Nz\s*\(\s*(.+?)\s*(?:,\s*(.+?))?\s*\)$/i);
  if (nzMatch) {
    const inner = translateAssignmentRHS(nzMatch[1]);
    if (!inner) return null;
    if (nzMatch[2] !== undefined) {
      const def = translateAssignmentRHS(nzMatch[2].trim());
      if (!def) return null;
      return `AC.nz(${inner}, ${def})`;
    }
    return `AC.nz(${inner})`;
  }

  // Anything else — untranslatable
  return null;
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
 * @param {string} vbaCond - VBA condition expression
 * @param {Set<string>} [assignedVars] - Variables that have been assigned translatable values
 */
function translateCondition(vbaCond, assignedVars) {
  if (!vbaCond) return null;
  const cond = vbaCond.trim();

  // True / False literals
  if (/^True$/i.test(cond)) return 'true';
  if (/^False$/i.test(cond)) return 'false';

  // Not <condition> — recursive
  const notMatch = cond.match(/^Not\s+(.+)$/i);
  if (notMatch) {
    const inner = translateCondition(notMatch[1], assignedVars);
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
      const translated = parts.map(p => translateCondition(p.trim(), assignedVars));
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

  // Comparisons with simple string/number literals: expr = "value", expr > 0, etc.
  const cmpMatch = cond.match(/^(.+?)\s*(=|<>|<|>|<=|>=)\s*(.+)$/);
  if (cmpMatch) {
    const [, lhs, op, rhs] = cmpMatch;
    const jsOp = op === '=' ? '===' : op === '<>' ? '!==' : op;
    const lhsTrimmed = lhs.trim();
    const rhsTrimmed = rhs.trim();

    const isLiteral = (s) => /^"[^"]*"$/.test(s) || /^\d+(\.\d+)?$/.test(s) || /^(True|False)$/i.test(s);
    const toLiteral = (s) => {
      if (/^True$/i.test(s)) return 'true';
      if (/^False$/i.test(s)) return 'false';
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

    return null; // Conservative: can't translate unknown comparisons
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
 * @param {string[]} lines
 * @param {number} startIdx
 * @param {string} formName
 * @param {Set<string>} [variables] - Declared variables
 * @param {Set<string>} [assignedVars] - Variables with translatable assignments
 */
function parseIfBlock(lines, startIdx, formName, variables, assignedVars) {
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
    const jsCond = b.condition !== null ? translateCondition(b.condition, assignedVars) : null; // null condition = Else branch
    const { jsLines: bodyJs } = translateBlock(b.bodyLines, 0, formName, variables, assignedVars);
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
function parseSelectCaseBlock(lines, startIdx, formName, variables, assignedVars) {
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
      const { jsLines: bodyJs } = translateBlock(b.bodyLines, 0, formName, variables, assignedVars);
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
      const { jsLines: bodyJs } = translateBlock(b.bodyLines, 0, formName, variables, assignedVars);
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
function parseForLoop(lines, startIdx, formName, variables, assignedVars) {
  const forLine = lines[startIdx];
  const forMatch = forLine.match(/^For\s+(\w+)\s*=\s*(\S+)\s+To\s+(\S+)(?:\s+Step\s+(-?\d+))?$/i);
  if (!forMatch) return null;

  const [, varName, startVal, endVal, stepVal] = forMatch;

  // Only translate numeric bounds
  if (!/^-?\d+$/.test(startVal) || !/^-?\d+$/.test(endVal)) return null;

  const step = stepVal ? parseInt(stepVal) : 1;
  const start = parseInt(startVal);
  const end = parseInt(endVal);

  const endIdx = findEndKeyword(lines, startIdx + 1, 'FOR');
  const bodyLines = lines.slice(startIdx + 1, endIdx);

  // Loop variable is available in body
  const innerVars = new Set(variables || []);
  innerVars.add(varName.toLowerCase());
  const innerAssigned = new Set(assignedVars || []);
  innerAssigned.add(varName.toLowerCase());

  const { jsLines: bodyJs } = translateBlock(bodyLines, 0, formName, innerVars, innerAssigned);

  const cmp = step > 0 ? '<=' : '>=';
  const inc = step === 1 ? `${varName}++` : step === -1 ? `${varName}--` : `${varName} += ${step}`;
  const jsLines = [`for (let ${varName} = ${start}; ${varName} ${cmp} ${end}; ${inc}) {`];
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
 */
function translateBlock(lines, startIdx, formName, variables, assignedVars) {
  const jsLines = [];
  let i = startIdx;

  // Initialize variable tracking Sets (shared across entire procedure)
  if (!variables) variables = new Set();
  if (!assignedVars) assignedVars = new Set();

  while (i < lines.length) {
    const line = lines[i].trim();

    // Dim x As Type → let x; (track variable)
    const dimMatch = line.match(/^Dim\s+(\w+)/i);
    if (dimMatch) {
      const varName = dimMatch[1].toLowerCase();
      variables.add(varName);
      jsLines.push(`let ${dimMatch[1]};`);
      i++;
      continue;
    }

    // Skip Set, Const, GoTo (VBA-only constructs)
    if (/^(Set|Const|GoTo)\s+/i.test(line)) {
      i++;
      continue;
    }

    // Variable assignment: x = <rhs> where x is a declared variable
    const assignMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (assignMatch && variables.has(assignMatch[1].toLowerCase())) {
      const varName = assignMatch[1];
      const rhs = translateAssignmentRHS(assignMatch[2].trim());
      if (rhs) {
        assignedVars.add(varName.toLowerCase());
        jsLines.push(`${varName} = ${rhs};`);
      } else {
        // Untranslatable RHS — emit as comment but still track the variable
        // (it was assigned, just to something we can't translate)
        jsLines.push(`// ${line}`);
      }
      i++;
      continue;
    }

    // Block If ... Then (multi-line — no statement after Then)
    if (/^If\s+.+\s+Then\s*$/i.test(line)) {
      const result = parseIfBlock(lines, i, formName, variables, assignedVars);
      jsLines.push(...result.jsLines);
      i = result.endIdx + 1;
      continue;
    }

    // Single-line If: If <cond> Then <stmt>
    const singleIfMatch = line.match(/^If\s+(.+?)\s+Then\s+(.+)$/i);
    if (singleIfMatch) {
      const cond = translateCondition(singleIfMatch[1], assignedVars);
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

    // Select Case — try to translate, fall back to comment
    if (/^Select\s+Case\b/i.test(line)) {
      const result = parseSelectCaseBlock(lines, i, formName, variables, assignedVars);
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
      const result = parseForLoop(lines, i, formName, variables, assignedVars);
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
  translateAssignmentRHS, parseSelectCaseBlock, parseForLoop,
};
