import {
  introLength,
  monthlyTasks,
  tdRate,
  type CatalogueProduct,
  type SimulationResult,
  type SwitchMove,
} from '@asc/engine';
import { useMemo, useState } from 'react';
import { buildIcs, download, type IcsEvent } from '../calendar';
import { money, pct, termLabel } from '../format';
import { afterTaxFactor as taxFactor, isCustomKey, monthKey, monthLabel, monthsBetween, startDate } from '../model';
import { useApp, type HeldInput, type PlanAccount } from '../store';
import type { HeldAdviceState } from '../useAutoPlan';
import { MoneyInput, NumberInput } from './fields';

const color = (slot: number) => `var(--s${(slot % 8) + 1})`;
const TERMS = [1, 3, 4, 6, 9, 12, 18, 24, 36, 48, 60];

function nameOf(byKey: Map<string, CatalogueProduct>, key: string): string {
  const p = byKey.get(key);
  return p ? `${p.brand} ${p.name}`.trim() : 'an account no longer listed';
}

function AddAccount({ products, onAdd }: { products: CatalogueProduct[]; onAdd: (p: CatalogueProduct | null) => void }) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (q.trim().length < 2) return [];
    // Every word typed must start a word in the bank or account name ("unity" finds Unity Bank, not Community).
    const res = words.map((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    return products
      .filter((p) => res.every((re) => re.test(`${p.brand} ${p.name}`)))
      .sort((a, b) => Number(!a.brand.toLowerCase().startsWith(words[0]!)) - Number(!b.brand.toLowerCase().startsWith(words[0]!)))
      .slice(0, 8);
  }, [q, products]);
  return (
    <div className="add-account">
      <input
        className="text-input"
        type="search"
        placeholder="Add an account: type the bank or account name"
        aria-label="Find an account you hold"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim().length >= 2 && (
        <ul className="picker" role="listbox" aria-label="Matching accounts">
          {matches.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => {
                  onAdd(p);
                  setQ('');
                }}
              >
                <strong>{p.brand}</strong> {p.name} <span className="hint">{p.kind === 'term_deposit' ? 'term deposit' : 'savings'}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => {
                onAdd(null);
                setQ('');
              }}
            >
              Not listed: add it by hand with its rate
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function HeldRow({ h, byKey, result }: { h: HeldInput; byKey: Map<string, CatalogueProduct>; result: SimulationResult | null }) {
  const s = useApp();
  const p = byKey.get(h.key);
  const fy = result?.summary.perAccountFirstYear[h.id];
  const isTd = h.termMonths !== null;
  const custom = isCustomKey(h.key);
  const label = (custom ? h.custom?.name : p ? `${p.brand} ${p.name}`.trim() : '') || 'account';
  const today =
    isTd && p
      ? tdRate({ kind: 'term_deposit', id: h.id, product: p, owners: {}, principal: Math.max(h.amount, 1000), termMonths: h.termMonths ?? 12, payment: 'MATURITY' }, Math.max(h.amount, 1000), [])
      : 0;
  return (
    <li className="held-row">
      <div className="held-name">
        <span className="key" style={{ background: color(h.slot) }} />
        {custom ? (
          <span className="custom-fields">
            <input
              className="text-input"
              value={h.custom?.name ?? ''}
              placeholder="Account name"
              aria-label="Account name"
              onChange={(e) => s.updateHeld(h.id, { custom: { name: e.target.value, rate: h.custom?.rate ?? 0 } })}
            />
            <label className="check">
              <NumberInput
                value={Math.round((h.custom?.rate ?? 0) * 10000) / 100}
                onChange={(v) => s.updateHeld(h.id, { custom: { name: h.custom?.name ?? '', rate: v / 100 } })}
                label="Rate, percent a year"
                step={0.05}
                max={20}
              />
              % a year
            </label>
          </span>
        ) : (
          <span>
            <strong>{p?.brand ?? 'Unavailable'}</strong> {p?.name}
            {!p && <span className="flag-off"> No longer in the bank data</span>}
          </span>
        )}
      </div>
      <label className="stack-label">
        Balance
        <MoneyInput value={h.amount} onChange={(v) => s.updateHeld(h.id, { amount: v })} label={`Balance of ${label}`} max={50_000_000} />
      </label>
      {isTd ? (
        <div className="held-details">
          <label className="stack-label">
            Term
            <select className="select" value={h.termMonths ?? 12} onChange={(e) => s.updateHeld(h.id, { termMonths: Number(e.target.value) })}>
              {TERMS.map((t) => (
                <option key={t} value={t}>
                  {termLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-label">
            Your rate, %
            <NumberInput
              value={h.tdRate === null ? 0 : Math.round(h.tdRate * 10000) / 100}
              onChange={(v) => s.updateHeld(h.id, { tdRate: v > 0 ? v / 100 : null })}
              label="Locked-in rate, percent"
              step={0.05}
              max={20}
            />
            {h.tdRate === null && today > 0 && <span className="hint">0 uses today&rsquo;s {pct(today)}</span>}
          </label>
          <label className="stack-label">
            Matures
            <input className="text-input" type="month" value={h.maturity ?? ''} onChange={(e) => s.updateHeld(h.id, { maturity: e.target.value || null })} />
          </label>
        </div>
      ) : (
        <div className="held-details">
          <label className="stack-label">
            Deposit a month
            <MoneyInput value={h.deposit} onChange={(v) => s.updateHeld(h.id, { deposit: v })} label={`Monthly deposit into ${label}`} max={1_000_000} />
          </label>
          {!custom && (
            <label className="stack-label">
              Opened
              <input
                className="text-input"
                type="month"
                value={h.opened ?? ''}
                max={monthKey()}
                onChange={(e) => s.updateHeld(h.id, { opened: e.target.value || null })}
                aria-describedby={`opened-${h.id}`}
              />
              <span className="hint" id={`opened-${h.id}`}>
                {h.opened ? '' : 'Blank: over a year ago'}
              </span>
            </label>
          )}
        </div>
      )}
      <div className="held-result num">
        {fy ? (
          <>
            {money(fy.interest)}
            <span className="sub">first year, {pct(fy.rate)}</span>
          </>
        ) : (
          <span className="hint">–</span>
        )}
      </div>
      <button type="button" className="icon-button" onClick={() => s.removeHeld(h.id)} aria-label={`Remove ${label}`}>
        Remove
      </button>
    </li>
  );
}

function Moves({ moves, byKey }: { moves: SwitchMove[]; byKey: Map<string, CatalogueProduct> }) {
  return (
    <ul className="moves">
      {moves.map((m, i) => (
        <li key={i}>
          {m.fromKey ? (
            <>
              Move <strong className="num">{money(m.amount)}</strong> from {nameOf(byKey, m.fromKey)} to{' '}
            </>
          ) : (
            <>
              Put <strong className="num">{money(m.amount)}</strong> of new savings into{' '}
            </>
          )}
          <strong>{nameOf(byKey, m.toKey)}</strong>
          {m.toTermMonths ? ` as a ${termLabel(m.toTermMonths)} term deposit` : ''}
        </li>
      ))}
    </ul>
  );
}

interface ChecklistAccount {
  id: string;
  key: string;
  deposit: number;
  termMonths: number | null;
  opened: string | null;
  maturity: string | null;
}

function Checklist({ accounts, byKey, fromPlan }: { accounts: ChecklistAccount[]; byKey: Map<string, CatalogueProduct>; fromPlan: boolean }) {
  const s = useApp();
  const month = monthKey();
  const ticked = new Set(s.checks[month] ?? []);
  const start = startDate();
  const items = accounts
    .filter((a) => a.termMonths === null)
    .map((a) => ({ a, p: byKey.get(a.key), tasks: byKey.get(a.key) ? monthlyTasks(byKey.get(a.key)!) : [] }))
    .filter((x) => x.p && x.tasks.length);

  const upcoming: Array<{ date: string; text: string }> = [];
  for (const a of accounts) {
    const p = byKey.get(a.key);
    if (!p) continue;
    if (a.termMonths === null) {
      const intro = introLength(p);
      const opened = a.opened ?? (fromPlan ? monthKey(new Date(`${start}T00:00:00`)) : null);
      if (intro !== null && opened) {
        const [y, m] = opened.split('-').map(Number) as [number, number];
        const end = new Date(y, m - 1 + intro, 1);
        const key = monthKey(end);
        if (monthsBetween(month, key) >= 0 && monthsBetween(month, key) <= 12) upcoming.push({ date: key, text: `${p.brand} ${p.name}: intro rate ends` });
      }
    } else if (a.maturity) {
      upcoming.push({ date: a.maturity, text: `${p.brand} ${p.name}: term deposit matures; decide where the money goes` });
    }
  }
  upcoming.sort((x, y) => x.date.localeCompare(y.date));

  const addToCalendar = () => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const day = Math.min(28, Math.max(1, s.reminderDay));
    const first = new Date(y, m - 1, day) < new Date() ? new Date(y, m, day) : new Date(y, m - 1, day);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const events: IcsEvent[] = [];
    if (items.length) {
      events.push({
        uid: 'monthly-bonuses',
        date: iso(first),
        monthly: true,
        summary: 'Savings bonus check',
        description: items.map(({ p, tasks }) => `${p!.brand} ${p!.name}:\n${tasks.map((t) => `- ${t.text}`).join('\n')}`).join('\n\n'),
      });
    }
    for (const u of upcoming) events.push({ uid: `${u.date}-${u.text.replace(/\W+/g, '-').toLowerCase()}`, date: `${u.date}-01`, summary: u.text, description: u.text });
    download('savings-reminders.ics', buildIcs(events));
  };

  if (!items.length && !upcoming.length) {
    return <p className="note">No monthly conditions to keep track of{fromPlan ? ' in your plan' : ''}.</p>;
  }

  return (
    <>
      {fromPlan && <p className="note">Based on your plan. Add the accounts you actually hold above to track them instead.</p>}
      <div className="checklist">
        {items.map(({ a, p, tasks }) => (
          <section key={a.id} aria-label={`${p!.brand} ${p!.name}`}>
            <h3>
              {p!.brand} {p!.name}
            </h3>
            <ul>
              {tasks.map((t) => {
                const id = `${a.id}|${t.id}`;
                const amount = t.type === 'MIN_DEPOSIT_AMOUNT' ? (t.amount ?? 0) : 0;
                return (
                  <li key={id}>
                    <label className="check">
                      <input type="checkbox" checked={ticked.has(id)} onChange={() => s.toggleCheck(month, id)} />
                      <span>
                        {t.text}
                        {amount > 0 && a.deposit < amount && <span className="flag-warn"> Your usual deposit here is {money(a.deposit)}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {upcoming.length > 0 && (
        <>
          <h3 className="sub-title">Coming up</h3>
          <ul className="upcoming">
            {upcoming.map((u) => (
              <li key={u.date + u.text}>
                <span className="when">{monthLabel(u.date, 'short')}</span> {u.text}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="controls" style={{ marginTop: 16 }}>
        <label className="check">
          Remind me on day
          <NumberInput value={s.reminderDay} onChange={(v) => s.set({ reminderDay: Math.min(28, Math.max(1, Math.round(v))) })} label="Reminder day of the month" max={28} width="4em" />
          of each month
        </label>
        <button type="button" className="button" onClick={addToCalendar}>
          Add reminders to my calendar
        </button>
      </p>
    </>
  );
}

export function MyAccounts({
  products,
  byKey,
  result,
  advice,
  plan,
}: {
  products: CatalogueProduct[];
  byKey: Map<string, CatalogueProduct>;
  result: SimulationResult | null;
  advice: HeldAdviceState;
  plan: PlanAccount[];
}) {
  const s = useApp();
  const held = s.held;
  const total = held.reduce((sum, h) => sum + h.amount, 0);
  const lockedTotal = held.filter((h) => h.termMonths !== null).reduce((sum, h) => sum + h.amount, 0);
  const afterTaxFactor = taxFactor(s);
  const adv = advice.status === 'done' ? advice.result : advice.status === 'working' ? advice.last : null;
  const gain = adv ? adv.bestInterest - adv.stay : 0;
  const worth = gain >= Math.max(50, s.accountCost);

  const add = (p: CatalogueProduct | null) => {
    if (!p) {
      const key = `custom:${Math.random().toString(36).slice(2, 9)}`;
      s.addHeld({ key, custom: { name: '', rate: 0.04 }, amount: 0, deposit: 0, termMonths: null, opened: null, tdRate: null, maturity: null });
      return;
    }
    const isTd = p.kind === 'term_deposit';
    s.addHeld({ key: p.key, custom: null, amount: 0, deposit: isTd ? 0 : held.length ? 0 : s.monthlyDeposit, termMonths: isTd ? 12 : null, opened: null, tdRate: null, maturity: null });
  };

  const copyPlan = () => {
    const now = monthKey();
    for (const a of plan) {
      const [y, m] = now.split('-').map(Number) as [number, number];
      s.addHeld({
        key: a.key,
        custom: null,
        amount: a.amount,
        deposit: a.deposit,
        termMonths: a.termMonths,
        opened: a.termMonths === null ? now : null,
        tdRate: null,
        maturity: a.termMonths !== null ? monthKey(new Date(y, m - 1 + a.termMonths, 1)) : null,
      });
    }
  };

  const checklistAccounts: ChecklistAccount[] = held.length
    ? held.map((h) => ({ id: h.id, key: h.key, deposit: h.deposit, termMonths: h.termMonths, opened: h.opened, maturity: h.maturity }))
    : plan.map((a) => ({ id: a.id, key: a.key, deposit: a.deposit, termMonths: a.termMonths, opened: null, maturity: null }));

  return (
    <section aria-label="My accounts">
      <p className="note" style={{ marginTop: 0 }}>
        Enter the accounts you hold now to see what they earn, what switching would gain, and what each bonus needs this month. This stays in your browser.
      </p>
      <div className="controls">
        <AddAccount products={products} onAdd={add} />
        {plan.length > 0 && (
          <button type="button" className="button" onClick={copyPlan}>
            I&rsquo;ve opened my plan&rsquo;s accounts
          </button>
        )}
      </div>

      {held.length > 0 && (
        <>
          <ul className="held-list">
            {held.map((h) => (
              <HeldRow key={h.id} h={h} byKey={byKey} result={result} />
            ))}
          </ul>
          <p className="held-total">
            Together <strong className="num">{money(total)}</strong>
            {result ? (
              <>
                , earning <strong className="num">{money(s.taxView === 'after' ? result.summary.firstYearAfterTax : result.summary.firstYearInterest)}</strong> in the first year{' '}
                {s.taxView === 'after' ? 'after tax' : 'before tax'} ({pct(result.summary.firstYearRate)}).
              </>
            ) : (
              '.'
            )}
            {Math.abs(total - s.balance) > 0.5 && (
              <>
                {' '}
                The band above uses {money(s.balance)}.{' '}
                <button type="button" className="button quiet" onClick={() => s.setBalance(total)}>
                  Use {money(total)} there
                </button>
              </>
            )}
          </p>

          <h2 className="section-title">Should you switch?</h2>
          {!adv ? (
            <p className="note">Working it out…</p>
          ) : worth ? (
            <>
              <p className="note" style={{ opacity: advice.status === 'working' ? 0.6 : 1 }}>
                Rearranging your savings accounts could earn about <strong>{money(gain * afterTaxFactor)}</strong> more in the first year after tax ({money(gain)} before tax), counting what
                you&rsquo;d give up on intro rates and only opening accounts that earn at least {money(s.accountCost)} a year.
                {lockedTotal > 0 && ' Term deposits stay where they are until they mature.'}
              </p>
              <Moves moves={adv.moves} byKey={byKey} />
            </>
          ) : (
            <div className="callout ok">
              <span>
                Your savings accounts are within {money(Math.max(50, s.accountCost))} a year of the best arrangement for your settings, so there&rsquo;s nothing worth moving right now.
              </span>
            </div>
          )}

          <h2 className="section-title">As intro rates end and deposits mature</h2>
          {!adv ? (
            <p className="note">Working it out…</p>
          ) : adv.steps.length === 0 ? (
            <p className="note">
              {adv.timelineFrom === 'switched' ? 'After those moves, nothing' : 'Keeping things as they are, nothing'} in the next two years makes another move worth it: no intro rate ends or
              deposit matures where switching would earn enough more.
            </p>
          ) : (
            <>
            <p className="note">{adv.timelineFrom === 'switched' ? 'After the moves above:' : 'Keeping things as they are:'}</p>
            <ol className="timeline">
              {adv.steps.map((st) => (
                <li key={st.month}>
                  <div className="when">{monthLabel(st.date.slice(0, 7))}</div>
                  <div>
                    <div className="hint">{st.reasons.join('; ')}</div>
                    <Moves moves={st.moves} byKey={byKey} />
                    <div className="hint">About {money(st.gain * afterTaxFactor)} more over the following year after tax.</div>
                  </div>
                </li>
              ))}
            </ol>
            </>
          )}
        </>
      )}

      <h2 className="section-title">This month: {monthLabel(monthKey())}</h2>
      {checklistAccounts.length ? (
        <Checklist accounts={checklistAccounts} byKey={byKey} fromPlan={!held.length} />
      ) : (
        <p className="note">Add accounts above, or build a plan, to get a checklist of what each bonus needs each month.</p>
      )}
    </section>
  );
}
