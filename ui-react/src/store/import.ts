import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import { convertAccessForm, convertAccessReport } from '@/views/ImportViewer/Converter';
import type { FormDefinition, ReportDefinition } from '@/api/types';

// ============================================================
// Types
// ============================================================

export type ObjectType = 'tables' | 'queries' | 'forms' | 'reports' | 'modules' | 'macros';

export interface SourceItem {
  name: string;
  type?: string;
  fields?: number;
  rows?: number;
  lines?: number;
  detail?: string;
}

export interface ImportPhaseStatus {
  phase: string;
  current: string;
  imported: number;
  total: number;
  failed: Array<{ name: string; error: string }>;
}

export interface ScannedDatabase {
  path: string;
  name: string;
  size: number;
  modified: string;
}

export interface ImportState {
  // Source
  loading: boolean;
  error: string | null;
  activePath: string | null;
  selectedPaths: string[];
  scannedDatabases: ScannedDatabase[];
  objectType: ObjectType;
  // Cached source contents per path
  cache: Record<string, Record<ObjectType, SourceItem[]>>;
  // Selection
  selected: Set<string>;
  // Target
  targetExisting: Record<ObjectType, Set<string>>;
  // Import progress
  importing: boolean;
  importAllActive: boolean;
  importAllStatus: ImportPhaseStatus | null;
  autoImportPhase: string | null;
  // Import log
  importLog: Array<Record<string, unknown>>;
}

// ============================================================
// Actions
// ============================================================

export interface ImportActions {
  // Source browsing
  scanForDatabases(locations?: string): Promise<void>;
  loadAccessDatabase(path: string): Promise<void>;
  setActivePath(path: string): void;
  toggleDatabaseSelection(path: string): void;
  setObjectType(type: ObjectType): void;

  // Selection
  toggleSelection(name: string): void;
  selectAll(): void;
  selectNone(): void;

  // Target tracking
  loadTargetExisting(): Promise<void>;

  // Single-object import
  importForm(path: string, name: string): Promise<boolean>;
  importReport(path: string, name: string): Promise<boolean>;
  importModule(path: string, name: string): Promise<boolean>;
  importMacro(path: string, name: string): Promise<boolean>;
  importTable(path: string, name: string): Promise<boolean>;
  importQuery(path: string, name: string): Promise<{ ok: boolean; category?: string }>;

  // Batch/orchestrated import
  importSelected(): Promise<void>;
  importAll(force?: boolean): Promise<void>;

  // Import log
  loadImportLog(): Promise<void>;

  // Reset
  reset(): void;
}

type Store = ImportState & ImportActions;

// ============================================================
// Helpers
// ============================================================

function sanitizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

function itemsForType(cache: ImportState['cache'], selectedPaths: string[], type: ObjectType): SourceItem[] {
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  for (const path of selectedPaths) {
    const contents = cache[path];
    if (!contents) continue;
    for (const item of contents[type] || []) {
      const key = sanitizeName(item.name);
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
  }
  return items;
}

function findPathForItem(cache: ImportState['cache'], selectedPaths: string[], type: ObjectType, name: string): string | null {
  const key = sanitizeName(name);
  for (const path of selectedPaths) {
    const contents = cache[path];
    if (!contents) continue;
    for (const item of contents[type] || []) {
      if (sanitizeName(item.name) === key) return path;
    }
  }
  return selectedPaths[0] || null;
}

// ============================================================
// Store
// ============================================================

export const useImportStore = create<Store>()(
  immer((set, get) => ({
    loading: false,
    error: null,
    activePath: null,
    selectedPaths: [],
    scannedDatabases: [],
    objectType: 'tables',
    cache: {},
    selected: new Set<string>(),
    targetExisting: {
      tables: new Set(), queries: new Set(), forms: new Set(),
      reports: new Set(), modules: new Set(), macros: new Set(),
    },
    importing: false,
    importAllActive: false,
    importAllStatus: null,
    autoImportPhase: null,
    importLog: [],

    // --------------------------------------------------------
    // Source browsing
    // --------------------------------------------------------
    async scanForDatabases(locations) {
      set(s => { s.loading = true; s.error = null; });
      const url = locations
        ? `/api/database-import/scan?locations=${encodeURIComponent(locations)}`
        : '/api/database-import/scan';
      const res = await api.get<{ databases: ScannedDatabase[] }>(url);
      set(s => {
        s.loading = false;
        if (res.ok) {
          s.scannedDatabases = res.data.databases ?? [];
        } else {
          s.error = 'Failed to scan for databases';
        }
      });
    },

    async loadAccessDatabase(path) {
      if (get().cache[path]) {
        set(s => { s.activePath = path; });
        return;
      }
      set(s => { s.loading = true; s.error = null; });
      const res = await api.get<Record<string, unknown>>(`/api/database-import/database?path=${encodeURIComponent(path)}`);
      if (res.ok && res.data) {
        const d = res.data;
        set(s => {
          s.cache[path] = {
            tables: (d.tables as SourceItem[]) || [],
            queries: (d.queries as SourceItem[]) || [],
            forms: (d.forms as SourceItem[]) || [],
            reports: (d.reports as SourceItem[]) || [],
            modules: (d.modules as SourceItem[]) || [],
            macros: (d.macros as SourceItem[]) || [],
          };
          s.activePath = path;
          s.loading = false;
        });
      } else {
        set(s => { s.loading = false; s.error = 'Failed to load Access database'; });
      }
    },

    setActivePath(path) { set(s => { s.activePath = path; }); },

    toggleDatabaseSelection(path) {
      const state = get();
      const idx = state.selectedPaths.indexOf(path);
      if (idx >= 0) {
        set(s => {
          s.selectedPaths.splice(idx, 1);
          if (s.activePath === path) s.activePath = s.selectedPaths[0] || null;
        });
      } else {
        set(s => { s.selectedPaths.push(path); });
        get().loadAccessDatabase(path);
      }
    },

    setObjectType(type) { set(s => { s.objectType = type; s.selected = new Set(); }); },

    // --------------------------------------------------------
    // Selection
    // --------------------------------------------------------
    toggleSelection(name) {
      set(s => {
        if (s.selected.has(name)) s.selected.delete(name);
        else s.selected.add(name);
      });
    },

    selectAll() {
      const state = get();
      const items = itemsForType(state.cache, state.selectedPaths, state.objectType);
      set(s => { s.selected = new Set(items.map(i => i.name)); });
    },

    selectNone() { set(s => { s.selected = new Set(); }); },

    // --------------------------------------------------------
    // Target tracking
    // --------------------------------------------------------
    // Match CLJS: forms/reports/modules/macros use name-array keys (string[]),
    // tables use object array (.name), queries merge views + functions
    async loadTargetExisting() {
      await Promise.all([
        // Tables: body.tables is array of objects with .name
        api.get<Record<string, unknown>>('/api/tables').then(res => {
          if (res.ok) {
            const items = (res.data.tables ?? []) as Array<{ name: string }>;
            set(s => { s.targetExisting.tables = new Set(items.map(i => sanitizeName(i.name))); });
          }
        }),
        // Forms: body.forms is string array
        api.get<Record<string, unknown>>('/api/forms').then(res => {
          if (res.ok) {
            const names = (res.data.forms ?? []) as string[];
            set(s => { s.targetExisting.forms = new Set(names.map(n => sanitizeName(n))); });
          }
        }),
        // Reports: body.reports is string array
        api.get<Record<string, unknown>>('/api/reports').then(res => {
          if (res.ok) {
            const names = (res.data.reports ?? []) as string[];
            set(s => { s.targetExisting.reports = new Set(names.map(n => sanitizeName(n))); });
          }
        }),
        // Modules: body.modules is string array
        api.get<Record<string, unknown>>('/api/modules').then(res => {
          if (res.ok) {
            const names = (res.data.modules ?? []) as string[];
            set(s => { s.targetExisting.modules = new Set(names.map(n => sanitizeName(n))); });
          }
        }),
        // Macros: body.macros is string array
        api.get<Record<string, unknown>>('/api/macros').then(res => {
          if (res.ok) {
            const names = (res.data.macros ?? []) as string[];
            set(s => { s.targetExisting.macros = new Set(names.map(n => sanitizeName(n))); });
          }
        }),
        // Queries: merge views + functions (matches CLJS which fetches both endpoints)
        Promise.all([
          api.get<Record<string, unknown>>('/api/queries'),
          api.get<Record<string, unknown>>('/api/functions'),
        ]).then(([qRes, fRes]) => {
          const viewNames = qRes.ok
            ? ((qRes.data.queries ?? []) as Array<{ name: string }>).map(q => sanitizeName(q.name))
            : [];
          const funcNames = fRes.ok
            ? ((fRes.data.functions ?? []) as Array<{ name: string }>).map(f => sanitizeName(f.name))
            : [];
          set(s => { s.targetExisting.queries = new Set([...viewNames, ...funcNames]); });
        }),
      ]);
    },

    // --------------------------------------------------------
    // Single-object imports
    // --------------------------------------------------------
    async importForm(path, name) {
      const res = await api.post<Record<string, unknown>>('/api/database-import/export-form', { path, name });
      if (!res.ok || !res.data) return false;
      const definition = convertAccessForm(res.data);
      const filename = sanitizeName(name);
      const saveRes = await api.put(`/api/forms/${encodeURIComponent(filename)}?source=import`, {
        name, ...definition,
      });
      return saveRes.ok;
    },

    async importReport(path, name) {
      const res = await api.post<Record<string, unknown>>('/api/database-import/export-report', { path, name });
      if (!res.ok || !res.data) return false;
      const definition = convertAccessReport(res.data);
      const filename = sanitizeName(name);
      const saveRes = await api.put(`/api/reports/${encodeURIComponent(filename)}?source=import`, {
        name, ...definition,
      });
      return saveRes.ok;
    },

    async importModule(path, name) {
      const res = await api.post<{ source?: string }>('/api/database-import/export-module', { path, name });
      if (!res.ok || !res.data?.source) return false;
      const filename = sanitizeName(name);
      const saveRes = await api.put(`/api/modules/${encodeURIComponent(filename)}`, {
        name, vba_source: res.data.source,
      });
      return saveRes.ok;
    },

    async importMacro(path, name) {
      const res = await api.post<{ xml?: string }>('/api/database-import/export-macro', { path, name });
      if (!res.ok || !res.data?.xml) return false;
      const filename = sanitizeName(name);
      const saveRes = await api.put(`/api/macros/${encodeURIComponent(filename)}`, {
        name, definition: res.data.xml,
      });
      return saveRes.ok;
    },

    async importTable(path, name) {
      const res = await api.post<{ ok?: boolean }>('/api/database-import/import-table', { path, name });
      return res.ok;
    },

    async importQuery(path, name) {
      const res = await api.post<{ ok?: boolean; category?: string; error?: string }>('/api/database-import/import-query', { path, name });
      if (res.ok && res.data.ok !== false) return { ok: true };
      return { ok: false, category: res.data?.category || 'conversion-error' };
    },

    // --------------------------------------------------------
    // Import selected items
    // --------------------------------------------------------
    async importSelected() {
      const state = get();
      const type = state.objectType;
      const selected = Array.from(state.selected);
      if (!selected.length) return;

      set(s => { s.importing = true; });

      const importFn = async (name: string) => {
        const path = findPathForItem(state.cache, state.selectedPaths, type, name);
        if (!path) return false;
        switch (type) {
          case 'tables': return get().importTable(path, name);
          case 'forms': return get().importForm(path, name);
          case 'reports': return get().importReport(path, name);
          case 'modules': return get().importModule(path, name);
          case 'macros': return get().importMacro(path, name);
          case 'queries': {
            const r = await get().importQuery(path, name);
            return r.ok;
          }
          default: return false;
        }
      };

      if (type === 'queries' && selected.length > 1) {
        // Multi-pass retry for queries
        let pending = [...selected];
        for (let pass = 0; pass < 20 && pending.length > 0; pass++) {
          const nextPending: string[] = [];
          let progress = false;
          for (const name of pending) {
            const path = findPathForItem(state.cache, state.selectedPaths, type, name);
            if (!path) continue;
            const result = await get().importQuery(path, name);
            if (result.ok) {
              progress = true;
            } else if (result.category === 'missing-dependency') {
              nextPending.push(name);
            }
            // permanent errors are silently dropped
          }
          pending = nextPending;
          if (!progress) break;
        }
      } else {
        for (const name of selected) {
          await importFn(name);
        }
      }

      await get().loadTargetExisting();
      set(s => { s.importing = false; s.selected = new Set(); });
    },

    // --------------------------------------------------------
    // Import All (full pipeline)
    // --------------------------------------------------------
    async importAll(force = false) {
      if (get().importAllActive) return;
      set(s => { s.importAllActive = true; s.importing = true; s.autoImportPhase = 'importing'; });

      const state = get();
      const allTypes: ObjectType[] = ['tables', 'forms', 'reports', 'modules', 'queries', 'macros'];

      const updateStatus = (phase: string, current: string, imported: number, total: number) => {
        set(s => {
          s.importAllStatus = {
            phase, current, imported, total,
            failed: s.importAllStatus?.failed || [],
          };
        });
      };

      const addFailed = (name: string, error: string) => {
        set(s => {
          if (s.importAllStatus) s.importAllStatus.failed.push({ name, error });
        });
      };

      try {
        for (const type of allTypes) {
          const items = itemsForType(state.cache, state.selectedPaths, type);
          const toImport = force ? items : items.filter(i => !state.targetExisting[type].has(sanitizeName(i.name)));
          if (!toImport.length) continue;

          if (type === 'queries') {
            // Multi-pass retry for queries
            let pending = [...toImport];
            for (let pass = 0; pass < 20 && pending.length > 0; pass++) {
              const nextPending: SourceItem[] = [];
              let progress = false;
              for (let i = 0; i < pending.length; i++) {
                const item = pending[i];
                updateStatus(type, item.name, i, pending.length);
                const path = findPathForItem(state.cache, state.selectedPaths, type, item.name);
                if (!path) continue;
                const result = await get().importQuery(path, item.name);
                if (result.ok) {
                  progress = true;
                } else if (result.category === 'missing-dependency') {
                  nextPending.push(item);
                } else {
                  addFailed(item.name, 'Query conversion failed');
                }
              }
              pending = nextPending;
              if (!progress) break;
            }
          } else {
            for (let i = 0; i < toImport.length; i++) {
              const item = toImport[i];
              updateStatus(type, item.name, i, toImport.length);
              const path = findPathForItem(state.cache, state.selectedPaths, type, item.name);
              if (!path) continue;

              try {
                let ok = false;
                switch (type) {
                  case 'tables': ok = await get().importTable(path, item.name); break;
                  case 'forms': ok = await get().importForm(path, item.name); break;
                  case 'reports': ok = await get().importReport(path, item.name); break;
                  case 'modules': ok = await get().importModule(path, item.name); break;
                  case 'macros': ok = await get().importMacro(path, item.name); break;
                }
                if (!ok) addFailed(item.name, `${type} import failed`);
              } catch (err) {
                addFailed(item.name, String(err));
              }
            }
          }
        }

        // Post-import pipeline steps
        set(s => { s.autoImportPhase = 'translating'; });

        // Apply fixes
        try { await api.post('/api/database-import/apply-fixes', {}); } catch { /* non-fatal */ }

        // Create function stubs
        try { await api.post('/api/database-import/create-function-stubs', {}); } catch { /* non-fatal */ }

        // Translate modules
        try { await api.post('/api/database-import/translate-modules', {}); } catch { /* non-fatal */ }

        // Resolve expressions
        try { await api.post('/api/database-import/resolve-expressions', {}); } catch { /* non-fatal */ }

        // Wire events
        try { await api.post('/api/database-import/wire-events', {}); } catch { /* non-fatal */ }

        // Validation pipeline
        try {
          await api.post('/api/database-import/repair-pass', {});
          await api.post('/api/database-import/validation-pass', {});
          await api.post('/api/database-import/autofix-pass', {});
        } catch { /* non-fatal */ }

        set(s => { s.autoImportPhase = 'complete'; });
      } finally {
        await get().loadTargetExisting();
        await get().loadImportLog();
        set(s => { s.importing = false; s.importAllActive = false; });
      }
    },

    // --------------------------------------------------------
    // Import log
    // --------------------------------------------------------
    async loadImportLog() {
      const res = await api.get<Array<Record<string, unknown>>>('/api/database-import/history');
      if (res.ok) {
        set(s => { s.importLog = res.data; });
      }
    },

    // --------------------------------------------------------
    // Reset
    // --------------------------------------------------------
    reset() {
      set(s => {
        s.loading = false;
        s.error = null;
        s.activePath = null;
        s.selectedPaths = [];
        s.scannedDatabases = [];
        s.objectType = 'tables';
        s.cache = {};
        s.selected = new Set();
        s.targetExisting = {
          tables: new Set(), queries: new Set(), forms: new Set(),
          reports: new Set(), modules: new Set(), macros: new Set(),
        };
        s.importing = false;
        s.importAllActive = false;
        s.importAllStatus = null;
        s.autoImportPhase = null;
        s.importLog = [];
      });
    },
  }))
);
