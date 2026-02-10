# Contributing to AccessClone

Thanks for your interest in contributing! This guide will help you get set up and understand how the project works.

## Development Environment

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Java 11+ (for ClojureScript compiler)
- Windows recommended (Access import features require PowerShell + MS Access)

### Setup

1. Clone the repo and install dependencies:
   ```
   npm install
   cd server && npm install && cd ..
   cd ui && npm install && cd ..
   ```

2. Create a PostgreSQL database and run infrastructure:
   ```powershell
   .\setup.ps1 -DatabaseName polyaccess -Password <your_pg_password>
   ```

3. Set database credentials via environment variables (see `server/config.js`):
   ```powershell
   $env:PGPASSWORD = "<your_pg_password>"
   ```

4. Start the server:
   ```
   cd server && node index.js
   ```

5. For frontend development with hot reload:
   ```
   cd ui && npx shadow-cljs watch app
   ```

### WSL Users
The project auto-detects WSL and adjusts the database host. If PostgreSQL is running on the Windows side, it should connect automatically.

## Project Structure

```
server/           Node.js/Express backend
  routes/         API route handlers (one file per domain)
  lib/            Shared utilities (events.js for logging)
  graph/          Dependency graph logic
ui/src/app/       ClojureScript frontend
  state.cljs        Core state (shared helpers, loading, tabs, chat, config)
  state_form.cljs   Form editor state (records, navigation, row-source cache)
  state_report.cljs Report editor state (definition, preview, normalization)
  state_table.cljs  Table-specific state
  state_query.cljs  Query-specific state
  views/            Reagent UI components
skills/           AI-assisted conversion guides
sql/              Database schema definitions
scripts/          PowerShell scripts for Access import
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation.

## Making Changes

### Backend (Node.js)
- Route files are in `server/routes/`. Each exports a factory function that receives `pool`.
- All database queries use parameterized `$N` placeholders — never interpolate user input into SQL.
- All catch blocks should call `logError(pool, source, message, err, { databaseId })` from `server/lib/events.js`.
- Source naming convention: `"METHOD /api/path"` (e.g., `"GET /api/tables"`).

### Frontend (ClojureScript)
- State mutations live in `state.cljs`, `state_form.cljs`, `state_report.cljs`, `state_table.cljs`, `state_query.cljs`.
- UI components live in `ui/src/app/views/`.
- Side-effecting functions must end with `!` (e.g., `save-record!`).
- Error sites should call `log-error!` (shows UI banner + logs to server) or `log-event!` (logs to server only).
- Compile with: `cd ui && npx shadow-cljs compile app`
- Expected warnings: 2 `no.en.core` redef warnings (parse-long, parse-double) are harmless.

### Commit Messages
- Use imperative mood: "Add feature" not "Added feature"
- Keep the first line under 70 characters
- Reference issue numbers when applicable

## Submitting a Pull Request

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Verify the server starts: `cd server && node index.js`
4. Verify the frontend compiles: `cd ui && npx shadow-cljs compile app`
5. Open a PR with a clear description of what changed and why

## Reporting Bugs

Open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS information
- Any relevant error messages from the browser console or server log

## Questions?

Open a discussion or issue — happy to help.
