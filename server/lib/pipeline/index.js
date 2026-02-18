/**
 * Pipeline module — testable, per-module, swappable steps.
 *
 * Re-exports everything from steps.js and runner.js.
 */

const { steps, getStep, listStrategies } = require('./steps');
const { runStep, runPipeline, getModuleStatus, hasUnresolvedGaps, STEP_ORDER } = require('./runner');

module.exports = {
  // Step definitions
  steps,
  getStep,
  listStrategies,

  // Runner
  runStep,
  runPipeline,
  getModuleStatus,
  hasUnresolvedGaps,
  STEP_ORDER
};
