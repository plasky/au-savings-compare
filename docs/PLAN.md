# Plan

Last updated 22 Nov 2026.

## Decisions

| Topic | Decision |
|---|---|
| Audience | Personal first. A "public mode" switch may come later, with neutral sorting, coverage statements and disclaimers. |
| Products | Savings and transaction accounts, term deposits, cash ETFs. **Out of scope for now:** super (you're happy with your fund) and mortgage offset (no mortgage). |
| Household | Two people, **joint accounts only**. Interest is split 50/50 and each half is taxed at that person's marginal rate. The Financial Claims Scheme limit is $250k per holder per ADI, so a two-holder joint balance is covered up to $500k per ADI. |
| Data | Automated from day one: CDR product reference data, crawled nightly by GitHub Actions and published to the `data` branch. |
| Bonus conditions | Banks' structured conditions plus **Claude extraction from day one** (`claude-haiku-5-5`, structured outputs), cached by text hash. A manual override file wins over both. |
| Tax | Toggle between pre- and after-tax. Rules live in per-financial-year files (2026–27 brackets including the 15% rate, Medicare levy, low-income tax offset). |
| Optimiser | Mode switch: **Manual / Optimised / Compare**. |
| Deposit cycling | Off by default, available as a toggle. |
| Cash ETFs | An indicative yield linked to the RBA cash rate, editable by you. No scraping of issuer or ASX sites, whose terms forbid it. |
| Monetisation | None. |
| Stack | TypeScript monorepo (pnpm). The engine is pure TS and runs in a Web Worker. Web app: React 19 + Vite, Tailwind + shadcn/ui, TanStack Table/Query, Zustand, ECharts. Optimiser: HiGHS (WASM). |
| Hosting | GitHub repo plus Actions; the web app goes on static hosting (Cloudflare Pages or GitHub Pages). |

## Data pipeline (`packages/pipeline`)

1. **Discover:** call the CDR register `GET https://api.cdr.gov.au/cdr-register/v1/all/data-holders/brands/summary` (`x-v: 2`, no auth). Keep brands in `banking` and `non-bank-lending`. Use `productBaseUri ?? publicBaseUri`, and crawl shared endpoints once.
2. **Crawl:** for each endpoint:
   - Get Products (`x-v: 5`), all pages, filtered client-side.
   - Product Detail (`x-v: 7`) for savings, transaction and term-deposit products.
   - Version negotiation falls back to exact versions for holders that reject `x-min-v`.
   - Retries, with Retry-After honoured.
   - A CORS preflight probe per holder, to see where a live in-browser refresh would work.
3. **Extract:** send bonus and intro rate rows that have free text to Claude, which returns structured conditions:
   - condition types: min deposit, purchases, balance growth, withdrawals, age, new customer, linked account, caps
   - whether the bonus is additive or a total rate
   - the intro period
4. **Report:** coverage, API versions, CORS, structured vs free-text conditions, quality flags (percent-formatted rates, duplicate rows, tier quirks, terms that can't be determined, implausible headlines), the top savings and 12-month TD rates for sanity checks, and agreement between Claude's output and the banks' structured conditions.
5. **Next (phase 2):**
   - a normaliser producing a compact `products.json`
   - grouping by ADI, via ABN reconciled with APRA's list
   - an overrides file
   - a data-health page
   - change detection and alerts

## Engine (phase 1)

- **Simulation:** month by month, with daily accrual inside each month. Bonus conditions are evaluated per calendar month against simulated behaviour (deposits, withdrawals, balance growth) and declared behaviour (card purchases).
- **Savings:** tiers (per-tier vs whole-balance), intro-rate expiry and an optional probability of meeting conditions.
- **Term deposits:** paid at maturity or periodically, rollover at the scenario rate, and break costs.
- **Household tax:** per-FY rules, the 50/50 split of joint-account interest, and both people's marginal rates.
- **Variable rates:** modelled as a margin over the RBA cash rate. Scenarios: flat, a user-drawn path, or Monte Carlo (later).
- **Real vs nominal:** using RBA/ABS CPI.
- **Tests:** Vitest with hand-calculated cases and property tests; cross-checks against bank and MoneySmart calculators.

## Optimiser (phase 5)

- **Goal:** maximise interest after tax (or before tax) minus a hassle cost per account.
- **Constraints:**
  - total amount, and a minimum instantly accessible
  - the FCS cap per ADI (joint: $500k)
  - maximum number of accounts or banks
  - product balance caps
  - feasibility of bonus conditions given monthly inflows (unless deposit cycling is on)
- **Output:** shadow prices, e.g. "lifting the FCS cap would earn $X/yr".
- **v2:** a time-based switching plan as intro rates expire and TDs mature.

## Web app (phases 3–4)

- **Setup questionnaire:** incomes, ages, access needs, appetite for conditions, horizon.
- **Dashboard:** total slider, headline after-tax interest, FCS warnings, this month's bonus checklist.
- **Explorer:** every product, sortable by *your* effective rate; rate history; link to the bank's page.
- **Allocation:** per-account sliders with locks; Manual / Optimised / Compare.
- **Projections:** pre/after tax, nominal/real, scenarios.
- **My accounts:** switching gain and alerts.
- **Data health page.**

## Phases

0. **Data trial run** (now): crawler, Claude extraction, quality report, nightly workflow.
1. Engine core: savings, TDs, household tax, tests.
2. Pipeline v1: normalised snapshot, overrides, ADI grouping, history.
3. Web v1: explorer, allocation sliders, projections, toggles.
4. Questionnaire, eligibility, bonus checklist, cash flows and goals, "My accounts".
5. Optimiser and the mode switch.
6. Cash ETFs.
7. Rate scenarios and Monte Carlo, rate history, alerts.
8. Public mode (only if ever needed).

## Phase 0 findings (first full crawls, 22 Nov 2026)

**Coverage**
- The register lists 390 brands. 306 are banking or non-bank lending, and **259 answer**.
- The 47 failures:
  - 42 mortgage-only non-bank lenders returning `400 Field/Invalid`, even without page-size. They're out of scope.
  - Thriday (DNS), DDH Graham (401), Aussie (404), Afterpay (406) and Mortgage Street (invalid JSON).
- **1,546 in-scope products:** 892 savings/transaction and 654 term deposits. 1,545 details fetched.
- Versions: Get Products v5 at 255/259 holders; Product Detail v7 for 1,477 of 1,544 products.
- **CORS:** 242 of 259 answering holders are callable from a browser with `x-v`, so a live single-bank refresh is viable.
- A crawl takes about 3 minutes on Actions. The raw snapshot is about 19 MB.

**Checks against published rates (all ✓):**

| Product | Our data | Published |
|---|---|---|
| Virgin Money Boost Saver | 6.30% | 6.30% |
| Westpac Life | 6.20% | 6.20% |
| ING Savings Booster | 6.50% intro / 5.90% ongoing | 6.50% intro / 5.90% |
| AMP GO Save (no conditions) | 5.75% | 5.75% |
| AMP GO 12-month TD | 5.70% | 5.70% |

**Bonus conditions:** 264 bonus rows. 63% have structured conditions plus text, 20% are free text only, and 17% have neither.

**How rate rows combine** (the main modelling lesson):
- Rows apply by **DOLLAR tier**.
- Distinct bonus rows at the same balance usually **stack**, e.g. Virgin Money 0.05% + 0.50% + 5.75%. Some are **alternatives** instead (My State, Bendigo: summing them gives ~10–11%).
- Several base rows at the same balance are **plans or special eligibility**, e.g. Revolut's paid plans and Bankwest's 11.5% rate for competition winners only.
- Banks often publish intro and bonus rates as the **total rate**, against the standard (Defence Bank says so explicitly; Rabobank, Revolut, BNK and bcu look the same). 19 intros are flagged.

**Other quality issues:**
- 15 rates published as percentages (Traditional CU: `"2.00"`).
- 126 TD rows with the term only in the product name (Bank of China "Term Deposit CNY 12M").
- 140 tier bounds sent as numbers; 58 `maximumValue: 0` meaning "no cap".
- 41 foreign-currency products and 362 business/SMSF/trust/organisation products, which need excluding for a household.

**Decisions from phase 0:**
1. Move Claude extraction from per-row to **per-product "rate composition"**: send the whole `depositRates` array and ask for each row's role (base, plan alternative, stacking bonus, alternative bonus, intro), additive vs total, eligibility (age, new customer, plan fee, business), term (from name if needed) and conditions. Then check the result with deterministic rules, e.g. that the composed headline matches any total the text states. A manual overrides file covers what's left.
2. The normaliser auto-corrects percent-formatted rates (and flags them), treats `max 0` as unbounded, and excludes non-AUD and non-personal products.
3. Phase 2: keep raw responses as Actions artifacts, and commit only the compact normalised `products.json` (plus the extraction cache) to the `data` branch.
4. **Blocker:** the Anthropic account behind `ANTHROPIC_API_KEY` needs credit. The key itself is valid and correctly placed.

## Known constraints

- The CDR standards require CORS on these endpoints, but not every holder complies, and a full crawl is thousands of requests. So the app uses a nightly snapshot, with an optional live refresh for a single bank.
- About 38% of bonus rows have free-text conditions only, hence Claude extraction plus overrides.
- Offset linkage and TD maturity instructions are not in product reference data. Neither matters for current scope.
- ASIC's generic-calculator relief (Instrument 2026/41) excludes tools that promote specific products. That is irrelevant for personal use, but matters for any public mode.
