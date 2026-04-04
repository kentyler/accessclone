/**
 * Mock AC Runtime — recording mock of all window.AC methods.
 * Used for testing VBA-to-JS handler output without a browser.
 */

// All methods from runtime.ts installRuntime() (lines 526-593)
const AC_METHODS = [
  // Core navigation
  'openForm', 'openReport', 'closeForm', 'gotoRecord', 'saveRecord',
  'requery', 'setVisible', 'setEnabled', 'setValue', 'setSubformSource',
  'runSQL', 'setFocus', 'requeryControl', 'undo', 'setRecordSource',
  'setFormCaption', 'setFilter', 'setFilterOn',
  // Getters
  'getValue', 'getVisible', 'getEnabled', 'isDirty', 'isNewRecord',
  'getOpenArgs', 'nz',
  // Domain aggregates
  'dCount', 'dLookup', 'dMin', 'dMax', 'dSum',
  // TempVars
  'getTempVar', 'setTempVar', 'removeTempVar', 'removeAllTempVars',
  // Cross-module
  'callFn', 'registerFnHandler',
  // Property setters
  'setLocked', 'setBackColor', 'setForeColor', 'setBackShade', 'setBackStyle',
  'setDefaultValue',
  // Property getters
  'getBackColor', 'getForeColor', 'getBackShade', 'getBackStyle', 'getLocked',
  // Allow* setters
  'setAllowEdits', 'setAllowAdditions', 'setAllowDeletions',
  'setNavigationCaption', 'setSubformAllow',
  // Control/TempVar enumeration
  'getControlNames', 'getTempVarNames',
  // Cross-form
  'getFormValue', 'requeryForm', 'focusForm',
  // Misc
  'setAppTitle', 'dateAdd', 'dateDiff', 'formatValue',
  'deleteRecord', 'searchForRecord', 'getFilter', 'getFilterOn',
  // alert/confirm (not on window.AC but used by handlers via window.alert)
  'alert'
];

// Async methods that return Promises
const ASYNC_METHODS = new Set([
  'dCount', 'dLookup', 'dMin', 'dMax', 'dSum',
  'callFn', 'runSQL'
]);

// Getter methods that return values
const GETTER_DEFAULTS = {
  getValue: null,
  getVisible: true,
  getEnabled: true,
  isDirty: false,
  isNewRecord: false,
  getOpenArgs: null,
  nz: null,
  getBackColor: null,
  getForeColor: null,
  getBackShade: null,
  getBackStyle: null,
  getLocked: false,
  getControlNames: [],
  getTempVarNames: [],
  getFormValue: null,
  getTempVar: null,
  getFilter: '',
  getFilterOn: false
};

/**
 * Create a recording mock of all AC methods.
 * @param {Object} overrides - Map of method names to return values or functions
 * @returns {{ ac: Object, calls: Array, reset: Function }}
 */
function createMockAC(overrides = {}) {
  const calls = [];

  function reset() {
    calls.length = 0;
  }

  const ac = {};

  for (const method of AC_METHODS) {
    ac[method] = (...args) => {
      calls.push({ method, args });

      // Check for override
      if (method in overrides) {
        const override = overrides[method];
        if (typeof override === 'function') {
          return override(...args);
        }
        if (ASYNC_METHODS.has(method)) {
          return Promise.resolve(override);
        }
        return override;
      }

      // Default returns
      if (ASYNC_METHODS.has(method)) {
        return Promise.resolve(method === 'callFn' ? null : 0);
      }
      if (method in GETTER_DEFAULTS) {
        return GETTER_DEFAULTS[method];
      }
      return undefined;
    };
  }

  return { ac, calls, reset };
}

/**
 * Execute a JS handler string against a mock AC runtime.
 * Mirrors runtime.ts executeHandler — uses AsyncFunction constructor.
 *
 * @param {string} jsCode - Handler JS code string
 * @param {Object} ac - Mock AC object from createMockAC
 * @param {Object} globals - Additional global variables (module-level vars)
 * @returns {Promise<*>} - Handler return value
 */
async function executeWithMockAC(jsCode, ac, globals = {}) {
  // Build parameter names and values
  const paramNames = ['AC', 'alert', 'confirm', 'prompt'];
  const paramValues = [ac, ac.alert, ac.alert, ac.alert];

  // Add globals
  for (const [key, value] of Object.entries(globals)) {
    paramNames.push(key);
    paramValues.push(value);
  }

  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AsyncFunction(...paramNames, jsCode);
  return fn(...paramValues);
}

module.exports = {
  createMockAC,
  executeWithMockAC,
  AC_METHODS,
  ASYNC_METHODS,
  GETTER_DEFAULTS
};
