import { Suspense, useMemo, useCallback, useEffect, lazy, ComponentType } from 'react';
import { useFormStore } from '@/store/form';
import { useUiStore } from '@/store/ui';
import { ctrlToKey } from '@/lib/utils';
import FormView from './FormView';
import type { GeneratedFormProps } from '@/generated/types';

// Eagerly discover all generated form components via Vite glob import.
// Each match is a () => Promise<Module> for lazy loading.
const generatedModules = import.meta.glob<{ default: ComponentType<GeneratedFormProps> }>(
  '../../generated/forms/**/*.tsx'
);

/**
 * Build a lookup map: "databaseId/FormName" → lazy component
 */
function buildRegistry(): Record<string, ReturnType<typeof lazy>> {
  const registry: Record<string, ReturnType<typeof lazy>> = {};
  for (const [path, loader] of Object.entries(generatedModules)) {
    // path looks like: ../../generated/forms/northwind4/FrmAbout.tsx
    const match = path.match(/\/generated\/forms\/([^/]+)\/([^/]+)\.tsx$/);
    if (match) {
      const [, dbId, formFile] = match;
      const key = `${dbId}/${formFile}`;
      registry[key] = lazy(loader);
    }
  }
  return registry;
}

const componentRegistry = buildRegistry();

/**
 * Look up a generated component by database ID and form name.
 * Tries exact match first, then case-insensitive.
 */
function findComponent(databaseId: string, formName: string) {
  // Normalize form name same way as the server writer:
  // strip non-alphanumeric except underscore, capitalize first letter
  const normalized = formName.replace(/[^a-zA-Z0-9_]/g, '');
  const pascal = normalized.charAt(0).toUpperCase() + normalized.slice(1);

  // Try exact match
  const exactKey = `${databaseId}/${pascal}`;
  if (componentRegistry[exactKey]) return componentRegistry[exactKey];

  // Try case-insensitive
  const lowerKey = exactKey.toLowerCase();
  for (const [key, comp] of Object.entries(componentRegistry)) {
    if (key.toLowerCase() === lowerKey) return comp;
  }

  return null;
}

/**
 * GeneratedFormWrapper — renders a generated form component if one exists,
 * otherwise falls back to the generic FormView renderer.
 */
export default function GeneratedFormWrapper() {
  const store = useFormStore();
  const databaseId = useUiStore(s => s.currentDatabase?.database_id);
  const current = store.current;
  const formName = current?.name || '';

  const GeneratedComponent = useMemo(() => {
    if (!databaseId || !formName) return null;
    return findComponent(databaseId, formName);
  }, [databaseId, formName]);

  // Fetch row sources for all combo-box/list-box controls
  useEffect(() => {
    if (!current || !GeneratedComponent) return;
    const sections = [current.header, current.detail, current.footer];
    for (const section of sections) {
      if (!section?.controls) continue;
      for (const ctrl of section.controls) {
        const t = ctrl.type;
        if ((t === 'combo-box' || t === 'list-box') && ctrl['row-source']) {
          store.fetchRowSource(ctrl['row-source'] as string);
        }
      }
    }
  }, [current, GeneratedComponent]);

  // Bridge store state → GeneratedFormProps
  const projection = store.projection;
  const currentRecord = projection?.record ?? {};
  const records = projection?.records ?? [];
  const position = useMemo(() => ({
    current: projection?.position ?? 0,
    total: projection?.total ?? 0,
  }), [projection?.position, projection?.total]);
  const recordDirty = projection?.dirty ?? false;
  const isNewRecord = Boolean(currentRecord.__new__);

  const onFieldChange = useCallback((field: string, value: unknown) => {
    store.updateRecordField(field, value);
  }, []);

  const onNavigate = useCallback((target: 'first' | 'prev' | 'next' | 'last' | 'new') => {
    const pos = useFormStore.getState().projection?.position ?? 0;
    const total = useFormStore.getState().projection?.total ?? 0;
    switch (target) {
      case 'first': store.navigateToRecord(1); break;
      case 'prev': store.navigateToRecord(Math.max(1, pos - 1)); break;
      case 'next': store.navigateToRecord(Math.min(total, pos + 1)); break;
      case 'last': store.navigateToRecord(total); break;
      case 'new': store.newRecord(); break;
    }
  }, []);

  const onSave = useCallback(() => {
    store.saveCurrentRecord();
  }, []);

  const onDelete = useCallback(() => {
    if (confirm('Delete this record?')) {
      store.deleteCurrentRecord();
    }
  }, []);

  // Build controlState from projection
  const controlState = useMemo(() => {
    return (projection?.controlState ?? {}) as Record<string, { visible?: boolean; enabled?: boolean; caption?: string }>;
  }, [projection?.controlState]);

  // Build rowSources from projection
  const rowSources = useMemo(() => {
    const rs: Record<string, { columns: string[]; rows: unknown[][] }> = {};
    const projRs = projection?.rowSources;
    if (projRs) {
      for (const [key, val] of Object.entries(projRs)) {
        if (val && val !== 'loading') {
          rs[key] = {
            columns: val.fields?.map(f => f.name) ?? [],
            rows: val.rows ?? [],
          };
        }
      }
    }
    return rs;
  }, [projection?.rowSources]);

  // Build subformData from store subform cache
  const subformData = useMemo(() => {
    const sf: Record<string, { definition: any; records: unknown[]; columns: string[] }> = {};
    // The store exposes subform data via the subform cache, accessed per source-object
    // For now return empty — subform support comes through the generic renderer
    return sf;
  }, []);

  // Fire event through the store's event system
  const fireEvent = useCallback((controlName: string, eventKey: string) => {
    const key = controlName ? `${ctrlToKey(controlName)}.${eventKey}` : eventKey;
    store.fireFormEvent(key);
  }, []);

  // If no generated component exists, fall back to generic FormView
  if (!GeneratedComponent || !current) {
    return <FormView />;
  }

  const props: GeneratedFormProps = {
    definition: current,
    records: records as Record<string, unknown>[],
    currentRecord,
    position,
    recordDirty,
    isNewRecord,
    onFieldChange,
    onNavigate,
    onSave,
    onDelete,
    controlState,
    rowSources,
    subformData,
    fireEvent,
  };

  return (
    <Suspense fallback={<div style={{ padding: 20 }}>Loading generated form...</div>}>
      <GeneratedComponent {...props} />
    </Suspense>
  );
}
