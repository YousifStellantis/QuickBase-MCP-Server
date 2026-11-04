---
name: quickbase-pipelines-yaml
description: Read, write, lint and promote Quickbase Pipelines as YAML exports - step header grammar, inputs-meta, Jinja references between steps, loops and conditions, account slugs, the DEV to PROD remap workflow, and import rules. Use for any pipeline task; Quickbase has no public pipeline API, so all pipeline work goes through exported YAML in the workspace.
metadata:
  version: "1.0"
---

# Quickbase Pipelines as YAML

## What is and is not possible

- **No public REST API** lists, reads, creates or runs pipelines one by one.
- **Export** in the UI: Pipelines > (pipeline) ⋮ > Export > Download YAML.
  **Import**: Pipelines > My Pipelines > Import > paste or choose the file.
- Imported pipelines start **disabled**, the importing user becomes the **owner**, and
  Quickbase auth tokens are **never** exported (connected accounts appear as
  placeholders/slugs that must match accounts in the target realm).
- **Solutions/QBL** (Enterprise) can carry pipelines whose channels QBL supports
  (Quickbase and Callable pipelines in QBL v0.12; check the current QBL version page).
- A pipeline can be **started over HTTP** when it begins with an incoming-webhook or
  callable trigger; this server's `trigger_pipeline` posts to webhooks you allowlist.

Work loop: export → `inspect_pipeline` (lint against live schema) → edit or
`remap_pipeline` → `inspect_pipeline` again → `save_pipeline` → import in the UI →
test with a real record → enable.

## Anatomy of an export

```yaml
# Escalate overdue containment
#
# Account slugs:
#  - quickbase[Qa1B2c3]: Pipelines service account <None>
---
- META:
    name: Escalate overdue containment
    description: Flags 8D reports whose containment is overdue and notifies the owner.
    enabled: false
- TRIGGER quickbase[Qa1B2c3] record on_update -> a:
    inputs-meta:
      table: '"Plant Quality: 8D Reports" <bxxxxxxx1>'
      trigger_fields: '"Containment Due" <24>'
      export_fields: '"Report Number, Owner, Containment Due, Status" <6, 11, 24, 7>'
      query: "{7.XEX.'Closed'}"
- QUERY quickbase[Qa1B2c3] record search -> b:
    inputs-meta:
      table: '"Plant Quality: Containment Actions" <bxxxxxxx2>'
      export_fields: '"Related 8D, Status" <8, 9>'
      query: "{8.EX.'{{a.id}}'}AND{9.XEX.'Done'}"
- IF:
  - AND:
    - b<> !empty
  - THEN:
    - a<>ACTION quickbase record update -> c:
        inputs:
          escalation_level: '{{ (a.escalation_level|int) + 1 }}'
          last_escalated: '{{ time.now }}'
  - ELSE:
    - a<>ACTION quickbase record update -> d:
        inputs:
          escalation_level: '0'
...
```

### Step headers

`[<target><>]<KIND> <channel>[<account slug>] <resource> <action> -> <letter>:`

- `KIND`: `TRIGGER` (exactly one, first), `ACTION`, `QUERY` (search), and control blocks
  `LOOP`, `IF` with `AND` / `OR` conditions and `THEN` / `ELSE` / `DO` branches.
- `-> a:` is the step's letter. Later steps refer to earlier ones by letter
  (`{{a.field_name}}`, `{{b|length}}`). Letters must be unique; references only point
  backwards.
- `a<>` before a kind means "act on the record from step a"
  (e.g. `a<>ACTION quickbase record update` updates the triggering record;
  `b<>LOOP` iterates over the search results of step b).
- The account slug in brackets selects the connected account. The same slug must be
  listed in the `# Account slugs` header. A slug may include a realm/user suffix after
  `#` (`quickbase[PoAvqbr#jdoe]`).
- Channel/resource/action names are what the designer exported (`record on_create`,
  `record on_update`, `record search`, `record create`, `record update`,
  `quickbase_api make`, `clock timer pause` …). For a channel you have not used before,
  add the step once in the designer, export, and copy its header and inputs instead of
  guessing.

### inputs-meta and inputs

- `inputs-meta.table`: `'"App: Table" <dbid>'` or a bare dbid.
- `export_fields` / `trigger_fields`: labels then FIDs in angle brackets: `<6, 11, 24>`.
  These FIDs are what `remap_pipeline` rewrites between environments.
- `query`: Quickbase query syntax (see `quickbase-query-language`); Jinja is allowed
  inside values (`'{{a.id}}'`).
- `inputs` on record create/update: keys are the **snake_case field labels**
  ("Escalation Level" → `escalation_level`, Record ID# → `id`). Renaming a field in
  Quickbase silently breaks these keys; re-run `inspect_pipeline` after renames.

### Jinja

- `{{ a.field }}`, filters `|int`, `|float`, `|default('')`, `|trim`, `|length`,
  `|replace('a','b')`, `|lower`, `|upper`, `|tojson`.
- Blocks: `{% set x = ... %}`, `{% for item in b %}…{% endfor %}`, `{% if … %}…{% endif %}`.
- `{{ time.now }}` for the current time. For date formatting and the full list of
  filters, follow Quickbase's "Use Jinja in Quickbase Pipelines" reference rather than
  generic Jinja docs; Pipelines supports a curated subset.
- Build JSON bodies for `quickbase_api make` with loops and `{{ ',' if not loop.last }}`.
- Keep logic small; a 40-line Jinja template belongs in a callable pipeline or a script.

## Design rules

- **Service account** owns production pipelines and connects the Quickbase account; a
  person leaving must not stop production automations.
- **Idempotent**: guard triggers with a flag or status (`query: "{19.EX.1}"` then reset
  the flag) so re-saves do not fire twice.
- **Bulk work** uses `quickbase_api make` with one `POST /v1/records` of many rows, not a
  LOOP of single creates (rate limits and run time).
- **Name** pipelines `<App> | <Purpose> | <Env>` and put a version in META.description.
- **Comment intent** in `META.description`: what triggers it, what it changes, who owns it.

## Promotion DEV → TEST → PROD

1. Export from DEV into `pipelines/<name>.dev.yaml`.
2. `remap_pipeline path=... autoMap={sourceAppId, targetAppId}` (tables matched by name,
   fields by label) plus `slugMap` for the target account slug. Read every item under
   "review" (free-form JSON bodies with FIDs are flagged, not changed).
3. `inspect_pipeline` the result against the target environment until it has no errors.
4. Import in the target realm, replace any placeholders, run once with test data, enable.

## Linting checklist (`inspect_pipeline` covers most of it)

- Exactly one trigger; unique letters; no forward references.
- Every table and field ID exists in the target realm.
- Every `inputs` key matches a field label (snake_case).
- Every account slug is declared in the header.
- `enabled: false` in files you hand over for import.
