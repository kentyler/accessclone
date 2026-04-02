# Trace Convention: Double-Entry Changelog

<!-- INTENTS EXTRACTED → intents.json:
  whole file → double-entry-traces, forecloses-opens-topology
-->

When recording significant changes in HANDOFF.md, use the double-entry format. This ensures a future LLM reading the trace knows both what happened (expression) and what it was of (corona).

## Format

```
**EVENT**: [short name]

**EXPRESSION** (what changed):
- [actualized changes — deletions, modifications, schema alterations, test counts]
- [the leading visible terms of the perturbation]

**CORONA** (what this is of):
- [which theoretical document and section this enacts, by reference not summary]
- [what the change means for the engagement surface]

**WHAT THIS FORECLOSES**:
- [patterns, operations, or assumptions that are no longer available]

**WHAT THIS OPENS**:
- [new possibilities, changed character of adjacent elements]

**THEORETICAL GROUND**: [document references]
```

## Principles

1. **Corona entries reference theoretical documents by section, not summarize them.** The future LLM will have those documents in context — the trace's job is to point, not to re-explain.

2. **Propagation matters.** Note what adjacent elements change character because of this change — recon, FIM, skill files, graph queries — even if those elements were not directly modified.

3. **Forecloses/Opens is not pro/con.** It is topology — which paths in the possibility space closed, which opened. Both are real consequences that shape future engagement.

4. **The expression side is mechanical.** Files changed, functions deleted, tests passing. It should be complete enough for another developer to understand the diff without reading it.

5. **The corona side is theoretical.** It connects the mechanical change to the engagement surface framework. Without it, the trace is a changelog. With it, the trace carries the double-entry: what the system did and what the system is becoming.

## When to Use

- Architectural changes that alter what the system can express
- Changes that enact theoretical framework decisions (engagement-surface.md, capability-ontology.md)
- Removals or additions that change the character of adjacent subsystems

Not needed for routine bug fixes, test additions, or mechanical refactors that don't shift the engagement surface.
