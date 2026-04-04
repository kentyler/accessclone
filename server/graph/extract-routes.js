/**
 * Route Contract Extractor
 * Scans all .js files under server/routes/ and extracts HTTP method, path pattern,
 * req.body fields, req.query fields, and req.params fields via regex.
 */

const fs = require('fs');
const path = require('path');

/**
 * Recursively find all .js files under a directory.
 */
function findJsFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        results.push(fullPath);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

/**
 * Extract route contracts from all route files.
 *
 * @param {string} [routesDir] - Directory to scan (defaults to server/routes)
 * @returns {Array<{ method: string, path: string, file: string, fields: { body: string[], query: string[], params: string[] } }>}
 */
function extractRoutes(routesDir) {
  if (!routesDir) {
    routesDir = path.join(__dirname, '..', 'routes');
  }

  const files = findJsFiles(routesDir);
  const routes = [];

  for (const filePath of files) {
    try {
      const source = fs.readFileSync(filePath, 'utf8');
      const relFile = path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/');
      const extracted = extractRoutesFromSource(source, relFile);
      routes.push(...extracted);
    } catch (err) {
      // Skip unreadable files
    }
  }

  return routes;
}

/**
 * Extract routes from a single source string.
 * Exported for testing.
 *
 * @param {string} source - JS source code
 * @param {string} file - Relative file path for metadata
 * @returns {Array<{ method: string, path: string, file: string, fields: { body: string[], query: string[], params: string[] } }>}
 */
function extractRoutesFromSource(source, file) {
  const routes = [];

  // Match router.get/post/put/delete('path', ...
  const routeRegex = /router\.(get|post|put|delete)\(\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = routeRegex.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2];

    // Extract params from path pattern (e.g., :name, :id)
    const params = [];
    const paramRegex = /:(\w+)/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(routePath)) !== null) {
      params.push(paramMatch[1]);
    }

    // Find the handler body — scan forward from the route match to find
    // req.body and req.query destructuring within the handler
    const handlerStart = match.index;
    const handlerEnd = findHandlerEnd(source, handlerStart);
    const handlerSource = source.substring(handlerStart, handlerEnd);

    // Extract req.body destructured fields
    const body = extractDestructuredFields(handlerSource, 'req.body');

    // Extract req.query destructured fields
    const query = extractDestructuredFields(handlerSource, 'req.query');

    routes.push({
      method,
      path: routePath,
      file,
      fields: { body, query, params }
    });
  }

  return routes;
}

/**
 * Find the approximate end of a route handler function.
 * Scans forward looking for the next route definition or end of file.
 * Uses a generous window (up to next router.method or end of source).
 */
function findHandlerEnd(source, startIndex) {
  // Look for the next router.get/post/put/delete after this one
  const nextRouteRegex = /router\.(get|post|put|delete)\(\s*['"]/g;
  nextRouteRegex.lastIndex = startIndex + 10; // skip past current match
  const nextMatch = nextRouteRegex.exec(source);
  return nextMatch ? nextMatch.index : source.length;
}

/**
 * Extract destructured field names from patterns like:
 *   const { field1, field2, field3 } = req.body
 *   const { field1, field2 } = req.query
 *
 * Also handles multi-line destructuring.
 *
 * @param {string} source
 * @param {string} target - 'req.body' or 'req.query'
 * @returns {string[]}
 */
function extractDestructuredFields(source, target) {
  const fields = [];
  // Escape dots for regex
  const escaped = target.replace('.', '\\.');
  // Match: const { ... } = req.body  OR  let { ... } = req.body
  // Allow multiline with [\s\S]
  const regex = new RegExp(`(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${escaped}`, 'g');
  let match;
  while ((match = regex.exec(source)) !== null) {
    const inner = match[1];
    // Split by commas, strip whitespace and default values
    const names = inner.split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => {
        // Handle default values: field = 'default' or field = value
        const eqIdx = s.indexOf('=');
        if (eqIdx > 0) return s.substring(0, eqIdx).trim();
        return s.trim();
      })
      .filter(s => /^\w+$/.test(s)); // only valid identifiers
    fields.push(...names);
  }
  return [...new Set(fields)]; // dedupe
}

module.exports = { extractRoutes, extractRoutesFromSource, extractDestructuredFields };
