# Conversion Macros Skill

Phase 6 of the conversion process. Imports Access macros into AccessClone for viewing, analysis, and translation to ClojureScript.

## Prerequisites

- Access database accessible via COM automation
- Target database configured in AccessClone
- **AutoExec macro renamed to xAutoExec** (see below)

## AutoExec Warning

Access databases with an AutoExec macro will show a login dialog or run startup code when opened via COM automation, which hangs the PowerShell process. Before any import work:

1. Open the Access database manually
2. Rename "AutoExec" to "xAutoExec" in the macro list
3. Close the database
4. Proceed with import

After conversion is complete, rename it back if needed.

## Tools

Macro import uses PowerShell scripts in `scripts/access/`:

- `list_macros.ps1` - List all macros in an Access database
- `export_macro.ps1` - Export a single macro's definition via SaveAsText
- `create_sample_macros.ps1` - Create 10 sample macros for testing

## How Access Macros Work

Access macros are UI automation sequences — they execute actions like OpenForm, MsgBox, RunSQL, SetProperty, etc. They are NOT VBA code. Macros can be:

- **Standalone macros** — triggered manually or from events
- **Embedded macros** — attached directly to form/report events (stored in the form definition, not separately)
- **Data macros** — table-level triggers (before/after insert/update/delete)

Our pipeline currently handles standalone macros. Embedded macros are part of the form/report definition. Data macros are a future consideration.

## Access Macro Internal Format

Access macros have TWO representations:

### 1. Legacy LoadFromText Format

This is the format produced by `SaveAsText(acMacro, name, tempFile)` and consumed by `LoadFromText`. It is NOT raw XML. Structure:

```
Version =196611
PublishOption =1
ColumnsShown =0
Begin
    Action ="OpenForm"
    Argument ="Order List"
    Argument ="0"
    Argument =""
    Argument =""
    Argument ="-1"
    Argument ="0"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"OpenForm\"><Argument Name=\"FormName\">Order List</Argument></Action></S"
        "tatements></UserInterfaceMacro>"
End
```

Key format rules:
- Header: `Version =196611`, `PublishOption =1`, `ColumnsShown =0`
- Each action is a `Begin`/`End` block with `Action` and `Argument` lines
- Conditional actions use `Condition` lines (value `"..."` for else-if)
- The `_AXL:` comment block contains the XML representation with:
  - Escaped quotes: `\"`
  - Continuation lines indented with 8 spaces, each starting and ending with `"`
  - `\015\012` for CRLF sequences

### 2. XML Representation (inside _AXL block)

The actual macro definition in modern Access XML format:

```xml
<UserInterfaceMacro MinimumClientDesignVersion="14.0.0000.0000"
    xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
  <Statements>
    <Action Name="OpenForm">
      <Argument Name="FormName">Order List</Argument>
    </Action>
  </Statements>
</UserInterfaceMacro>
```

Key XML elements:
- `<Action Name="...">` — action to execute (OpenForm, MessageBox, RunSQL, etc.)
- `<Argument Name="...">` — action parameters
- `<ConditionalBlock>` with `<If>`, `<ElseIf>`, `<Else>` — conditional logic
- `<SubMacro Name="...">` — named sub-sections (reusable from RunMacro)
- `<Condition>` — expression for conditional branches

## LoadFromText Encoding

**Critical**: LoadFromText requires UTF-16 LE with BOM encoding. In PowerShell:

```powershell
# CORRECT — produces UTF-16 LE with BOM
[System.IO.File]::WriteAllText($tempFile, $content, [System.Text.Encoding]::Unicode)

# WRONG — Out-File may not produce exact format needed
$content | Out-File -FilePath $tempFile -Encoding Unicode
```

The file must start with bytes `FF FE` (UTF-16 LE BOM).

## Common Macro Action Types

| Action | Description | Key Arguments |
|--------|-------------|---------------|
| OpenForm | Open a form | FormName, View, WhereCondition, DataMode |
| OpenReport | Open a report | ReportName, View, WhereCondition |
| MessageBox | Show a message | Message, Type, Title |
| SetTempVar | Set a temporary variable | Name, Expression |
| RunSQL | Execute SQL | SQLStatement |
| SetProperty | Change control property | ControlName, Property, Value |
| SetWarnings | Suppress/enable warnings | WarningsOn |
| OnError | Set error handler | Goto, MacroName |
| RunMacro | Run another macro | MacroName |
| GoToRecord | Navigate records | ObjectType, ObjectName, Record, Offset |
| CloseWindow | Close a window | ObjectType, ObjectName, Save |
| ApplyFilter | Apply a filter | FilterName, WhereCondition |

## Storage Schema

Macros are stored in `shared.macros` with append-only versioning:

```sql
CREATE TABLE IF NOT EXISTS shared.macros (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    macro_xml TEXT,           -- Raw definition from SaveAsText
    cljs_source TEXT,         -- ClojureScript translation (via chat)
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    review_notes TEXT,
    version INT NOT NULL DEFAULT 1,
    is_current BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(database_id, name, version)
);
```

Status values: `pending`, `translated`, `needs-review`, `complete`

## Import Pipeline

### Automated (via UI)

1. Open Access Database Viewer
2. Select "Macros" from object type dropdown
3. Select target database from "Import into"
4. Check macros to import, click Import

Pipeline: `list_macros.ps1` → UI lists macros → user selects → `POST /export-macro` runs `export_macro.ps1` → frontend saves via `PUT /api/macros/:name`

### Manual (via API)

```
# List macros
GET /api/macros
Headers: X-Database-ID: <database_id>

# Read a macro
GET /api/macros/:name
Headers: X-Database-ID: <database_id>

# Save a macro
PUT /api/macros/:name
Headers: X-Database-ID: <database_id>
Body: { macro_xml, cljs_source, description, status, review_notes }
```

## Viewing and Translation

The macro viewer (`ui/src/app/views/macro_viewer.cljs`) displays:
- **Left panel**: Raw macro XML (read-only)
- **Right panel**: ClojureScript translation (initially empty)
- **Info panel**: Name, version, imported date, status dropdown

Translation is done via the chat panel — the LLM receives the macro XML as context and can generate ClojureScript equivalents. Auto-analyze fires when a macro is first opened, producing a structural analysis.

## Translation Strategy

Access macros map to ClojureScript event handler functions. General approach:

| Access Pattern | ClojureScript Equivalent |
|----------------|--------------------------|
| OpenForm | `state/open-tab!` with form type |
| OpenReport | `state/open-tab!` with report type |
| MessageBox | `js/alert` or custom modal component |
| SetTempVar | `swap! app-state assoc-in` |
| RunSQL | API call to server endpoint |
| SetProperty | `swap! app-state update-in` on control property |
| If/ElseIf/Else | `cond` / `if` expressions |
| SubMacro | Named functions |
| OnError | `try`/`catch` blocks |
| GoToRecord | `state/navigate-to-record!` |

## Sample Macros for Testing

`create_sample_macros.ps1` creates 10 macros covering key patterns:

1. **Macro_OpenForm** — Simple OpenForm
2. **Macro_OpenFormFiltered** — OpenForm with WhereCondition
3. **Macro_OpenReport** — Open report in preview
4. **Macro_MessageBox** — MsgBox with title/type
5. **Macro_MultipleActions** — SetTempVar + OpenForm + MsgBox sequence
6. **Macro_ConditionalLogic** — If/ElseIf/Else branches
7. **Macro_Submacros** — Named sub-sections
8. **Macro_ErrorHandling** — OnError + handler submacro
9. **Macro_RunSQL** — SQL execution with SetWarnings
10. **Macro_SetProperties** — Enable/show controls

Usage:
```powershell
.\scripts\access\create_sample_macros.ps1 -DatabasePath "C:\path\to\database.accdb"
```

## Related Skills

- `conversion.md` - Overall conversion orchestrator
- `conversion-forms.md` - Form import (macros often reference forms)
- `conversion-vba.md` - VBA translation (macros are an alternative to VBA)
- `form-design.md` - Form structure (macro targets)
