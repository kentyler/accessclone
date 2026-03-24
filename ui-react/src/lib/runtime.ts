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

function runSQL(sql: string) {
  api.post('/api/queries/execute', { sql }).catch(err => {
    console.warn('AC.runSQL failed:', err);
  });
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
  };
}
