/**
 * Form Linting API
 * Validates form definitions and returns errors/warnings
 */

const express = require('express');
const router = express.Router();

// Validation rules
const VALID_CONTROL_TYPES = [
  'label', 'text-box', 'button', 'check-box', 'combo-box'
];

const REQUIRED_FORM_FIELDS = ['id', 'name', 'record-source'];
const REQUIRED_CONTROL_FIELDS = ['type', 'x', 'y', 'width', 'height'];

function normalizeType(type) {
  if (!type) return null;
  return type.toString().replace(/^:/, '');
}

function validateControl(control, sectionName, index, errors, formName) {
  const prefix = `${sectionName} > control[${index}]`;
  const type = normalizeType(control.type);

  // Check required fields
  for (const field of REQUIRED_CONTROL_FIELDS) {
    const key = field.replace('-', '_'); // Handle kebab vs snake case
    if (control[field] === undefined && control[key] === undefined) {
      errors.push({
        severity: 'error',
        location: prefix,
        message: `Missing required field '${field}'`,
        field: field
      });
    }
  }

  // Check type is valid
  if (type && !VALID_CONTROL_TYPES.includes(type)) {
    errors.push({
      severity: 'error',
      location: prefix,
      message: `Invalid control type '${type}'`,
      field: 'type',
      validValues: VALID_CONTROL_TYPES
    });
  }

  // Type-specific validation
  if (type === 'text-box' && !control.field) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "text-box should have 'field' property for data binding",
      field: 'field',
      suggestion: 'Add a field property to bind this control to a database column'
    });
  }

  if (type === 'label' && !control.text) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "label should have 'text' property",
      field: 'text'
    });
  }

  // Check numeric fields
  for (const field of ['x', 'y', 'width', 'height']) {
    const value = control[field];
    if (value !== undefined && typeof value !== 'number') {
      errors.push({
        severity: 'error',
        location: prefix,
        message: `'${field}' should be a number, got ${typeof value}`,
        field: field
      });
    }
  }

  // Check for non-positive dimensions
  if (control.width !== undefined && control.width <= 0) {
    errors.push({
      severity: 'error',
      location: prefix,
      message: "'width' should be positive",
      field: 'width'
    });
  }
  if (control.height !== undefined && control.height <= 0) {
    errors.push({
      severity: 'error',
      location: prefix,
      message: "'height' should be positive",
      field: 'height'
    });
  }
}

function validateSection(section, sectionName, errors, formName) {
  if (!section) return;

  if (typeof section !== 'object') {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: 'Section should be an object'
    });
    return;
  }

  // Check height
  if (section.height === undefined) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "Missing 'height' property",
      field: 'height'
    });
  } else if (typeof section.height !== 'number') {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "'height' should be a number",
      field: 'height'
    });
  } else if (section.height < 0) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "'height' should not be negative",
      field: 'height'
    });
  }

  // Check controls
  if (section.controls === undefined) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "Missing 'controls' array",
      field: 'controls'
    });
  } else if (!Array.isArray(section.controls)) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "'controls' should be an array",
      field: 'controls'
    });
  } else {
    section.controls.forEach((ctrl, i) => {
      validateControl(ctrl, sectionName, i, errors, formName);
    });
  }
}

function validateForm(form) {
  const issues = [];
  const formName = form.name || 'Untitled';

  if (!form || typeof form !== 'object') {
    issues.push({
      severity: 'error',
      location: 'form',
      message: 'Form definition should be an object'
    });
    return issues;
  }

  // Check required top-level fields
  for (const field of REQUIRED_FORM_FIELDS) {
    const key = field.replace('-', '_');
    if (form[field] === undefined && form[key] === undefined) {
      issues.push({
        severity: 'error',
        location: 'form',
        message: `Missing required field '${field}'`,
        field: field
      });
    }
  }

  // Check for old flat controls structure
  if (form.controls && !form.detail) {
    issues.push({
      severity: 'error',
      location: 'form',
      message: "Uses old flat 'controls' structure - needs migration to sections",
      suggestion: 'Move controls into header/detail/footer sections'
    });
  }

  // Validate sections
  const hasSections = form.header || form.detail || form.footer;
  if (!hasSections && !form.controls) {
    issues.push({
      severity: 'warning',
      location: 'form',
      message: 'No sections or controls defined'
    });
  }

  if (hasSections) {
    validateSection(form.header, 'header', issues, formName);
    validateSection(form.detail, 'detail', issues, formName);
    validateSection(form.footer, 'footer', issues, formName);
  }

  return issues;
}

function createRouter(pool, secrets) {
  /**
   * POST /api/lint/form
   * Validate a form definition
   */
  router.post('/form', (req, res) => {
    const { form } = req.body;

    if (!form) {
      return res.status(400).json({ error: 'form is required' });
    }

    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    res.json({
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      summary: errors.length === 0
        ? 'Form is valid'
        : `${errors.length} error(s), ${warnings.length} warning(s)`
    });
  });

  return router;
}

module.exports = createRouter;
module.exports.validateForm = validateForm;
module.exports.validateControl = validateControl;
module.exports.normalizeType = normalizeType;
