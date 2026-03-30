import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as api from '@/api/client';
import type { GraphNode, GraphEdge, SubgraphResponse } from '@/api/types';

// ============================================================
// State shape
// ============================================================

export interface GraphState {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  expandedNodes: Set<string>;
  selectedNodeId: string | null;
  selectedNodeEdges: GraphEdge[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  searchResults: GraphNode[];
  visibleLayers: {
    structural: boolean;
  };
}

export interface GraphActions {
  loadSubgraph(databaseId: string): Promise<void>;
  expandNode(nodeId: string): Promise<void>;
  collapseNode(nodeId: string): void;
  selectNode(nodeId: string | null): Promise<void>;
  searchNodes(query: string): void;
  toggleLayer(layer: keyof GraphState['visibleLayers']): void;
  reset(): void;
}

type GraphStore = GraphState & GraphActions;

// ============================================================
// Store
// ============================================================

export const useGraphStore = create<GraphStore>()(
  immer((set, get) => ({
    nodes: new Map(),
    edges: new Map(),
    expandedNodes: new Set(),
    selectedNodeId: null,
    selectedNodeEdges: [],
    loading: false,
    error: null,
    searchQuery: '',
    searchResults: [],
    visibleLayers: { structural: true },

    async loadSubgraph(databaseId) {
      set(s => { s.loading = true; s.error = null; });
      const types = 'table,form';
      const res = await api.get<SubgraphResponse>(
        `/api/graph/subgraph?database_id=${encodeURIComponent(databaseId)}&types=${types}`
      );
      if (!res.ok) {
        set(s => { s.loading = false; s.error = 'Failed to load graph'; });
        return;
      }
      set(s => {
        s.nodes = new Map(res.data.nodes.map(n => [n.id, n]));
        s.edges = new Map(res.data.edges.map(e => [e.id, e]));
        s.expandedNodes = new Set();
        s.loading = false;
      });
    },

    async expandNode(nodeId) {
      if (get().expandedNodes.has(nodeId)) return;
      const res = await api.get<SubgraphResponse>(`/api/graph/children/${nodeId}`);
      if (!res.ok) return;
      set(s => {
        for (const n of res.data.nodes) s.nodes.set(n.id, n);
        for (const e of res.data.edges) s.edges.set(e.id, e);
        s.expandedNodes.add(nodeId);
      });
    },

    collapseNode(nodeId) {
      set(s => {
        // Find child node IDs via contains edges
        const childIds = new Set<string>();
        for (const e of s.edges.values()) {
          if (e.from_id === nodeId && e.rel_type === 'contains') {
            childIds.add(e.to_id);
          }
        }
        // Remove child nodes and their edges
        for (const cid of childIds) {
          s.nodes.delete(cid);
          // Remove edges involving child
          for (const [eid, e] of s.edges.entries()) {
            if (e.from_id === cid || e.to_id === cid) s.edges.delete(eid);
          }
        }
        s.expandedNodes.delete(nodeId);
      });
    },

    async selectNode(nodeId) {
      if (!nodeId) {
        set(s => { s.selectedNodeId = null; s.selectedNodeEdges = []; });
        return;
      }
      set(s => { s.selectedNodeId = nodeId; });
      const res = await api.get<{ edges: GraphEdge[] }>(`/api/graph/edges/${nodeId}?direction=both`);
      if (res.ok) {
        // Annotate edges with node names for display
        const nodes = get().nodes;
        const annotated = res.data.edges.map(e => ({
          ...e,
          from_type: nodes.get(e.from_id)?.node_type,
          from_name: nodes.get(e.from_id)?.name,
          to_type: nodes.get(e.to_id)?.node_type,
          to_name: nodes.get(e.to_id)?.name,
        }));
        set(s => { s.selectedNodeEdges = annotated; });
      }
    },

    searchNodes(query) {
      set(s => {
        s.searchQuery = query;
        if (!query.trim()) {
          s.searchResults = [];
          return;
        }
        const lower = query.toLowerCase();
        s.searchResults = Array.from(s.nodes.values())
          .filter(n => n.name.toLowerCase().includes(lower))
          .slice(0, 20);
      });
    },

    toggleLayer(layer) {
      set(s => { s.visibleLayers[layer] = !s.visibleLayers[layer]; });
    },

    reset() {
      set(s => {
        s.nodes = new Map();
        s.edges = new Map();
        s.expandedNodes = new Set();
        s.selectedNodeId = null;
        s.selectedNodeEdges = [];
        s.loading = false;
        s.error = null;
        s.searchQuery = '';
        s.searchResults = [];
        s.visibleLayers = { structural: true };
      });
    },
  }))
);
