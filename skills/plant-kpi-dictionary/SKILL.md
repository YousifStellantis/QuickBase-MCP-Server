---
name: plant-kpi-dictionary
description: Definitions, formulas, units, decimals and chart choices for automotive plant KPIs - safety, quality (FTT, DPU, DPHU, PPM, audit scores, warranty), delivery (JPH, schedule attainment), cost, people, maintenance (OEE, MTBF, MTTR), logistics, energy and environment - plus tier-meeting (SQDCP) board conventions and Quickbase formula patterns. Use when building KPI dashboards, reports or formulas so numbers are defined the way plants define them.
metadata:
  version: "1.0"
---

# Plant KPI dictionary

A KPI on a screen must say: definition, unit, scope (plant/area/line/shift), period,
target, and data source. Put the definition behind an info link or in the panel footer.
When the plant has its own definition, it wins; record it in the app (a KPI Definitions
table) instead of hardcoding it in a page.

## Safety
| KPI | Definition | Unit / decimals | Direction |
|---|---|---|---|
| Recordable incident rate | recordable incidents × 200,000 / hours worked | rate, 2 dp | lower |
| Lost-time incident rate | lost-time incidents × 200,000 / hours worked | rate, 2 dp | lower |
| Days since last lost-time incident | calendar days | 0 dp | higher |
| Near misses reported | count per period (a leading indicator; more reporting is good) | 0 dp | higher |
| Safety observations completed | done / planned | %, 0 dp | higher |

(200,000 hours = 100 full-time workers for a year; some regions use 1,000,000. State which.)

## Quality
| KPI | Definition | Unit | Direction |
|---|---|---|---|
| FTT / first-pass yield | units passing all checks without repair or rework / units built | %, 1 dp | higher |
| Rolled throughput yield | product of FTT of each process step | %, 1 dp | higher |
| DPU | defects found / units inspected | 2 dp | lower |
| DPHU | defects per hundred units = DPU × 100 | 0–1 dp | lower |
| PPM (supplier or customer) | defective parts / parts received (or shipped) × 1,000,000 | 0 dp | lower |
| Customer audit score | weighted defect points per audited vehicle | points, 1 dp | lower |
| Warranty claims per 1,000 vehicles | claims / vehicles in service × 1,000 at a months-in-service window | 1 dp | lower |
| Open 8Ds / overdue containment | count; aging by step | 0 dp | lower |

## Delivery
| KPI | Definition | Unit | Direction |
|---|---|---|---|
| JPH | good units / operating hours | units/h, 0–1 dp | higher |
| Schedule attainment | units built to plan (right model, right sequence) / planned | %, 1 dp | higher |
| Takt time | available time / customer demand | s, 0 dp | — |
| Throughput time | entry to exit time per unit | h or min | lower |

## Maintenance
| KPI | Definition | Unit | Direction |
|---|---|---|---|
| OEE | Availability × Performance × Quality | %, 1 dp | higher |
| Availability | run time / planned production time | % | higher |
| Performance | (ideal cycle time × total count) / run time | % | higher |
| Quality (OEE) | good count / total count | % | higher |
| MTBF | operating time / number of failures | h, 1 dp | higher |
| MTTR | total repair time / number of repairs | min, 0 dp | lower |
| Breakdown minutes | unplanned stop time attributed to equipment | min | lower |
| PM compliance | PM work orders done on time / due | %, 0 dp | higher |

## Cost, people, logistics, energy
| KPI | Definition | Unit | Direction |
|---|---|---|---|
| Scrap cost | cost of scrapped material per period or per unit | currency | lower |
| Overtime | overtime hours / regular hours | %, 1 dp | lower |
| Absenteeism | absent hours / scheduled hours | %, 1 dp | lower |
| Training plan completion | done / planned | %, 0 dp | higher |
| Competency coverage | stations with ≥ 3 qualified people / stations | %, 0 dp | higher |
| Line-side shortages | stockouts causing a stop, count and minutes | 0 dp | lower |
| Premium freight | cost or count of expedited shipments | currency | lower |
| Energy per vehicle | kWh (electricity + gas converted) / units built | kWh/unit, 0 dp | lower |
| CO2e per vehicle | scope 1+2 emissions / units built | kg/unit, 0 dp | lower |
| Water per vehicle | m³ / units built | m³/unit, 2 dp | lower |
| Waste per vehicle | kg not recycled / units built | kg/unit, 1 dp | lower |

## Quickbase formula patterns

```
// FTT (percent field on a daily production record)
If([Units Built] > 0, ([Units Built] - [Units With Defects]) / [Units Built], null)

// DPU
If([Units Inspected] > 0, [Defects Found] / [Units Inspected], null)

// OEE from components (percent fields)
[Availability] * [Performance] * [Quality Rate]

// MTBF in hours (numeric)
If([Failures] > 0, ToHours([Operating Time]) / [Failures], null)

// Status vs target (text) for a lower-is-better KPI
If(IsNull([Actual]), "No data", [Actual] <= [Target], "On target", [Actual] <= [Target] * 1.1, "At risk", "Off target")
```

Store counts and times (inputs), compute rates in formulas or in the page, and never
average percentages across lines: recompute from the summed numerators and denominators.

## Tier boards (SQDCP)

- Columns in this order: Safety, Quality, Delivery, Cost, People (some plants add
  Environment/Energy). One row per day or per shift.
- Each cell: actual, target, status (✓ / ▲ / ■ plus color), and for misses a link to the
  action or problem record.
- Tier 1 (team, start of shift) → Tier 2 (area) → Tier 3 (plant): the same KPI
  definitions roll up; escalation rules are explicit (e.g. two misses in a row go up a tier).
- Charts: last 30 days run chart with target line; month-to-date bar against plan.
