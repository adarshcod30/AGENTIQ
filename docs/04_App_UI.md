# 04 · How it should look and feel

### Light, professional, developer-grade. Boring on purpose.

**The north star:** it should look like a tool a working backend engineer would actually leave open
in a tab: calm, dense, legible, obviously trustworthy. Think Stripe Dashboard, Linear, GitHub
settings, Vercel. **Not** a hackathon dark-neon "AI platform".

> A dark cyber-console with glowing accents and a hardcoded number in a stat card looks impressive
> in a screenshot and untrustworthy in person. If a screen ever makes you feel clever, it has
> probably been made worse.

Light surfaces, restrained colour, evidence everywhere, and colour reserved for meaning.

---

## 1. Principles

1. **Light only.** No dark theme. A security-and-testing tool that looks like a game console
   invites the reader to doubt the numbers. One theme, done properly, beats two done adequately.
2. **Colour means something.** Red is a real finding. Amber is a real warning. Green is a real
   pass. The moment you use red for decoration it stops meaning anything.
3. **Evidence on demand.** Every result, finding and metric has a visible "why?": the payload,
   the baseline, the assertion. Nothing is a black box. *This is the most important principle here.*
4. **Density with air.** Developers read tables. Tight rows, generous section spacing.
5. **Monospace for machine data.** URLs, methods, status codes, headers, payloads, IDs, durations,
   token counts. Prose is sans. The eye should sort them without effort.
6. **Honest states.** Zero is zero. Empty is empty. Never fill a chart to look alive.
7. **WCAG 2.1 AA.** ≥ 4.5:1 body contrast, visible focus, full keyboard operation, never
   colour-only meaning.

---

## 2. Design tokens

Tailwind v4: tokens are **CSS**, in `web/src/index.css`. There is no `tailwind.config.js`.

```css
@import "tailwindcss";

@theme {
  /* Brand: deep, sober blue. Chrome, primary actions, active nav. */
  --color-primary:      #1B4D89;
  --color-primary-700:  #143A68;
  --color-primary-50:   #EDF3FA;

  /* Interactive: links, focus, selected */
  --color-accent:       #2563C9;
  --color-accent-50:    #EAF1FC;

  /* Surfaces */
  --color-surface:      #FFFFFF;   /* cards, panels */
  --color-surface-2:    #F6F8FB;   /* app background */
  --color-surface-3:    #EDF1F7;   /* wells, table headers, code blocks */
  --color-line:         #DDE4ED;   /* borders, dividers */

  /* Text */
  --color-ink:          #131A24;
  --color-ink-muted:    #5A6779;
  --color-ink-subtle:   #8A94A3;

  /* Semantic: findings, verdicts, status. Use ONLY for meaning. */
  --color-success:      #17794A;
  --color-success-50:   #E8F5EE;
  --color-warning:      #B5730B;
  --color-warning-50:   #FDF3E3;
  --color-danger:       #C0392B;
  --color-danger-50:    #FBEDEB;
  --color-info:         #2563C9;
  --color-info-50:      #EAF1FC;

  /* Severity: findings only */
  --color-sev-critical: #8E1F16;
  --color-sev-high:     #C0392B;
  --color-sev-medium:   #B5730B;
  --color-sev-low:      #5A6779;

  /* HTTP methods: chips only, never backgrounds */
  --color-method-get:    #17794A;
  --color-method-post:   #2563C9;
  --color-method-put:    #B5730B;
  --color-method-patch:  #6B3FA0;
  --color-method-delete: #C0392B;

  --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --radius-card: 8px;
  --radius-ctl:  6px;

  --shadow-card:  0 1px 2px rgba(19, 26, 36, .06);
  --shadow-hover: 0 4px 12px rgba(19, 26, 36, .10);
  --shadow-pop:   0 8px 28px rgba(19, 26, 36, .14);
}
```

**Discipline:** the entire base UI is ink-on-white with primary blue chrome. Semantic colours appear
only on verdicts, findings and status. If a screen has more than three colour families visible at
once, you have decorated something.

## 3. Typography

Inter (UI) + JetBrains Mono (machine data). Both are self-hosted via `@fontsource`, so the UI never
depends on a CDN at runtime.

| Role | Size / weight / leading |
|---|---|
| Display | 28 / 600 / 1.25 |
| H1 (page) | 22 / 600 / 1.3 |
| H2 (section) | 17 / 600 / 1.35 |
| H3 (card) | 15 / 600 / 1.4 |
| Body | 14 / 400 / 1.55 |
| Small / meta | 12.5 / 400 / 1.45 |
| Label (uppercase, tracked) | 11 / 600 / 0.06em |
| Mono inline | 13 / 450 |
| Mono block | 12.5 / 400 / 1.6 |

**`font-variant-numeric: tabular-nums` on every metric, duration, count and status code.** Without
it, KPI cards jitter as numbers change and live progress rows visibly twitch.

## 4. Spacing, shape, motion

- 8px grid: 4 / 8 / 12 / 16 / 24 / 32 / 48. Page gutter 24 (32 ≥ 1440px). Card padding 20.
- Radius: 8 cards, 6 inputs/buttons, 4 chips-square, 999 pills.
- Elevation stays subtle. Cards are `border + shadow-card`. Only modals and popovers get `shadow-pop`.
- Icons: Lucide, 1.75px stroke. 18px nav, 16px inline, 14px in chips.
- Motion 120-200ms, `ease-out`. Skeletons, not spinners. Respect `prefers-reduced-motion`.
- One moment of delight: run-progress rows resolving from `○` → `⟳` → `✓` as each step lands. That
  is enough. No confetti, no glow, no gradient text.

## 5. The shell

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ▣ AGENTIQ          Test Runner                        [+ New run]  [AD ▾]  │  56px, white, bottom border
├──────────────┬─────────────────────────────────────────────────────────────┤
│              │                                                             │
│  WORK        │   ┌───────────────────────────────────────────────────┐    │
│  ◇ Dashboard │   │                                                   │    │
│  ▶ Test Run  │   │   PAGE CONTENT   max-width 1280, centred          │    │
│  ⛉ Security  │   │                                                   │    │
│  ⛁ Specs     │   │                                                   │    │
│  ⇄ API Client│   │                                                   │    │
│  ⧗ History   │   │                                                   │    │
│  ⬆ Deploy    │   │                                                   │    │
│              │   └───────────────────────────────────────────────────┘    │
│  TRUST       │                                                             │
│  ⚙ Tools     │                                                             │
│  ☰ Audit     │                                                             │
│  ⓘ About     │                                                             │
│              │                                                             │
│  ── ─────────│                                                             │
│  Groq · free │   footer: LLM provider · build sha · fixture mode           │
└──────────────┴─────────────────────────────────────────────────────────────┘
     240px                       bg: surface-2
```

Sidebar 240px, white, right border, collapsible to 64px icons-only ≥ 1280, drawer below 1024.
Active item: `primary-50` fill, 2px `primary` left rule, `primary` text.

**The TRUST group is deliberate.** It signals that verification is a first-class part of the
product, and it puts the two pages that substantiate your architecture claim one click from
anywhere.

**Topbar carries no decorative badges.** A static chip asserts something nothing ever checked. Any
status shown is derived from real state, like the live LLM-provider chip that reads from
`/api/health`.

## 6. Components

**Button**: `primary` (filled `--color-primary`, white text) · `secondary` (white, `line` border) ·
`ghost` (transparent, muted text) · `danger` (filled `--color-danger`, for destructive only).
Heights 32 / 36 / 40. Always show a loading state in place, never swap to a spinner-only button.

**Card**: `bg-surface border border-line rounded-card shadow-card`. Optional header row with H3
plus right-aligned actions.

**KPI card**: 11px uppercase label, 30px `tabular-nums` value, 12.5px delta with an arrow. Delta is
`success`/`danger` **only when the direction genuinely means good/bad**: more findings is not
"green" just because it went up.

**Input / Select / Textarea**: 36px, `line` border, `accent` on focus with a 2px ring. Label above,
help text below, error text replaces help in `danger`. **URL and payload fields use mono.**

**Chip**: pill, 11px, 600. Variants: method (mono, coloured text on `surface-3`), severity (filled
tint), status (`pass` success / `fail` danger / `skip` muted), risk class (`local.compute` neutral,
`network.read` info, `network.probe` warning, `deploy.write` danger).

**Data table**: sticky header on `surface-3`, 40px rows, hover `surface-2`, zebra off, row-click to
detail, sortable headers, filter chips above, density toggle. All numerics `tabular-nums` and
right-aligned.

**Code block**: `surface-3`, `line` border, mono 12.5, copy button top-right, wrap toggle, ≤ 400px
then scroll. Used for payloads, raw responses, JSON Schemas.

**Assertion row**: the workhorse of the app:

```
✗  status              expected  401     actual  200
   ↑ 16px icon         ↑ mono label      ↑ mono, danger when mismatched
```

Full width, 32px, `danger-50` tint on fail. Never collapse a failing assertion by default.

**Finding card**: left severity rule 3px, severity chip + OWASP chip in the header, collapsed to
one-line summary, expanded to payload / signal / baseline / meaning / fix.

**Permission sheet**: centre modal, `shadow-pop`, host in mono and bold, one checkbox per risk
class with a plain-English description, `network.probe` **unchecked by default**, a one-line
authorisation warning, Cancel + Allow. Never auto-dismissing, never a toast.

**Progress list**: one row per step: state icon, label, elapsed (mono, tabular), result summary.
Completed rows stay visible. This replaces every full-page spinner in the app.

**Empty state**: centred, 40px muted icon, one-line heading, one sentence of guidance, one primary
action. Never a zero-filled chart.

**Toast**: bottom-right, 4s, icon + text, single action. Errors persist until dismissed.

## 7. Screens

**Landing**: one-sentence value proposition, one screenshot of a real run detail, three feature
blocks (executed tests, real security evidence, audited tool layer), one CTA. No animated gradients.

**Login / Signup**: centred 400px card, email/password, "Continue with Google", clear error text.

**Dashboard**: four KPI cards (runs, tests executed, pass rate, open findings by severity), a
14-day pass/fail bar chart, findings-by-severity donut, recent runs table. Every value from
`/api/runs/stats`. New account → honest zeros and "Run your first test".

**Test Runner**: two columns ≥ 1280: form left (400px, sticky), results right. Single column below.
Form: URL (mono), method select, description textarea, spec attach, "intended public" checkbox,
"also scan" checkbox, submit. Results: progress list → summary strip → Functional/Security tabs.

**Run detail**: header (method chip, URL mono, timestamp, duration, re-run action), summary strip,
tabs. Grounding chip when spec-backed.

**Security**: target form, six family cards showing `not run` / `running` / `clean` / `N findings`,
then findings sorted by severity. Clean state is a designed green panel with the honest
"not a guarantee" sentence, not an empty div.

**Specs**: imported specs as cards (title, version, operation count, source). Detail: searchable
operation table with method chip, path (mono), summary, "Generate tests" per row.

**API Client**: Postman layout: method + URL bar + Send; Params/Headers/Body tabs left; response
Body/Headers/Timing right, with status, size and duration in mono. Actions: "Save as test case",
"Scan this endpoint".

**History**: filterable table: date, method chip, URL, tests, pass rate bar, findings chip,
duration. Search by URL, filter by verdict and date.

**Deploy**: connection status, form, pre-flight checklist with tick/warn per item, deployment
records with post-deploy verification results. If scoped out: a plain notice saying so and linking
to About.

**Tool Registry**: a table of every registered tool: name (mono), title, description, risk chip, and an
expandable live JSON Schema. Header note: *"Fetched from the running server's MCP registry. Nothing
on this page is hardcoded."*

**Audit Log**: reverse-chronological: timestamp (mono), tool (mono), risk chip, target host (mono),
outcome chip, duration. Filters for run, tool, outcome. **`denied` and `blocked_ssrf` rows get a
danger left rule**: they are the most persuasive rows in the product.

**Settings**: profile, linked auth providers, LLM provider and key status (never render a key, show
`gsk_••••4f2a`), active host grants with revoke, danger zone.

**About:** the acknowledgement that a clean scan is not a security guarantee, what each probe
family does and does not cover, how to check the architecture claim yourself (the four risk
classes, the Tool Registry and the Audit Log), and what is out of scope. It sits in the TRUST group
and answers the obvious questions before anyone has to ask them.

## 8. Accessibility

AA contrast everywhere (the token pairs above are compliant on their intended surfaces). Visible
2px `accent` focus rings, never `outline: none`. Full keyboard operation including the permission
sheet (focus trap, Esc cancels, Enter does **not** auto-allow). ARIA labels on every icon-only
control. Assertion pass/fail carries an icon *and* text, never colour alone. Hit targets ≥ 36px.
`aria-live="polite"` on the run progress list so screen readers hear steps complete.

## 9. Responsive

| Width | Layout |
|---|---|
| ≥ 1440 | Full shell, 32px gutter, two-column runner |
| 1280-1439 | Full shell, 24px gutter |
| 1024-1279 | Sidebar collapses to icons, runner single column |
| 768-1023 | Sidebar becomes a drawer, tables scroll horizontally |
| < 768 | Stacked, cards over tables, form-first |

Desktop-first is the correct call, nobody scans an API from a phone, but nothing may be *broken*
on mobile.

## 10. Things that are explicitly forbidden

Each of these erodes trust:

- Dark theme, neon accents, glow effects, gradient text.
- Any hardcoded metric anywhere in the component tree.
- Static status badges asserting capability ("MCP Powered", "Agents Online", "Simulation Mode").
- Full-page spinners.
- Red or amber used decoratively.
- Fake progress bars that animate independently of real work.
- Emoji in the product UI. (In code comments and commits, fine.)
- A chart rendered with placeholder data when the real query returns empty.
