/**
 * Form and report definition normalization.
 * Coerces types, applies defaults, and normalizes control properties
 * on load — so downstream code can safely assume consistent types.
 *
 * Ported from state_form.cljs normalize-form-definition and
 * state_report.cljs normalize-report-definition.
 */

import type { FormDefinition, ReportDefinition, Control, Section, ControlType } from '@/api/types';

// ============================================================
// Coercion helpers
// ============================================================

/** Coerce any truthy/falsy value to 1 or 0. */
export function coerceYesNo(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v === 0 ? 0 : 1;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return ['true', 'yes', '1'].includes(v.toLowerCase()) ? 1 : 0;
  return 1;
}

/** Coerce a value to number. null→null, number→number, string→parseFloat, else→null. */
export function coerceToNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? null : n; }
  return null;
}

/** Coerce a value to a ControlType string (the "keyword" equivalent in TS). */
export function coerceToControlType(v: unknown): ControlType {
  if (!v) return 'text-box';
  const s = String(v).replace(/^:/, '');
  return s as ControlType;
}

// ============================================================
// Control normalization
// ============================================================

const YES_NO_CONTROL_PROPS = ['visible', 'enabled', 'locked', 'tab-stop'] as const;
const YES_NO_CONTROL_DEFAULTS: Record<string, number> = {
  visible: 1, enabled: 1, locked: 0, 'tab-stop': 1,
};

const NUMBER_CONTROL_PROPS = ['width', 'height', 'x', 'y', 'font-size', 'tab-index', 'left', 'top'] as const;

/** Normalize a single control: coerce type to string, yes/no and number props. */
export function normalizeControl(ctrl: Record<string, unknown>): Control {
  // Coerce :type to ControlType string
  ctrl.type = coerceToControlType(ctrl.type);

  // Yes/no props with defaults
  for (const prop of YES_NO_CONTROL_PROPS) {
    const v = ctrl[prop];
    ctrl[prop] = v == null ? (YES_NO_CONTROL_DEFAULTS[prop] ?? 0) : coerceYesNo(v);
  }

  // Number props
  for (const prop of NUMBER_CONTROL_PROPS) {
    if (prop in ctrl) {
      ctrl[prop] = coerceToNumber(ctrl[prop]);
    }
  }

  return ctrl as unknown as Control;
}

// ============================================================
// Section normalization
// ============================================================

function normalizeSection(section: Record<string, unknown>): Section {
  if (section.controls && Array.isArray(section.controls)) {
    section.controls = (section.controls as Record<string, unknown>[]).map(normalizeControl);
  }
  return section as unknown as Section;
}

// ============================================================
// Form normalization
// ============================================================

const YES_NO_FORM_PROPS = [
  'popup', 'modal', 'allow-additions', 'allow-deletions', 'allow-edits',
  'navigation-buttons', 'record-selectors', 'dividing-lines', 'data-entry',
] as const;

const YES_NO_FORM_DEFAULTS: Record<string, number> = {
  popup: 0, modal: 0, 'allow-additions': 1, 'allow-deletions': 1, 'allow-edits': 1,
  'navigation-buttons': 1, 'record-selectors': 1, 'dividing-lines': 1, 'data-entry': 0,
};

const NUMBER_FORM_PROPS = ['width'] as const;

/** Normalize a form definition: coerce all types and apply defaults. */
export function normalizeFormDefinition(def: Record<string, unknown>): FormDefinition {
  // Yes/no form props
  for (const prop of YES_NO_FORM_PROPS) {
    const v = def[prop];
    def[prop] = v == null ? (YES_NO_FORM_DEFAULTS[prop] ?? 0) : coerceYesNo(v);
  }

  // Number form props
  for (const prop of NUMBER_FORM_PROPS) {
    if (prop in def) {
      def[prop] = coerceToNumber(def[prop]);
    }
  }

  // Normalize sections
  if (def.header) def.header = normalizeSection(def.header as Record<string, unknown>);
  if (def.detail) def.detail = normalizeSection(def.detail as Record<string, unknown>);
  if (def.footer) def.footer = normalizeSection(def.footer as Record<string, unknown>);

  // Lowercase record-source
  if (typeof def['record-source'] === 'string') {
    def['record-source'] = (def['record-source'] as string).toLowerCase();
  }

  return def as unknown as FormDefinition;
}

// ============================================================
// Report normalization
// ============================================================

/** Normalize a report definition: coerce types across all banded sections. */
export function normalizeReportDefinition(def: Record<string, unknown>): ReportDefinition {
  // Number props
  if ('width' in def) def.width = coerceToNumber(def.width);

  // Standard band sections
  const standardBands = ['report-header', 'page-header', 'detail', 'page-footer', 'report-footer'];
  for (const band of standardBands) {
    if (def[band]) def[band] = normalizeSection(def[band] as Record<string, unknown>);
  }

  // Dynamic group bands
  for (const key of Object.keys(def)) {
    if (/^group-(header|footer)-\d+$/.test(key) && def[key]) {
      def[key] = normalizeSection(def[key] as Record<string, unknown>);
    }
  }

  // Lowercase record-source
  if (typeof def['record-source'] === 'string') {
    def['record-source'] = (def['record-source'] as string).toLowerCase();
  }

  return def as unknown as ReportDefinition;
}
