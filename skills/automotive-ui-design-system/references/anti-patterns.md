# Patterns that make a page look AI-generated (and what to do instead)

These are the tells reviewers notice first. Each one is cheap to avoid.

| Avoid | Why it reads as generated | Do this instead |
|---|---|---|
| Purple/indigo-to-blue gradients, gradient headers and buttons | The default "AI demo" palette; says nothing about the data | Flat brand color for one primary action; graphite neutrals everywhere else |
| Radial "glow" blobs in the page background | Decoration with no meaning, hurts contrast | Solid `--paper` / `--surface-sunken` backgrounds |
| Glowing logo squares with a single letter or emoji | Fake branding | The product name in text, set in the UI font. Use the real logo only if brand provides one |
| Emoji as icons (🚀 📊 ✅) | Unprofessional on a plant TV, inconsistent rendering | No icon, or a simple inline SVG line icon (1.5 px stroke, `currentColor`) |
| Big rounded cards (16–24 px radius) with heavy drop shadows | Consumer-app look, wastes space | 4–6 px radius, hairline border, no shadow (or `--shadow-1` for menus only) |
| Hover effects that lift elements (`translateY(-4px)`) | Feels like a template; jumps under the cursor | Color/border change only, 160 ms |
| Colored icon circles on every KPI tile | Visual noise; color without meaning | Label, value, unit, target, delta. Color only the delta/status |
| Animated counting numbers, pulsing dots, shimmer everywhere | Slows reading, distracts on the floor | Render the final value; skeletons only while loading |
| Inter/Poppins + center-aligned hero text | The generic template stack | Barlow / Segoe UI, left-aligned, data at the top |
| Vague marketing copy: "Unlock insights", "Empower your team", "seamless" | Not how engineers talk | Name the metric, scope and action: "Body shop DPU, last 7 days" |
| Title Case Everywhere And Exclamation Marks! | Shouty | Sentence case, no exclamation marks |
| Rainbow charts (each bar a different color) | Color carries no meaning | One color; highlight the bar that needs attention |
| Pie charts with 8+ slices, donut "progress rings" for everything | Hard to compare | Sorted horizontal bars; a plain number with target |
| 3D charts, drop shadows on charts, gradient fills | Distorts values | Flat marks, horizontal gridlines only |
| Legends for a single series; legends far from the data | Extra work for the eye | Direct labels at line ends |
| Status shown by color only | Fails color-blind users and grayscale print | Color + word/shape: `▲ At risk` |
| Placeholder content: "Lorem ipsum", "John Doe", "Acme Corp" | Obvious template | Real field labels from the schema; realistic sample values |
| `alert()` popups and spinners covering the screen | Blocks work | Inline error banner with retry; skeleton rows |
| Hardcoded hex colors and pixel values sprinkled in markup | Inconsistent, impossible to rebrand | Tokens from `tokens.css` |
| Several "primary" buttons per panel | No hierarchy | One primary, others outline or text |
| Decorative stock-style section dividers, wavy SVG separators | Marketing-site leftovers | Spacing and a `--divider` line |

Quick self-test: remove every color that is not brand-accent or status. If the page
still makes sense and the important numbers still stand out, the design is right.
