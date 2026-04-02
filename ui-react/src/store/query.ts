import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import type { QueryInfo, ColumnInfo } from '@/api/types';

// ============================================================
// Design data (from server's parseQueryDesign)
// ============================================================

export interface QBETable {
  name: string;
  alias: string | null;
  schema: string | null;
  columns: string[];
}

export interface QBEJoin {
  type: string;
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
}

export interface QBEField {
  expression: string;
  table: string | null;
  alias: string | null;
  sort: string | null;
  show: boolean;
}

export interface QBEDesignData {
  parseable: boolean;
  sql?: string;
  tables?: QBETable[];
  joins?: QBEJoin[];
  fields?: QBEField[];
  where?: string | null;
  groupBy?: string[] | null;
  orderBy?: Array<{ expression: string; direction: string }> | null;
}

// ============================================================
// State
// ============================================================

export interface QueryState {
  queryId: number | null;
  queryInfo: QueryInfo | null;
  sql: string;
  results: Record<string, unknown>[];
  resultFields: ColumnInfo[];
  viewMode: 'results' | 'sql' | 'design';
  loading: boolean;
  error: string | null;
  pendingName: string | null;

  // Design view
  designData: QBEDesignData | null;
  designLoading: boolean;

  // Sort / filter (client-side, for results view)
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc';
  filters: Record<string, unknown[]>;
  activeFilterColumn: string | null;
}

// ============================================================
// Actions
// ============================================================

export interface QueryActions {
  loadQueryForViewing(query: QueryInfo): Promise<void>;
  setSql(sql: string): void;
  runQuery(): Promise<void>;
  setViewMode(mode: 'results' | 'sql' | 'design'): void;
  createNewQuery(): void;
  setNewQueryName(name: string): void;
  loadDesignData(): Promise<void>;

  // Sort / filter
  sortBy(col: string, dir: 'asc' | 'desc'): void;
  setFilter(col: string, excludedValues: unknown[]): void;
  clearFilter(col?: string): void;
  setActiveFilterColumn(col: string | null): void;
  getFilteredResults(): Record<string, unknown>[];

  reset(): void;
}

type QueryStore = QueryState & QueryActions;

// ============================================================
// Store
// ============================================================

export const useQueryStore = create<QueryStore>()(
  immer((set, get) => ({
    queryId: null,
    queryInfo: null,
    sql: '',
    results: [],
    resultFields: [],
    viewMode: 'results',
    loading: false,
    error: null,
    pendingName: null,
    designData: null,
    designLoading: false,
    sortColumn: null,
    sortDirection: 'asc',
    filters: {},
    activeFilterColumn: null,

    async loadQueryForViewing(query) {
      set(s => {
        s.queryId = query.id;
        s.queryInfo = query;
        s.sql = query.sql || '';
        s.results = [];
        s.resultFields = [];
        s.viewMode = 'results';
        s.loading = false;
        s.error = null;
        s.designData = null;
        s.designLoading = false;
        s.sortColumn = null;
        s.sortDirection = 'asc';
        s.filters = {};
        s.activeFilterColumn = null;
      });
      // Auto-run
      await get().runQuery();
    },

    setSql(sql) { set(s => { s.sql = sql; }); },

    async runQuery() {
      const sql = get().sql.trim();
      if (!sql) return;

      set(s => { s.loading = true; s.error = null; });

      const res = await api.post<{ data: Record<string, unknown>[]; fields: Array<{ name: string; type: number }>; rowCount: number; error?: string }>('/api/queries/run', { sql });

      set(s => {
        s.loading = false;
        if (res.ok && !res.data.error) {
          s.results = res.data.data || [];
          // Map server fields (name + OID number) to ColumnInfo
          s.resultFields = (res.data.fields || []).map(f => ({
            name: f.name,
            type: String(f.type),
          }));
          s.error = null;
        } else {
          s.results = [];
          s.resultFields = [];
          s.error = res.data?.error || (typeof res.data === 'string' ? res.data : 'Query failed');
        }
      });
    },

    setViewMode(mode) {
      set(s => { s.viewMode = mode; });
      if (mode === 'design' && !get().designData && !get().designLoading) {
        get().loadDesignData();
      }
    },

    async loadDesignData() {
      const queryInfo = get().queryInfo;
      if (!queryInfo) return;

      set(s => { s.designLoading = true; });

      const res = await api.get<QBEDesignData>(`/api/queries/${encodeURIComponent(queryInfo.name)}/design`);

      set(s => {
        s.designLoading = false;
        s.designData = res.ok ? res.data : { parseable: false };
      });
    },

    createNewQuery() {
      set(s => {
        s.queryId = null;
        s.queryInfo = null;
        s.sql = 'SELECT ';
        s.results = [];
        s.resultFields = [];
        s.viewMode = 'sql';
        s.error = null;
        s.pendingName = 'New Query';
        s.designData = null;
        s.designLoading = false;
        s.sortColumn = null;
        s.sortDirection = 'asc';
        s.filters = {};
        s.activeFilterColumn = null;
      });
    },

    setNewQueryName(name) { set(s => { s.pendingName = name; }); },

    // --------------------------------------------------------
    // Sort / filter (client-side)
    // --------------------------------------------------------
    sortBy(col, dir) {
      set(s => {
        s.sortColumn = col;
        s.sortDirection = dir;
        s.activeFilterColumn = null;
        // Sort results in-place
        s.results.sort((a, b) => {
          const aVal = a[col];
          const bVal = b[col];
          if (aVal == null && bVal == null) return 0;
          if (aVal == null) return dir === 'asc' ? -1 : 1;
          if (bVal == null) return dir === 'asc' ? 1 : -1;
          const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
          return dir === 'asc' ? cmp : -cmp;
        });
      });
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

    getFilteredResults() {
      const state = get();
      const { results, filters } = state;
      const filterCols = Object.keys(filters);
      if (filterCols.length === 0) return results;
      return results.filter(rec => {
        for (const col of filterCols) {
          const excluded = filters[col];
          const val = rec[col];
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

    reset() {
      set(s => {
        s.queryId = null;
        s.queryInfo = null;
        s.sql = '';
        s.results = [];
        s.resultFields = [];
        s.viewMode = 'results';
        s.loading = false;
        s.error = null;
        s.designData = null;
        s.designLoading = false;
        s.sortColumn = null;
        s.sortDirection = 'asc';
        s.filters = {};
        s.activeFilterColumn = null;
      });
    },
  }))
);
