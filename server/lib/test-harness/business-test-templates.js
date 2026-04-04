/**
 * Business Test Templates — generate predicate assertions from business intents.
 * Checks entity references, related object existence, category consistency.
 */

/**
 * Generate business predicate assertions from a business intent.
 *
 * @param {string} objectType - 'form' | 'report'
 * @param {string} objectName
 * @param {Object} businessIntent - extracted business intent JSON
 * @returns {Array<{id: string, description: string, predicate: Object}>}
 */
function generateBusinessAssertions(objectType, objectName, businessIntent) {
  if (!businessIntent) return [];
  const assertions = [];
  const prefix = `${objectType}:${objectName}:business`;
  let idx = 0;

  // Entity references — the tables/queries this object claims to use
  const entities = businessIntent.entities || [];
  for (const entity of entities) {
    assertions.push({
      id: `${prefix}:${idx++}`,
      description: `References entity "${entity}"`,
      predicate: { type: 'entity_referenced', entity }
    });
  }

  // Data flows — check that referenced tables exist
  const dataFlows = businessIntent.data_flows || [];
  for (const flow of dataFlows) {
    if (flow.target) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Data flow target "${flow.target}" exists`,
        predicate: { type: 'entity_referenced', entity: flow.target }
      });
    }
  }

  // Related objects from navigation (forms only)
  const opens = businessIntent.opens || [];
  for (const op of opens) {
    if (op.target_name) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Related ${op.target_type || 'object'} "${op.target_name}" exists`,
        predicate: { type: 'related_object_exists', object_name: op.target_name, object_type: op.target_type || 'form' }
      });
    }
  }

  // Consumer references (reports only)
  const consumers = businessIntent.consumers || [];
  // No direct assertion for consumers — they describe who uses the report, not something testable
  // in the definition itself.

  // Category consistency
  if (businessIntent.category) {
    assertions.push({
      id: `${prefix}:${idx++}`,
      description: `Category "${businessIntent.category}" matches structural evidence`,
      predicate: { type: 'category_matches_evidence', category: businessIntent.category }
    });
  }

  return assertions;
}

module.exports = { generateBusinessAssertions };
