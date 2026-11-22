import type { Catalogue } from '@asc/engine';
import { dateLabel, money, moneyShort, pct } from '../format';
import { useApp } from '../store';
import { balanceToPos, InlineNumber, InlineSelect, posToBalance } from './fields';

export interface Verdict {
  best: { brand: string; name: string; interest: number; afterTax: number; rate: number } | null;
  plan: { count: number; interest: number; afterTax: number; rate: number; auto: boolean; allocated: number } | null;
  working: boolean;
}

const LOCK_OPTIONS = [3, 6, 12, 24, 36, 60].map((m) => ({ value: m, label: m < 12 ? `${m} months` : m === 12 ? '1 year' : `${m / 12} years` }));

export function Band({ catalogue, verdict, onHousehold }: { catalogue: Catalogue | null; verdict: Verdict; onHousehold: () => void }) {
  const s = useApp();
  const we = s.partner ? 'We' : 'I';
  const after = s.taxView === 'after';
  const figure = (v: { interest: number; afterTax: number }) => money(after ? v.afterTax : v.interest);
  const taxWords = after ? 'after tax' : 'before tax';
  const banks = catalogue ? new Set(catalogue.products.map((p) => p.brand)).size : 0;

  return (
    <header className="band">
      <div className="wrap">
        <div className="masthead">
          <h1 className="wordmark">Savings compare</h1>
          {catalogue && (
            <span>
              {catalogue.counts.savings + catalogue.counts.termDeposits} accounts from {banks} banks, rates fetched {dateLabel(catalogue.crawledAt)}
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="band-button" onClick={onHousehold}>
            Household and tax
          </button>
        </div>

        <p className="sentence">
          {we} have <InlineNumber money value={s.balance} onChange={s.setBalance} label="Savings balance" max={50_000_000} /> in savings and add{' '}
          <InlineNumber money value={s.monthlyDeposit} onChange={(v) => s.set({ monthlyDeposit: v })} label="Monthly deposit" max={1_000_000} /> a month.{' '}
          {we}&rsquo;d make <InlineNumber value={s.purchases} onChange={(v) => s.set({ purchases: Math.round(v) })} label="Card purchases a month at each bank" max={99} /> card purchases a
          month with each bank, take out about{' '}
          <InlineNumber money value={s.withdrawal} onChange={(v) => s.set({ withdrawal: v })} label="Withdrawals a month" max={10_000_000} /> a month, and could lock away{' '}
          <InlineNumber money value={s.lockable} onChange={(v) => s.set({ lockable: v })} label="Amount that can be locked away" max={50_000_000} /> for{' '}
          <InlineSelect value={s.lockMonths} options={LOCK_OPTIONS} onChange={(v) => s.set({ lockMonths: v })} label="How long it can be locked away" />.
        </p>

        <div className="balance-slider">
          <span>{moneyShort(1000)}</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={balanceToPos(s.balance)}
            onChange={(e) => s.setBalance(posToBalance(Number(e.target.value)))}
            aria-label="Savings balance"
            aria-valuetext={money(s.balance)}
          />
          <span>{moneyShort(2_000_000)}</span>
        </div>

        <p className="verdict" aria-live="polite" style={{ opacity: verdict.working ? 0.7 : 1 }}>
          {verdict.plan && verdict.plan.count > (verdict.plan.auto ? 1 : 0) ? (
            <>
              {verdict.plan.auto ? `Split across ${verdict.plan.count} accounts` : `Your plan of ${verdict.plan.count} account${verdict.plan.count === 1 ? '' : 's'}`} earns{' '}
              <span className="figure num">{figure(verdict.plan)}</span> in the first year {taxWords}, or <strong>{pct(verdict.plan.rate)}</strong> a year.
              {Math.abs(verdict.plan.allocated - s.balance) > 0.5 && (
                <>
                  {' '}
                  It places {money(verdict.plan.allocated)} of your {money(s.balance)}.
                </>
              )}
              {verdict.best && (
                <>
                  {' '}
                  The best single account, {verdict.best.brand}&rsquo;s {verdict.best.name}, earns {figure(verdict.best)}.
                </>
              )}
            </>
          ) : verdict.best ? (
            <>
              {verdict.plan?.auto ? 'One account is the best plan here: ' : 'The best single account is '}
              <strong>
                {verdict.best.brand}&rsquo;s {verdict.best.name}
              </strong>
              , earning <span className="figure num">{figure(verdict.best)}</span> in the first year {taxWords}, or <strong>{pct(verdict.best.rate)}</strong> a year.
            </>
          ) : catalogue ? (
            <>No account fits these settings. Try including accounts for particular groups in Household and tax.</>
          ) : (
            <>Loading rates…</>
          )}
        </p>
      </div>
    </header>
  );
}
