import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import { registerFnHandlers } from '@/generated/handlerRegistry';
import type {
  Database, TableInfo, ColumnInfo, QueryInfo, FormListItem, ReportListItem,
  ModuleListItem, MacroListItem, SqlFunctionInfo, TabDescriptor,
  ChatMessage, AppMode, ObjectType, AppConfig, LogsFilter,
  ImportLogEntry, ImportIssue, ContextMenuState,
  ModuleDetail, MacroDetail,
} from '@/api/types';

// ============================================================
// State shape
// ============================================================

export interface UiState {
  // Database selection
  availableDatabases: Database[];
  currentDatabase: Database | null;
  loadingObjects: boolean;

  // Global UI
  loading: boolean;
  error: string | null;
  optionsDialogOpen: boolean;
  appMode: AppMode;

  // Sidebar
  sidebarCollapsed: boolean;
  sidebarObjectType: ObjectType;

  // Objects loaded from database
  objects: {
    tables: TableInfo[];
    queries: QueryInfo[];
    forms: FormListItem[];
    reports: ReportListItem[];
    modules: ModuleListItem[];
    macros: MacroListItem[];
    sqlFunctions: SqlFunctionInfo[];
  };

  // Tab management
  openTabs: TabDescriptor[];
  activeTab: TabDescriptor | null;

  // Chat
  chatMessages: ChatMessage[];
  chatInput: string;
  chatLoading: boolean;
  chatPanelOpen: boolean;
  chatTab: TabDescriptor | null;
  autoAnalyzePending: boolean;

  // Logs mode
  logsEntries: ImportLogEntry[];
  logsSelectedEntry: ImportLogEntry | null;
  logsIssues: ImportIssue[];
  logsLoading: boolean;
  logsFilter: LogsFilter;

  // Import
  importCompleteness: Record<string, unknown> | null;

  // Module viewer (simple enough to keep here)
  moduleViewer: {
    moduleId: number | null;
    moduleInfo: ModuleDetail | null;
    loading: boolean;
    translating: boolean;
  };

  // Macro viewer
  macroViewer: {
    macroId: number | null;
    macroInfo: MacroDetail | null;
    loading: boolean;
  };

  // Properties panel
  propertiesPanelOpen: boolean;

  // Config
  config: AppConfig;

  // Context menu (global)
  contextMenu: ContextMenuState;

  // Saved UI state (for restore after load)
  _pendingUiState: unknown;
  _pendingLoads: number;
}

// ============================================================
// Actions
// ============================================================

export interface UiActions {
  // Init
  init(): Promise<void>;

  // Error / Loading
  setLoading(v: boolean): void;
  setError(error: string | null): void;
  clearError(): void;

  // Database
  loadDatabases(): Promise<void>;
  switchDatabase(databaseId: string): Promise<void>;

  // Object loaders
  loadAllObjects(): Promise<void>;
  loadTables(): Promise<void>;
  loadQueries(): Promise<void>;
  loadForms(): Promise<void>;
  loadReports(): Promise<void>;
  loadModules(): Promise<void>;
  loadMacros(): Promise<void>;
  loadSqlFunctions(): Promise<void>;

  // Tab management
  openObject(type: ObjectType, id: number | string, name: string): void;
  closeTab(type: ObjectType, id: number | string): void;
  setActiveTab(tab: TabDescriptor | null): void;

  // Sidebar
  toggleSidebar(): void;
  togglePropertiesPanel(): void;
  setSidebarObjectType(type: ObjectType): void;

  // App mode
  setAppMode(mode: AppMode): void;

  // Chat
  toggleChatPanel(): void;
  setChatInput(text: string): void;
  addChatMessage(role: 'user' | 'assistant', content: string): void;
  setChatLoading(v: boolean): void;
  sendChatMessage(): Promise<void>;
  saveChatTranscript(): Promise<void>;
  loadChatTranscript(tab: TabDescriptor): Promise<void>;

  // Module/Macro viewer
  loadModuleForViewing(mod: ModuleListItem): Promise<void>;
  loadMacroForViewing(macro: MacroListItem): Promise<void>;
  setModuleStatus(status: string, reviewNotes?: string): void;

  // Logs
  loadLogEntries(): Promise<void>;
  selectLogEntry(entry: ImportLogEntry | null): Promise<void>;
  loadIssuesForEntry(entry: ImportLogEntry): Promise<void>;
  loadAllIssues(): Promise<void>;
  toggleIssueResolved(issueId: number, currentlyResolved: boolean): Promise<void>;
  setLogsFilter(key: keyof LogsFilter, value: string | null): void;

  // Config
  loadConfig(): Promise<void>;
  saveConfig(): Promise<void>;
  setGridSize(size: number): void;
  openOptionsDialog(): void;
  closeOptionsDialog(): void;
  hasCapability(cap: string): boolean;

  // UI state persistence
  saveUiState(): Promise<void>;
  loadUiState(): Promise<void>;

  // Import completeness
  loadImportCompleteness(): Promise<void>;

  // Context menu
  showContextMenu(x: number, y: number): void;
  hideContextMenu(): void;

  // Helpers
  updateObject(type: ObjectType, id: number, updates: Record<string, unknown>): void;
  addObject(type: ObjectType, obj: unknown): void;
  getObjectsKey(type: ObjectType): keyof UiState['objects'];
}

type UiStore = UiState & UiActions;

// ============================================================
// Object type → store key mapping
// ============================================================

const typeToKey: Record<ObjectType, keyof UiState['objects']> = {
  tables: 'tables',
  queries: 'queries',
  forms: 'forms',
  reports: 'reports',
  modules: 'modules',
  macros: 'macros',
  'sql-functions': 'sqlFunctions',
  graph: 'tables', // graph doesn't use object lists; placeholder to satisfy type
};

// ============================================================
// Store
// ============================================================

export const useUiStore = create<UiStore>()(
  immer((set, get) => ({
    // Initial state
    availableDatabases: [],
    currentDatabase: null,
    loadingObjects: false,
    loading: false,
    error: null,
    optionsDialogOpen: false,
    appMode: 'run',
    sidebarCollapsed: false,
    sidebarObjectType: 'tables',
    objects: {
      tables: [], queries: [], forms: [], reports: [],
      modules: [], macros: [], sqlFunctions: [],
    },
    openTabs: [],
    activeTab: null,
    chatMessages: [],
    chatInput: '',
    chatLoading: false,
    chatPanelOpen: false,
    chatTab: null,
    autoAnalyzePending: false,
    logsEntries: [],
    logsSelectedEntry: null,
    logsIssues: [],
    logsLoading: false,
    logsFilter: { objectType: null, status: null },
    importCompleteness: null,
    moduleViewer: { moduleId: null, moduleInfo: null, loading: false, translating: false },
    macroViewer: { macroId: null, macroInfo: null, loading: false },
    propertiesPanelOpen: true,
    config: { formDesigner: { gridSize: 8 } },
    contextMenu: { visible: false, x: 0, y: 0 },
    _pendingUiState: null,
    _pendingLoads: 0,

    // --------------------------------------------------------
    // Init
    // --------------------------------------------------------
    async init() {
      const whoami = await api.get<{ username: string }>('/api/whoami');
      if (whoami.ok) api.setUserId(whoami.data.username);

      const uiState = await api.get<Record<string, unknown>>('/api/session/ui-state');
      if (uiState.ok && uiState.data) {
        set(s => { s._pendingUiState = uiState.data; });
      }

      await Promise.all([get().loadDatabases(), get().loadConfig()]);
    },

    // --------------------------------------------------------
    // Error / Loading
    // --------------------------------------------------------
    setLoading(v) { set(s => { s.loading = v; }); },
    setError(error) { set(s => { s.error = error; }); },
    clearError() { set(s => { s.error = null; }); },

    // --------------------------------------------------------
    // Database
    // --------------------------------------------------------
    async loadDatabases() {
      const res = await api.get<{ databases: Database[]; current: string }>('/api/databases');
      if (!res.ok) return;
      const databases = res.data.databases ?? [];
      const currentId = res.data.current;
      set(s => {
        s.availableDatabases = databases;
        if (databases.length > 0 && !s.currentDatabase) {
          s.currentDatabase = databases.find(d => d.database_id === currentId) ?? databases[0];
        }
      });
      const db = get().currentDatabase;
      if (db) {
        api.setDatabaseId(db.database_id);
        await get().loadAllObjects();
      }
    },

    async switchDatabase(databaseId) {
      const res = await api.post('/api/databases/switch', { database_id: databaseId });
      if (!res.ok) return;
      const db = get().availableDatabases.find(d => d.database_id === databaseId);
      if (!db) return;
      set(s => {
        s.currentDatabase = db;
        s.openTabs = [];
        s.activeTab = null;
        s.chatMessages = [];
        s.chatTab = null;
      });
      api.setDatabaseId(databaseId);
      await get().loadAllObjects();
    },

    // --------------------------------------------------------
    // Object loaders
    // --------------------------------------------------------
    async loadAllObjects() {
      set(s => { s.loadingObjects = true; s._pendingLoads = 7; });
      const decrement = () => {
        set(s => {
          s._pendingLoads--;
          if (s._pendingLoads <= 0) {
            s.loadingObjects = false;
            if (s._pendingUiState) {
              const saved = s._pendingUiState as Record<string, unknown>;
              s._pendingUiState = null;
              if (Array.isArray(saved.open_objects)) {
                s.openTabs = saved.open_objects as TabDescriptor[];
              }
              if (saved.active_tab) {
                s.activeTab = saved.active_tab as TabDescriptor;
              }
              if (saved.app_mode) {
                s.appMode = saved.app_mode as AppMode;
              }
            }
          }
        });
      };

      const wrap = async (fn: () => Promise<void>) => {
        try { await fn(); } finally { decrement(); }
      };

      await Promise.all([
        wrap(() => get().loadTables()),
        wrap(() => get().loadQueries()),
        wrap(() => get().loadForms()),
        wrap(() => get().loadReports()),
        wrap(() => get().loadModules()),
        wrap(() => get().loadMacros()),
        wrap(() => get().loadSqlFunctions()),
      ]);

      // Register fn.* handlers for cross-module function dispatch
      const dbId = get().currentDatabase?.database_id;
      if (dbId) {
        const count = registerFnHandlers(dbId);
        if (count > 0) console.log(`Registered ${count} fn.* handlers for ${dbId}`);
      }
    },

    // Match CLJS: body.tables is array of objects, add synthetic 1-based id
    async loadTables() {
      const res = await api.get<Record<string, unknown>>('/api/tables');
      if (res.ok) {
        const raw = (res.data.tables ?? []) as Array<Record<string, unknown>>;
        set(s => {
          s.objects.tables = raw.map((t, i) => ({
            id: i + 1, name: t.name as string,
            fields: (t.fields ?? []) as ColumnInfo[],
            description: t.description as string | undefined,
          }));
        });
      }
    },
    // Match CLJS: body.queries is array of objects, add synthetic id
    async loadQueries() {
      const res = await api.get<Record<string, unknown>>('/api/queries');
      if (res.ok) {
        const raw = (res.data.queries ?? []) as Array<Record<string, unknown>>;
        set(s => {
          s.objects.queries = raw.map((q, i) => ({
            id: i + 1, name: q.name as string,
            sql: (q.sql ?? '') as string,
            fields: (q.fields ?? []) as ColumnInfo[],
          }));
        });
      }
    },
    // Match CLJS: iterate body.forms (string array), look up detail by index
    async loadForms() {
      const res = await api.get<Record<string, unknown>>('/api/forms');
      if (res.ok) {
        const names = (res.data.forms ?? []) as string[];
        const details = (res.data.details ?? []) as Array<Record<string, unknown>>;
        set(s => {
          s.objects.forms = names.map((name, i) => ({
            id: i + 1, name, filename: name,
            record_source: (details[i]?.record_source as string) || undefined,
          }));
        });
      }
    },
    // Match CLJS: iterate body.reports (string array), look up detail by index
    async loadReports() {
      const res = await api.get<Record<string, unknown>>('/api/reports');
      if (res.ok) {
        const names = (res.data.reports ?? []) as string[];
        const details = (res.data.details ?? []) as Array<Record<string, unknown>>;
        set(s => {
          s.objects.reports = names.map((name, i) => ({
            id: i + 1, name, filename: name,
            record_source: (details[i]?.record_source as string) || undefined,
          }));
        });
      }
    },
    // Match CLJS: body.modules is string array, add synthetic id
    async loadModules() {
      const res = await api.get<Record<string, unknown>>('/api/modules');
      if (res.ok) {
        const names = (res.data.modules ?? []) as string[];
        set(s => {
          s.objects.modules = names.map((name, i) => ({
            id: i + 1, name, filename: name,
          }));
        });
      }
    },
    // Match CLJS: body.macros is string array, add synthetic id
    async loadMacros() {
      const res = await api.get<Record<string, unknown>>('/api/macros');
      if (res.ok) {
        const names = (res.data.macros ?? []) as string[];
        set(s => {
          s.objects.macros = names.map((name, i) => ({
            id: i + 1, name,
          }));
        });
      }
    },
    // Match CLJS: body.functions is array of objects, add synthetic id
    async loadSqlFunctions() {
      const res = await api.get<Record<string, unknown>>('/api/functions');
      if (res.ok) {
        const raw = (res.data.functions ?? []) as Array<Record<string, unknown>>;
        set(s => {
          s.objects.sqlFunctions = raw.map((f, i) => ({
            id: i + 1, name: f.name as string,
            arguments: (f.arguments ?? '') as string,
            return_type: (f.returnType ?? f.return_type ?? '') as string,
            source: f.source as string | undefined,
            description: f.description as string | undefined,
          }));
        });
      }
    },

    // --------------------------------------------------------
    // Tab management
    // --------------------------------------------------------
    openObject(type, id, name) {
      set(s => {
        const exists = s.openTabs.some(t => t.type === type && t.id === id);
        if (!exists) {
          s.openTabs.push({ type, id, name });
        }
        s.activeTab = { type, id, name };
      });
      // Save transcript + UI state async
      get().saveChatTranscript();
      get().loadChatTranscript(get().activeTab!);
      get().saveUiState();
    },

    closeTab(type, id) {
      set(s => {
        const idx = s.openTabs.findIndex(t => t.type === type && t.id === id);
        if (idx >= 0) s.openTabs.splice(idx, 1);
        // Set new active tab
        if (s.activeTab?.type === type && s.activeTab?.id === id) {
          s.activeTab = s.openTabs.length > 0 ? s.openTabs[s.openTabs.length - 1] : null;
        }
      });
      get().saveUiState();
      const tab = get().activeTab;
      if (tab) get().loadChatTranscript(tab);
    },

    setActiveTab(tab) {
      set(s => { s.activeTab = tab; });
      if (tab) {
        get().loadChatTranscript(tab);
        get().saveUiState();
      }
    },

    // --------------------------------------------------------
    // Sidebar
    // --------------------------------------------------------
    toggleSidebar() { set(s => { s.sidebarCollapsed = !s.sidebarCollapsed; }); },
    togglePropertiesPanel() { set(s => { s.propertiesPanelOpen = !s.propertiesPanelOpen; }); },
    setSidebarObjectType(type) {
      set(s => { s.sidebarObjectType = type; });
      if (type === 'graph') {
        get().openObject('graph', 'explorer', 'Graph Explorer');
      }
    },

    // --------------------------------------------------------
    // App mode
    // --------------------------------------------------------
    setAppMode(mode) {
      set(s => { s.appMode = mode; });
      if (mode === 'logs') get().loadLogEntries();
      get().saveUiState();
    },

    // --------------------------------------------------------
    // Chat
    // --------------------------------------------------------
    toggleChatPanel() { set(s => { s.chatPanelOpen = !s.chatPanelOpen; }); },
    setChatInput(text) { set(s => { s.chatInput = text; }); },
    addChatMessage(role, content) { set(s => { s.chatMessages.push({ role, content }); }); },
    setChatLoading(v) { set(s => { s.chatLoading = v; }); },

    async sendChatMessage() {
      const state = get();
      const message = state.chatInput.trim();
      if (!message) return;

      set(s => {
        s.chatMessages.push({ role: 'user', content: message });
        s.chatInput = '';
        s.chatLoading = true;
      });

      const body: Record<string, unknown> = {
        message,
        history: get().chatMessages.slice(0, -1),
        database_id: get().currentDatabase?.database_id,
      };

      // Add context based on active tab type
      const tab = state.activeTab;
      if (tab) {
        if (tab.type === 'forms') {
          const form = state.objects.forms.find(f => f.id === tab.id);
          if (form) {
            body.form_context = {
              form_name: form.name,
              record_source: form.record_source || form.definition?.['record-source'],
              definition: form.definition,
            };
          }
        } else if (tab.type === 'reports') {
          const report = state.objects.reports.find(r => r.id === tab.id);
          if (report) {
            body.report_context = {
              report_name: report.name,
              record_source: report.record_source || report.definition?.['record-source'],
              definition: report.definition,
            };
          }
        } else if (tab.type === 'modules') {
          const mod = state.moduleViewer.moduleInfo;
          if (mod) {
            body.module_context = { vba_source: mod.vba_source, name: mod.name };
          }
        }
      }

      const res = await api.post<{ message: string; updated_query?: unknown }>('/api/chat', body);
      set(s => { s.chatLoading = false; });

      if (res.ok && res.data.message) {
        set(s => { s.chatMessages.push({ role: 'assistant', content: res.data.message }); });
        get().saveChatTranscript();
        if (res.data.updated_query) {
          get().loadQueries();
          get().loadSqlFunctions();
        }
      }
    },

    async saveChatTranscript() {
      const { chatTab, chatMessages } = get();
      if (!chatTab) return;
      await api.put(`/api/transcripts/${chatTab.type}/${chatTab.name}`, { transcript: chatMessages });
    },

    async loadChatTranscript(tab) {
      set(s => { s.chatTab = tab; s.chatMessages = []; s.autoAnalyzePending = false; });
      const res = await api.get<{ transcript: ChatMessage[] }>(`/api/transcripts/${tab.type}/${tab.name}`);
      if (res.ok && res.data.transcript?.length > 0) {
        set(s => { s.chatMessages = res.data.transcript; });
      } else {
        set(s => { s.autoAnalyzePending = true; });
      }
    },

    // --------------------------------------------------------
    // Module / Macro viewer
    // --------------------------------------------------------
    async loadModuleForViewing(mod) {
      set(s => { s.moduleViewer = { moduleId: mod.id, moduleInfo: null, loading: true, translating: false }; });
      const res = await api.get<ModuleDetail>(`/api/modules/${encodeURIComponent(mod.name)}`);
      set(s => {
        s.moduleViewer.loading = false;
        if (res.ok) s.moduleViewer.moduleInfo = res.data;
      });
    },

    async loadMacroForViewing(macro) {
      set(s => { s.macroViewer = { macroId: macro.id, macroInfo: null, loading: true }; });
      const res = await api.get<MacroDetail>(`/api/macros/${encodeURIComponent(macro.name)}`);
      set(s => {
        s.macroViewer.loading = false;
        if (res.ok) s.macroViewer.macroInfo = res.data;
      });
    },

    setModuleStatus(status, reviewNotes) {
      set(s => {
        if (s.moduleViewer.moduleInfo) {
          s.moduleViewer.moduleInfo.status = status;
          if (reviewNotes !== undefined) s.moduleViewer.moduleInfo.review_notes = reviewNotes;
        }
      });
    },

    // --------------------------------------------------------
    // Logs
    // --------------------------------------------------------
    async loadLogEntries() {
      const dbId = get().currentDatabase?.database_id;
      if (!dbId) return;
      set(s => { s.logsLoading = true; });
      const res = await api.get<ImportLogEntry[]>(`/api/database-import/history?target_database_id=${dbId}&limit=200`);
      set(s => {
        s.logsLoading = false;
        if (res.ok) s.logsEntries = res.data;
      });
    },

    async selectLogEntry(entry) {
      set(s => { s.logsSelectedEntry = entry; });
      if (entry) {
        await get().loadIssuesForEntry(entry);
      } else {
        await get().loadAllIssues();
      }
    },

    async loadIssuesForEntry(entry) {
      const dbId = get().currentDatabase?.database_id;
      if (!dbId) return;
      const res = await api.get<ImportIssue[]>(`/api/import-issues?database_id=${dbId}&import_log_id=${entry.id}`);
      if (res.ok) set(s => { s.logsIssues = res.data; });
    },

    async loadAllIssues() {
      const dbId = get().currentDatabase?.database_id;
      if (!dbId) return;
      const res = await api.get<ImportIssue[]>(`/api/import-issues?database_id=${dbId}`);
      if (res.ok) set(s => { s.logsIssues = res.data; });
    },

    async toggleIssueResolved(issueId, currentlyResolved) {
      await api.patch(`/api/import-issues/${issueId}`, { resolved: !currentlyResolved });
      // Refresh
      const entry = get().logsSelectedEntry;
      if (entry) await get().loadIssuesForEntry(entry);
      else await get().loadAllIssues();
      await get().loadLogEntries();
    },

    setLogsFilter(key, value) { set(s => { s.logsFilter[key] = value; }); },

    // --------------------------------------------------------
    // Config
    // --------------------------------------------------------
    async loadConfig() {
      const res = await api.get<Record<string, unknown>>('/api/config');
      if (res.ok && res.data) {
        set(s => {
          const d = res.data as Record<string, unknown>;
          if (d.form_designer && typeof d.form_designer === 'object') {
            const fd = d.form_designer as Record<string, unknown>;
            s.config.formDesigner.gridSize = (fd.grid_size as number) || 8;
          }
          if (d.capabilities) {
            s.config.capabilities = d.capabilities as Record<string, boolean>;
          }
        });
      }
    },

    async saveConfig() {
      const cfg = get().config;
      await api.put('/api/config', {
        form_designer: { grid_size: cfg.formDesigner.gridSize },
      });
    },

    setGridSize(size) {
      set(s => { s.config.formDesigner.gridSize = size; });
    },

    openOptionsDialog() { set(s => { s.optionsDialogOpen = true; }); },
    closeOptionsDialog() { set(s => { s.optionsDialogOpen = false; }); },

    hasCapability(cap) {
      return !!get().config.capabilities?.[cap];
    },

    // --------------------------------------------------------
    // UI state persistence
    // --------------------------------------------------------
    async saveUiState() {
      const { currentDatabase, openTabs, activeTab, appMode } = get();
      if (!currentDatabase) return;
      await api.put('/api/session/ui-state', {
        database_id: currentDatabase.database_id,
        open_objects: openTabs,
        active_tab: activeTab,
        app_mode: appMode,
      });
    },

    async loadUiState() {
      const res = await api.get<Record<string, unknown>>('/api/session/ui-state');
      if (res.ok && res.data) {
        set(s => { s._pendingUiState = res.data; });
      }
    },

    // --------------------------------------------------------
    // Import completeness
    // --------------------------------------------------------
    async loadImportCompleteness() {
      const dbId = get().currentDatabase?.database_id;
      if (!dbId) return;
      const res = await api.get<Record<string, unknown>>(`/api/database-import/import-completeness?database_id=${dbId}`);
      if (res.ok) set(s => { s.importCompleteness = res.data; });
    },

    // --------------------------------------------------------
    // Context menu
    // --------------------------------------------------------
    showContextMenu(x, y) { set(s => { s.contextMenu = { visible: true, x, y }; }); },
    hideContextMenu() { set(s => { s.contextMenu.visible = false; }); },

    // --------------------------------------------------------
    // Helpers
    // --------------------------------------------------------
    updateObject(type, id, updates) {
      const key = typeToKey[type];
      set(s => {
        const list = s.objects[key] as Array<Record<string, unknown>>;
        const idx = list.findIndex((o) => o.id === id);
        if (idx >= 0) Object.assign(list[idx], updates);
      });
    },

    addObject(type, obj) {
      const key = typeToKey[type];
      set(s => { (s.objects[key] as unknown[]).push(obj); });
    },

    getObjectsKey(type) { return typeToKey[type]; },
  }))
);
