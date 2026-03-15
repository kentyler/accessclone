# Three Horse — Preliminary Business Concept

## One-Line Summary

A platform that migrates legacy database applications (Access, FoxPro, Paradox) to modern web apps, then lets users keep building and modifying them using natural language.

## The Problem

Millions of small business applications were built in the 1990s and 2000s using desktop database tools — Microsoft Access, Visual FoxPro, Borland Paradox. These apps run critical business operations: inventory, invoicing, scheduling, customer management.

The original developers are retired or gone. The platforms are dead or dying. The apps still work but can't be extended, can't run on the web, can't be accessed from phones, and break when Windows updates. Businesses are stuck.

The alternative today is a manual rewrite — $30-50k+ from a developer, months of work, high risk of losing business logic that was never documented. Most small businesses can't afford it or don't trust it, so they limp along.

## The Product

### Three Entry Points

1. **Legacy Migration** — Import an Access, FoxPro, or Paradox application. The pipeline extracts tables, forms, reports, queries, and business logic. Output: a working web application backed by PostgreSQL.

2. **Spreadsheet Extraction** — Upload Excel files and documents. The system infers tables, relationships, forms, and logic (VLOOKUP becomes dlookup, SUMIF becomes dsum, IF becomes branch conditions). Output: a structured application replacing the spreadsheet chaos.

3. **App Builder** — Start from scratch. Design tables, drag-drop forms, bind data, wire events. The same platform used for migration becomes a general-purpose database app builder.

### The LLM Layer

Every application has a built-in AI assistant that understands its full context: schema, form definitions, report layouts, event handlers, and the dependency graph.

Users can ask the assistant to:
- Explain how the app works ("what happens when I click Save on the order form?")
- Make changes ("add an email field to the customer form")
- Build new features ("create a report that shows overdue invoices")
- Troubleshoot ("why isn't the total calculating correctly?")

This is possible because the platform uses an **intent representation layer** — structured JSON trees that describe behavior (open form, look up value, show message, branch on condition) rather than raw code. The LLM generates these intent trees, which can be validated before execution. Much more reliable than generating source code.

## Architecture

### Current State (Working)

- **Frontend**: ClojureScript/Reagent single-page app
- **Backend**: Node.js/Express API server
- **Database**: PostgreSQL with schema-per-database isolation
- **Desktop**: Electron wrapper (optional)
- **Import**: PowerShell COM automation for Access file extraction

### Key Abstractions

```
Source Platform (Access/FoxPro/Paradox/Spreadsheet)
     |
     v
Extraction Layer (platform-specific adapters)
     |
     v
Intent Representation (platform-neutral JSON trees)
     |
     v
Target Runtime (web forms, reports, event interpreter, PostgreSQL)
     |
     v
LLM Modification Layer (natural language → intent trees → app changes)
```

The **intent representation** is the critical architectural boundary. Extractors produce intent trees. The runtime executes them. The LLM reads and writes them. No component needs to know about VBA or FoxPro code or ObjectPAL — only the extractors deal with source platform specifics.

### Platform Coverage

| Platform | Status | File Formats | Scripting Language |
|----------|--------|-------------|-------------------|
| Microsoft Access | Working | .accdb, .mdb | VBA |
| Visual FoxPro | Planned (next) | .pjx, .scx, .vcx, .dbf, .prg | FoxPro |
| Borland Paradox | Planned | .db, .fdl | ObjectPAL |
| Spreadsheets | Planned | .xlsx, .csv | Excel formulas |

Adding a new platform requires:
1. File format reader/extractor
2. Query dialect converter (source SQL → PostgreSQL)
3. Intent extractor (LLM prompts for the source scripting language)
4. Form/report definition parser

The runtime, builder, and LLM modification layer are shared across all platforms.

## Business Model

### Revenue: Single-Shot Migration Fee

Flat price per migration, not hourly. Tiered by complexity:

| Tier | Scope | Approximate Price Range |
|------|-------|------------------------|
| Small | Under 10 forms, simple CRUD, minimal code | Lower tier |
| Medium | 10-50 forms, business logic, reports | Mid tier |
| Large | 50+ forms, complex logic, cross-form dependencies | Upper tier |

Pricing rationale: the alternative is a manual rewrite at $30-50k+. Automated migration at a fraction of that cost is an easy decision.

### Qualifying Analysis (Pre-Sale)

Before accepting a project, run the extraction pipeline to produce a diagnostic report:

- Object inventory (forms, reports, queries, modules)
- Intent coverage stats (green = fully automated, yellow = needs LLM assist, red = gap)
- Dependency graph complexity
- Rejection flags (heavy COM automation, ActiveX controls, SQL Server shell apps)

This protects both sides — accurate quoting based on actual content, not guesswork. It also serves as the sales tool: "here's exactly what your app does and what the migration covers."

### Rejection Criteria

Some projects are not a fit:
- Heavy VBA with COM automation (Word/Excel/Outlook integration) — not a database app
- Embedded ActiveX controls with no web equivalent
- Apps that are really front-ends for SQL Server stored procedures
- Applications requiring real-time hardware integration

### Post-Migration Support

- **LLM-powered self-service**: Users modify and extend their own apps via natural language. This handles the majority of post-migration "support" without human involvement.
- **Community**: Forum or Discord where migrated users help each other. Low overhead, builds network effects.
- **Optional paid support**: Available for complex customization beyond what the LLM can handle.

### Retraining

Delivered as short video walkthroughs of the migrated app — where everything landed, how to navigate, how to use the LLM assistant. Async delivery scales better than live training and can be rewatched. Most walkthroughs follow similar templates.

### Future Revenue Options

- **Cloud-hosted migration (upload & convert)**: Instead of download-and-run-locally, users upload their `.accdb`/`.mdb` file to a web portal. The file is queued for a Windows worker VM (Access installed) that runs the existing PowerShell extraction scripts unchanged. Results land in Cloud SQL (PostgreSQL), and the migrated app is immediately accessible via browser. No local install needed.
  - **Architecture**: Upload endpoint → Cloud Storage bucket → job queue (Cloud Tasks / Pub/Sub) → Windows worker VM → Cloud SQL. Everything after the worker is the standard Node.js API + frontend, unchanged. The worker runs the battle-tested PowerShell scripts — no rewrite needed.
  - **Hosting stack**: Static frontend on Cloud Storage + CDN (or Firebase Hosting). Node.js API on Cloud Run (scales to zero). PostgreSQL on Cloud SQL (managed, multi-schema works as-is). Windows worker VM for extraction (Access licensing is per-machine).
  - **Why Windows VM, not a rewrite**: The extraction layer uses PowerShell COM/DAO automation to read `.accdb` files. Form and report definitions are stored as proprietary binary blobs — `SaveAsText` (COM) is the only reliable way to extract them. Open-source tools (mdbtools, jackcess) can read table data and schema but cannot extract forms, reports, or VBA reliably. A JVM or Linux rewrite of the extraction layer is a dead end until someone reverse-engineers the Access binary format.
  - **Scaling**: Start with a single always-on Windows VM for early customers, then auto-scaling VM instances as demand grows. Access licensing is per-machine, so costs are predictable.
  - **Deployment simplicity**: Cloud Run supports source-based deploys (`gcloud run deploy --source .`) — auto-detects Node.js, no Docker expertise required. The Windows worker VM is just a Windows machine with Access and PowerShell, no containerization needed. If Docker is eventually wanted, a Node.js Dockerfile is ~5 lines. This is operational work that can be contracted out when the time comes.
  - **Not for launch**: The initial offering is download-and-run-local. Cloud hosting is a future add-on for customers who don't want to install anything or who want their app permanently hosted.
- **Hosted apps**: Run the PostgreSQL backend as a managed service, charge monthly per app. Small businesses don't want to manage databases. (Natural companion to cloud-hosted migration — the app stays where it was converted.)
- **Spreadsheet extraction**: Lower price point, higher volume, much larger market than legacy database migration.
- **Builder seats**: Free to import and view, pay to create and edit.

## Market

### Target Customer

5-50 person businesses running a critical application that one person built in the late 1990s or early 2000s. That person is retired or gone. The app still works but:
- Can't be accessed remotely or on mobile
- Breaks with Windows updates
- Can't be extended or modified
- No one understands the code
- The business depends on it daily

These customers have been burned by vendor lock-in and are skeptical of new platforms. Transparent pricing and the option to self-host builds trust.

### Market Size

- Microsoft Access: estimated 100M+ databases created over its lifetime, millions still in active use
- Visual FoxPro: large installed base, officially dead since 2007, community still active (VFPX)
- Borland Paradox: dead since ~2002, unknown but significant installed base in specific industries

The spreadsheet extraction market is orders of magnitude larger — every business with shared Excel files is a potential customer.

### Competition

- **Manual rewrite shops**: Slow, expensive, risky. Our pipeline makes us 10x faster.
- **Airtable/Retool/Appsmith**: Modern builders, but they don't import legacy apps and don't feel like Access. They target developers, not business users.
- **Access migration consultancies**: Exist, but use custom code each time. No repeatable engine.
- **FileMaker**: Still sold by Claris, so some customers upgrade rather than migrate. Different market.

Nobody is building a multi-platform legacy database migration tool with an LLM-powered builder on the other side.

## Competitive Advantage

1. **The intent representation layer** — extracts meaning from any source platform and represents it in a form the LLM can read, write, and validate. This is the technical moat.
2. **Multi-platform extraction** — one target runtime, multiple source adapters. Each new extractor expands the addressable market without rebuilding the platform.
3. **LLM-native modification** — the app understands itself. Users don't need developers for ongoing changes. This transforms a one-time migration sale into lasting value.
4. **Qualifying analysis** — the ability to scan an app and produce a detailed diagnostic before committing. No competitor can show a customer exactly what their app does and what will migrate before the engagement starts.

## Patch Marketplace

Because every app lands in the same runtime with the same intent representation, applications are composable. A form built for one app can snap into another. This enables a marketplace for reusable "patches" — bundled schema fragments, form definitions, intent handlers, and sample data.

### How Patches Work

A patch is a portable package containing:
- Table definitions (schema fragment)
- Form and report definitions (JSON)
- Intent handler trees (event logic)
- Sample data (optional)
- README describing what it does and what it expects

Installation: the LLM assistant maps the patch's fields to the target app's existing schema, resolves naming differences, and adjusts intent handlers. Unlike Access templates (static, brittle), patches are adaptive.

### Marketplace Tiers

- **Free patches** — Community contributions. Basic CRUD forms, common patterns (contacts, inventory, scheduling, time tracking).
- **Premium patches** — Polished modules from developers. Industry-specific: medical intake forms, work order management, rental property tracking, invoicing.
- **Migration-derived patches** — Every successful migration potentially produces a reusable template. With the client's permission, anonymize and publish. "I migrated my FoxPro veterinary clinic app — here's the template for other vets." The client gets their migration; the platform gets a reusable asset.

### Network Effects

The marketplace changes the builder's onramp. Instead of "build an app from scratch," it becomes "start with these three patches and customize." Much lower barrier to entry.

As the patch library grows, the platform becomes more valuable to every user — classic marketplace dynamics. Early migrators contribute templates that attract new builders, who contribute refinements that attract more users.

### Two-Tier Community Model

**Discord (free, open)**
- General support, Q&A, showcase
- Migration war stories, tips, templates shared informally
- Builds the community, drives awareness
- Anyone can join — migrated users, builders, curious developers

**Developer Marketplace (paid monthly membership)**
- Monthly fee to list and sell patches
- Members get a storefront: profile, patch listings, ratings, download stats
- Access to marketplace tools: patch packaging CLI, testing sandbox, analytics dashboard
- The fee filters for serious contributors and funds marketplace infrastructure
- Buyers browse and install for free (or pay per premium patch) — no buyer-side subscription

This keeps the community open and welcoming while creating a professional channel for developers who want to build a business on the platform. The monthly fee is low enough to be accessible but high enough to signal commitment and cover curation costs.

### Revenue Streams

- **Migration fees** — flat-rate per engagement (primary revenue)
- **Developer marketplace memberships** — monthly recurring from patch developers
- **Premium patch sales** — revenue share on paid patches (platform takes a percentage)
- **Hosted apps** (optional) — monthly per-app for managed PostgreSQL hosting

## Website Infrastructure (three.horse)

Even for the local-first model, the public website needs its own infrastructure:

- **Authorization**: User accounts, login/signup, password reset, session management. Required for: delivering qualifying analysis results, gating downloads after payment, tracking customer engagements, support access. Using **Clerk** (clerk.com) — managed auth with drop-in UI components, good DX, built-in Stripe/billing hooks. 10k free MAU. JWT verification middleware on Express. Hosting on Google Cloud (Cloud Run + Cloud SQL) — Clerk is infrastructure-agnostic.
- **Payments**: Stripe or similar for flat-fee migration charges. Payment flow: qualifying analysis (free) → review → accept quote → pay → receive download/access. Need invoicing, receipts, refund handling.
- **Qualifying analysis delivery**: User uploads `.accdb` or runs the local tool, results need to be stored and accessible from their account.
- **Download distribution**: Gated download of the local installer/package after payment.

These are standard SaaS problems with well-trodden solutions (Stripe, Auth0/Clerk, S3 for downloads), but they're still significant implementation work that's separate from the product itself.

## Open Questions

- Pricing: exact tier boundaries and price points need market testing
- Open source vs. proprietary: open source builds trust and community contributions, but complicates monetization
- Hosting: self-host only, managed hosting, or both? (Cloud-hosted migration option documented above — deferred to post-launch.)
- FoxPro extraction: need to prototype file format reading — .scx/.vcx are DBF-based, which helps
- Spreadsheet extraction: scope and fidelity — how much structure can reliably be inferred?
- Patch marketplace: curation, quality control, versioning, dependency management between patches
- Brand: three.horse domain is secured. Full brand identity TBD.

## Technical Resources

### FoxPro (Next Platform Target)
- VFPX community: https://vfpx.github.io/projects/
- VFP Foundation Classes: https://github.com/VFPX/FFC
- VFP 8.0 Samples (Microsoft): https://www.microsoft.com/en-us/download/details.aspx?id=24095
- GitHub topics: foxpro, visual-foxpro

### Existing Codebase
- Repository: accessclone (current working name)
- Access extraction pipeline: fully working (tables, forms, reports, queries, modules, macros)
- Intent interpreter: fully working (30+ intent types, async domain functions, expression evaluator)
- Form/report editors: fully working (design view, live data view, property sheets)
- Event runtime: fully working (form events, report events, focus events, button click resolution)
- Query converter: fully working (regex + LLM fallback, multi-pass dependency resolution)
- All server tests passing (497 tests)
