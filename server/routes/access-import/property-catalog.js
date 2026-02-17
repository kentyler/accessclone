/**
 * Property catalog routes.
 * GET /property-catalog — Query the Access property reference catalog
 */

const { logError } = require('../../lib/events');

module.exports = function(router, pool) {

  /**
   * GET /api/access-import/property-catalog
   * Query the property catalog with optional filters.
   *
   * Query params:
   *   version     - Access version ('1997', '2000', '2003', '2007', '2010', '2013', '2016', '2021')
   *   objectType  - 'table', 'query', 'form', 'report', 'module', 'macro', 'relationship'
   *   subtype     - 'field', 'index', 'section', 'control', 'combo-box', 'text-box', etc. (empty string or omitted for object-level)
   *   status      - 'imported', 'skipped', 'planned', 'not-applicable'
   */
  router.get('/property-catalog', async (req, res) => {
    try {
      const { version, objectType, subtype, status } = req.query;

      const conditions = [];
      const params = [];
      let idx = 1;

      if (version) {
        // Return properties from this version and all earlier versions
        conditions.push(`access_version <= $${idx++}`);
        params.push(version);
      }

      if (objectType) {
        conditions.push(`object_type = $${idx++}`);
        params.push(objectType);
      }

      if (subtype !== undefined) {
        // Empty string = object-level properties (no subtype)
        conditions.push(`object_subtype = $${idx++}`);
        params.push(subtype);
      }

      if (status) {
        conditions.push(`import_status = $${idx++}`);
        params.push(status);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      const result = await pool.query(`
        SELECT
          id, access_version, object_type, object_subtype,
          property_name, property_data_type, default_value,
          enum_values, import_status, skip_reason, notes
        FROM shared.access_property_catalog
        ${whereClause}
        ORDER BY object_type, object_subtype, property_name
      `, params);

      res.json({
        count: result.rows.length,
        properties: result.rows
      });
    } catch (err) {
      console.error('Error querying property catalog:', err);
      logError(pool, 'GET /api/access-import/property-catalog', 'Failed to query property catalog', err);
      res.status(500).json({ error: 'Failed to query property catalog' });
    }
  });

};
