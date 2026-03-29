import { useState } from 'react';
import { useUiStore, type UiState } from '@/store/ui';
import { useImportStore } from '@/store/import';
import type { ObjectType, TabDescriptor, ImportLogEntry } from '@/api/types';
import { filenameToDisplayName } from '@/lib/utils';

const OBJECT_TYPES: { key: ObjectType; label: string }[] = [
  { key: 'tables', label: 'Tables' },
  { key: 'queries', label: 'Queries' },
  { key: 'forms', label: 'Forms' },
  { key: 'reports', label: 'Reports' },
  { key: 'modules', label: 'Modules' },
  { key: 'macros', label: 'Macros' },
  { key: 'sql-functions', label: 'Functions' },
  { key: 'graph', label: 'Graph' },
];

export default function Sidebar() {
  const {
    sidebarCollapsed, toggleSidebar, appMode,
    sidebarObjectType, setSidebarObjectType,
    objects, activeTab, openObject,
    logsEntries, logsSelectedEntry, logsLoading, selectLogEntry,
  } = useUiStore();

  return (
    <div className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        <button className="collapse-toggle" onClick={toggleSidebar}>
          {sidebarCollapsed ? '>' : '<'}
        </button>
        {!sidebarCollapsed && <span className="sidebar-title">Objects</span>}
      </div>

      {!sidebarCollapsed && appMode === 'logs' && (
        <LogsSidebar
          entries={logsEntries}
          selected={logsSelectedEntry}
          loading={logsLoading}
          onSelect={selectLogEntry}
        />
      )}

      {!sidebarCollapsed && appMode === 'import' && (
        <ImportSidebar />
      )}

      {!sidebarCollapsed && appMode === 'run' && (
        <>
          <div className="object-type-selector">
            <select
              value={sidebarObjectType}
              onChange={e => setSidebarObjectType(e.target.value as ObjectType)}
            >
              {OBJECT_TYPES.map(t => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>

          {sidebarObjectType === 'graph' ? (
            <GraphLegend />
          ) : (
            <div className="object-list-container">
              <ObjectList
                type={sidebarObjectType}
                items={getObjectList(objects, sidebarObjectType)}
                activeTab={activeTab}
                onOpen={openObject}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function getObjectList(
  objects: UiState['objects'],
  type: ObjectType,
): Array<{ id: number | string; name: string }> {
  switch (type) {
    case 'tables': return objects.tables.map(t => ({ id: t.id ?? t.name, name: t.name }));
    case 'queries': return objects.queries.map(q => ({ id: q.id ?? q.name, name: q.name }));
    case 'forms': return objects.forms.map(f => ({ id: f.id, name: f.name }));
    case 'reports': return objects.reports.map(r => ({ id: r.id, name: r.name }));
    case 'modules': return objects.modules.map(m => ({ id: m.id, name: m.name }));
    case 'macros': return objects.macros.map(m => ({ id: m.id, name: m.name }));
    case 'sql-functions': return objects.sqlFunctions.map(f => ({ id: f.id, name: f.name }));
    case 'graph': return [];
  }
}

function ObjectList({ type, items, activeTab, onOpen }: {
  type: ObjectType;
  items: Array<{ id: number | string; name: string }>;
  activeTab: TabDescriptor | null;
  onOpen: (type: ObjectType, id: number | string, name: string) => void;
}) {
  if (items.length === 0) {
    return <div className="empty-list">No {type} found</div>;
  }

  return (
    <ul className="object-list">
      {items.map(item => {
        const isActive = activeTab?.type === type && activeTab?.id === item.id;
        return (
          <li
            key={`${type}-${item.id}`}
            className={`object-item${isActive ? ' active' : ''}`}
            onClick={() => onOpen(type, item.id, item.name)}
          >
            <span className="object-name">
              {filenameToDisplayName(item.name)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ImportSidebar() {
  const store = useImportStore();
  const [pathInput, setPathInput] = useState('');

  const handleGo = () => {
    const path = pathInput.trim();
    if (!path) return;
    // If it looks like a file path (.accdb/.mdb), add it directly
    if (/\.(accdb|mdb)$/i.test(path)) {
      store.toggleDatabaseSelection(path);
    } else {
      // Treat as folder — scan it
      store.scanForDatabases(path);
    }
    setPathInput('');
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <div className="object-list-container" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div className="sidebar-section-label" style={{ padding: '8px 8px 4px', fontWeight: 600, fontSize: 11, color: '#666' }}>
        Access Databases
      </div>

      {/* Path input */}
      <div style={{ padding: '0 8px 4px', display: 'flex', gap: 4 }}>
        <input
          type="text"
          className="text-input"
          placeholder="Folder or file path"
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleGo(); }}
          style={{ flex: 1, fontSize: 11, padding: '3px 6px' }}
        />
        <button className="secondary-btn" onClick={handleGo} style={{ fontSize: 11, padding: '3px 8px' }}>Go</button>
      </div>

      {/* Scan buttons */}
      <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          className="secondary-btn"
          onClick={() => store.scanForDatabases()}
          disabled={store.loading}
          style={{ fontSize: 11, width: '100%' }}
        >
          {store.loading ? 'Scanning...' : 'Scan Desktop & Documents'}
        </button>
      </div>

      {/* Scanned results */}
      {store.scannedDatabases.length > 0 && (
        <>
          <div style={{ padding: '4px 8px', fontSize: 10, color: '#999', borderTop: '1px solid #eee' }}>
            Found {store.scannedDatabases.length} database(s)
          </div>
          <ul className="object-list" style={{ flex: 1, overflowY: 'auto' }}>
            {store.scannedDatabases.map(db => {
              const isSelected = store.selectedPaths.includes(db.path);
              return (
                <li
                  key={db.path}
                  className={`object-item${isSelected ? ' active' : ''}`}
                  onClick={() => store.toggleDatabaseSelection(db.path)}
                  title={db.path}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => store.toggleDatabaseSelection(db.path)}
                    onClick={e => e.stopPropagation()}
                    style={{ marginRight: 4 }}
                  />
                  <span className="object-name" style={{ fontSize: 11 }}>
                    {db.path.split(/[/\\]/).pop()}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: '#999' }}>
                    {formatSize(db.size)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Already-selected databases (not from scan) */}
      {store.selectedPaths.length > 0 && store.scannedDatabases.length === 0 && (
        <ul className="object-list">
          {store.selectedPaths.map(path => (
            <li key={path} className="object-item active" title={path}>
              <span className="object-name" style={{ fontSize: 11 }}>
                {path.split(/[/\\]/).pop()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const LEGEND_NODES = [
  { type: 'table', color: '#3b82f6', label: 'Table' },
  { type: 'column', color: '#93c5fd', label: 'Column' },
  { type: 'form', color: '#22c55e', label: 'Form' },
  { type: 'control', color: '#86efac', label: 'Control' },
  { type: 'potential', color: '#f97316', label: 'Potential' },
  { type: 'capability', color: '#a855f7', label: 'Capability' },
];

const LEGEND_EDGES = [
  { type: 'contains', color: '#9ca3af', style: 'solid', label: 'Contains' },
  { type: 'references', color: '#3b82f6', style: 'dashed', label: 'References' },
  { type: 'bound_to', color: '#22c55e', style: 'solid', label: 'Bound To' },
  { type: 'serves', color: '#f97316', style: 'dotted', label: 'Serves' },
  { type: 'actualizes', color: '#a855f7', style: 'dashed', label: 'Actualizes' },
];

function GraphLegend() {
  return (
    <div className="object-list-container" style={{ padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: '#666' }}>Node Types</div>
      {LEGEND_NODES.map(n => (
        <div key={n.type} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            width: 12, height: 12, borderRadius: n.type === 'potential' ? 0 : 3,
            background: n.color, display: 'inline-block',
            transform: n.type === 'potential' ? 'rotate(45deg) scale(0.8)' : undefined,
          }} />
          <span style={{ fontSize: 11 }}>{n.label}</span>
        </div>
      ))}
      <div style={{ fontSize: 11, fontWeight: 600, margin: '12px 0 8px', color: '#666' }}>Edge Types</div>
      {LEGEND_EDGES.map(e => (
        <div key={e.type} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            width: 24, height: 0, borderTop: `2px ${e.style} ${e.color}`, display: 'inline-block',
          }} />
          <span style={{ fontSize: 11 }}>{e.label}</span>
        </div>
      ))}
    </div>
  );
}

function LogsSidebar({ entries, selected, loading, onSelect }: {
  entries: ImportLogEntry[];
  selected: ImportLogEntry | null;
  loading: boolean;
  onSelect: (entry: ImportLogEntry | null) => void;
}) {
  if (loading) return <div className="logs-loading">Loading log entries...</div>;

  return (
    <div className="object-list-container">
      <ul className="object-list">
        <li
          className={`log-entry-item${!selected ? ' selected' : ''}`}
          onClick={() => onSelect(null)}
        >
          <span className="log-entry-name">All Issues</span>
        </li>
        {entries.map(entry => (
          <li
            key={entry.id}
            className={`log-entry-item${selected?.id === entry.id ? ' selected' : ''}`}
            onClick={() => onSelect(entry)}
          >
            <span className="log-entry-name">{entry.source_path?.split(/[/\\]/).pop() || 'Import'}</span>
            <div className="log-entry-meta">
              <span className={`status-badge ${entry.status}`}>{entry.status}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
