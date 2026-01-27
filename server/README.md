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

## File Structure

The server reads/writes to `../forms/`:

```
CloneTemplate/
├── forms/
│   ├── _index.edn           # List of form names
│   ├── recipe_calculator.edn
│   └── ...
└── server/
    └── index.js             # This server
```

## Development

```bash
npm run dev  # Runs with --watch for auto-reload
```
