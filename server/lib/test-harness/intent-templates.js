/**
 * Intent Test Templates — maps each of the 30 intent types in INTENT_VOCABULARY
 * to a test assertion template for auto-generated tests.
 *
 * Each template returns:
 *   { description, setup: { overrides }, assertions: [{ type, ...params }] }
 *
 * Assertion types:
 *   - calledWith(method, ...expectedArgs) — method was called with specific args
 *   - called(method) — method was called at least once
 *   - alertCalled — alert/confirm was called
 *   - noThrow — handler executed without throwing
 */

/**
 * Build a test template for an intent.
 * @param {Object} intent - { type, params }
 * @returns {{ description: string, setup: { overrides: Object }, assertions: Array }}
 */
function getIntentTemplate(intent) {
  const type = intent.type || intent.intent_type;
  const params = intent.params || {};

  switch (type) {
    case 'open-form':
      return {
        description: `opens form "${params.form_name || params.target || '?'}"`,
        setup: { overrides: {} },
        assertions: [
          params.form_name || params.target
            ? { type: 'calledWith', method: 'openForm', args: [params.form_name || params.target] }
            : { type: 'called', method: 'openForm' }
        ]
      };

    case 'open-form-filtered':
      return {
        description: `opens form "${params.form_name || params.target || '?'}" with filter`,
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'openForm' }]
      };

    case 'open-report':
      return {
        description: `opens report "${params.report_name || params.target || '?'}"`,
        setup: { overrides: {} },
        assertions: [
          params.report_name || params.target
            ? { type: 'calledWith', method: 'openReport', args: [params.report_name || params.target] }
            : { type: 'called', method: 'openReport' }
        ]
      };

    case 'close-form':
      return {
        description: `closes form "${params.form_name || params.target || 'specified'}"`,
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'closeForm' }]
      };

    case 'close-current':
      return {
        description: 'closes current form',
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'closeForm' }]
      };

    case 'goto-record':
      return {
        description: `navigates to record (${params.direction || 'specified'})`,
        setup: { overrides: {} },
        assertions: [
          params.direction
            ? { type: 'calledWith', method: 'gotoRecord', args: [params.direction] }
            : { type: 'called', method: 'gotoRecord' }
        ]
      };

    case 'new-record':
      return {
        description: 'navigates to new record',
        setup: { overrides: {} },
        assertions: [{ type: 'calledWith', method: 'gotoRecord', args: ['new'] }]
      };

    case 'save-record':
      return {
        description: 'saves current record',
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'saveRecord' }]
      };

    case 'delete-record':
      return {
        description: 'deletes current record',
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'deleteRecord' }]
      };

    case 'requery':
      return {
        description: 'requeries the form',
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'requery' }]
      };

    case 'set-control-visible':
      return {
        description: `sets visibility of "${params.control || '?'}"`,
        setup: { overrides: {} },
        assertions: [
          params.control
            ? { type: 'calledWith', method: 'setVisible', args: [params.control, params.value !== undefined ? params.value : null] }
            : { type: 'called', method: 'setVisible' }
        ]
      };

    case 'set-control-enabled':
      return {
        description: `sets enabled state of "${params.control || '?'}"`,
        setup: { overrides: {} },
        assertions: [
          params.control
            ? { type: 'calledWith', method: 'setEnabled', args: [params.control, params.value !== undefined ? params.value : null] }
            : { type: 'called', method: 'setEnabled' }
        ]
      };

    case 'set-control-value':
      return {
        description: 'sets a control value',
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'setValue' }]
      };

    case 'validate-required':
      return {
        description: `validates required field "${params.field || '?'}"`,
        setup: { overrides: { getValue: null } },
        assertions: [{ type: 'alertCalled' }]
      };

    case 'validate-condition':
      return {
        description: 'validates a condition',
        setup: { overrides: {} },
        assertions: [{ type: 'noThrow' }]
      };

    case 'show-message':
      return {
        description: `shows message "${(params.message || '').substring(0, 40)}"`,
        setup: { overrides: {} },
        assertions: [{ type: 'alertCalled' }]
      };

    case 'confirm-action':
      return {
        description: 'shows confirmation dialog',
        setup: { overrides: {} },
        assertions: [{ type: 'alertCalled' }]
      };

    case 'set-filter':
      return {
        description: 'sets form filter',
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'setFilter' }]
      };

    case 'set-record-source':
      return {
        description: 'sets form record source',
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'setRecordSource' }]
      };

    case 'set-tempvar':
      return {
        description: `sets TempVar "${params.name || '?'}"`,
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'setTempVar' }]
      };

    case 'dlookup':
      return {
        description: `DLookup on "${params.domain || '?'}"`,
        setup: { overrides: { dLookup: 0 } },
        assertions: [{ type: 'called', method: 'dLookup' }]
      };

    case 'dcount':
      return {
        description: `DCount on "${params.domain || '?'}"`,
        setup: { overrides: { dCount: 0 } },
        assertions: [{ type: 'called', method: 'dCount' }]
      };

    case 'dsum':
      return {
        description: `DSum on "${params.domain || '?'}"`,
        setup: { overrides: { dSum: 0 } },
        assertions: [{ type: 'called', method: 'dSum' }]
      };

    case 'run-sql':
      return {
        description: 'executes SQL',
        setup: { overrides: { runSQL: undefined } },
        assertions: [{ type: 'called', method: 'runSQL' }]
      };

    case 'read-field':
      return {
        description: `reads field "${params.field || '?'}"`,
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'getValue' }]
      };

    case 'write-field':
      return {
        description: `writes field "${params.field || '?'}"`,
        setup: { overrides: {} },
        assertions: [{ type: 'called', method: 'setValue' }]
      };

    // Structural intents — just verify no crash
    case 'branch':
    case 'value-switch':
    case 'loop':
    case 'error-handler':
    case 'gap':
      return {
        description: `structural: ${type}`,
        setup: { overrides: {} },
        assertions: [{ type: 'noThrow' }]
      };

    default:
      return {
        description: `unknown intent: ${type}`,
        setup: { overrides: {} },
        assertions: [{ type: 'noThrow' }]
      };
  }
}

module.exports = { getIntentTemplate };
