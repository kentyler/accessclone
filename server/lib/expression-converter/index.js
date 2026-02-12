/**
 * Expression Converter — translates Access control-source expressions
 * containing domain functions (DLookUp, DCount, DSum, etc.) into
 * PostgreSQL LANGUAGE SQL STABLE functions.
 *
 * Simple expressions (IIf, math, string ops) are handled client-side.
 * This module only processes expressions that require database access.
 */

const { sanitizeName } = require('../query-converter');
const { hasDomainFunctions, translateCriteria, translateDomainFunction } = require('./domain-functions');
const { translateAccessFunctions } = require('./access-functions');
const { translateFormSelfRefs, translateExpression, buildFunctionDDL, getColumnTypes, processDefinitionExpressions } = require('./pipeline');

module.exports = {
  hasDomainFunctions,
  translateExpression,
  buildFunctionDDL,
  getColumnTypes,
  processDefinitionExpressions,
  // Exported for testing
  translateCriteria,
  translateDomainFunction,
  translateAccessFunctions,
  translateFormSelfRefs,
  sanitizeName
};
