import { depositNeed, fcsExposure, FCS_LIMIT, type Catalogue, type CatalogueProduct, type SimulationResult } from '@asc/engine';
import { CASH_ETF_GROUP } from '../data';
import { money, pct, termLabel } from '../format';
import { displayName, hasNoWithdrawalRule, suggestDeposits, withdrawalAccount } from '../model';
import { useApp, type PlanAccount } from '../store';
import type { AutoPlanState } from '../useAutoPlan';
import { Check, MoneyInput, Segmented } from './fields';

const color = (slot: number) => `var(--s${(slot % 8) + 1})`;
const darkText = (slot: number) => slot % 8 === 3;

function stepFor(max: number) {
  return max <= 20_000 ? 100 : max <= 200_000 ? 500 : 1000;
}

export function Plan({
  accounts,
  byKey,
  result,
  auto,
  catalogue,
}: {
  accounts: PlanAccount[];
  byKey: Map<string, CatalogueProduct>;
  result: SimulationResult | null;
  auto: AutoPlanState;
  catalogue: Catalogue;
}) {
  const s = useApp();
  const manual = s.planMode === 'manual';
  const allocated = accounts.reduce((sum, a) => sum + a.amount, 0);
  const unallocated = s.balance - allocated;
  const depositTotal = accounts.reduce((sum, a) => sum + (a.termMonths === null ? a.deposit : 0), 0);
  const savingsAccounts = accounts.filter((a) => a.termMonths === null);
  const lockedAway = accounts.filter((a) => a.termMonths !== null).reduce((sum, a) => sum + a.amount, 0);
  const from = withdrawalAccount(accounts, byKey, s.withdrawFrom);
  const people = s.partner ? s.people : [s.people[0]];
  const owners = Object.fromEntries(people.map((p) => [p.id, 1 / people.length]));
  const groupName = (g: string) => catalogue.groups.find((x) => x.id === g)?.brands.join(', ') ?? g;
  const first = result?.summary.perAccountFirstYear ?? {};
  const totalInterest = result?.summary.firstYearInterest ?? 0;
  const totalAfter = result?.summary.firstYearAfterTax ?? 0;

  const holdings = accounts
    .map((a) => ({ a, p: byKey.get(a.key) }))
    .filter((x): x is { a: PlanAccount; p: CatalogueProduct } => !!x.p);
  const exposures = fcsExposure(holdings.filter((h) => h.p.group !== CASH_ETF_GROUP).map((h) => ({ group: h.p.group, balance: h.a.amount, owners })));
  const groups = [...new Set(exposures.map((e) => e.group))];
  const etf = holdings.filter((h) => h.p.group === CASH_ETF_GROUP);

  const splitDeposits = () => {
    const d = suggestDeposits(accounts, byKey, s.monthlyDeposit, depositNeed);
    accounts.forEach((a, i) => s.updateAccount(a.id, { deposit: d[i] ?? 0 }));
  };

  const keepAuto = () => {
    s.replaceAccounts(accounts.map((a) => ({ key: a.key, amount: a.amount, deposit: a.deposit, termMonths: a.termMonths })));
    s.set({ planMode: 'manual' });
  };

  return (
    <section aria-label="Your plan">
      <div className="plan-head">
        <Segmented
          label="How the plan is made"
          value={s.planMode}
          options={[
            { value: 'manual', label: 'I’ll choose accounts' },
            { value: 'auto', label: 'Choose for me' },
          ]}
          onChange={(v) => s.set({ planMode: v })}
        />
        {!manual && (
          <>
            <label className="check">
              Up to
              <select className="select" value={s.maxAccounts} onChange={(e) => s.set({ maxAccounts: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} account{n === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <Check checked={s.fcsCap} onChange={(v) => s.set({ fcsCap: v })}>
              Stay within the {money(FCS_LIMIT)} guarantee at each bank
            </Check>
            <button type="button" className="button primary" disabled={!accounts.length || auto.status === 'working'} onClick={keepAuto}>
              Keep this plan
            </button>
          </>
        )}
      </div>

      {!manual && (
        <p className="note" style={{ marginTop: -8 }}>
          {auto.status === 'working'
            ? 'Working out the best split…'
            : `Tries the best ${s.lockable > 0 ? 'savings accounts and term deposits' : 'savings accounts'} for your settings and splits your money and monthly deposit to earn the most in the first year. Keep the plan to fine-tune it by hand.`}
          {s.lockable > 0 ? ` Term deposits are limited to the ${money(s.lockable)} you can lock away, for up to ${termLabel(s.lockMonths)}.` : ''}
        </p>
      )}

      {accounts.length === 0 ? (
        <div className="empty">
          {manual ? (
            <>
              <p>Your plan is empty. Add accounts from the Compare tab and set how much goes in each, or let the app choose for you.</p>
              <button type="button" className="button primary" onClick={() => s.set({ planMode: 'auto' })}>
                Choose for me
              </button>
            </>
          ) : (
            <p>{auto.status === 'working' ? 'Working out the best split…' : 'No account fits these settings.'}</p>
          )}
        </div>
      ) : (
        <>
          <div className="allocation-bar" role="img" aria-label={`Allocation of ${money(s.balance)}: ${accounts.map((a) => `${byKey.get(a.key)?.brand ?? a.key} ${money(a.amount)}`).join(', ')}${unallocated > 0.5 ? `, not allocated ${money(unallocated)}` : ''}`}>
            {accounts.filter((a) => a.amount > 0).map((a) => {
              const share = a.amount / Math.max(s.balance, allocated, 1);
              return (
                <div key={a.id} className={`part ${darkText(a.slot) ? 'light-text-dark' : ''}`} style={{ flexGrow: share, flexBasis: 0, background: color(a.slot) }}>
                  {share > 0.09 ? `${Math.round(share * 100)}%` : ''}
                </div>
              );
            })}
            {unallocated > 0.5 && (
              <div className="part unallocated" style={{ flexGrow: unallocated / s.balance, flexBasis: 0 }}>
                {unallocated / s.balance > 0.12 ? 'Not allocated' : ''}
              </div>
            )}
          </div>
          <div className="allocation-legend">
            {accounts.map((a) => {
              const p = byKey.get(a.key);
              return (
                <span key={a.id}>
                  <span className="key" style={{ background: color(a.slot) }} />
                  {p ? `${p.brand} ${p.name}` : a.key}
                  {a.termMonths !== null ? `, ${termLabel(a.termMonths)}` : ''}
                </span>
              );
            })}
          </div>

          <table className="plan-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Amount</th>
                <th scope="col" className="right">
                  Deposit a month
                </th>
                <th scope="col" className="right">
                  First-year interest
                </th>
                <th scope="col" className="right">
                  Rate
                </th>
                {manual && <th scope="col"><span className="visually-hidden">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const p = byKey.get(a.key);
                const fy = first[a.id];
                const max = Math.max(s.balance, a.amount);
                return (
                  <tr key={a.id}>
                    <td>
                      <span className="key" style={{ background: color(a.slot) }} />
                      <strong>{p?.brand ?? 'Unavailable'}</strong> {p?.name ?? a.key}
                      {a.termMonths !== null && <div className="hint">Term deposit, {termLabel(a.termMonths)}, rolled over at maturity</div>}
                      {!p && <div className="flag-off">This account is no longer in the bank data.</div>}
                    </td>
                    <td className="amount-cell">
                      {manual ? (
                        <>
                          <MoneyInput value={a.amount} onChange={(v) => s.updateAccount(a.id, { amount: v })} label={`Amount in ${p?.name ?? a.key}`} max={50_000_000} />
                          <input
                            type="range"
                            min={0}
                            max={max}
                            step={stepFor(max)}
                            value={a.amount}
                            onChange={(e) => s.updateAccount(a.id, { amount: Number(e.target.value) })}
                            aria-label={`Amount in ${p?.name ?? a.key}`}
                            aria-valuetext={money(a.amount)}
                          />
                        </>
                      ) : (
                        <span className="num">{money(a.amount)}</span>
                      )}
                    </td>
                    <td className="right" data-label="Deposit a month">
                      {a.termMonths !== null ? (
                        <span className="hint">None</span>
                      ) : manual ? (
                        <MoneyInput value={a.deposit} onChange={(v) => s.updateAccount(a.id, { deposit: v })} label={`Monthly deposit into ${p?.name ?? a.key}`} max={1_000_000} />
                      ) : (
                        <span className="num">{money(a.deposit)}</span>
                      )}
                    </td>
                    <td className="right num" data-label="First-year interest">
                      {fy ? money(fy.interest) : '–'}
                    </td>
                    <td className="right num" data-label="Rate">
                      {fy ? pct(fy.rate) : '–'}
                    </td>
                    {manual && (
                      <td className="right actions" style={{ whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          className="icon-button"
                          aria-pressed={a.locked}
                          onClick={() => s.updateAccount(a.id, { locked: !a.locked })}
                          title="A locked amount stays put when you change your total savings"
                        >
                          {a.locked ? 'Locked' : 'Lock'}
                        </button>
                        <button type="button" className="icon-button" onClick={() => s.removeAccount(a.id)} aria-label={`Remove ${p?.name ?? a.key} from the plan`}>
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num amount-cell">
                  {money(allocated)} <span className="hint">of {money(s.balance)}</span>
                </td>
                <td className="right num" data-label="Deposit a month">
                  {money(depositTotal)}
                </td>
                <td className="right num" data-label="First-year interest">
                  {money(totalInterest)}
                </td>
                <td className="right num" data-label="Rate">
                  {result ? pct(result.summary.firstYearRate) : '–'}
                </td>
                {manual && <td />}
              </tr>
            </tfoot>
          </table>
          <p className="hint">
            First-year interest after tax: <strong className="num">{money(totalAfter)}</strong>, on top of your taxable incomes and split by ownership.
          </p>

          {manual && Math.abs(unallocated) > 0.5 && (
            <div className="callout">
              <span>
                {unallocated > 0
                  ? `${money(unallocated)} of your ${money(s.balance)} isn’t in any account yet, so it earns nothing here.`
                  : `The plan holds ${money(-unallocated)} more than your ${money(s.balance)} savings.`}{' '}
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => {
                    const target = accounts.find((a) => !a.locked) ?? accounts[0]!;
                    s.updateAccount(target.id, { amount: Math.max(0, target.amount + unallocated) });
                  }}
                >
                  {unallocated > 0 ? 'Add it to' : 'Take it from'} {byKey.get((accounts.find((a) => !a.locked) ?? accounts[0]!).key)?.name ?? 'the first account'}
                </button>
              </span>
            </div>
          )}
          {manual && savingsAccounts.length > 0 && Math.abs(depositTotal - s.monthlyDeposit) > 0.5 && (
            <div className="callout">
              <span>
                The plan sends {money(depositTotal)} a month into accounts, but you said you add {money(s.monthlyDeposit)}.{' '}
                <button type="button" className="button quiet" onClick={splitDeposits}>
                  Split {money(s.monthlyDeposit)} for me
                </button>
              </span>
            </div>
          )}
          {lockedAway > s.lockable + 0.5 && (
            <div className="callout">
              <span>
                {money(lockedAway)} is in term deposits, more than the {money(s.lockable)} you said you could lock away.
              </span>
            </div>
          )}
          {s.withdrawal > 0 && savingsAccounts.length > 0 && (
            <p className="note">
              <label className="check">
                Monthly withdrawals of {money(s.withdrawal)} come out of
                <select className="select" value={from ?? ''} onChange={(e) => s.set({ withdrawFrom: e.target.value })} disabled={!manual}>
                  {savingsAccounts.map((a) => {
                    const p = byKey.get(a.key);
                    return (
                      <option key={a.id} value={a.id}>
                        {p ? `${p.brand} ${p.name}` : a.key}
                        {p && !hasNoWithdrawalRule(p) ? ' (bonus needs no withdrawals)' : ''}
                      </option>
                    );
                  })}
                </select>
              </label>
            </p>
          )}
          {result?.warnings
            .filter((w) => !w.includes('assumed 3 months') && !w.includes('no rate for the chosen payment'))
            .map((w) => (
              <div className="callout" key={w}>
                <span>{w}</span>
              </div>
            ))}

          <h2 className="section-title">Government guarantee</h2>
          <p className="note">
            The Financial Claims Scheme covers up to {money(FCS_LIMIT)} per person at each licensed bank. Brands that share a licence share one limit, and joint accounts count half to each holder.
          </p>
          <ul className="fcs-list">
            {groups.map((g) => {
              const rows = exposures.filter((e) => e.group === g);
              const worst = rows.reduce((m, e) => (e.amount > m.amount ? e : m), rows[0]!);
              const over = worst.uncovered > 0;
              return (
                <li key={g}>
                  <div>
                    <strong>{groupName(g)}</strong>
                    <div className={over ? 'flag-off' : 'hint'}>
                      {rows.length > 1 && rows.every((e) => Math.abs(e.amount - worst.amount) < 1)
                        ? `${money(worst.amount)} each`
                        : rows.map((e) => `${displayName(s.people.find((p) => p.id === e.person) ?? s.people[0])}: ${money(e.amount)}`).join(', ')}
                      {over ? `, ${money(worst.uncovered)} above the limit${rows.length > 1 ? ' each' : ''}` : ', within the limit'}
                    </div>
                  </div>
                  <span className={`meter ${over ? 'over' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={FCS_LIMIT} aria-valuenow={Math.round(worst.amount)} aria-label={`${groupName(g)} guarantee use`}>
                    <span style={{ width: `${Math.min(100, (worst.amount / FCS_LIMIT) * 100)}%` }} />
                  </span>
                </li>
              );
            })}
            {etf.length > 0 && (
              <li>
                <div>
                  <strong>Cash ETF</strong>
                  <div className="hint">Not a bank deposit, so not covered.</div>
                </div>
              </li>
            )}
          </ul>
          <p className="hint">Assumes each bank is an authorised deposit-taking institution; you can check on APRA&rsquo;s register.</p>
        </>
      )}
    </section>
  );
}
