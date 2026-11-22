import {
  depositNeed,
  explainCondition,
  explainRole,
  explainTerm,
  explainTiers,
  rankTermDeposits,
  type CatalogueProduct,
  type Ranked,
  type RateRow,
  type Scenario,
} from '@asc/engine';
import { useDeferredValue, useMemo, useState } from 'react';
import { CASH_ETF_KEY } from '../data';
import { dateLabel, money, pct, termLabel } from '../format';
import { useApp } from '../store';
import { Check, Segmented } from './fields';

const TERMS = [1, 3, 4, 6, 9, 12, 18, 24, 36, 48, 60];
const PAGE = 40;

function rowsToShow(p: CatalogueProduct, term: number | null, all: boolean): RateRow[] {
  if (p.kind !== 'term_deposit' || all || term === null) return p.rows;
  return p.rows.filter((r) => !r.term || (r.term.min <= term + 0.5 && (r.term.max ?? r.term.min) >= term - 0.5));
}

function Detail({ r }: { r: Ranked }) {
  const p = r.product as CatalogueProduct;
  const [all, setAll] = useState(false);
  const rows = rowsToShow(p, r.termMonths, all);
  const isTd = p.kind === 'term_deposit';
  const sorted = [...rows].sort((a, b) => (a.term?.min ?? 0) - (b.term?.min ?? 0) || order(a) - order(b) || (a.tiers[0]?.min ?? 0) - (b.tiers[0]?.min ?? 0));
  return (
    <div className="detail">
      {p.description && <p>{p.description}</p>}
      {!r.eligibility.ok && (
        <p className="flag-off">
          You can&rsquo;t open this as set up: {r.eligibility.reasons.join('; ')}.
        </p>
      )}
      {r.unmet.length > 0 && (
        <p className="flag-warn">
          Bonus missed in some months with your settings: {r.unmet.join('; ')}.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th scope="col">Rate</th>
            <th scope="col">Type</th>
            {isTd && <th scope="col">Term</th>}
            <th scope="col">Balance</th>
            <th scope="col">Conditions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.id} className={row.rate === 0 ? 'muted-row' : undefined}>
              <td className="rate">{pct(row.rate)}</td>
              <td className="nowrap">
                {explainRole(row)}
                {row.alternativeSet && row.option ? <div className="hint">Option: {row.option}</div> : null}
              </td>
              {isTd && (
                <td>
                  {explainTerm(row) ?? 'Any'}
                  {row.payment?.type === 'PERIODIC' && row.payment.everyMonths ? <div className="hint">Interest every {termLabel(row.payment.everyMonths)}</div> : null}
                </td>
              )}
              <td className="nowrap">{explainTiers(row)}</td>
              <td>{row.conditions.length ? row.conditions.map(explainCondition).join('; ') : 'None'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isTd && rows.length < p.rows.length && (
        <button type="button" className="button quiet" onClick={() => setAll(true)}>
          Show all {p.rows.length} rates
        </button>
      )}
      {p.notes.length > 0 && (
        <>
          <p style={{ marginBottom: 4 }}>{p.key === CASH_ETF_KEY ? 'About this estimate' : p.reviewed ? 'Reviewer’s notes' : 'Notes'}</p>
          <ul>
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
      <p className="hint">
        {p.key === CASH_ETF_KEY
          ? 'An estimate, not a bank product.'
          : p.reviewed
            ? `How the rates combine was checked by hand (${p.confidence ?? 'unrated'} confidence).`
            : 'Read automatically from the bank’s published data; bonus conditions written only in words may be incomplete.'}{' '}
        {p.lastUpdated ? `The bank last updated this on ${dateLabel(p.lastUpdated)}.` : ''}
      </p>
      {p.url && (
        <a href={p.url} target="_blank" rel="noopener noreferrer">
          Open {p.brand}&rsquo;s page for this account
        </a>
      )}
    </div>
  );
}

const order = (r: RateRow) => (r.role === 'BASE' ? 0 : r.role === 'BONUS' ? 1 : 2);

function bonusSummary(r: Ranked): string | null {
  if (r.termMonths !== null) return null;
  const hasBonus = r.product.rows.some((x) => x.role === 'BONUS');
  if (!hasBonus) return 'No conditions';
  if (r.bonusMonths === r.months) return 'Bonus every month';
  if (r.bonusMonths === 0) return 'Bonus missed';
  return `Bonus in ${r.bonusMonths} of ${r.months} months`;
}

export function Compare({ savings, products, scenario, balance }: { savings: Ranked[]; products: CatalogueProduct[]; scenario: Scenario; balance: number }) {
  const s = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const deferredBalance = useDeferredValue(balance);
  const isTd = s.compareKind === 'term_deposit';

  const tds = useMemo(
    () => (isTd ? rankTermDeposits(products, Math.max(deferredBalance, 1), s.tdTerm, scenario, { includeIneligible: true }) : []),
    [isTd, products, deferredBalance, s.tdTerm, scenario],
  );

  const list = (isTd ? tds : savings).filter((r) => {
    if (!s.showIneligible && !r.eligibility.ok) return false;
    if (s.reviewedOnly && !r.product.reviewed) return false;
    if (s.search) {
      const q = s.search.toLowerCase();
      if (!`${r.product.brand} ${r.product.name}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const inPlan = new Set(s.accounts.map((a) => `${a.key}@${a.termMonths ?? ''}`));
  const allocated = s.accounts.reduce((sum, a) => sum + a.amount, 0);
  const depositsUsed = s.accounts.reduce((sum, a) => sum + a.deposit, 0);

  const add = (r: Ranked) => {
    const p = r.product;
    const unallocated = Math.max(0, s.accounts.length ? s.balance - allocated : s.balance);
    // Nothing left to place: a term deposit starts with what can be locked away, so the plan shows what to move.
    const amount = unallocated > 0 ? unallocated : r.termMonths !== null ? Math.min(s.lockable, s.balance) : 0;
    const savingsCount = s.accounts.filter((a) => a.termMonths === null).length;
    const left = Math.max(0, s.monthlyDeposit - depositsUsed);
    const need = depositNeed(p);
    const deposit = r.termMonths !== null ? 0 : savingsCount === 0 ? left : need > 0 && need <= left ? need : 0;
    s.addAccount({ key: p.key, amount: amount > 0 ? amount : 0, deposit, termMonths: r.termMonths });
  };

  return (
    <section aria-label="Compare accounts">
      <div className="controls">
        <Segmented
          label="Account type"
          value={s.compareKind}
          options={[
            { value: 'savings', label: 'Savings accounts' },
            { value: 'term_deposit', label: 'Term deposits' },
          ]}
          onChange={(v) => {
            s.set({ compareKind: v });
            setLimit(PAGE);
          }}
        />
        {isTd && (
          <label className="check">
            Term
            <select className="select" value={s.tdTerm} onChange={(e) => s.set({ tdTerm: Number(e.target.value) })}>
              {TERMS.map((t) => (
                <option key={t} value={t}>
                  {termLabel(t)}
                </option>
              ))}
            </select>
          </label>
        )}
        <input
          className="text-input"
          type="search"
          placeholder="Find a bank or account"
          aria-label="Find a bank or account"
          value={s.search}
          onChange={(e) => s.set({ search: e.target.value })}
        />
        <Check checked={s.reviewedOnly} onChange={(v) => s.set({ reviewedOnly: v })}>
          Hand-checked only
        </Check>
        <Check checked={s.showIneligible} onChange={(v) => s.set({ showIneligible: v })}>
          Include accounts we can&rsquo;t open
        </Check>
      </div>

      <p className="hint" style={{ margin: '0 0 12px' }}>
        {isTd
          ? `${list.length} term deposits for ${money(deferredBalance)} over ${termLabel(s.tdTerm)}, interest paid at maturity, ranked by rate.`
          : `${list.length} savings accounts for ${money(deferredBalance)}, ranked by interest over the first year with your deposits, purchases and withdrawals.`}
      </p>

      {list.length === 0 ? (
        <p className="empty">Nothing matches. Clear the search, or include accounts you can&rsquo;t open to see why they&rsquo;re left out.</p>
      ) : (
        <ol className="ranked">
          {list.slice(0, limit).map((r, i) => {
            const p = r.product;
            const id = `${p.key}@${r.termMonths ?? ''}`;
            const expanded = open === id;
            const bonus = bonusSummary(r);
            const added = inPlan.has(id);
            return (
              <li key={id} className="rank-row">
                <div className="rank-main">
                  <span className="rank-pos">{i + 1}</span>
                  <div className="rank-name">
                    <button type="button" className="disclose" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : id)}>
                      <span className="brand">{p.brand}</span> <span className="product">{p.name}</span>
                    </button>
                    <div className="rank-meta">
                      {bonus && <span className={r.bonusMonths < r.months ? 'flag-warn' : undefined}>{bonus}</span>}
                      {!r.eligibility.ok && <span className="flag-off">{r.eligibility.reasons[0]}</span>}
                      {p.eligibility.restrictedTo && r.eligibility.ok && <span>For {p.eligibility.restrictedTo}</span>}
                      {p.key === CASH_ETF_KEY ? <span>Estimate, not covered by the guarantee</span> : p.reviewed ? <span>Hand-checked</span> : null}
                    </div>
                  </div>
                  <span className="rank-rate">{pct(r.rate)}</span>
                  <span className="rank-money">
                    {money(s.taxView === 'after' ? r.afterTax : r.interest)}
                    <span className="sub">
                      {isTd ? `over ${termLabel(r.months)}` : 'first year'} {s.taxView === 'after' ? 'after tax' : 'before tax'}
                    </span>
                  </span>
                  <span className="rank-add">
                    <button type="button" className="button" disabled={added} onClick={() => add(r)} aria-label={added ? `${p.brand} ${p.name} is in your plan` : `Add ${p.brand} ${p.name} to your plan`}>
                      {added ? 'In plan' : 'Add to plan'}
                    </button>
                  </span>
                </div>
                {expanded && <Detail r={r} />}
              </li>
            );
          })}
        </ol>
      )}
      {list.length > limit && (
        <button type="button" className="button more" onClick={() => setLimit(limit + PAGE)}>
          Show {Math.min(PAGE, list.length - limit)} more
        </button>
      )}
    </section>
  );
}
