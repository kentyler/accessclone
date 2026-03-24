import { describe, it, expect } from 'vitest';
import {
  ctrlToKey, snapToGrid, twipsToPx, accessColorToHex, applyShadeTint,
  stripAccessHotkey, extractHotkey, parseHotkeyText,
  controlStyle, resolveControlField, resolveFieldValue,
  formatValue, parseInputMask, maskPlaceholder,
  displayText, filenameToDisplayName, sanitizeName,
  getSectionHeight, getSectionControls,
} from './utils';
import type { Control } from '@/api/types';

// ============================================================
// ctrlToKey
// ============================================================

describe('ctrlToKey', () => {
  it('converts camelCase to kebab-case', () => {
    expect(ctrlToKey('SubformCustomers')).toBe('subform-customers');
    expect(ctrlToKey('OptionGroup1')).toBe('option-group1');
  });
  it('lowercases', () => {
    expect(ctrlToKey('BtnSave')).toBe('btn-save');
  });
  it('strips non-alphanumeric', () => {
    expect(ctrlToKey('field_name')).toBe('field-name');
  });
  it('handles null/undefined/empty', () => {
    expect(ctrlToKey(null)).toBe('');
    expect(ctrlToKey(undefined)).toBe('');
    expect(ctrlToKey('')).toBe('');
  });
});

// ============================================================
// snapToGrid
// ============================================================

describe('snapToGrid', () => {
  it('snaps to nearest grid point (default 8)', () => {
    expect(snapToGrid(13, false)).toBe(16);
    expect(snapToGrid(11, false)).toBe(8);
  });
  it('returns value as-is when ctrlKey is true', () => {
    expect(snapToGrid(13, true)).toBe(13);
  });
  it('uses custom grid size', () => {
    expect(snapToGrid(14, false, 10)).toBe(10);
    expect(snapToGrid(16, false, 10)).toBe(20);
  });
  it('snaps 0 to 0', () => {
    expect(snapToGrid(0, false)).toBe(0);
  });
});

// ============================================================
// twipsToPx
// ============================================================

describe('twipsToPx', () => {
  it('converts twips to pixels (15 twips/px)', () => {
    expect(twipsToPx(150)).toBe(10);
    expect(twipsToPx(1440)).toBe(96);
  });
  it('rounds to nearest integer', () => {
    expect(twipsToPx(100)).toBe(7);
  });
  it('handles 0', () => {
    expect(twipsToPx(0)).toBe(0);
  });
});

// ============================================================
// accessColorToHex
// ============================================================

describe('accessColorToHex', () => {
  it('converts BGR to RGB hex', () => {
    // BGR: Blue=0xFF (16711680), Green=0, Red=0 → #0000ff
    expect(accessColorToHex(16711680)).toBe('#0000ff');
    // BGR: Blue=0, Green=0, Red=0xFF (255) → #ff0000
    expect(accessColorToHex(255)).toBe('#ff0000');
    // White: 16777215 → #ffffff
    expect(accessColorToHex(16777215)).toBe('#ffffff');
    // Black: 0 → #000000
    expect(accessColorToHex(0)).toBe('#000000');
  });
  it('handles string input', () => {
    expect(accessColorToHex('255')).toBe('#ff0000');
  });
  it('returns empty for null/undefined/NaN', () => {
    expect(accessColorToHex(null)).toBe('');
    expect(accessColorToHex(undefined)).toBe('');
    expect(accessColorToHex('abc')).toBe('');
  });
});

// ============================================================
// applyShadeTint
// ============================================================

describe('applyShadeTint', () => {
  it('returns same color when shade=100 and tint=100', () => {
    expect(applyShadeTint('#ff0000', 100, 100)).toBe('#ff0000');
  });
  it('shade=0 produces black', () => {
    expect(applyShadeTint('#ff8040', 0, 100)).toBe('#000000');
  });
  it('tint=0 produces white', () => {
    expect(applyShadeTint('#000000', 100, 0)).toBe('#ffffff');
  });
  it('shade=50 darkens to half', () => {
    expect(applyShadeTint('#ff0000', 50, 100)).toBe('#800000');
  });
});

// ============================================================
// stripAccessHotkey / extractHotkey / parseHotkeyText
// ============================================================

describe('stripAccessHotkey', () => {
  it('removes & markers', () => {
    expect(stripAccessHotkey('Product &Vendors')).toBe('Product Vendors');
    expect(stripAccessHotkey('&File')).toBe('File');
  });
});

describe('extractHotkey', () => {
  it('extracts the hotkey letter (lowercase)', () => {
    expect(extractHotkey('Product &Vendors')).toBe('v');
    expect(extractHotkey('&File')).toBe('f');
  });
  it('returns null for no hotkey', () => {
    expect(extractHotkey('No Hotkey')).toBeNull();
    expect(extractHotkey(null)).toBeNull();
    expect(extractHotkey(undefined)).toBeNull();
  });
});

describe('parseHotkeyText', () => {
  it('splits text around hotkey markers', () => {
    const result = parseHotkeyText('Product &Vendors');
    expect(result).toEqual([
      'Product ',
      { hotkey: true, char: 'V' },
      'endors',
    ]);
  });
  it('handles && as literal ampersand', () => {
    const result = parseHotkeyText('Save && Exit');
    expect(result).toEqual(['Save ', '&', ' Exit']);
  });
  it('returns [""] for null/empty', () => {
    expect(parseHotkeyText(null)).toEqual(['']);
    expect(parseHotkeyText('')).toEqual(['']);
  });
  it('returns plain text when no marker', () => {
    expect(parseHotkeyText('Hello')).toEqual(['Hello']);
  });
});

// ============================================================
// controlStyle
// ============================================================

describe('controlStyle', () => {
  it('returns position properties', () => {
    const ctrl = { type: 'text-box', name: 'x', left: 10, top: 20, width: 100, height: 30 } as Control;
    const style = controlStyle(ctrl);
    expect(style.left).toBe(10);
    expect(style.top).toBe(20);
    expect(style.width).toBe(100);
    expect(style.height).toBe(30);
  });

  it('includes font properties when present', () => {
    const ctrl = {
      type: 'text-box', name: 'x', left: 0, top: 0, width: 0, height: 0,
      'font-name': 'Arial', 'font-size': 12, 'font-weight': 700, 'font-italic': 1,
    } as Control;
    const style = controlStyle(ctrl);
    expect(style.fontFamily).toBe('Arial');
    expect(style.fontSize).toBe(12);
    expect(style.fontWeight).toBe('bold');
    expect(style.fontStyle).toBe('italic');
  });

  it('labels are transparent by default', () => {
    const ctrl = {
      type: 'label', name: 'x', left: 0, top: 0, width: 0, height: 0,
      'back-color': '#fff',
    } as Control;
    const style = controlStyle(ctrl);
    expect(style.backgroundColor).toBeUndefined();
  });

  it('text-box is opaque by default', () => {
    const ctrl = {
      type: 'text-box', name: 'x', left: 0, top: 0, width: 0, height: 0,
      'back-color': '#fff',
    } as Control;
    const style = controlStyle(ctrl);
    expect(style.backgroundColor).toBe('#fff');
  });

  it('back-style overrides default transparency', () => {
    const ctrl = {
      type: 'label', name: 'x', left: 0, top: 0, width: 0, height: 0,
      'back-style': 1, 'back-color': '#fff',
    } as Control;
    const style = controlStyle(ctrl);
    expect(style.backgroundColor).toBe('#fff');
  });
});

// ============================================================
// resolveControlField / resolveFieldValue
// ============================================================

describe('resolveControlField', () => {
  it('returns lowercase field name', () => {
    expect(resolveControlField({ type: 'text-box', name: 'x', field: 'FullName' } as Control)).toBe('fullname');
  });
  it('prefers control-source over field', () => {
    expect(resolveControlField({
      type: 'text-box', name: 'x',
      field: 'Name',
      'control-source': 'OtherField',
    } as Control)).toBe('otherfield');
  });
  it('returns raw expression for =expressions', () => {
    expect(resolveControlField({
      type: 'text-box', name: 'x',
      'control-source': '=[Price]*[Qty]',
    } as Control)).toBe('=[Price]*[Qty]');
  });
  it('returns null when no field', () => {
    expect(resolveControlField({ type: 'label', name: 'x' } as Control)).toBeNull();
  });
});

describe('resolveFieldValue', () => {
  it('looks up record value', () => {
    expect(resolveFieldValue('name', { name: 'Alice' })).toBe('Alice');
  });
  it('falls back to lowercase key', () => {
    expect(resolveFieldValue('Name', { name: 'Alice' })).toBe('Alice');
  });
  it('evaluates expressions', () => {
    expect(resolveFieldValue('=1+2', {})).toBe(3);
  });
  it('returns undefined for null field', () => {
    expect(resolveFieldValue(null, {})).toBeUndefined();
  });
  it('returns empty string for missing field', () => {
    expect(resolveFieldValue('missing', { name: 'Alice' })).toBe('');
  });
});

// ============================================================
// formatValue
// ============================================================

describe('formatValue', () => {
  it('returns original for null/empty format', () => {
    expect(formatValue(42, null)).toBe(42);
    expect(formatValue(42, '')).toBe(42);
  });
  it('returns original for null/empty value', () => {
    expect(formatValue(null, 'Fixed')).toBeNull();
    expect(formatValue('', 'Fixed')).toBe('');
  });
  it('formats fixed (2 decimal places)', () => {
    expect(formatValue(3.1, 'Fixed')).toBe('3.10');
  });
  it('formats general number', () => {
    expect(formatValue(42, 'General Number')).toBe('42');
  });
  it('formats yes/no', () => {
    expect(formatValue(1, 'Yes/No')).toBe('Yes');
    expect(formatValue(0, 'Yes/No')).toBe('No');
  });
  it('formats true/false', () => {
    expect(formatValue(1, 'True/False')).toBe('True');
    expect(formatValue(0, 'True/False')).toBe('False');
  });
  it('formats on/off', () => {
    expect(formatValue(1, 'On/Off')).toBe('On');
    expect(formatValue(0, 'On/Off')).toBe('Off');
  });
});

// ============================================================
// parseInputMask / maskPlaceholder
// ============================================================

describe('parseInputMask', () => {
  it('parses full mask string', () => {
    const result = parseInputMask('(999) 000-0000;0;_');
    expect(result).toEqual({
      pattern: '(999) 000-0000',
      storeLiterals: true,
      placeholderChar: '_',
    });
  });
  it('returns null for empty/null', () => {
    expect(parseInputMask(null)).toBeNull();
    expect(parseInputMask('')).toBeNull();
  });
  it('defaults placeholder to _ and storeLiterals to true', () => {
    const result = parseInputMask('000-0000');
    expect(result!.placeholderChar).toBe('_');
    expect(result!.storeLiterals).toBe(true);
  });
  it('storeLiterals false when part[1] is "1"', () => {
    const result = parseInputMask('000;1');
    expect(result!.storeLiterals).toBe(false);
  });
});

describe('maskPlaceholder', () => {
  it('replaces mask chars with placeholder', () => {
    expect(maskPlaceholder('(999) 000-0000')).toBe('(___) ___-____');
  });
  it('uses custom placeholder char', () => {
    expect(maskPlaceholder('000-0000', '#')).toBe('###-####');
  });
  it('handles backslash escape', () => {
    expect(maskPlaceholder('\\A00')).toBe('A__');
  });
  it('skips case/fill markers', () => {
    expect(maskPlaceholder('>LL')).toBe('__');
  });
});

// ============================================================
// displayText
// ============================================================

describe('displayText', () => {
  it('returns caption', () => {
    expect(displayText({ caption: 'Save' } as Control)).toBe('Save');
  });
  it('returns empty string when nothing set', () => {
    expect(displayText({ type: 'label', name: 'x' } as Control)).toBe('');
  });
});

// ============================================================
// filenameToDisplayName / sanitizeName
// ============================================================

describe('filenameToDisplayName', () => {
  it('converts underscores and capitalizes', () => {
    expect(filenameToDisplayName('recipe_calculator')).toBe('Recipe Calculator');
  });
});

describe('sanitizeName', () => {
  it('lowercases and replaces whitespace', () => {
    expect(sanitizeName('Product Vendors')).toBe('product_vendors');
  });
  it('strips non-alphanumeric', () => {
    expect(sanitizeName('Hello (World)!')).toBe('hello_world');
  });
});

// ============================================================
// getSectionHeight / getSectionControls
// ============================================================

describe('getSectionHeight', () => {
  it('returns section height when present', () => {
    expect(getSectionHeight({ header: { height: 50 } }, 'header')).toBe(50);
  });
  it('returns defaults when section missing', () => {
    expect(getSectionHeight({}, 'header')).toBe(40);
    expect(getSectionHeight({}, 'footer')).toBe(40);
    expect(getSectionHeight({}, 'detail')).toBe(200);
  });
});

describe('getSectionControls', () => {
  it('returns controls array', () => {
    const ctrls = [{ type: 'label', name: 'x' }];
    expect(getSectionControls({ detail: { controls: ctrls } }, 'detail')).toBe(ctrls);
  });
  it('returns empty array for missing section', () => {
    expect(getSectionControls({}, 'detail')).toEqual([]);
  });
});
