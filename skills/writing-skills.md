# Writing Skill Files

Guide for creating and maintaining skill files in the `/skills/` directory. Skill files are structured documentation that serves both humans and LLMs — they capture hard-won knowledge so it doesn't need to be rediscovered.

## Purpose

Skill files are not just documentation. They are **reusable knowledge** that an LLM can reference in future sessions to:
- Reproduce a working process without trial and error
- Understand format requirements, encoding quirks, and edge cases
- Map concepts between different source platforms and our normalized model
- Build on patterns that already work

## Structure

Every skill file should include these sections as appropriate:

### 1. Prerequisites
What must be true before this skill applies (phases completed, tools available, access requirements).

### 2. Tools and Scripts
What scripts, endpoints, or commands are used. Include exact paths and usage.

### 3. Format and Encoding Details
**This is critical.** Document exact format requirements, encoding, and gotchas discovered through testing. The difference between "it should work" and "it actually works" is often encoding, BOM bytes, escaping rules, or undocumented format constraints.

Examples of things to capture:
- File encoding requirements (UTF-8, UTF-16 LE with BOM, etc.)
- Escaping rules (escaped quotes, continuation lines, XML entities)
- Coordinate systems (twips, pixels, points) and conversion factors
- Property name mappings (Access `Caption` → our `text`, etc.)
- Data type mappings with edge cases

### 4. Pipeline Description
The end-to-end flow: extraction → transformation → storage → viewing → translation. Include the exact API endpoints and data flow.

### 5. Common Patterns / Reference Tables
Quick-reference tables mapping source concepts to our model. These are heavily used by the LLM during translation work.

### 6. Gotchas and Hard-Won Lessons
Things that failed and why. Things that look like they should work but don't. These prevent future sessions from repeating the same mistakes.

## Two Audiences

Each skill file serves two audiences simultaneously:

### Platform-Specific (the immediate target)
- Exact scripts, endpoints, formats for this specific platform
- COM automation details, API quirks, encoding requirements
- Property mappings, type mappings, coordinate conversions

### Platform-Generic (transferable knowledge)
- **Patterns that apply to any source platform** — always call these out explicitly
- The normalized model we're mapping TO is the same regardless of source
- Common categories of problems that recur across platforms

## Writing for Cross-Platform Learning

When documenting platform-specific work, always consider: **what would help someone tackling a different source platform?**

### Extraction Patterns (generic)
Every platform has some way to export its objects. Document:
- What extraction method was used and why (COM automation, XML export, REST API, ODBC, file parsing)
- What alternatives exist and their trade-offs
- What the extraction produces (raw format) vs. what we need (normalized format)
- Startup/shutdown concerns (like AutoExec in Access — other platforms have equivalents)

### Object Type Mapping (generic)
Every database platform has its own names for the same concepts:

| Generic Concept | Access | FileMaker | Lotus Notes | Oracle Forms |
|-----------------|--------|-----------|-------------|--------------|
| Data entry screen | Form | Layout | Form | Form |
| Printed output | Report | Layout (list) | View | Report |
| Automation sequence | Macro | Script | Agent/Action | Trigger |
| Code module | VBA Module | Custom Function | LotusScript | PL/SQL |
| Stored query | Query | (embedded) | View | View |
| Lookup list | Combo-box row source | Value List | Keyword list | LOV |

When writing a skill file for a new platform, explicitly map its object types to this table. This helps the LLM understand the analogies immediately.

### Transformation Patterns (generic)
Common transformation categories that recur across platforms:
- **Coordinate conversion** — every platform has its own unit system
- **Color format conversion** — BGR vs RGB, integer vs hex, named colors
- **Event model mapping** — platform events → our event handlers
- **Expression/formula translation** — platform-specific functions → SQL or ClojureScript
- **Reference resolution** — how objects refer to each other (by name, by ID, by path)

### Storage Destination (generic)
Our normalized storage is always the same:
- `shared.forms` — form/layout definitions as JSON
- `shared.reports` — report definitions as JSON
- `shared.modules` — code (VBA, LotusScript, etc.) + optional ClojureScript translation
- `shared.macros` — automation definitions (XML, script text, etc.) + optional ClojureScript translation
- Database tables — actual data in PostgreSQL schemas

New platforms should map into these existing tables. Only create new shared tables if the platform has a genuinely new object type with no equivalent.

### Error Patterns (generic)
Common failure modes across all platforms:
- **Encoding mismatches** — source exports in one encoding, our pipeline expects another
- **Startup code execution** — databases that run code on open (Access AutoExec, FileMaker startup scripts)
- **Lock files** — COM/API sessions that don't close cleanly leave locks
- **Large object limits** — OLE objects, attachments, binary data that can't transfer cleanly
- **Reserved word conflicts** — platform column names that collide with PostgreSQL reserved words
- **Case sensitivity** — platforms that are case-insensitive mapping to PostgreSQL which folds to lowercase
- **Translation before full import** — if code references objects that haven't been imported yet, the LLM will guess at the logic and produce incorrect, insecure code. **Block translation until all objects from the source discovery scan have been imported into the target.** No dependency chain analysis needed — just compare discovery inventory vs. target inventory. This applies universally across platforms: Access VBA referencing queries, FileMaker scripts referencing layouts, etc.

## Maintaining Skill Files

- **Update when you discover something new** — if a session reveals a gotcha, add it immediately
- **Mark things that turned out wrong** — don't just delete; note why the original approach failed
- **Keep reference tables current** — these are the most-used sections
- **Link between skill files** — use the Related Skills section so the LLM can navigate

## Checklist for New Skill Files

Before considering a skill file complete:

- [ ] Prerequisites listed
- [ ] Scripts/tools with exact paths and usage
- [ ] Format and encoding details documented (the hard-won stuff)
- [ ] Pipeline described end-to-end
- [ ] Reference/mapping tables included
- [ ] Gotchas section with specific failure modes
- [ ] Generic patterns called out (what transfers to other platforms)
- [ ] Related skills linked
- [ ] Added to CLAUDE.md skills list
- [ ] Added to conversion.md if it's a conversion phase
