# Corpus Medium Plans — Messages, Email, Meetings

## Premise

Notes, messages, emails, and meetings are not different apps. They are entries in a single corpus (`shared.corpus_entries`) distinguished by metadata. The schema already supports all four mediums — `medium`, `author`, `recipients`, `thread_id`, `session_id`, `subject`, and `metadata` columns are in place. What follows is how each medium's UI, API, and integration layer would be built on top of what already exists.

The LLM reader is the payoff. It reads across all entry types. A note you wrote Tuesday, a Slack message from a colleague Wednesday, and a meeting transcript Thursday are all retrievable context for Friday's entry. The corpus doesn't care about app boundaries. The UI just decides what to foreground.

---

## 1. Messages

### What It Is

A view over corpus entries where `medium = 'message'`. Messages have an author, optionally a channel, and optionally a thread. The UI would look like a simplified Slack/Discord reader — a channel list, a message stream, and the LLM reader panel on the right.

### Schema Mapping

| Column | Usage |
|--------|-------|
| medium | `'message'` |
| entry_type | `'human'` for user-authored, `'system'` for bot/integration messages |
| author | Sender handle (e.g. `'ken'`, `'alice'`, `'slackbot'`) |
| recipients | For DMs: comma-separated recipient handles. NULL for channel messages |
| thread_id | Points to the thread root message. Thread root has `thread_id = own id` |
| session_id | NULL (messages are asynchronous) |
| subject | NULL (messages don't have subjects) |
| metadata | `{ "channel": "general", "platform": "slack", "reactions": [...] }` |
| content | The message text |
| parent_id | NULL (not an LLM response; use thread_id for threading) |
| embedding | Embedded on creation, same as notes |

### API Routes

All mounted at `/api/messages` in `app.js`. Excluded from database schema routing (shared schema only), same as `/api/notes`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/messages` | List messages. Query params: `channel`, `thread_id`, `limit`, `before` (cursor). Returns newest-first. |
| GET | `/api/messages/:id` | Single message + thread replies (if thread root) |
| POST | `/api/messages` | Create a message. Body: `{ content, channel, author?, thread_id? }`. Embeds on creation. |
| GET | `/api/messages/channels` | Distinct channels: `SELECT DISTINCT metadata->>'channel' FROM shared.corpus_entries WHERE medium = 'message'` |

No LLM auto-response on message creation — messages are human-to-human artifacts being recorded, not prompts expecting a response. The LLM reads them as context when the user writes notes or submits entries in any medium.

### Import / Integration

Messages would enter the corpus through one of:

**A. Manual paste.** User pastes a conversation into a textarea. A `'system'` parser entry could split it into individual messages with extracted authors and timestamps.

**B. Slack export import.** Slack's data export produces JSON files per channel per day. A server-side importer would:
1. Accept an uploaded Slack export ZIP
2. Parse each channel's JSON files
3. Insert entries with `medium = 'message'`, `author` from Slack user mapping, `metadata.channel` from channel name, `metadata.platform = 'slack'`
4. Map Slack `thread_ts` to `thread_id` (insert thread root first, then replies referencing it)
5. Embed all entries via `POST /api/notes/backfill-embeddings` (reusable — embeddings are medium-agnostic)

**C. Live webhook.** A `/api/messages/webhook` endpoint could receive Slack/Discord webhook payloads in real-time. Each incoming message becomes a corpus entry. This is the most complex path — requires webhook signature verification, rate limiting, and deduplication via `metadata.message_id`.

### Frontend

**File**: `ui/src/app/views/messages.cljs`

Three-pane layout (same pattern as notes):

| Pane | Content |
|------|---------|
| Left (280px) | Channel list at top, then message list for selected channel. Each message shows author, first line, relative timestamp. |
| Center (flex) | Message stream for selected channel/thread. Read-only display of messages in chronological order. Optional compose box at bottom for adding entries. |
| Right (flex) | LLM reader panel — not auto-triggered per message, but available as a "What does the LLM see?" panel that shows the semantic neighborhood of any selected message. |

**Transforms**: `set-messages`, `set-messages-channel`, `set-messages-thread`, `add-message`
**Flows**: `load-channels-flow`, `load-messages-flow`, `send-message-flow`, `select-message-flow`
**State keys**: `:messages-entries`, `:messages-channel`, `:messages-thread-id`, `:messages-input`

**Hub integration**: "Messages" in hub left menu. Right panel shows recent messages across all channels.

### What the LLM Gains

Messages are short, contextual, and time-sensitive. They often contain decisions, commitments, and reactions that longer-form notes don't capture. When the LLM retrieves a message as context for a note, it can surface: "You agreed to X in #general on Tuesday — this entry contradicts/extends/fulfills that."

---

## 2. Email

### What It Is

A view over corpus entries where `medium = 'email'`. Emails have a sender, recipients, a subject line, and belong to chains (threads). The UI would look like a simplified email reader — an inbox list, a reading pane, and the LLM reader panel.

### Schema Mapping

| Column | Usage |
|--------|-------|
| medium | `'email'` |
| entry_type | `'human'` for sent/received mail, `'system'` for forwarding receipts or auto-replies |
| author | Sender email address or display name |
| recipients | Comma-separated To addresses |
| thread_id | Points to the first email in the chain. Thread root has `thread_id = own id` |
| session_id | NULL |
| subject | Email subject line (without Re:/Fwd: prefixes for threading) |
| metadata | `{ "cc": [...], "bcc": [...], "message_id": "<abc@example.com>", "in_reply_to": "<xyz@example.com>", "date": "2026-02-23T10:00:00Z", "labels": ["inbox", "important"] }` |
| content | Email body (plain text, stripped of signatures/quoted text where possible) |
| parent_id | NULL (not an LLM response) |
| embedding | Embedded on creation |

### API Routes

Mounted at `/api/emails`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/emails` | List emails. Query params: `thread_id`, `author`, `limit`, `before`. Returns newest-first. |
| GET | `/api/emails/:id` | Single email + full thread (all entries sharing thread_id, ordered chronologically) |
| POST | `/api/emails` | Create an email entry. Body: `{ content, author, recipients, subject, metadata? }`. Auto-assigns thread_id based on subject matching or explicit `in_reply_to`. |
| GET | `/api/emails/threads` | Distinct threads: aggregates by thread_id, returns subject + participant count + last activity |

### Import / Integration

**A. .mbox / .eml import.** Standard email export formats. A server-side parser would:
1. Accept uploaded .mbox file (or directory of .eml files)
2. Parse MIME headers: From, To, Cc, Bcc, Subject, Date, Message-ID, In-Reply-To, References
3. Extract plain text body (strip HTML, signatures, quoted replies)
4. Thread by References/In-Reply-To headers → map to `thread_id`
5. Insert with `medium = 'email'`
6. Batch embed

**B. Gmail export.** Google Takeout produces .mbox files. Same parser as above.

**C. IMAP polling.** A background process could connect to an IMAP server, fetch new messages periodically, and insert them. This is the most complex — requires credential storage, connection management, IDLE support for real-time, and deduplication by Message-ID.

**D. Manual entry.** For recording the substance of an important email without importing the full mailbox. User fills in author, recipients, subject, and pastes the relevant content.

### Frontend

**File**: `ui/src/app/views/email.cljs`

Three-pane layout:

| Pane | Content |
|------|---------|
| Left (320px) | Thread list. Each item shows subject (bold if unread equivalent), participants, date, first-line preview. Sorted by most recent activity. |
| Center (flex) | Thread view — all emails in the chain, chronological, with author/date headers. Compose reply at bottom (optional). |
| Right (flex) | LLM reader panel. When viewing a thread, the LLM can summarize the chain, surface action items, or connect it to notes/messages in the corpus. |

**Transforms**: `set-emails`, `set-email-thread`, `add-email`
**Flows**: `load-email-threads-flow`, `load-email-thread-flow`, `create-email-flow`
**State keys**: `:email-threads`, `:email-selected-thread`, `:email-thread-entries`, `:email-input`

**Hub integration**: "Email" in hub left menu. Right panel shows recent threads.

### What the LLM Gains

Emails are commitments. They contain promises, deadlines, decisions made with external parties. When the LLM retrieves an email as context for a note, it can surface: "You told the client X on Feb 15 — this note's direction is consistent/inconsistent with that commitment." Cross-medium retrieval means the corpus knows what you said publicly (email) and what you're thinking privately (notes).

---

## 3. Meetings

### What It Is

A view over corpus entries where `medium = 'meeting'`. A meeting is a set of entries sharing a `session_id` — each entry is a segment of the meeting (a speaker turn, a decision point, an action item). The UI would show a meeting list, a transcript-style reading pane, and the LLM reader panel.

### Schema Mapping

| Column | Usage |
|--------|-------|
| medium | `'meeting'` |
| entry_type | `'human'` for speaker turns, `'system'` for structural markers (meeting start/end, topic change), `'llm'` for auto-generated summaries |
| author | Speaker name or identifier |
| recipients | NULL (meetings are broadcast — everyone present hears everything) |
| thread_id | NULL (meetings are flat, not threaded) |
| session_id | Shared UUID for all entries in this meeting. Format: `meeting-{uuid}` |
| subject | Meeting title (same across all entries in the session) |
| metadata | `{ "scheduled_at": "...", "duration_minutes": 60, "platform": "zoom", "recording_url": "...", "attendees": ["ken", "alice", "bob"], "topic": "Q1 planning" }` |
| content | The speaker turn text, or structural marker content |
| parent_id | NULL (not an LLM response to a specific entry) |
| embedding | Each segment embedded individually |

### API Routes

Mounted at `/api/meetings`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/meetings` | List meetings (distinct session_ids). Returns: session_id, subject, date, attendee count, entry count. |
| GET | `/api/meetings/:sessionId` | All entries for a meeting session, chronological. Includes metadata from the first entry. |
| POST | `/api/meetings` | Create a meeting session. Body: `{ subject, metadata? }`. Creates a `'system'` entry marking meeting start, returns session_id. |
| POST | `/api/meetings/:sessionId/entries` | Add an entry to a meeting. Body: `{ content, author, entry_type? }`. Inherits session_id and subject. |
| POST | `/api/meetings/:sessionId/end` | Mark meeting ended. Creates a `'system'` entry. Optionally triggers LLM summary. |
| POST | `/api/meetings/:sessionId/summarize` | Generate an LLM summary of the full meeting. Creates an `'llm'` entry with the summary, embedded for future retrieval. |

### Import / Integration

**A. Transcript paste.** User pastes a meeting transcript. A parser splits by speaker turns (detecting patterns like `Speaker Name: text` or `[HH:MM] Speaker: text`). Each turn becomes an entry with the speaker as `author`.

**B. Otter.ai / transcript service export.** Most transcription services export as SRT, VTT, or structured JSON. A server-side importer would:
1. Accept uploaded transcript file
2. Parse speaker turns with timestamps
3. Create a meeting session (system entry with subject and metadata)
4. Insert each speaker turn as a `'human'` entry with `author` and `session_id`
5. Batch embed

**C. Real-time capture.** The most ambitious path. A WebSocket endpoint receives live transcription segments (from a browser extension or desktop app connected to Zoom/Meet). Each segment becomes an entry in real-time. Meeting end triggers auto-summary.

**D. Manual structured entry.** For recording key meeting outcomes without a full transcript. User creates a meeting, then adds entries for decisions, action items, and key discussion points. Each entry has an author.

### Frontend

**File**: `ui/src/app/views/meetings.cljs`

Three-pane layout:

| Pane | Content |
|------|---------|
| Left (280px) | Meeting list. Each item shows subject, date, attendee count, duration. Sorted by date. "New Meeting" button at top. |
| Center (flex) | Transcript view — entries in chronological order. Each entry shows author name (bold), timestamp, and content. System entries (start/end/topic) shown as centered dividers. LLM summaries shown in a distinct style. |
| Right (flex) | LLM reader panel. "Summarize" button generates a full-meeting summary. Semantic neighborhood shows related notes/messages/emails from the corpus. |

**Transforms**: `set-meetings`, `set-meeting-session`, `add-meeting-entry`, `set-meeting-summary`
**Flows**: `load-meetings-flow`, `load-meeting-flow`, `create-meeting-flow`, `add-entry-flow`, `summarize-meeting-flow`
**State keys**: `:meetings-list`, `:meeting-selected-session`, `:meeting-entries`, `:meeting-input`

**Hub integration**: "Meetings" in hub left menu. Right panel shows recent meetings with subject and date.

### What the LLM Gains

Meetings are where decisions happen but aren't always recorded. When the LLM retrieves meeting segments as context, it can surface: "In the Feb 20 planning meeting, Alice raised concern X — your note today addresses this directly." Meeting entries also provide multi-voice context — the corpus isn't just one person's thinking anymore, it includes what others said, which gives the LLM reader a richer field to draw connections from.

---

## Cross-Medium Retrieval

The most powerful consequence of the unified schema is that semantic retrieval crosses medium boundaries automatically. The existing `retrieveContext()` in `notes.js` already queries all of `shared.corpus_entries` by vector similarity — it doesn't filter by medium. This means:

- A note about "Q1 budget concerns" will retrieve the email thread where the budget was discussed, the meeting segment where it was decided, and the Slack message where someone flagged the discrepancy.
- The LLM reader sees all of this as context, regardless of which view the user is currently in.
- No additional retrieval code is needed. The schema does the work.

If medium-scoped retrieval is ever desired (e.g., "only show me related emails"), it's a single WHERE clause: `WHERE medium = 'email'`. But the default — retrieving across all mediums — is the design intent.

## Implementation Order

If these were ever built, the natural order would be:

1. **Messages** — simplest medium. No threading complexity (thread_id is optional). Slack export is a well-documented format. Good proof of concept for cross-medium retrieval.
2. **Meetings** — session_id grouping is straightforward. Transcript paste is the minimum viable import. Summary generation reuses existing LLM infrastructure.
3. **Email** — most complex. Threading by References headers, MIME parsing, signature stripping, and the volume of data all add complexity. But the schema is already ready for it.

Each medium needs: one route file (~150-200 lines), one view file (~200-300 lines), one transform file (~30-50 lines), one flow file (~50-80 lines), hub integration (~20 lines), and CSS (~100 lines). The server infrastructure (embeddings, LLM routing, semantic retrieval) is already built and medium-agnostic.

## What This Document Is Not

This is not a commitment to build these features. The Notes corpus is the real thing — a working system where a human writes and an LLM reads back. Messages, email, and meetings are described here to prove that the unified corpus schema can support them, and to document how they would work if someone wanted to build them. The schema is in place. The retrieval is medium-agnostic. The rest is UI.
