# Capability Ontology

A three-layer model that separates what a business system *could* do, what it *should* do, and what it *currently* does — making the intent space navigable by both humans and AI.

## Background

AccessClone extracts business logic from Access databases. Before this change, extracted knowledge lived in two disconnected stores:

1. **VBA intents** — per-module JSONB in `shared.modules.intents`. Procedural, concrete, scoped to a single module. 30 types from the INTENT_VOCABULARY (validate-required, open-form, dlookup, etc.).
2. **Graph intents** — `_nodes` with `node_type='intent'`, global scope. Business purposes like "Track Inventory Costs". Connected to structures via `serves` edges.

These two layers encoded the same distinction — meaning vs. expression — but had no bridge between them. A graph intent like "Enforce credential expiration" was not connected to the specific VBA intents (validate-condition, show-message, set-control-enabled) that implemented it.

More fundamentally: both layers described only what *existed* in a specific application. Neither captured the space of what *could* exist.

## The Three-Layer Model

```
CAPABILITY    what could exist       (discovered, imported, or declared)
    ↑ actualizes
INTENT        what should exist      (business decision for this application)
    ↑ expresses
EXPRESSION    what does exist        (extracted from code)
```

**Capabilities** are abstract, global, business-domain concepts. "Customer inactivity detection", "vendor reliability tracking", "temporal compliance checking". They exist independently of any application, database, or codebase. They are points in a possibility space.

**Intents** are decisions. A specific business chose to care about a specific capability. "We intend to enforce data completeness on customer records." An intent links an application to a capability — it says "this matters to us."

**Expressions** are implementations. Concrete code artifacts extracted from VBA (or written in ClojureScript). `{type: "validate-required", field: "CustomerName"}`. An expression realizes an intent in running software.

### Key properties

- **None derives from the others.** Capabilities don't come from expressions (they can be declared with no code). Intents don't come from capabilities (a business might ignore available capabilities). Expressions don't come from intents (legacy code often has no articulated intent).
- **The layers connect via edges, not containment.** An expression `--expresses-->` an intent. An intent `--actualizes-->` a capability. These are many-to-many relationships.
- **Each layer has independent lifecycle.** Capabilities grow as the ontology learns. Intents change when business priorities shift. Expressions change when code is modified. A change at one layer doesn't force changes at others.

## The Embedding Analogy

Capability nodes are like points in an embedding space. They represent *meaning* — abstract, language-independent, implementation-independent. Multiple different expressions can map to the same capability, just as multiple sentences can map to the same point in embedding space.

The graph topology defines distance. Two capabilities that share structural connections (both served by tables with timestamp columns, both requiring notification patterns) are "nearby" in the space. The AI doesn't need vector similarity — the graph structure IS the similarity metric.

A capability with no expressions is a point in the space that nothing has mapped to *yet*. It's still a valid, useful point — it tells the AI "this concept is in play for this business" even though no code implements it.

## Capability Sources

Capabilities enter the system from four directions:

| Origin | Description | Example |
|--------|-------------|---------|
| `extracted` | Bottom-up from VBA intent analysis | "Across 14 modules, I found customer validation patterns — proposing Customer Data Quality" |
| `observed` | Pattern recognized across multiple migrations | "Three databases all have credential expiry checking — this is a common capability" |
| `imported` | Derived from analyzing existing products | "Salesforce has automated invoice aging — that's a capability relevant to any system with invoice tables" |
| `user` | Declared by a human | "I wish I could get an alert when a customer hasn't ordered in 90 days" |

All four are valid. The origin is metadata (stored in the `origin` field on `_nodes`), not a quality ranking. User-declared capabilities are just as real as extracted ones.

## Applications

An application is a first-class entity above databases. It represents the business system being built, regardless of where it currently lives.

**`shared.applications` table:**
- `id` UUID — stable identity
- `name`, `description` — human-readable
- `database_id` → nullable FK to `shared.databases` (PG implementation)
- `source_path` → nullable (Access source file)
- `metadata` JSONB (provenance, tags)

**Lifecycle states:**

| database_id | source_path | State |
|-------------|-------------|-------|
| NULL | NULL | Aspirational — defined only by capability edges |
| NULL | set | Pre-import — Access source identified, no PG database yet |
| set | set | In migration — both source and target exist |
| set | NULL | Post-migration or greenfield — PG only |

Applications also exist as graph nodes (`node_type='application'`, global scope) so they can have edges to capability nodes: `application --serves--> capability`.

## Schema Changes

### Modified: `shared._nodes` constraint

The `valid_scope` constraint now allows three global node types:

```
(node_type IN ('intent', 'capability', 'application')
  AND database_id IS NULL AND scope = 'global')
OR
(node_type NOT IN ('intent', 'capability', 'application')
  AND database_id IS NOT NULL AND scope = 'local')
```

A migration block (`DO $$ ... END $$`) drops and re-adds the constraint for existing installs.

### New: `shared.applications` table

Created alongside `shared.databases`. The applications table owns the business concept; the databases table owns the PG infrastructure.

### New node types

| node_type | scope | database_id | purpose |
|-----------|-------|-------------|---------|
| `capability` | global | NULL | Abstract business capability |
| `expression` | local | set | Concrete code artifact extracted from VBA |
| `application` | global | NULL | Business system entity |

### New edge types

| rel_type | from → to | meaning |
|----------|-----------|---------|
| `expresses` | expression → intent | "this code implements this business intent" |
| `actualizes` | intent → capability | "this business intent makes this capability real" |
| `refines` | capability → capability | "this is a sub-capability or related concern" |

### Modified: `upsertNode()` in query.js

Scope default now treats `capability` and `application` as global (alongside `intent`).

## Implications for Existing Systems

### Import Pipeline — no changes needed

The import pipeline creates structures (tables, forms, controls) and extracts VBA intents. These continue to work as-is. The new layers (capability, application, expression-as-node) are additive — they reference existing data but don't modify the import flow.

### VBA Intent Extraction — future: promote to expression nodes

Currently, extracted intents live in `shared.modules.intents` JSONB. A future step promotes these to `_nodes` with `node_type='expression'`, making them addressable in the graph. The JSONB becomes a cache or is dropped. This is a data migration, not a schema change.

### Chat System — future: capability-aware context

The chat system prompt currently scopes to a single tab (form, report, module). Two new context scopes are needed:

- **Application-level chat**: sees all intents/expressions for a database plus the capability edges. Lives in the Application view.
- **Global-level chat**: sees all capability nodes, cross-application patterns. Lives in the Global view. This is where `propose_capability` as a chat tool would live.

### Dependency Graph — existing edges unchanged

All existing edge types (`contains`, `references`, `bound_to`, `serves`, `requires`, `enables`) continue to work. The new edge types (`expresses`, `actualizes`, `refines`) extend the graph without modifying existing traversals.

### UI — future: Global and Application views

Two new top-level views (alongside Import, Run, Logs):

- **Global**: the capability ontology. All capability nodes regardless of application. Origin badges, connection counts, chat scoped to the full space.
- **Application**: the current App Viewer reframed through capabilities. Which capabilities does this app serve? What coverage gaps exist? Intent/expression summary with capability context.

## Capability Node Properties

Capability nodes are intentionally loose. A node with just a name and a one-line description is valid and useful. Formal schemas, parameter definitions, and decomposition are optional — they emerge over time as expressions attach and the AI triangulates meaning from the graph neighborhood.

### What makes them valuable

Capabilities don't execute anything. They're context for the AI. Even a vague capability node like `{name: "customer-inactivity-detection", description: "alert when customers go quiet"}` does enormous work when it's in the graph connected to `customers` and `orders` tables. The AI doesn't need a formal spec — it needs to know the concept is *in play*.

### Versioning

Capability nodes are mutable with an event log, not versioned. They aren't code — changing a description doesn't break anything downstream. Provenance is recorded in `metadata.history` as an append-only array of events (created, refined, linked, source changed).

### Cross-application patterns

Two applications that independently create similar capability nodes signal that the capability is real — independently discovered. The shared capability ontology enables: "businesses with your structural profile typically have these capabilities that you haven't articulated yet."

### Relationship to intents

Capabilities and intents are linked by human decision, not computation. The AI proposes ("given your structures and this capability, do you intend to enforce this?") and the human confirms. This is the one point in the pipeline that truly requires human judgment — everything else (extraction, generation, structural analysis) can be automated.

## Design Principles

1. **The AI proposes, the graph records, the human confirms.** Capability nodes are never created silently.
2. **Rough is fine.** A vague capability is better than no capability. Resolution increases over time as expressions and structures attach.
3. **The ontology grows from every direction.** Bottom-up from code, top-down from users, laterally from product analysis. All origins are equally valid.
4. **The capability space is the product.** Access import is one feeder. The accumulated knowledge of what businesses do with data — independent of any particular app — is the long-term value.
