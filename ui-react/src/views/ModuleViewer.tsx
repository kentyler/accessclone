import { useEffect, useState, useCallback } from 'react';
import { useUiStore } from '@/store/ui';
import * as api from '@/api/client';
import { filenameToDisplayName } from '@/lib/utils';

// ============================================================
// Types
// ============================================================

interface IntentStats {
  mechanical: number;
  llm_fallback: number;
  gap: number;
  total: number;
}

interface Intent {
  type: string;
  classification?: string;
  field?: string;
  form?: string;
  message?: string;
  table?: string;
  vba_line?: string;
  question?: string;
  gap_id?: string;
  suggestions?: string[];
  resolution?: { answer: string; custom_notes?: string };
  resolution_history?: Array<{ answer: string; custom_notes?: string; resolved_at: string }>;
  then?: Intent[];
  else?: Intent[];
  children?: Intent[];
}

interface Procedure {
  name: string;
  trigger?: string;
  intents: Intent[];
  stats: IntentStats;
}

interface IntentsData {
  intents: { procedures: Procedure[] };
  mapped: { procedures: Procedure[] };
  stats: IntentStats;
  gap_questions?: unknown[];
}

// ============================================================
// Constants
// ============================================================

const STATUS_OPTIONS = [
  ['pending', 'Pending'],
  ['translated', 'Translated'],
  ['needs-review', 'Needs Review'],
  ['complete', 'Complete'],
] as const;

// ============================================================
// Sub-components
// ============================================================

function ClassificationBadge({ classification }: { classification: string }) {
  const cls =
    classification === 'mechanical' ? 'badge-mechanical' :
    classification === 'llm-fallback' ? 'badge-llm' :
    classification === 'gap' ? 'badge-gap' : 'badge-unknown';
  return <span className={`intent-badge ${cls}`}>{classification}</span>;
}

function IntentItem({ intent }: { intent: Intent }) {
  return (
    <>
      <div className="intent-item">
        <span className="intent-type">{intent.type}</span>
        {intent.classification && <ClassificationBadge classification={intent.classification} />}
        {intent.field && <span className="intent-detail">field: {intent.field}</span>}
        {intent.form && <span className="intent-detail">form: {intent.form}</span>}
        {intent.message && (
          <span className="intent-detail">
            "{intent.message.length > 40 ? intent.message.slice(0, 40) + '...' : intent.message}"
          </span>
        )}
        {intent.table && <span className="intent-detail">table: {intent.table}</span>}
        {intent.type === 'gap' && intent.vba_line && (
          <span className="intent-detail">
            {intent.vba_line.length > 50 ? intent.vba_line.slice(0, 50) + '...' : intent.vba_line}
          </span>
        )}
      </div>
    </>
  );
}

function ProcedureSummary({ proc }: { proc: Procedure }) {
  const [expanded, setExpanded] = useState(false);
  const stats = proc.stats;

  return (
    <div className="procedure-summary">
      <div className="procedure-header" onClick={() => setExpanded(!expanded)}>
        <span className="expand-icon">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className="procedure-name">{proc.name}</span>
        {proc.trigger && <span className="procedure-trigger">({proc.trigger})</span>}
        <span className="procedure-stats">
          {(stats?.mechanical ?? 0) > 0 && <span className="stat-mechanical">{stats.mechanical} mech</span>}
          {(stats?.llm_fallback ?? 0) > 0 && <span className="stat-llm">{stats.llm_fallback} llm</span>}
          {(stats?.gap ?? 0) > 0 && <span className="stat-gap">{stats.gap} gap</span>}
        </span>
      </div>
      {expanded && (
        <div className="procedure-intents">
          {proc.intents.map((intent, i) => (
            <IntentItem key={i} intent={intent} />
          ))}
        </div>
      )}
    </div>
  );
}

function IntentSummaryPanel({ intentsData }: { intentsData: IntentsData }) {
  const stats = intentsData.stats;
  const procedures = intentsData.mapped?.procedures ?? [];

  return (
    <div className="intent-summary-panel">
      <div className="intent-summary-header">
        <strong>Intent Analysis</strong>
        <span className="intent-summary-stats">
          {intentsData.intents?.procedures?.length ?? 0} procedures, {stats?.total ?? 0} intents
        </span>
      </div>
      <div className="intent-stats-bar">
        {(stats?.mechanical ?? 0) > 0 && (
          <span className="stat-bar-mechanical">{stats.mechanical} mechanical</span>
        )}
        {(stats?.llm_fallback ?? 0) > 0 && (
          <span className="stat-bar-llm">{stats.llm_fallback} LLM-assisted</span>
        )}
        {(stats?.gap ?? 0) > 0 && (
          <span className="stat-bar-gap">{stats.gap} gaps</span>
        )}
      </div>
      <div className="intent-procedures">
        {procedures.map(proc => (
          <ProcedureSummary key={proc.name} proc={proc} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Main component
// ============================================================

interface Props {
  moduleName: string;
}

export default function ModuleViewer({ moduleName }: Props) {
  const { moduleViewer, loadModuleForViewing, objects, setModuleStatus, currentDatabase } = useUiStore();
  const { moduleInfo, loading } = moduleViewer;
  const [extracting, setExtracting] = useState(false);
  const [intentsData, setIntentsData] = useState<IntentsData | null>(null);

  useEffect(() => {
    const mod = objects.modules.find(m => m.name === moduleName);
    if (mod) loadModuleForViewing(mod);
    setIntentsData(null);
  }, [moduleName]);

  const handleStatusChange = useCallback(async (newStatus: string) => {
    if (!moduleInfo) return;
    setModuleStatus(newStatus);
    await api.put(`/api/modules/${encodeURIComponent(moduleInfo.name)}`, {
      status: newStatus,
      review_notes: moduleInfo.review_notes,
    });
  }, [moduleInfo, setModuleStatus]);

  const handleExtractIntents = useCallback(async () => {
    if (!moduleInfo?.vba_source) return;
    setExtracting(true);
    try {
      const appObjects = {
        forms: objects.forms.map(f => f.name),
        reports: objects.reports.map(r => r.name),
        tables: objects.tables.map(t => t.name),
        queries: objects.queries.map(q => q.name),
        modules: objects.modules.map(m => m.name),
        macros: objects.macros.map(m => m.name),
      };
      const res = await api.post<IntentsData>('/api/chat/extract-intents', {
        vba_source: moduleInfo.vba_source,
        module_name: moduleInfo.name,
        app_objects: appObjects,
        database_id: currentDatabase?.database_id,
      });
      if (res.ok) setIntentsData(res.data);
    } finally {
      setExtracting(false);
    }
  }, [moduleInfo, objects, currentDatabase]);

  if (loading) return <div className="loading-indicator">Loading module...</div>;
  if (!moduleInfo) return <div className="empty-viewer">Module not found</div>;

  const status = moduleInfo.status || 'pending';

  return (
    <div className="module-viewer">
      {/* Toolbar */}
      <div className="module-toolbar">
        <div className="toolbar-left">
          <span className="toolbar-label">
            {moduleInfo.vba_source ? 'VBA Module' : 'Module (Read-only)'}
          </span>
        </div>
      </div>

      {/* Info panel */}
      <div className="module-info-panel">
        <div className="info-row">
          <span className="info-label">Module:</span>
          <span className="info-value">{filenameToDisplayName(moduleName)}</span>
        </div>
        {moduleInfo.version != null && (
          <div className="info-row">
            <span className="info-label">Version:</span>
            <span className="info-value">v{moduleInfo.version}</span>
          </div>
        )}
        {moduleInfo.created_at && (
          <div className="info-row">
            <span className="info-label">Imported:</span>
            <span className="info-value">
              {new Date(moduleInfo.created_at).toLocaleDateString()}{' '}
              {new Date(moduleInfo.created_at).toLocaleTimeString()}
            </span>
          </div>
        )}
        <div className="info-row">
          <span className="info-label">Status:</span>
          <select
            className="status-select"
            value={status}
            onChange={e => handleStatusChange(e.target.value)}
          >
            {STATUS_OPTIONS.map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Intent summary (if extracted) */}
      {intentsData && <IntentSummaryPanel intentsData={intentsData} />}

      {/* Split view: VBA + JS handlers */}
      <div className="module-split">
        <div className="module-vba-panel">
          <div className="panel-header">
            <span>VBA Source</span>
            {moduleInfo.vba_source && (
              <div className="panel-actions">
                <button
                  className="btn-primary btn-sm"
                  onClick={handleExtractIntents}
                  disabled={extracting}
                >
                  {extracting ? 'Extracting...' : 'Extract Intents'}
                </button>
              </div>
            )}
          </div>
          <pre className="vba-source">{moduleInfo.vba_source || '(no VBA source)'}</pre>
        </div>

        <div className="module-js-panel">
          <div className="panel-header">JS Handlers</div>
          {moduleInfo.js_handlers && Object.keys(moduleInfo.js_handlers).length > 0 ? (
            <div className="handlers-list">
              {Object.entries(moduleInfo.js_handlers).map(([key, handler]) => (
                <div key={key} className="handler-entry">
                  <div className="handler-key">
                    <span className="handler-event">{handler.event}</span>
                    {handler.control && <span className="handler-control">{handler.control}</span>}
                    {handler.confidence && (
                      <span className={`confidence-badge ${handler.confidence}`}>{handler.confidence}</span>
                    )}
                  </div>
                  {handler.js && <pre className="handler-js">{handler.js}</pre>}
                  {handler.notes && <div className="handler-notes">{handler.notes}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-panel">No JS handlers generated</div>
          )}
        </div>
      </div>

      {moduleInfo.description && (
        <div className="module-description">
          <strong>Description:</strong> {moduleInfo.description}
        </div>
      )}
    </div>
  );
}
