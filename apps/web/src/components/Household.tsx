import { marginalRate, rulesFor, fyOf } from '@asc/engine';
import { useEffect, useRef } from 'react';
import { pct } from '../format';
import { DEFAULT_CASH_ETF_YIELD, useApp, type PersonInput } from '../store';
import { Check, MoneyInput, NumberInput, Segmented } from './fields';

function PersonRow({ p, title }: { p: PersonInput; title: string }) {
  const setPerson = useApp((s) => s.setPerson);
  const rules = rulesFor(fyOf(new Date()));
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
        <MoneyInput value={p.income} onChange={(v) => setPerson(p.id, { income: v })} label={`${title} taxable income`} max={100_000_000} className="" />
      </label>
      <span className="hint" style={{ gridColumn: '1 / -1', marginTop: -2 }}>
        Interest is taxed at {pct(marginalRate(p.income, rules), 0)} on top of this income, including the Medicare levy ({rules.fy} rates).
      </span>
    </div>
  );
}

export function Household({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const s = useApp();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="sheet" onClose={onClose} aria-labelledby="household-title">
      <div className="sheet-body">
        <h2 id="household-title">Household and tax</h2>
        <p className="hint">These settings stay in this browser. Nothing you enter is sent anywhere.</p>

        <fieldset>
          <legend>Who holds the accounts</legend>
          <Segmented
            label="Who holds the accounts"
            value={s.partner ? 'joint' : 'solo'}
            options={[
              { value: 'solo', label: 'Just me' },
              { value: 'joint', label: 'Me and my partner, jointly' },
            ]}
            onChange={(v) => s.set({ partner: v === 'joint' })}
          />
          <p className="hint">Joint accounts are split equally for tax, and each holder is covered by the government guarantee up to $250,000 per bank.</p>
          <PersonRow p={s.people[0]} title={s.partner ? 'First holder' : 'Name'} />
          {s.partner && <PersonRow p={s.people[1]} title="Second holder" />}
        </fieldset>

        <fieldset>
          <legend>Which accounts to consider</legend>
          <div className="stack">
            <Check checked={s.newCustomer} onChange={(v) => s.set({ newCustomer: v })}>
              We&rsquo;re new to each bank, so introductory rates apply
            </Check>
            <Check checked={s.linkedAccounts} onChange={(v) => s.set({ linkedAccounts: v })}>
              Happy to open an everyday account where a bonus needs one
            </Check>
            <Check checked={s.otherConditionsMet} onChange={(v) => s.set({ otherConditionsMet: v })}>
              Assume we can meet conditions the bank only describes in words
            </Check>
            <Check checked={s.includeRestricted} onChange={(v) => s.set({ includeRestricted: v })}>
              Include accounts for particular groups (kids, seniors, members of a profession)
            </Check>
          </div>
        </fieldset>

        <fieldset>
          <legend>Cash ETF</legend>
          <div className="stack">
            <Check checked={s.cashEtf.enabled} onChange={(v) => s.set({ cashEtf: { ...s.cashEtf, enabled: v } })}>
              Show an indicative cash ETF alongside bank accounts
            </Check>
            <label className="stack-label">
              Estimated yield after fees, % a year
              <span>
                <NumberInput
                  value={Math.round(s.cashEtf.yield * 10000) / 100}
                  onChange={(v) => s.set({ cashEtf: { ...s.cashEtf, yield: v / 100 } })}
                  label="Cash ETF yield, percent"
                  step={0.05}
                  max={20}
                />{' '}
                <button type="button" className="button quiet" onClick={() => s.set({ cashEtf: { ...s.cashEtf, yield: DEFAULT_CASH_ETF_YIELD } })}>
                  Reset to {pct(DEFAULT_CASH_ETF_YIELD)}
                </button>
              </span>
              <span className="hint">The default is the RBA cash rate (4.85% since 3 November 2026) less about 0.20% in fund fees.</span>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Inflation</legend>
          <label className="stack-label">
            Expected inflation, % a year, for &ldquo;today&rsquo;s dollars&rdquo;
            <NumberInput value={Math.round(s.cpi * 1000) / 10} onChange={(v) => s.set({ cpi: v / 100 })} label="Expected inflation, percent" step={0.1} max={20} />
          </label>
        </fieldset>
      </div>
      <div className="sheet-foot">
        <button
          type="button"
          className="button quiet"
          onClick={() => {
            if (confirm('Clear everything you have entered, including your plan?')) s.reset();
          }}
        >
          Clear all settings
        </button>
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
