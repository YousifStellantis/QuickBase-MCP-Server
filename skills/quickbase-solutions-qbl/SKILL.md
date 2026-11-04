---
name: quickbase-solutions-qbl
description: Work with Quickbase Solutions and QBL (Quickbase Language, YAML) - export an app's schema including forms, reports, dashboards, roles, code pages and supported pipelines; inspect resources and !BadRef problems; preview and apply changes between environments. Use when the task involves forms, dashboards, whole-app schema, or promoting an app between DEV/TEST/PROD on an Enterprise plan.
metadata:
  version: "1.0"
---

# Solutions and QBL

## When to use it

QBL is the only API surface that describes **forms** (`QB::Form` for legacy forms,
`QB::FormV2` for new forms, plus dynamic form rules), **dashboards**, **charts**,
**roles** and **pages** (including `QB::CodePage` with `Name` and `RawCode`) as schema.
It is also how schema moves between environments as a unit.

Limits to tell the user up front:

- **Enterprise plans only** for the Solution APIs (since January 2026).
- Coverage depends on the **QBL version**; Quickbase releases schema coverage in stages
  and retires old versions. Unsupported objects are left unchanged in the target.
- Pipelines inside solutions: only supported channels (v0.12 documents Quickbase and
  Callable pipelines); a solution with unsupported pipeline channels cannot be exported.
  Newer versions also limit solution size (e.g. v0.14 beta: up to 2 apps with up to
  30 pipelines, or up to 3 apps without pipelines).
- Whole-solution granularity: there is no "update just this form" call. For a fast
  code-page loop use `deploy_code_page` (XML API) instead.

## Shape

```yaml
Resources:
  $App_Plant_Quality:
    Type: QB::Application
    Properties:
      Name: Plant Quality
      Manager: ...            # strip when promoting to another environment
  $Table_Defects:
    Type: QB::Table
    Properties:
      Name: Defects
      ...
  $Form_Defect_Entry:
    Type: QB::FormV2
    Properties: ...
  $CodePage_Line_Board:
    Type: QB::CodePage
    Properties:
      Name: line-board.html
      RawCode: "<!DOCTYPE html>..."
ParameterDefinitions: ...     # environment-specific values; keep the target's
```

- Logical IDs (`$Table_Defects`) are stable names inside the solution; real IDs are
  assigned per environment.
- `!Ref $Table_Defects` references another resource. `!BadRef` marks a reference
  Quickbase could not resolve on export (a deleted field in a formula, a cross-app
  reference). Fix every `!BadRef` before installing anywhere.

## Workflow with this server

1. `get_solution_info solutionId=...` (apps and pipelines, real and logical IDs).
2. `export_solution` → QBL saved under `solutions/` with a summary by resource type.
3. `inspect_qbl type=QB::FormV2` to list forms; `inspect_qbl resource=$Form_...` to read
   one; `inspect_qbl resource=$CodePage_... extractCodeTo=pages/x.html` to pull a page.
4. Edit the exported file (keep tags, indentation and logical IDs; do not re-serialize
   the whole document with a YAML library, which can change quoting).
5. `preview_solution_changes` and show the change list to the user.
6. `apply_solution mode=update solutionId=... confirm=update:<solutionId>` (writes enabled).

## Promoting between environments

- Take the schema from the source export, but keep the target's
  `ParameterDefinitions` and the target app's logical ID; remove `Manager` from the
  `QB::Application` properties (it causes API errors across environments).
- Version mismatches matter: changing the QBL version of a file on update can drop
  objects the old version did not model (Quickbase warns that moving a v0.2 file to v0.3
  on update deletes app variables). Export and apply with the same version; set
  `QB_QBL_VERSION` only when you need a specific one.
- After install, field IDs in the target may differ: regenerate code page constants and
  remap pipelines.
