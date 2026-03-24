import { useEffect } from 'react';
import { useQueryStore } from '@/store/query';
import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';

interface Props {
  queryName: string;
}

export default function QueryViewer({ queryName }: Props) {
  const store = useQueryStore();
  const queries = useUiStore(s => s.objects.queries);

  useEffect(() => {
    const query = queries.find(q => q.name === queryName);
    if (query) store.loadQueryForViewing(query);
  }, [queryName]);

  const { queryInfo, sql, setSql, results, resultFields, viewMode, setViewMode, loading, error, runQuery } = store;

  return (
    <div className="query-viewer">
      <div className="viewer-toolbar">
        <h3>{filenameToDisplayName(queryName)}</h3>
        <div className="view-toggle">
          <button className={viewMode === 'results' ? 'active' : ''} onClick={() => setViewMode('results')}>
            Results
          </button>
          <button className={viewMode === 'sql' ? 'active' : ''} onClick={() => setViewMode('sql')}>
            SQL View
          </button>
        </div>
      </div>

      {viewMode === 'sql' && (
        <div className="sql-editor">
          <textarea
            className="sql-input"
            value={sql}
            onChange={e => setSql(e.target.value)}
            rows={8}
            spellCheck={false}
          />
          <div className="sql-actions">
            <button className="primary-btn" onClick={runQuery} disabled={loading}>
              {loading ? 'Running...' : 'Run'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="query-error">{error}</div>}

      {loading && <div className="loading-indicator">Executing query...</div>}

      {!loading && results.length > 0 && (
        <div className="query-results">
          <div className="results-count">{results.length} row{results.length !== 1 ? 's' : ''}</div>
          <table className="data-table">
            <thead>
              <tr>
                {resultFields.map(f => (
                  <th key={f.name}>{f.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((row, i) => (
                <tr key={i}>
                  {resultFields.map(f => (
                    <td key={f.name}>
                      {row[f.name] == null ? '' : String(row[f.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && results.length === 0 && !error && viewMode === 'results' && (
        <div className="empty-results">No results</div>
      )}
    </div>
  );
}
