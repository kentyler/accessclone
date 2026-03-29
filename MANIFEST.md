# Document Manifest

Guide for AI agents. Files marked **STARTUP** should be read in full at session start. All others: read the summary here, then read the full file only when working on that topic.

## Startup Files

| File | Summary |
|------|---------|
| `CLAUDE.md` | **STARTUP** — Coding conventions, implementation details, state management, API routes, testing matrix, known issues. The primary reference for all code changes. |
| `HANDOFF.md` | **STARTUP** — Session handoff: shipped features chronology, known landmines, in-progress work, conventions. Read this to understand current project state. |
| `tasks.md` | **STARTUP** — Pending and completed project tasks. Check before starting new work. |

## Root-Level Docs

| File | Summary |
|------|---------|
| `README.md` | Public project description, features list, quick start, OpenClaw appendix. Read when updating public-facing docs. |
| `PRODUCT.md` | Product vision, intent-based migration philosophy, transform architecture as AI substrate, three-phase trajectory. Read when making architectural decisions. |
| `ARCHITECTURE.md` | Multi-DB isolation, state management (why not re-frame), data flow, key design decisions. Read when modifying state management or data flow. |
| `INSTRUCTIONS.md` | Setup runbook for humans and AI agents, distinguishes shell-access vs chat-only tool modes. Read when modifying setup/install flow. |
| `CHANGELOG.md` | Version history (v0.2.0 through unreleased). Update when shipping features. |
| `CONTRIBUTING.md` | Contributor guidelines, PR process. Rarely needs changes. |
| `CODE_OF_CONDUCT.md` | Standard Contributor Covenant v2.0. Almost never needs changes. |
| `server/README.md` | Backend route file reference table (one-line per route file). Read when adding/modifying server routes. |

## Skills — Conversion Pipeline

Read in order for the full import workflow.

| File | Summary |
|------|---------|
| `skills/conversion.md` | Master orchestrator: 7-phase workflow, import order, completion checklist. Read first when working on any import feature. |
| `skills/conversion-setup.md` | Phase 1: DB creation, schema setup, infrastructure, git init. |
| `skills/conversion-tables.md` | Phase 2: Table migration — type mapping (Access→PG), PK detection, index creation, data transfer. |
| `skills/conversion-queries.md` | Phase 3: Query→view/function conversion, regex pipeline, LLM fallback, retry loop, form-state cross-joins. |
| `skills/conversion-forms.md` | Phase 4: Form import — twips→pixels, control type mapping, section organization, property normalization. |
| `skills/conversion-vba.md` | Phase 5: VBA→PostgreSQL functions — session-state pattern, validator/executor/orchestrator. |
| `skills/conversion-vba-js.md` | VBA translation guide — VBA-to-JS parser patterns, runtime API (`window.AC`), intent extraction pipeline, common VBA patterns reference. |
| `skills/conversion-macros.md` | Phase 6: Macro import — LoadFromText format, XML macros, action mapping, translation strategy. |

## Skills — Architecture & Design

| File | Summary |
|------|---------|
| `skills/import-patterns.md` | **START** Known import patterns checklist — every solved problem with status (automated/partial/not-implemented). Consult when working on import pipeline. |
| `skills/form-design.md` | Form definition JSON structure — control types (15), layout (twips grid), binding, sections, hotkeys, continuous/popup/modal. |
| `skills/form-state-sync.md` | Cross-form state sync architecture — control_column_map, session_state cross-join, runtime population, import ordering. |
| `skills/updatable-queries.md` | View write-target resolution — Access updatable queries vs PG read-only views, view_metadata table, INSTEAD OF triggers. |
| `skills/database-patterns.md` | PostgreSQL function patterns — session-state access, validator/executor/orchestrator pattern, naming conventions. |
| `skills/transform-architecture.md` | Pure transform architecture — 3 layers (transforms/flows/effects), 5 build phases, VBA intent mapping, domain registry. |
| `skills/capability-ontology.md` | Three-layer model (Could Do / Should Do / Doing Now), four primitives (Boundary/Transduction/Resolution/Trace), Deleuzian reading. |
| `skills/access-system-tables.md` | MSys* table handling — what to import, what to skip, graph/intent implications. |

## Skills — AI & Automation

| File | Summary |
|------|---------|
| `skills/intent-extraction.md` | VBA intent extraction LLM prompt — 30 intent types, trigger mapping, JSON output schema, gap questions, decomposition examples. |
| `skills/ai-import.md` | AI agent import skill — two paths: full-pipeline (Claude Code, local machine) vs post-extraction (Codex, cloud sandbox). |
| `skills/event-runtime.md` | Event runtime for forms & reports — intent interpreter async model, supported events, intent types, branch conditions, criteria resolution, server endpoints, file map. |

## Skills — Development Guides

| File | Summary |
|------|---------|
| `skills/codebase-guide.md` | Pipeline-oriented walkthrough of every subsystem — best starting point for understanding the codebase. |
| `skills/render-levels.md` | Progressive render level system — 5-level debug/dev tool for form/report/table/query rendering. Full implementation plan for forms, cross-object architecture. |
| `skills/testing.md` | Test map, patterns, coverage gaps, templates for writing new tests. Read before adding tests. |
| `skills/install.md` | Installation assistant skill — auto-detect environment, PostgreSQL setup, troubleshooting steps. |
| `skills/writing-skills.md` | Meta-guide for writing new skill files — cross-platform patterns, structure checklist, examples. |

## Skills — Three Horse Website

| File | Summary |
|------|---------|
| `skills/three-horse-chat.md` | System prompt for the Three Horse chat — loaded when `database_id = 'threehorse'`. Covers what TH does, platforms, migration process, AI partner, pricing, qualifying analysis. |

## Other Docs

| File | Summary |
|------|---------|
| `docs/northwind-openclaw.md` | Northwind automation analysis (70% mechanical / 20% LLM-assisted / 10% gap), OpenClaw integration vision. |
| `databases/accessclone/notes.md` | Per-database notes (AccessClone DB). Empty template. |
| `databases/threehorse/notes.md` | Per-database notes (ThreeHorse DB). Empty template. |
| `databases/threehorse/seed-pages.sql` | SQL to insert the three website page forms (About, Qualifying Analysis, How It Works) into shared.forms. |
| `.github/ISSUE_TEMPLATE/bug_report.md` | GitHub bug report template. |
| `.github/ISSUE_TEMPLATE/feature_request.md` | GitHub feature request template. |
| `.github/PULL_REQUEST_TEMPLATE.md` | GitHub PR template. |

## Business

| File | Summary |
|------|---------|
| `THREE-HORSE-PRELIMINARY.md` | Preliminary business concept — multi-platform legacy migration + spreadsheet extraction + app builder. Revenue model, market analysis, competitive advantage, technical architecture. Domain: three.horse. |
