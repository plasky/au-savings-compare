# au-savings-compare

A personal web app for comparing Australian savings accounts, term deposits and cash ETFs, and projecting interest for a household with joint accounts.

Product and rate data comes from the **Consumer Data Right (Open Banking) product reference data** APIs that Australian banks must publish. A nightly GitHub Action crawls every bank, extracts bonus-rate conditions with Claude, checks data quality and publishes a snapshot to the `data` branch. The web app, which is still to come, will load that snapshot and do every calculation in the browser.

See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Status

**Phase 1 done.** The data pipeline runs nightly, and the calculation engine plus a command-line `rank` preview work against real banks. Next: the normalised `products.json` and then the web app.

## Layout

```
packages/engine/     Interest, condition and household-tax engine (pure TypeScript)
packages/pipeline/   CDR crawler, review tooling, normaliser, quality report, `rank` command (Node 22)
curation/            reviews.json (weekly Claude reviews), brands.json (membership-restricted banks)
.github/workflows/   crawl.yml (nightly + manual + on pipeline changes), ci.yml (typecheck + tests)
docs/PLAN.md         product and technical plan
```

The **`data` branch** holds `latest/` (the most recent crawl) and `cache/conditions.json` (Claude extraction cache, so unchanged text is never re-sent). Git history on that branch is the rate history.

`latest/` contains:
- `raw/<brand>.json`: one file per bank endpoint, with full product details
- `status.json`: per-endpoint outcome, API versions and CORS behaviour
- `register.json`: all CDR data-holder brands
- `conditions.json`: Claude's structured bonus conditions
- `report.md` / `report.json`: coverage and data-quality report

## Running locally

```bash
pnpm install
pnpm test
pnpm --filter @asc/pipeline exec tsx src/cli.ts crawl --out out --limit 5   # quick crawl of 5 banks
ANTHROPIC_API_KEY=... pnpm --filter @asc/pipeline exec tsx src/cli.ts extract --out out
pnpm --filter @asc/pipeline exec tsx src/cli.ts report --out out             # writes out/report.md
pnpm --filter @asc/pipeline exec tsx src/cli.ts rank --out out --balance 50000 --deposit 1000 --purchases 5   # rank real products
```

## Condition reviews

Bonus conditions, and how each product's rate rows combine, are reviewed weekly by Claude in a chat session, with no API key needed. The crawl lists what needs reviewing in `latest/review-queue.json`, and reviews are committed to `curation/reviews.json`. See [docs/WEEKLY_REVIEW.md](docs/WEEKLY_REVIEW.md).

Optional paid path: set the repo variable `USE_ANTHROPIC_API=true` and the `ANTHROPIC_API_KEY` secret (with API credit) to also run per-row extraction through the API every night.

## Data and disclaimer

CDR product data is published by data holders, and the CDR Rules (r 2.6) prohibit restrictions on its use. Rates can be wrong or stale, so always check with the bank. This is general information, not financial advice.
