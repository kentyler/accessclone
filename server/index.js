/**
 * Simple backend for CloneTemplate
 * Handles form EDN file read/write operations
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Forms directory (relative to server location)
const FORMS_DIR = path.join(__dirname, '..', 'forms');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'application/edn' }));

// Serve forms directory as static files
app.use('/forms', express.static(FORMS_DIR));

/**
 * GET /api/forms
 * List all form files
 */
app.get('/api/forms', async (req, res) => {
  try {
    const files = await fs.readdir(FORMS_DIR);
    const formFiles = files
      .filter(f => f.endsWith('.edn') && f !== '_index.edn')
      .map(f => f.replace('.edn', ''));
    res.json({ forms: formFiles });
  } catch (err) {
    console.error('Error listing forms:', err);
    res.status(500).json({ error: 'Failed to list forms' });
  }
});

/**
 * GET /api/forms/:name
 * Read a single form file
 */
app.get('/api/forms/:name', async (req, res) => {
  try {
    const filename = `${req.params.name}.edn`;
    const filepath = path.join(FORMS_DIR, filename);
    const content = await fs.readFile(filepath, 'utf8');
    res.type('application/edn').send(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Form not found' });
    } else {
      console.error('Error reading form:', err);
      res.status(500).json({ error: 'Failed to read form' });
    }
  }
});

/**
 * PUT /api/forms/:name
 * Save a form file (create or update)
 */
app.put('/api/forms/:name', async (req, res) => {
  try {
    const filename = `${req.params.name}.edn`;
    const filepath = path.join(FORMS_DIR, filename);

    // Get content - could be JSON or EDN string
    let content;
    if (typeof req.body === 'string') {
      content = req.body;
    } else {
      // Convert JSON to EDN-like format (simple pretty print)
      content = jsonToEdn(req.body);
    }

    // Write the file
    await fs.writeFile(filepath, content, 'utf8');

    // Update _index.edn if this is a new form
    await updateIndex(req.params.name);

    console.log(`Saved form: ${filename}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error('Error saving form:', err);
    res.status(500).json({ error: 'Failed to save form' });
  }
});

/**
 * DELETE /api/forms/:name
 * Delete a form file
 */
app.delete('/api/forms/:name', async (req, res) => {
  try {
    const filename = `${req.params.name}.edn`;
    const filepath = path.join(FORMS_DIR, filename);

    await fs.unlink(filepath);
    await removeFromIndex(req.params.name);

    console.log(`Deleted form: ${filename}`);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Form not found' });
    } else {
      console.error('Error deleting form:', err);
      res.status(500).json({ error: 'Failed to delete form' });
    }
  }
});

/**
 * Update _index.edn to include a form name
 */
async function updateIndex(formName) {
  const indexPath = path.join(FORMS_DIR, '_index.edn');
  try {
    const content = await fs.readFile(indexPath, 'utf8');
    // Simple parse - extract array of strings
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
    // If index doesn't exist, create it
    if (err.code === 'ENOENT') {
      await fs.writeFile(indexPath, `["${formName}"]`, 'utf8');
    } else {
      console.error('Error updating index:', err);
    }
  }
}

/**
 * Remove a form name from _index.edn
 */
async function removeFromIndex(formName) {
  const indexPath = path.join(FORMS_DIR, '_index.edn');
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
 * Convert JSON object to EDN-like string format
 * (Simple conversion - handles basic types)
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
      // Convert key to keyword format
      const key = `:${k.replace(/_/g, '-')}`;
      const val = jsonToEdn(v, indent + 1);
      return `${key} ${val}`;
    });

    return `{${pairs.join('\n' + spaces + ' ')}}`;
  }

  return obj.toString();
}

// Start server
app.listen(PORT, () => {
  console.log(`CloneTemplate backend running on http://localhost:${PORT}`);
  console.log(`Forms directory: ${FORMS_DIR}`);
});
