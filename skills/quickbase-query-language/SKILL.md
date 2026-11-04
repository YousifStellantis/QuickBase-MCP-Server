---
name: quickbase-query-language
description: Reference for Quickbase query strings ({fid.OPERATOR.'value'}), the JSON API request bodies for querying, sorting, grouping, paging, inserting/updating (upsert) and deleting records, and value formats per field type. Use whenever you write a where clause, call query_records / upsert_records / delete_records, or write API calls in a code page or pipeline.
metadata:
  version: "1.0"
---

# Quickbase query language and record API

## Where clause syntax

```
{<fid>.<OPERATOR>.'<value>'}
{7.EX.'Open'}AND{12.GT.0}
({6.EX.'Line 1'}OR{6.EX.'Line 2'})AND{9.OAF.'today'}
```

- Always use **field IDs**, never labels, in API queries.
- Quote values with single quotes; escape a quote inside a value as `\'`.
- Combine with `AND` / `OR`; use parentheses to group. No spaces are required.

| Operator | Meaning | Typical use |
|---|---|---|
| `EX` / `XEX` | is equal / is not equal | text, numbers, checkbox (`'true'`/`'false'`), record IDs |
| `CT` / `XCT` | contains / does not contain | free text |
| `SW` / `XSW` | starts with / does not start with | codes, part-number families |
| `LT` `LTE` `GT` `GTE` | less / greater (or equal) | numbers, dates |
| `BF` / `OBF` | before / on or before | dates |
| `AF` / `OAF` | after / on or after | dates |
| `IR` / `XIR` | is (not) during a range | relative dates, e.g. `'today'`, `'this week'`, `'last month'` |
| `HAS` / `XHAS` | has / does not have | multi-select text, list-user fields |
| `TV` | equals the stored ("true") value | when display formatting differs from the stored value |

Dates: `'today'`, `'yesterday'`, `'tomorrow'` or an explicit date such as
`'2026-11-04'`. Set `options.compareWithAppLocalTime: true` when "today" must follow
the app's time zone rather than UTC. Empty values: `{8.EX.''}` matches empty.

## Query body (`POST /v1/records/query`, tool `query_records`)

```json
{
  "from": "bxxxxxxxx",
  "select": [3, 6, 7, 9],
  "where": "{7.EX.'Open'}AND{9.OAF.'2026-11-01'}",
  "sortBy": [{ "fieldId": 9, "order": "DESC" }],
  "groupBy": [{ "fieldId": 6, "grouping": "equal-values" }],
  "options": { "skip": 0, "top": 1000, "compareWithAppLocalTime": true }
}
```

Response: `data` (rows keyed by FID as `{ "<fid>": { "value": ... } }`), `fields`
(id, label, type) and `metadata` (`totalRecords`, `numRecords`, `skip`). Page with `skip`
until `skip >= totalRecords`. `query_records` does this for you up to `maxRecords`.

Returned values by type: text/numeric as plain values; dates as `YYYY-MM-DD`;
datetimes as ISO-8601 UTC; user fields as `{ id, email, name }`; multi-select as arrays;
file attachments as `{ url, versions: [{ versionNumber, fileName, uploaded, creator }] }`.

## Insert / update (`POST /v1/records`, tool `upsert_records`)

```json
{
  "to": "bxxxxxxxx",
  "data": [
    { "6": { "value": "Line 2" }, "7": { "value": "Open" }, "10": { "value": 3 } },
    { "3": { "value": 1452 }, "7": { "value": "Closed" } }
  ],
  "mergeFieldId": 3,
  "fieldsToReturn": [3, 7]
}
```

- A row with the key field (or `mergeFieldId`) updates that record; otherwise it inserts.
  Use a unique business field as `mergeFieldId` (e.g. TID, part number) for idempotent
  imports that can safely be re-run.
- Value formats: dates `"2026-11-04"`; datetimes `"2026-11-04T06:30:00Z"`; checkbox
  `true/false`; multi-select `["A", "B"]`; file `{ "fileName": "x.pdf", "data": "<base64>" }`;
  user fields: use the user object/ID returned by a query.
- HTTP 200 can still contain `metadata.lineErrors` (per-row failures). Always check it.
- Large loads: batches of a few hundred to a few thousand rows; stay under the request
  size limit and the ~100 requests / 10 s per-token rate limit.

## Delete (`DELETE /v1/records`, tool `delete_records`)

```json
{ "from": "bxxxxxxxx", "where": "{7.EX.'Test'}AND{1.BF.'2026-01-01'}" }
```

There is no undo. The tool shows the match count first and needs a confirm phrase.
Deleting all records requires an explicit `{3.GT.0}`.

## Reports and formulas

- `run_report` returns the report's own filter, columns and sorting; good for
  "the same view the users see".
- `run_formula` evaluates a formula for a table/record without creating a field.

## Common mistakes

- Querying by label (`{'Status'.EX.'Open'}`) in the JSON API: use the FID.
- Forgetting quotes around text values containing spaces.
- Comparing datetimes to dates with `EX`; use `OAF`/`OBF` or `IR`.
- Assuming one page of results; always page or set `maxRecords`.
- Building where clauses from user input without escaping `'`.
