import { useEffect, useCallback } from 'react';
import { useQueryStore, type QBETable, type QBEJoin, type QBEField, type QBEDesignData } from '@/store/query';
import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';
import ColumnDropdown from '@/components/ColumnDropdown';

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

  const { viewMode, setViewMode, loading, error } = store;

  return (
    <div className="query-viewer">
      <div className="viewer-toolbar">
        <h3>{filenameToDisplayName(queryName)}</h3>
        <div className="view-toggle">
          <button className={viewMode === 'results' ? 'active' : ''} onClick={() => setViewMode('results')}>
            Results
          </button>
          <button className={viewMode === 'design' ? 'active' : ''} onClick={() => setViewMode('design')}>
            Design
          </button>
          <button className={viewMode === 'sql' ? 'active' : ''} onClick={() => setViewMode('sql')}>
            SQL View
          </button>
        </div>
      </div>

      {error && <div className="query-error">{error}</div>}
      {loading && <div className="loading-indicator">Executing query...</div>}

      {viewMode === 'results' && <ResultsView />}
      {viewMode === 'design' && <DesignView />}
      {viewMode === 'sql' && <SqlView />}
    </div>
  );
}

// ============================================================
// Results View (Datasheet with sort/filter)
// ============================================================

function ResultsView() {
  const store = useQueryStore();
  const { results, resultFields, sortColumn, sortDirection, filters, activeFilterColumn, loading } = store;
  const filteredResults = store.getFilteredResults();

  const toggleDropdown = useCallback((col: string, e: React.MouseEvent) => {
    e.stopPropagation();
    store.setActiveFilterColumn(activeFilterColumn === col ? null : col);
  }, [activeFilterColumn]);

  if (!loading && results.length === 0) {
    return <div className="empty-results">No results</div>;
  }

  return (
    <div className="query-results-view">
      <div className="results-count">{filteredResults.length} row{filteredResults.length !== 1 ? 's' : ''}</div>
      <div className="datasheet">
        <table className="data-table">
          <thead>
            <tr>
              {resultFields.map(f => {
                const isSorted = sortColumn === f.name;
                const isFiltered = !!(filters[f.name] && filters[f.name].length > 0);
                return (
                  <th key={f.name} className={isFiltered ? 'filtered-col' : ''}>
                    <div className="column-header" onClick={e => toggleDropdown(f.name, e)}>
                      <span className="column-header-name">
                        {f.name}
                        {isSorted && <span className="sort-indicator">{sortDirection === 'asc' ? ' \u2191' : ' \u2193'}</span>}
                        {isFiltered && <span className="filter-indicator">{' \u0192'}</span>}
                      </span>
                      <span className="column-header-arrow">{'\u25BC'}</span>
                    </div>
                    {activeFilterColumn === f.name && (
                      <ColumnDropdown
                        column={f.name}
                        records={results}
                        currentExcluded={filters[f.name] || []}
                        onSort={(col, dir) => store.sortBy(col, dir)}
                        onSetFilter={(col, excl) => store.setFilter(col, excl)}
                        onClearFilter={(col) => store.clearFilter(col)}
                        onClose={() => store.setActiveFilterColumn(null)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredResults.map((row, i) => (
              <tr key={i}>
                {resultFields.map(f => (
                  <td key={f.name}>
                    <span className="cell-value">{row[f.name] == null ? '' : String(row[f.name])}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {Object.keys(filters).length > 0 && (
        <div className="filter-status-bar">
          Filtered: {filteredResults.length} of {results.length} records
          <button className="clear-all-filters-btn" onClick={() => store.clearFilter()}>Clear All Filters</button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Design View (QBE)
// ============================================================

function DesignView() {
  const { designData, designLoading } = useQueryStore();

  if (designLoading) {
    return <div className="query-design-view"><div className="loading-indicator">Loading design...</div></div>;
  }

  if (!designData || !designData.parseable) {
    return (
      <div className="query-design-view">
        <div className="qbe-unparseable">
          <p>Cannot display this query in Design View.</p>
          <p>This query uses CTEs, UNIONs, or other advanced SQL features that the visual designer cannot represent.</p>
          <p>Use SQL View to view and edit the query text.</p>
        </div>
      </div>
    );
  }

  const { tables = [], joins = [], fields = [], where, groupBy, orderBy } = designData;

  return (
    <div className="query-design-view">
      <div className="query-design-upper">
        <QBECanvas tables={tables} joins={joins} fields={fields} />
      </div>
      <div className="query-design-lower">
        <QBEGrid fields={fields} where={where} groupBy={groupBy} />
      </div>
    </div>
  );
}

function QBECanvas({ tables, joins, fields }: { tables: QBETable[]; joins: QBEJoin[]; fields: QBEField[] }) {
  // Build set of selected columns per table (from the fields list)
  const selectedCols: Record<string, Set<string>> = {};
  for (const f of fields) {
    if (f.table) {
      if (!selectedCols[f.table]) selectedCols[f.table] = new Set();
      // Extract column name from expression (may be "table.col" or just "col")
      const dotIdx = f.expression.lastIndexOf('.');
      const colName = dotIdx >= 0 ? f.expression.substring(dotIdx + 1).replace(/"/g, '') : f.expression.replace(/"/g, '');
      selectedCols[f.table].add(colName.toLowerCase());
    }
  }

  // Compute layout positions for table boxes
  const BOX_WIDTH = 180;
  const BOX_GAP = 40;
  const tablePositions: Record<string, { x: number; y: number }> = {};
  tables.forEach((t, i) => {
    tablePositions[t.name] = { x: 16 + i * (BOX_WIDTH + BOX_GAP), y: 16 };
  });

  return (
    <div className="qbe-canvas" style={{ position: 'relative', minWidth: tables.length * (BOX_WIDTH + BOX_GAP) + 16 }}>
      {/* SVG overlay for join lines */}
      {joins.length > 0 && (
        <svg className="qbe-join-svg" style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%', pointerEvents: 'none',
        }}>
          {joins.map((join, i) => {
            const leftPos = tablePositions[join.leftTable];
            const rightPos = tablePositions[join.rightTable];
            if (!leftPos || !rightPos) return null;

            // Find column index for y offset
            const leftTable = tables.find(t => t.name === join.leftTable);
            const rightTable = tables.find(t => t.name === join.rightTable);
            const leftColIdx = leftTable?.columns?.indexOf(join.leftColumn) ?? 0;
            const rightColIdx = rightTable?.columns?.indexOf(join.rightColumn) ?? 0;

            const x1 = leftPos.x + BOX_WIDTH;
            const y1 = leftPos.y + 30 + (leftColIdx >= 0 ? leftColIdx : 0) * 24 + 12;
            const x2 = rightPos.x;
            const y2 = rightPos.y + 30 + (rightColIdx >= 0 ? rightColIdx : 0) * 24 + 12;

            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--gray-400)" strokeWidth="1.5" />
                <text className="qbe-join-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle">
                  {join.type === 'INNER JOIN' ? '' : join.type.replace(' JOIN', '')}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      <div className="qbe-table-row">
        {tables.map(t => {
          const selected = selectedCols[t.name] || new Set();
          return (
            <div key={t.name} className="qbe-table-box">
              <div className="qbe-table-title">{t.alias ? `${t.name} (${t.alias})` : t.name}</div>
              <div className="qbe-table-columns">
                {t.columns && t.columns.length > 0 ? (
                  t.columns.map(col => (
                    <div
                      key={col}
                      className={`qbe-table-column${selected.has(col.toLowerCase()) ? ' qbe-col-selected' : ''}`}
                    >
                      {col}
                    </div>
                  ))
                ) : (
                  <div className="qbe-table-column qbe-col-empty">No columns loaded</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QBEGrid({ fields, where, groupBy }: {
  fields: QBEField[];
  where?: string | null;
  groupBy?: string[] | null;
}) {
  // Determine display name for each field
  const displayFields = fields.map(f => {
    const dotIdx = f.expression.lastIndexOf('.');
    const colName = dotIdx >= 0 ? f.expression.substring(dotIdx + 1).replace(/"/g, '') : f.expression.replace(/"/g, '');
    const displayName = f.alias ? `${f.alias}: ${colName}` : colName;
    return { ...f, displayName, colName };
  });

  return (
    <div className="qbe-grid-container">
      <table className="qbe-grid">
        <thead>
          <tr>
            <th>Field</th>
            <th>Table</th>
            {groupBy && <th>Group By</th>}
            <th>Sort</th>
            <th>Show</th>
            <th>Criteria</th>
          </tr>
        </thead>
        <tbody>
          {displayFields.map((f, i) => (
            <tr key={i}>
              <td className="qbe-field-cell">{f.displayName}</td>
              <td className="qbe-table-cell">{f.table || ''}</td>
              {groupBy && (
                <td className="qbe-table-cell">
                  {groupBy.some(g => {
                    const gLower = g.toLowerCase().replace(/"/g, '');
                    return gLower === f.colName.toLowerCase() || gLower === f.expression.toLowerCase().replace(/"/g, '');
                  }) ? 'Group By' : ''}
                </td>
              )}
              <td className="qbe-sort-cell">{f.sort === 'ASC' ? 'Ascending' : f.sort === 'DESC' ? 'Descending' : ''}</td>
              <td className="qbe-show-cell">{f.show ? <span className="qbe-checkmark">{'\u2713'}</span> : ''}</td>
              <td className="qbe-criteria-cell"></td>
            </tr>
          ))}
          {where && (
            <tr className="qbe-criteria-row">
              <td colSpan={groupBy ? 6 : 5}>
                <span className="qbe-criteria-label">WHERE: </span>
                <span className="qbe-criteria-text">{where}</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// SQL View
// ============================================================

function SqlView() {
  const { sql, setSql, runQuery, loading } = useQueryStore();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runQuery();
    }
  };

  return (
    <div className="query-sql-view">
      <div className="sql-editor-container">
        <textarea
          className="sql-editor"
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={8}
          spellCheck={false}
          placeholder="Enter SQL query..."
        />
      </div>
      <div className="sql-toolbar">
        <button className="primary-btn" onClick={runQuery} disabled={loading}>
          {loading ? 'Running...' : 'Run'}
        </button>
        <span className="hint">Ctrl+Enter to run</span>
      </div>
    </div>
  );
}
