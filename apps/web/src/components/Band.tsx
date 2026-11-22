import { FCS_LIMIT, fyOf, marginalRate, rulesFor, type Catalogue } from '@asc/engine';
import { useState, type ReactNode } from 'react';
import { dateLabel, money, moneyShort, pct } from '../format';
import { useApp, type PersonInput } from '../store';
import { Check, Segmented, SliderField } from './fields';

export interface Verdict {
  best: { brand: string; name: string; interest: number; afterTax: number; rate: number } | null;
  plan: { count: number; interest: number; afterTax: number; rate: number; auto: boolean; allocated: number } | null;
  working: boolean;
}

const LOCK_TERMS = [3, 6, 12, 24, 36, 60].map((m) => ({ value: m, label: m < 12 ? `${m} mo` : m === 12 ? '1 yr' : `${m / 12} yrs` }));

/** A group of controls; on narrow screens all but the first start folded, with a one-line summary. */
function Group({ title, summary, open, children }: { title: string; summary: string; open: boolean; children: ReactNode }) {
  return (
    <details className="ctl-group" open={open}>
      <summary>
        <span className="ctl-title">{title}</span>
        <span className="ctl-summary">{summary}</span>
      </summary>
      <div className="ctl-body">{children}</div>
    </details>
  );
}

function PersonControls({ p, who }: { p: PersonInput; who: string }) {
  const setPerson = useApp((s) => s.setPerson);
  const rate = marginalRate(p.income, rulesFor(fyOf(new Date())));
  return (
    <>
      <SliderField label={`${who} age`} value={p.age} onChange={(v) => setPerson(p.id, { age: Math.round(v) })} min={16} max={90} inputMax={120} />
      <SliderField
        label={`${who} taxable income`}
        value={p.income}
        onChange={(v) => setPerson(p.id, { income: Math.round(v) })}
        min={0}
        max={300_000}
        step={1000}
        inputMax={100_000_000}
        money
        hint={`Interest taxed at ${pct(rate, 0)} including Medicare`}
      />
    </>
  );
}

function VerdictLine({ verdict, catalogue }: { verdict: Verdict; catalogue: Catalogue | null }) {
  const s = useApp();
  const after = s.taxView === 'after';
  const figure = (v: { interest: number; afterTax: number }) => money(after ? v.afterTax : v.interest);
  const taxWords = after ? 'after tax' : 'before tax';
  if (verdict.plan && verdict.plan.count > (verdict.plan.auto ? 1 : 0)) {
    return (
      <>
        {verdict.plan.auto ? `Split across ${verdict.plan.count} accounts` : `Your plan of ${verdict.plan.count} account${verdict.plan.count === 1 ? '' : 's'}`} earns{' '}
        <span className="figure num">{figure(verdict.plan)}</span> in the first year {taxWords}, <span className="num">{pct(verdict.plan.rate)}</span> a year.
        <span className="verdict-sub">
          {Math.abs(verdict.plan.allocated - s.balance) > 0.5 && `It places ${money(verdict.plan.allocated)} of your ${money(s.balance)}. `}
          {verdict.best && `The best single account, ${verdict.best.brand}’s ${verdict.best.name}, earns ${figure(verdict.best)}.`}
        </span>
      </>
    );
  }
  if (verdict.best) {
    return (
      <>
        {verdict.plan?.auto ? 'One account is the best plan here: ' : 'The best single account is '}
        {verdict.best.brand}&rsquo;s {verdict.best.name}, earning <span className="figure num">{figure(verdict.best)}</span> in the first year {taxWords},{' '}
        <span className="num">{pct(verdict.best.rate)}</span> a year.
      </>
    );
  }
  return <>{catalogue ? 'No account fits these settings. Try including accounts for particular groups in More settings.' : 'Loading rates…'}</>;
}

export function Band({ catalogue, verdict, onHousehold }: { catalogue: Catalogue | null; verdict: Verdict; onHousehold: () => void }) {
  const s = useApp();
  const banks = catalogue ? new Set(catalogue.products.map((p) => p.brand)).size : 0;
  // Everything open on wide screens; on phones only "Your money" starts open.
  const [wide] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 721px)').matches);
  const termWords = LOCK_TERMS.find((t) => t.value === s.lockMonths)?.label ?? `${s.lockMonths} mo`;
  const ages = s.partner ? `${s.people[0].age} and ${s.people[1].age}` : `${s.people[0].age}`;

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
            More settings
          </button>
        </div>

        <p className="headline" aria-live="polite" style={{ opacity: verdict.working ? 0.7 : 1 }}>
          <VerdictLine verdict={verdict} catalogue={catalogue} />
        </p>

        <div className="controls-grid">
          <Group title="Your money" summary={`${money(s.balance)}, +${money(s.monthlyDeposit)} a month`} open>
            <SliderField label="Savings now" value={s.balance} onChange={s.setBalance} min={1000} max={2_000_000} log money inputMax={50_000_000} />
            <SliderField label="Added each month" value={s.monthlyDeposit} onChange={(v) => s.set({ monthlyDeposit: v })} min={0} max={10_000} step={100} money inputMax={1_000_000} />
            <SliderField
              label="Taken out each month"
              value={s.withdrawal}
              onChange={(v) => s.set({ withdrawal: v })}
              min={0}
              max={10_000}
              step={100}
              money
              inputMax={10_000_000}
              hint="Many bonuses need a month with no withdrawals"
            />
          </Group>

          <Group title="Locking money away" summary={s.lockable > 0 ? `${money(s.lockable)} for ${termWords}` : 'None'} open={wide}>
            <SliderField
              label="Could lock away"
              value={s.lockable}
              onChange={(v) => s.set({ lockable: v })}
              min={0}
              max={Math.max(s.balance, s.lockable)}
              step={s.balance > 200_000 ? 5000 : 1000}
              money
              inputMax={50_000_000}
              hint="Term deposits pay a fixed rate but lock the money until they mature"
            />
            <div className="ctl">
              <div className="ctl-head">
                <span>For up to</span>
              </div>
              <Segmented label="Longest term" value={s.lockMonths} options={LOCK_TERMS} onChange={(v) => s.set({ lockMonths: v })} />
            </div>
          </Group>

          <Group title="Household" summary={`${s.partner ? 'Joint' : 'Just me'}, age ${ages}`} open={wide}>
            <div className="ctl">
              <Segmented
                label="Whose savings"
                value={s.partner ? 'joint' : 'solo'}
                options={[
                  { value: 'solo', label: 'Just me' },
                  { value: 'joint', label: 'Joint with partner' },
                ]}
                onChange={(v) => s.set({ partner: v === 'joint' })}
              />
            </div>
            <PersonControls p={s.people[0]} who="Your" />
            {s.partner && <PersonControls p={s.people[1]} who="Partner’s" />}
          </Group>

          <Group title="Effort" summary={`${s.purchases} card purchases, up to ${s.maxAccounts} account${s.maxAccounts === 1 ? '' : 's'}`} open={wide}>
            <SliderField
              label="Card purchases a month at each bank"
              value={s.purchases}
              onChange={(v) => s.set({ purchases: Math.round(v) })}
              min={0}
              max={10}
              inputMax={99}
              hint="Several of the best bonuses need 5"
            />
            <div className="ctl">
              <div className="ctl-head">
                <span>Most accounts to juggle</span>
              </div>
              <Segmented label="Most accounts to juggle" value={s.maxAccounts} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} onChange={(v) => s.set({ maxAccounts: v })} />
            </div>
            <div className="ctl">
              <div className="ctl-head">
                <span>Open another account for</span>
              </div>
              <Segmented
                label="Open another account for"
                value={s.accountCost}
                options={[0, 100, 250, 500, 1000].map((v) => ({ value: v, label: v === 0 ? 'Any gain' : `${moneyShort(v)}+` }))}
                onChange={(v) => s.set({ accountCost: v })}
              />
              <div className="ctl-hint">Extra interest a year it must add</div>
            </div>
            <div className="ctl stack">
              <Check checked={s.linkedAccounts} onChange={(v) => s.set({ linkedAccounts: v })}>
                Happy to open an everyday account where a bonus needs one
              </Check>
              <Check checked={s.fcsCap} onChange={(v) => s.set({ fcsCap: v })}>
                Stay within the {money(FCS_LIMIT)} guarantee at each bank
              </Check>
            </div>
          </Group>
        </div>
      </div>
    </header>
  );
}
