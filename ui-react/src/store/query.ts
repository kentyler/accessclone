import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import type { QueryInfo, ColumnInfo } from '@/api/types';

// ============================================================
// State
// ============================================================

export interface QueryState {
  queryId: number | null;
  queryInfo: QueryInfo | null;
  sql: string;
  results: Record<string, unknown>[];
  resultFields: ColumnInfo[];
  viewMode: 'results' | 'sql';
  loading: boolean;
  error: string | null;
  pendingName: string | null;
}

// ============================================================
// Actions
// ============================================================

export interface QueryActions {
  loadQueryForViewing(query: QueryInfo): Promise<void>;
  setSql(sql: string): void;
  runQuery(): Promise<void>;
  setViewMode(mode: 'results' | 'sql'): void;
  createNewQuery(): void;
  setNewQueryName(name: string): void;
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
      });
      // Auto-run
      await get().runQuery();
    },

    setSql(sql) { set(s => { s.sql = sql; }); },

    async runQuery() {
      const sql = get().sql.trim();
      if (!sql) return;

      set(s => { s.loading = true; s.error = null; });

      const res = await api.post<{ rows: Record<string, unknown>[]; fields: ColumnInfo[]; error?: string }>('/api/queries/run', { sql });

      set(s => {
        s.loading = false;
        if (res.ok && !res.data.error) {
          s.results = res.data.rows || [];
          s.resultFields = res.data.fields || [];
          s.error = null;
        } else {
          s.results = [];
          s.resultFields = [];
          s.error = res.data?.error || (typeof res.data === 'string' ? res.data : 'Query failed');
        }
      });
    },

    setViewMode(mode) { set(s => { s.viewMode = mode; }); },

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
      });
    },

    setNewQueryName(name) { set(s => { s.pendingName = name; }); },

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
      });
    },
  }))
);
