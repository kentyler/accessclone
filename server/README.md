# CloneTemplate Backend

Simple Node.js server for form file operations.

## Setup

```bash
npm install
npm start
```

Server runs on http://localhost:3001 (or `PORT` env variable).

## API Endpoints

### List Forms
```
GET /api/forms
```
Returns: `{ "forms": ["recipe_calculator", "ingredient_entry", ...] }`

### Read Form
```
GET /api/forms/:name
```
Returns: EDN content of the form file

### Save Form
```
PUT /api/forms/:name
Content-Type: application/json

{
  "id": 1,
  "name": "Recipe Calculator",
  "type": "form",
  "record-source": "recipe",
  "default-view": "single",
  "controls": [...]
}
```
- Creates or updates the form file
- Automatically adds to `_index.edn` if new

### Delete Form
```
DELETE /api/forms/:name
```
- Deletes the form file
- Removes from `_index.edn`

### Read Config
```
GET /api/config
```
Returns: EDN content of `settings/config.edn`

### Save Config
```
PUT /api/config
Content-Type: application/json

{
  "form-designer": {
    "grid-size": 8
  }
}
```
- Saves app configuration to `settings/config.edn`

### Graph API (Dependency/Intent Graph)

The graph tracks relationships between database objects (tables, columns, forms, controls) and business intents.

#### Query Nodes
```
GET /api/graph/node/:id           # Get node by ID
GET /api/graph/nodes?type=table&database_id=calc  # Query by type
GET /api/graph/find?type=table&name=ingredient&database_id=calc
```

#### Dependencies
```
GET /api/graph/dependencies/:nodeId?direction=downstream&depth=3
GET /api/graph/dependencies/:nodeId/prose  # Human-readable
GET /api/graph/impact?type=table&name=ingredient&database_id=calc
```

#### Intents
```
GET /api/graph/intents            # List all intents
GET /api/graph/intents/prose      # Human-readable summary
GET /api/graph/intent/:id/structures   # What serves this intent
GET /api/graph/structure/:id/intents   # What intents this serves

POST /api/graph/intent
{
  "name": "Track Inventory Costs",
  "description": "Monitor ingredient pricing and usage",
  "structures": [
    { "node_type": "table", "name": "ingredient" }
  ]
}

POST /api/graph/intent/confirm
{ "structure_id": "uuid", "intent_id": "uuid" }
```

#### Admin
```
POST /api/graph/populate   # Re-scan schemas (use after schema changes)
POST /api/graph/clear      # Clear all graph data (dangerous!)
```

## File Structure

The server reads/writes to `../forms/`:

```
CloneTemplate/
├── forms/
│   ├── _index.edn           # List of form names
│   ├── recipe_calculator.edn
│   └── ...
└── server/
    ├── index.js             # Main server
    └── graph/               # Dependency/intent graph
        ├── schema.js        # Table creation
        ├── query.js         # CRUD operations
        ├── populate.js      # Schema/form scanning
        └── render.js        # Prose rendering for LLM
```

## Development

```bash
npm run dev  # Runs with --watch for auto-reload
```
