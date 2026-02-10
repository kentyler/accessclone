# AccessClone Backend

Node.js/Express server for AccessClone — handles data CRUD, form/report storage, LLM chat, Access import, and more.

## Setup

```bash
npm install
npm start
```

Server runs on http://localhost:3001 (or `PORT` env variable).

## Route Files

| File | Prefix | Purpose |
|------|--------|---------|
| `metadata.js` | `/api` | Tables, queries, functions, query execution |
| `data.js` | `/api/data` | Record CRUD (INSERT/UPDATE/DELETE) |
| `databases.js` | `/api/databases` | Multi-database management |
| `forms.js` | `/api/forms` | Form CRUD (append-only versioning) |
| `reports.js` | `/api/reports` | Report CRUD (append-only versioning) |
| `modules.js` | `/api/modules` | PostgreSQL function source |
| `lint.js` | `/api/lint` | Form/report validation |
| `chat.js` | `/api/chat` | LLM chat with context |
| `sessions.js` | `/api/session` | UI state persistence |
| `transcripts.js` | `/api/transcripts` | Chat transcript storage |
| `events.js` | `/api/events` | Error/event logging |
| `config.js` | `/api/config` | App configuration |
| `graph.js` | `/api/graph` | Dependency/intent graph |
| `access-import.js` | `/api/access-import` | Import from Access databases |

## Data Storage

Forms and reports are stored as JSON in `shared.forms` / `shared.reports` PostgreSQL tables with append-only versioning.
Config is stored as JSON in `settings/config.json`.

## Development

```bash
npm run dev  # Runs with --watch for auto-reload
```
