---
name: automotive-software-compliance
description: Software-defined-vehicle engineering context and compliance frameworks - ISO 26262 functional safety (ASIL), ISO 21448 SOTIF, ISO/SAE 21434 cybersecurity (TARA), UNECE R155 CSMS and R156 SUMS (software updates, RXSWIN), ISO 24089, Automotive SPICE 4.0, AUTOSAR, TISAX - and how to model traceability, TARA registers, vulnerability handling, OTA campaign records and supplier assessments in Quickbase. Use for engineering tracking apps, program dashboards, or questions about these standards.
metadata:
  version: "1.0"
---

# Automotive software and compliance

## Context

Vehicles are moving to central compute and software platforms with over-the-air
updates. Stellantis' platform names are **STLA Brain** (central compute and software
architecture), **STLA SmartCockpit** (in-vehicle experience) and **STLA AutoDrive**
(automated driving), developed with partners, within the FaSTLAne 2030 plan presented
at the May 2026 Investor Day. Engineering tracking around these programs is mostly
about **traceability, evidence and change control**, which is where a Quickbase app helps
(it does not replace ALM tools such as requirements or test management systems).

## Frameworks (what each asks you to prove)

| Framework | Scope | Key artifacts to track |
|---|---|---|
| ISO 26262:2018 | functional safety of E/E systems | item definition, HARA, ASIL A–D per safety goal, safety requirements, safety case, confirmation reviews |
| ISO 21448:2022 (SOTIF) | hazards from functional insufficiencies (e.g. perception limits) without a fault | triggering conditions, known/unknown unsafe scenarios, validation coverage |
| ISO/SAE 21434:2021 | cybersecurity engineering across the lifecycle | TARA (assets, threat scenarios, attack feasibility, impact, risk treatment), cybersecurity goals, vulnerability management, incident response |
| UNECE R155 | cybersecurity management system (CSMS), type approval | CSMS certificate, vehicle-type risk assessment, monitoring and response evidence |
| UNECE R156 / ISO 24089 | software update management system (SUMS) | software identification (RXSWIN), update campaigns, compatibility checks, user information, safety during update |
| Automotive SPICE 4.0 | process capability for software/system development (supplier assessments) | process assessments per process (SWE, SYS, SUP, MAN …), capability levels 0–5, findings and improvement plans |
| AUTOSAR (Classic / Adaptive) | standard ECU software architectures | module versions, configuration baselines |
| TISAX (VDA ISA) | information security in the supply chain | assessment level, scope, label validity, findings |

R155/R156 became mandatory in the EU for new vehicle types from July 2022 and for all
new vehicles from July 2024; other UNECE markets adopt them on their own timelines.

## Quickbase models that work

- **Traceability matrix**: Requirements (ID, ASIL/CAL, source) ↔ Design elements ↔
  Tests (method, result, evidence link) with relationship counts that flag requirements
  without tests and tests without requirements. Import from the ALM tool on a schedule
  (pipeline or script); Quickbase is the reporting layer.
- **TARA register**: Assets → Damage scenarios → Threat scenarios (attack path, feasibility
  rating, impact rating) → Risk value (formula) → Treatment (avoid/reduce/share/retain)
  → Cybersecurity requirements. Keep rating tables as lookup tables so methods can change.
- **Vulnerability management**: CVE/advisory intake, affected components (SBOM link),
  triage (CVSS + vehicle context), decision, fix release, closure; SLA formulas by severity.
- **OTA campaign record (R156 evidence)**: campaign ID, affected vehicle population
  (VIN ranges / configuration), software versions before/after, RXSWIN, approval steps,
  pre-conditions (battery state, parked), rollout waves, success/failure counts, rollback.
- **Supplier ASPICE / TISAX tracker**: supplier, process scope, target vs achieved level,
  findings with due dates, re-assessment dates.

## Rules for these apps

- Every status change needs who/when/why (audited fields or a history child table).
- Evidence is a link or file, not a checkbox alone.
- Ratings come from lookup tables with versioned methods, not free numbers.
- Access is need-to-know; vulnerability details are confidential until fixed.
- Do not paste confidential engineering data into public AI tools; this server talks
  only to your Quickbase realm, but the AI client's own data policy still applies.
