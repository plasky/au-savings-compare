import { FCS_LIMIT } from '@asc/engine';
import { useEffect, useRef, useState } from 'react';
import { money, termLabel } from '../format';
import { useApp, type PersonInput } from '../store';
import { Check, MoneyInput, NumberInput, Segmented } from './fields';

const STEPS = ['Whose savings', 'Your money', 'Locking money away', 'How much effort'] as const;

function Person({ p, title }: { p: PersonInput; title: string }) {
  const setPerson = useApp((s) => s.setPerson);
  return (
    <div className="person-grid">
      <label>
        {title}
        <input className="text-input" value={p.name} placeholder={p.id === 'p1' ? 'You' : 'Partner'} onChange={(e) => setPerson(p.id, { name: e.target.value })} />
      </label>
      <label>
        Age
        <NumberInput value={p.age} onChange={(v) => setPerson(p.id, { age: Math.round(v) })} label={`${title} age`} max={120} width="100%" />
      </label>
      <label>
        Taxable income
        <MoneyInput value={p.income} onChange={(v) => setPerson(p.id, { income: v })} label={`${title} taxable income`} max={100_000_000} />
      </label>
    </div>
  );
}

/** First-visit questions; every answer lands in the same settings the band and Household dialog edit. */
export function Setup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const s = useApp();
  const [step, setStep] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setStep(0);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const finish = (tab: 'plan' | 'compare') => {
    s.set({ setupDone: true, tab, ...(tab === 'plan' ? { planMode: 'auto' as const } : {}) });
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="setup-title"
      onClose={() => {
        s.set({ setupDone: true });
        onClose();
      }}
    >
      <div className="sheet-body">
        <p className="hint" style={{ margin: 0 }}>
          Step {step + 1} of {STEPS.length}
        </p>
        <h2 id="setup-title">{STEPS[step]}</h2>

        {step === 0 && (
          <>
            <p className="note">Your answers stay in this browser. Nothing is sent anywhere.</p>
            <Segmented
              label="Whose savings"
              value={s.partner ? 'joint' : 'solo'}
              options={[
                { value: 'solo', label: 'Just mine' },
                { value: 'joint', label: 'Mine and my partner’s, in joint accounts' },
              ]}
              onChange={(v) => s.set({ partner: v === 'joint' })}
            />
            <p className="hint">Ages matter for some accounts, and taxable income (before this interest) sets the tax you&rsquo;ll pay on it.</p>
            <Person p={s.people[0]} title={s.partner ? 'First holder' : 'Your name'} />
            {s.partner && <Person p={s.people[1]} title="Second holder" />}
          </>
        )}

        {step === 1 && (
          <div className="stack">
            <label className="stack-label">
              Savings you have now
              <MoneyInput value={s.balance} onChange={s.setBalance} label="Savings you have now" max={50_000_000} />
            </label>
            <label className="stack-label">
              What you add each month, on average
              <MoneyInput value={s.monthlyDeposit} onChange={(v) => s.set({ monthlyDeposit: v })} label="Monthly deposit" max={1_000_000} />
            </label>
            <label className="stack-label">
              What you take out of savings each month, on average
              <MoneyInput value={s.withdrawal} onChange={(v) => s.set({ withdrawal: v })} label="Monthly withdrawals" max={10_000_000} />
              <span className="hint">Many bonus rates need a month with no withdrawals, so this changes which accounts suit you.</span>
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <p className="note">Term deposits pay a fixed rate, but the money is locked away until the term ends. Leave this at $0 if you need everything on hand.</p>
            <label className="stack-label">
              Amount you could lock away
              <MoneyInput value={s.lockable} onChange={(v) => s.set({ lockable: v })} label="Amount you could lock away" max={50_000_000} />
            </label>
            <label className="stack-label">
              For up to
              <select className="select" value={s.lockMonths} onChange={(e) => s.set({ lockMonths: Number(e.target.value) })}>
                {[3, 6, 12, 24, 36, 60].map((m) => (
                  <option key={m} value={m}>
                    {termLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <label className="stack-label">
              Card purchases you&rsquo;d make each month at each bank
              <NumberInput value={s.purchases} onChange={(v) => s.set({ purchases: Math.round(v) })} label="Card purchases a month" max={99} />
              <span className="hint">Several of the best bonuses need 5 a month on that bank&rsquo;s debit card.</span>
            </label>
            <label className="stack-label">
              Most accounts you&rsquo;d want to juggle
              <select className="select" value={s.maxAccounts} onChange={(e) => s.set({ maxAccounts: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack-label">
              Only open another account if it earns at least
              <select className="select" value={s.accountCost} onChange={(e) => s.set({ accountCost: Number(e.target.value) })}>
                {[0, 100, 250, 500, 1000].map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? 'anything extra' : `${money(v)} a year more`}
                  </option>
                ))}
              </select>
            </label>
            <Check checked={s.linkedAccounts} onChange={(v) => s.set({ linkedAccounts: v })}>
              Happy to open an everyday account where a bonus needs one
            </Check>
            <Check checked={s.fcsCap} onChange={(v) => s.set({ fcsCap: v })}>
              Keep each of us within the {money(FCS_LIMIT)} government guarantee at each bank
            </Check>
          </div>
        )}
      </div>
      <div className="sheet-foot">
        {step === 0 ? (
          <button type="button" className="button quiet" onClick={() => finish('compare')}>
            Skip
          </button>
        ) : (
          <button type="button" className="button" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" className="button primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="button" onClick={() => finish('compare')}>
              Compare accounts
            </button>
            <button type="button" className="button primary" onClick={() => finish('plan')}>
              Show my best plan
            </button>
          </span>
        )}
      </div>
    </dialog>
  );
}
