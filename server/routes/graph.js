/**
 * Graph API Routes
 * REST endpoints for querying and manipulating the dependency/intent graph
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

const {
  findNode,
  findNodeById,
  findNodesByType,
  upsertNode,
  deleteNode,
  getEdges,
  upsertEdge,
  deleteEdge,
  traverseDependencies
} = require('../graph/query');

const {
  populateFromSchemas,
  populateFromForm,
  proposePotential,
  confirmPotentialLink,
  clearGraph
} = require('../graph/populate');

const {
  renderDependenciesToProse,
  renderPotentialsForStructure,
  renderStructuresForPotential,
  renderAllPotentialsToProse,
  renderDatabaseOverview,
  renderImpactAnalysis
} = require('../graph/render');

module.exports = function(pool) {
  /**
   * GET /api/graph/node/:id
   * Get a single node by ID
   */
  router.get('/node/:id', async (req, res) => {
    try {
      const node = await findNodeById(pool, req.params.id);
      if (!node) {
        return res.status(404).json({ error: 'Node not found' });
      }
      res.json(node);
    } catch (err) {
      console.error('Error getting node:', err);
      logError(pool, 'GET /api/graph/node/:id', 'Failed to get node', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/nodes
   * Query nodes by type and optional database_id
   * Query params: type, database_id
   */
  router.get('/nodes', async (req, res) => {
    try {
      const { type, database_id } = req.query;
      if (!type) {
        return res.status(400).json({ error: 'type parameter required' });
      }
      const nodes = await findNodesByType(pool, type, database_id || null);
      res.json({ nodes });
    } catch (err) {
      console.error('Error querying nodes:', err);
      logError(pool, 'GET /api/graph/nodes', 'Failed to query nodes', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/find
   * Find a specific node by type, name, and database_id
   * Query params: type, name, database_id
   */
  router.get('/find', async (req, res) => {
    try {
      const { type, name, database_id } = req.query;
      if (!type || !name) {
        return res.status(400).json({ error: 'type and name parameters required' });
      }
      const node = await findNode(pool, type, name, database_id || null);
      if (!node) {
        return res.status(404).json({ error: 'Node not found' });
      }
      res.json(node);
    } catch (err) {
      console.error('Error finding node:', err);
      logError(pool, 'GET /api/graph/find', 'Failed to find node', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/node
   * Create or update a node
   * Body: { node_type, name, database_id, scope, origin, metadata }
   */
  router.post('/node', async (req, res) => {
    try {
      const node = await upsertNode(pool, req.body);
      res.json(node);
    } catch (err) {
      console.error('Error creating node:', err);
      logError(pool, 'POST /api/graph/node', 'Failed to create node', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/graph/node/:id
   * Delete a node
   */
  router.delete('/node/:id', async (req, res) => {
    try {
      const deleted = await deleteNode(pool, req.params.id);
      res.json({ success: deleted });
    } catch (err) {
      console.error('Error deleting node:', err);
      logError(pool, 'DELETE /api/graph/node/:id', 'Failed to delete node', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/edges/:nodeId
   * Get edges for a node
   * Query params: direction (outgoing, incoming, both)
   */
  router.get('/edges/:nodeId', async (req, res) => {
    try {
      const { direction = 'both' } = req.query;
      const edges = await getEdges(pool, req.params.nodeId, direction);
      res.json({ edges });
    } catch (err) {
      console.error('Error getting edges:', err);
      logError(pool, 'GET /api/graph/edges/:nodeId', 'Failed to get edges', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/edge
   * Create or update an edge
   * Body: { from_id, to_id, rel_type, status, proposed_by, metadata }
   */
  router.post('/edge', async (req, res) => {
    try {
      const edge = await upsertEdge(pool, req.body);
      res.json(edge);
    } catch (err) {
      console.error('Error creating edge:', err);
      logError(pool, 'POST /api/graph/edge', 'Failed to create edge', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/graph/edge
   * Delete an edge
   * Query params: from_id, to_id, rel_type
   */
  router.delete('/edge', async (req, res) => {
    try {
      const { from_id, to_id, rel_type } = req.query;
      if (!from_id || !to_id || !rel_type) {
        return res.status(400).json({ error: 'from_id, to_id, and rel_type required' });
      }
      const deleted = await deleteEdge(pool, from_id, to_id, rel_type);
      res.json({ success: deleted });
    } catch (err) {
      console.error('Error deleting edge:', err);
      logError(pool, 'DELETE /api/graph/edge', 'Failed to delete edge', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/dependencies/:nodeId
   * Traverse dependencies from a node
   * Query params: direction (upstream, downstream), depth, rel_types (comma-separated)
   */
  router.get('/dependencies/:nodeId', async (req, res) => {
    try {
      const { direction = 'downstream', depth = '3', rel_types } = req.query;
      const maxDepth = parseInt(depth);
      const relTypes = rel_types ? rel_types.split(',') : null;

      const deps = await traverseDependencies(pool, req.params.nodeId, direction, maxDepth, relTypes);
      res.json({ dependencies: deps });
    } catch (err) {
      console.error('Error traversing dependencies:', err);
      logError(pool, 'GET /api/graph/dependencies/:nodeId', 'Failed to traverse dependencies', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/dependencies/:nodeId/prose
   * Get dependency prose for a node
   */
  router.get('/dependencies/:nodeId/prose', async (req, res) => {
    try {
      const { direction = 'downstream', depth = '3' } = req.query;
      const prose = await renderDependenciesToProse(pool, req.params.nodeId, direction, parseInt(depth));
      res.json({ prose });
    } catch (err) {
      console.error('Error rendering dependencies:', err);
      logError(pool, 'GET /api/graph/dependencies/:nodeId/prose', 'Failed to render dependencies', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/potentials
   * Get all potentials
   */
  router.get('/potentials', async (req, res) => {
    try {
      const potentials = await findNodesByType(pool, 'potential');
      res.json({ potentials });
    } catch (err) {
      console.error('Error getting potentials:', err);
      logError(pool, 'GET /api/graph/potentials', 'Failed to get potentials', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/potentials/prose
   * Get all potentials as prose
   */
  router.get('/potentials/prose', async (req, res) => {
    try {
      const prose = await renderAllPotentialsToProse(pool);
      res.json({ prose });
    } catch (err) {
      console.error('Error rendering potentials:', err);
      logError(pool, 'GET /api/graph/potentials/prose', 'Failed to render potentials', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/potential/:id/structures
   * Get structures that serve a potential
   */
  router.get('/potential/:id/structures', async (req, res) => {
    try {
      const prose = await renderStructuresForPotential(pool, req.params.id);
      res.json({ prose });
    } catch (err) {
      console.error('Error getting structures for potential:', err);
      logError(pool, 'GET /api/graph/potential/:id/structures', 'Failed to get structures for potential', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/structure/:id/potentials
   * Get potentials a structure serves
   */
  router.get('/structure/:id/potentials', async (req, res) => {
    try {
      const prose = await renderPotentialsForStructure(pool, req.params.id);
      res.json({ prose });
    } catch (err) {
      console.error('Error getting potentials for structure:', err);
      logError(pool, 'GET /api/graph/structure/:id/potentials', 'Failed to get potentials for structure', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/potential
   * Create a potential and optionally link structures
   * Body: { name, description, origin, structures: [{ node_type, name, database_id }] }
   */
  router.post('/potential', async (req, res) => {
    try {
      const { name, description, origin, structures = [] } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      const result = await proposePotential(pool, { name, description, origin }, structures);
      res.json(result);
    } catch (err) {
      console.error('Error creating potential:', err);
      logError(pool, 'POST /api/graph/potential', 'Failed to create potential', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/potential/confirm
   * Confirm a proposed potential link
   * Body: { structure_id, potential_id }
   */
  router.post('/potential/confirm', async (req, res) => {
    try {
      const { structure_id, potential_id } = req.body;
      const confirmed = await confirmPotentialLink(pool, structure_id, potential_id);
      res.json({ success: confirmed });
    } catch (err) {
      console.error('Error confirming potential:', err);
      logError(pool, 'POST /api/graph/potential/confirm', 'Failed to confirm potential', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/database/:databaseId/overview
   * Get database structure overview
   */
  router.get('/database/:databaseId/overview', async (req, res) => {
    try {
      const prose = await renderDatabaseOverview(pool, req.params.databaseId);
      res.json({ prose });
    } catch (err) {
      console.error('Error getting database overview:', err);
      logError(pool, 'GET /api/graph/database/:databaseId/overview', 'Failed to get database overview', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/impact
   * Get impact analysis for a node
   * Query params: type, name, database_id
   */
  router.get('/impact', async (req, res) => {
    try {
      const { type, name, database_id } = req.query;
      if (!type || !name) {
        return res.status(400).json({ error: 'type and name required' });
      }
      const prose = await renderImpactAnalysis(pool, type, name, database_id || null);
      res.json({ prose });
    } catch (err) {
      console.error('Error getting impact analysis:', err);
      logError(pool, 'GET /api/graph/impact', 'Failed to get impact analysis', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/populate
   * Trigger schema population
   */
  router.post('/populate', async (req, res) => {
    try {
      const stats = await populateFromSchemas(pool);
      res.json({ success: true, stats });
    } catch (err) {
      console.error('Error populating graph:', err);
      logError(pool, 'POST /api/graph/populate', 'Failed to populate graph', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/clear
   * Clear all graph data (dangerous!)
   */
  router.post('/clear', async (req, res) => {
    try {
      await clearGraph(pool);
      res.json({ success: true });
    } catch (err) {
      console.error('Error clearing graph:', err);
      logError(pool, 'POST /api/graph/clear', 'Failed to clear graph', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
