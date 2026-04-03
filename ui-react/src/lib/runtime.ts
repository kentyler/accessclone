/**
 * window.AC runtime API for generated VBA-to-JS event handlers.
 * Bridges plain JS calls into Zustand stores.
 */
import { useUiStore } from '@/store/ui';
import { useFormStore } from '@/store/form';
import { ctrlToKey } from '@/lib/utils';
import * as api from '@/api/client';

function findObjectByName(objectType: 'forms' | 'reports', name: string) {
  const objects = useUiStore.getState().objects[objectType];
  const lower = name.toLowerCase();
  return objects.find((o: { name: string; filename?: string }) =>
    (o.filename || o.name || '').toLowerCase() === lower ||
    o.name.toLowerCase() === lower
  );
}

function openForm(formName: string, _whereFilter?: string) {
  const form = findObjectByName('forms', formName);
  if (form) {
    useUiStore.getState().openObject('forms', form.id, form.name);
  } else {
    console.warn(`AC.openForm: form "${formName}" not found`);
  }
}

function openReport(reportName: string) {
  const report = findObjectByName('reports', reportName);
  if (report) {
    useUiStore.getState().openObject('reports', report.id, report.name);
  } else {
    console.warn(`AC.openReport: report "${reportName}" not found`);
  }
}

function closeForm(formName?: string) {
  if (formName) {
    const form = findObjectByName('forms', formName);
    if (form) {
      useUiStore.getState().closeTab('forms', form.id);
      return;
    }
  }
  // Fallback: close current tab
  const ui = useUiStore.getState();
  if (ui.activeTab) {
    ui.closeTab(ui.activeTab.type as 'forms', ui.activeTab.id);
  }
}

function gotoRecord(target: string) {
  const store = useFormStore.getState();
  const projection = store.projection;
  if (!projection) return;

  const records = projection.records || [];
  const position = projection.position ?? 1;
  const total = records.length;

  switch (target.toLowerCase()) {
    case 'new':
      store.newRecord();
      break;
    case 'first':
      store.navigateToRecord(1);
      break;
    case 'last':
      store.navigateToRecord(total);
      break;
    case 'next':
      store.navigateToRecord(Math.min(position + 1, total));
      break;
    case 'previous':
      store.navigateToRecord(Math.max(position - 1, 1));
      break;
    default:
      console.warn(`AC.gotoRecord: unknown target "${target}"`);
  }
}

function saveRecord() {
  useFormStore.getState().saveCurrentRecord();
}

function requery() {
  // Reload form data
  const store = useFormStore.getState();
  if (store.formId && store.current) {
    store.setViewMode('view');
  }
}

function setVisible(controlName: string, visible: boolean) {
  const store = useFormStore.getState();
  if (!store.projection) return;
  const key = ctrlToKey(controlName);
  const cs = store.projection.controlState || {};
  const current = cs[key] || {};
  store.setProjection({
    ...store.projection,
    controlState: { ...cs, [key]: { ...current, visible } },
  });
}

function setEnabled(controlName: string, enabled: boolean) {
  const store = useFormStore.getState();
  if (!store.projection) return;
  const key = ctrlToKey(controlName);
  const cs = store.projection.controlState || {};
  const current = cs[key] || {};
  store.setProjection({
    ...store.projection,
    controlState: { ...cs, [key]: { ...current, enabled } },
  });
}

function setValue(controlName: string, value: unknown) {
  const store = useFormStore.getState();
  if (!store.projection) return;
  const key = ctrlToKey(controlName);
  const cs = store.projection.controlState || {};
  const current = cs[key] || {};
  store.setProjection({
    ...store.projection,
    controlState: { ...cs, [key]: { ...current, caption: String(value) } },
  });
}

function setSubformSource(subformControlName: string, sourceObject: string) {
  const store = useFormStore.getState();
  if (!store.projection || !store.current) return;
  const key = ctrlToKey(subformControlName);

  // Update projection subform sources
  const subSources = { ...(store.projection.subformSources || {}) };
  subSources[key] = sourceObject;

  // Update form definition controls
  const def = { ...store.current };
  for (const section of ['header', 'detail', 'footer'] as const) {
    const sec = def[section];
    if (sec?.controls) {
      const controls = [...sec.controls];
      for (let i = 0; i < controls.length; i++) {
        if (ctrlToKey(controls[i].name) === key) {
          controls[i] = { ...controls[i], 'source-object': sourceObject } as typeof controls[0];
        }
      }
      (def as Record<string, unknown>)[section] = { ...sec, controls };
    }
  }

  store.setProjection({ ...store.projection, subformSources: subSources });
  store.setFormDefinition(def);
}

function getValue(controlName: string): unknown {
  const store = useFormStore.getState();
  if (!store.projection) return null;
  const key = ctrlToKey(controlName);
  const cs = store.projection.controlState || {};
  const state = cs[key];
  if (state && state.caption !== undefined) return state.caption;
  // Fall back to bound field value from current record
  const record = store.projection.record;
  if (record && key in record) return record[key];
  return null;
}

function getVisible(controlName: string): boolean {
  const store = useFormStore.getState();
  if (!store.projection) return true;
  const key = ctrlToKey(controlName);
  const cs = store.projection.controlState || {};
  const state = cs[key];
  return state?.visible !== false;
}

function getEnabled(controlName: string): boolean {
  const store = useFormStore.getState();
  if (!store.projection) return true;
  const key = ctrlToKey(controlName);
  const cs = store.projection.controlState || {};
  const state = cs[key];
  return state?.enabled !== false;
}

function isDirty(): boolean {
  const store = useFormStore.getState();
  return !!(store.projection as unknown as Record<string, unknown>)?.['dirty?'];
}

function isNewRecord(): boolean {
  const store = useFormStore.getState();
  const record = store.projection?.record;
  return !!(record as Record<string, unknown>)?.['__new__'];
}

function getOpenArgs(): null {
  // Stub — future: thread OpenForm args through form open flow
  return null;
}

function nz(value: unknown, defaultVal?: unknown): unknown {
  return value ?? defaultVal ?? '';
}

// ============================================================
// TempVars — session-global variables (Access TempVars collection)
// ============================================================

const tempVars = new Map<string, unknown>();

function getTempVar(name: string): unknown {
  return tempVars.get(name) ?? null;
}

function setTempVar(name: string, value: unknown): void {
  tempVars.set(name, value);
}

function removeTempVar(name: string): void {
  tempVars.delete(name);
}

function removeAllTempVars(): void {
  tempVars.clear();
}

function setFocus(controlName: string) {
  // Try to find and focus the control element
  const key = ctrlToKey(controlName);
  const el = document.querySelector(`[data-control="${key}"] input, [data-control="${key}"] select, [data-control="${key}"] textarea`) as HTMLElement;
  if (el) {
    el.focus();
  } else {
    console.warn(`AC.setFocus: control "${controlName}" not found`);
  }
}

function requeryControl(controlName: string) {
  // Stub — future: refresh combo/listbox data source
  console.warn(`AC.requeryControl("${controlName}"): stub — not yet implemented`);
}

function undo() {
  // Stub — future: reload current record to discard changes
  console.warn('AC.undo: stub — not yet implemented');
}

function setRecordSource(source: string) {
  // Stub — future: change form's record source and reload data
  console.warn(`AC.setRecordSource("${source}"): stub — not yet implemented`);
}

function setFormCaption(text: string) {
  // Stub — future: update form title bar
  console.warn(`AC.setFormCaption("${text}"): stub — not yet implemented`);
}

function setFilter(expr: string) {
  // Stub — future: apply filter expression to form data
  console.warn(`AC.setFilter("${expr}"): stub — not yet implemented`);
}

function setFilterOn(on: boolean) {
  // Stub — future: toggle filter on/off
  console.warn(`AC.setFilterOn(${on}): stub — not yet implemented`);
}

function runSQL(sql: string) {
  api.post('/api/queries/execute', { sql }).catch(err => {
    console.warn('AC.runSQL failed:', err);
  });
}

// ============================================================
// Domain aggregate functions (DCount, DLookup, DMin, DMax, DSum)
// ============================================================

async function dCount(expr: string, domain: string, criteria?: string): Promise<number> {
  const col = expr === '*' ? '*' : `"${expr}"`;
  const sql = `SELECT COUNT(${col}) as result FROM ${domain}${criteria ? ' WHERE ' + criteria : ''}`;
  const res = await api.post<{ data: Record<string, unknown>[] }>('/api/queries/run', { sql });
  if (res.ok && res.data?.data?.[0]) return Number(res.data.data[0].result) || 0;
  return 0;
}

async function dLookup(expr: string, domain: string, criteria?: string): Promise<unknown> {
  const sql = `SELECT ${expr} as result FROM ${domain}${criteria ? ' WHERE ' + criteria : ''} LIMIT 1`;
  const res = await api.post<{ data: Record<string, unknown>[] }>('/api/queries/run', { sql });
  if (res.ok && res.data?.data?.[0]) return res.data.data[0].result;
  return null;
}

async function dMin(expr: string, domain: string, criteria?: string): Promise<unknown> {
  const sql = `SELECT MIN("${expr}") as result FROM ${domain}${criteria ? ' WHERE ' + criteria : ''}`;
  const res = await api.post<{ data: Record<string, unknown>[] }>('/api/queries/run', { sql });
  if (res.ok && res.data?.data?.[0]) return res.data.data[0].result;
  return null;
}

async function dMax(expr: string, domain: string, criteria?: string): Promise<unknown> {
  const sql = `SELECT MAX("${expr}") as result FROM ${domain}${criteria ? ' WHERE ' + criteria : ''}`;
  const res = await api.post<{ data: Record<string, unknown>[] }>('/api/queries/run', { sql });
  if (res.ok && res.data?.data?.[0]) return res.data.data[0].result;
  return null;
}

async function dSum(expr: string, domain: string, criteria?: string): Promise<number> {
  const sql = `SELECT SUM("${expr}") as result FROM ${domain}${criteria ? ' WHERE ' + criteria : ''}`;
  const res = await api.post<{ data: Record<string, unknown>[] }>('/api/queries/run', { sql });
  if (res.ok && res.data?.data?.[0]) return Number(res.data.data[0].result) || 0;
  return 0;
}

// ============================================================
// Cross-module function dispatch (fn.* handlers)
// ============================================================

/**
 * Registry of fn.* handler code loaded from modules.
 * Populated by the handler loading system; keyed by procedure name (case-insensitive).
 */
const fnHandlerRegistry = new Map<string, string>();

/**
 * Register a fn.* handler's JS code for cross-module dispatch.
 */
function registerFnHandler(name: string, jsCode: string): void {
  fnHandlerRegistry.set(name.toLowerCase(), jsCode);
}

/**
 * Call a registered fn.* handler by name.
 * Generated JS emits `await AC.callFn("FuncName", arg1, arg2)`.
 * Arguments are passed as local variables $0, $1, etc. within the handler body.
 */
async function callFn(name: string, ...args: unknown[]): Promise<unknown> {
  const jsCode = fnHandlerRegistry.get(name.toLowerCase());
  if (!jsCode) {
    console.warn(`AC.callFn: function "${name}" not registered`);
    return null;
  }
  try {
    // Build argument bindings: let $0 = args[0]; let $1 = args[1]; ...
    const argBindings = args.map((_, i) => `let $${i} = arguments[${i + 1}];`).join('\n');
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction('name', ...args.map((_, i) => `_arg${i}`), argBindings + '\n' + jsCode);
    return await fn.call(null, name, ...args);
  } catch (e) {
    console.warn(`AC.callFn("${name}") failed:`, e);
    return null;
  }
}

// ============================================================
// Async handler execution
// ============================================================

/**
 * Execute a JS handler string using AsyncFunction so `await` works inside.
 */
export function executeHandler(jsCode: string, label: string) {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction(jsCode);
    fn.call(null);
  } catch (e) {
    console.warn(`Handler ${label} failed:`, e);
  }
}

/**
 * Install window.AC runtime. Call once at app init.
 */
export function installRuntime() {
  (window as unknown as Record<string, unknown>).AC = {
    openForm,
    openReport,
    closeForm,
    gotoRecord,
    saveRecord,
    requery,
    setVisible,
    setEnabled,
    setValue,
    setSubformSource,
    runSQL,
    setFocus,
    requeryControl,
    undo,
    setRecordSource,
    setFormCaption,
    setFilter,
    setFilterOn,
    getValue,
    getVisible,
    getEnabled,
    isDirty,
    isNewRecord,
    getOpenArgs,
    nz,
    dCount,
    dLookup,
    dMin,
    dMax,
    dSum,
    getTempVar,
    setTempVar,
    removeTempVar,
    removeAllTempVars,
    callFn,
    registerFnHandler,
  };
}
