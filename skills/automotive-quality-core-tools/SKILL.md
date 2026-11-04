---
name: automotive-quality-core-tools
description: Automotive quality methods and how to build Quickbase apps for them - 8D and 5-Why problem solving, QRQC, Ishikawa, AIAG-VDA PFMEA with Action Priority, control plans, APQP phases, PPAP elements and submission levels, SPC (Cp/Cpk, control charts), MSA (Gage R&R), layered process audits, and IATF 16949 with Stellantis customer-specific requirements. Use when designing quality apps, reports, code pages or pipelines, or when the user asks about these methods.
metadata:
  version: "1.0"
  sources: "AIAG / VDA core tools, IATF 16949:2016 and IATF Rules 6th ed., Stellantis CSR (IATF Global Oversight, June 2025)"
---

# Automotive quality core tools

Use the vocabulary plant and supplier quality engineers use, and model apps so the
method's logic is enforced by the data (required fields per stage, dates that drive
escalation), not by a PDF template.

## 8D problem solving

| Step | Content | Data to capture |
|---|---|---|
| D0 | Prepare; emergency response | detection date/time, customer, part number, quantity suspect |
| D1 | Team | champion, leader, members (user fields, cross-functional) |
| D2 | Problem description | 5W2H, IS / IS NOT, photos, defect code, first-seen date |
| D3 | Interim containment | actions, locations (line, warehouse, in transit, customer), quantities sorted/found, start time |
| D4 | Root cause | occurrence root cause **and** non-detection (escape) root cause, verified, 5-Why chains, Ishikawa |
| D5 | Permanent corrective actions | chosen actions with evidence they eliminate the cause |
| D6 | Implement and validate | implementation date, effectiveness check (data after change), containment removed |
| D7 | Prevent recurrence | PFMEA, control plan, work instructions, lessons learned, read-across to similar lines/parts |
| D8 | Close and recognize | closure approval, customer acceptance, date |

Rules worth enforcing: containment starts within the customer's required time (often
24 hours); D4 needs both occurrence and escape causes; D6 needs data showing the defect
stopped; D7 must update the PFMEA/control plan, not only the part. Follow the
customer's own 8D timing and format where it differs.

**5-Why** is three chains, not one: why it happened (occurrence), why it was not
detected (escape), why the system allowed it (systemic). **Ishikawa** branches (6M):
Man, Machine, Method, Material, Measurement, Milieu/Environment.

**QRQC** (Quick Response Quality Control), widely used in European automotive plants:
daily, at the place of the problem (gemba), with real parts and real data, short
cycles (detect → contain → analyze → correct within days), escalating from line to plant
level. Model as a daily problem log with owner, due date and escalation level.

Quickbase model: see `references/8d-app-model.md`.

## PFMEA (AIAG-VDA, 7 steps)

1. Planning and preparation  2. Structure analysis  3. Function analysis
4. Failure analysis (failure mode, effect, cause chain)  5. Risk analysis
6. Optimization  7. Results documentation.

Risk uses **Action Priority (AP: High / Medium / Low)** from the Severity, Occurrence and
Detection ratings via the AIAG-VDA tables; it replaces ranking by RPN. Store S, O, D and
the AP; treat AP High as "action required". Link failure causes to control plan
characteristics so a change in one flags the other.

## Control plan

Per process step and characteristic: product/process characteristic, special
characteristic class (safety/critical, significant), specification/tolerance,
evaluation/measurement technique, sample size and frequency, control method, reaction
plan. Phases: prototype, pre-launch, production.

## APQP (5 phases) and PPAP

APQP: 1 Plan and define, 2 Product design and development, 3 Process design and
development, 4 Product and process validation, 5 Feedback, assessment and corrective
action (launch and production). Track deliverables per phase with gate reviews
(green/yellow/red) and owners.

PPAP 18 elements: design records; authorized engineering change documents; customer
engineering approval; DFMEA; process flow diagram; PFMEA; control plan; MSA studies;
dimensional results; material/performance test results; initial process studies;
qualified laboratory documentation; appearance approval report; sample production
parts; master sample; checking aids; customer-specific requirements records; Part
Submission Warrant (PSW). Submission levels 1 to 5 (level 3 is the common default:
PSW with product samples and complete supporting data). See `references/ppap-elements.md`.

## SPC and capability

- Control charts: X̄-R / X̄-S for subgroups, I-MR for individuals, p/np for defectives,
  c/u for defects. Limits are calculated from the process (I-MR: X̄ ± 2.66 × MR̄), never
  from the specification.
- Out-of-control signals (Western Electric / Nelson style): a point beyond 3σ, runs of
  points on one side of the center line, trends of consecutive increases/decreases.
- Capability: Cp = (USL − LSL) / 6σ, Cpk = min(USL − μ, μ − LSL) / 3σ (within σ);
  Pp/Ppk with overall σ. Typical targets: Cpk ≥ 1.33 for ongoing production, ≥ 1.67 for
  initial studies or special characteristics; customer requirements override.

## MSA

Gage R&R (crossed, ANOVA method): %GRR < 10 % acceptable, 10–30 % conditionally
acceptable depending on application and cost, > 30 % not acceptable; number of distinct
categories (ndc) ≥ 5. Attribute agreement analysis for visual inspection. Re-run after
gauge repair or relocation.

## Audits

Layered process audits (LPA): short checklists done at several management layers on a
schedule; track completion %, non-conformances, and closure time. Product audits and
customer acceptance audits (vehicle-level, defect points per vehicle) feed quality KPIs.

## Standards context

- **IATF 16949:2016** with ISO 9001; certification under the **IATF Rules, 6th edition**
  (in effect from January 2025).
- **Stellantis customer-specific requirements (CSR)** for IATF 16949 are published as a
  single document on the IATF Global Oversight site (issued June 2025, effective July
  2025), replacing earlier division-specific CSRs. Always check the current CSR and the
  supplier portal for requirements such as PPAP submission rules, 8D timing and
  escalation; do not invent them.

## Building apps with these methods

- One record per problem / FMEA line / PPAP element, with child tables for actions.
- Status is a formula derived from dates and required fields, not a free choice.
- Escalation and reminders by pipeline (e.g. containment overdue → notify the owner and
  the quality manager), with the rule documented in the pipeline description.
- Charts: Pareto for defect codes, run/control charts for measurements, aging bars for
  open problems by step. Follow `automotive-ui-design-system`.
