import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import type {
  FormDefinition, Control, Section, Projection, RowSourceData,
  ColumnInfo, ContextMenuState, RecordPosition, HandlerEntry,
} from '@/api/types';
import { getFileHandlers } from '@/generated/handlerRegistry';
import { executeHandler } from '@/lib/runtime';
import { useUiStore } from '@/store/ui';

// ============================================================
// Subform cache entry
// ============================================================

export interface SubformCacheEntry {
  definition: FormDefinition | null;
  records: Record<string, unknown>[];
  projection: Projection | null;
  filterKey: string;
}

// ============================================================
// State
// ============================================================

export interface FormState {
  formId: number | null;
  current: FormDefinition | null;
  original: FormDefinition | null;
  dirty: boolean;
  selectedControl: number | null;
  selectedSection: string;
  viewMode: 'design' | 'view';
  propertiesTab: string;
  lintErrors: Array<{ message: string; path?: string }> | null;
  personalized: boolean;

  // Record navigation (view mode)
  records: Record<string, unknown>[];
  currentRecord: Record<string, unknown> | null;
  recordPosition: RecordPosition;
  recordDirty: boolean;

  // Projection
  projection: Projection | null;

  // Caches
  rowSourceCache: Record<string, RowSourceData | 'loading'>;
  subformCache: Record<string, SubformCacheEntry>;
  syncedControls: Record<string, { tableName: string; columnName: string }>;

  // Context menu
  contextMenu: ContextMenuState;
}

// ============================================================
// Actions
// ============================================================

export interface FormActions {
  // Definition
  setFormDefinition(def: FormDefinition): void;
  clearLintErrors(): void;
  setLintErrors(errors: Array<{ message: string }>): void;

  // Loading
  loadFormForEditing(form: { id: number; name: string; filename: string; definition?: FormDefinition }): Promise<void>;
  setupFormEditor(formId: number, definition: FormDefinition): void;

  // Save
  saveForm(): Promise<void>;
  doSaveForm(): Promise<void>;

  // View mode
  setViewMode(mode: 'design' | 'view'): Promise<void>;
  getViewMode(): 'design' | 'view';

  // Record CRUD
  loadFormRecords(recordSource: string, orderBy?: string, filter?: string, dataEntry?: number): Promise<void>;
  saveCurrentRecord(): Promise<void>;
  newRecord(): void;
  deleteCurrentRecord(): Promise<void>;
  navigateToRecord(position: number): Promise<void>;
  updateRecordField(fieldName: string, value: unknown): void;
  setCurrentRecord(record: Record<string, unknown>): void;

  // Control operations
  selectControl(idx: number | null): void;
  selectSection(section: string): void;
  setPropertiesTab(tab: string): void;
  deleteControl(section: string, idx: number): void;
  updateControl(section: string, idx: number, prop: string, value: unknown): void;

  // Row-source cache
  clearRowSourceCache(): void;
  fetchRowSource(rowSource: string): Promise<void>;
  getRowSourceOptions(rowSource: string): RowSourceData | 'loading' | null;

  // Subform cache
  clearSubformCache(): void;
  fetchSubformDefinition(sourceFormName: string): Promise<void>;
  fetchSubformRecords(sourceFormName: string, recordSource: string, linkChild: string, linkMaster: string, parentRecord: Record<string, unknown>): Promise<void>;
  saveSubformCell(sourceFormName: string, rowIdx: number, colName: string, value: unknown): Promise<void>;
  newSubformRecord(sourceFormName: string, linkChild: string, linkMaster: string): void;
  deleteSubformRecord(sourceFormName: string, rowIdx: number): Promise<void>;

  // Event handling
  fireFormEvent(eventKey: string): void;
  loadEventHandlers(formName: string): Promise<void>;

  // Projection (for runtime)
  setProjection(projection: Projection): void;

  // Form state sync
  syncFormState(entries: Array<{ tableName: string; columnName: string; value: unknown }>): Promise<void>;

  // Context menu
  showFormContextMenu(x: number, y: number): void;
  hideFormContextMenu(): void;

  // Clipboard
  copyRecord(): void;
  cutRecord(): void;
  pasteRecord(): void;

  // Tab ops
  toggleHeaderFooter(): void;
  createNewForm(): void;

  // Personalization
  resetPersonalization(): Promise<void>;
  promoteToStandard(): Promise<void>;

  // Reset
  reset(): void;
}

type FormStore = FormState & FormActions;

// ============================================================
// Helpers
// ============================================================

function detectPkField(fields: ColumnInfo[]): string {
  const pk = fields.find(f => f.pk);
  return pk ? pk.name : 'id';
}

function recordToApiMap(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === '__new__') continue;
    out[k] = v;
  }
  return out;
}

function parseAccessFilter(filterStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!filterStr) return result;
  const parts = filterStr.split(/\s+AND\s+/i);
  for (const part of parts) {
    const m = part.match(/^\[?(\w+)\]?\s*=\s*'([^']*)'/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

// Clipboard singleton
let formClipboard: { record: Record<string, unknown>; cut: boolean } | null = null;

// ============================================================
// Store
// ============================================================

export const useFormStore = create<FormStore>()(
  immer((set, get) => ({
    // Initial state
    formId: null,
    current: null,
    original: null,
    dirty: false,
    selectedControl: null,
    selectedSection: 'detail',
    viewMode: 'design',
    propertiesTab: 'format',
    lintErrors: null,
    personalized: false,
    records: [],
    currentRecord: null,
    recordPosition: { current: 0, total: 0 },
    recordDirty: false,
    projection: null,
    rowSourceCache: {},
    subformCache: {},
    syncedControls: {},
    contextMenu: { visible: false, x: 0, y: 0 },

    // --------------------------------------------------------
    // Definition
    // --------------------------------------------------------
    setFormDefinition(def) {
      set(s => {
        s.current = def;
        s.dirty = JSON.stringify(def) !== JSON.stringify(s.original);
      });
    },
    clearLintErrors() { set(s => { s.lintErrors = null; }); },
    setLintErrors(errors) { set(s => { s.lintErrors = errors; }); },

    // --------------------------------------------------------
    // Loading
    // --------------------------------------------------------
    async loadFormForEditing(form) {
      // Auto-save dirty record if any
      if (get().recordDirty) {
        await get().saveCurrentRecord();
      }

      // Clear caches
      set(s => {
        s.rowSourceCache = {};
        s.subformCache = {};
      });

      if (form.definition) {
        get().setupFormEditor(form.id, form.definition);
      } else {
        const res = await api.get<Record<string, unknown>>(`/api/forms/${encodeURIComponent(form.filename)}`);
        if (res.ok && res.data) {
          const def = (res.data as { definition?: FormDefinition }).definition || res.data as unknown as FormDefinition;
          get().setupFormEditor(form.id, def);
        }
      }
    },

    setupFormEditor(formId, definition) {
      // Normalize will be called from lib/normalize.ts in Wave 2
      set(s => {
        s.formId = formId;
        s.current = definition;
        s.original = JSON.parse(JSON.stringify(definition));
        s.dirty = false;
        s.selectedControl = null;
        s.selectedSection = 'detail';
        s.lintErrors = null;
        s.records = [];
        s.currentRecord = null;
        s.recordPosition = { current: 0, total: 0 };
        s.recordDirty = false;
        s.projection = null;
        s.viewMode = 'design';
      });
    },

    // --------------------------------------------------------
    // Save
    // --------------------------------------------------------
    async saveForm() {
      const state = get();
      if (!state.current) return;

      // Lint first
      const lintRes = await api.post<{ valid: boolean; errors?: Array<{ message: string }> }>('/api/lint/form', {
        form: state.current,
      });

      if (lintRes.ok && lintRes.data.valid) {
        get().clearLintErrors();
        await get().doSaveForm();
      } else if (lintRes.ok && !lintRes.data.valid) {
        get().setLintErrors(lintRes.data.errors || []);
      } else {
        // Lint endpoint failed — save anyway
        await get().doSaveForm();
      }
    },

    async doSaveForm() {
      const state = get();
      if (!state.current) return;
      const name = state.current.name || '';
      const filename = name.toLowerCase().replace(/[^a-z0-9]/g, '_');

      await api.put(`/api/forms/${encodeURIComponent(filename)}`, {
        id: state.formId,
        name,
        ...state.current,
      });

      set(s => {
        s.original = JSON.parse(JSON.stringify(s.current));
        s.dirty = false;
      });
    },

    // --------------------------------------------------------
    // View mode
    // --------------------------------------------------------
    async setViewMode(mode) {
      const prev = get().viewMode;
      set(s => { s.viewMode = mode; });

      if (prev === 'view' && mode === 'design') {
        // Auto-save dirty record
        if (get().recordDirty) await get().saveCurrentRecord();
      }

      if (mode === 'view') {
        const def = get().current;
        if (def?.['record-source']) {
          await get().loadFormRecords(
            def['record-source'],
            def['order-by'],
            def.filter,
            def['data-entry'],
          );
        }
      }
    },

    getViewMode() { return get().viewMode; },

    // --------------------------------------------------------
    // Record loading
    // --------------------------------------------------------
    async loadFormRecords(recordSource, orderBy, filter, dataEntry) {
      let records: Record<string, unknown>[] = [];

      if (recordSource.toUpperCase().trimStart().startsWith('SELECT')) {
        const res = await api.post<{ rows: Record<string, unknown>[]; fields: ColumnInfo[] }>('/api/queries/run', {
          sql: recordSource,
        });
        if (res.ok) records = res.data.rows || [];
      } else {
        const params = new URLSearchParams({ limit: '1000' });
        if (orderBy) {
          const parts = orderBy.split(/\s+/);
          params.set('orderBy', parts[0]);
          if (parts[1]) params.set('orderDir', parts[1]);
        }
        if (filter) params.set('filter', filter);

        const res = await api.get<Record<string, unknown>[]>(`/api/data/${encodeURIComponent(recordSource)}?${params}`);
        if (res.ok) records = res.data;
      }

      // If data-entry mode, start with empty new record
      if (dataEntry) {
        records = [{ __new__: true }];
      }

      set(s => {
        s.records = records;
        s.recordDirty = false;
        if (records.length > 0) {
          s.currentRecord = records[0];
          s.recordPosition = { current: 1, total: records.length };
        } else {
          s.currentRecord = null;
          s.recordPosition = { current: 0, total: 0 };
        }
      });
    },

    // --------------------------------------------------------
    // Record CRUD
    // --------------------------------------------------------
    async saveCurrentRecord() {
      const state = get();
      if (!state.currentRecord || !state.recordDirty) return;
      const def = state.current;
      if (!def?.['record-source']) return;

      const recordSource = def['record-source'];
      const record = state.currentRecord;
      const apiRecord = recordToApiMap(record);

      if (record.__new__) {
        const res = await api.post<Record<string, unknown>>(`/api/data/${encodeURIComponent(recordSource)}`, apiRecord);
        if (res.ok) {
          set(s => {
            s.recordDirty = false;
            // Replace the new record with the saved version
            const idx = s.records.findIndex(r => (r as Record<string, unknown>).__new__);
            if (idx >= 0 && res.data) {
              s.records[idx] = res.data;
              s.currentRecord = res.data;
            }
          });
        }
      } else {
        // Find PK
        const table = recordSource;
        const tables = (await api.get<Array<{ name: string; fields: ColumnInfo[] }>>('/api/tables')).data || [];
        const tableInfo = tables.find(t => t.name.toLowerCase() === table.toLowerCase());
        const pkField = tableInfo ? detectPkField(tableInfo.fields) : 'id';
        const pkValue = record[pkField];

        if (pkValue != null) {
          const updateData = { ...apiRecord };
          delete updateData[pkField];
          await api.put(`/api/data/${encodeURIComponent(recordSource)}/${encodeURIComponent(String(pkValue))}`, updateData);
          set(s => { s.recordDirty = false; });
        }
      }
    },

    newRecord() {
      set(s => {
        const newRec: Record<string, unknown> = { __new__: true };
        s.records.push(newRec);
        s.currentRecord = newRec;
        s.recordPosition = { current: s.records.length, total: s.records.length };
        s.recordDirty = false;
      });
    },

    async deleteCurrentRecord() {
      const state = get();
      if (!state.currentRecord || state.currentRecord.__new__) return;
      const def = state.current;
      if (!def?.['record-source']) return;

      const recordSource = def['record-source'];
      const tables = (await api.get<Array<{ name: string; fields: ColumnInfo[] }>>('/api/tables')).data || [];
      const tableInfo = tables.find(t => t.name.toLowerCase() === recordSource.toLowerCase());
      const pkField = tableInfo ? detectPkField(tableInfo.fields) : 'id';
      const pkValue = state.currentRecord[pkField];

      if (pkValue == null) return;
      const res = await api.del(`/api/data/${encodeURIComponent(recordSource)}/${encodeURIComponent(String(pkValue))}`);
      if (res.ok) {
        set(s => {
          const idx = s.records.findIndex(r => (r as Record<string, unknown>)[pkField] === pkValue);
          if (idx >= 0) s.records.splice(idx, 1);
          // Navigate to previous or first
          if (s.records.length > 0) {
            const newIdx = Math.min(idx, s.records.length - 1);
            s.currentRecord = s.records[newIdx] as Record<string, unknown>;
            s.recordPosition = { current: newIdx + 1, total: s.records.length };
          } else {
            s.currentRecord = null;
            s.recordPosition = { current: 0, total: 0 };
          }
          s.recordDirty = false;
        });
      }
    },

    async navigateToRecord(position) {
      // Auto-save before navigation
      if (get().recordDirty) await get().saveCurrentRecord();

      set(s => {
        const idx = Math.max(0, Math.min(position - 1, s.records.length - 1));
        s.currentRecord = s.records[idx] as Record<string, unknown>;
        s.recordPosition = { current: idx + 1, total: s.records.length };
        s.recordDirty = false;
      });
    },

    updateRecordField(fieldName, value) {
      set(s => {
        if (s.currentRecord) {
          s.currentRecord[fieldName] = value;
          s.recordDirty = true;
        }
      });
    },

    setCurrentRecord(record) {
      set(s => { s.currentRecord = record; });
    },

    // --------------------------------------------------------
    // Control operations
    // --------------------------------------------------------
    selectControl(idx) { set(s => { s.selectedControl = idx; }); },
    selectSection(section) { set(s => { s.selectedSection = section; s.selectedControl = null; }); },
    setPropertiesTab(tab) { set(s => { s.propertiesTab = tab; }); },

    deleteControl(section, idx) {
      set(s => {
        const sec = s.current?.[section as keyof FormDefinition] as Section | undefined;
        if (sec?.controls) {
          sec.controls.splice(idx, 1);
          s.selectedControl = null;
          s.dirty = true;
        }
      });
    },

    updateControl(section, idx, prop, value) {
      set(s => {
        const sec = s.current?.[section as keyof FormDefinition] as Section | undefined;
        if (sec?.controls?.[idx]) {
          (sec.controls[idx] as Record<string, unknown>)[prop] = value;
          s.dirty = true;
        }
      });
    },

    // --------------------------------------------------------
    // Row-source cache
    // --------------------------------------------------------
    clearRowSourceCache() { set(s => { s.rowSourceCache = {}; }); },

    async fetchRowSource(rowSource) {
      if (!rowSource || get().rowSourceCache[rowSource]) return;

      set(s => { s.rowSourceCache[rowSource] = 'loading'; });

      // Value list
      if (rowSource.includes(';') && !rowSource.toUpperCase().includes('SELECT')) {
        const items = rowSource.split(';').filter(Boolean);
        set(s => {
          s.rowSourceCache[rowSource] = {
            rows: items.map(i => [i]),
            fields: [{ name: 'value', type: 'text' }],
          };
        });
        return;
      }

      // SQL
      if (rowSource.toUpperCase().trimStart().startsWith('SELECT')) {
        const res = await api.post<{ rows: unknown[][]; fields: ColumnInfo[] }>('/api/queries/run', { sql: rowSource });
        if (res.ok) {
          set(s => { s.rowSourceCache[rowSource] = { rows: res.data.rows || [], fields: res.data.fields || [] }; });
        } else {
          set(s => { delete s.rowSourceCache[rowSource]; });
        }
        return;
      }

      // Table/query name
      const res = await api.get<Record<string, unknown>[]>(`/api/data/${encodeURIComponent(rowSource.trim())}?limit=1000`);
      if (res.ok && Array.isArray(res.data)) {
        const fields = res.data.length > 0 ? Object.keys(res.data[0]).map(k => ({ name: k, type: 'text' })) : [];
        const rows = res.data.map(r => Object.values(r));
        set(s => { s.rowSourceCache[rowSource] = { rows, fields }; });
      } else {
        set(s => { delete s.rowSourceCache[rowSource]; });
      }
    },

    getRowSourceOptions(rowSource) {
      return get().rowSourceCache[rowSource] || null;
    },

    // --------------------------------------------------------
    // Subform cache
    // --------------------------------------------------------
    clearSubformCache() { set(s => { s.subformCache = {}; }); },

    async fetchSubformDefinition(sourceFormName) {
      const res = await api.get<{ definition: FormDefinition }>(`/api/forms/${encodeURIComponent(sourceFormName)}`);
      if (res.ok) {
        set(s => {
          if (!s.subformCache[sourceFormName]) {
            s.subformCache[sourceFormName] = { definition: null, records: [], projection: null, filterKey: '' };
          }
          s.subformCache[sourceFormName].definition = res.data.definition || res.data as unknown as FormDefinition;
        });
      }
    },

    async fetchSubformRecords(sourceFormName, recordSource, linkChild, linkMaster, parentRecord) {
      const params = new URLSearchParams({ limit: '1000' });
      // Build filter from linked fields
      if (linkChild && linkMaster && parentRecord) {
        const childFields = linkChild.split(';').map(s => s.trim());
        const masterFields = linkMaster.split(';').map(s => s.trim());
        const filterParts: string[] = [];
        for (let i = 0; i < childFields.length; i++) {
          const val = parentRecord[masterFields[i]] ?? parentRecord[masterFields[i].toLowerCase()];
          if (val != null) {
            filterParts.push(`${childFields[i]}='${val}'`);
          }
        }
        if (filterParts.length > 0) {
          params.set('filter', filterParts.join(' AND '));
        }
      }

      const res = await api.get<Record<string, unknown>[]>(`/api/data/${encodeURIComponent(recordSource)}?${params}`);
      if (res.ok) {
        set(s => {
          if (!s.subformCache[sourceFormName]) {
            s.subformCache[sourceFormName] = { definition: null, records: [], projection: null, filterKey: '' };
          }
          s.subformCache[sourceFormName].records = res.data;
          s.subformCache[sourceFormName].filterKey = params.get('filter') || '';
        });
      }
    },

    async saveSubformCell(sourceFormName, rowIdx, colName, value) {
      const entry = get().subformCache[sourceFormName];
      if (!entry?.definition?.['record-source']) return;
      const recordSource = entry.definition['record-source'];
      const record = entry.records[rowIdx] as Record<string, unknown>;
      if (!record) return;

      // Find PK
      const pkField = 'id'; // Simplified — could look up from table info
      const pkValue = record[pkField];
      if (pkValue == null) return;

      // Optimistic update
      set(s => {
        const r = s.subformCache[sourceFormName]?.records[rowIdx] as Record<string, unknown>;
        if (r) r[colName] = value;
      });

      const res = await api.put(`/api/data/${encodeURIComponent(recordSource)}/${encodeURIComponent(String(pkValue))}`, {
        [colName]: value,
      });

      if (!res.ok) {
        // Revert
        set(s => {
          const r = s.subformCache[sourceFormName]?.records[rowIdx] as Record<string, unknown>;
          if (r) r[colName] = record[colName];
        });
      }
    },

    newSubformRecord(sourceFormName, linkChild, linkMaster) {
      set(s => {
        const entry = s.subformCache[sourceFormName];
        if (!entry) return;
        const newRec: Record<string, unknown> = { __new__: true };
        // Set linked field values from parent
        const parentRecord = s.currentRecord;
        if (parentRecord && linkChild && linkMaster) {
          const childFields = linkChild.split(';').map(x => x.trim());
          const masterFields = linkMaster.split(';').map(x => x.trim());
          for (let i = 0; i < childFields.length; i++) {
            const val = parentRecord[masterFields[i]] ?? parentRecord[masterFields[i].toLowerCase()];
            if (val != null) newRec[childFields[i]] = val;
          }
        }
        entry.records.push(newRec);
      });
    },

    async deleteSubformRecord(sourceFormName, rowIdx) {
      const entry = get().subformCache[sourceFormName];
      if (!entry?.definition?.['record-source']) return;
      const recordSource = entry.definition['record-source'];
      const record = entry.records[rowIdx] as Record<string, unknown>;
      if (!record) return;

      const pkField = 'id';
      const pkValue = record[pkField];
      if (pkValue == null) return;

      const res = await api.del(`/api/data/${encodeURIComponent(recordSource)}/${encodeURIComponent(String(pkValue))}`);
      if (res.ok) {
        set(s => {
          s.subformCache[sourceFormName]?.records.splice(rowIdx, 1);
        });
      }
    },

    // --------------------------------------------------------
    // Event handling
    // --------------------------------------------------------
    fireFormEvent(eventKey) {
      const handlers = get().projection?.eventHandlers;
      if (!handlers) return;
      const handler = handlers[eventKey];
      if (handler?.js) {
        executeHandler(handler.js, eventKey);
      } else {
        console.warn(`No JS handler for event: ${eventKey}`);
      }
    },

    async loadEventHandlers(formName) {
      const safeName = formName.replace(/\s+/g, '_');
      const moduleName = `Form_${safeName}`;
      const databaseId = useUiStore.getState().currentDatabase?.database_id;

      // Try file registry first (synchronous, no API call)
      if (databaseId) {
        const fileHandlers = getFileHandlers(databaseId, moduleName);
        if (fileHandlers) {
          set(s => {
            if (s.projection) s.projection.eventHandlers = fileHandlers;
          });
          return;
        }
      }

      // Fallback: API — convert array to Record if needed
      const res = await api.get<HandlerEntry[] | Record<string, HandlerEntry>>(`/api/modules/${encodeURIComponent(moduleName)}/handlers`);
      if (res.ok && res.data) {
        let handlers: Record<string, HandlerEntry>;
        if (Array.isArray(res.data)) {
          handlers = {};
          for (const h of res.data) {
            const k = (h as Record<string, unknown>).key as string;
            if (k) handlers[k] = h;
          }
        } else {
          handlers = res.data;
        }
        set(s => {
          if (s.projection) s.projection.eventHandlers = handlers;
        });
      }
    },

    // --------------------------------------------------------
    // Projection (for runtime)
    // --------------------------------------------------------
    setProjection(projection) { set(s => { s.projection = projection; }); },

    // --------------------------------------------------------
    // Form state sync
    // --------------------------------------------------------
    async syncFormState(entries) {
      await api.put('/api/form-state', {
        sessionId: api.sessionId,
        entries,
      });
    },

    // --------------------------------------------------------
    // Context menu
    // --------------------------------------------------------
    showFormContextMenu(x, y) { set(s => { s.contextMenu = { visible: true, x, y }; }); },
    hideFormContextMenu() { set(s => { s.contextMenu.visible = false; }); },

    // --------------------------------------------------------
    // Clipboard
    // --------------------------------------------------------
    copyRecord() {
      const rec = get().currentRecord;
      if (rec) formClipboard = { record: { ...rec }, cut: false };
    },
    cutRecord() {
      const rec = get().currentRecord;
      if (rec) formClipboard = { record: { ...rec }, cut: true };
    },
    pasteRecord() {
      if (!formClipboard) return;
      set(s => {
        s.currentRecord = { ...formClipboard!.record, __new__: true };
        s.recordDirty = true;
      });
    },

    // --------------------------------------------------------
    // Header/footer toggle
    // --------------------------------------------------------
    toggleHeaderFooter() {
      set(s => {
        if (!s.current) return;
        if (s.current.header) {
          delete s.current.header;
          delete s.current.footer;
        } else {
          s.current.header = { height: 300, controls: [] };
          s.current.footer = { height: 300, controls: [] };
        }
        s.dirty = true;
      });
    },

    // --------------------------------------------------------
    // Create new form
    // --------------------------------------------------------
    createNewForm() {
      // This will be wired to the UI store's addObject + openObject
      set(s => {
        s.current = {
          name: 'New Form',
          detail: { height: 2000, controls: [] },
        };
        s.original = JSON.parse(JSON.stringify(s.current));
        s.dirty = false;
        s.formId = null;
        s.viewMode = 'design';
      });
    },

    // --------------------------------------------------------
    // Personalization
    // --------------------------------------------------------
    async resetPersonalization() {
      const def = get().current;
      if (!def?.name) return;
      const filename = def.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      await api.del(`/api/forms/${encodeURIComponent(filename)}/personalization`);
    },

    async promoteToStandard() {
      const def = get().current;
      if (!def?.name) return;
      const filename = def.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      await api.post(`/api/forms/${encodeURIComponent(filename)}/promote`);
    },

    // --------------------------------------------------------
    // Reset
    // --------------------------------------------------------
    reset() {
      set(s => {
        s.formId = null;
        s.current = null;
        s.original = null;
        s.dirty = false;
        s.selectedControl = null;
        s.viewMode = 'design';
        s.lintErrors = null;
        s.records = [];
        s.currentRecord = null;
        s.recordPosition = { current: 0, total: 0 };
        s.recordDirty = false;
        s.projection = null;
        s.rowSourceCache = {};
        s.subformCache = {};
      });
    },
  }))
);
