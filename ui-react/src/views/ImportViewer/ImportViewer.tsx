import { useEffect, useMemo } from 'react';
import { useImportStore, ObjectType, SourceItem } from '@/store/import';

// ============================================================
// Helpers
// ============================================================

function sanitizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

const OBJECT_TYPES: ObjectType[] = ['tables', 'forms', 'reports', 'modules', 'queries', 'macros'];

const TYPE_LABELS: Record<ObjectType, string> = {
  tables: 'Tables',
  queries: 'Queries',
  forms: 'Forms',
  reports: 'Reports',
  modules: 'Modules',
  macros: 'Macros',
};

// ============================================================
// Source database list (left sidebar)
// ============================================================

function SourceDatabasesList() {
  const store = useImportStore();

  if (store.selectedPaths.length === 0) return null;

  return (
    <div className="import-source-panel">
      <div className="panel-header">Selected Sources</div>
      <div className="source-db-list">
        {store.selectedPaths.map((path: string) => {
          const isActive = store.activePath === path;
          const filename = path.split(/[/\\]/).pop() || path;
          return (
            <div
              key={path}
              className={`source-db-item${isActive ? ' active' : ''}`}
              onClick={() => store.setActivePath(path)}
              title={path}
            >
              <span className="source-db-name">{filename}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Phase tracker (horizontal type buttons with progress)
// ============================================================

function PhaseTracker() {
  const store = useImportStore();

  // Compute per-type progress
  const progress = useMemo(() => {
    const result: Record<ObjectType, { total: number; imported: number }> = {} as Record<ObjectType, { total: number; imported: number }>;
    for (const type of OBJECT_TYPES) {
      const items = getItemsForType(store.cache, store.selectedPaths, type);
      const existing = store.targetExisting[type];
      const imported = items.filter(i => existing.has(sanitizeName(i.name))).length;
      result[type] = { total: items.length, imported };
    }
    return result;
  }, [store.cache, store.selectedPaths, store.targetExisting]);

  return (
    <div className="import-phase-tracker">
      {OBJECT_TYPES.map(type => {
        const p = progress[type];
        const active = store.objectType === type;
        const complete = p.total > 0 && p.imported === p.total;
        return (
          <button
            key={type}
            className={`phase-btn${active ? ' active' : ''}${complete ? ' complete' : ''}`}
            onClick={() => store.setObjectType(type)}
          >
            {TYPE_LABELS[type]}
            {p.total > 0 && (
              <span className="phase-count">{p.imported}/{p.total}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function getItemsForType(
  cache: Record<string, Record<ObjectType, SourceItem[]>>,
  selectedPaths: string[],
  type: ObjectType,
): SourceItem[] {
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

// ============================================================
// Object list with checkboxes
// ============================================================

function ObjectList() {
  const store = useImportStore();
  const items = useMemo(
    () => getItemsForType(store.cache, store.selectedPaths, store.objectType),
    [store.cache, store.selectedPaths, store.objectType],
  );
  const existing = store.targetExisting[store.objectType];

  return (
    <div className="import-object-list" style={{ flex: 1, overflowY: 'auto' }}>
      {items.length === 0 ? (
        <div style={{ padding: 16, color: '#999' }}>No {TYPE_LABELS[store.objectType]} found in source database</div>
      ) : (
        items.map(item => {
          const isImported = existing.has(sanitizeName(item.name));
          const isChecked = store.selected.has(item.name);
          return (
            <div key={item.name} className={`import-item${isImported ? ' imported' : ''}`}>
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => store.toggleSelection(item.name)}
              />
              <span className="import-item-name">{item.name}</span>
              {isImported && <span className="badge imported-badge">imported</span>}
              {item.fields != null && <span className="item-detail">{item.fields} fields</span>}
              {item.rows != null && <span className="item-detail">{item.rows} rows</span>}
              {item.lines != null && <span className="item-detail">{item.lines} lines</span>}
              {item.type && <span className="item-detail">{item.type}</span>}
            </div>
          );
        })
      )}
    </div>
  );
}

// ============================================================
// Toolbar
// ============================================================

function ImportToolbar() {
  const store = useImportStore();
  const selectedCount = store.selected.size;

  return (
    <div className="import-toolbar">
      <button className="toolbar-btn" onClick={() => store.selectAll()}>Select All</button>
      <button className="toolbar-btn" onClick={() => store.selectNone()}>Select None</button>
      <span className="toolbar-spacer" />
      <span style={{ color: '#666', fontSize: 12 }}>{selectedCount} selected</span>
      <button
        className="primary-btn"
        disabled={selectedCount === 0 || store.importing}
        onClick={() => store.importSelected()}
      >
        Import {selectedCount} {TYPE_LABELS[store.objectType]}
      </button>
    </div>
  );
}

// ============================================================
// Import All progress
// ============================================================

function ImportAllProgress() {
  const status = useImportStore(s => s.importAllStatus);
  const phase = useImportStore(s => s.autoImportPhase);
  const importing = useImportStore(s => s.importing);

  if (!status && !phase) return null;

  return (
    <div className="import-all-progress">
      {importing && status && (
        <div className="progress-info">
          <div className="progress-phase">
            Phase: <strong>{status.phase}</strong>
            {status.current && ` — ${status.current}`}
          </div>
          <div className="progress-bar-container">
            <div
              className="progress-bar-fill"
              style={{ width: status.total > 0 ? `${(status.imported / status.total) * 100}%` : '0%' }}
            />
          </div>
          <div className="progress-counts">{status.imported} / {status.total}</div>
        </div>
      )}
      {phase === 'translating' && (
        <div className="progress-info">
          <div className="progress-phase">Post-import pipeline: translating modules, resolving expressions...</div>
        </div>
      )}
      {phase === 'complete' && !importing && (
        <div className="progress-info complete">
          <div className="progress-phase">Import complete</div>
          {status?.failed && status.failed.length > 0 && (
            <div className="progress-failures">
              {status.failed.length} failures:
              <ul>
                {status.failed.map((f, i) => (
                  <li key={i}>{f.name}: {f.error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Import log sidebar
// ============================================================

function ImportLogPanel() {
  const importLog = useImportStore(s => s.importLog);

  if (!importLog.length) return null;

  return (
    <div className="import-log-panel">
      <div className="panel-header">Import History</div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {importLog.slice(0, 50).map((entry, idx) => (
          <div key={idx} className="log-entry">
            <span className={`log-status ${entry.status}`}>{String(entry.status)}</span>
            <span className="log-type">{String(entry.object_type || '')}</span>
            <span className="log-name">{String(entry.object_name || '')}</span>
            {entry.error_message ? (
              <span className="log-error">{String(entry.error_message)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Main Import Viewer
// ============================================================

export default function ImportViewer() {
  const store = useImportStore();
  const hasSelection = store.selectedPaths.length > 0;

  useEffect(() => {
    store.loadTargetExisting();
    store.loadImportLog();
  }, []);

  return (
    <div className="import-viewer" style={{ display: 'flex', height: '100%' }}>
      {/* Left: source databases */}
      <div style={{ width: 240, borderRight: '1px solid #ddd', display: 'flex', flexDirection: 'column' }}>
        <SourceDatabasesList />
      </div>

      {/* Center: main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!hasSelection ? (
          <div style={{ padding: 32, color: '#999', textAlign: 'center' }}>
            <h3>Import Pipeline</h3>
            <p>Select one or more Access databases from the left panel to begin.</p>
          </div>
        ) : (
          <>
            {/* Auto-import button */}
            <div style={{ padding: '8px 16px', borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="primary-btn"
                disabled={store.importing}
                onClick={() => store.importAll()}
              >
                Auto-Import All
              </button>
              <button
                className="secondary-btn"
                disabled={store.importing}
                onClick={() => store.importAll(true)}
              >
                Force Re-Import
              </button>
              {store.loading && <span style={{ color: '#999' }}>Loading...</span>}
            </div>

            <ImportAllProgress />

            <PhaseTracker />

            <ImportToolbar />

            <ObjectList />
          </>
        )}
      </div>

      {/* Right: import log */}
      <div style={{ width: 280, borderLeft: '1px solid #ddd', display: 'flex', flexDirection: 'column' }}>
        <ImportLogPanel />
      </div>
    </div>
  );
}
