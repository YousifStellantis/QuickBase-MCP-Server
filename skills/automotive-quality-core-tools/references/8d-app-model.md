# Quickbase app model: 8D / problem solving

Tables (plural name / record name), key fields and relationships. Build in this order;
create relationships after both tables exist.

## 8D Reports / 8D Report
| Field | Type | Notes |
|---|---|---|
| Report Number | text, unique | e.g. `8D-2026-0142`; business key (keep Record ID# as the table key) |
| Title | text | short problem statement |
| Customer | text-multiple-choice or reference to Customers | |
| Part Number | text | mono font in UI |
| Plant / Line / Station | references to lookup tables | |
| Detected At | datetime | D0 |
| Detected By | user | |
| Champion, Leader | user | D1 |
| Problem Description | text-multi-line | D2 (5W2H) |
| Is / Is Not | rich-text | D2 |
| Suspect Quantity | numeric | |
| Containment Due | formula datetime | `[Detected At] + Hours(24)` (adjust to customer rule) |
| Occurrence Root Cause | text-multi-line | D4 |
| Escape Root Cause | text-multi-line | D4 |
| Root Cause Verified | checkbox | D4 |
| PFMEA Updated / Control Plan Updated | checkbox | D7 |
| Read-across Done | checkbox | D7 |
| Closed On | date | D8 |
| Current Step | formula text | derived from which required fields are filled |
| Days Open | formula numeric | see quickbase-schema-design |
| Containment Overdue | formula checkbox | `IsNull([Containment Started]) and Now() > [Containment Due]` |

`Current Step` example:

```
If(not IsNull([Closed On]), "D8",
   [PFMEA Updated] and [Control Plan Updated], "D7",
   not IsNull([Validation Date]), "D6",
   [# Permanent Actions] > 0, "D5",
   [Root Cause Verified], "D4",
   [# Containment Actions] > 0, "D3",
   not IsNull([Problem Description]), "D2",
   not IsNull([Leader]), "D1", "D0")
```

## Containment Actions / Containment Action (child of 8D Reports)
Location (choice: line, warehouse, in transit, customer, supplier), Quantity Checked,
Quantity Found, Owner (user), Started At (datetime), Status, Evidence (file).
Summary fields on the parent: `# Containment Actions` (count), `Total Found` (sum).

## Root Cause Analyses / Root Cause Analysis (child)
Type (occurrence / escape / systemic), Why 1 … Why 5, Category (6M), Verified (checkbox),
Evidence (file).

## Corrective Actions / Corrective Action (child)
Kind (permanent / preventive), Description, Owner, Due Date, Done On, Effectiveness Check
(text), Effective (checkbox). Summary on parent: `# Permanent Actions`, `Open Actions`.

## Lessons Learned / Lesson Learned (child, optional)
Applies To (lines/parts), Description, Read-across Owner, Done.

## Automation ideas
- Pipeline: on create → notify champion and leader; on `Containment Overdue` true →
  escalate (increase escalation level, notify quality manager).
- Pipeline: daily → list reports stuck in the same step for more than N days.
- Code page: 8D board by step (columns D0–D8), aging coloring, filter by customer/line.
