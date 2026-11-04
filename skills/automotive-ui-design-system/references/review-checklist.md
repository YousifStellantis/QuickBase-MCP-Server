# Design review checklist (run before showing or deploying a page)

Context and content
- [ ] Header shows plant / area / line (as applicable), date range or shift, data source, last refresh time.
- [ ] Every number has a unit, a target or comparison, and a fixed number of decimals.
- [ ] Titles are sentence case and say the scope ("Paint shop FTT, last 14 days").
- [ ] No placeholder text, emoji, exclamation marks or marketing verbs.

Visual system
- [ ] Only tokens from `tokens.css` (no stray hex values); one brand accent; status colors only for status.
- [ ] Radius 4–6 px, hairline borders, no glow, no gradient backgrounds, no lift-on-hover.
- [ ] Numbers use tabular figures; IDs (part number, VIN, TID, DBID) use the mono font.
- [ ] KPI strip has 3–6 tiles; tables (not cards) for more than 5 items.

Charts
- [ ] Chart type matches the question (trend, ranking, Pareto, control chart, radar for competency).
- [ ] Horizontal gridlines only; axes labeled with units; bars start at zero.
- [ ] One highlight color; everything else muted; direct labels instead of a legend for ≤ 4 series.
- [ ] Target / limit lines are drawn and labeled.

States and behavior
- [ ] Loading skeletons, a specific empty state, and an inline error with retry exist and were tested.
- [ ] Works with 0 rows, 1 row and 5,000+ rows (pagination, no frozen tab).
- [ ] Keyboard reachable with a visible focus ring; touch targets ≥ 44 px on tablet views.
- [ ] Contrast checked in light and dark mode; status also conveyed by text/shape.
- [ ] Print preview: white background, filters hidden, header and source footer kept.

Quickbase specifics
- [ ] Temp-token auth only; no user tokens or app secrets in the page.
- [ ] All DBIDs/FIDs come from generated constants or `__QB_FIELD__` placeholders.
- [ ] `analyze_code_page` reports no errors.
