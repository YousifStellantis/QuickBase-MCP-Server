---
name: automotive-ui-design-system
description: Design system for Quickbase code pages, dashboards and reports used in automotive plants and engineering (quality, launch, maintenance, competency, KPI boards). Use it for any UI or chart so the result looks like engineered, modern automotive software and not like a generic AI-generated page. Covers tokens, typography, color semantics, layout, components, charts, copy, accessibility and a review checklist.
metadata:
  version: "1.0"
  applies-to: "Quickbase code pages, HTML reports, PDF exports, rich-text pages"
---

# Automotive UI design system

Plant and engineering users read these screens for seconds at a time, often on a
shared TV, a tablet at the line, or a laptop between meetings. The design goal is
**calm, dense, exact**: like an instrument cluster or a good test-bench HMI, not a
marketing landing page.

Before writing markup, read `references/anti-patterns.md`. It lists the patterns
that make a page look machine-generated and what to do instead. Start new pages
from `references/page-template.html` and `references/tokens.css`; use
`references/chart-theme.js` for every Chart.js chart.

## Principles

1. **Data first.** The number, its unit, its target and its trend are the content. Chrome
   (headers, cards, icons) exists only to make those faster to read.
2. **One accent, real status colors.** Use the brand accent sparingly (selection,
   primary action, links). Status colors carry meaning and are never decoration.
3. **Flat and precise.** Hairline borders and spacing create structure. No glow,
   no glassmorphism, no gradient backgrounds, no floating cards.
4. **Context is always visible.** Plant, area/line, shift, date range, data source
   and last refresh time sit in the header. A number without context is a rumor.
5. **Same thing, same place.** Filters top-left, freshness top-right, primary
   action bottom-right of its panel, totals in the last row. Consistency beats novelty.
6. **Built for the floor.** Readable at 3 m on a TV (KPI value ≥ 36 px), touchable
   with gloves on a tablet (targets ≥ 44 px), usable in dark "cockpit" mode.

## Tokens

All values live in `references/tokens.css` as CSS custom properties. Never hardcode
a hex value or pixel size that has a token.

- **Brand slot**: `--brand-*` are neutral placeholders (deep blue). Replace them with
  the official corporate values from your brand portal; never copy a logo or a
  trademarked asset from the web.
- **Neutrals**: graphite scale `--ink-50 … --ink-900`, surfaces `--paper`, `--surface`.
- **Status** (aligned with the IEC 60073 meaning of indicator colors):
  `--ok` green = within target / normal, `--warn` amber = abnormal / at risk,
  `--stop` red = out of target / action required, `--info` blue = information or
  pending, `--idle` gray = no data / not applicable. Always pair color with text or a
  shape (✓ ▲ ■ or a word) for color-blind users and black-and-white printouts.
- **Spacing**: 4 px grid (`--sp-1` 4 px … `--sp-7` 48 px).
- **Radius**: 4–6 px. Pills only for status chips and filters.
- **Motion**: 160 ms, `cubic-bezier(.2,0,0,1)`, opacity/color only. No bounce,
  no translate-on-hover, no animated counters. Respect `prefers-reduced-motion`.

## Typography

- UI: `var(--font-ui)`: Barlow (a DIN-like grotesk with an engineering feel) with
  system fallbacks (Segoe UI on Windows fleets). If web fonts are blocked by the
  corporate proxy, the fallback must still look right; test it.
- Numbers: always `font-variant-numeric: tabular-nums` so columns and KPI tiles do not
  jitter when values update.
- Identifiers (part numbers, VIN, TID, DBIDs, FIDs): `var(--font-mono)`.
- Scale: 12 / 13 / 14 (body) / 16 / 20 / 28 / 36 (KPI). Two weights: 400 and 600.
  Uppercase only for short labels (≤ 3 words) with `letter-spacing: .04em`.
- Units are smaller and lighter than the value: `98.2 <small>%</small>`, `57 <small>JPH</small>`.

## Layout

- 12-column grid, 24 px gutters, max content width 1600 px; dashboards may be full width.
- Header (56 px): product name (text, not a fake logo), context chips, last refresh,
  user/role. Optional left rail for navigation only when there are > 4 sections.
- KPI strip: 3–6 tiles. More than six means the page needs a second view, not smaller tiles.
- Panels: title (sentence case), one-line subtitle stating the scope ("Body shop · last 7 days"),
  content, then a footer with source and definitions link.
- Tables beat cards for anything with more than 5 items. Right-align numbers, left-align
  text, sticky header, zebra rows only above ~20 rows.

## Components (see `references/page-template.html`)

- **KPI tile**: label, value + unit, target, delta vs target with arrow and status color,
  optional 24 px sparkline. No icon badge circles.
- **Status chip**: dot + word (`● On target`, `▲ At risk`, `■ Stopped`).
- **Data table**: sortable headers with a visible sort arrow, sticky first column for IDs,
  inline bars for percentages, row click opens the Quickbase record (`?a=dr&rid=`).
- **Filter bar**: native `<select>`/`<input>` styled with tokens; "Reset" as a text button.
- **States**: loading = skeleton rows (no spinners over content); empty = one sentence with
  the reason and next step ("No defects logged for Line 2 this shift."); error = inline
  banner with what failed, the Quickbase message and a retry button. Never `alert()`.
- **Buttons**: primary (filled brand), secondary (outline), tertiary (text). One primary
  per panel. Labels are verbs: "Export PDF", "Open 8D", "Assign".

## Charts

Use `references/chart-theme.js` (Chart.js 4, pinned version). Rules:

- Pick the chart for the question: trend → line/run chart with target line; ranking →
  horizontal bar sorted descending; defects → Pareto (bars + cumulative % line);
  process stability → control chart with mean, UCL, LCL; part-to-whole → stacked bar
  (pie only for ≤ 4 slices); competency → radar with required level dashed and current filled.
- Label directly at line ends instead of a legend when there are ≤ 4 series.
- Gridlines: horizontal only, `--ink-100`. No 3D, no shadows, no gradient fills
  (a 10–15 % flat fill under a single line is fine).
- Axes start at zero for bars. Always show units in the axis title or tick labels.
- Highlight one thing. Gray out the rest (`--ink-300`), color only what needs attention.

## Copy

- Sentence case for titles and buttons. No exclamation marks, no emoji, no marketing
  verbs ("unlock", "empower", "seamless", "supercharge", "insights at a glance").
- Plant vocabulary: shift, line, station, takt, FTT, DPU, containment, 8D, PPAP, launch
  gate. Write what the user does, not what the software is.
- Numbers: thousands separators, fixed decimals per metric (PPM 0 dp, % 1 dp, OEE 1 dp),
  dates as `2026-11-04` or `Nov 4`, times in 24 h with the plant time zone.
- Empty, error and help text are specific and short. Say what happened and what to do.

## Accessibility and print

- Text contrast ≥ 4.5:1 (≥ 3:1 for large KPI values); check dark mode separately.
- Visible `:focus-visible` outline using `--focus-ring`; every control reachable by keyboard.
- `@media print`: white background, no shadows, hide filters/buttons, keep the context
  header and the source footer, avoid page breaks inside tables rows and charts.
- Language attribute set (`<html lang="en">`), `<title>` matches the page heading.

## Dark "cockpit" mode

For andon TVs and control rooms: `data-theme="dark"` on `<html>`, or follow
`prefers-color-scheme`. Dark surfaces are graphite (`#0f1216`), not pure black; status
colors are lifted for contrast (tokens handle this). Never invert charts by CSS filter.

## Review checklist

Run `references/review-checklist.md` before you show or deploy a page. Then run the
`analyze_code_page` tool. A page ships when both are clean.
