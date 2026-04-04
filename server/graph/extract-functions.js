/**
 * Frontend Function Contract Extractor
 * Scans TypeScript/JavaScript store files to extract function names,
 * API endpoints called, and field names sent in request bodies.
 */

const fs = require('fs');
const path = require('path');

/**
 * Default store files to scan for function contracts.
 */
const DEFAULT_STORE_FILES = [
  'ui-react/src/store/import.ts',
];

/**
 * Extract function contracts from store files.
 *
 * @param {string} [projectRoot] - Project root directory
 * @param {string[]} [storeFiles] - Relative paths to scan
 * @returns {Array<{ name: string, endpoint: string, method: string, file: string, fields: string[] }>}
 */
function extractFunctions(projectRoot, storeFiles) {
  if (!projectRoot) {
    projectRoot = path.join(__dirname, '..', '..');
  }
  if (!storeFiles) {
    storeFiles = DEFAULT_STORE_FILES;
  }

  const functions = [];

  for (const relPath of storeFiles) {
    const filePath = path.join(projectRoot, relPath);
    try {
      const source = fs.readFileSync(filePath, 'utf8');
      const extracted = extractFunctionsFromSource(source, relPath);
      functions.push(...extracted);
    } catch (err) {
      // Skip unreadable files
    }
  }

  return functions;
}

/**
 * Extract function contracts from a single source string.
 * Exported for testing.
 *
 * Looks for patterns like:
 *   async importTable(databasePath, name) {
 *     ...
 *     const res = await api.post<...>('/api/database-import/import-table', {
 *       databasePath, tableName: name, targetDatabaseId,
 *     });
 *
 * @param {string} source - TS/JS source code
 * @param {string} file - Relative file path for metadata
 * @returns {Array<{ name: string, endpoint: string, method: string, file: string, fields: string[] }>}
 */
function extractFunctionsFromSource(source, file) {
  const functions = [];

  // Find async function definitions in zustand store (method shorthand)
  // Pattern: async funcName(params) {
  const funcRegex = /async\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let funcMatch;

  while ((funcMatch = funcRegex.exec(source)) !== null) {
    const funcName = funcMatch[1];
    const funcStart = funcMatch.index;

    // Find the function body end (next async function or end of file)
    const nextFuncRegex = /async\s+\w+\s*\([^)]*\)\s*\{/g;
    nextFuncRegex.lastIndex = funcStart + funcMatch[0].length;
    const nextFunc = nextFuncRegex.exec(source);
    const funcEnd = nextFunc ? nextFunc.index : source.length;
    const funcBody = source.substring(funcStart, funcEnd);

    // Find api.post/put/get/delete calls with object literal bodies
    // Handle nested generic types like api.post<Record<string, unknown>>
    const apiCallRegex = /api\.(post|put|get|delete)(?:<[^(]*>)?\(\s*['"]([^'"]+)['"]\s*,\s*\{([^}]*)\}/g;
    let apiMatch;

    while ((apiMatch = apiCallRegex.exec(funcBody)) !== null) {
      const method = apiMatch[1].toUpperCase();
      const endpoint = apiMatch[2];
      const bodyLiteral = apiMatch[3];

      // Parse field names from the object literal
      const fields = parseObjectLiteralFields(bodyLiteral);

      functions.push({
        name: funcName,
        endpoint,
        method,
        file,
        fields
      });
    }
  }

  return functions;
}

/**
 * Parse field names from an object literal string.
 * Handles both shorthand (fieldName) and key:value (fieldName: expr) patterns.
 *
 * @param {string} literal - Contents between { and }
 * @returns {string[]}
 */
function parseObjectLiteralFields(literal) {
  const fields = [];
  const parts = literal.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // key: value pattern
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.substring(0, colonIdx).trim();
      if (/^\w+$/.test(key)) {
        fields.push(key);
      }
    } else {
      // Shorthand: just the identifier
      if (/^\w+$/.test(trimmed)) {
        fields.push(trimmed);
      }
    }
  }

  return [...new Set(fields)]; // dedupe
}

module.exports = { extractFunctions, extractFunctionsFromSource, parseObjectLiteralFields };
