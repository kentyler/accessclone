/**
 * Shared utility functions for both form and report editors.
 * Ported from editor_utils.cljs + projection.cljs helpers.
 */

import { isExpression, evaluateExpression, type ExprContext } from './expressions';
import type { Control, ControlType } from '@/api/types';

// ============================================================
// Control name conversion
// ============================================================

/**
 * Convert a control name to kebab-case string.
 * E.g. "SubformCustomers" → "subform-customers", "OptionGroup1" → "option-group1"
 * Returns string (not keyword — eliminates the keyword/string duality bug).
 */
export function ctrlToKey(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================
// Coordinate helpers
// ============================================================

/** Snap a coordinate to the nearest grid point. If ctrlKey is true, return as-is. */
export function snapToGrid(value: number, ctrlKey: boolean, gridSize = 8): number {
  if (ctrlKey) return value;
  return gridSize * Math.round(value / gridSize);
}

/** Convert Access twips to pixels (1 twip = 1/1440 inch, 96 DPI → 15 twips/pixel). */
export function twipsToPx(twips: number): number {
  return Math.round(twips / 15);
}

// ============================================================
// Color conversion
// ============================================================

/**
 * Convert an Access BGR color integer to a CSS hex color string.
 * Access stores colors as BGR (Blue-Green-Red), not RGB.
 */
export function accessColorToHex(color: number | string | null | undefined): string {
  if (color == null) return '';
  const n = typeof color === 'string' ? parseInt(color, 10) : color;
  if (isNaN(n)) return '';
  const b = (n >> 16) & 0xFF;
  const g = (n >> 8) & 0xFF;
  const r = n & 0xFF;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Apply Access shade/tint modifiers to a hex color string.
 * shade < 100 darkens (0=black), tint < 100 lightens (0=white).
 */
export function applyShadeTint(hexColor: string, shade: number, tint: number): string {
  if (shade === 100 && tint === 100) return hexColor;
  const hex = hexColor.startsWith('#') ? hexColor.slice(1) : hexColor;
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
  if (shade < 100) {
    r *= shade / 100; g *= shade / 100; b *= shade / 100;
  }
  if (tint < 100) {
    r += (255 - r) * (100 - tint) / 100;
    g += (255 - g) * (100 - tint) / 100;
    b += (255 - b) * (100 - tint) / 100;
  }
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

// ============================================================
// Hotkey rendering
// ============================================================

/** Strip Access &-hotkey markers from caption text, returning a plain string. */
export function stripAccessHotkey(s: string): string {
  return s.replace(/&(.)/g, '$1');
}

/**
 * Extract the hotkey letter from an Access caption string.
 * Returns the lowercase letter following the first non-escaped '&', or null.
 */
export function extractHotkey(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/&([^&])/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Parse Access &-hotkey markers and return an array of segments.
 * Each segment is either a plain string or { hotkey: true, char: 'X' }.
 * The React component will render hotkey chars with underline.
 */
export type HotkeySegment = string | { hotkey: true; char: string };

export function parseHotkeyText(s: string | null | undefined): HotkeySegment[] {
  if (!s) return [''];
  const result: HotkeySegment[] = [];
  let remaining = s;
  while (remaining.length > 0) {
    const idx = remaining.indexOf('&');
    if (idx === -1) {
      result.push(remaining);
      break;
    }
    if (idx > 0) result.push(remaining.slice(0, idx));
    const after = remaining.slice(idx + 1);
    if (after.length === 0) break;
    const ch = after[0];
    if (ch === '&') {
      result.push('&');
      remaining = after.slice(1);
    } else {
      result.push({ hotkey: true, char: ch });
      remaining = after.slice(1);
    }
  }
  return result.length === 0 ? [''] : result;
}

// ============================================================
// Control style
// ============================================================

const TRANSPARENT_BY_DEFAULT = new Set<ControlType>([
  'label', 'option-button', 'check-box', 'toggle-button', 'image', 'line',
]);

/**
 * Build a position+style object for a control (layout + font + colors).
 * Uses back-style (0=Transparent, 1=Normal) when available.
 */
export function controlStyle(ctrl: Control): Record<string, unknown> {
  const backStyle = ctrl['back-style'];
  const opaque = backStyle === 1 ? true
    : backStyle === 0 ? false
    : !TRANSPARENT_BY_DEFAULT.has(ctrl.type);

  const style: Record<string, unknown> = {
    left: ctrl.left,
    top: ctrl.top,
    width: ctrl.width,
    height: ctrl.height,
  };
  if (ctrl['font-name']) style.fontFamily = ctrl['font-name'];
  if (ctrl['font-size']) style.fontSize = ctrl['font-size'];
  if (ctrl['font-weight'] === 1 || ctrl['font-weight'] === 700) style.fontWeight = 'bold';
  if (ctrl['font-italic'] === 1) style.fontStyle = 'italic';
  if (ctrl['fore-color']) style.color = ctrl['fore-color'];
  if (ctrl['back-color'] && opaque) style.backgroundColor = ctrl['back-color'];
  return style;
}

// ============================================================
// Field value resolution
// ============================================================

/**
 * Get the bound field name from a control, normalized to lowercase.
 * Checks control-source (Property Sheet) then field (drag-drop).
 * Returns the raw string (with =) for expressions.
 */
export function resolveControlField(ctrl: Control): string | null {
  const rawField = ctrl['control-source'] || ctrl.field;
  if (!rawField) return null;
  if (isExpression(rawField)) return rawField;
  return (rawField as string).toLowerCase();
}

/**
 * Look up a field's value from a record.
 * If field starts with '=', evaluates it as an Access expression.
 */
export function resolveFieldValue(
  field: string | null,
  record: Record<string, unknown>,
  exprContext?: ExprContext,
  ctrl?: Control,
): unknown {
  if (!field) return undefined;

  // Server-side computed function alias
  if (ctrl) {
    const alias = (ctrl as Record<string, unknown>)['computed-alias'] as string | undefined;
    if (alias) return record[alias] ?? record[alias.toLowerCase()] ?? '';
  }

  if (isExpression(field)) {
    return evaluateExpression(field.slice(1), { record, ...exprContext });
  }

  return record[field] ?? record[(field as string).toLowerCase()] ?? '';
}

// ============================================================
// Format / Input mask
// ============================================================

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(d: Date, fmtLower: string): string | null {
  switch (fmtLower) {
    case 'short date': return d.toLocaleDateString('en-US');
    case 'medium date': {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
    }
    case 'long date': return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    case 'short time': return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    case 'medium time': return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    case 'long time': return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    case 'general date':
      return `${d.toLocaleDateString('en-US')} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
    default: return null;
  }
}

function formatNumber(n: number, fmtLower: string): string | null {
  switch (fmtLower) {
    case 'currency': return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    case 'fixed': return n.toFixed(2);
    case 'standard': return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'percent': return `${(n * 100).toFixed(2)}%`;
    case 'scientific': return n.toExponential(2);
    case 'general number': return String(n);
    default: return null;
  }
}

/** Apply an Access format string to a value. Returns formatted string or original value. */
export function formatValue(value: unknown, fmt: string | null | undefined): unknown {
  if (!fmt || !fmt.trim() || value == null || value === '') return value;
  const fmtLower = fmt.trim().toLowerCase();
  const s = String(value);

  // Try date formats
  const d = parseDate(value);
  if (d) { const r = formatDate(d, fmtLower); if (r) return r; }

  // Try number formats
  const n = parseFloat(s);
  if (!isNaN(n)) { const r = formatNumber(n, fmtLower); if (r) return r; }

  // Yes/No formats
  switch (fmtLower) {
    case 'yes/no': return value ? 'Yes' : 'No';
    case 'true/false': return value ? 'True' : 'False';
    case 'on/off': return value ? 'On' : 'Off';
  }

  return value;
}

/** Parse an Access input mask string into its components. */
export function parseInputMask(maskStr: string | null | undefined): {
  pattern: string;
  storeLiterals: boolean;
  placeholderChar: string;
} | null {
  if (!maskStr?.trim()) return null;
  const parts = maskStr.split(';');
  return {
    pattern: parts[0],
    storeLiterals: parts[1] !== '1',
    placeholderChar: parts[2]?.[0] ?? '_',
  };
}

/** Convert an Access mask pattern to a placeholder string. */
export function maskPlaceholder(pattern: string, placeholderChar = '_'): string {
  const result: string[] = [];
  let escape = false;
  for (const c of pattern) {
    if (escape) { result.push(c); escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if ('09#L?Aa&C'.includes(c)) { result.push(placeholderChar); continue; }
    if ('<>!'.includes(c)) continue; // case/fill markers, not displayed
    result.push(c); // literal separator
  }
  return result.join('');
}

// ============================================================
// Display text
// ============================================================

/** Get display text from a control (for labels, buttons, etc). */
export function displayText(ctrl: Control): string {
  return (ctrl as Record<string, unknown>).text as string
    ?? (ctrl as Record<string, unknown>).label as string
    ?? ctrl.caption
    ?? '';
}

// ============================================================
// Filename helpers
// ============================================================

/** Convert a filename to a display name: "recipe_calculator" → "Recipe Calculator", "frmOrderDetails" → "frm Order Details" */
export function filenameToDisplayName(filename: string): string {
  return filename
    .replace(/_/g, ' ')
    // Insert space before uppercase letters that follow lowercase (camelCase boundaries)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Insert space before uppercase letters followed by lowercase when preceded by uppercase (e.g. "HTMLParser" → "HTML Parser")
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Sanitize a name for use as a filename/identifier: lowercase, whitespace→_, strip non-alnum. */
export function sanitizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// ============================================================
// Section helpers (form & report)
// ============================================================

export function getSectionHeight(def: Record<string, unknown>, section: string): number {
  const sec = def[section] as Record<string, unknown> | undefined;
  if (sec?.height && typeof sec.height === 'number') return sec.height;
  if (section === 'header') return 40;
  if (section === 'footer') return 40;
  return 200; // detail default
}

export function getSectionControls(def: Record<string, unknown>, section: string): Control[] {
  const sec = def[section] as Record<string, unknown> | undefined;
  return (sec?.controls as Control[] | undefined) ?? [];
}
