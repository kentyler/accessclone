import { useState, useEffect, useMemo } from 'react';
import { useUiStore } from '@/store/ui';
import * as api from '@/api/client';

// ============================================================
// Types
// ============================================================

interface OverviewData {
  database_name: string;
  imported: Record<string, number>;
  source: Record<string, number>;
  completeness?: { has_discovery: boolean; complete: boolean; missing_count: number };
  translation_status?: { pending: number; draft: number; reviewed: number; approved: number };
  intent_stats?: { total: number; modules_with_intents: number; mechanical: number; llm_fallback: number; gap: number };
}

interface DependencyData {
  summary: Record<string, number>;
  form_bindings: Array<{ form: string; record_source: string; source_exists: boolean }>;
  report_bindings: Array<{ report: string; record_source: string; source_exists: boolean }>;
  module_form_refs: Array<{ module: string; forms: string[] }>;
  orphaned_tables: string[];
}

interface ApiSurfaceData {
  summary: { total_endpoints_needed: number; missing_tables: number };
  module_endpoints: Array<{ table: string; operations: string[]; modules: string[]; exists: boolean }>;
  form_data_needs: Array<{ table: string; source: string; exists: boolean }>;
}

type Pane = 'overview' | 'pipeline' | 'gaps' | 'deps' | 'api';

const PANE_TABS: Array<{ id: Pane; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'gaps', label: 'Gap Decisions' },
  { id: 'deps', label: 'Dependencies' },
  { id: 'api', label: 'API Surface' },
];

// ============================================================
// Overview pane
// ============================================================

function ProgressBar({ imported, total }: { imported: number; total: number }) {
  const pct = total > 0 ? Math.round((imported / total) * 100) : 0;
  return (
    <div className="progress-bar-container" style={{ background: '#eee', height: 8, borderRadius: 4, flex: 1 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#4caf50' : '#2196f3', borderRadius: 4 }} />
    </div>
  );
}

function StatusCard({ label, imported, total }: { label: string; imported: number; total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <span style={{ width: 80, fontWeight: 500 }}>{label}</span>
      <ProgressBar imported={imported} total={total} />
      <span style={{ width: 60, textAlign: 'right', fontSize: 12, color: '#666' }}>{imported}/{total}</span>
    </div>
  );
}

function OverviewPane({ data }: { data: OverviewData | null }) {
  const [designCheckRunning, setDesignCheckRunning] = useState(false);
  const [designCheckResults, setDesignCheckResults] = useState<Record<string, unknown> | null>(null);

  if (!data) return <div style={{ padding: 16, color: '#999' }}>Loading overview...</div>;

  const imported = data.imported ?? {};
  const source = data.source ?? {};
  const types = ['tables', 'queries', 'forms', 'reports', 'modules', 'macros'];

  const runDesignCheck = async () => {
    setDesignCheckRunning(true);
    const res = await api.post<Record<string, unknown>>('/api/design-check/run', {});
    if (res.ok) setDesignCheckResults(res.data);
    setDesignCheckRunning(false);
  };

  return (
    <div style={{ padding: 16 }}>
      <h3>{data.database_name || 'Database'}</h3>

      <div style={{ maxWidth: 400, marginBottom: 16 }}>
        {types.map(t => (
          <StatusCard key={t} label={t.charAt(0).toUpperCase() + t.slice(1)}
            imported={imported[t] || 0} total={source[t] || imported[t] || 0} />
        ))}
      </div>

      {data.translation_status && (
        <div style={{ marginBottom: 16, padding: 12, background: '#f5f5f5', borderRadius: 4 }}>
          <strong>Module Translation</strong>
          <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 13 }}>
            <span>Pending: {data.translation_status.pending}</span>
            <span>Draft: {data.translation_status.draft}</span>
            <span>Reviewed: {data.translation_status.reviewed}</span>
            <span>Approved: {data.translation_status.approved}</span>
          </div>
        </div>
      )}

      {data.intent_stats && (
        <div style={{ marginBottom: 16, padding: 12, background: '#f5f5f5', borderRadius: 4 }}>
          <strong>Intent Stats</strong>
          <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 13 }}>
            <span>Total: {data.intent_stats.total}</span>
            <span style={{ color: '#4caf50' }}>Mechanical: {data.intent_stats.mechanical}</span>
            <span style={{ color: '#ff9800' }}>LLM: {data.intent_stats.llm_fallback}</span>
            <span style={{ color: '#f44336' }}>Gap: {data.intent_stats.gap}</span>
          </div>
        </div>
      )}

      <button className="secondary-btn" disabled={designCheckRunning} onClick={runDesignCheck}>
        {designCheckRunning ? 'Running Design Check...' : 'Run Design Check'}
      </button>

      {designCheckResults && (
        <pre style={{ marginTop: 8, padding: 8, background: '#f5f5f5', fontSize: 12, maxHeight: 300, overflow: 'auto' }}>
          {JSON.stringify(designCheckResults, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ============================================================
// Dependencies pane
// ============================================================

function DependenciesPane({ data }: { data: DependencyData | null }) {
  if (!data) return <div style={{ padding: 16, color: '#999' }}>Click "Load" to fetch dependencies</div>;

  return (
    <div style={{ padding: 16, overflowY: 'auto' }}>
      <h4>Form Bindings</h4>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr><th>Form</th><th>Record Source</th><th>Exists</th></tr></thead>
        <tbody>
          {data.form_bindings.map((b, i) => (
            <tr key={i}>
              <td>{b.form}</td>
              <td>{b.record_source}</td>
              <td style={{ color: b.source_exists ? '#4caf50' : '#f44336' }}>{b.source_exists ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ marginTop: 16 }}>Report Bindings</h4>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr><th>Report</th><th>Record Source</th><th>Exists</th></tr></thead>
        <tbody>
          {data.report_bindings.map((b, i) => (
            <tr key={i}>
              <td>{b.report}</td>
              <td>{b.record_source}</td>
              <td style={{ color: b.source_exists ? '#4caf50' : '#f44336' }}>{b.source_exists ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.orphaned_tables.length > 0 && (
        <>
          <h4 style={{ marginTop: 16 }}>Orphaned Tables</h4>
          <ul>{data.orphaned_tables.map(t => <li key={t}>{t}</li>)}</ul>
        </>
      )}
    </div>
  );
}

// ============================================================
// API Surface pane
// ============================================================

function ApiSurfacePane({ data }: { data: ApiSurfaceData | null }) {
  if (!data) return <div style={{ padding: 16, color: '#999' }}>Click "Load" to analyze API surface</div>;

  return (
    <div style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ marginBottom: 16 }}>
        <strong>Endpoints needed:</strong> {data.summary.total_endpoints_needed}
        {data.summary.missing_tables > 0 && (
          <span style={{ color: '#f44336', marginLeft: 8 }}>({data.summary.missing_tables} missing tables)</span>
        )}
      </div>

      <h4>Module Data Endpoints</h4>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr><th>Table</th><th>Operations</th><th>Modules</th><th>Exists</th></tr></thead>
        <tbody>
          {data.module_endpoints.map((ep, i) => (
            <tr key={i}>
              <td>{ep.table}</td>
              <td>{ep.operations.join(', ')}</td>
              <td>{ep.modules.join(', ')}</td>
              <td style={{ color: ep.exists ? '#4caf50' : '#f44336' }}>{ep.exists ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ marginTop: 16 }}>Form Data Sources</h4>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr><th>Table</th><th>Source</th><th>Exists</th></tr></thead>
        <tbody>
          {data.form_data_needs.map((fd, i) => (
            <tr key={i}>
              <td>{fd.table}</td>
              <td>{fd.source}</td>
              <td style={{ color: fd.exists ? '#4caf50' : '#f44336' }}>{fd.exists ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// Pipeline pane (per-module tracking)
// ============================================================

function PipelinePane() {
  const modules = useUiStore(s => s.objects.modules);
  const [statuses, setStatuses] = useState<Record<string, { step: string; status: string }>>({});
  const [running, setRunning] = useState(false);

  const loadStatuses = async () => {
    const res = await api.get<Array<{ name: string; step: string; status: string }>>('/api/pipeline/status');
    if (res.ok && Array.isArray(res.data)) {
      const map: Record<string, { step: string; status: string }> = {};
      for (const m of res.data) map[m.name] = { step: m.step, status: m.status };
      setStatuses(map);
    }
  };

  useEffect(() => { loadStatuses(); }, []);

  const runAll = async () => {
    setRunning(true);
    await api.post('/api/pipeline/run', { all: true });
    await loadStatuses();
    setRunning(false);
  };

  return (
    <div style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
        <button className="primary-btn" disabled={running} onClick={runAll}>
          {running ? 'Running...' : 'Run All Modules'}
        </button>
        <button className="secondary-btn" onClick={loadStatuses}>Refresh</button>
      </div>

      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr><th>Module</th><th>Step</th><th>Status</th></tr></thead>
        <tbody>
          {modules.map(m => {
            const s = statuses[m.name];
            return (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td>{s?.step || '—'}</td>
                <td>{s?.status || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// Gap Decisions pane
// ============================================================

function GapDecisionsPane() {
  const [gaps, setGaps] = useState<Array<{
    module: string; procedure: string; question: string;
    suggestions: string[]; gap_id: string; selected: string | null;
  }> | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<unknown[]>('/api/app/gap-questions').then(res => {
      if (res.ok && Array.isArray(res.data)) {
        setGaps(res.data as typeof gaps extends null ? never : NonNullable<typeof gaps>);
      }
    });
  }, []);

  const handleSelect = (idx: number, suggestion: string) => {
    if (!gaps) return;
    const updated = [...gaps];
    updated[idx] = { ...updated[idx], selected: suggestion };
    setGaps(updated);
    // Fire-and-forget save
    api.put('/api/app/gap-questions', updated);
  };

  const submitAll = async () => {
    if (!gaps) return;
    setSubmitting(true);
    for (const gap of gaps) {
      if (gap.selected) {
        await api.post('/api/chat/resolve-gap', { gap_id: gap.gap_id, decision: gap.selected });
      }
    }
    setSubmitting(false);
  };

  if (!gaps) return <div style={{ padding: 16, color: '#999' }}>Loading gap questions...</div>;
  if (gaps.length === 0) return <div style={{ padding: 16, color: '#999' }}>No gap questions found. Extract intents first.</div>;

  return (
    <div style={{ padding: 16, overflowY: 'auto' }}>
      {gaps.map((gap, idx) => (
        <div key={gap.gap_id} style={{ marginBottom: 16, padding: 12, background: '#f9f9f9', borderRadius: 4 }}>
          <div style={{ fontSize: 12, color: '#666' }}>{gap.module} &gt; {gap.procedure}</div>
          <div style={{ fontWeight: 500, marginTop: 4 }}>{gap.question}</div>
          <div style={{ marginTop: 8 }}>
            {gap.suggestions.map(s => (
              <label key={s} style={{ display: 'block', marginBottom: 4, cursor: 'pointer' }}>
                <input type="radio" name={`gap-${gap.gap_id}`}
                  checked={gap.selected === s} onChange={() => handleSelect(idx, s)} />
                <span style={{ marginLeft: 4 }}>{s}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <button className="primary-btn" disabled={submitting} onClick={submitAll}>
        {submitting ? 'Submitting...' : 'Submit All Decisions'}
      </button>
    </div>
  );
}

// ============================================================
// Main App Viewer
// ============================================================

export default function AppViewer() {
  const [pane, setPane] = useState<Pane>('overview');
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [deps, setDeps] = useState<DependencyData | null>(null);
  const [apiSurface, setApiSurface] = useState<ApiSurfaceData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get<OverviewData>('/api/app/overview').then(res => {
      if (res.ok) setOverview(res.data);
      setLoading(false);
    });
  }, []);

  const loadDeps = async () => {
    setLoading(true);
    const res = await api.get<DependencyData>('/api/app/dependency-summary');
    if (res.ok) setDeps(res.data);
    setLoading(false);
  };

  const loadApiSurface = async () => {
    setLoading(true);
    const res = await api.get<ApiSurfaceData>('/api/app/api-surface');
    if (res.ok) setApiSurface(res.data);
    setLoading(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid #ddd', padding: '0 16px' }}>
        {PANE_TABS.map(tab => (
          <button
            key={tab.id}
            className={`toolbar-btn${pane === tab.id ? ' active' : ''}`}
            onClick={() => {
              setPane(tab.id);
              if (tab.id === 'deps' && !deps) loadDeps();
              if (tab.id === 'api' && !apiSurface) loadApiSurface();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && <div style={{ padding: 16, color: '#999' }}>Loading...</div>}

        {pane === 'overview' && <OverviewPane data={overview} />}
        {pane === 'pipeline' && <PipelinePane />}
        {pane === 'gaps' && <GapDecisionsPane />}
        {pane === 'deps' && <DependenciesPane data={deps} />}
        {pane === 'api' && <ApiSurfacePane data={apiSurface} />}
      </div>
    </div>
  );
}
