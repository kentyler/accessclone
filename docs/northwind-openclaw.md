# Northwind + OpenClaw: What Could Agents Handle?

An analysis of the Northwind database through the lens of AI agent automation via AccessClone's intent extraction pipeline and OpenClaw's autonomous agent runtime.

---

## Fully Automatable (~70-80% of daily operations)

These are processes where the intent graph provides a complete, unambiguous action sequence. An agent reads the intents and executes them mechanically — no judgment required.

### Order Intake & Processing
- **What it does**: Customer places an order → validate customer exists → validate product availability → check unit price → calculate line totals → apply discount if applicable → save order + order details → update units in stock
- **Why it's automatable**: Every step maps to known intents: `validate-required`, `dlookup` (customer, product), `save-record`, `set-value` (calculated fields). The business rules are explicit in the form definitions and validation logic.
- **Agent behavior**: Receives order data (via API, Slack, email, WhatsApp), validates against the database, creates the order, confirms back to the requester.

### Inventory Monitoring & Alerts
- **What it does**: Track units in stock vs. reorder level → flag products below threshold → generate reorder reports
- **Why it's automatable**: The "Products Below Reorder Level" query already exists as a PostgreSQL view. The agent just needs to poll it and notify.
- **Agent behavior**: Periodic check → if results found → notify purchasing team via configured channel with product names, current stock, and reorder quantities.

### Report Generation & Distribution
- **What it does**: Sales by category, sales by year, employee sales, customer order history — all standard Northwind reports
- **Why it's automatable**: Reports are banded definitions with record sources that are PostgreSQL views. The agent renders them on schedule or on demand.
- **Agent behavior**: "Send me the Q1 sales report" → agent runs the report with date parameters → returns formatted output (PDF, table, or summary text).

### Data Lookup & Inquiry
- **What it does**: "What's the phone number for customer ALFKI?" / "How many units of Chai are in stock?" / "What orders did employee Nancy handle last month?"
- **Why it's automatable**: These are `dlookup` and `dcount` intents against known tables. The dependency graph tells the agent exactly which table/column to query.
- **Agent behavior**: Natural language question → intent recognition → SQL query against PostgreSQL → formatted response.

### Customer CRUD
- **What it does**: Add new customer → validate required fields (company name, contact name) → save → confirm. Update address, phone, fax. Look up customer by ID or name.
- **Why it's automatable**: The Customers form definition specifies every field, its validation rules, and its data binding. All `validate-required` + `save-record` intents.
- **Agent behavior**: "Add a new customer: Acme Corp, contact John Smith, 555-1234" → validates → saves → confirms with customer ID.

### Shipping Workflow
- **What it does**: Order placed → assign shipper → set shipped date → calculate freight → update order status
- **Why it's automatable**: The Orders form has fields for ShipVia (shipper selection), ShippedDate, and Freight. These are `set-value` and `save-record` intents.
- **Agent behavior**: "Ship order 10248 via Federal Shipping" → sets ShipVia, ShippedDate = today, saves → confirms.

---

## Human-in-the-Loop (~15-20%)

These are processes where the agent can do most of the work but needs human approval or judgment at specific decision points.

### Order Modifications After Placement
- **What happens**: Customer wants to change quantities, swap products, or cancel line items on an existing order
- **Why it needs humans**: The original Northwind database doesn't encode policies for order modification (restocking fees, cutoff times, partial shipment rules). These are business judgment calls.
- **Agent role**: Receives modification request → looks up order → presents current state and proposed changes → asks human for approval → executes approved changes
- **Human role**: Approve/deny the modification, decide on any fees or exceptions

### Exception Handling
- **What happens**: Product discontinued mid-order, supplier can't fulfill, freight calculation seems wrong, duplicate customer detected
- **Why it needs humans**: Exceptions require judgment about business relationships, cost tradeoffs, and customer impact
- **Agent role**: Detects the exception (discontinued product in an order, stock below zero after order) → escalates with full context → executes whatever the human decides
- **Human role**: Make the judgment call, then the agent handles execution

### Reorder Decisions
- **What happens**: Inventory drops below reorder level → need to decide quantity, supplier, timing
- **Why it needs humans**: Reorder quantity depends on demand forecasts, supplier lead times, budget constraints, and seasonal factors — none of which are encoded in the database
- **Agent role**: Alerts that reorder is needed → presents current stock, reorder level, historical order frequency, supplier info → human decides quantity → agent creates the purchase order
- **Human role**: Decide how much to reorder and when

---

## Human-Only (~5-10%)

These are activities that require strategic thinking, relationship management, or policy decisions that no amount of structured data can automate.

### Product Strategy
- Adding new products to the catalog
- Setting prices and discount policies
- Discontinuing products
- Choosing suppliers and negotiating terms

### Customer Relationships
- Resolving disputes
- Negotiating special pricing or terms
- Building long-term partnerships
- Handling complaints that go beyond data

### Employee Decisions
- Hiring, territory assignments, performance reviews
- The Employees table has data, but managing people isn't a database operation

### Business Rule Changes
- Deciding to change the reorder level formula
- Modifying discount policies
- Adding new product categories
- Changing shipping policies

---

## Why Transforms Make This Governable

The key insight is that AccessClone's transform architecture creates a **closed, enumerable action space**. The agent doesn't have arbitrary access to the database — it can only perform the 80 named transforms that the system defines.

This means:

| Property | What it enables |
|----------|----------------|
| **Finite action space** | You can audit every possible action the agent can take. There are no surprises. |
| **Intent traceability** | Every agent action traces back to a specific VBA intent from the original Access database. You can explain *why* the agent did something. |
| **Permission boundaries** | You can allow the agent to execute `save-record` on Orders but not on Employees. The transform names are the permission model. |
| **Rollback** | Pure transforms are `(state, args) → state`. If an agent makes a mistake, you can replay the transform sequence minus the bad one. |
| **Monitoring** | Every transform dispatch is loggable. You get a complete audit trail of agent behavior in business-meaningful terms ("saved order 10248") rather than raw SQL. |

### The 70/20/10 Split in Practice

For a typical Northwind workday:
- **70-80%**: Agent handles autonomously — order processing, lookups, reports, CRUD, inventory alerts, shipping updates
- **15-20%**: Agent does the work, human approves — order modifications, reorder quantities, exception resolution
- **5-10%**: Human only — strategy, relationships, policy changes

The agent doesn't replace the human. It handles the mechanical majority so the human can focus on the judgment-heavy minority. And because every agent action is a named transform with a clear intent lineage, the human can always understand what the agent did and why.

---

## Architecture

```
Northwind.accdb
    → AccessClone (extraction)
        → 30 typed intents + dependency graph + PG views
            → OpenClaw skill (execution)
                → Agent operates order processing, inventory, reports
                    → Human reviews exceptions, approves reorders, sets strategy
```

The browser UI remains the development and debugging tool. The real output — structured intents, dependency graph, PostgreSQL views — is what the agent consumes. The human interacts with the agent through whatever channel makes sense: Slack, WhatsApp, email, or a custom dashboard.
