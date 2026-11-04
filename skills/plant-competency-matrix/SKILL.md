---
name: plant-competency-matrix
description: Competency and skills matrices for automotive plants - World Class Manufacturing style domains (safety, quality, maintenance, logistics, people development, launches ...), 0-5 and ILUO level scales, required levels by position, gap analysis, flexibility (3x3) coverage, certification expiry, radar charts, and a catalog of modern technical skills (EV high-voltage, battery, robotics, PLC, DC tools, vision/AI inspection, data). Use when building or analyzing competency apps, radar dashboards, training plans or position requirements.
metadata:
  version: "1.0"
---

# Plant competency matrix

## Domains

Plants running World Class Manufacturing (WCM) organize capability around its pillars
(WCM at Stellantis has 10 technical and 10 managerial pillars; plants are audited and
each technical pillar is scored 0–5). A practical domain list for a competency model,
matching common plant usage:

| Code | Domain | Typical pillar link |
|---|---|---|
| PAR | Plant ambition roadmap | managerial: targets, deployment |
| LD | Losses deployment | cost deployment (loss → cost mapping) |
| HS | Health and safety | safety |
| Q | Quality | quality control |
| ENV | Environment | environment |
| E | Energy | energy |
| CI | Continuous improvement | focused improvement |
| WO | Workplace organization | autonomous activities |
| M | Maintenance | autonomous + professional maintenance |
| LOG | Logistics | logistics / customer service |
| PD | People development | people development |
| LA | Launches | early equipment / product management |

Keep domains in a **lookup table** (code, name, color, sort order, owner), not hardcoded
in pages, so a new domain or color does not need a code change.

## Levels

0–5 scale (use the same words everywhere, including PDF exports):

| Level | Meaning | Evidence |
|---|---|---|
| 0 | No exposure | none |
| 1 | Knows the theory | training completed |
| 2 | Performs with support | supervised practice signed off |
| 3 | Performs independently to standard | observed to standard |
| 4 | Troubleshoots and trains others | trained someone; solved real problems |
| 5 | Expert: improves the standard | led an improvement; certifies others |

ILUO is the 4-step equivalent (I: in training, L: can do with help, U: can do to
standard, O: can teach). Map ILUO to 1/2/3/4 when both exist.

**Binary items** (safety induction, high-voltage authorization, forklift license) are
pass/fail with an **expiry date**. Store them as certifications, not as 0–5 levels;
show them as chips (✓ valid / ■ expired / ▲ expires in 30 days), not as radar spokes.
If a radar must include them, plot complete = 5 and incomplete = 0 and label them
clearly; never plot the raw 1.

## Requirements and gaps

- **Position requirement**: (position × competency) → required level. A position is a
  role at a place (e.g. "GA Electrician", "Body shop maintenance technician").
- **Gap** = max(0, required − current) per competency. Report:
  - person view: radar (current filled, required dashed), list of gaps sorted by size
    then by criticality;
  - team view: heat map people × competencies (cell color by gap), totals per column;
  - **coverage**: for each station/competency, count people at or above the required
    level; flag stations with fewer than 3 qualified people;
  - **flexibility (3×3 rule)**: each operation covered by ≥ 3 qualified people, each
    person qualified on ≥ 3 operations.
- **Average per domain**: average of the person's levels across that domain's
  competencies, rounded to one decimal; keep the unrounded value for sorting.
- Priority for training = gap × criticality (safety and quality critical items first).

## Radar chart rules

- 5–12 axes; same order every time (domain sort order); scale fixed 0–5 with integer
  rings. Required = dashed outline, current = filled at ~15 % opacity, accent color.
- Never compare people on one radar with more than 2–3 series; use small multiples.
- Show the numbers next to the chart (table), because radar areas exaggerate differences.
- PDF export: same chart, same colors, plus the gap table and certification status.

## Data model

See `references/data-model.md`. Treat assessments and employee IDs (TID) as personal
data: narrow roles, no IDs in URLs or logs, and retention rules agreed with HR.

## Modern technical skills

See `references/skills-catalog.md` for a catalog by area (EV high voltage, battery
assembly, robotics, PLC/controls, DC tools and error-proofing, vision/AI inspection,
conveyors, glazing, data and AI tools, maintenance technologies). Use it to propose
competencies for new positions; the plant's training department decides the final
standard.
