import { useGraphStore } from '@/store/graph';

const TYPE_COLORS: Record<string, string> = {
  table: '#3b82f6',
  column: '#93c5fd',
  form: '#22c55e',
  control: '#86efac',
};

export default function DetailPanel() {
  const { selectedNodeId, nodes, selectedNodeEdges, selectNode } = useGraphStore();

  if (!selectedNodeId) {
    return (
      <div className="graph-detail-panel">
        <div className="graph-detail-empty">Click a node to see its details</div>
      </div>
    );
  }

  const node = nodes.get(selectedNodeId);
  if (!node) {
    return (
      <div className="graph-detail-panel">
        <div className="graph-detail-empty">Node not found</div>
      </div>
    );
  }

  const outgoing = selectedNodeEdges.filter(e => e.from_id === selectedNodeId);
  const incoming = selectedNodeEdges.filter(e => e.to_id === selectedNodeId);

  const handleEdgeClick = (targetId: string) => {
    if (nodes.has(targetId)) {
      selectNode(targetId);
    }
  };

  return (
    <div className="graph-detail-panel">
      <div className="graph-detail-header">
        <span
          className="node-type-badge"
          style={{ background: TYPE_COLORS[node.node_type] || '#6b7280' }}
        >
          {node.node_type}
        </span>
        <h3 className="graph-detail-name">{node.name}</h3>
      </div>

      <table className="graph-props-table">
        <tbody>
          <tr><td>Scope</td><td>{node.scope}</td></tr>
          {node.database_id && <tr><td>Database</td><td>{node.database_id}</td></tr>}
          {node.origin && <tr><td>Origin</td><td>{node.origin}</td></tr>}
          {Object.entries(node.metadata).map(([k, v]) => (
            <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>
          ))}
        </tbody>
      </table>

      {outgoing.length > 0 && (
        <div className="graph-edge-section">
          <h4>Outgoing ({outgoing.length})</h4>
          <ul className="edge-list">
            {outgoing.map(e => (
              <li
                key={e.id}
                className="edge-item"
                onClick={() => handleEdgeClick(e.to_id)}
              >
                <span className="edge-rel">{e.rel_type}</span>
                <span className="edge-target">
                  {e.to_name || e.to_id.slice(0, 8)}
                  {e.to_type && <span className="edge-type-hint"> ({e.to_type})</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {incoming.length > 0 && (
        <div className="graph-edge-section">
          <h4>Incoming ({incoming.length})</h4>
          <ul className="edge-list">
            {incoming.map(e => (
              <li
                key={e.id}
                className="edge-item"
                onClick={() => handleEdgeClick(e.from_id)}
              >
                <span className="edge-rel">{e.rel_type}</span>
                <span className="edge-target">
                  {e.from_name || e.from_id.slice(0, 8)}
                  {e.from_type && <span className="edge-type-hint"> ({e.from_type})</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
