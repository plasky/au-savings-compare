# au-savings-compare

A personal web app for comparing Australian savings accounts, term deposits and cash ETFs, and projecting interest for a household with joint accounts.

Product and rate data comes from the **Consumer Data Right (Open Banking) product reference data** APIs that Australian banks must publish. A nightly GitHub Action crawls every bank, extracts bonus-rate conditions with Claude, checks data quality and publishes a snapshot to the `data` branch. The web app, which is still to come, will load that snapshot and do every calculation in the browser.

See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Status

**Phase 0: data trial run.** The crawler, condition extraction and data-quality report are in `packages/pipeline`.

## Layout

```
packages/pipeline/   CDR crawler, Claude condition extraction, quality report (TypeScript, Node 22)
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
```

## Secrets

The crawl workflow needs `ANTHROPIC_API_KEY` as a repository Actions secret. Without it, the crawl and report still run, and the extraction step is skipped with a warning.

## Data and disclaimer

CDR product data is published by data holders, and the CDR Rules (r 2.6) prohibit restrictions on its use. Rates can be wrong or stale, so always check with the bank. This is general information, not financial advice.
