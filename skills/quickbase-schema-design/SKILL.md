---
name: quickbase-schema-design
description: How to read and design Quickbase app schemas - tables, field types, keys, relationships, lookups, summaries, formula fields, roles and environments (DEV/TEST/PROD) - and how to change them safely with this server's tools. Use before creating or changing tables or fields, writing formulas, or explaining an existing app.
metadata:
  version: "1.0"
---

# Quickbase schema design

## Mental model

- **App** (dbid `b…`) contains **tables** (each a dbid `b…`). Records have a
  Record ID# (field 3). Fields have integer IDs (FIDs) that never change for the life
  of a table, but a *copy* or *solution install* into another app can assign new ones.
- Built-in fields on every table: 1 Date Created, 2 Date Modified, 3 Record ID#,
  4 Record Owner, 5 Last Modified By.
- **Relationships** are one-to-many: the child holds a *reference field* (foreign key)
  pointing at the parent's key field. *Lookup fields* show parent values on the child;
  *summary fields* aggregate children on the parent (count, sum, max, combined text …).
- Field **modes**: plain data, `formula` (computed on read), `lookup`, `summary`.

## Always start from the live schema

1. `get_schema_map` for the whole app (tables, FIDs, types, relationships). Save it.
2. `find_fields query="..."` to locate a field across tables.
3. `get_field_usage` before renaming, retyping or deleting a field: formulas,
   reports, forms, notifications and webhooks may depend on it.
4. `run_formula` to test a formula against real records before creating the field.

## Design rules

- **One table per real-world thing** (Defects, Suppliers, Parts, Employees, Assessments).
  Plural table name, singular record name ("Defects" / "Defect").
- **Keys**: keep Record ID# as the key unless a business key is guaranteed unique and
  stable (never a name). Changing a key field later breaks every relationship on it.
  Mark business identifiers (TID, part number, VIN) as *unique* text fields instead.
- **Lookup tables over choice lists** when the values change, carry attributes
  (owner, color, short code, sort order) or are shared by tables (domains, stations,
  positions). Choice lists are fine for short, fixed vocabularies (Open/Closed).
- **People are user fields**, not text names: permissions, notifications and
  `User()` formulas depend on it.
- **Types matter**: dates as date/datetime, quantities as numeric with the unit in the
  label ("Torque (Nm)", "Cycle time (s)"), percentages as percent, money as currency.
- **Many-to-many** needs a junction table (Employee ↔ Competency → Assessments).
- **Compute, don't copy**: status flags, ages and gaps are formula fields
  ("Days Open", "Gap to Required"). Store only what a person or system enters.
- **Lookup labels** must be unambiguous: "Supplier - Name", "Position - Required Level".
- **Formulas over many lookups/summaries are computed per row on every read**; in very
  large tables keep them simple or materialize with a pipeline.
- **Help text** on every non-obvious field; it shows in forms and helps the next builder.

## Formula essentials

Fields are referenced by label in square brackets. Common functions: `If`, `Case`,
`IsNull`, `Nz`, `ToText`, `ToNumber`, `ToDate`, `Today()`, `Now()`, `ToDays`, `Days`,
`WeekdayAdd`, `Round`, `Floor`, `Ceil`, `Contains`, `Left`, `Right`, `Mid`, `Length`,
`Trim`, `Upper`, `Lower`, `List`, `User()`, `UserToName`, `UserToEmail`, `URLRoot()`,
`Dbid()`.

```
// Days a defect has been open (numeric formula)
If(IsNull([Date Closed]), ToDays(Today() - ToDate([Date Created])), ToDays([Date Closed] - ToDate([Date Created])))

// Containment overdue flag (checkbox formula): containment due 24 h after detection
IsNull([Containment Date]) and Now() > [Detected At] + Hours(24)

// Competency gap (numeric formula), never negative
Max(0, [Required Level] - Nz([Current Level]))

// Status color for reports (text formula returning a color name)
Case([Status], "Open", "#c0262d", "Contained", "#a86400", "Closed", "#1c7a45", "#6b747d")
```

Renaming a field updates formulas that reference it inside Quickbase, but **not**
code pages, pipelines (they use snake_case labels in `inputs`) or external scripts.
That is why code pages use FIDs and pipelines must be re-linted after renames.

## Roles and access

- `list_app_roles` shows roles and access levels. Design roles by job (Operator,
  Team Leader, Quality Engineer, Plant Admin), not by person.
- Record-level rules (e.g. "only records where [Record Owner] is the current user")
  and field-level permissions are set per role in the Quickbase UI.
- Personal data (employee IDs, assessments) needs the narrowest roles that work. Do not
  put it in report URLs or code page query strings.

## Environments

- Keep DEV, TEST and PROD as separate apps. Promote schema with Solutions/QBL on
  Enterprise plans (see `quickbase-solutions-qbl`), or by copying apps.
- After a promotion, regenerate field constants (`generate_field_constants`) and
  remap pipelines (`remap_pipeline`); FIDs and table IDs may differ.

## Changing schema with this server

Write tools exist only when the server runs with `QB_ALLOW_WRITES=true`; deletes also need
`QB_ALLOW_DESTRUCTIVE=true` and a two-step confirmation. Before any change:
describe the change, show the affected fields/usage, and wait for the user's go-ahead.
Order of work: tables → fields → relationships (lookups/summaries) → formula fields →
reports/forms in the UI → code pages and pipelines.
