# Capability Ontology — Three-Layer Model

## The Three Layers

### Capability (names, lightweight)
A capability is a name. Its meaning is not defined by a description field — it emerges from the expressions that link to it. "Inventory Management" means whatever the forms, tables, queries, and code that express it actually do.

- `node_type: 'capability'`, `scope: 'global'`, `database_id: NULL`
- Derived by the LLM from structural evidence (tables, forms, modules)
- Linked to potentials via `actualizes` edges
- Linked to structures via `serves` edges

### Potential (what's implied or intended)
A potential is what a structure is *for* — the business purpose it serves. This is the universal middle layer between abstract capabilities and concrete expressions. Potentials are proposed by the LLM or user when examining database objects.

- `node_type: 'potential'`, `scope: 'global'`, `database_id: NULL`
- Created via `propose_potential` chat tool or `POST /api/graph/potential`
- Linked to structures via `serves` edges (structure → potential)
- Linked to capabilities via `actualizes` edges (potential → capability)

### Expression (what currently exists)
An expression is any concrete manifestation — an application, a form, a table, a code module, a query. Expressions are the things that *do* the work. In the graph, structural nodes (tables, columns, forms, controls) are expressions.

- Applications are expressions, not a separate graph concept
- `shared.applications` exists as a UI convenience registry, not as a graph node type
- Structural nodes (`node_type: 'table'`, `'column'`, `'form'`, `'control'`) are the expression layer in the graph

## Key Properties

- **Capabilities are names, not definitions.** Their meaning emerges from linked expressions.
- **Potentials replace intents** as the universal middle layer. The word "potential" better captures what's implied or intended without the baggage of "intent" as a technical term.
- **Applications are expressions.** They manifest capabilities, they don't occupy a separate ontological layer. The `shared.applications` table is a registry convenience, not a graph entity.
- **None derives from the others.** Capabilities don't come from expressions (they can be declared with no code). Potentials don't come from capabilities (a business might ignore available capabilities). Expressions don't come from potentials (legacy code often has no articulated purpose).
- **The layers connect via edges, not containment.** An expression `--serves-->` a potential. A potential `--actualizes-->` a capability. These are many-to-many relationships.

## Graph Node Types

| node_type | scope | database_id | layer |
|-----------|-------|-------------|-------|
| table | local | required | expression |
| column | local | required | expression |
| form | local | required | expression |
| control | local | required | expression |
| capability | global | NULL | capability |
| potential | global | NULL | potential |

## Edge Types

| rel_type | from → to | meaning |
|----------|-----------|---------|
| contains | table → column, form → control | structural containment |
| references | column → table | foreign key reference |
| bound_to | form → table, control → column | data binding |
| serves | structure → potential | "this structure serves this purpose" |
| actualizes | potential → capability | "this potential actualizes this capability" |
| requires | node → node | dependency |
| enables | node → node | enablement |
| expresses | node → node | expression relationship |
| refines | capability → capability | sub-capability or related concern |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graph/potentials` | GET | List all potential nodes |
| `/api/graph/potentials/prose` | GET | All potentials as prose |
| `/api/graph/potential/:id/structures` | GET | Structures serving a potential |
| `/api/graph/structure/:id/potentials` | GET | Potentials a structure serves |
| `/api/graph/potential` | POST | Create potential + link structures |
| `/api/graph/potential/confirm` | POST | Confirm a proposed potential link |

## Chat Tools

- `query_potential` — find potentials for a structure, or structures for a potential
- `propose_potential` — create a new potential and link structures to it
- `query_dependencies` — traverse structural dependency graph

## The Three-Schema Vision

- `shared` — framework schema (graph, forms, reports, modules, events)
- `accessclone` (or any target) — one migrated Access database
- Future databases — additional schemas, each an expression of capabilities

Capabilities and potentials live in `shared` (global). Structural nodes live in their database schema (local). This means capabilities can span multiple databases — "Inventory Management" might be expressed by tables in `northwind` and forms in `threehorse`.

## The Embedding Analogy

Capability nodes are like points in an embedding space. They represent *meaning* — abstract, language-independent, implementation-independent. Multiple different expressions can map to the same capability, just as multiple sentences can map to the same point in embedding space.

The graph topology defines distance. Two capabilities that share structural connections are "nearby" in the space. The AI doesn't need vector similarity — the graph structure IS the similarity metric.

## Design Principles

1. **The AI proposes, the graph records, the human confirms.** Capability and potential nodes are never created silently.
2. **Rough is fine.** A vague potential is better than no potential. Resolution increases over time as expressions attach.
3. **The ontology grows from every direction.** Bottom-up from code, top-down from users, laterally from product analysis. All origins are equally valid.
4. **The capability space is the product.** Access import is one feeder. The accumulated knowledge of what businesses do with data — independent of any particular app — is the long-term value.
