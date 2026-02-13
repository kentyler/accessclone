# Testing Guide Skill

You are helping an LLM (or human developer) understand and use the test suite in AccessClone. Your job is to answer questions about what tests exist, help run the right tests after changes, and guide writing new tests.

## Your Role

- After making code changes, identify which tests are affected and run them
- If no tests cover the changed code, say so — don't pretend coverage exists
- When writing new tests, follow the existing patterns in the relevant test file
- Never skip tests or mark them as passing when they fail

## Quick Reference

**Run all unit tests (server + electron):**
```
npm test
```
This runs from the project root and covers both packages. Always run this after any change.

**Run database integration tests (requires PostgreSQL):**
```
npm run test:db
```
This is gated behind `ACCESSCLONE_DB_TESTS=1` and needs a live database. Only run when changing schema routing or database middleware.

**Run electron tests with coverage:**
```
cd electron && npm run test:coverage
```

## Test Map

### Server Tests (`server/__tests__/`)

| File | Tests | What it covers | Run when you change... |
|------|-------|---------------|----------------------|
| `query-converter.test.js` | 95 | Access SQL → PostgreSQL conversion | Anything in `server/lib/query-converter/` |
| `lint.test.js` | ~50 | Form/report structural + cross-object validation | `server/routes/lint/`, form/report validation logic |
| `vba-stub-generator.test.js` | ~15 | VBA declaration parsing, PG function stub generation | `server/lib/vba-stub-generator.js` |
| `db.schema-routing.test.js` | 2 | Multi-database schema isolation via X-Database-ID | Schema routing middleware, database switching |

### Electron Tests (`electron/__tests__/`)

| File | Tests | What it covers | Run when you change... |
|------|-------|---------------|----------------------|
| `format.test.js` | ~30 | HTML escaping, markdown→HTML rendering | `electron/lib/format.js` |
| `config.test.js` | ~10 | Config file load/save/update | `electron/lib/config.js` |
| `powershell.test.js` | ~10 | PowerShell command execution (Windows only) | `electron/lib/powershell.js` |
| `skills.test.js` | ~10 | Skill file loading and caching | `electron/lib/skills.js` |

### What Has No Tests

These areas currently have **no automated tests**. Be extra careful when changing them, and consider adding tests if your change is non-trivial:

- **API routes** (`server/routes/`) — No HTTP integration tests except schema routing. `supertest` is installed but underused.
- **Access import pipeline** (`server/routes/access-import/`) — Complex multi-step pipeline with no tests. Changes here should be verified manually.
- **Expression converter** (`server/lib/expression-converter/`) — Converts Access expressions to PostgreSQL. No tests despite being a complex transformer.
- **Graph engine** (`server/graph/`) — Dependency/intent graph population and queries.
- **Chat/LLM integration** (`server/routes/chat.js`) — Context building, tool dispatch.
- **All frontend code** (`ui/src/app/`) — No ClojureScript tests exist. State management, form editor, report editor, etc. are all untested.
- **PowerShell export scripts** (`scripts/access/`) — COM automation scripts, tested only by running against real Access databases.

## How Tests Are Structured

### Server: Jest + supertest

Test files use Jest with Node test environment. The query converter tests show the standard pattern:

```javascript
const { convertAccessQuery } = require('../lib/query-converter');

describe('convertAccessQuery', () => {
  // Helper that extracts just the converted SQL
  const convert = (sql) => convertAccessQuery(sql, 'test_schema').sql;

  // Helper that generates full DDL
  const ddl = (name, sql) => convertAccessQuery(sql, 'test_schema', name).ddl;

  describe('function translations', () => {
    test('Nz → COALESCE', () => {
      expect(convert('SELECT Nz(field, 0) FROM t'))
        .toContain('COALESCE');
    });
  });
});
```

Key patterns:
- **Helper functions** at the top of describe blocks to reduce boilerplate
- **Descriptive test names** that state the transformation: `'Nz → COALESCE'`
- **Grouped by category** using nested `describe` blocks
- **No mocking** — tests call real functions with real inputs and check real outputs
- **No database dependency** for unit tests (DB tests are separate and gated)

### Electron: Jest with temp directories

Electron tests that touch the filesystem use temp directories:

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
```

### DB Tests: Gated with environment variable

```javascript
const shouldRunDbTests = process.env.ACCESSCLONE_DB_TESTS === '1';

(shouldRunDbTests ? describe : describe.skip)('Schema routing', () => {
  // tests that need a live PostgreSQL connection
});
```

This pattern prevents accidental slow test runs. Only `npm run test:db` sets the flag.

## Writing New Tests

### Where to put them

- Server tests → `server/__tests__/your-feature.test.js`
- Electron tests → `electron/__tests__/your-feature.test.js`
- Both locations use `**/__tests__/**/*.test.js` glob pattern in Jest config

### When to write them

Write tests when:
- Adding a new converter, transformer, or parser (these are pure functions — easy to test)
- Fixing a bug that could regress (write the failing test first, then fix)
- Adding a new API endpoint that has non-trivial logic (use supertest)

Don't write tests when:
- The change is purely cosmetic (UI styling, log message wording)
- The function is a thin wrapper around a library call with no logic
- The code requires a full running system to exercise (save for manual testing)

### Template for a new server test

```javascript
// server/__tests__/my-feature.test.js
const { myFunction } = require('../lib/my-module');

describe('myFunction', () => {
  test('handles basic case', () => {
    const result = myFunction('input');
    expect(result).toBe('expected output');
  });

  test('handles edge case', () => {
    expect(() => myFunction(null)).toThrow();
  });
});
```

### Template for an API route test (with supertest)

```javascript
// server/__tests__/my-route.test.js
const express = require('express');
const request = require('supertest');

// Create a minimal app with just the route under test
const createApp = () => {
  const app = express();
  app.use(express.json());
  // Mount route with mock dependencies
  const mockPool = { query: jest.fn() };
  const router = require('../routes/my-route')(mockPool);
  app.use('/api', router);
  return { app, mockPool };
};

describe('GET /api/my-endpoint', () => {
  test('returns data', async () => {
    const { app, mockPool } = createApp();
    mockPool.query.mockResolvedValue({ rows: [{ id: 1 }] });

    const res = await request(app)
      .get('/api/my-endpoint')
      .set('X-Database-ID', '1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
```

## Highest-Value Tests to Add Next

If you're looking to improve coverage, these would catch the most regressions per test written:

1. **Expression converter** (`server/lib/expression-converter/`) — Pure transformer like the query converter. Same test pattern: input expression → expected PostgreSQL output. ~20 tests would cover the core functions.

2. **Access type mapping** (`server/lib/access-types.js`) — Maps Access type codes to PostgreSQL types. Simple lookup table — easy to test, catches type mapping regressions.

3. **Control mapping** (`server/lib/control-mapping.js`) — Manages form control → table column mappings. Critical for form state sync.

4. **API contract tests** for `/api/data/:table` and `/api/forms/:name` — The two most-used endpoints. supertest is already installed. Mock the pg pool, verify request/response shapes.

## Common Questions

**"I changed a file but don't know which tests to run"**
> Run `npm test` from the project root. It runs all unit tests for both server and electron. If you changed database/schema code, also run `npm run test:db`.

**"Tests pass but I'm not confident my change is correct"**
> Check the test map above. If there are no tests for the code you changed, that's a gap. Consider adding a test for your specific change, or at minimum, verify manually via the API or UI.

**"How do I run just one test file?"**
> `cd server && npx jest __tests__/query-converter.test.js --verbose`
> Or for a single test: `cd server && npx jest --testNamePattern "Nz → COALESCE"`

**"The DB test is failing"**
> Check: Is PostgreSQL running? Is `ACCESSCLONE_DB_TESTS=1` set? Does the test database exist? The DB test creates its own test schemas but needs a working connection.

**"Should I add frontend tests?"**
> ClojureScript/Reagent tests are possible with `cljs.test` but none exist in this project yet. For now, frontend changes are verified manually. If you're adding complex state logic, consider testing the state functions in isolation.
