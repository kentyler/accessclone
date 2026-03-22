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
 * - Line numbers (10, 20, 30...)
 * - On Error GoTo / Resume / Exit Sub
 * - Error handler blocks (Err_Handler: ... End Sub)
 * - Labels (Exit_Handler:, Err_Handler:)
 * Returns cleaned lines (only the meaningful statements).
 */
function stripBoilerplate(body) {
  const lines = body.split(/\r?\n/);
  const cleaned = [];
  let inErrorHandler = false;

  for (const rawLine of lines) {
    let line = rawLine.trim();

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
 */
function translateStatement(stmt) {
  // DoCmd.Close acForm, Me.Name  or  DoCmd.Close
  if (/^DoCmd\.Close\b/i.test(stmt)) {
    return 'AC.closeForm()';
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
    return 'AC.closeForm()';
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
 * Parse VBA source and return handler descriptors with JS code.
 * Returns [{key, control, event, procedure, js}]
 */
function parseVbaToHandlers(vbaSource) {
  if (!vbaSource) return [];

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

    // Parse the VBA body into JS statements
    const cleanLines = stripBoilerplate(proc.body);
    const jsStatements = [];
    for (const line of cleanLines) {
      const js = translateStatement(line);
      if (js) jsStatements.push(js);
    }

    // Only emit handler if we could translate at least something
    if (jsStatements.length > 0) {
      handlers.push({
        key,
        control: controlKw,
        event: eventKey,
        procedure: proc.name,
        js: jsStatements.join(';\n'),
      });
    }
  }

  return handlers;
}

module.exports = { parseVbaToHandlers, extractProcedures, stripBoilerplate, translateStatement };
