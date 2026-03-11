/**
 * Attachment import route.
 * POST /import-attachments — Extract files from Access attachment columns (DAO type 101)
 * and store them on disk with metadata in shared.attachments.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { logError } = require('../../lib/events');
const { sanitizeName } = require('../../lib/query-converter');
const { quoteIdent } = require('../../lib/access-types');
const { runPowerShell, parsePowerShellJson } = require('./helpers');

// Simple extension → MIME type map
const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.zip': 'application/zip',
};

function detectMime(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

module.exports = function(router, pool) {

  router.post('/import-attachments', async (req, res) => {
    const { databasePath, tableName, targetDatabaseId } = req.body;

    if (!databasePath || !tableName || !targetDatabaseId) {
      return res.status(400).json({ error: 'databasePath, tableName, and targetDatabaseId required' });
    }

    const stagingDir = path.join(__dirname, '..', '..', 'uploads', '.staging', crypto.randomUUID());
    const uploadsBase = path.join(__dirname, '..', '..', 'uploads', 'attachments');

    try {
      // 1. Run export_attachments.ps1
      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_attachments.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-TableName', tableName,
        '-OutputDir', stagingDir
      ]);

      const manifest = parsePowerShellJson(jsonOutput);

      if (manifest.error) {
        return res.status(500).json({ error: manifest.error });
      }

      if (!manifest.files || manifest.files.length === 0) {
        // Clean up empty staging dir
        fs.rmSync(stagingDir, { recursive: true, force: true });
        return res.json({ success: true, count: 0, tableName, attachmentColumns: manifest.attachmentColumns || [] });
      }

      // 2. Move files from staging to permanent location and UPSERT metadata
      // Sanitize table name for filesystem use
      const safeTable = tableName.replace(/[\\/:*?"<>|]/g, '_').toLowerCase();
      let upsertCount = 0;

      for (const file of manifest.files) {
        const safeKey = String(file.pkValue).replace(/[\\/:*?"<>|]/g, '_');
        const permanentDir = path.join(uploadsBase, targetDatabaseId, safeTable, safeKey);
        fs.mkdirSync(permanentDir, { recursive: true });

        const srcPath = path.join(stagingDir, safeKey, file.fileName);
        const destPath = path.join(permanentDir, file.fileName);

        // Move file from staging to permanent location
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          fs.unlinkSync(srcPath);
        } else {
          console.error(`[import-attachments] Staging file not found: ${srcPath}`);
          continue;
        }

        const mimeType = detectMime(file.fileName);

        // UPSERT into shared.attachments
        await pool.query(
          `INSERT INTO shared.attachments
             (database_id, table_name, pk_column, pk_value, column_name, file_name, file_path, mime_type, file_size, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (database_id, table_name, pk_value, column_name, file_name)
           DO UPDATE SET file_path = $7, mime_type = $8, file_size = $9, sort_order = $10`,
          [
            targetDatabaseId,
            tableName,
            manifest.pkColumn,
            String(file.pkValue),
            file.columnName,
            file.fileName,
            destPath,
            mimeType,
            file.sizeBytes || 0,
            file.sortOrder || 0
          ]
        );

        upsertCount++;
      }

      // 3. Update the actual table column with file paths
      // Group files by (pkValue, columnName) — attachment fields can have multiple files per record
      const byRecord = {};
      for (const file of manifest.files) {
        const key = `${file.pkValue}::${file.columnName}`;
        if (!byRecord[key]) byRecord[key] = { pkValue: file.pkValue, columnName: file.columnName, paths: [] };
        const safeKey = String(file.pkValue).replace(/[\\/:*?"<>|]/g, '_');
        byRecord[key].paths.push(`/attachments/${targetDatabaseId}/${safeTable}/${safeKey}/${file.fileName}`);
      }

      // Look up schema name for the target database
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [targetDatabaseId]
      );
      if (dbResult.rows.length > 0) {
        const schemaName = dbResult.rows[0].schema_name;
        const pgTable = sanitizeName(tableName);
        const pgPkCol = sanitizeName(manifest.pkColumn);

        for (const rec of Object.values(byRecord)) {
          const pgColName = sanitizeName(rec.columnName);
          // Single file → plain path; multiple files → JSON array
          const value = rec.paths.length === 1 ? rec.paths[0] : JSON.stringify(rec.paths);
          try {
            await pool.query(
              `UPDATE ${quoteIdent(schemaName)}.${quoteIdent(pgTable)}
               SET ${quoteIdent(pgColName)} = $1
               WHERE ${quoteIdent(pgPkCol)} = $2`,
              [value, rec.pkValue]
            );
          } catch (updateErr) {
            // Column may not exist yet (table imported without attachment support) — log and continue
            console.warn(`[import-attachments] Could not update ${pgTable}.${pgColName}: ${updateErr.message}`);
          }
        }
      }

      // 4. Clean up staging directory
      fs.rmSync(stagingDir, { recursive: true, force: true });

      res.json({
        success: true,
        count: upsertCount,
        tableName,
        attachmentColumns: manifest.attachmentColumns || []
      });

    } catch (err) {
      // Clean up staging on error
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
      await logError(pool, 'POST /api/access-import/import-attachments', err.message, err, { databaseId: targetDatabaseId });
      res.status(500).json({ error: err.message });
    }
  });

};
