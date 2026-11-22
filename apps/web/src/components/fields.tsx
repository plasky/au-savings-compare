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

/** A number written into the band's sentence, underlined in wattle. */
export function InlineNumber(props: NumberFieldProps) {
  const { shown, props: input } = useNumberText(props);
  return (
    <span className="field">
      {props.money && <span className="unit" aria-hidden="true">$</span>}
      <span className="autosize" data-value={shown || ' '}>
        <input {...input} aria-label={props.label} size={1} />
      </span>
    </span>
  );
}

export function InlineSelect<T extends string | number>({
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
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  return (
    <span className="field">
      <span className="autosize for-select" data-value={current}>
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      </span>
    </span>
  );
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
