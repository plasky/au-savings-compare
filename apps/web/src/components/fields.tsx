import { useId, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { parseMoney } from '../format';

interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  label: string;
  /** Arrow-key step. */
  step?: number;
  min?: number;
  max?: number;
  money?: boolean;
}

function stepFor(v: number): number {
  if (v < 10_000) return 500;
  if (v < 100_000) return 1000;
  if (v < 500_000) return 5000;
  return 10_000;
}

function useNumberText({ value, onChange, step, min = 0, max = Number.POSITIVE_INFINITY, money }: NumberFieldProps) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = text ?? (money ? value.toLocaleString('en-AU') : String(value));
  return {
    shown,
    props: {
      value: shown,
      inputMode: 'decimal' as const,
      onFocus: () => setText(String(value)),
      onBlur: () => setText(null),
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        setText(e.target.value);
        const v = money ? parseMoney(e.target.value) : Number(e.target.value.replace(/[^\d.]/g, ''));
        if (v !== null && Number.isFinite(v) && e.target.value.trim() !== '') onChange(clamp(v));
      },
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const s = step ?? (money ? stepFor(value) : 1);
        const next = clamp(value + (e.key === 'ArrowUp' ? s : -s));
        onChange(next);
        setText(String(next));
      },
    },
  };
}

/** A plain money input for forms and tables. */
export function MoneyInput(props: NumberFieldProps & { className?: string }) {
  const { props: input } = useNumberText({ ...props, money: true });
  return <input {...input} className={`text-input money ${props.className ?? ''}`} aria-label={props.label} />;
}

export function NumberInput(props: NumberFieldProps & { width?: string }) {
  const { props: input } = useNumberText(props);
  return <input {...input} className="text-input num" style={{ width: props.width ?? '5em' }} aria-label={props.label} />;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  const id = useId();
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** Log-scale slider position (0–1000) for balances from $1k to $2M, rounded to sensible steps. */
const LO = 1000;
const HI = 2_000_000;
export const balanceToPos = (v: number) => Math.round((1000 * Math.log(Math.min(HI, Math.max(LO, v)) / LO)) / Math.log(HI / LO));
export function posToBalance(p: number): number {
  const v = LO * (HI / LO) ** (p / 1000);
  const s = stepFor(v);
  return Math.round(v / s) * s;
}

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Log-scale balance slider ($1k–$2M) instead of a linear one. */
  log?: boolean;
  money?: boolean;
  /** Largest value that can be typed (defaults to max). */
  inputMax?: number;
  suffix?: string;
  hint?: ReactNode;
}

/** A labelled slider with its value as a typed field, for the band. */
export function SliderField({ label, value, onChange, min, max, step = 1, log, money: isMoney, inputMax, suffix, hint }: SliderFieldProps) {
  const id = useId();
  const { shown, props: input } = useNumberText({ value, onChange, label, min, max: inputMax ?? max, money: isMoney, step: isMoney ? undefined : step });
  const pos = log ? balanceToPos(value) : Math.min(max, Math.max(min, value));
  return (
    <div className="ctl">
      <div className="ctl-head">
        <label htmlFor={id}>{label}</label>
        <span className="ctl-value">
          {isMoney && <span aria-hidden="true">$</span>}
          <span className="autosize" data-value={shown || ' '}>
            <input {...input} aria-label={`${label}, typed`} size={1} />
          </span>
          {suffix && <span className="ctl-suffix">{suffix}</span>}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={log ? 0 : min}
        max={log ? 1000 : max}
        step={log ? 1 : step}
        value={pos}
        onChange={(e) => onChange(log ? posToBalance(Number(e.target.value)) : Number(e.target.value))}
        aria-valuetext={isMoney ? `$${value.toLocaleString('en-AU')}` : `${value}${suffix ? ` ${suffix}` : ''}`}
      />
      {hint && <div className="ctl-hint">{hint}</div>}
    </div>
  );
}
