/**
 * LLM prompt templates for 5-step form generation pipeline.
 * Each function returns the system + user messages for one step.
 */

const PROPS_INTERFACE = `
interface GeneratedFormProps {
  definition: FormDefinition;
  records: Record<string, unknown>[];
  currentRecord: Record<string, unknown> | null;
  position: { current: number; total: number };
  recordDirty: boolean;
  isNewRecord: boolean;
  onFieldChange: (field: string, value: unknown) => void;
  onNavigate: (target: 'first' | 'prev' | 'next' | 'last' | 'new') => void;
  onSave: () => void;
  onDelete: () => void;
  controlState: Record<string, { visible?: boolean; enabled?: boolean; caption?: string }>;
  rowSources: Record<string, { columns: string[]; rows: unknown[][] }>;
  subformData: Record<string, { definition: any; records: unknown[]; columns: string[] }>;
  fireEvent: (controlName: string, eventKey: string) => void;
}
`.trim();

const COMMON_INSTRUCTIONS = `
RULES:
- Output ONLY the .tsx file content. No markdown fences, no explanation.
- The component must be the default export.
- Import React and GeneratedFormProps:
  import type { GeneratedFormProps } from '../../types';
- The component signature is: export default function GeneratedForm(props: GeneratedFormProps)
- Use inline styles for all positioning and colors — no CSS classes except for the outermost container which uses className="form-canvas view-mode".

DATA FORMAT — CRITICAL:
- All dimensions (x, y, width, height, section heights) are ALREADY IN PIXELS. Do NOT divide by 15 or apply any conversion. Use values directly.
- Positions use "x" and "y" properties (not "left"/"top").
- Colors are ALREADY HEX STRINGS like "#ffffff", "#4472c4". Use them directly in CSS. Do NOT apply any BGR conversion.
- Font sizes are in POINTS (e.g. font-size: 11 means 11pt). Convert to CSS: fontSize: '11pt' or use px equivalent (points * 1.33).
- Text/caption is in the "text" property (not "caption"). Some controls use "caption" — check both.
- For captions with & markers (e.g. "&Login"), render the letter after & with <u> tags: <u>L</u>ogin. Double && means literal &.
`.trim();

const REFERENCE_EXAMPLE = `
REFERENCE EXAMPLE — a simple form with one label and one text box:

import type { GeneratedFormProps } from '../../types';

export default function GeneratedForm(props: GeneratedFormProps) {
  const { currentRecord, position, recordDirty, onFieldChange, onNavigate, onSave, onDelete, controlState, fireEvent } = props;
  const rec = currentRecord || {};

  return (
    <div className="form-canvas view-mode">
      <div style={{ position: 'relative', width: 500 }}>
        {/* Detail section */}
        <div style={{ position: 'relative', height: 200, backgroundColor: '#e6e6e6' }}>
          {/* Label — note: x/y used directly as left/top in pixels */}
          <span style={{ position: 'absolute', left: 20, top: 14, width: 100, height: 20, fontSize: '10pt', color: '#000000' }}>
            Full Name
          </span>
          {/* Text box */}
          <input
            type="text"
            style={{ position: 'absolute', left: 130, top: 14, width: 200, height: 20, fontSize: '10pt' }}
            value={String(rec['full_name'] ?? '')}
            onChange={e => onFieldChange('full_name', e.target.value)}
          />
        </div>
        {/* Nav bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px', borderTop: '1px solid #999', fontSize: 11 }}>
          <span>Record:</span>
          <button disabled={position.current <= 1} onClick={() => onNavigate('first')}>|&#9664;</button>
          <button disabled={position.current <= 1} onClick={() => onNavigate('prev')}>&#9664;</button>
          <span>{position.total > 0 ? \`\${position.current} of \${position.total}\` : '0 of 0'}</span>
          <button disabled={position.current >= position.total} onClick={() => onNavigate('next')}>&#9654;</button>
          <button disabled={position.current >= position.total} onClick={() => onNavigate('last')}>&#9654;|</button>
          <button onClick={() => onNavigate('new')}>&#9654;*</button>
          <button disabled={!recordDirty} onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
`.trim();

/**
 * Step 1: Layout Shell — sections, dimensions, form-level properties.
 */
function buildStep1Prompt(formDef, formName) {
  const system = `You are a React/TypeScript code generator. You produce .tsx files for Access form components.

${COMMON_INSTRUCTIONS}

${PROPS_INTERFACE}

${REFERENCE_EXAMPLE}`;

  const formWidth = formDef['form-width'] || formDef.width || 'auto';

  const user = `Generate Step 1 (Layout Shell) for the form "${formName}".

This step creates the skeleton: form container, section divs (header/detail/footer) with correct heights and backgrounds, and optionally a RecordNavBar at the bottom.

DO NOT place any controls yet — just the empty section containers with correct dimensions and colors.

Form-level properties:
- caption: ${JSON.stringify(formDef.caption || formDef.text || formName)}
- width: ${formWidth} (pixels — use directly)
- default-view: ${JSON.stringify(formDef['default-view'] || 'Single Form')}
- popup: ${formDef.popup || 0}
- modal: ${formDef.modal || 0}
- record-selectors: ${formDef['record-selectors'] ?? 1}
- navigation-buttons: ${formDef['navigation-buttons'] ?? 1}
- scroll-bars: ${JSON.stringify(formDef['scroll-bars'] || 'both')}
- back-color: ${JSON.stringify(formDef['back-color'] || 'none')} (already a hex string or 'none')
- allow-additions: ${formDef['allow-additions'] ?? 1}
- allow-deletions: ${formDef['allow-deletions'] ?? 1}
- allow-edits: ${formDef['allow-edits'] ?? 1}
- record-source: ${JSON.stringify(formDef['record-source'] || null)}

Sections (heights are in PIXELS — use directly):
- header: height=${formDef.header?.height || 0}, visible=${formDef.header?.visible ?? 1}, back-color=${JSON.stringify(formDef.header?.['back-color'] || 'none')}, controls=${formDef.header?.controls?.length || 0}
- detail: height=${formDef.detail?.height || 0}, visible=${formDef.detail?.visible ?? 1}, back-color=${JSON.stringify(formDef.detail?.['back-color'] || 'none')}, controls=${formDef.detail?.controls?.length || 0}
- footer: height=${formDef.footer?.height || 0}, visible=${formDef.footer?.visible ?? 1}, back-color=${JSON.stringify(formDef.footer?.['back-color'] || 'none')}, controls=${formDef.footer?.controls?.length || 0}

${formDef.popup ? 'This is a POPUP form — wrap the content in a popup window with title bar showing the caption and a close button. ' : ''}${formDef.modal ? 'It is also MODAL — add a backdrop overlay behind the popup.' : ''}

${formDef['navigation-buttons'] === 0 ? 'navigation-buttons is 0 — do NOT render a RecordNavBar.' : 'Include the RecordNavBar at the bottom (wired to props.onNavigate, props.onSave, etc.).'}

${formDef['record-source'] ? '' : 'This form has NO record-source — it is an unbound form (like a dialog/login). No record navigation needed.'}

If default-view is "Continuous Forms", the detail section should have a comment noting it will repeat per record (actual iteration added in step 3).`;

  return { system, user };
}

/**
 * Step 2: Place Controls — all controls with absolute positioning and styling.
 */
function buildStep2Prompt(formDef, formName, previousTsx) {
  const system = `You are a React/TypeScript code generator. You produce .tsx files for Access form components.

${COMMON_INSTRUCTIONS}

${PROPS_INTERFACE}

Control type → HTML element mapping:
- label → <span> (display text from "text" property, never editable)
- text-box → <input type="text"> (or <textarea> if multi-line)
- button / command-button → <button> (display text from "text" property)
- combo-box → <select> with placeholder option
- list-box → <select multiple>
- check-box → <input type="checkbox"> with associated label span
- option-group → <div> containing option-button children
- option-button → <input type="radio">
- toggle-button → <button> with pressed/unpressed state
- tab-control → <div> with tab headers and pages
- image / object-frame → <img> or empty div with border
- rectangle → <div> with border, pointer-events: none, z-index: 0
- line → <div> with border-top or border-left, pointer-events: none, z-index: 0
- subform → <div> with border and "subform: {source-object}" placeholder text
- page-break → <div> with border-bottom dashed

For each control:
- Position: position: 'absolute', left: x, top: y, width: width, height: height (ALL IN PIXELS — use directly)
- Font: fontFamily from font-name, fontSize in pt from font-size (e.g. '11pt'), fontWeight (700 if font-weight >= 700)
- Colors: color from fore-color, backgroundColor from back-color — THESE ARE ALREADY HEX STRINGS, use directly
- For labels: back-color is often "#ffffff" (white) and the label is meant to be transparent (no background). Only set backgroundColor if back-style is explicitly 1.
- border-style: 0=transparent (no border), 1=solid; border-color already hex
- special-effect: 0=flat, 1=raised, 2=sunken, 3=etched — use box-shadow or border styles
- visible: if visible===0 or visible===false, don't render the control`;

  const controlsJson = JSON.stringify(extractControlsSummary(formDef), null, 2);

  const user = `Generate Step 2 (Place Controls) for the form "${formName}".

Take the Step 1 output below and ADD all controls to their correct sections with proper positioning and styling. Keep the existing layout shell intact.

IMPORTANT REMINDERS:
- x/y/width/height are PIXELS — use directly as left/top/width/height in CSS
- Colors are hex strings — use directly
- font-size is in points — use as '${'{'}size}pt' in CSS
- Controls are display-only for now. Don't wire onChange or value yet (that's steps 3-4).

PREVIOUS STEP OUTPUT:
${previousTsx}

CONTROLS TO PLACE:
${controlsJson}

Place each control inside its parent section div using absolute positioning.`;

  return { system, user };
}

/**
 * Step 3: Record Source — data loading integration.
 */
function buildStep3Prompt(formDef, formName, previousTsx, schemaContext) {
  const system = `You are a React/TypeScript code generator. You produce .tsx files for Access form components.

${COMMON_INSTRUCTIONS}

${PROPS_INTERFACE}`;

  const recordSource = formDef['record-source'] || '';
  const defaultView = formDef['default-view'] || 'Single Form';
  const isContinuous = defaultView === 'Continuous Forms';

  let schemaInfo = '';
  if (schemaContext && recordSource) {
    const rsLower = recordSource.toLowerCase();
    const matchingTable = schemaContext.tables?.find(t => t.name.toLowerCase() === rsLower);
    const matchingView = schemaContext.views?.find(v => v.name.toLowerCase() === rsLower);
    const source = matchingTable || matchingView;
    if (source) {
      schemaInfo = `\nAvailable columns in "${source.name}": ${source.columns.map(c => `${c.name} (${c.type})`).join(', ')}`;
    }
  }

  const user = `Generate Step 3 (Record Source) for the form "${formName}".

Take the Step 2 output and wire up the record source. The form's record-source is: ${JSON.stringify(recordSource || null)}.
Default view: "${defaultView}"
${schemaInfo}

${!recordSource ? `This form has NO record-source — it is an unbound form. Do NOT add record navigation or data loading logic. Just keep the Step 2 output as-is with minimal changes (destructure props for later steps).` : `Changes to make:
1. Destructure props: records, currentRecord, position from props
2. Use \`const rec = currentRecord || {};\` for field access
3. Display field values in the appropriate text-box, combo-box, check-box etc. controls using rec['field_name'] ?? ''
4. ${isContinuous
    ? 'This is a CONTINUOUS FORM: the detail section should iterate over props.records, rendering one detail row per record. The header renders once above, footer once below. Highlight the selected row (where index+1 === position.current).'
    : 'This is a SINGLE FORM: show one record at a time from currentRecord.'}
5. Wire the RecordNavBar to show position.current / position.total and call onNavigate.`}

PREVIOUS STEP OUTPUT:
${previousTsx}`;

  return { system, user };
}

/**
 * Step 4: Wire Bindings — field values, onChange handlers, row sources.
 */
function buildStep4Prompt(formDef, formName, previousTsx, schemaContext) {
  const system = `You are a React/TypeScript code generator. You produce .tsx files for Access form components.

${COMMON_INSTRUCTIONS}

${PROPS_INTERFACE}`;

  // Build field→column mapping
  const fieldMap = extractFieldBindings(formDef);

  // Build row-source controls
  const rowSourceControls = extractRowSourceControls(formDef);

  // Build subform controls
  const subformControls = extractSubformControls(formDef);

  const user = `Generate Step 4 (Wire Bindings) for the form "${formName}".

Take the Step 3 output and make controls fully interactive:

1. FIELD BINDINGS — for each bound control, wire value + onChange:
${fieldMap.map(f => `   - Control "${f.name}" (${f.type}) → field "${f.field}"`).join('\n') || '   (no bound controls)'}

   For text-box: value={String(rec['field'] ?? '')} onChange={e => onFieldChange('field', e.target.value)}
   For check-box: checked={Boolean(rec['field'])} onChange={e => onFieldChange('field', e.target.checked ? 1 : 0)}
   For combo-box: value={String(rec['field'] ?? '')} onChange={e => onFieldChange('field', e.target.value)}
   Field lookups must be CASE-INSENSITIVE: use a helper like \`const f = (name: string) => { const key = Object.keys(rec).find(k => k.toLowerCase() === name.toLowerCase()); return key ? rec[key] : ''; };\`

2. ROW SOURCES — for combo-box/list-box controls, populate options from props.rowSources:
${rowSourceControls.map(r => `   - Control "${r.name}" → rowSource key "${r.rowSource}" (bound-column: ${r.boundColumn}, column-count: ${r.columnCount})`).join('\n') || '   (no row-source controls)'}
   Pattern: const rs = props.rowSources['key']; if (rs) rs.rows.map((row: any[], i: number) => <option key={i} value={String(row[boundCol-1] ?? '')}>{String(row[displayCol] ?? '')}</option>)
   IMPORTANT: Cast row elements to String() to avoid TypeScript errors with unknown types.

3. SUBFORMS — for subform controls, render from props.subformData:
${subformControls.map(s => `   - Control "${s.name}" → sourceObject "${s.sourceObject}", linkMaster="${s.linkMaster}", linkChild="${s.linkChild}"`).join('\n') || '   (no subform controls)'}

4. CONTROL STATE — apply props.controlState overrides:
   For each control, check if controlState[controlName] exists. If so:
   - If visible === false, don't render
   - If enabled === false, add disabled attribute
   - If caption is set, use it instead of the original caption

5. Allow-edits: ${formDef['allow-edits'] ?? 1}. If 0, all inputs should be readOnly/disabled.

PREVIOUS STEP OUTPUT:
${previousTsx}`;

  return { system, user };
}

/**
 * Step 5: Event Code — wire VBA-to-JS handlers.
 */
function buildStep5Prompt(formDef, formName, previousTsx, jsHandlers) {
  const system = `You are a React/TypeScript code generator. You produce .tsx files for Access form components.

${COMMON_INSTRUCTIONS}

${PROPS_INTERFACE}`;

  // Format handlers for the prompt
  const handlerList = [];
  if (jsHandlers) {
    for (const [key, handler] of Object.entries(jsHandlers)) {
      if (handler && handler.js) {
        handlerList.push({ key, event: handler.event, control: handler.control || '(form-level)', js: handler.js });
      }
    }
  }

  // Form-level event properties from definition
  const formEvents = [];
  for (const prop of ['has-load-event', 'has-current-event', 'on-load', 'on-current', 'on-open', 'on-close', 'before-update', 'after-update']) {
    if (formDef[prop]) formEvents.push(prop);
  }

  const user = `Generate Step 5 (Event Code) for the form "${formName}".

Take the Step 4 output and wire event handlers.

APPROACH: Use props.fireEvent(controlName, eventKey) for ALL events. The wrapper handles JS execution.

1. CONTROL EVENTS — for each control with event properties (on-click, after-update, on-enter, etc.), call props.fireEvent:
   - Button on-click: onClick={() => fireEvent('btnName', 'on-click')}
   - Text-box after-update: onBlur={() => fireEvent('txtName', 'after-update')} (fire on blur)
   - Checkbox after-update: in the onChange handler, also call fireEvent
   - Focus events: onFocus/onBlur handlers

2. FORM-LEVEL EVENTS — use useEffect for on-load and on-current:
${formEvents.length > 0 ? formEvents.map(e => `   - ${e}`).join('\n') : '   (no form-level events)'}
   Pattern:
   useEffect(() => { fireEvent('', 'on-load'); }, []);

3. AVAILABLE JS HANDLERS (for reference — these are executed by fireEvent, not inlined):
${handlerList.length > 0 ? handlerList.map(h => `   - ${h.key}: ${h.control}.${h.event}`).join('\n') : '   (no JS handlers found)'}

Controls that have event properties in the definition:
${extractEventControls(formDef).map(e => `   - "${e.name}" has: ${e.events.join(', ')}`).join('\n') || '   (none)'}

PREVIOUS STEP OUTPUT:
${previousTsx}`;

  return { system, user };
}

// ============================================================
// Helper functions to extract info from form definitions
// ============================================================

function extractControlsSummary(formDef) {
  const result = {};
  for (const section of ['header', 'detail', 'footer']) {
    const controls = formDef[section]?.controls || [];
    if (controls.length > 0) {
      result[section] = controls.map(ctrl => {
        const summary = {
          name: ctrl.name,
          type: ctrl.type,
          // Support both x/y and left/top property names
          x: ctrl.x ?? ctrl.left,
          y: ctrl.y ?? ctrl.top,
          width: ctrl.width,
          height: ctrl.height,
        };
        // Text/caption — check both property names
        if (ctrl.text) summary.text = ctrl.text;
        if (ctrl.caption) summary.caption = ctrl.caption;
        if (ctrl.field) summary.field = ctrl.field;
        if (ctrl['control-source']) summary['control-source'] = ctrl['control-source'];
        if (ctrl['font-name']) summary['font-name'] = ctrl['font-name'];
        if (ctrl['font-size']) summary['font-size'] = ctrl['font-size'];
        if (ctrl['font-weight']) summary['font-weight'] = ctrl['font-weight'];
        if (ctrl['font-italic']) summary['font-italic'] = ctrl['font-italic'];
        if (ctrl['fore-color'] != null) summary['fore-color'] = ctrl['fore-color'];
        if (ctrl['back-color'] != null) summary['back-color'] = ctrl['back-color'];
        if (ctrl['back-style'] != null) summary['back-style'] = ctrl['back-style'];
        if (ctrl['border-style'] != null) summary['border-style'] = ctrl['border-style'];
        if (ctrl['border-color'] != null) summary['border-color'] = ctrl['border-color'];
        if (ctrl['text-align'] != null) summary['text-align'] = ctrl['text-align'];
        if (ctrl['special-effect'] != null) summary['special-effect'] = ctrl['special-effect'];
        if (ctrl.visible === 0 || ctrl.visible === false) summary.visible = 0;
        if (ctrl.enabled === 0 || ctrl.enabled === false) summary.enabled = 0;
        if (ctrl['row-source']) summary['row-source'] = ctrl['row-source'];
        if (ctrl['row-source-type']) summary['row-source-type'] = ctrl['row-source-type'];
        if (ctrl['bound-column']) summary['bound-column'] = ctrl['bound-column'];
        if (ctrl['column-count']) summary['column-count'] = ctrl['column-count'];
        if (ctrl['column-widths']) summary['column-widths'] = ctrl['column-widths'];
        if (ctrl['source-object']) summary['source-object'] = ctrl['source-object'];
        if (ctrl['link-child-fields']) summary['link-child-fields'] = ctrl['link-child-fields'];
        if (ctrl['link-master-fields']) summary['link-master-fields'] = ctrl['link-master-fields'];
        if (ctrl.pages) summary.pages = ctrl.pages.map(p => ({
          name: p.name,
          caption: p.caption || p.text,
          controls: (p.controls || []).length
        }));
        if (ctrl.picture) summary.picture = ctrl.picture;
        if (ctrl['size-mode'] != null) summary['size-mode'] = ctrl['size-mode'];
        // Event properties — include both has-*-event and on-* forms
        for (const evt of ['on-click', 'on-dbl-click', 'after-update', 'before-update', 'on-enter', 'on-exit', 'on-got-focus', 'on-lost-focus', 'on-change',
                           'has-click-event', 'has-after-update-event', 'has-dbl-click-event']) {
          if (ctrl[evt]) summary[evt] = ctrl[evt];
        }
        return summary;
      });
    }
  }
  return result;
}

function extractFieldBindings(formDef) {
  const bindings = [];
  for (const section of ['header', 'detail', 'footer']) {
    for (const ctrl of formDef[section]?.controls || []) {
      const field = ctrl.field || ctrl['control-source'];
      if (field && !field.startsWith('=')) {
        bindings.push({ name: ctrl.name, type: ctrl.type, field });
      }
    }
  }
  return bindings;
}

function extractRowSourceControls(formDef) {
  const controls = [];
  for (const section of ['header', 'detail', 'footer']) {
    for (const ctrl of formDef[section]?.controls || []) {
      if (ctrl['row-source'] && (ctrl.type === 'combo-box' || ctrl.type === 'list-box')) {
        controls.push({
          name: ctrl.name,
          type: ctrl.type,
          rowSource: ctrl['row-source'],
          boundColumn: ctrl['bound-column'] || 1,
          columnCount: ctrl['column-count'] || 1,
        });
      }
    }
  }
  return controls;
}

function extractSubformControls(formDef) {
  const controls = [];
  for (const section of ['header', 'detail', 'footer']) {
    for (const ctrl of formDef[section]?.controls || []) {
      if (ctrl.type === 'subform' && ctrl['source-object']) {
        controls.push({
          name: ctrl.name,
          sourceObject: ctrl['source-object'],
          linkMaster: ctrl['link-master-fields'] || '',
          linkChild: ctrl['link-child-fields'] || '',
        });
      }
    }
  }
  return controls;
}

function extractEventControls(formDef) {
  const eventProps = ['on-click', 'on-dbl-click', 'after-update', 'before-update', 'on-enter', 'on-exit', 'on-got-focus', 'on-lost-focus', 'on-change',
                      'has-click-event', 'has-after-update-event', 'has-dbl-click-event'];
  const controls = [];
  for (const section of ['header', 'detail', 'footer']) {
    for (const ctrl of formDef[section]?.controls || []) {
      const events = eventProps.filter(e => ctrl[e]);
      if (events.length > 0) {
        controls.push({ name: ctrl.name, events });
      }
    }
  }
  return controls;
}

module.exports = {
  buildStep1Prompt,
  buildStep2Prompt,
  buildStep3Prompt,
  buildStep4Prompt,
  buildStep5Prompt,
};
