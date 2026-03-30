/**
 * File writer for LLM-generated form components.
 * Writes .tsx files to ui-react/src/generated/forms/{databaseId}/{FormName}.tsx
 */

const fs = require('fs');
const path = require('path');

const GENERATED_DIR = path.join(__dirname, '..', '..', '..', 'ui-react', 'src', 'generated', 'forms');

/**
 * Normalize form name to a valid PascalCase filename.
 * Strips special chars, ensures it starts with uppercase.
 */
function normalizeFormName(formName) {
  // Remove non-alphanumeric chars except underscores
  let normalized = formName.replace(/[^a-zA-Z0-9_]/g, '');
  // Ensure starts with uppercase
  if (normalized.length > 0) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized || 'UnnamedForm';
}

/**
 * Write a generated form component to disk.
 *
 * @param {string} databaseId - Database slug (e.g. 'northwind4')
 * @param {string} formName - Original form name (e.g. 'frmAbout')
 * @param {string} tsxContent - The generated TSX source code
 * @param {number|null} step - If provided, writes as {FormName}{step}.tsx (debug mode)
 * @returns {{ filePath: string, relativePath: string }} Written file info
 */
function writeGeneratedForm(databaseId, formName, tsxContent, step = null) {
  const dir = path.join(GENERATED_DIR, databaseId);
  fs.mkdirSync(dir, { recursive: true });

  const normalized = normalizeFormName(formName);
  const filename = step ? `${normalized}${step}.tsx` : `${normalized}.tsx`;
  const filePath = path.join(dir, filename);

  fs.writeFileSync(filePath, tsxContent, 'utf8');

  const relativePath = `ui-react/src/generated/forms/${databaseId}/${filename}`;
  return { filePath, relativePath };
}

/**
 * Check if a generated form exists on disk.
 */
function generatedFormExists(databaseId, formName) {
  const normalized = normalizeFormName(formName);
  const filePath = path.join(GENERATED_DIR, databaseId, `${normalized}.tsx`);
  return fs.existsSync(filePath);
}

/**
 * List all generated forms for a database.
 */
function listGeneratedForms(databaseId) {
  const dir = path.join(GENERATED_DIR, databaseId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.tsx'))
    .map(f => f.replace('.tsx', ''));
}

module.exports = { writeGeneratedForm, generatedFormExists, listGeneratedForms, normalizeFormName };
