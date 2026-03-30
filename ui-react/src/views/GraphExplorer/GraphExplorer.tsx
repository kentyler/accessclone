import { useEffect, useRef } from 'react';
import { useUiStore } from '@/store/ui';
import { useGraphStore } from '@/store/graph';
import * as api from '@/api/client';
import GraphCanvas from './GraphCanvas';
import DetailPanel from './DetailPanel';

export default function GraphExplorer() {
  const { currentDatabase } = useUiStore();
  const {
    loading, error, nodes, searchQuery, searchResults,
    visibleLayers, loadSubgraph, searchNodes, toggleLayer, selectNode, reset,
  } = useGraphStore();
  const initialLoad = useRef(false);

  const databaseId = currentDatabase?.database_id;

  // Load subgraph on mount
  useEffect(() => {
    if (!databaseId || initialLoad.current) return;
    initialLoad.current = true;
    loadSubgraph(databaseId);
    return () => { reset(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId]);

  const handlePopulate = async () => {
    await api.post('/api/graph/populate');
    if (databaseId) loadSubgraph(databaseId);
  };

  const handleFit = () => {
    const container = document.querySelector('.graph-canvas-container');
    if (container) {
      // Access cytoscape instance from the DOM element
      const cy = (container as any)?._cy;
      if (cy) cy.fit(undefined, 30);
    }
  };

  const handleResetLayout = () => {
    const container = document.querySelector('.graph-canvas-container');
    const cy = (container as any)?._cy;
    if (cy) {
      cy.layout({
        name: 'cose',
        animate: true,
        animationDuration: 500,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 80,
        numIter: 300,
        padding: 30,
      }).run();
    }
  };

  const handleSearchSelect = (nodeId: string) => {
    selectNode(nodeId);
    searchNodes('');
  };

  if (loading) {
    return (
      <div className="graph-explorer">
        <div className="graph-loading">Loading graph...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="graph-explorer">
        <div className="graph-error">{error}</div>
      </div>
    );
  }

  // Empty graph — offer to populate
  if (nodes.size === 0 && !loading) {
    return (
      <div className="graph-explorer">
        <div className="graph-empty">
          <p>Graph is empty for this database.</p>
          <button className="primary-btn" onClick={handlePopulate}>
            Populate Graph
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-explorer">
      <div className="graph-toolbar">
        <div className="graph-search-wrap">
          <input
            type="text"
            className="text-input"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={e => searchNodes(e.target.value)}
          />
          {searchResults.length > 0 && (
            <ul className="graph-search-dropdown">
              {searchResults.map(n => (
                <li key={n.id} onClick={() => handleSearchSelect(n.id)}>
                  <span className="node-type-badge" style={{ background: TYPE_COLORS[n.node_type] || '#6b7280', fontSize: 9, padding: '1px 4px' }}>
                    {n.node_type}
                  </span>
                  {' '}{n.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="graph-layer-toggles">
          <button
            className={`layer-btn${visibleLayers.structural ? ' active' : ''}`}
            onClick={() => toggleLayer('structural')}
          >
            Structural
          </button>
        </div>

        <div className="graph-toolbar-actions">
          <button className="secondary-btn" onClick={handleFit} title="Fit to screen">Fit</button>
          <button className="secondary-btn" onClick={handleResetLayout} title="Re-run layout">Layout</button>
        </div>
      </div>

      <div className="graph-body">
        <GraphCanvas />
        <DetailPanel />
      </div>
    </div>
  );
}

const TYPE_COLORS: Record<string, string> = {
  table: '#3b82f6',
  column: '#93c5fd',
  form: '#22c55e',
  control: '#86efac',
};
