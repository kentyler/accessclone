# A Corpus That Writes Back

## What It Is

The corpus is an append-only table (`shared.corpus_entries`) where entries accumulate regardless of origin. Notes, messages, emails, and meetings are not different apps with different data models — they are entries in a single corpus distinguished by metadata. A Slack message is an entry with author and channel metadata. An email is an entry with sender, recipients, and a subject. A meeting is a set of entries sharing a session ID.

The LLM reader is the payoff: it reads across all entry types and surfaces connections that app-category boundaries would hide.

The four architectural primitives (Boundary, Transduction, Resolution, Trace) do the structural work; the UI just decides what to foreground.

### Notes (the original view)

The Notes view is the first and currently only UI over the corpus. A human writes entries and an LLM reads each new entry against everything that came before, responding with what changed, connected, or was revealed. It is not a chatbot. It is a second reader — someone who has read everything and notices what the writer might not see from inside the act of writing.

The corpus is global (not per-database) and chronological. There are no categories, tags, folders, or organization features. Entries accumulate. The LLM's responses interleave with the human's entries in the same stream.

## How It Works

1. Human writes an entry in the center pane and submits (button or Ctrl+Enter). The text stays visible while processing.
2. The server saves the human entry to `shared.corpus_entries`.
3. The entry is embedded via OpenAI `text-embedding-3-small` (or Google `text-embedding-004` fallback), stored as `vector(768)` in pgvector.
4. The secretary LLM inspects the entry and makes two judgments: which model(s) should respond, and which corpus sampling strategy to use. Sampling strategy and reasoning are persisted on the human entry.
5. Context retrieval: the chosen sampling strategy is executed (similarity, distance, random, time_range, or mixed). Default is similarity — the 20 most similar entries via `embedding <=> query_vector`. Falls back to recency if no embeddings.
6. Each selected LLM receives the new entry (primary) with corpus context (background). Temperature is taken from each model's registry config and persisted on the response.
7. Each LLM response is saved as a separate entry with `parent_id`, `model_name`, and `temperature`, then embedded (fire-and-forget).
8. Both entries appear in the sidebar. The human entry shows in the center pane; the LLM responses show in the right pane with response conditions (model, temperature, sampling dropdowns + reasoning text).

**Retry/Regenerate**: The user can change the model, temperature, or sampling dropdowns on any response card and click Retry. This calls `POST /api/notes/:id/regenerate` with the chosen settings. A new response is generated and appended as a sibling — the original response is preserved (append-only).

If no embedding API key is configured, retrieval falls back to recency. If no LLM key is configured, the human entry is saved with no responses.

## The LLM System Prompt

The system prompt instructs the LLM to respond primarily to the new entry's content, with the corpus as background context. The LLM may:

- Extend or challenge the entry's argument
- Surface implications the writer may not see from inside the act of writing
- Connect the entry to earlier corpus threads when it illuminates the current entry
- Ask a question — the kind a careful reader would ask

The LLM is explicitly told not to: summarize, praise, advise (unless asked), or comment on the corpus itself (patterns, duplicates, metadata, structure).

The response should feel like marginalia. Plain prose, no formatting. Length varies naturally.

## Secretary Routing

The secretary LLM receives each new entry and decides which registered models should respond. The routing criterion is not structurally enforced — the secretary decides on what basis to route (topic, complexity, interpretive work needed). This is intentional: premature enclosure of a routing ontology would constrain emergence. Multiple models can respond to the same entry; their responses are stored as siblings with `parent_id`. Divergence between readers is not tracked by a dedicated entity — it re-enters the corpus as content and becomes retrievable context for future entries.

## Semantic Retrieval

Context is selected by vector similarity, not recency. Every entry (human and LLM) is embedded on creation using OpenAI `text-embedding-3-small` (768 dimensions, stored via pgvector). On each new prompt, the 20 most similar entries across the full corpus are retrieved. An entry from day one is as reachable as one from yesterday.

Fallback: if no embedding API key is configured, or pgvector is not installed, retrieval degrades to 20 most recent entries. Embedding failures never block entry submission.

Backfill: `POST /api/notes/backfill-embeddings` embeds all existing entries that lack embeddings.

## Architecture

### Database

Table: `shared.corpus_entries` (created in `server/graph/schema.js`)

**Core columns** (original):

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | Entry ID |
| entry_type | VARCHAR(10) | `'human'`, `'llm'`, or `'system'` |
| content | TEXT | The entry text |
| parent_id | INTEGER (FK) | For LLM entries, points to the human entry it responds to |
| model_name | TEXT | Which LLM produced this response (NULL for human entries) |
| embedding | vector(768) | pgvector embedding for semantic retrieval (NULL if not yet embedded) |
| temperature | REAL | LLM temperature used for this response (on LLM rows) |
| sampling_strategy | VARCHAR(30) | Corpus sampling strategy used (on human rows: similarity/distance/random/time_range/mixed) |
| routing_reasoning | TEXT | Secretary's one-line explanation of routing decision (on human rows) |
| created_at | TIMESTAMPTZ | Timestamp |

**Unified corpus columns** (added for multi-medium support):

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| medium | VARCHAR(20) | `'note'` | What kind of communication: note, message, email, meeting |
| author | TEXT | NULL | Who wrote/sent it. NULL = the instance user (backward compat for notes) |
| recipients | TEXT | NULL | Comma-separated. For emails (To line), DMs. NULL for notes/meetings |
| thread_id | INTEGER (FK) | NULL | Groups entries into conversations. Thread root: thread_id = own id |
| session_id | TEXT | NULL | Groups entries from same synchronous session (meetings, sprints) |
| subject | TEXT | NULL | Email subject line, meeting title |
| metadata | JSONB | NULL | Medium-specific fields (cc/bcc, platform, channel, recording_url, etc.) |

**How each medium maps:**

| | Note (existing) | Message | Email | Meeting |
|---|---|---|---|---|
| entry_type | human/llm | human/system | human/system | human/llm/system |
| medium | 'note' (default) | 'message' | 'email' | 'meeting' |
| author | NULL (implied) | sender handle | sender address | speaker name |
| recipients | NULL | DM target(s) | To addresses | NULL (broadcast) |
| thread_id | NULL | thread root id | email chain root | NULL |
| session_id | NULL | NULL | NULL | shared meeting UUID |
| subject | NULL | NULL | subject line | meeting title |
| metadata | NULL | {channel, platform} | {cc, bcc, message_id} | {scheduled_at, duration, platform} |

**Indexes**: `created_at DESC`, `parent_id WHERE NOT NULL`, plus partial indexes on `medium` (WHERE != 'note'), `thread_id`, `session_id`, `author` (all WHERE NOT NULL), and `(medium, created_at DESC)`.

Requires: `CREATE EXTENSION IF NOT EXISTS vector` (pgvector must be installed in PostgreSQL).

**Backward compatibility**: All new columns are nullable with defaults. Existing notes rows get `medium = 'note'`, all other new columns NULL. No changes to `notes.js` API routes or frontend — they continue to work unchanged.

### API Endpoints

Mounted at `/api/notes` in `server/app.js`. Excluded from database schema routing middleware (accesses shared schema only).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notes` | Fetch recent entries (default 200, max 1000, most recent first) |
| GET | `/api/notes/:id` | Fetch a single entry + its LLM responses (if entry_type is human). Backward-compat: if no `sampling_strategy` on human entry, looks it up from `corpus_retrievals.strategy`. |
| POST | `/api/notes` | Create human entry, embed, secretary routes (sampling + models), persist routing metadata, LLMs respond, return all |
| POST | `/api/notes/:id/regenerate` | Re-generate a response for an existing human entry with user-chosen model/temperature/sampling. Returns 502 with message on LLM errors. |
| POST | `/api/notes/backfill-embeddings` | Embed all entries missing embeddings |

POST `/api/notes` body: `{ content: string }`
POST `/api/notes` response: `{ entry: {...}, responses: [...], reasoning: string, routing: { sampling, reasoning } }`
POST `/api/notes/:id/regenerate` body: `{ model_name: string, temperature: number, sampling: string }`
POST `/api/notes/:id/regenerate` response: `{ response: {...} }`
POST `/api/notes/backfill-embeddings` response: `{ processed: N, total: M, pending: P }`

### Server (`server/routes/notes.js`)

- Receives `pool`, `secrets`, and `settingsDir` (for LLM registry).
- On POST: inserts human entry → embeds via `embedAndStore()` → retrieves context via `retrieveContext()` (semantic or recency fallback) → formats as `[H]`/`[R]` markers → routes via secretary → selected LLMs respond in parallel → each response inserted and embedded (fire-and-forget).
- Multi-LLM: secretary routing via `routePrompt()`, parallel fan-out via `Promise.allSettled()`, fallback to Claude Sonnet if no registry.
- `embedAndStore()` and `retrieveContext()` are fully wrapped in try/catch — never break the POST flow.
- Graceful degradation: no embedding key → recency fallback; no LLM key → entry saved with no responses; pgvector not installed → embedding silently skipped.

### Embeddings (`server/lib/embeddings.js`)

- `embed(text, secrets)` — dual-provider: OpenAI `text-embedding-3-small` checked first, Google `text-embedding-004` fallback. Both normalize to 768 dimensions. Never throws, returns null on failure.
- `pgVector(embedding)` — formats float array as pgvector literal string for SQL.
- Provider keys in `secrets.json`: `openai.api_key`, `gemini.api_key`. Optional model overrides: `openai.embedding_model`, `gemini.embedding_model`.

### Frontend State (`ui/src/app/state.cljs`)

Six keys in `app-state`:

| Key | Type | Description |
|-----|------|-------------|
| `:notes-entries` | vector | All entries for sidebar display |
| `:notes-selected-id` | int/nil | Currently selected entry ID |
| `:notes-input` | string | Textarea content |
| `:notes-loading?` | boolean | True while waiting for LLM response |
| `:notes-read-entry` | map/nil | Currently displayed human entry |
| `:notes-read-responses` | vector | Currently displayed LLM responses (supports multiple) |

### Transforms (`ui/src/app/transforms/notes.cljs`)

Eight pure state transforms:

| Transform | Args | Effect |
|-----------|------|--------|
| `:set-notes-entries` | entries | Replace all entries |
| `:add-notes-entry` | entry | Prepend entry to list (most recent first) |
| `:set-notes-selected` | id | Set selected entry ID |
| `:set-notes-input` | text | Update textarea |
| `:set-notes-loading` | bool | Toggle loading state |
| `:set-notes-read-entry` | entry, responses | Set both read pane values |
| `:append-notes-response` | response | Append a new response to read pane and prepend to sidebar |
| `:set-notes-regenerating` | bool | Toggle regenerating state (for Retry button) |

### Flows (`ui/src/app/flows/notes.cljs`)

Three flows:

| Flow | Trigger | What it does |
|------|---------|-------------|
| `load-notes-flow` | Page mount | GET /api/notes, dispatch `:set-notes-entries` |
| `submit-entry-flow` | Submit button / Ctrl+Enter | Set loading (input stays visible), POST content, clear input on response, add all entries to sidebar, show in read pane |
| `select-entry-flow` | Click sidebar entry | GET /api/notes/:id, set read pane with entry + response |

### View (`ui/src/app/views/notes.cljs`)

Three-pane layout inside `notes-page`:

| Pane | Component | Width | Content |
|------|-----------|-------|---------|
| Left | `notes-sidebar` | 280px | Chronological entry list, colored left border (blue=human, purple=LLM), relative timestamps, first-line previews |
| Center | `notes-entry-pane` | flex | Textarea for writing (or read-only view of selected entry's content), submit button, "+" new entry button |
| Right | `notes-read-pane` | flex | LLM response for selected entry (read-only) |

- `notes-page` wraps everything with a "Back to Hub" link.
- Entries load on component mount.
- Ctrl+Enter keyboard shortcut for submit.

### Routing (`ui/src/app/views/main.cljs`)

`:notes` case in the page router renders `notes/notes-page`.

### Hub Integration (`ui/src/app/views/hub.cljs`)

- "Notes" appears in the hub left menu.
- The hub right panel shows the 5 most recent notes when Notes is selected.
- Clicking "Open" navigates to the full notes page (`:current-page :notes`).
- Notes are loaded via `load-notes-flow` when the hub mounts.

### CSS (`ui/resources/public/css/style.css`)

Full styling at lines ~323-568:
- Sidebar: 280px, light background, scrollable, entry items with 3px left border (blue for human, purple for LLM)
- Entry pane: flex column, full-height textarea with no borders, line-height 1.6
- Read pane: light background, read-only display with left border matching entry type
- Hub integration: recent notes list in hub right panel

## Current Status

Unified corpus schema added 2026-02-23. The `medium` column distinguishes notes, messages, emails, and meetings within the same table. All new columns are nullable — existing notes are unaffected. The Notes UI is the only view currently implemented; message/email/meeting views are future work.

Semantic retrieval and multi-LLM routing added 2026-02-21. Entries are embedded on creation; context is selected by vector similarity across the full corpus. System prompt rewritten to focus on entry content over corpus patterns.

## Design Decisions

- **One table, many views.** Notes, messages, emails, and meetings share `shared.corpus_entries`. The `medium` column distinguishes them; the UI decides what to foreground. The LLM reads across all mediums.
- **Metadata, not models.** A Slack message differs from a note only in having author and channel metadata — not in being a fundamentally different entity. The schema encodes this directly.
- **Append-only, no editing or deleting.** The corpus grows. Nothing is removed.
- **Global, not per-database.** The corpus is about the user's thinking and communication, not about a specific Access database.
- **Semantic retrieval, not recency.** Context is the 20 most similar entries, not the 20 most recent. An entry from day one is as reachable as yesterday's. Retrieval crosses medium boundaries.
- **Entry-first prompting.** The new entry is primary; corpus is background context. The LLM engages with the entry's substance, not the corpus's structure.
- **Secretary routing is opaque.** The secretary decides how to route — no hardcoded ontology. Routing criteria can emerge as the corpus grows.
- **Divergence is implicit.** Multiple LLM responses are stored as siblings. No entity watches the differential — divergence re-enters the corpus as content.
- **Multi-provider embeddings.** OpenAI first, Google fallback. Both normalize to 768 dims. Switching providers requires backfilling.
- **Interleaved entries.** Human and LLM entries live in the same stream, visible in the sidebar.
- **Graceful degradation at every layer.** No embedding key → recency fallback. No LLM key → entry saved, no responses. pgvector missing → embedding silently skipped. Nothing blocks entry submission.
- **Three-pane layout.** Sidebar for navigation, center for writing/viewing entries, right for reading LLM responses. Input stays visible during processing.
- **`'system'` entry_type.** For automated/structural entries: meeting start markers, email forwarding receipts, import artifacts. Distinct from 'human' (written by a person) and 'llm' (generated by a model in response to a human entry).

## Files

| File | Role |
|------|------|
| `server/routes/notes.js` | API endpoints, LLM prompt, semantic retrieval, secretary routing |
| `server/lib/embeddings.js` | Embedding API (OpenAI + Google), pgvector formatting |
| `server/graph/schema.js` | Table DDL for `shared.corpus_entries`, pgvector extension |
| `server/app.js` | Route mounting at `/api/notes` |
| `ui/src/app/transforms/notes.cljs` | 6 pure state transforms |
| `ui/src/app/flows/notes.cljs` | 3 flows (load, submit, select) |
| `ui/src/app/views/notes.cljs` | Three-pane UI |
| `ui/src/app/views/main.cljs` | Page routing |
| `ui/src/app/views/hub.cljs` | Hub integration |
| `ui/src/app/state.cljs` | State keys |
| `ui/resources/public/css/style.css` | All notes styling |
