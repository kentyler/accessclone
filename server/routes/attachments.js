/**
 * Attachment serving routes.
 * GET /api/attachments/:databaseId/:table/:pkValue/:column — metadata (JSON array)
 * GET /api/attachments/:id/file — serve the actual file
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

module.exports = function(pool) {
  const router = express.Router();

  /**
   * GET /:databaseId/:table/:pkValue/:column
   * Return metadata for all attachments matching the given record + column.
   */
  router.get('/:databaseId/:table/:pkValue/:column', async (req, res) => {
    const { databaseId, table, pkValue, column } = req.params;

    try {
      const result = await pool.query(
        `SELECT id, file_name, mime_type, file_size, sort_order
         FROM shared.attachments
         WHERE database_id = $1 AND LOWER(table_name) = LOWER($2)
           AND pk_value = $3 AND LOWER(column_name) = LOWER($4)
         ORDER BY sort_order, file_name`,
        [databaseId, table, pkValue, column]
      );

      const files = result.rows.map(row => ({
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        url: `/api/attachments/${row.id}/file`
      }));

      res.json(files);
    } catch (err) {
      console.error('[attachments] metadata error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /:id/file
   * Serve the actual attachment file.
   */
  router.get('/:id/file', async (req, res) => {
    const { id } = req.params;

    try {
      const result = await pool.query(
        'SELECT file_path, mime_type, file_name FROM shared.attachments WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Attachment not found' });
      }

      const { file_path: filePath, mime_type: mimeType, file_name: fileName } = result.rows[0];

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      res.sendFile(path.resolve(filePath));
    } catch (err) {
      console.error('[attachments] file serve error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
