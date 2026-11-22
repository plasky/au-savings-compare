# Plan

Last updated 22 Nov 2026.

## Decisions

| Topic | Decision |
|---|---|
| Audience | Personal first. A "public mode" switch may come later, with neutral sorting, coverage statements and disclaimers. |
| Products | Savings and transaction accounts, term deposits, cash ETFs. **Out of scope for now:** super (you're happy with your fund) and mortgage offset (no mortgage). |
| Household | Two people, **joint accounts only**. Interest is split 50/50 and each half is taxed at that person's marginal rate. The Financial Claims Scheme limit is $250k per holder per ADI, so a two-holder joint balance is covered up to $500k per ADI. |
| Data | Automated from day one: CDR product reference data, crawled nightly by GitHub Actions and published to the `data` branch. |
| Bonus conditions | **Weekly Claude review in Paul's chat**, using his Claude plan rather than paid API credit. The nightly crawl queues products whose rate structure needs judgement. Claude records how each product's rows combine, plus conditions and eligibility, in `curation/reviews.json`, validated by `review-apply` (see [WEEKLY_REVIEW.md](WEEKLY_REVIEW.md)). The paid-API extraction path stays available behind the `USE_ANTHROPIC_API` repo variable. |
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

0. ✅ **Data trial run**: crawler, Claude review, quality report, nightly workflow.
1. ✅ Engine core: savings, TDs, household tax, tests.
2. ✅ Pipeline v1: normalised snapshot, overrides, ADI grouping, history.
3. ✅ Web v1: explorer, allocation sliders, projections, toggles (plus an early optimiser and indicative cash ETF, pulled forward from phases 5 and 6).
4. ✅ Questionnaire, bonus checklist, cash flows and goals, "My accounts".
5. ✅ Optimiser v2: what each limit costs, hassle cost, switching timeline.
6. Cash ETFs from live yields.
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
4. ~~Blocker: API credit~~ Replaced by the weekly in-chat review (22 Nov 2026).

**First full review (22 Nov 2026):**
- All **167** products needing judgement were reviewed: 110 high, 50 medium and 7 low confidence.
- 17 rows turned out to be total rates, not add-ons, and 46 rows were excluded (competition prizes, staff-only, SMSF-only, overseas students and the like).
- 16 products have plan, age or balance-band alternatives.
- 48 products are restricted to niche audiences (children, ADF, police, teachers, retirees 55+, first home buyers and so on).
- Joint accounts: at least Bankwest Easy Saver is sole-holder only, and Westpac Life's 0.70% Spend&Save bonus excludes joint accounts.

## Phase 1 status (22 Nov 2026): engine done

**`packages/engine`** is pure TypeScript with no runtime dependencies:
- **Accrual:** daily, on a 365-day year, credited monthly.
- **Tiers:** banded (`PER_TIER`) or applied to the whole balance (`WHOLE_BALANCE`).
- **Monthly conditions:** deposits (including external-only), purchases, balance growth, withdrawals, age, new/existing customer, sole-holder-only.
- **Rate composition:** base + stacked bonuses + intro, with total-rate rows replacing the base, and alternative sets (best option, or the user's choice).
- **Intro expiry**, and **rate shifts** that move variable base and total-rate rows.
- **Term deposits:** at maturity or periodic, rollover or payout.
- **Household tax:** per financial year (2026–27 at 15%, 2027–28 at 14%), including the low-income tax offset and the Medicare levy phase-in. Joint interest is split by ownership and taxed incrementally at each holder's own rate.
- **Outputs:** real values via CPI, effective rates on the average daily balance, and warnings for joint-ineligible or restricted products.
- **Tests:** 35, hand-calculated.

**`pipeline/src/normalise.ts`** turns CDR product data plus aligned reviews into engine products:
- Unreviewed products fall back to the CDR labels and structured conditions; free-text bonuses become an `OTHER` condition.
- Overlapping base rows become alternatives (the Macquarie and CommBank duplicate-band patterns).
- Fixed-term sub-options are dropped from at-call products, and super and pension products are excluded.
- Restricted audiences come from the review, `curation/brands.json` (membership-restricted banks) or the product name.

**`rank`** command example:
`pnpm --filter @asc/pipeline exec tsx src/cli.ts rank --out <crawl>/latest --balance 50000 --deposit 1000 --purchases 5 --ages 45,43 --incomes 120000,80000 [--td 12] [--solo] [--all]`

Results match published rates, e.g. Virgin Boost 6.30%, ING Maximiser 6.00%, RACQ 6.00%, BOQ Smart Saver 5.85%, and 12-month TDs from Unity 5.80%, Suncorp 5.75% and AMP GO 5.70%.

## Phases 2 and 3 status (22 Nov 2026): catalogue and web app

**`products.json`** (the `catalogue` command, run nightly after the crawl and published to the data branch):
- Normalised engine products plus the bank's page link, last-updated date and a short description.
- Brands grouped by ABN for the Financial Claims Scheme (e.g. CommBank + Bankwest; Westpac + St.George + BankSA + Bank of Melbourne; BOQ + ME + Virgin Money; NAB + UBank; ANZ + ANZ Plus).
- Brand names tidied (`curation/brands.json` `displayNames`), products with only 0% rates dropped, and any product with a rate above 15% left out as a data error.
- Rates are read per product: if any value is published as a percentage, the whole product is (fixes Traditional CU's ".25" meaning 0.25%). Accounts for charities, not-for-profits and SMSFs are excluded by description.

**Engine additions:** eligibility with reasons, `rankSavings`/`rankTermDeposits`, plain-English condition text, the FCS exposure check (per holder per ABN, joint split equally), and an optimiser (greedy allocation in steps with jumps to tier edges, then swap and move passes; respects account count, the lock-away amount and term, and the FCS cap; splits the monthly deposit so each bonus gets what it needs). The top band of a bonus ladder is capped rather than cut off ("bonus on balances up to $250k" pays on the first $250k of a larger balance).

**`apps/web`** (React 19 + Vite 8, zustand persisted to localStorage, hand-drawn SVG charts; no other runtime dependencies):
- The household written as a sentence with editable fields (balance, monthly deposit, card purchases, withdrawals, amount and term that can be locked away), a log-scale balance slider, and a one-line verdict.
- **Compare:** savings ranked by simulated first-year interest; term deposits by rate for a chosen term; search, hand-checked filter, ineligible accounts with reasons; each row expands to its rate table in plain English, notes, and a link to the bank.
- **Your plan:** manual (amount sliders, per-account deposits, locks, withdrawal account) or automatic (optimiser in a web worker, "Keep this plan"); allocation bar; FCS check per institution.
- **Projection:** 1–10 years, stacked balances by account, interest and tax by financial year, future vs today's dollars, a variable-rate shift from a chosen month, tables view.
- Household dialog: joint or single, ages and taxable incomes (with the marginal rate shown), new-customer and condition assumptions, restricted products, cash ETF yield (default 4.65% = RBA cash rate 4.85% less ~0.20% fees), inflation (default 3%).
- Deployed to GitHub Pages by `deploy.yml` after each successful crawl and on app changes.

## Phases 4 and 5 status (22 Nov 2026)

**Engine:**
- Held accounts: savings carry months since opening (an intro rate ends on time); term deposits carry their locked-in rate and months into the term, including interest built up before today.
- One-off deposits and withdrawals by month (a withdrawal breaks a no-withdrawal bonus that month).
- `monthlyTasks`: each bonus's recurring conditions merged into a short to-do list; `introLength`.
- Optimiser: accounts already held are always candidates, keep what's left of their intro, and cost nothing to keep; `optimiseWithCost` makes each extra account earn its keep (default $250 a year) and tries 1..N accounts, which also beats the single greedy pass.
- `constraintValues`: re-runs the plan with one limit relaxed at a time (one more account, any gain, the guarantee, locking more away or for longer, 5 card purchases, linked accounts).
- `switchingPlan`: steps through intro-rate ends and term-deposit maturities over two years, re-optimises the money free to move, and keeps a move only if it beats staying put by the hassle threshold. `describeMoves` turns two sets of balances into transfers.

**Web app:**
- First-visit setup questions (who, money, locking away, effort), rerunnable from Household and tax.
- **My accounts** tab: add accounts you hold from the bank data (word-start search) or by hand with a rate; balance, deposit, opened month; term deposits with term, locked rate and maturity. Shows first-year earnings, whether switching now is worth it (with the moves), the timeline of later moves, and this month's checklist with ticks and an `.ics` export (a monthly reminder plus intro-end and maturity dates). "I've opened my plan's accounts" copies the plan across.
- **Plan:** "What's holding the plan back" (after-tax value of each relaxed limit), a threshold for opening another account.
- **Projection:** project the plan or the accounts you hold; a savings goal with on-track status or the extra monthly deposit needed; one-off money in or out.
- All of it runs in the browser; held accounts, goals and ticks stay in localStorage.

## Known constraints

- The CDR standards require CORS on these endpoints, but not every holder complies, and a full crawl is thousands of requests. So the app uses a nightly snapshot, with an optional live refresh for a single bank.
- About 38% of bonus rows have free-text conditions only, hence Claude extraction plus overrides.
- Offset linkage and TD maturity instructions are not in product reference data. Neither matters for current scope.
- ASIC's generic-calculator relief (Instrument 2026/41) excludes tools that promote specific products. That is irrelevant for personal use, but matters for any public mode.
