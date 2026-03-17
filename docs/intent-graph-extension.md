# Intent Graph — Extended Use Summary

## Current State

The intent graph is a directed graph of typed nodes representing
application behavior, extracted from legacy database platforms (Access,
FoxPro, Paradox) and executed by the Three Horse runtime.

Current node types cover database application operations:
- open form, close form
- look up value, run query
- validate input, show message
- branch on condition
- trigger event, run report

Edges represent dependency, sequence, trigger, and conditional
relationships.

The runtime traverses the graph, resolves conditions, and executes
handlers. An expression evaluator handles branching logic. The LLM
reads and writes the same graph structure to propose and apply
modifications.

All of this is working. 497 tests passing.

---

## The Extension

The graph structure — typed nodes, directed edges, trigger conditions,
branch logic, event handlers — is not specific to database applications.
It is specific to processes. The current node types are vocabulary, not
structural commitments. The structure can hold any vocabulary.

The extension adds new node types representing business infrastructure
operations. The runtime, edge types, expression evaluator, and LLM
modification layer do not change. Only the vocabulary expands.

---

## New Node Types Required

### Communication Events
Triggers and outcomes corresponding to business communication activity.

```json
{
  "type": "communication_event",
  "subtype": "email_received | message_sent | meeting_held | document_shared",
  "actor": "role_ref | agent_ref",
  "artifact_in": ["artifact_ref"],
  "artifact_out": ["artifact_ref"],
  "triggers": ["node_ref"]
}
```

### Role-Based Actors
Participants in a workflow — human roles, agent roles, or human/agent
collaborative roles. The execution model is a property of the actor
node, not of the graph structure.

```json
{
  "type": "actor",
  "execution_model": "human | agent | human_agent",
  "role": "string",
  "capabilities": ["capability_ref"]
}
```

### State Transitions
A client, engagement, or business entity moves between defined states.
Structurally equivalent to a branch with persistence.

```json
{
  "type": "state_transition",
  "entity": "entity_ref",
  "from_state": "string",
  "to_state": "string",
  "condition": "expression",
  "artifact_out": ["artifact_ref"]
}
```

### External System Interactions
API calls, calendar events, invoice generation, and similar outbound
operations. Structurally close to existing query and lookup nodes.

```json
{
  "type": "external_interaction",
  "system": "string",
  "operation": "string",
  "artifact_in": ["artifact_ref"],
  "artifact_out": ["artifact_ref"]
}
```

### Document Artifacts
Outputs with downstream triggers — proposals, contracts, reports,
diagnostic documents. Each is a node that can be referenced by
subsequent operations.

```json
{
  "type": "document_artifact",
  "label": "string",
  "template": "template_ref",
  "artifact_in": ["artifact_ref"],
  "artifact_out": "artifact_ref",
  "triggers": ["node_ref"]
}
```

### Time-Based Triggers
Scheduled, duration-based, or deadline-based event initiators.

```json
{
  "type": "time_trigger",
  "schedule": "cron | duration | deadline",
  "reference": "string",
  "triggers": ["node_ref"]
}
```

---

## The Artifact Model

The artifact is the boundary object between operations. The intent graph
does not reach inside operations to specify how they execute. It links
to what surrounds them — the inputs they consume and the outputs they
produce.

An artifact is any referenceable output:
- a document
- a decision record
- a message thread
- a completed form
- a triggered event
- an agent output
- a human judgment logged in the events table

Every node has `artifact_in` and `artifact_out` properties. Operations
are substitutable: a human/agent operation and a fully agent-driven
operation can occupy the same node position in the graph if their
artifact interfaces match. Swapping execution models does not change the
graph. Downstream operations are unaffected.

---

## The Events Table Connection

The events table (Formfold substrate) is the structured residue of
business activity. It serves two roles in this architecture:

**1. Extraction source**

Business operation intent graphs are extracted from the events table the
same way application intent graphs are extracted from Access files. The
events table entries are read by an extraction layer that produces
intent nodes — communication events, state transitions, actor
invocations, artifact productions.

**2. Execution trace**

Every operation, regardless of execution model, produces artifacts
recorded in the events table. The intent graph specifies what should
happen. The events table records what did happen and where the artifacts
are. Traversing the graph gives you the specification. Traversing the
artifact links gives you the forensics.

---

## Execution Model as Node Property

Whether a node is executed by an agent, a human, or a human/agent
collaboration is a property of the node, not of the graph structure.

```json
{
  "type": "operation",
  "label": "qualifying_analysis",
  "execution_model": "agent",
  "artifact_in": ["legacy_application_file"],
  "artifact_out": ["diagnostic_report"],
  "triggers": ["migration_proposal_node"]
}
```

The same node during an earlier phase might carry `"execution_model":
"human_agent"`. The graph is identical. The artifact interface is
identical. The execution model migrates as capability and trust develop.

This is how the fluency gradient is encoded structurally. The graph
records which nodes have migrated to agent execution and when. The
events table records the artifact trail for both execution models.

---

## Three Horse Operations as a Subgraph

Every Three Horse service operation maps to a subgraph:

| Operation | Artifact In | Artifact Out | Current Execution |
|-----------|-------------|--------------|-------------------|
| Qualifying analysis | Legacy app file | Diagnostic report | Agent pipeline |
| Migration | Diagnostic report + source files | Intent graph + web app | Agent + human review |
| Managed service digest | Activity log segment | Periodic summary | Agent + human review |
| Bespoke development | Client specification | Intent tree update | Human/agent |
| Patch proposal | Cross-org telemetry | Patch definition | Agent + human review |
| Community pattern detection | Anonymized logs | Pattern record | Agent |

These subgraphs compose. Their dependencies are visible in the graph.
Their execution is traceable through the events table and artifact links.

---

## Client Application Graphs and Business Operation Graphs

Both use the same runtime, the same node schema, the same artifact
reference model, and the same events table.

A client artifact produced by their application can become an input to a
Three Horse operation without a translation layer. Both sides speak the
same intent graph language.

The boundary between a business and the software it runs is
representational, not architectural. Software operations and business
operations are the same kind of thing: nodes with artifact interfaces,
varying in execution model, linked by the same directed graph structure.

---

## What Does Not Change

- Graph structure (nodes, edges, dependency/sequence/trigger/conditional
  edge types)
- Expression evaluator
- Runtime traversal and execution model
- LLM read/write interface to the graph
- Events table schema

---

## What Needs to Be Built

1. **New node type definitions** — JSON schema extensions for the six
   business node types above
2. **Actor registry** — maps role references to execution models and
   capability sets
3. **Artifact registry** — tracks artifact references, their producing
   nodes, and their locations in the events table
4. **Business extraction layer** — reads events table entries and
   produces intent nodes (analogous to the Access extraction pipeline)
5. **Execution model resolver** — dispatches node execution to agent,
   human task queue, or human/agent interface based on node property
6. **Trigger layer integration** — time-based and activity-based
   triggers feed into the graph as trigger nodes rather than as
   external processes

---

## Prototype Path

The lowest-risk validation is schema extension without runtime changes:

1. Define the new node types in the existing JSON schema
2. Hand-author a small business operation subgraph (intake process or
   qualifying analysis pipeline) using the new types
3. Feed it to the existing runtime and observe what breaks
4. Gaps will be vocabulary (missing node types) or dispatch (execution
   model resolver not yet built) — not structural

The hypothesis: the runtime handles the new node types without
modification to traversal or evaluation logic. What requires new code is
the dispatch layer (routing to agent vs. human) and the extraction layer
(reading events table entries into intent nodes).
