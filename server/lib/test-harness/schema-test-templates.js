/**
 * Schema Test Templates — generate predicate assertions from schema snapshots.
 * Checks column existence, types, nullability, FK relationships, defaults.
 */

/**
 * Generate schema predicate assertions from a schema snapshot.
 *
 * @param {string} tableName
 * @param {Object} schemaSnapshot - { columns, foreignKeys, checkConstraints }
 * @returns {Array<{id: string, description: string, predicate: Object}>}
 */
function generateSchemaAssertions(tableName, schemaSnapshot) {
  if (!schemaSnapshot) return [];
  const assertions = [];
  const prefix = `table:${tableName}:schema`;
  let idx = 0;

  const columns = schemaSnapshot.columns || [];
  for (const col of columns) {
    // Column existence + type
    assertions.push({
      id: `${prefix}:${idx++}`,
      description: `Column "${col.name}" exists with type "${col.type}"`,
      predicate: { type: 'table_has_column', table: tableName, column: col.name, data_type: col.type }
    });

    // Nullability
    assertions.push({
      id: `${prefix}:${idx++}`,
      description: `Column "${col.name}" nullable=${col.nullable}`,
      predicate: { type: 'column_nullable', table: tableName, column: col.name, nullable: col.nullable }
    });

    // Default value
    if (col.default !== null && col.default !== undefined) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Column "${col.name}" has default`,
        predicate: { type: 'column_has_default', table: tableName, column: col.name, default_value: col.default }
      });
    }
  }

  // Foreign keys
  const foreignKeys = schemaSnapshot.foreignKeys || [];
  for (const fk of foreignKeys) {
    assertions.push({
      id: `${prefix}:${idx++}`,
      description: `Column "${fk.column}" has FK to "${fk.references_table}.${fk.references_column}"`,
      predicate: {
        type: 'column_has_fk',
        table: tableName,
        column: fk.column,
        references_table: fk.references_table,
        references_column: fk.references_column
      }
    });
  }

  return assertions;
}

module.exports = { generateSchemaAssertions };
