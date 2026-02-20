# Three-Layer Architecture — A Deleuzian Reading

## The Three Layers: Could Do / Should Do / Doing Now

Every existing communication tool collapses a crucial distinction — it only shows you what the organization *is doing now* and you have to imagine what it *could do* or *should do*. This architecture makes all three visible simultaneously.

### Could Do — The Virtual

*The plane of consistency. Think of it as your wildest dreams.*

Not a list of insights waiting to be surfaced. The full differential field of everything an organization's body of work implies, real but not actualized, containing all the variations, all the connections, all the patterns the work has ever enacted or could enact.

This is *puissance* — capacity that exists as intensity, not as enumerated possibility. It's the Body without Organs of organizational thinking: unorganized potential that resists premature stratification into any single interpretation. The virtual is not vague — it's maximally determined as a field of differential relations. Every unrealized implication stands in relation to every other, and those relations constitute the topology of the space.

### Should Do — The Diagram

*The abstract machine. Think of it as the sketches on the back of an envelope.*

The selective principle that draws from the virtual and orients actualization without yet being actual itself. It's what Deleuze and Guattari call the *diagrammatic function*: it doesn't represent a pre-existing reality and it doesn't produce a finished one. It pilots the process of stratification.

In the system, this is where intellectual operations live — the acts of distinguishing, connecting, reframing, converging, bounding that recur across expressions without being named. An organization argues about scope in three meetings using different vocabulary; the should-do layer is where "bounding" exists as an operation independent of any particular instance.

The abstract machine is what makes *this* expression *this* expression rather than some other equally possible one. It's *pouvoir* operating on *puissance* — power exercised as selection from capacity.

### Doing Now — The Actual

*The concrete assemblage, the stratum. Think of it as the hurly-burly, the daily grind.*

The actual note, transcript, message, or email with its specific wording, specific context, specific audience. What has been captured from the flows of the virtual and organized into a functioning arrangement of bodies (participants), tools (communication platforms), statements (arguments, claims, proposals), and practices (workflows, correspondence patterns).

It's *molar* — organized at scale, recognizable, repeatable. It's also, crucially, *territorial* — it has a boundary, a channel, a thread, a specific population of readers and respondents it operates within.

### Bidirectional Movement

**Actualization** moves from could-do through should-do to doing-now — an unrealized potential, shaped by an intellectual operation, becomes a specific expression in a specific medium.

**Deterritorialization** moves back — when the AI extracts an intention from a particular expression and recognizes it as an operation recurring across many expressions, it's freeing the pattern from its territorial binding. The system is a *deterritorialization engine*: it takes stratified, territorialized communication and extracts their virtual content, making visible what the organization *could do* and *should do* that was always real but never perceptible from inside what it *is doing now*.

---

## The Four Primitives (The Minimal Diagram)

Beneath the three layers, the system operates on three topological primitives and one invariant. These are the generating conditions — not metaphors for what the system does, but the *instruction set* that produces its behavior at every level of abstraction.

| Primitive | Topological Action | Manifestations |
|-----------|-------------------|----------------|
| **Boundary** | Enclosure. Creating a "here" vs "there" where local rules apply. | Schema isolation, tab workspaces, module namespaces, form sections, report bands. |
| **Transduction** | Isomorphism. Carrying shape across a boundary into a new medium. | SQL conversion, VBA→ClojureScript, intent extraction, form normalization, graph population. |
| **Resolution** | Gradient descent. Using failure as signal to find the path of least resistance. | Multi-pass retry loops, dependency resolution, gap decisions, LLM fallback, lint validation. |
| **Trace** (invariant) | Lineage. Ensuring the "whence" is never lost during the "what." | Append-only versioning, event logging, transcript persistence, import history, edge provenance. |

Trace is not a fourth primitive in the same sense — it's the *invariant* that all three primitives must preserve. Every Boundary creation must be traceable. Every Transduction must carry provenance. Every Resolution must log its path.

### Seeded in the Graph

The four primitives are stored in the graph as capability nodes (`node_type: 'capability'`, `scope: 'global'`). Their manifestations are potential nodes linked via `actualizes` edges. Trace is linked to the other three via `refines` edges (relationship: `invariant-of`).

Seeded by `seedPrimitives()` in `server/graph/populate.js`. Endpoints:
- `POST /api/graph/seed-primitives` — seed only the primitives
- `POST /api/graph/populate` — seeds primitives alongside schema population

Idempotent — safe to call multiple times.

---

## Graph Node Types

| node_type | scope | database_id | layer |
|-----------|-------|-------------|-------|
| table | local | required | expression (doing now) |
| column | local | required | expression (doing now) |
| form | local | required | expression (doing now) |
| control | local | required | expression (doing now) |
| potential | global | NULL | should do / manifestation |
| capability | global | NULL | could do / primitive |

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
| refines | capability → capability | sub-capability, related concern, or invariant-of |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graph/potentials` | GET | List all potential nodes |
| `/api/graph/potentials/prose` | GET | All potentials as prose |
| `/api/graph/potential/:id/structures` | GET | Structures serving a potential |
| `/api/graph/structure/:id/potentials` | GET | Potentials a structure serves |
| `/api/graph/potential` | POST | Create potential + link structures |
| `/api/graph/potential/confirm` | POST | Confirm a proposed potential link |
| `/api/graph/populate` | POST | Populate from schemas + seed primitives |
| `/api/graph/seed-primitives` | POST | Seed only the four primitives |

## Chat Tools

- `query_potential` — find potentials for a structure, or structures for a potential
- `propose_potential` — create a new potential and link structures to it
- `query_dependencies` — traverse structural dependency graph

## The Reflexive Turn

The four primitives aren't just a description of the system — they're *stored in the system's own graph*. The system can inspect its own architecture:
- "What actualizes Transduction?" → every conversion pipeline
- "What does Trace refine?" → the three primitives whose operations must preserve lineage
- "What serves Schema Isolation?" → structural nodes that implement boundary creation

When the system describes itself, it performs a Transduction where the source is its own execution logic (the should-do layer) and the target is the graph (the doing-now layer), with the structural logic of the three primitives as the invariant.

If the virtual is made legible — actually creating nodes for structural isomorphisms and emergent orderability — the system stops being a tool and becomes a **reflexive environment**. It could look at a new, unknown medium and ask: *"Which of my existing Transduction primitives can maintain an invariant across this specific Boundary?"*

## Design Principles

1. **The AI proposes, the graph records, the human confirms.** Capability and potential nodes are never created silently (except the four seeded primitives, which are foundational).
2. **Rough is fine.** A vague potential is better than no potential. Resolution increases over time as expressions attach.
3. **The ontology grows from every direction.** Bottom-up from code, top-down from users, laterally from product analysis. All origins are equally valid.
4. **The capability space is the product.** Access import is one feeder. The accumulated knowledge of what businesses do with data — independent of any particular app — is the long-term value.
5. **The primitives are the DNA.** Boundary, Transduction, Resolution, and Trace are the generating conditions. Everything the system does is a composition of these four.
