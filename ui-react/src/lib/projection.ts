/**
 * Pure data projection for forms. Separates data concerns (record, bindings,
 * computed fields, row-sources, events) from UI rendering.
 *
 * Ported from projection.cljs (373 lines).
 */

import { evaluateExpression, isExpression } from './expressions';
import { ctrlToKey } from './utils';
import type { FormDefinition, Control, Section, ControlType } from '@/api/types';

// ============================================================
// TYPES
// ============================================================

export interface FieldBinding {
  value: unknown;
}

export interface ComputedSpec {
  expression: string;
  deps: Set<string>;
  value?: unknown;
}

export interface RowSourceSpec {
  source: string;
  type: 'sql' | 'value-list' | 'query';
  boundCol: number;
  colWidths: number[] | null;
  options: { rows: Record<string, unknown>[]; fields: { name: string }[] } | null;
}

export interface SubformSpec {
  link: { master: string | null; child: string | null };
}

export interface ControlState {
  visible: boolean;
  enabled: boolean;
  locked: boolean;
  caption: string | null;
}

export interface Reaction {
  ctrl: string;
  prop: keyof ControlState;
  valueFn: (fieldVal: unknown, record: Record<string, unknown>) => unknown;
}

export interface EventHandler {
  key: string;
  control?: string;
  event?: string;
  js?: string;
  intents?: unknown[];
}

export interface ProjectionData {
  recordSource: string | undefined;
  record: Record<string, unknown>;
  bindings: Record<string, unknown>;
  computed: Record<string, ComputedSpec>;
  rowSources: Record<string, RowSourceSpec>;
  subforms: Record<string, SubformSpec>;
  events: Record<string, boolean>;
  fieldTriggers: Record<string, Record<string, boolean>>;
  controlState: Record<string, ControlState>;
  reactions: Record<string, Reaction[]>;
  eventHandlers: Record<string, EventHandler>;
  records: Record<string, unknown>[];
  position: number;
  total: number;
  dirty: boolean;
}

// ============================================================
// HELPERS
// ============================================================

function scanControls(definition: FormDefinition): Control[] {
  const controls: Control[] = [];
  for (const section of ['header', 'detail', 'footer'] as const) {
    const sec = definition[section] as Section | undefined;
    if (sec?.controls) controls.push(...sec.controls);
  }
  return controls;
}

function extractFieldRefs(exprStr: string): Set<string> {
  const matches = exprStr.match(/\[([^\]]+)\]/g) || [];
  const names = matches.map(m => m.slice(1, -1));
  return new Set(
    names
      .filter(n => !['Forms', 'TempVars', 'Form'].includes(n))
      .filter(n => !exprStr.includes(`[${n}].[`))
      .map(n => n.toLowerCase())
  );
}

// ============================================================
// EXTRACTORS
// ============================================================

function extractBindings(controls: Control[]): { bindings: Record<string, unknown>; computed: Record<string, ComputedSpec> } {
  const bindings: Record<string, unknown> = {};
  const computed: Record<string, ComputedSpec> = {};

  for (const ctrl of controls) {
    const rawField = ctrl['control-source'] || ctrl.field;
    if (!rawField || typeof rawField !== 'string' || !rawField.trim()) continue;

    if (isExpression(rawField)) {
      const ctrlName = (ctrl.name || '').toLowerCase();
      const exprBody = (rawField as string).slice(1);
      computed[ctrlName] = { expression: exprBody, deps: extractFieldRefs(exprBody) };
    } else {
      bindings[(rawField as string).toLowerCase()] = null;
    }
  }

  return { bindings, computed };
}

function extractRowSources(controls: Control[]): Record<string, RowSourceSpec> {
  const result: Record<string, RowSourceSpec> = {};

  for (const ctrl of controls) {
    if (!ctrl['row-source'] || !['combo-box', 'list-box'].includes(ctrl.type)) continue;

    const fieldKey = (ctrl.field || ctrl.name || '').toLowerCase();
    const trimmed = (ctrl['row-source'] as string).trim();
    const rsType: 'sql' | 'value-list' | 'query' =
      /^select\s/i.test(trimmed) ? 'sql'
      : trimmed.includes(';') ? 'value-list'
      : 'query';

    const colWidths = ctrl['column-widths']
      ? String(ctrl['column-widths']).split(/[;,]/).map(s => parseInt(s, 10))
      : null;

    let options: RowSourceSpec['options'] = null;
    if (rsType === 'value-list') {
      const items = trimmed.split(';').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^"|"$/g, ''));
      options = { rows: items.map(v => ({ value: v })), fields: [{ name: 'value' }] };
    }

    result[fieldKey] = { source: trimmed, type: rsType, boundCol: ctrl['bound-column'] ?? 1, colWidths, options };
  }

  return result;
}

function extractSubforms(controls: Control[]): Record<string, SubformSpec> {
  const result: Record<string, SubformSpec> = {};

  for (const ctrl of controls) {
    if (ctrl.type !== 'sub-form') continue;
    const sf = (ctrl as Record<string, unknown>)['source-form'] as string
      || (ctrl as Record<string, unknown>)['source_form'] as string
      || '';
    const sfName = sf.toLowerCase();
    result[sfName] = {
      link: {
        master: ctrl['link-master-fields'] || (ctrl as Record<string, unknown>)['link_master_fields'] as string || null,
        child: ctrl['link-child-fields'] || (ctrl as Record<string, unknown>)['link_child_fields'] as string || null,
      },
    };
  }

  return result;
}

const FORM_EVENT_FLAGS = [
  'has-load-event', 'has-open-event', 'has-close-event', 'has-current-event',
  'has-before-insert-event', 'has-after-insert-event',
  'has-before-update-event', 'has-after-update-event',
  'has-delete-event',
];

function extractEvents(definition: FormDefinition): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const flag of FORM_EVENT_FLAGS) {
    if ((definition as Record<string, unknown>)[flag]) result[flag] = true;
  }
  return result;
}

const CONTROL_EVENT_FLAGS = [
  'has-click-event', 'has-dblclick-event', 'has-change-event',
  'has-enter-event', 'has-exit-event',
  'has-before-update-event', 'has-after-update-event',
  'has-gotfocus-event', 'has-lostfocus-event',
];

function extractFieldTriggers(controls: Control[]): Record<string, Record<string, boolean>> {
  const result: Record<string, Record<string, boolean>> = {};

  for (const ctrl of controls) {
    const ctrlName = (ctrl.name || ctrl.field || '').toLowerCase();
    const flags: Record<string, boolean> = {};
    for (const flag of CONTROL_EVENT_FLAGS) {
      if ((ctrl as Record<string, unknown>)[flag]) flags[flag] = true;
    }
    if (Object.keys(flags).length > 0) result[ctrlName] = flags;
  }

  return result;
}

function extractControlState(controls: Control[]): Record<string, ControlState> {
  const result: Record<string, ControlState> = {};

  for (const ctrl of controls) {
    const ctrlName = ctrl.name || ctrl.field;
    const key = ctrlToKey(ctrlName);
    if (!key) continue;
    result[key] = {
      visible: (ctrl.visible ?? 1) !== 0,
      enabled: (ctrl.enabled ?? 1) !== 0,
      locked: ctrl.locked === 1,
      caption: ctrl.caption ?? (ctrl as Record<string, unknown>).text as string ?? null,
    };
  }

  return result;
}

// ============================================================
// PUBLIC API
// ============================================================

/** Build a projection map from a normalized form definition. */
export function buildProjection(definition: FormDefinition): ProjectionData {
  const controls = scanControls(definition);
  const { bindings, computed } = extractBindings(controls);

  return {
    recordSource: definition['record-source'],
    record: {},
    bindings,
    computed,
    rowSources: extractRowSources(controls),
    subforms: extractSubforms(controls),
    events: extractEvents(definition),
    fieldTriggers: extractFieldTriggers(controls),
    controlState: extractControlState(controls),
    reactions: {},
    eventHandlers: {},
    records: [],
    position: 0,
    total: 0,
    dirty: false,
  };
}

/** Evaluate all computed fields using current bindings as record context. */
function evaluateComputed(proj: ProjectionData): ProjectionData {
  for (const [ctrlKey, spec] of Object.entries(proj.computed)) {
    proj.computed[ctrlKey] = {
      ...spec,
      value: evaluateExpression(spec.expression, { record: proj.bindings }),
    };
  }
  return proj;
}

/** Re-evaluate only computed fields whose deps intersect changedFields. */
function evaluateComputedFor(proj: ProjectionData, changedFields: Set<string>): ProjectionData {
  for (const [ctrlKey, spec] of Object.entries(proj.computed)) {
    const hasOverlap = [...spec.deps].some(d => changedFields.has(d));
    if (hasOverlap) {
      proj.computed[ctrlKey] = {
        ...spec,
        value: evaluateExpression(spec.expression, { record: proj.bindings }),
      };
    }
  }
  return proj;
}

/** Fire reactions for changedFields, apply results to control-state. */
function settleReactions(proj: ProjectionData, changedFields: Set<string>): ProjectionData {
  if (Object.keys(proj.reactions).length === 0) return proj;

  for (const triggerKey of changedFields) {
    const entries = proj.reactions[triggerKey];
    if (!entries) continue;
    const fieldVal = proj.record[triggerKey];
    for (const entry of entries) {
      const result = entry.valueFn(fieldVal, proj.record);
      if (result != null && proj.controlState[entry.ctrl]) {
        (proj.controlState[entry.ctrl] as unknown as Record<string, unknown>)[entry.prop] = result;
      }
    }
  }

  return proj;
}

/** Fill binding values from a record map. Case-insensitive lookup. */
export function hydrateBindings(proj: ProjectionData, record: Record<string, unknown>): ProjectionData {
  if (!record || typeof record !== 'object') return proj;

  // Build lowercase record
  const recordLc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    recordLc[k.toLowerCase()] = v;
  }

  proj.record = recordLc;
  for (const key of Object.keys(proj.bindings)) {
    proj.bindings[key] = recordLc[key];
  }

  evaluateComputed(proj);
  settleReactions(proj, new Set(Object.keys(proj.reactions)));
  return proj;
}

/** Update a field in bindings and record, re-evaluate affected computed fields. */
export function updateField(proj: ProjectionData, fieldKey: string, value: unknown): ProjectionData {
  proj.bindings[fieldKey] = value;
  proj.record[fieldKey] = value;
  proj.dirty = true;
  evaluateComputedFor(proj, new Set([fieldKey]));
  settleReactions(proj, new Set([fieldKey]));
  return proj;
}

/** Assoc records, position, total, then hydrate bindings at position. */
export function syncRecords(proj: ProjectionData, records: Record<string, unknown>[], position: number, total: number): ProjectionData {
  proj.records = records;
  proj.position = position;
  proj.total = total;
  const idx = position - 1;
  if (position > 0 && idx < records.length) {
    return hydrateBindings(proj, records[idx]);
  }
  return proj;
}

/** Update position and re-hydrate bindings from stored records. */
export function syncPosition(proj: ProjectionData, position: number): ProjectionData {
  proj.position = position;
  const idx = position - 1;
  if (position > 0 && idx < proj.records.length) {
    return hydrateBindings(proj, proj.records[idx]);
  }
  return proj;
}

/** Set row-source options data. */
export function populateRowSource(proj: ProjectionData, sourceStr: string, data: RowSourceSpec['options']): ProjectionData {
  for (const [key, spec] of Object.entries(proj.rowSources)) {
    if (spec.source === sourceStr) {
      proj.rowSources[key] = { ...spec, options: data };
      break;
    }
  }
  return proj;
}

/** Set a mutable property on a control in the projection. */
export function setControlState(proj: ProjectionData, ctrlKey: string, prop: keyof ControlState, value: unknown): ProjectionData {
  if (proj.controlState[ctrlKey]) {
    (proj.controlState[ctrlKey] as unknown as Record<string, unknown>)[prop] = value;
  }
  return proj;
}

/** Register a reaction. */
export function registerReaction(
  proj: ProjectionData,
  triggerKey: string,
  ctrlKey: string,
  propKey: keyof ControlState,
  valueFn: (fieldVal: unknown, record: Record<string, unknown>) => unknown,
): ProjectionData {
  if (!proj.reactions[triggerKey]) proj.reactions[triggerKey] = [];
  proj.reactions[triggerKey].push({ ctrl: ctrlKey, prop: propKey, valueFn });
  return proj;
}

/** Merge handler descriptors into the projection's event-handlers map. */
export function registerEventHandlers(proj: ProjectionData, handlers: EventHandler[]): ProjectionData {
  for (const h of handlers) {
    proj.eventHandlers[h.key] = h;
  }
  return proj;
}

/** Look up an event handler by control name and event key. */
export function getEventHandler(proj: ProjectionData, controlName: string, event: string): EventHandler | null {
  const key = `${ctrlToKey(controlName)}.${event}`;
  return proj.eventHandlers[key] || null;
}
