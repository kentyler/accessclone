// ============================================================
// Core Entities
// ============================================================

export interface Database {
  database_id: string;
  name: string;
  description?: string;
}

// ============================================================
// Object Lists (sidebar)
// ============================================================

export interface TableInfo {
  id: number;
  name: string;
  fields: ColumnInfo[];
  description?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  description?: string;
  indexed?: boolean;
  checkConstraint?: string;
  defaultValue?: string;
}

export interface QueryInfo {
  id: number;
  name: string;
  sql: string;
  fields: ColumnInfo[];
}

export interface FormListItem {
  id: number;
  name: string;
  filename: string;
  definition?: FormDefinition;
  record_source?: string;
}

export interface ReportListItem {
  id: number;
  name: string;
  filename: string;
  definition?: ReportDefinition;
  record_source?: string;
}

export interface ModuleListItem {
  id: number;
  name: string;
  filename: string;
}

export interface MacroListItem {
  id: number;
  name: string;
}

// ============================================================
// Control Types
// ============================================================

export type ControlType =
  | 'label'
  | 'text-box'
  | 'button'
  | 'command-button'
  | 'combo-box'
  | 'list-box'
  | 'check-box'
  | 'option-group'
  | 'option-button'
  | 'toggle-button'
  | 'tab-control'
  | 'page'
  | 'sub-form'
  | 'subform'
  | 'object-frame'
  | 'image'
  | 'attachment'
  | 'rectangle'
  | 'line'
  | 'page-break'
  | 'bound-object-frame'
  | 'unbound-object-frame';

// ============================================================
// Form Definitions
// ============================================================

export interface Control {
  name: string;
  type: ControlType;
  left: number;
  top: number;
  width: number;
  height: number;
  field?: string;
  'control-source'?: string;
  caption?: string;
  'default-value'?: string;
  'font-name'?: string;
  'font-size'?: number;
  'font-weight'?: number;
  'font-italic'?: number;
  'font-underline'?: number;
  'fore-color'?: number;
  'back-color'?: number;
  'back-style'?: number;
  'border-style'?: number;
  'border-color'?: number;
  'border-width'?: number;
  'text-align'?: number;
  'special-effect'?: number;
  visible?: number;
  enabled?: number;
  locked?: number;
  'tab-stop'?: number;
  'input-mask'?: string;
  'row-source'?: string;
  'row-source-type'?: string;
  'bound-column'?: number;
  'column-count'?: number;
  'column-widths'?: string;
  'list-rows'?: number;
  'limit-to-list'?: number;
  'multi-line'?: number;
  'scroll-bars'?: number;
  format?: string;
  'decimal-places'?: number;
  'computed-function'?: string;
  'computed-params'?: string[];
  // Event properties
  'on-click'?: string;
  'on-dbl-click'?: string;
  'on-enter'?: string;
  'on-exit'?: string;
  'on-got-focus'?: string;
  'on-lost-focus'?: string;
  'after-update'?: string;
  'before-update'?: string;
  'on-change'?: string;
  // Subform
  'source-object'?: string;
  'link-child-fields'?: string;
  'link-master-fields'?: string;
  // Tab control
  pages?: TabPage[];
  // Image
  picture?: string;
  'picture-type'?: number;
  'size-mode'?: number;
  // Misc
  'option-value'?: number;
  'triple-state'?: number;
  'auto-tab'?: number;
  [key: string]: unknown;
}

export interface TabPage {
  name: string;
  caption?: string;
  controls: Control[];
  [key: string]: unknown;
}

export interface Section {
  height: number;
  controls: Control[];
  visible?: number;
  'back-color'?: number;
  'special-effect'?: number;
  [key: string]: unknown;
}

export interface FormDefinition {
  name?: string;
  'record-source'?: string;
  'default-view'?: string;
  caption?: string;
  'navigation-buttons'?: number;
  'record-selectors'?: number;
  'dividing-lines'?: number;
  'scroll-bars'?: number;
  'control-box'?: number;
  'min-max-buttons'?: number;
  'close-button'?: number;
  'border-style'?: number;
  width?: number;
  popup?: number;
  modal?: number;
  'auto-center'?: number;
  'auto-resize'?: number;
  'allow-additions'?: number;
  'allow-deletions'?: number;
  'allow-edits'?: number;
  'data-entry'?: number;
  'order-by'?: string;
  filter?: string;
  'filter-on'?: number;
  'has-module'?: number;
  // Event properties
  'on-load'?: string;
  'on-current'?: string;
  'on-open'?: string;
  'on-close'?: string;
  'before-update'?: string;
  'after-update'?: string;
  'on-activate'?: string;
  'on-deactivate'?: string;
  // Sections
  header?: Section;
  detail?: Section;
  footer?: Section;
  // Grouping
  grouping?: GroupLevel[];
  [key: string]: unknown;
}

export interface GroupLevel {
  field?: string;
  'sort-order'?: string;
  'group-on'?: string;
  'group-interval'?: number;
  'keep-together'?: string;
}

// ============================================================
// Report Definitions
// ============================================================

export interface ReportDefinition {
  name?: string;
  'record-source'?: string;
  caption?: string;
  width?: number;
  // Event properties
  'on-open'?: string;
  'on-close'?: string;
  'on-no-data'?: string;
  // Standard bands
  'report-header'?: Section;
  'page-header'?: Section;
  detail?: Section;
  'page-footer'?: Section;
  'report-footer'?: Section;
  // Dynamic group bands (group-header-0, group-footer-0, etc.)
  // Grouping config
  grouping?: GroupLevel[];
  [key: string]: unknown;
}

// ============================================================
// Module / Macro detail
// ============================================================

export interface ModuleDetail {
  name: string;
  vba_source?: string;
  js_handlers?: Record<string, HandlerEntry>;
  intents?: unknown;
  status?: string;
  review_notes?: string;
  description?: string;
  version?: number;
  created_at?: string;
}

export interface HandlerEntry {
  key?: string;
  event: string;
  control?: string;
  procedure?: string;
  js?: string;
  confidence?: string;
  notes?: string;
}

export interface MacroDetail {
  name: string;
  macro_xml?: string;
  status?: string;
  review_notes?: string;
  description?: string;
  version?: number;
  created_at?: string;
}

// ============================================================
// Projection (form runtime binding)
// ============================================================

export interface Projection {
  fields: Record<string, FieldBinding>;
  record: Record<string, unknown> | null;
  records: Record<string, unknown>[];
  position: number;
  total: number;
  dirty: boolean;
  rowSources: Record<string, RowSourceData | 'loading'>;
  eventHandlers: Record<string, HandlerEntry>;
  fieldTriggers: Record<string, FieldTriggers>;
  computedFields: Record<string, ComputedField>;
  subforms: Record<string, SubformBinding>;
  syncedControls: Record<string, { tableName: string; columnName: string }>;
  controlState: Record<string, Record<string, unknown>>;
  subformSources?: Record<string, string>;
}

export interface FieldBinding {
  controlName: string;
  field: string;
  controlSource?: string;
  type: ControlType;
  value: unknown;
}

export interface FieldTriggers {
  hasEnterEvent?: boolean;
  hasExitEvent?: boolean;
  hasGotfocusEvent?: boolean;
  hasLostfocusEvent?: boolean;
  hasAfterUpdate?: boolean;
}

export interface ComputedField {
  fn: string;
  params: string[];
  alias: string;
}

export interface SubformBinding {
  sourceObject: string;
  linkChildFields: string;
  linkMasterFields: string;
}

export interface RowSourceData {
  rows: unknown[][];
  fields: ColumnInfo[];
}

// ============================================================
// Tabs
// ============================================================

export type ObjectType = 'tables' | 'queries' | 'forms' | 'reports' | 'modules' | 'macros' | 'graph';

// ============================================================
// Graph
// ============================================================

export interface GraphNode {
  id: string;
  node_type: string;
  name: string;
  database_id: string | null;
  scope: 'local' | 'global';
  origin: string | null;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from_id: string;
  to_id: string;
  rel_type: string;
  status: string | null;
  from_type?: string;
  from_name?: string;
  to_type?: string;
  to_name?: string;
}

export interface SubgraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TabDescriptor {
  type: ObjectType;
  id: number | string;
  name: string;
}

// ============================================================
// Chat
// ============================================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ============================================================
// Import
// ============================================================

export interface ImportStatus {
  phase: string;
  current: number;
  total?: number;
  imported: number;
  errors?: string[];
}

export interface ImportIssue {
  id: number;
  object_type: string;
  object_name: string;
  category: string;
  message: string;
  resolved: boolean;
  import_log_id?: number;
}

export interface ImportLogEntry {
  id: number;
  database_id: string;
  source_path: string;
  status: string;
  started_at: string;
  completed_at?: string;
  object_counts?: Record<string, number>;
}

// ============================================================
// Config
// ============================================================

export interface AppConfig {
  formDesigner: {
    gridSize: number;
  };
  capabilities?: Record<string, boolean>;
}

// ============================================================
// API Response wrapper
// ============================================================

export interface ApiResult<T> {
  ok: boolean;
  data: T;
  status: number;
}

// ============================================================
// Misc
// ============================================================

export type AppMode = 'run' | 'import' | 'logs';

export type ViewMode = 'design' | 'view' | 'preview' | 'datasheet' | 'results' | 'sql';

export type PropertyTab = 'format' | 'data' | 'event' | 'other' | 'all';

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
}

export interface RecordPosition {
  current: number;
  total: number;
}

export interface LogsFilter {
  objectType: string | null;
  status: string | null;
}
