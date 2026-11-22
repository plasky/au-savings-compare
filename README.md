# au-savings-compare

A personal web app for comparing Australian savings accounts, term deposits and cash ETFs, and projecting interest for a household with joint accounts.

Product and rate data comes from the **Consumer Data Right (Open Banking) product reference data** APIs that Australian banks must publish. A nightly GitHub Action crawls every bank, checks data quality and publishes a normalised snapshot (`products.json`) to the `data` branch. The web app at **https://plasky.github.io/au-savings-compare/** loads that snapshot and does every calculation in the browser; your settings stay in your browser's local storage.

See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Status

**Phases 0–3 done.** Nightly data pipeline, calculation engine, `products.json` catalogue, and the web app (compare, plan with an optimiser, projections). Next: phase 4 (bonus checklist, cash flows and goals, "My accounts").

## Layout

```
apps/web/            The web app (React + Vite); reads products.json, runs the engine in the browser
packages/engine/     Interest, condition, household-tax, ranking, FCS and optimiser engine (pure TypeScript)
packages/pipeline/   CDR crawler, review tooling, normaliser, catalogue, quality report, `rank` command (Node 22)
curation/            reviews.json (weekly Claude reviews), brands.json (restricted banks, display names)
.github/workflows/   crawl.yml (nightly), deploy.yml (GitHub Pages), ci.yml (typecheck, tests, build)
docs/PLAN.md         product and technical plan
```

The **`data` branch** holds `latest/` (the most recent crawl) and `cache/conditions.json` (Claude extraction cache, so unchanged text is never re-sent). Git history on that branch is the rate history.

`latest/` contains:
- `raw/<brand>.json`: one file per bank endpoint, with full product details
- `status.json`: per-endpoint outcome, API versions and CORS behaviour
- `register.json`: all CDR data-holder brands
- `products.json`: the normalised catalogue the web app loads, with FCS institution groups
- `review-queue.json`: products waiting for the weekly review
- `report.md` / `report.json`: coverage and data-quality report

## Running locally

```bash
pnpm install
pnpm test
pnpm --filter @asc/pipeline exec tsx src/cli.ts crawl --out out --limit 5   # quick crawl of 5 banks
ANTHROPIC_API_KEY=... pnpm --filter @asc/pipeline exec tsx src/cli.ts extract --out out
pnpm --filter @asc/pipeline exec tsx src/cli.ts report --out out             # writes out/report.md
pnpm --filter @asc/pipeline exec tsx src/cli.ts rank --out out --balance 50000 --deposit 1000 --purchases 5   # rank real products
pnpm --filter @asc/pipeline exec tsx src/cli.ts catalogue --out out          # writes out/products.json

# Web app against a local catalogue
pnpm --filter @asc/web data:local "$PWD/out/products.json"   # copies it into apps/web/public/data
pnpm dev                                               # http://localhost:5173/au-savings-compare/
```

## Condition reviews

Bonus conditions, and how each product's rate rows combine, are reviewed weekly by Claude in a chat session, with no API key needed. The crawl lists what needs reviewing in `latest/review-queue.json`, and reviews are committed to `curation/reviews.json`. See [docs/WEEKLY_REVIEW.md](docs/WEEKLY_REVIEW.md).

Optional paid path: set the repo variable `USE_ANTHROPIC_API=true` and the `ANTHROPIC_API_KEY` secret (with API credit) to also run per-row extraction through the API every night.

## Data and disclaimer

CDR product data is published by data holders, and the CDR Rules (r 2.6) prohibit restrictions on its use. Rates can be wrong or stale, so always check with the bank. This is general information, not financial advice.
