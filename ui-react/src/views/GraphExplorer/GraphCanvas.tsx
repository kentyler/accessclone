import { useEffect, useRef } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { useGraphStore } from '@/store/graph';
import type { GraphNode, GraphEdge } from '@/api/types';

// ============================================================
// Node & Edge Styling
// ============================================================

const NODE_COLORS: Record<string, string> = {
  table: '#3b82f6',
  column: '#93c5fd',
  form: '#22c55e',
  control: '#86efac',
  potential: '#f97316',
  capability: '#a855f7',
};

const NODE_SHAPES: Record<string, string> = {
  table: 'round-rectangle',
  column: 'ellipse',
  form: 'round-rectangle',
  control: 'ellipse',
  potential: 'triangle',
  capability: 'star',
};

const EDGE_STYLES: Record<string, { lineColor: string; lineStyle: string; width: number }> = {
  contains: { lineColor: '#9ca3af', lineStyle: 'solid', width: 1 },
  references: { lineColor: '#3b82f6', lineStyle: 'dashed', width: 1.5 },
  bound_to: { lineColor: '#22c55e', lineStyle: 'solid', width: 2 },
  serves: { lineColor: '#f97316', lineStyle: 'dotted', width: 1.5 },
  actualizes: { lineColor: '#a855f7', lineStyle: 'dashed', width: 1.5 },
  refines: { lineColor: '#6366f1', lineStyle: 'dotted', width: 1 },
};

const cyStyle: cytoscape.StylesheetStyle[] = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'font-size': 10,
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 4,
      'background-color': 'data(color)',
      shape: 'data(shape)' as any,
      width: 'data(size)',
      height: 'data(size)',
      'border-width': 0,
      'text-max-width': '80px',
      'text-wrap': 'ellipsis',
    },
  },
  {
    selector: 'node.selected',
    style: {
      'border-width': 3,
      'border-color': '#ef4444',
    },
  },
  {
    selector: 'node.neighbor',
    style: {
      'border-width': 2,
      'border-color': '#fbbf24',
    },
  },
  {
    selector: 'edge',
    style: {
      width: 'data(weight)',
      'line-color': 'data(color)',
      'line-style': 'data(lineStyle)' as any,
      'target-arrow-color': 'data(color)',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'arrow-scale': 0.8,
      opacity: 0.6,
    },
  },
  {
    selector: 'edge.highlighted',
    style: {
      opacity: 1,
      width: 3,
    },
  },
];

// ============================================================
// Helper: convert store data → cytoscape elements
// ============================================================

function isNodeVisible(node: GraphNode, layers: { structural: boolean; potentials: boolean; capabilities: boolean }): boolean {
  const t = node.node_type;
  if (t === 'potential') return layers.potentials;
  if (t === 'capability') return layers.capabilities;
  return layers.structural;
}

function buildElements(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  layers: { structural: boolean; potentials: boolean; capabilities: boolean },
): ElementDefinition[] {
  const visibleNodeIds = new Set<string>();
  const elements: ElementDefinition[] = [];

  for (const n of nodes.values()) {
    if (!isNodeVisible(n, layers)) continue;
    visibleNodeIds.add(n.id);
    const isSmall = n.node_type === 'column' || n.node_type === 'control';
    elements.push({
      data: {
        id: n.id,
        label: n.name,
        color: NODE_COLORS[n.node_type] || '#6b7280',
        shape: NODE_SHAPES[n.node_type] || 'ellipse',
        size: isSmall ? 16 : 32,
        nodeType: n.node_type,
      },
    });
  }

  for (const e of edges.values()) {
    if (!visibleNodeIds.has(e.from_id) || !visibleNodeIds.has(e.to_id)) continue;
    const style = EDGE_STYLES[e.rel_type] || EDGE_STYLES.contains;
    elements.push({
      data: {
        id: e.id,
        source: e.from_id,
        target: e.to_id,
        color: style.lineColor,
        lineStyle: style.lineStyle,
        weight: style.width,
        relType: e.rel_type,
      },
    });
  }

  return elements;
}

// ============================================================
// Component
// ============================================================

export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const { nodes, edges, visibleLayers, selectedNodeId, selectNode, expandNode } = useGraphStore();

  // Create cytoscape instance on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      style: cyStyle,
      layout: { name: 'grid' }, // placeholder, will run CoSE after elements added
      minZoom: 0.1,
      maxZoom: 5,
      wheelSensitivity: 0.3,
    });

    // Single-tap node → select
    cy.on('tap', 'node', (evt) => {
      const nodeId = evt.target.id();
      selectNode(nodeId);
    });

    // Tap background → deselect
    cy.on('tap', (evt) => {
      if (evt.target === cy) selectNode(null);
    });

    // Double-tap node → expand (for table/form types)
    cy.on('dbltap', 'node', (evt) => {
      const nodeType = evt.target.data('nodeType');
      if (nodeType === 'table' || nodeType === 'form') {
        expandNode(evt.target.id());
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync elements when data changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const elements = buildElements(nodes, edges, visibleLayers);
    const currentIds = new Set(cy.elements().map(el => el.id()));
    const newIds = new Set(elements.map(el => el.data.id!));

    // Remove stale
    cy.elements().forEach(el => {
      if (!newIds.has(el.id())) el.remove();
    });

    // Add new
    const toAdd = elements.filter(el => !currentIds.has(el.data.id!));
    if (toAdd.length > 0) {
      cy.add(toAdd);
    }

    // Run layout if elements changed
    if (toAdd.length > 0 || cy.elements().length !== elements.length) {
      cy.layout({
        name: 'cose',
        animate: true,
        animationDuration: 500,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 80,
        edgeElasticity: () => 100,
        numIter: 300,
        padding: 30,
        randomize: cy.elements().length < 5,
      } as any).run();
    }
  }, [nodes, edges, visibleLayers]);

  // Highlight selected node
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().removeClass('selected neighbor highlighted');

    if (selectedNodeId) {
      const node = cy.getElementById(selectedNodeId);
      if (node.length > 0) {
        node.addClass('selected');
        node.neighborhood('node').addClass('neighbor');
        node.connectedEdges().addClass('highlighted');
        // Center on selected node
        cy.animate({
          center: { eles: node },
          duration: 300,
        });
      }
    }
  }, [selectedNodeId]);

  return <div ref={containerRef} className="graph-canvas-container" />;
}

// ============================================================
// Exports for toolbar actions
// ============================================================

export function fitGraph() {
  // Access via store is tricky — use DOM-based approach
  const container = document.querySelector('.graph-canvas-container');
  if (container && (container as any).__cy) {
    (container as any).__cy.fit(undefined, 30);
  }
}
