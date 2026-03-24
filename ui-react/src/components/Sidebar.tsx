import { useUiStore, type UiState } from '@/store/ui';
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
        <div className="object-list-container">
          <div className="empty-list">Import mode — use the main panel</div>
        </div>
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

          <div className="object-list-container">
            <ObjectList
              type={sidebarObjectType}
              items={getObjectList(objects, sidebarObjectType)}
              activeTab={activeTab}
              onOpen={openObject}
            />
          </div>
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
