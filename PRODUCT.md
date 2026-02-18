# AccessClone — Product Description

## The Problem

There are roughly 100 million Microsoft Access databases in the world. They encode purchase orders, inventory tracking, patient intake, compliance workflows, fleet management, student records — the operational backbone of organizations that can't justify enterprise software but need more than spreadsheets.

These databases work. Many have worked for decades. But they're stuck: one user at a time, one desktop at a time, one operating system. The business logic accumulated in their forms, queries, and VBA modules represents years of institutional knowledge about how the organization actually operates — knowledge that exists nowhere else.

The standard migration advice is: rewrite from scratch. Hire developers, interview users, build a new system. This throws away the most valuable part of the Access database — the working specification of the business process — and replaces it with someone's interpretation of what users said they wanted.

## What AccessClone Does

AccessClone imports an Access database — tables, queries, forms, reports, VBA modules — into a PostgreSQL-backed web application that runs in a browser. Not a generic database viewer. A faithful reproduction of the application the user already knows, with the same forms, the same navigation, the same business rules.

**Tables and data** import with full type fidelity — constraints, indexes, identity columns, and every row.

**Queries** convert from Access SQL to PostgreSQL views and functions. A regex-based converter handles the common patterns (bracket syntax, Access-specific functions, date literals). When that fails, an LLM reads the original SQL, the PostgreSQL error, and the full schema context, and produces a working conversion. The system tracks which queries needed LLM assistance so you know where to look.

**Forms** render in the browser with the same layout, the same controls (text boxes, combo boxes, subforms, tab controls, buttons), the same record navigation. Design View lets you drag, drop, and resize controls. Form View shows live data. The Property Sheet has the same tabs Access users expect: Format, Data, Event, Other, All.

**Reports** render with banded sections — report header/footer, page header/footer, detail, and dynamic group bands with configurable grouping, sorting, and intervals. A live preview shows actual data with group-break detection.

**VBA modules** go through a three-stage pipeline that doesn't translate code line by line:

1. An LLM reads the VBA and produces structured intents — not code, but a declaration of what the code means to do: "validate this field," "save the record," "open this form with a filter."
2. Each intent is classified: mechanical (maps to a deterministic template), LLM-assisted (needs targeted AI generation for domain-specific logic like DLookup), or gap (needs human review).
3. Mechanical intents produce code from templates. LLM-assisted intents get focused generation with full schema context. Gaps are flagged with concrete questions and suggestions — not silently guessed at.

The result is clean, idiomatic code with clear traceability back to the original VBA. Every generated line can be traced to a specific intent, which traces to a specific VBA procedure.

## How It Works — The Pipeline

### Import

The import pipeline runs through the browser UI. Point it at an `.accdb` or `.mdb` file (`.mdb` is automatically converted), and AccessClone lists every object in the database. Import objects individually or in bulk:

- **Tables**: Server-side pipeline — PowerShell exports via DAO, Node.js maps Access type codes to PostgreSQL types, creates tables with batch inserts, and rebuilds indexes. All in one transaction.
- **Queries**: Multi-pass retry loop handles dependency ordering — if query A depends on query B, B is imported first. Failed queries retry across passes until the dependency graph resolves.
- **Forms and reports**: Frontend extracts via PowerShell, converts client-side, saves to the server. Definitions are stored as JSON with append-only versioning — every save creates a new version, previous versions are retained.
- **Modules**: Source code is extracted and stored. Intent extraction happens later, on demand or in batch.

### Conversion Intelligence

The system applies intelligence at specific, bounded points:

**Query conversion** uses a deterministic regex engine for ~90% of queries. The LLM fallback activates only when the regex output fails PostgreSQL execution, and only for genuine conversion errors — dependency errors (missing tables or functions) are handled by the retry loop, not the LLM. This means the LLM is never asked to guess about objects that simply haven't been imported yet.

**Intent extraction** uses the LLM to read VBA and produce structured JSON, not to write code. The vocabulary is fixed — 30 intent types that cover the operations Access applications actually perform. The LLM's job is classification, not generation. If it encounters something outside the vocabulary, it produces a gap with a question, not a hallucinated implementation.

**Code generation** is mostly mechanical. Of the 30 intent types, 22 have deterministic templates that produce identical code every time. The remaining 8 (DLookup, DCount, DSum, RunSQL, loops, and a few others) get targeted LLM generation with full graph context — the LLM knows every table, column, form, and control in the database.

### Batch Pipeline

The App Viewer provides a whole-application view with a three-step batch pipeline:

1. **Extract All** — Extract intents from every VBA module in one pass. Gap questions are collected across all modules and presented together.
2. **Resolve Gaps** — Gaps whose referenced objects exist in the database are auto-resolved. Remaining gaps are presented to the user with concrete suggestions. Submit all decisions at once.
3. **Generate All Code** — Multi-pass code generation with dependency retry. Modules whose intents reference objects that haven't been generated yet are deferred to subsequent passes. The loop continues while progress is made, up to 20 passes — the same pattern used for query imports.

After the batch pipeline completes, individual modules can be revisited for refinement. By that point all endpoints exist in the graph, so single-module generation references real objects.

### AI Chat

Every object in the application has a built-in chat panel. The AI sees the full definition and data context — not a generic prompt, but the actual form structure, report bands, column types, and record source.

- Auto-analyzes forms, reports, and modules on first open — describes structure, identifies issues
- Searches and analyzes records through natural language
- Queries the dependency graph — "What tables does this form reference? What would break if I renamed this column?"
- Extracts intents and generates code interactively
- Validates cross-object bindings and suggests fixes

## The Transform Architecture — A Prelude to Automation

Underneath the browser UI, AccessClone's frontend is built on a pure transform architecture. This is the design choice that makes the system AI-operable, not just AI-assisted.

### What transforms are

Every state change in the application — selecting a control, saving a record, navigating to the next row, opening a form, filtering a combo box — is a named, pure function:

```
(state, args) → new state
```

There are 80 transforms across 10 domains (UI, chat, form, report, table, query, module, macro, logs, app). Each one is registered by keyword name in a central registry:

```clojure
:select-control     ;; (state, section, index) → state with control selected
:save-record        ;; (state) → state with current record saved
:set-filter         ;; (state, filter-string) → state with filter applied
:navigate-to-record ;; (state, position) → state at new record position
```

Transforms are composed into flows — sequences of transforms and effects that implement user-visible behaviors:

```
User clicks Save →
  [:validate-required-fields]
  [:lint-form (http effect)]
  [:save-to-api (http effect)]
  [:mark-form-clean]
  [:show-message "Saved"]
```

### Why this matters for AI

A traditional application has code that does things. An AI assistant can read the code and explain what it does, or generate new code that does similar things. But the AI is always working with text — source code that must be parsed, understood, and regenerated.

AccessClone's transform architecture gives an AI something different: an **action space**. The complete set of things the application can do is enumerable, finite, and named. An AI doesn't need to write code to operate the application — it needs to compose transforms.

Combined with the intent extraction pipeline, this creates a three-layer structure:

| Layer | What it contains | What it represents |
|-------|-----------------|-------------------|
| **Intent graph** | 30 typed intents per module (validate, save, open-form, dlookup...) | What the business process *means to do* |
| **Transform catalog** | 80 named transforms with declared inputs, outputs, and domains | What the application *can do* |
| **Dependency graph** | Tables → columns → forms → controls → intents | How everything *connects* |

An autonomous agent reading these three layers doesn't need to understand VBA, ClojureScript, or PostgreSQL. It needs to understand the business process (intent graph), know what actions are available (transform catalog), and understand the data model (dependency graph). This is a fundamentally different — and more tractable — problem than "read this codebase and figure out what to do."

### From migration tool to operational substrate

The usual trajectory for a migration tool is: import the old system, verify it works, turn off the old system, maintain the new one. The migration tool's job is done.

AccessClone's structured output suggests a different trajectory:

**Phase 1: Migration.** Import the Access database. Verify forms, reports, and queries work. Users interact with the browser UI the same way they interacted with Access.

**Phase 2: AI-assisted operation.** The chat assistant already understands every object. It can search records, analyze data, explain form logic, and suggest improvements. Users work faster because they have a knowledgeable assistant that understands their specific application — not a generic chatbot, but one that has read every form definition, every VBA module, every table schema.

**Phase 3: AI-automated operation.** This is where the transform architecture pays off. An autonomous agent can:

- Read the intent graph for a purchase order workflow: "When a new order arrives, validate the customer exists (DLookup), check inventory (DCount), create the order record (save-record), update stock levels (run-sql), and notify the warehouse (show-message → email)."
- Map each intent to transforms: `[:validate-required :dlookup :dcount :save-record :run-sql :show-message]`
- Execute the workflow against the database through the existing API — the same API the browser UI uses.
- Handle variations by reading the branching logic in the intent graph: "If inventory is below reorder point, also create a purchase order."

The agent doesn't need screen access, browser automation, or code generation. It reads a structured specification of the business process and executes it through a finite set of named operations. The browser UI becomes a development and debugging tool. The production runtime is the agent.

### What this looks like in practice

Consider a medical office that runs on an Access database. Today, a receptionist opens the Patients form, looks up a patient, checks their insurance status (DLookup against the Insurance table), schedules an appointment (new record in Appointments), and sends a confirmation (action query).

After AccessClone migration:

- **Phase 1**: The receptionist does exactly the same thing, but in a browser. Multiple receptionists can work simultaneously. The office can access the system from any device.
- **Phase 2**: The receptionist asks the chat assistant "Which patients have upcoming appointments but expired insurance?" The AI queries the dependency graph, writes the SQL, and presents the results — in seconds, instead of the custom report someone would have had to build in Access.
- **Phase 3**: An AI agent monitors incoming appointment requests (from a web form, email, or messaging platform), automatically validates insurance status, checks provider availability, creates the appointment record, and sends confirmations — all by executing the same intent sequence the receptionist used to follow manually.

The business logic doesn't change across these phases. The intent graph is the same. The transforms are the same. What changes is who — or what — is composing them.

## Technical Foundation

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Frontend | ClojureScript / Reagent | Single-page application with design editors |
| Backend | Node.js / Express | REST API, schema routing, LLM integration |
| Database | PostgreSQL | Schema-per-database isolation, full SQL capability |
| Import | PowerShell / COM | Extract from Access via DAO automation |
| AI | Anthropic Claude | Intent extraction, gap resolution, chat assistance |

**80 pure transforms**, registered by keyword, composable into flows. Every state transition is named, testable, and enumerable.

**75 flows** connecting transforms to effects (HTTP calls, DOM operations). Each flow is a declarative sequence, not imperative code.

**30 intent types** covering the operations Access applications perform. Fixed vocabulary — the LLM classifies, it doesn't invent.

**A dependency graph** tracking every structural relationship (table contains column, form binds to field, control references query) and every business intent (form serves "customer management," procedure implements "order validation").

**334 automated tests** across the server and desktop layers. Query converter alone has 95 tests validating Access SQL → PostgreSQL conversion.

## Who This Is For

**Organizations with critical Access databases** that need multi-user access, browser-based operation, or integration with modern systems — but can't afford (in time, money, or institutional knowledge) to rewrite from scratch.

**IT departments managing Access portfolios** — dozens or hundreds of Access databases across the organization, each encoding its own business process. AccessClone provides a systematic migration path and, through the intent graph, a machine-readable inventory of what each database actually does.

**AI agent developers** looking for structured representations of real-world business processes. The intent graph, transform catalog, and dependency graph are not abstractions designed for a demo — they're extracted from production Access databases that run actual businesses. This is the training ground for agents that operate, not just advise.

## The Thesis

The bottleneck for automating routine business operations isn't AI capability. Models can already read, reason, and act. The bottleneck is structured access to what the business actually does — the specific validation rules, data lookups, conditional logic, and workflow sequences that constitute a business process.

One hundred million Access databases contain exactly this information, encoded as forms, queries, and VBA modules. But it's trapped in a proprietary binary format that no AI can reason over, on desktop machines that no API can reach.

AccessClone is the extraction layer. It turns opaque Access databases into structured, machine-operable specifications: typed intents, named transforms, a dependency graph, and standard PostgreSQL. The browser UI is a development and debugging tool — a way for humans to verify the extraction is correct and refine the edge cases.

The real output is a business process that a machine can read, understand, and execute.
