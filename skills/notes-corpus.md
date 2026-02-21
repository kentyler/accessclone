# Notes — A Corpus That Writes Back

## What It Is

The Notes feature is an append-only corpus where a human writes entries and an LLM reads each new entry against everything that came before, responding with what changed, connected, or was revealed. It is not a chatbot. It is a second reader — someone who has read everything and notices what the writer might not see from inside the act of writing.

The corpus is global (not per-database) and chronological. There are no categories, tags, folders, or organization features. Entries accumulate. The LLM's responses interleave with the human's entries in the same stream.

## How It Works

1. Human writes an entry in the center pane and submits (button or Ctrl+Enter).
2. The server saves the human entry to `shared.corpus_entries`.
3. The server loads the last 50 entries as context, builds a prompt, and calls the Anthropic API (Claude Sonnet).
4. The LLM's response is saved as a separate entry with `parent_id` pointing to the human entry.
5. Both entries appear in the sidebar. The human entry shows in the center pane; the LLM response shows in the right pane.

If no API key is configured, the human entry is saved and no LLM response is generated.

## The LLM System Prompt

The system prompt instructs the LLM to perform four operations on each new entry (without naming them to the user):

1. **Boundary** — What the entry includes, excludes, or redraws the edges of. Every entry is an act of enclosure.
2. **Transduction** — What the entry converts from one form to another. An observation becomes a principle; a concrete experience becomes an abstract pattern.
3. **Resolution** — What the entry settles, sharpens, or problematizes. Some entries converge; others crack open what seemed settled.
4. **Trace** — What the entry reveals about the corpus as a whole. Lineage, echoes, trajectories extended or broken.

The response should feel like marginalia — not summary, not praise, not advice. Plain prose, no formatting. Length varies naturally with the entry.

These four operations mirror the four architectural primitives of AccessClone itself (Boundary, Transduction, Resolution, Trace), applied to thought rather than software.

## Architecture

### Database

Table: `shared.corpus_entries` (created in `server/graph/schema.js`)

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | Entry ID |
| entry_type | VARCHAR(10) | `'human'` or `'llm'` |
| content | TEXT | The entry text |
| parent_id | INTEGER (FK) | For LLM entries, points to the human entry it responds to |
| created_at | TIMESTAMPTZ | Timestamp |

Indexes on `created_at DESC` and `parent_id WHERE parent_id IS NOT NULL`.

### API Endpoints

Mounted at `/api/notes` in `server/app.js`. Excluded from database schema routing middleware (accesses shared schema only).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notes` | Fetch recent entries (default 200, max 1000, most recent first) |
| GET | `/api/notes/:id` | Fetch a single entry + its LLM response (if entry_type is human) |
| POST | `/api/notes` | Create human entry, generate LLM response, return both |

POST body: `{ content: string }`
POST response: `{ entry: {...}, response: {...} | null }`

### Server (`server/routes/notes.js`)

- Receives `pool` and `secrets` (for Anthropic API key).
- On POST: inserts human entry, loads last 50 entries as context (chronological), formats them as `[H]`/`[R]` markers with `---` separators, calls Anthropic API with system prompt, inserts LLM response with `parent_id`.
- LLM model: `claude-sonnet-4-20250514`, max_tokens 2048.
- Graceful degradation: if API key missing or LLM call fails, human entry is still saved and returned.

### Frontend State (`ui/src/app/state.cljs`)

Six keys in `app-state`:

| Key | Type | Description |
|-----|------|-------------|
| `:notes-entries` | vector | All entries for sidebar display |
| `:notes-selected-id` | int/nil | Currently selected entry ID |
| `:notes-input` | string | Textarea content |
| `:notes-loading?` | boolean | True while waiting for LLM response |
| `:notes-read-entry` | map/nil | Currently displayed human entry |
| `:notes-read-response` | map/nil | Currently displayed LLM response |

### Transforms (`ui/src/app/transforms/notes.cljs`)

Six pure state transforms:

| Transform | Args | Effect |
|-----------|------|--------|
| `:set-notes-entries` | entries | Replace all entries |
| `:add-notes-entry` | entry | Prepend entry to list (most recent first) |
| `:set-notes-selected` | id | Set selected entry ID |
| `:set-notes-input` | text | Update textarea |
| `:set-notes-loading` | bool | Toggle loading state |
| `:set-notes-read-entry` | entry, response | Set both read pane values |

### Flows (`ui/src/app/flows/notes.cljs`)

Three flows:

| Flow | Trigger | What it does |
|------|---------|-------------|
| `load-notes-flow` | Page mount | GET /api/notes, dispatch `:set-notes-entries` |
| `submit-entry-flow` | Submit button / Ctrl+Enter | Clear input, set loading, POST content, add both entries to sidebar, show in read pane |
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

The feature was merged in PR #32 ("Add Notes — append-only corpus with LLM response"). The git status shows uncommitted modifications to three files:
- `server/routes/notes.js`
- `ui/resources/public/css/style.css`
- `ui/src/app/views/notes.cljs`

These may represent work-in-progress refinements beyond the merged PR.

## Design Decisions

- **Append-only, no editing or deleting.** The corpus grows. Nothing is removed.
- **Global, not per-database.** Notes are about the user's thinking, not about a specific Access database.
- **No organization.** Chronological is the only ordering. The LLM handles pattern-finding.
- **Interleaved entries.** Human and LLM entries live in the same stream, visible in the sidebar.
- **Graceful degradation.** Works without an API key — just no LLM responses.
- **Three-pane layout.** Sidebar for navigation, center for writing/viewing entries, right for reading LLM responses.

## Files

| File | Role |
|------|------|
| `server/routes/notes.js` | API endpoints, LLM prompt, corpus context building |
| `server/graph/schema.js` | Table DDL for `shared.corpus_entries` |
| `server/app.js` | Route mounting at `/api/notes` |
| `ui/src/app/transforms/notes.cljs` | 6 pure state transforms |
| `ui/src/app/flows/notes.cljs` | 3 flows (load, submit, select) |
| `ui/src/app/views/notes.cljs` | Three-pane UI |
| `ui/src/app/views/main.cljs` | Page routing |
| `ui/src/app/views/hub.cljs` | Hub integration |
| `ui/src/app/state.cljs` | State keys |
| `ui/resources/public/css/style.css` | All notes styling |
