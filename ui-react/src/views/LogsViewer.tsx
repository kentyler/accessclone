import { useUiStore } from '@/store/ui';

export default function LogsViewer() {
  const { logsIssues, logsSelectedEntry, toggleIssueResolved, logsFilter, setLogsFilter } = useUiStore();

  // Filter issues
  let filtered = logsIssues;
  if (logsFilter.objectType) {
    filtered = filtered.filter(i => i.object_type === logsFilter.objectType);
  }
  if (logsFilter.status === 'unresolved') {
    filtered = filtered.filter(i => !i.resolved);
  }

  return (
    <div className="logs-viewer">
      <div className="viewer-toolbar">
        <h3>{logsSelectedEntry ? `Import: ${logsSelectedEntry.source_path?.split(/[/\\]/).pop()}` : 'All Issues'}</h3>
        <div className="logs-filter-bar">
          <select
            value={logsFilter.objectType || ''}
            onChange={e => setLogsFilter('objectType', e.target.value || null)}
          >
            <option value="">All Types</option>
            <option value="form">Forms</option>
            <option value="report">Reports</option>
            <option value="query">Queries</option>
            <option value="table">Tables</option>
            <option value="module">Modules</option>
            <option value="macro">Macros</option>
          </select>
          <label className="logs-issues-toggle">
            <input
              type="checkbox"
              checked={logsFilter.status === 'unresolved'}
              onChange={e => setLogsFilter('status', e.target.checked ? 'unresolved' : null)}
            />
            Unresolved only
          </label>
        </div>
      </div>

      <div className="issues-list">
        {filtered.length === 0 && <div className="empty-list">No issues found</div>}
        {filtered.map(issue => (
          <div key={issue.id} className={`issue-item${issue.resolved ? ' resolved' : ''}`}>
            <div className="issue-header">
              <span className="issue-type">{issue.object_type}</span>
              <span className="issue-name">{issue.object_name}</span>
              <span className={`issue-category ${issue.category}`}>{issue.category}</span>
            </div>
            <div className="issue-message">{issue.message}</div>
            <button
              className="btn-sm"
              onClick={() => toggleIssueResolved(issue.id, issue.resolved)}
            >
              {issue.resolved ? 'Unresolve' : 'Resolve'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
