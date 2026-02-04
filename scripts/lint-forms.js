#!/usr/bin/env node
/**
 * Form Definition Linter
 *
 * Validates form EDN files for structural correctness.
 * Run: node scripts/lint-forms.js
 *
 * Exit codes:
 *   0 - All forms valid
 *   1 - Validation errors found
 */

const fs = require('fs');
const path = require('path');

// Simple EDN parser (handles our subset of EDN)
function parseEDN(str) {
  let pos = 0;

  function skipWhitespace() {
    while (pos < str.length && /[\s,]/.test(str[pos])) pos++;
    // Skip comments
    if (str[pos] === ';') {
      while (pos < str.length && str[pos] !== '\n') pos++;
      skipWhitespace();
    }
  }

  function parseValue() {
    skipWhitespace();
    if (pos >= str.length) return null;

    const ch = str[pos];

    // Map
    if (ch === '{') {
      pos++;
      const map = {};
      while (true) {
        skipWhitespace();
        if (str[pos] === '}') { pos++; return map; }
        const key = parseValue();
        const val = parseValue();
        if (typeof key === 'string' || typeof key === 'symbol') {
          map[key.toString().replace(/^:/, '')] = val;
        }
      }
    }

    // Vector
    if (ch === '[') {
      pos++;
      const arr = [];
      while (true) {
        skipWhitespace();
        if (str[pos] === ']') { pos++; return arr; }
        arr.push(parseValue());
      }
    }

    // String
    if (ch === '"') {
      pos++;
      let s = '';
      while (str[pos] !== '"') {
        if (str[pos] === '\\') { pos++; s += str[pos++]; }
        else s += str[pos++];
      }
      pos++;
      return s;
    }

    // Keyword or symbol
    if (ch === ':') {
      pos++;
      let kw = ':';
      while (pos < str.length && /[a-zA-Z0-9_\-]/.test(str[pos])) {
        kw += str[pos++];
      }
      return kw;
    }

    // Number
    if (/[\d\-]/.test(ch)) {
      let num = '';
      if (ch === '-') { num += ch; pos++; }
      while (pos < str.length && /[\d.]/.test(str[pos])) {
        num += str[pos++];
      }
      return parseFloat(num);
    }

    // Boolean/nil
    if (str.slice(pos, pos + 4) === 'true') { pos += 4; return true; }
    if (str.slice(pos, pos + 5) === 'false') { pos += 5; return false; }
    if (str.slice(pos, pos + 3) === 'nil') { pos += 3; return null; }

    // Unquoted symbol
    let sym = '';
    while (pos < str.length && /[a-zA-Z0-9_\-]/.test(str[pos])) {
      sym += str[pos++];
    }
    return sym || null;
  }

  return parseValue();
}

// Validation rules
const VALID_CONTROL_TYPES = [
  'label', 'text-box', 'button', 'check-box', 'combo-box',
  ':label', ':text-box', ':button', ':check-box', ':combo-box'
];

const REQUIRED_FORM_FIELDS = ['id', 'name', 'record-source'];
const REQUIRED_CONTROL_FIELDS = ['type', 'x', 'y', 'width', 'height'];

function validateControl(control, sectionName, index, errors, formName) {
  const prefix = `${formName} > ${sectionName} > control[${index}]`;

  // Check required fields
  for (const field of REQUIRED_CONTROL_FIELDS) {
    if (control[field] === undefined) {
      errors.push(`${prefix}: missing required field '${field}'`);
    }
  }

  // Check type is valid
  const type = control.type?.toString().replace(/^:/, '');
  if (type && !VALID_CONTROL_TYPES.map(t => t.replace(/^:/, '')).includes(type)) {
    errors.push(`${prefix}: invalid control type '${type}'`);
  }

  // Type-specific validation
  if (type === 'text-box' && !control.field) {
    errors.push(`${prefix}: text-box should have 'field' property for data binding`);
  }

  if (type === 'label' && !control.text) {
    errors.push(`${prefix}: label should have 'text' property`);
  }

  // Check numeric fields
  for (const field of ['x', 'y', 'width', 'height']) {
    if (control[field] !== undefined && typeof control[field] !== 'number') {
      errors.push(`${prefix}: '${field}' should be a number, got ${typeof control[field]}`);
    }
  }

  // Check for negative dimensions
  if (control.width !== undefined && control.width <= 0) {
    errors.push(`${prefix}: 'width' should be positive`);
  }
  if (control.height !== undefined && control.height <= 0) {
    errors.push(`${prefix}: 'height' should be positive`);
  }
}

function validateSection(section, sectionName, errors, formName) {
  const prefix = `${formName} > ${sectionName}`;

  if (!section) {
    // Section is optional
    return;
  }

  if (typeof section !== 'object') {
    errors.push(`${prefix}: should be an object`);
    return;
  }

  // Check height
  if (section.height === undefined) {
    errors.push(`${prefix}: missing 'height' property`);
  } else if (typeof section.height !== 'number') {
    errors.push(`${prefix}: 'height' should be a number`);
  } else if (section.height < 0) {
    errors.push(`${prefix}: 'height' should not be negative`);
  }

  // Check controls
  if (section.controls === undefined) {
    errors.push(`${prefix}: missing 'controls' array`);
  } else if (!Array.isArray(section.controls)) {
    errors.push(`${prefix}: 'controls' should be an array`);
  } else {
    section.controls.forEach((ctrl, i) => {
      validateControl(ctrl, sectionName, i, errors, formName);
    });
  }
}

function validateForm(form, filename) {
  const errors = [];
  const warnings = [];
  const formName = form.name || filename;

  // Check it's an object
  if (!form || typeof form !== 'object') {
    errors.push(`${formName}: form definition should be an object`);
    return { errors, warnings };
  }

  // Check required top-level fields
  for (const field of REQUIRED_FORM_FIELDS) {
    if (form[field] === undefined) {
      errors.push(`${formName}: missing required field '${field}'`);
    }
  }

  // Check for old flat controls structure (needs migration)
  if (form.controls && !form.detail) {
    errors.push(`${formName}: uses old flat 'controls' structure - migrate to section-based (header/detail/footer)`);
  }

  // Validate sections
  const hasSections = form.header || form.detail || form.footer;
  if (!hasSections && !form.controls) {
    warnings.push(`${formName}: no sections or controls defined`);
  }

  if (hasSections) {
    validateSection(form.header, 'header', errors, formName);
    validateSection(form.detail, 'detail', errors, formName);
    validateSection(form.footer, 'footer', errors, formName);

    // Detail section should typically have controls
    if (form.detail && (!form.detail.controls || form.detail.controls.length === 0)) {
      warnings.push(`${formName}: detail section has no controls`);
    }
  }

  // Check default-view value
  if (form['default-view'] && !['single', 'continuous'].includes(form['default-view'])) {
    warnings.push(`${formName}: 'default-view' should be 'single' or 'continuous'`);
  }

  return { errors, warnings };
}

function lintForms(formsDir) {
  const results = {
    files: 0,
    errors: [],
    warnings: [],
    valid: []
  };

  // Read all .edn files except _index.edn
  const files = fs.readdirSync(formsDir)
    .filter(f => f.endsWith('.edn') && f !== '_index.edn');

  for (const file of files) {
    results.files++;
    const filepath = path.join(formsDir, file);

    try {
      const content = fs.readFileSync(filepath, 'utf8');
      const form = parseEDN(content);
      const { errors, warnings } = validateForm(form, file);

      if (errors.length > 0) {
        results.errors.push(...errors);
      } else {
        results.valid.push(file);
      }

      if (warnings.length > 0) {
        results.warnings.push(...warnings);
      }
    } catch (err) {
      results.errors.push(`${file}: failed to parse - ${err.message}`);
    }
  }

  return results;
}

// Export parseEDN for testing
module.exports = { parseEDN };

// Main (only runs when executed directly)
if (require.main === module) {
  const formsDir = path.join(__dirname, '..', 'forms');

  console.log('Form Definition Linter');
  console.log('======================\n');

  const results = lintForms(formsDir);

  console.log(`Checked ${results.files} form(s)\n`);

  if (results.errors.length > 0) {
    console.log('ERRORS:');
    results.errors.forEach(e => console.log(`  ✗ ${e}`));
    console.log('');
  }

  if (results.warnings.length > 0) {
    console.log('WARNINGS:');
    results.warnings.forEach(w => console.log(`  ⚠ ${w}`));
    console.log('');
  }

  if (results.valid.length > 0) {
    console.log('VALID:');
    results.valid.forEach(f => console.log(`  ✓ ${f}`));
    console.log('');
  }

  // Summary
  if (results.errors.length === 0) {
    console.log('✓ All forms passed validation');
    process.exit(0);
  } else {
    console.log(`✗ ${results.errors.length} error(s) found`);
    process.exit(1);
  }
}
