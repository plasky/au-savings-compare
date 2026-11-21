# Weekly Claude review (no API key)

The nightly crawl lists every product whose rate structure needs judgement in `latest/review-queue.json` on the `data` branch. These are products with bonus or intro rows, overlapping base rows, or TD terms that can't be parsed. Once a week, Claude reviews the queue in Paul's chat, using his Claude plan rather than paid API credit, and commits the results to `curation/reviews.json` on `main`.

Reviews are keyed by a hash of each product's rates, name and eligibility. A product only comes back into the queue when the bank changes it. The weekly queue includes products with a headline rate of at least **3%**.

## Procedure

1. **Repo.** Use `/home/claude/au-savings-compare`, or re-attach `plasky/au-savings-compare` with push access and clone it there. Then run `git pull` and `pnpm install`.
2. **Latest crawl.** Make a fresh shallow clone of the data branch:
   `rm -rf /home/claude/asc-data && git clone -q --depth 1 --branch data https://github.com/plasky/au-savings-compare /home/claude/asc-data`
3. **Batch.** From the repo root:
   ```bash
   R=$PWD/curation/reviews.json; D=/home/claude/asc-data/latest
   pnpm --filter @asc/pipeline exec tsx src/cli.ts review-batch --out $D --reviews $R --limit 40 --file /tmp/review-batch.md
   ```
   Add `--threshold 0` to include products below 3%.
4. **Review.** Read `/tmp/review-batch.md` and write `/tmp/answers.json` following the guidelines below.
5. **Apply.**
   `pnpm --filter @asc/pipeline exec tsx src/cli.ts review-apply --out $D --reviews $R --answers /tmp/answers.json`
   Fix every `ERROR`, and check each `warning`. A warning is fine if the bank's text is wrong, but say so in `notes`. Repeat steps 3–5 until the queue is empty.
6. **Commit** `curation/reviews.json` to `main` and push. The push triggers a crawl, which refreshes the queue and the report.
7. **Report to Paul** in a few lines:
   - how many products were reviewed and how many remain
   - new or changed products worth knowing about
   - any rates that moved notably
   - anything with low confidence
8. **Schedule the next reminder** for 7 days later in the same chat, unless Paul has asked to stop.

## Review guidelines

Each review covers **every** `depositRates` row, by its index, exactly once. Omit any field that is at its default. For products with many plain rows (typically TDs), set `"defaultRole": "BASE"` and list only the rows that need more than that.

| Field | Meaning | Default |
|---|---|---|
| `role` | `BASE`, `BONUS`, `INTRO` or `EXCLUDE`. Correct the bank's labels where they're wrong. | (required) |
| `combine` | `ADD_TO_BASE` (as the CDR standard says) or `TOTAL_RATE` (see below). | `ADD_TO_BASE` |
| `alternativeSet` / `option` | Rows sharing a set name are mutually exclusive choices (see below). | null |
| `conditions` | The types from the extraction schema (see below). | [] |
| `introMonths` | Length of an intro period. | null |
| `termMonths` | Term of a TD row, only where it can't be parsed from the duration, tiers or name. | null |
| `excludeReason` | Required when `role` is `EXCLUDE`. | null |

**`TOTAL_RATE`:** use this when the row's rate already includes the base. Signs: the text calls it the "total" or "introductory variable rate", or the rate equals an advertised headline (e.g. base 3.70% plus intro 5.80%, where the bank advertises 5.80%).

**Overlapping base rows:** if two base rows cover the same balances (e.g. a rate published once untiered and again as bands, or advised and non-advised versions), put them in an `alternativeSet`. The validator warns when they overlap without one, and the engine would treat them as alternatives anyway.

**`alternativeSet` and `option`:** examples are plan tiers (Revolut Standard/Ultra), age bands, customer types, and alternative bonus levels (e.g. bonus A *or* bonus B). Give each row a readable `option`, including any fee: `"Ultra plan (fee applies)"`. Rows that differ only by **DOLLAR tier** don't need a set, because tiers are evaluated by balance.

**`conditions` types:**
- `MIN_DEPOSIT_AMOUNT` (`amount`; set `externalOnly` if deposits must come from outside), `MIN_DEPOSITS` (`count`)
- `MIN_PURCHASES` (`count`), `DEPOSIT_BALANCE_INCREASED`
- `MAX_WITHDRAWALS` (`count`, 0 = none allowed), `MAX_WITHDRAWAL_AMOUNT`
- `MIN_BALANCE` (also used for a TD's minimum investment), `BALANCE_CAP` (only if not already expressed by tiers)
- `NEW_CUSTOMER`, `EXISTING_CUSTOMER`, `AGE_RANGE` (`minAge` / `maxAge`), `LINKED_ACCOUNT`, `ONLINE_ONLY`, `SOLE_HOLDER_ONLY` (row not available on joint accounts), `OTHER` (with a `description`)

`period` defaults to `MONTH`. Use `NONE` for standing requirements and `ONCE` for one-offs.

**`EXCLUDE`** rows that an ordinary two-person household can't get: competition winners, staff only, business or SMSF only, foreign currency, closed or legacy versions, rates only for balances above the FCS-relevant range where the text says "not available".

**Product-level fields:**

| Field | Meaning |
|---|---|
| `eligibility` | `minAge`, `maxAge` and `newCustomersOnly`, where the *product itself* is restricted (not just one row). Also `jointAllowed` (`false` if sole holder only; Paul's household uses joint accounts only, so always set this when the text says) and `restrictedTo` for niche audiences (ADF members, students, staff, seniors), plus short `notes`. |
| `statedHeadline` | The maximum or total rate the bank's text states, e.g. "earn up to 6.30% p.a." → `0.063`. The validator cross-checks it against the composed rows. |
| `confidence` | `high`, `medium` or `low`. Use `low` when the text is ambiguous or contradicts the structured data. |
| `notes` | One short sentence, e.g. on anything surprising or anything the validator warned about. |

Example:

```json
{ "reviews": [
  { "key": "virgin-money-7bedfe:XYZ", "reviewKey": "…", "statedHeadline": 0.063, "confidence": "high",
    "eligibility": { "minAge": 18 },
    "rows": [
      { "index": 0, "role": "BASE" },
      { "index": 1, "role": "BONUS", "conditions": [{ "type": "MIN_PURCHASES", "count": 5 }] },
      { "index": 2, "role": "BONUS", "conditions": [{ "type": "MIN_DEPOSIT_AMOUNT", "amount": 1000, "externalOnly": true }, { "type": "MIN_PURCHASES", "count": 5 }] }
    ] }
] }
```
