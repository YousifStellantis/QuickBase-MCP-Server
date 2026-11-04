# Competency app data model (Quickbase)

```
Domains 1───* Competencies 1───* Position Requirements *───1 Positions
                    │                                          │
                    └───* Assessments *───1 Employees *────────┘ (current position)
Employees 1───* Certifications *───1 Certification Types
Employees 1───* Development Actions *───1 Competencies
```

| Table | Key fields |
|---|---|
| Domains | Code (unique), Name, Color, Sort Order, Owner (user) |
| Competencies | Name, Domain (ref), Tool / Station / Equipment, Criticality (safety / quality / standard), Description of levels 1–5 |
| Positions | Name, Area (body, paint, GA, powertrain, battery), Shift pattern |
| Position Requirements | Position (ref), Competency (ref), Required Level (0–5), Mandatory (checkbox) |
| Employees | TID (unique text), Name, Position (ref), Team Leader (user), Shift, Active |
| Assessments | Employee (ref), Competency (ref), Level (0–5), Assessed On, Assessor (user), Evidence (file), Valid Until (optional) |
| Certification Types | Name (HV authorization, forklift, LOTO, confined space), Validity (months), Binary (checkbox) |
| Certifications | Employee (ref), Type (ref), Completed On, Expires On (formula), Status (formula: Valid / Expiring / Expired) |
| Development Actions | Employee, Competency, Action (training, coaching, shadowing), Due, Done, Target Level |

Useful formulas:

Keep one *current* assessment per employee and competency: either update the existing
record (upsert with a unique "Employee|Competency" text key as `mergeFieldId`) and keep
history in a separate Assessment History table, or keep every assessment and pick the
latest per pair in the page. The first is simpler for reports.

```
// Certifications: status
If(IsNull([Expires On]), "Valid",
   [Expires On] < Today(), "Expired",
   [Expires On] <= Today() + Days(30), "Expiring", "Valid")

// Position Requirements (lookup current level via a combined key, or compute in the page)
Max(0, [Required Level] - Nz([Current Level]))
```

Query pattern for a person radar (one call): select assessments for the employee with
competency → domain lookups, then group in the page by domain and average. Get the
required levels from Position Requirements for the employee's position in a second call.
Run both in parallel.
