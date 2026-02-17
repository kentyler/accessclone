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
        case 'Big Integer':  return 'bigint';
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
    case 'Date/Time Extended':
      return 'timestamp with time zone';
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
 * Map a DAO DataTypeEnum code (from export_table.ps1) to a resolveType-compatible descriptor.
 * DAO codes: 1=Boolean, 2=Byte, 3=Integer, 4=Long, 5=Currency, 6=Single, 7=Double,
 * 8=Date/Time, 10=Text, 12=Memo, 15=GUID, 16=BigInt, 18=Calculated, 20=Decimal,
 * 26=DateTimeExtended.
 * Skipped by export_table.ps1: 11=OLE, 17=Binary, 19/101=Attachment, 102-109=MultiValue.
 * @param {Object} field - { type (DAO code), size, isAutoNumber, resultType, precision, scale }
 * @returns {Object} descriptor for resolveType
 */
function mapAccessType(field) {
  const code = field.type;
  const isAutoNum = field.isAutoNumber;
  switch (code) {
    case 1:  return { type: 'Yes/No' };
    case 2:  return { type: 'Number', fieldSize: 'Byte' };
    case 3:  return { type: 'Number', fieldSize: 'Integer' };
    case 4:  return isAutoNum
               ? { type: 'AutoNumber' }
               : { type: 'Number', fieldSize: 'Long Integer' };
    case 5:  return { type: 'Currency' };
    case 6:  return { type: 'Number', fieldSize: 'Single' };
    case 7:  return { type: 'Number', fieldSize: 'Double' };
    case 8:  return { type: 'Date/Time' };
    case 10: return { type: 'Short Text', maxLength: field.size || 255 };
    case 12: return { type: 'Long Text' };
    case 15: return { type: 'Short Text', maxLength: 38 };
    case 16: return { type: 'Number', fieldSize: 'Big Integer' };
    case 18: {
      const rt = field.resultType || 10;
      return mapAccessType({ ...field, type: rt, isAutoNumber: false });
    }
    case 20: return { type: 'Number', fieldSize: 'Decimal',
                      precision: field.precision || 18, scale: field.scale || 0 };
    case 26: return { type: 'Date/Time Extended' };
    default: return { type: 'Short Text', maxLength: 255 };
  }
}

/**
 * Quote a SQL identifier (table/column name).
 */
function quoteIdent(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

module.exports = { resolveType, mapAccessType, quoteIdent };
