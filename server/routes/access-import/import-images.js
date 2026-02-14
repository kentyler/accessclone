/**
 * Image import route.
 * POST /import-images — Extract PictureData from Access form/report image controls
 * and patch the saved definitions with data URIs.
 */

const path = require('path');
const { logError } = require('../../lib/events');
const { runPowerShell, parsePowerShellJson } = require('./helpers');

module.exports = function(router, pool) {

  router.post('/import-images', async (req, res) => {
    const { databasePath, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !targetDatabaseId) {
        return res.status(400).json({ error: 'databasePath and targetDatabaseId required' });
      }

      // 1. Run export_images.ps1 to extract all image data
      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_images.ps1');

      // Collect form and report names from the target database
      const [formsResult, reportsResult] = await Promise.all([
        pool.query(
          `SELECT DISTINCT name FROM shared.forms WHERE database_id = $1 AND is_current = true`,
          [targetDatabaseId]
        ),
        pool.query(
          `SELECT DISTINCT name FROM shared.reports WHERE database_id = $1 AND is_current = true`,
          [targetDatabaseId]
        )
      ]);

      const formNames = formsResult.rows.map(r => r.name);
      const reportNames = reportsResult.rows.map(r => r.name);

      if (formNames.length === 0 && reportNames.length === 0) {
        return res.json({ success: true, imageCount: 0, updated: [] });
      }

      const args = ['-DatabasePath', databasePath];
      if (formNames.length > 0) {
        args.push('-FormNames', formNames.join(','));
      }
      if (reportNames.length > 0) {
        args.push('-ReportNames', reportNames.join(','));
      }

      let imageData;
      try {
        const jsonOutput = await runPowerShell(exportScript, args);
        // Parse JSON robustly — find first '{' and last '}' to ignore any surrounding output
        const clean = jsonOutput.replace(/^\uFEFF/, '').trim();
        const jsonStart = clean.indexOf('{');
        const jsonEnd = clean.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
          throw new Error('No JSON object found in PowerShell output');
        }
        imageData = JSON.parse(clean.substring(jsonStart, jsonEnd + 1));
      } catch (psErr) {
        console.error('PowerShell export_images.ps1 failed:', psErr.message);
        return res.status(500).json({ error: `Image extraction failed: ${psErr.message}` });
      }

      const images = imageData.images || [];
      if (images.length === 0) {
        return res.json({ success: true, imageCount: 0, updated: [] });
      }

      // 2. Group images by object type and name
      const byObject = {};
      for (const img of images) {
        const key = `${img.objectType}:${img.objectName}`;
        if (!byObject[key]) byObject[key] = [];
        byObject[key].push(img);
      }

      // 3. For each object, load definition, patch image controls, save new version
      const updated = [];

      for (const [key, imgs] of Object.entries(byObject)) {
        const [objectType, objectName] = key.split(':');
        const table = objectType === 'form' ? 'shared.forms' : 'shared.reports';

        try {
          // Load current definition
          const defResult = await pool.query(
            `SELECT definition FROM ${table} WHERE database_id = $1 AND name = $2 AND is_current = true`,
            [targetDatabaseId, objectName]
          );
          if (defResult.rows.length === 0) continue;

          let definition;
          try {
            definition = JSON.parse(defResult.rows[0].definition);
          } catch {
            continue;
          }

          let modified = false;

          // Build lookup: controlName -> data URI
          const imageMap = {};
          for (const img of imgs) {
            imageMap[img.controlName] = `data:${img.mimeType};base64,${img.base64}`;
          }

          // Scan all sections for matching image/object-frame controls
          for (const [sectionKey, section] of Object.entries(definition)) {
            if (!section || !Array.isArray(section.controls)) continue;
            for (const ctrl of section.controls) {
              const ctrlName = ctrl.name || ctrl.id || '';
              if (imageMap[ctrlName]) {
                ctrl.picture = imageMap[ctrlName];
                modified = true;
                updated.push({
                  objectType,
                  objectName,
                  controlName: ctrlName
                });
              }
            }
          }

          // Save updated definition as new version
          if (modified) {
            const content = JSON.stringify(definition);
            const recordSource = definition['record-source'] || definition.recordSource || null;

            const client = await pool.connect();
            try {
              await client.query('BEGIN');

              const versionResult = await client.query(
                `SELECT COALESCE(MAX(version), 0) AS max_version FROM ${table} WHERE database_id = $1 AND name = $2`,
                [targetDatabaseId, objectName]
              );
              const newVersion = versionResult.rows[0].max_version + 1;

              await client.query(
                `UPDATE ${table} SET is_current = false WHERE database_id = $1 AND name = $2 AND is_current = true`,
                [targetDatabaseId, objectName]
              );

              await client.query(
                `INSERT INTO ${table} (database_id, name, definition, record_source, version, is_current) VALUES ($1, $2, $3, $4, $5, true)`,
                [targetDatabaseId, objectName, content, recordSource, newVersion]
              );

              await client.query('COMMIT');
            } catch (txErr) {
              await client.query('ROLLBACK');
              throw txErr;
            } finally {
              client.release();
            }
          }
        } catch (objErr) {
          console.error(`Error patching images for ${objectType} "${objectName}":`, objErr.message);
        }
      }

      console.log(`[IMAGES] Imported ${updated.length} images into ${Object.keys(byObject).length} objects`);

      res.json({
        success: true,
        imageCount: updated.length,
        updated
      });
    } catch (err) {
      console.error('Error importing images:', err);
      logError(pool, 'POST /api/access-import/import-images', 'Failed to import images', err, {
        details: { databasePath, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to import images' });
    }
  });

  /**
   * GET /api/access-import/image-status?targetDatabaseId=...
   * List all image controls in saved form/report definitions with their import status.
   */
  router.get('/image-status', async (req, res) => {
    const { targetDatabaseId } = req.query;
    try {
      if (!targetDatabaseId) {
        return res.status(400).json({ error: 'targetDatabaseId required' });
      }

      const [formsResult, reportsResult] = await Promise.all([
        pool.query(
          `SELECT name, definition FROM shared.forms WHERE database_id = $1 AND is_current = true`,
          [targetDatabaseId]
        ),
        pool.query(
          `SELECT name, definition FROM shared.reports WHERE database_id = $1 AND is_current = true`,
          [targetDatabaseId]
        )
      ]);

      const images = [];

      function collectImages(rows, objectType) {
        for (const row of rows) {
          let def;
          try { def = JSON.parse(row.definition); } catch { continue; }
          for (const [key, section] of Object.entries(def)) {
            if (!section || !Array.isArray(section.controls)) continue;
            for (const ctrl of section.controls) {
              if (ctrl.type === 'image' || ctrl.type === ':image' ||
                  ctrl.type === 'object-frame' || ctrl.type === ':object-frame') {
                images.push({
                  name: `${row.name} / ${ctrl.name || ctrl.id || 'unnamed'}`,
                  objectType,
                  objectName: row.name,
                  controlName: ctrl.name || ctrl.id || '',
                  section: key,
                  imported: !!(ctrl.picture && ctrl.picture.startsWith('data:'))
                });
              }
            }
          }
        }
      }

      collectImages(formsResult.rows, 'form');
      collectImages(reportsResult.rows, 'report');

      const total = images.length;
      const imported = images.filter(i => i.imported).length;

      res.json({ total, imported, images });
    } catch (err) {
      console.error('Error checking image status:', err);
      res.status(500).json({ error: err.message });
    }
  });

};
