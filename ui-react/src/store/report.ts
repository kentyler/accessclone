import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import type {
  ReportDefinition, Section, ColumnInfo, HandlerEntry,
} from '@/api/types';
import { getFileHandlers } from '@/generated/handlerRegistry';
import { executeHandler } from '@/lib/runtime';
import { useUiStore } from '@/store/ui';

// ============================================================
// State
// ============================================================

export interface ReportState {
  reportId: number | null;
  current: ReportDefinition | null;
  original: ReportDefinition | null;
  dirty: boolean;
  selectedControl: { section: string; idx?: number } | null;
  viewMode: 'design' | 'preview';
  propertiesTab: string;
  lintErrors: Array<{ message: string; path?: string }> | null;
  personalized: boolean;
  records: Record<string, unknown>[];
  eventHandlers: Record<string, HandlerEntry>;
}

// ============================================================
// Actions
// ============================================================

export interface ReportActions {
  // Definition
  setReportDefinition(def: ReportDefinition): void;
  clearLintErrors(): void;
  setLintErrors(errors: Array<{ message: string }>): void;

  // Loading
  loadReportForEditing(report: { id: number; name: string; filename: string; definition?: ReportDefinition }): Promise<void>;
  setupReportEditor(reportId: number, definition: ReportDefinition): void;

  // Save
  saveReport(): Promise<void>;
  doSaveReport(): Promise<void>;

  // View mode
  setViewMode(mode: 'design' | 'preview'): Promise<void>;
  getViewMode(): 'design' | 'preview';

  // Control operations
  selectControl(selection: { section: string; idx?: number } | null): void;
  updateControl(section: string, idx: number, prop: string, value: unknown): void;
  deleteControl(section: string, idx: number): void;

  // Group bands
  addGroupLevel(): void;
  removeGroupLevel(): void;

  // Events
  loadEventHandlers(reportName: string): Promise<void>;
  fireReportEvent(eventKey: string): void;

  // New report
  createNewReport(): void;

  // Personalization
  resetPersonalization(): Promise<void>;
  promoteToStandard(): Promise<void>;

  // Properties tab
  setPropertiesTab(tab: string): void;

  // Reset
  reset(): void;
}

type ReportStore = ReportState & ReportActions;

// ============================================================
// Store
// ============================================================

export const useReportStore = create<ReportStore>()(
  immer((set, get) => ({
    // Initial state
    reportId: null,
    current: null,
    original: null,
    dirty: false,
    selectedControl: null,
    viewMode: 'design',
    propertiesTab: 'format',
    lintErrors: null,
    personalized: false,
    records: [],
    eventHandlers: {},

    // --------------------------------------------------------
    // Definition
    // --------------------------------------------------------
    setReportDefinition(def) {
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
    async loadReportForEditing(report) {
      if (report.definition) {
        get().setupReportEditor(report.id, report.definition);
      } else {
        const res = await api.get<Record<string, unknown>>(`/api/reports/${encodeURIComponent(report.filename)}`);
        if (res.ok && res.data) {
          const def = (res.data as { definition?: ReportDefinition }).definition || res.data as unknown as ReportDefinition;
          get().setupReportEditor(report.id, def);
        }
      }
      // Load event handlers
      const safeName = report.name.replace(/\s+/g, '_');
      get().loadEventHandlers(safeName);
    },

    setupReportEditor(reportId, definition) {
      set(s => {
        s.reportId = reportId;
        s.current = definition;
        s.original = JSON.parse(JSON.stringify(definition));
        s.dirty = false;
        s.selectedControl = null;
        s.lintErrors = null;
        s.records = [];
        s.viewMode = 'design';
      });
    },

    // --------------------------------------------------------
    // Save
    // --------------------------------------------------------
    async saveReport() {
      const state = get();
      if (!state.current) return;

      const lintRes = await api.post<{ valid: boolean; errors?: Array<{ message: string }> }>('/api/lint/report', {
        report: state.current,
      });

      if (lintRes.ok && lintRes.data.valid) {
        get().clearLintErrors();
        await get().doSaveReport();
      } else if (lintRes.ok && !lintRes.data.valid) {
        get().setLintErrors(lintRes.data.errors || []);
      } else {
        await get().doSaveReport();
      }
    },

    async doSaveReport() {
      const state = get();
      if (!state.current) return;
      const name = state.current.name || '';
      const filename = name.toLowerCase().replace(/[^a-z0-9]/g, '_');

      await api.put(`/api/reports/${encodeURIComponent(filename)}`, {
        id: state.reportId,
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

      // Fire on-close when leaving preview
      if (prev === 'preview' && mode === 'design') {
        get().fireReportEvent('on-close');
      }

      // Load data when entering preview
      if (mode === 'preview') {
        const def = get().current;
        if (def?.['record-source']) {
          const recordSource = def['record-source'];
          let records: Record<string, unknown>[] = [];

          if (recordSource.toUpperCase().trimStart().startsWith('SELECT')) {
            const res = await api.post<{ rows: Record<string, unknown>[]; fields: ColumnInfo[] }>('/api/queries/run', {
              sql: recordSource,
            });
            if (res.ok) records = res.data.rows || [];
          } else {
            const params = new URLSearchParams({ limit: '1000' });
            const res = await api.get<Record<string, unknown>[]>(`/api/data/${encodeURIComponent(recordSource)}?${params}`);
            if (res.ok) records = res.data;
          }

          set(s => { s.records = records; });

          if (records.length === 0) {
            get().fireReportEvent('on-no-data');
          } else {
            get().fireReportEvent('on-open');
          }
        }
      }
    },

    getViewMode() { return get().viewMode; },

    // --------------------------------------------------------
    // Control operations
    // --------------------------------------------------------
    selectControl(selection) { set(s => { s.selectedControl = selection; }); },

    updateControl(section, idx, prop, value) {
      set(s => {
        const sec = s.current?.[section as keyof ReportDefinition] as Section | undefined;
        if (sec?.controls?.[idx]) {
          (sec.controls[idx] as Record<string, unknown>)[prop] = value;
          s.dirty = true;
        }
      });
    },

    deleteControl(section, idx) {
      set(s => {
        const sec = s.current?.[section as keyof ReportDefinition] as Section | undefined;
        if (sec?.controls) {
          sec.controls.splice(idx, 1);
          s.selectedControl = null;
          s.dirty = true;
        }
      });
    },

    // --------------------------------------------------------
    // Group bands
    // --------------------------------------------------------
    addGroupLevel() {
      set(s => {
        if (!s.current) return;
        if (!s.current.grouping) s.current.grouping = [];
        const n = s.current.grouping.length;
        s.current.grouping.push({ field: '', 'sort-order': 'asc' });
        (s.current as Record<string, unknown>)[`group-header-${n}`] = { height: 300, controls: [] };
        (s.current as Record<string, unknown>)[`group-footer-${n}`] = { height: 300, controls: [] };
        s.dirty = true;
      });
    },

    removeGroupLevel() {
      set(s => {
        if (!s.current?.grouping?.length) return;
        const n = s.current.grouping.length - 1;
        s.current.grouping.pop();
        delete (s.current as Record<string, unknown>)[`group-header-${n}`];
        delete (s.current as Record<string, unknown>)[`group-footer-${n}`];
        s.dirty = true;
      });
    },

    // --------------------------------------------------------
    // Events
    // --------------------------------------------------------
    async loadEventHandlers(reportName) {
      const moduleName = `Report_${reportName}`;
      const databaseId = useUiStore.getState().currentDatabase?.database_id;

      // Try file registry first (synchronous, no API call)
      if (databaseId) {
        const fileHandlers = getFileHandlers(databaseId, moduleName);
        if (fileHandlers) {
          set(s => { s.eventHandlers = fileHandlers; });
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
        set(s => { s.eventHandlers = handlers; });
      }
    },

    fireReportEvent(eventKey) {
      const handler = get().eventHandlers[eventKey];
      if (handler?.js) {
        executeHandler(handler.js, eventKey);
      }
    },

    // --------------------------------------------------------
    // New report
    // --------------------------------------------------------
    createNewReport() {
      set(s => {
        s.current = {
          name: 'New Report',
          'report-header': { height: 500, controls: [] },
          'page-header': { height: 300, controls: [] },
          detail: { height: 300, controls: [] },
          'page-footer': { height: 300, controls: [] },
          'report-footer': { height: 300, controls: [] },
        };
        s.original = JSON.parse(JSON.stringify(s.current));
        s.dirty = false;
        s.reportId = null;
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
      await api.del(`/api/reports/${encodeURIComponent(filename)}/personalization`);
    },

    async promoteToStandard() {
      const def = get().current;
      if (!def?.name) return;
      const filename = def.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      await api.post(`/api/reports/${encodeURIComponent(filename)}/promote`);
    },

    // --------------------------------------------------------
    // Properties tab
    // --------------------------------------------------------
    setPropertiesTab(tab) { set(s => { s.propertiesTab = tab; }); },

    // --------------------------------------------------------
    // Reset
    // --------------------------------------------------------
    reset() {
      set(s => {
        s.reportId = null;
        s.current = null;
        s.original = null;
        s.dirty = false;
        s.selectedControl = null;
        s.viewMode = 'design';
        s.lintErrors = null;
        s.records = [];
        s.eventHandlers = {};
      });
    },
  }))
);
