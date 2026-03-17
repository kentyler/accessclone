# Intent Graph — Artifact Extension Summary

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

The graph structure does not change. Node types do not change. Edge
types do not change. The runtime does not change.

The single change is to the artifact model.

Currently an artifact is a value produced or consumed by a node during
execution — a form result, a query result, a field value, a generated
report. The extension broadens what an artifact can be: any referenceable
output of a human-LLM conversation about the business.

Examples of the new artifact type:
- a diagnostic report produced by a qualifying analysis conversation
- a client specification document produced by a scoping conversation
- a decision record produced by a review conversation
- a periodic digest produced by a managed service monitoring conversation
- a patch proposal produced by a community pattern conversation
- a migration plan produced by an intake conversation

The node that produces a diagnostic report is structurally identical to
the node that produces a query result. The node that consumes a client
specification before generating an intent tree update is structurally
identical to the node that consumes a lookup value before branching. The
graph does not know the difference. The runtime does not need to.

---

## What This Enables

Human-LLM conversations become first-class participants in the graph —
not by adding new node types, but by treating the artifacts those
conversations produce as referenceable outputs that downstream nodes can
consume.

The conversation happens outside the graph. Its artifact enters the
graph at a defined input point. The graph continues.

This means the same intent graph that models a client's Access
application can model the business operations surrounding it — client
intake, migration execution, managed service monitoring, community
pattern detection — because all of those operations produce and consume
artifacts in the same way application operations do.

The boundary between application logic and business logic is
representational, not architectural. Both are processes. Both produce
and consume artifacts. The graph represents both with the same
structure.

---

## Artifact Schema Extension

The current artifact model needs one additional property to accommodate
non-code artifacts:

```json
{
  "id": "artifact_ref",
  "type": "form_result | query_result | field_value | report | document | decision | conversation_record",
  "label": "string",
  "produced_by": "node_ref | conversation_ref",
  "content_ref": "uri | events_table_ref",
  "consumed_by": ["node_ref"]
}
```

The only additions are:
- new `type` values for non-code artifacts
- `conversation_ref` as a valid `produced_by` source
- `content_ref` to locate the artifact in the events table or an
  external store

Everything else is unchanged.

---

## The Events Table Connection

Non-code artifacts produced by human-LLM conversations are recorded in
the events table as immutable fact entries, the same way application
execution events are recorded.

The artifact's `content_ref` points to its events table entry. Downstream
nodes that consume the artifact resolve it through the same lookup
mechanism they use for any other artifact.

The events table therefore holds both the execution trace of application
operations and the artifact record of business conversations. Both are
queryable through the same interface. Both are inputs to the trigger
layer and the LLM's ongoing model of what is happening.

---

## What Needs to Be Built

1. **Artifact schema extension** — add new type values and
   `conversation_ref` as a valid producer to the existing artifact
   schema definition

2. **Conversation artifact recorder** — writes the output of a
   human-LLM conversation to the events table and returns an artifact
   reference that can be inserted into the graph

3. **Artifact resolver update** — extends the existing artifact lookup
   to handle `events_table_ref` as a content location alongside
   existing resolution paths

---

## What Does Not Change

- Graph structure
- Node types
- Edge types
- Expression evaluator
- Runtime traversal and execution logic
- LLM read/write interface to the graph
- Events table schema

---

## Prototype Path

1. Add new artifact type values to the schema
2. Hand-author a small business operation subgraph — the qualifying
   analysis pipeline is a good candidate — using existing node types
   but with document artifacts as inputs and outputs
3. Write a conversation artifact to the events table manually and
   reference it in the subgraph
4. Feed the subgraph to the existing runtime and observe what breaks

The hypothesis: nothing structural breaks. The only gaps will be in
artifact resolution — the runtime encounters a `conversation_ref` or
`events_table_ref` it doesn't yet know how to resolve. That is a
bounded addition, not an architectural revision.
