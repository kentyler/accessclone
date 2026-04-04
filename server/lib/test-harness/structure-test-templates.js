/**
 * Structure Test Templates — generate predicate assertions from structure intents.
 * Forms: section existence, control existence, subform links, record-source, properties.
 * Reports: band existence, grouping fields, control existence.
 */

/**
 * Generate structure predicate assertions from a structure intent.
 *
 * @param {string} objectType - 'form' | 'report'
 * @param {string} objectName
 * @param {Object} structureIntent - extracted structure intent JSON
 * @returns {Array<{id: string, description: string, predicate: Object}>}
 */
function generateStructureAssertions(objectType, objectName, structureIntent) {
  if (!structureIntent) return [];
  const assertions = [];
  const prefix = `${objectType}:${objectName}:structure`;
  let idx = 0;

  if (objectType === 'form') {
    // Section existence
    const sections = structureIntent.layout?.sections_used || [];
    for (const section of sections) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Form has ${section} section`,
        predicate: { type: 'definition_has_section', section }
      });
    }

    // Subform links
    const subpatterns = structureIntent.subpatterns || [];
    for (const sp of subpatterns) {
      if (sp.type === 'subform-link' && sp.controls) {
        for (const ctrl of sp.controls) {
          assertions.push({
            id: `${prefix}:${idx++}`,
            description: `Subform control "${ctrl}" exists`,
            predicate: { type: 'definition_has_subform', control_name: ctrl }
          });
        }
      }
      if (sp.type === 'tab-organization' && sp.controls) {
        for (const ctrl of sp.controls) {
          assertions.push({
            id: `${prefix}:${idx++}`,
            description: `Tab control "${ctrl}" exists`,
            predicate: { type: 'definition_has_control', control_name: ctrl }
          });
        }
      }
    }

    // Record source
    const mode = structureIntent.record_interaction?.mode;
    if (mode && mode !== 'unbound') {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: 'Form has a record source',
        predicate: { type: 'definition_has_record_source' }
      });
    } else if (mode === 'unbound') {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: 'Form has no record source (unbound)',
        predicate: { type: 'definition_has_no_record_source' }
      });
    }

    // Continuous forms check
    if (structureIntent.layout?.continuous) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: 'Form is continuous',
        predicate: { type: 'definition_property_equals', property: 'default-view', value: 'Continuous Forms' }
      });
    }
  }

  if (objectType === 'report') {
    // Band existence
    const bands = structureIntent.layout?.bands_used || [];
    for (const band of bands) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Report has ${band} band`,
        predicate: { type: 'has_band', band }
      });
    }

    // Grouping fields
    const groupFields = structureIntent.layout?.grouping_fields || [];
    for (const field of groupFields) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Report groups on field "${field}"`,
        predicate: { type: 'grouping_uses_field', field }
      });
    }

    // Subreports
    const subreports = structureIntent.navigation?.subreports || [];
    for (const sr of subreports) {
      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Subreport "${sr.name}" exists`,
        predicate: { type: 'definition_has_subform', control_name: sr.name }
      });
    }
  }

  // Pattern assertion (applies to both)
  if (structureIntent.pattern) {
    assertions.push({
      id: `${prefix}:${idx++}`,
      description: `Pattern is "${structureIntent.pattern}"`,
      predicate: { type: 'definition_property_equals', property: '__pattern', value: structureIntent.pattern }
    });
  }

  return assertions;
}

module.exports = { generateStructureAssertions };
