# Screenshots

Referenced by the root README. Capture these with the app running
against the fixtures (`npm run dev` and `npm run fixtures`), signed in, at a 1440x900 window.

They are not committed as placeholders on purpose: a README showing a screenshot of an empty
dashboard is worse than one showing none.

| File | What to capture | Why it matters |
| --- | --- | --- |
| `run-detail.png` | A run detail page with a **failing assertion expanded** | Shows expected vs actual per assertion: the evidence that the LLM did not judge itself |
| `security-finding.png` | A finding card with its **payload and baseline** visible | Shows the differential, not just a verdict |
| `clean-scan.png` | The hardened fixture scanned: the clean-result panel | The designed empty state, with its honest disclaimer |
| `permission-sheet.png` | The permission sheet open, `network.probe` **unchecked** | The moment the architecture becomes visible to a person |
| `tool-registry.png` | Tool Registry with a schema expanded | Schemas are generated from Zod, never hand-written |
| `audit-log.png` | Audit Log filtered to `blocked_ssrf` | The clearest evidence that the guard works |
| `dashboard.png` | Dashboard with real runs | Every figure is a Mongo aggregation |

To produce a `blocked_ssrf` row: grant `network.read` for `169.254.169.254` in the API Client,
then request `http://169.254.169.254/latest/meta-data/`. The permission gate passes and the egress
guard refuses anyway, which is the point worth showing.
