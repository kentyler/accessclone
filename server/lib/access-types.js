/**
 * Shared utilities for Access → PostgreSQL type mapping.
 * Used by both metadata.js (table design view) and access-import.js (table import).
 */

/**
 * Map an Access field descriptor to a PostgreSQL type string.
 * @param {Object} field - { type, maxLength, fieldSize, precision, scale }
 * @returns {string} PostgreSQL type
 */
function resolveType(field) {
  const t = (field.type || '').trim();
  switch (t) {
    case 'Short Text':
      return `character varying(${field.maxLength || 255})`;
    case 'Long Text':
      return 'text';
    case 'Number': {
      const fs = (field.fieldSize || 'Long Integer').trim();
      switch (fs) {
        case 'Byte':         return 'smallint';
        case 'Integer':      return 'smallint';
        case 'Long Integer': return 'integer';
        case 'Single':       return 'real';
        case 'Double':       return 'double precision';
        case 'Decimal':      return `numeric(${field.precision || 18},${field.scale || 0})`;
        default:             return 'integer';
      }
    }
    case 'Yes/No':
      return 'boolean';
    case 'Date/Time':
      return 'timestamp without time zone';
    case 'Currency':
      return 'numeric(19,4)';
    case 'AutoNumber':
      return 'integer';
    default:
      // Pass through raw PG types, fall back to text
      return t || 'text';
  }
}

/**
 * Quote a SQL identifier (table/column name).
 */
function quoteIdent(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

module.exports = { resolveType, quoteIdent };
