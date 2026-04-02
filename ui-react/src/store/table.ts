import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import type { TableInfo, ColumnInfo, ContextMenuState } from '@/api/types';

// ============================================================
// Design field (editable schema)
// ============================================================

export interface DesignField {
  name: string;
  type: string;
  nullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  description?: string;
  isPrimaryKey: boolean;
  defaultValue?: string;
  indexed?: string | boolean | null;
  originalName?: string;
}

// ============================================================
// State
// ============================================================

export interface TableState {
  tableId: string | null;
  tableInfo: TableInfo | null;
  records: Record<string, unknown>[];
  viewMode: 'datasheet' | 'design' | 'intents';
  loading: boolean;

  // Intents
  intents: unknown[] | null;
  intentsLoading: boolean;

  // Datasheet editing
  selected: { row: number; col: string } | null;
  editing: { row: number; col: string } | null;
  contextMenu: ContextMenuState;

  // Design mode
  designFields: DesignField[] | null;
  designOriginal: DesignField[] | null;
  designDirty: boolean;
  designRenames: Record<string, string>;
  designErrors: Array<{ message: string }> | null;
  selectedField: number | null;
  tableDescription: string | null;
  originalDescription: string | null;

  // New table
  newTable: boolean;
  newTableName: string;

  // Sort / filter
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc';
  filters: Record<string, unknown[]>;        // column → excluded values
  activeFilterColumn: string | null;         // which dropdown is open
}

// ============================================================
// Actions
// ============================================================

export interface TableActions {
  // Loading
  loadTableForViewing(table: { id?: number; name: string }): Promise<void>;
  refreshTableData(): Promise<void>;

  // View mode
  setViewMode(mode: 'datasheet' | 'design' | 'intents'): void;

  // Intents
  loadTableIntents(): Promise<void>;

  // Cell selection / editing
  selectCell(row: number, col: string): void;
  selectRow(row: number): void;
  startEditing(row: number, col: string): void;
  stopEditing(): void;
  saveCell(newValue: unknown): Promise<void>;
  moveToNextCell(shift: boolean): void;

  // Context menu
  showContextMenu(x: number, y: number): void;
  hideContextMenu(): void;

  // Clipboard
  copyCell(): void;
  cutCell(): void;
  pasteCell(): void;

  // Record CRUD
  newRecord(): Promise<void>;
  deleteRecord(): Promise<void>;

  // Design mode
  initDesignEditing(): void;
  selectDesignField(idx: number | null): void;
  updateDesignField(idx: number, prop: string, value: unknown): void;
  addDesignField(): void;
  removeDesignField(idx: number): void;
  toggleDesignPk(idx: number): void;
  updateTableDescription(desc: string): void;
  revertDesign(): void;
  saveTableDesign(): Promise<void>;

  // New table
  startNewTable(): void;
  setNewTableName(name: string): void;
  saveNewTable(): Promise<void>;

  // Sort / filter
  sortBy(col: string, dir: 'asc' | 'desc'): void;
  setFilter(col: string, excludedValues: unknown[]): void;
  clearFilter(col?: string): void;
  setActiveFilterColumn(col: string | null): void;
  getFilteredRecords(): Record<string, unknown>[];

  // Field helpers
  getPkField(): string;

  // Reset
  reset(): void;
}

type TableStore = TableState & TableActions;

// Clipboard singleton
let tableClipboard: { value: unknown; cut: boolean; row?: number; col?: string } | null = null;

// PG type → Access display name
const PG_TO_ACCESS: Record<string, string> = {
  'character varying': 'Short Text',
  'varchar': 'Short Text',
  'text': 'Long Text',
  'integer': 'Number',
  'bigint': 'Number',
  'smallint': 'Number',
  'numeric': 'Number',
  'decimal': 'Number',
  'real': 'Number',
  'double precision': 'Number',
  'boolean': 'Yes/No',
  'date': 'Date/Time',
  'timestamp without time zone': 'Date/Time',
  'timestamp with time zone': 'Date/Time',
  'bytea': 'OLE Object',
  'uuid': 'Short Text',
};

function pgTypeToAccess(pgType: string): string {
  return PG_TO_ACCESS[pgType.toLowerCase()] || pgType;
}

// ============================================================
// Store
// ============================================================

export const useTableStore = create<TableStore>()(
  immer((set, get) => ({
    tableId: null,
    tableInfo: null,
    records: [],
    viewMode: 'datasheet',
    loading: false,
    selected: null,
    editing: null,
    contextMenu: { visible: false, x: 0, y: 0 },
    designFields: null,
    designOriginal: null,
    designDirty: false,
    designRenames: {},
    designErrors: null,
    selectedField: null,
    tableDescription: null,
    originalDescription: null,
    intents: null,
    intentsLoading: false,
    newTable: false,
    newTableName: '',
    sortColumn: null,
    sortDirection: 'asc',
    filters: {},
    activeFilterColumn: null,

    // --------------------------------------------------------
    // Loading
    // --------------------------------------------------------
    async loadTableForViewing(table) {
      set(s => {
        s.tableId = table.name;
        s.tableInfo = null;
        s.records = [];
        s.loading = true;
        s.viewMode = 'datasheet';
        s.selected = null;
        s.editing = null;
        s.designFields = null;
        s.designOriginal = null;
        s.designDirty = false;
        s.designRenames = {};
        s.designErrors = null;
        s.intents = null;
        s.intentsLoading = false;
        s.newTable = false;
        s.sortColumn = null;
        s.sortDirection = 'asc';
        s.filters = {};
        s.activeFilterColumn = null;
      });

      // Load table metadata — API returns { tables: [...] }
      // API returns isPrimaryKey but frontend uses pk
      const metaRes = await api.get<{ tables: TableInfo[] }>('/api/tables');
      if (metaRes.ok) {
        const tables = metaRes.data.tables || [];
        const info = tables.find(t => t.name === table.name);
        if (info) {
          for (const f of info.fields) {
            if ((f as any).isPrimaryKey != null) {
              f.pk = (f as any).isPrimaryKey;
            }
          }
          set(s => { s.tableInfo = info; });
        }
      }

      // Load records — API returns { data: [...], pagination: {...} }
      const dataRes = await api.get<{ data: Record<string, unknown>[] }>(`/api/data/${encodeURIComponent(table.name)}?limit=1000`);
      set(s => {
        s.loading = false;
        if (dataRes.ok) s.records = dataRes.data.data || [];
      });
    },

    async refreshTableData() {
      const state = get();
      const name = state.tableInfo?.name;
      if (!name) return;
      let url = `/api/data/${encodeURIComponent(name)}?limit=1000`;
      if (state.sortColumn) {
        url += `&orderBy=${encodeURIComponent(state.sortColumn)}&orderDir=${state.sortDirection}`;
      }
      const res = await api.get<{ data: Record<string, unknown>[] }>(url);
      if (res.ok) set(s => { s.records = res.data.data || []; });
    },

    // --------------------------------------------------------
    // View mode
    // --------------------------------------------------------
    setViewMode(mode) {
      set(s => { s.viewMode = mode; });
      if (mode === 'design') get().initDesignEditing();
      if (mode === 'datasheet') get().refreshTableData();
      if (mode === 'intents') get().loadTableIntents();
    },

    // --------------------------------------------------------
    // Intents
    // --------------------------------------------------------
    async loadTableIntents() {
      const name = get().tableInfo?.name || get().tableId;
      if (!name) return;
      set(s => { s.intentsLoading = true; });
      const res = await api.get<unknown[]>(`/api/tables/${encodeURIComponent(name)}/intents`);
      set(s => {
        s.intentsLoading = false;
        s.intents = res.ok ? res.data : [];
      });
    },

    // --------------------------------------------------------
    // Cell selection / editing
    // --------------------------------------------------------
    selectCell(row, col) {
      set(s => {
        s.selected = { row, col };
        s.contextMenu.visible = false;
      });
    },
    selectRow(row) { set(s => { s.selected = { row, col: '' }; }); },
    startEditing(row, col) { set(s => { s.selected = { row, col }; s.editing = { row, col }; }); },
    stopEditing() { set(s => { s.editing = null; }); },

    async saveCell(newValue) {
      const state = get();
      if (!state.editing || !state.tableInfo) return;
      const { row, col } = state.editing;
      const record = state.records[row] as Record<string, unknown>;
      if (!record) return;

      const pkField = get().getPkField();
      const pkValue = record[pkField];
      if (pkValue == null) return;

      const oldValue = record[col];
      // Optimistic update
      set(s => { (s.records[row] as Record<string, unknown>)[col] = newValue; s.editing = null; });

      const res = await api.put(
        `/api/data/${encodeURIComponent(state.tableInfo!.name)}/${encodeURIComponent(String(pkValue))}`,
        { [col]: newValue },
      );

      if (!res.ok) {
        // Revert
        set(s => { (s.records[row] as Record<string, unknown>)[col] = oldValue; });
        get().refreshTableData();
      }
    },

    moveToNextCell(shift) {
      const state = get();
      if (!state.selected || !state.tableInfo) return;
      const { row, col } = state.selected;
      const fields = state.tableInfo.fields.map(f => f.name);
      const colIdx = fields.indexOf(col);

      if (shift) {
        // Previous cell
        if (colIdx > 0) set(s => { s.selected = { row, col: fields[colIdx - 1] }; });
        else if (row > 0) set(s => { s.selected = { row: row - 1, col: fields[fields.length - 1] }; });
      } else {
        // Next cell
        if (colIdx < fields.length - 1) set(s => { s.selected = { row, col: fields[colIdx + 1] }; });
        else if (row < state.records.length - 1) set(s => { s.selected = { row: row + 1, col: fields[0] }; });
      }
    },

    // --------------------------------------------------------
    // Context menu
    // --------------------------------------------------------
    showContextMenu(x, y) { set(s => { s.contextMenu = { visible: true, x, y }; }); },
    hideContextMenu() { set(s => { s.contextMenu.visible = false; }); },

    // --------------------------------------------------------
    // Clipboard
    // --------------------------------------------------------
    copyCell() {
      const sel = get().selected;
      if (!sel) return;
      const record = get().records[sel.row] as Record<string, unknown>;
      if (record) tableClipboard = { value: record[sel.col], cut: false };
    },
    cutCell() {
      const sel = get().selected;
      if (!sel) return;
      const record = get().records[sel.row] as Record<string, unknown>;
      if (record) tableClipboard = { value: record[sel.col], cut: true, row: sel.row, col: sel.col };
    },
    pasteCell() {
      if (!tableClipboard) return;
      const sel = get().selected;
      if (!sel) return;
      set(s => { s.editing = sel; });
      get().saveCell(tableClipboard.value);
    },

    // --------------------------------------------------------
    // Record CRUD
    // --------------------------------------------------------
    async newRecord() {
      const info = get().tableInfo;
      if (!info) return;
      // Build empty record (skip PK fields)
      const data: Record<string, unknown> = {};
      for (const f of info.fields) {
        if (!f.pk) data[f.name] = null;
      }
      const res = await api.post(`/api/data/${encodeURIComponent(info.name)}`, data);
      if (res.ok) get().refreshTableData();
    },

    async deleteRecord() {
      const state = get();
      if (!state.selected || !state.tableInfo) return;
      const record = state.records[state.selected.row] as Record<string, unknown>;
      if (!record) return;
      const pkField = get().getPkField();
      const pkValue = record[pkField];
      if (pkValue == null) return;

      const res = await api.del(`/api/data/${encodeURIComponent(state.tableInfo.name)}/${encodeURIComponent(String(pkValue))}`);
      if (res.ok) {
        set(s => { s.selected = null; });
        get().refreshTableData();
      }
    },

    // --------------------------------------------------------
    // Design mode
    // --------------------------------------------------------
    initDesignEditing() {
      const info = get().tableInfo;
      if (!info) return;
      const fields: DesignField[] = info.fields.map(f => ({
        name: f.name,
        type: pgTypeToAccess(f.type),
        nullable: f.nullable ?? true,
        maxLength: f.maxLength,
        precision: f.precision,
        scale: f.scale,
        description: f.description,
        isPrimaryKey: !!f.pk,
        defaultValue: f.defaultValue,
        indexed: f.indexed,
      }));
      set(s => {
        s.designFields = fields;
        s.designOriginal = JSON.parse(JSON.stringify(fields));
        s.designDirty = false;
        s.designRenames = {};
        s.designErrors = null;
        s.tableDescription = info.description || null;
        s.originalDescription = info.description || null;
      });
    },

    selectDesignField(idx) { set(s => { s.selectedField = idx; }); },

    updateDesignField(idx, prop, value) {
      set(s => {
        if (!s.designFields?.[idx]) return;
        const f = s.designFields[idx];
        // Track renames
        if (prop === 'name' && f.originalName === undefined) {
          (f as Record<string, unknown>).originalName = f.name;
        }
        if (prop === 'name' && f.originalName) {
          s.designRenames[f.originalName] = value as string;
        }
        (f as Record<string, unknown>)[prop] = value;
        // Recompute dirty
        s.designDirty = JSON.stringify(s.designFields) !== JSON.stringify(s.designOriginal)
          || s.tableDescription !== s.originalDescription;
      });
    },

    addDesignField() {
      set(s => {
        if (!s.designFields) s.designFields = [];
        s.designFields.push({
          name: '',
          type: 'Short Text',
          nullable: true,
          maxLength: 255,
          isPrimaryKey: false,
        });
        s.selectedField = s.designFields.length - 1;
        s.designDirty = true;
      });
    },

    removeDesignField(idx) {
      set(s => {
        if (!s.designFields) return;
        s.designFields.splice(idx, 1);
        if (s.selectedField === idx) s.selectedField = null;
        else if (s.selectedField != null && s.selectedField > idx) s.selectedField--;
        s.designDirty = true;
      });
    },

    toggleDesignPk(idx) {
      set(s => {
        if (!s.designFields?.[idx]) return;
        s.designFields[idx].isPrimaryKey = !s.designFields[idx].isPrimaryKey;
        s.designDirty = true;
      });
    },

    updateTableDescription(desc) {
      set(s => {
        s.tableDescription = desc;
        s.designDirty = JSON.stringify(s.designFields) !== JSON.stringify(s.designOriginal)
          || desc !== s.originalDescription;
      });
    },

    revertDesign() {
      set(s => {
        s.designFields = s.designOriginal ? JSON.parse(JSON.stringify(s.designOriginal)) : null;
        s.designDirty = false;
        s.designRenames = {};
        s.designErrors = null;
        s.tableDescription = s.originalDescription;
      });
    },

    async saveTableDesign() {
      const state = get();
      if (!state.tableInfo || !state.designFields) return;

      const res = await api.put(`/api/tables/${encodeURIComponent(state.tableInfo.name)}`, {
        fields: state.designFields,
        renames: state.designRenames,
        description: state.tableDescription,
      });

      if (res.ok) {
        // Re-populate graph
        api.post('/api/graph/populate');
        // Reload table metadata — API returns { tables: [...] }
        const metaRes = await api.get<{ tables: TableInfo[] }>('/api/tables');
        if (metaRes.ok) {
          const tables = metaRes.data.tables || [];
          const info = tables.find(t => t.name === state.tableInfo!.name);
          if (info) {
            set(s => {
              s.tableInfo = info;
              s.designDirty = false;
              s.designRenames = {};
              s.designErrors = null;
            });
            get().initDesignEditing();
          }
        }
      } else {
        set(s => {
          s.designErrors = [{ message: typeof res.data === 'string' ? res.data : 'Save failed' }];
        });
      }
    },

    // --------------------------------------------------------
    // New table
    // --------------------------------------------------------
    startNewTable() {
      set(s => {
        s.newTable = true;
        s.newTableName = '';
        s.tableInfo = null;
        s.records = [];
        s.viewMode = 'design';
        s.designFields = [{
          name: 'id',
          type: 'Number',
          nullable: false,
          isPrimaryKey: true,
        }];
        s.designOriginal = null;
        s.designDirty = true;
        s.tableDescription = null;
      });
    },

    setNewTableName(name) { set(s => { s.newTableName = name; }); },

    async saveNewTable() {
      const state = get();
      if (!state.newTableName || !state.designFields) return;

      const res = await api.post('/api/tables', {
        name: state.newTableName,
        fields: state.designFields,
        description: state.tableDescription,
      });

      if (res.ok) {
        api.post('/api/graph/populate');
        set(s => { s.newTable = false; s.designDirty = false; });
      } else {
        set(s => {
          s.designErrors = [{ message: typeof res.data === 'string' ? res.data : 'Create failed' }];
        });
      }
    },

    // --------------------------------------------------------
    // Sort / filter
    // --------------------------------------------------------
    sortBy(col, dir) {
      set(s => { s.sortColumn = col; s.sortDirection = dir; s.activeFilterColumn = null; });
      get().refreshTableData();
    },

    setFilter(col, excludedValues) {
      set(s => {
        if (excludedValues.length === 0) {
          delete s.filters[col];
        } else {
          s.filters[col] = excludedValues;
        }
        s.activeFilterColumn = null;
      });
    },

    clearFilter(col) {
      set(s => {
        if (col) {
          delete s.filters[col];
        } else {
          s.filters = {};
        }
      });
    },

    setActiveFilterColumn(col) {
      set(s => { s.activeFilterColumn = col; });
    },

    getFilteredRecords() {
      const state = get();
      const { records, filters } = state;
      const filterCols = Object.keys(filters);
      if (filterCols.length === 0) return records;
      return records.filter(rec => {
        for (const col of filterCols) {
          const excluded = filters[col];
          const val = rec[col];
          // Normalize: null/undefined/'' all treated as blank
          const normalized = (val == null || val === '') ? null : val;
          if (excluded.some(ex => {
            const exNorm = (ex == null || ex === '') ? null : ex;
            return exNorm === null ? normalized === null : String(exNorm) === String(normalized);
          })) {
            return false;
          }
        }
        return true;
      });
    },

    // --------------------------------------------------------
    // Helpers
    // --------------------------------------------------------
    getPkField() {
      const fields = get().tableInfo?.fields;
      if (!fields) return 'id';
      const pk = fields.find(f => f.pk);
      return pk ? pk.name : 'id';
    },

    // --------------------------------------------------------
    // Reset
    // --------------------------------------------------------
    reset() {
      set(s => {
        s.tableId = null;
        s.tableInfo = null;
        s.records = [];
        s.viewMode = 'datasheet';
        s.loading = false;
        s.selected = null;
        s.editing = null;
        s.designFields = null;
        s.designOriginal = null;
        s.designDirty = false;
        s.newTable = false;
      });
    },
  }))
);
