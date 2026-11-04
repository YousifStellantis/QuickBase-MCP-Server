# Modern automotive skills for Stellantis: research notes

Snapshot: November 2026. Two readings of "skills" matter here, and the server covers both:

1. **Agent skills**: playbooks the AI loads so its Quickbase work (apps, code pages,
   pipelines, reports) uses automotive methods and looks like professional plant software.
2. **Workforce skills**: the competencies Stellantis plants and engineering teams need,
   which is exactly what the SIS competency radar app in this repository tracks.

## Where Stellantis is heading (public sources)

- **FaSTLAne 2030**: a €60 billion, five-year plan presented at the May 2026 Investor Day,
  with AI embedded across the business and the **STLA One** architecture; by 2030 half of
  global volume is planned on three global platforms.
- **Software-defined vehicles**: **STLA Brain** (central compute and software
  architecture), **STLA SmartCockpit**, **STLA AutoDrive**, with partners including Applied
  Intuition (software development, simulation, validation), Wayve (AI driving software),
  Qualcomm, NVIDIA and Mistral AI.
- **AI in operations**: more than 120 AI applications reported in operations; an April 2026
  collaboration with Microsoft covering more than 100 AI initiatives, including enterprise
  AI tools and a dedicated training program for the workforce.
- **Manufacturing**: AI, robotics and vision pilots across 60+ plants ("Factory Booster");
  digital-twin pilots with Accenture and NVIDIA planned in North America for 2026; earlier
  reported gains include a 40 % reduction in quality issues since 2021 (2024 release).
- **Production system**: World Class Manufacturing, with 10 technical and 10 managerial
  pillars; plants are audited and scored 0–5 per technical pillar.
- **Quality system**: a single **Stellantis customer-specific requirements** document
  for IATF 16949 (issued June 2025, effective July 2025), with the AIAG/VDA core tools
  (APQP/PPAP, FMEA, SPC, MSA) as the working vocabulary; IATF Rules 6th edition in force
  since January 2025.

## What that means for skills

| Area | Skills in demand | Agent skill in this server |
|---|---|---|
| Plant operations (WCM) | loss/cost deployment, autonomous and professional maintenance, workplace organization, people development, launch management | `plant-competency-matrix`, `plant-kpi-dictionary` |
| Quality | 8D/5-Why/QRQC, PFMEA with Action Priority, control plans, PPAP/APQP, SPC, MSA, layered audits, CSR compliance | `automotive-quality-core-tools` |
| Electrification | high-voltage safety authorization, battery pack/module assembly and test, thermal-event response | `plant-competency-matrix` (skills catalog) |
| Automation | robot recovery and programming (KUKA, FANUC), PLC troubleshooting (Rockwell, Siemens), industrial networks, safety circuits, vision/AI inspection, DC torque tools and error-proofing | `plant-competency-matrix` (skills catalog) |
| Software-defined vehicle | ISO 26262, SOTIF, ISO/SAE 21434 + UNECE R155, R156/ISO 24089 OTA updates, ASPICE 4.0, AUTOSAR, TISAX | `automotive-software-compliance` |
| Data and AI | data literacy (control charts, Pareto), low-code apps, responsible AI use, OT cybersecurity awareness | `plant-competency-matrix`, `automotive-ui-design-system` |
| Digital tools on Quickbase | schema discipline, query language, code pages, pipelines, solutions | `quickbase-*` skills |

Industry reporting (mostly recruiter and vendor analyses, so treat figures as indicative)
consistently names the hardest roles to fill: multi-craft maintenance technicians with PLC
and robot skills, high-voltage battery technicians, and mechatronics specialists combining
both. These map directly onto the "M" (maintenance) and "LA" (launches) domains and the
station categories (KUKA, battery, DC tool, AVI) already present in the radar dashboard.

## How the radar app lines up

The SIS radar code pages use twelve domains: Plant Ambition Roadmap, Losses Deployment,
Health and Safety, Quality, Environment, Continuous Improvement, Workplace Organization,
Maintenance, Energy, Logistics, People Development, Launches, on a 0–5 scale with
required levels per position. That is the WCM structure. The `plant-competency-matrix`
skill keeps the agent consistent with it: domains in a lookup table, binary certifications
kept off the radar (or plotted 0/5 and labeled), the 3×3 flexibility rule, and gap
priority = gap × criticality.

## Design language for automotive software

"Does not look AI-generated" comes down to removing decoration and adding precision:
graphite neutrals, one brand accent, IEC 60073-style status colors paired with words or
shapes, tabular numerals, hairline structure, context (plant, line, shift, freshness) in
every header, and charts chosen for plant questions (Pareto, run/control charts, radar for
competency). The `automotive-ui-design-system` skill encodes this with tokens, a page
template, a Chart.js theme, an anti-pattern list and a review checklist. Swap the
placeholder brand tokens for the official palette from the corporate brand portal; do not
copy logos or brand assets from the web.

## Sources

- [Stellantis unveils €60 billion strategic plan (May 2026)](https://www.stellantis.com/en/news/press-releases/2026/may/stellantis-unveils-60-billion-euro-strategic-plan-to-accelerate-growth-and-profit)
- [SEC filing: €60 billion, five-year strategic plan](https://www.sec.gov/Archives/edgar/data/1605484/000160548426000047/a99205222026_stla.htm)
- [Stellantis Investor Day 2026 transcript (FaSTLAne 2030)](https://www.stellantis.com/content/dam/stellantis-corporate/investors/events/stellantis-investor-day-2026/transcript/Stellantis-Investor-Day-2026-FaSTLAne2030-Transcript-Full.pdf)
- [Stellantis and Applied Intuition expand collaboration on STLA Brain](https://www.stellantis.com/en/news/press-releases/2026/may/stellantis-and-applied-intuition-expand-collaboration-with-stla-brain-to-advance-vehicle-software-and-enhance-customer-experience)
- [Stellantis and Microsoft: AI-led strategy (April 2026)](https://www.stellantis.com/en/news/press-releases/2026/april/stellantis-accelerates-ai-led-strategy-and-digital-transformation-through-strategic-collaboration-with-microsoft-to-enhance-customer-experiences)
- [Constellation Research: how Stellantis aims to leverage AI](https://www.constellationr.com/insights/news/how-stellantis-aims-leverage-ai-technology-turnaround)
- [Stellantis deploys AI-enabled manufacturing innovations (Sept 2024)](https://www.stellantis.com/en/news/press-releases/2024/september/stellantis-deploys-ai-enabled-innovations-to-boost-manufacturing-efficiency-sustainability-and-improve-workplace)
- [Stellantis and Accenture with NVIDIA: AI-driven manufacturing](https://newsroom.accenture.com/news/2026/stellantis-and-accenture-announce-plans-for-a-strategic-partnership-to-advance-ai-driven-manufacturing-with-nvidia)
- [Over sixty Stellantis plants bet on AI and robotics (ClubAlfa)](https://www.clubalfa.it/en/over-sixty-stellantis-plants-bet-on-ai-and-robotics-to-fix-manufacturing-chaos-46705)
- [Stellantis joins the World Class Manufacturing body (Automotive World)](https://www.automotiveworld.com/news/stellantis-joins-world-class-manufacturing-body/)
- [IATF Global Oversight: Stellantis CSR update (June 2025)](https://www.iatfglobaloversight.org/news/13-june-2025-stellantis-customer-specific-requirements-update/)
- [Workforce: Chattanooga automotive EV talent gap (KiTalent)](https://kitalent.com/articles/chattanooga-automotive-ev-talent-gap.md),
  [Kansas City EV workforce (KiTalent)](https://kitalent.com/articles/kansas-city-automotive-ev-talent)
