/**
 * Helper utilities for the server
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Update the forms index file when a form is saved
 */
async function updateFormIndex(formsDir, formName) {
  const indexPath = path.join(formsDir, '_index.edn');
  try {
    const content = await fs.readFile(indexPath, 'utf8');
    const match = content.match(/\[([\s\S]*)\]/);
    if (match) {
      const items = match[1]
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.startsWith('"'))
        .map(s => s.replace(/^"|"$/g, '').replace(/",?$/, ''));

      if (!items.includes(formName)) {
        items.push(formName);
        const newContent = `["${items.join('"\n "')}"]`;
        await fs.writeFile(indexPath, newContent, 'utf8');
        console.log(`Added ${formName} to index`);
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.writeFile(indexPath, `["${formName}"]`, 'utf8');
    } else {
      console.error('Error updating index:', err);
    }
  }
}

/**
 * Remove a form from the index file
 */
async function removeFromFormIndex(formsDir, formName) {
  const indexPath = path.join(formsDir, '_index.edn');
  try {
    const content = await fs.readFile(indexPath, 'utf8');
    const match = content.match(/\[([\s\S]*)\]/);
    if (match) {
      const items = match[1]
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.startsWith('"'))
        .map(s => s.replace(/^"|"$/g, '').replace(/",?$/, ''))
        .filter(s => s !== formName);

      const newContent = items.length > 0
        ? `["${items.join('"\n "')}"]`
        : '[]';
      await fs.writeFile(indexPath, newContent, 'utf8');
      console.log(`Removed ${formName} from index`);
    }
  } catch (err) {
    console.error('Error updating index:', err);
  }
}

/**
 * Convert JSON object to EDN format
 */
function jsonToEdn(obj, indent = 0) {
  const spaces = ' '.repeat(indent);

  if (obj === null) return 'nil';
  if (typeof obj === 'boolean') return obj.toString();
  if (typeof obj === 'number') return obj.toString();
  if (typeof obj === 'string') return `"${obj}"`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(item => jsonToEdn(item, indent + 1));
    return `[${items.join('\n' + spaces + ' ')}]`;
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';

    const pairs = entries.map(([k, v]) => {
      const key = `:${k.replace(/_/g, '-')}`;
      const val = jsonToEdn(v, indent + 1);
      return `${key} ${val}`;
    });

    return `{${pairs.join('\n' + spaces + ' ')}}`;
  }

  return obj.toString();
}

module.exports = {
  updateFormIndex,
  removeFromFormIndex,
  jsonToEdn
};
