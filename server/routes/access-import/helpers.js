/**
 * Shared helpers for Access import routes.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

/**
 * Create an import logger closure for a specific import operation.
 */
function makeLogImport(pool, sourcePath, objectName, objectType, targetDatabaseId) {
  return async function logImport(status, errorMessage = null, details = null) {
    try {
      const result = await pool.query(`
        INSERT INTO shared.import_log
          (source_path, source_object_name, source_object_type, target_database_id, status, error_message, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [sourcePath, objectName, objectType, targetDatabaseId || '_none', status, errorMessage, details ? JSON.stringify(details) : null]);
      return result.rows[0]?.id || null;
    } catch (logErr) {
      console.error('Error writing to import_log:', logErr);
      return null;
    }
  };
}

// Default scan locations — use the current user's Desktop and Documents
const userProfile = process.env.USERPROFILE || process.env.HOME || '';
const DEFAULT_SCAN_LOCATIONS = userProfile ? [
  path.join(userProfile, 'Desktop'),
  path.join(userProfile, 'Documents')
] : [];

/**
 * Run a PowerShell script and return the output
 */
async function runPowerShell(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args
    ];

    const ps = spawn('powershell.exe', psArgs);
    let stdout = '';
    let stderr = '';

    // Use setEncoding to avoid garbling UTF-8 chars split across chunks
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');

    ps.stdout.on('data', (data) => {
      stdout += data;
    });

    ps.stderr.on('data', (data) => {
      stderr += data;
    });

    ps.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `PowerShell exited with code ${code}`));
      }
    });

    ps.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Recursively scan a directory for .accdb files
 */
async function scanDirectory(dirPath, results = []) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Skip system and hidden directories
        if (!entry.name.startsWith('.') &&
            !entry.name.startsWith('$') &&
            entry.name !== 'node_modules' &&
            entry.name !== 'AppData') {
          try {
            await scanDirectory(fullPath, results);
          } catch (err) {
            // Skip directories we can't access
          }
        }
      } else if (entry.name.toLowerCase().endsWith('.accdb') ||
                 entry.name.toLowerCase().endsWith('.mdb')) {
        try {
          const stats = await fs.stat(fullPath);
          results.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            modified: stats.mtime
          });
        } catch (err) {
          // Skip files we can't stat
        }
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }

  return results;
}

/**
 * Parse PowerShell JSON output — strips BOM and extracts JSON object.
 */
function parsePowerShellJson(output) {
  const cleanOutput = output.replace(/^\uFEFF/, '').trim();
  const jsonStart = cleanOutput.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('No JSON object found in PowerShell output');
  }
  return JSON.parse(cleanOutput.substring(jsonStart));
}

module.exports = {
  makeLogImport, DEFAULT_SCAN_LOCATIONS, runPowerShell, scanDirectory, parsePowerShellJson
};
