/**
 * Two small SVG charts drawn to the dataviz spec: hairline grid, 2px surface
 * gaps between stacked marks, bars no thicker than 24px with 4px rounded ends,
 * a crosshair (area) or per-column (bars) tooltip, a legend, and a table view.
 */
import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { money, moneyShort } from '../format';

export interface Series {
  id: string;
  label: string;
  color: string;
  values: number[];
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(720);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function Legend({ series, kind }: { series: Series[]; kind: 'rect' | 'line' }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.id}>
          <span className={kind === 'rect' ? 'key' : 'line-key'} style={{ background: s.color, marginRight: 6 }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = x > width * 0.6 ? undefined : x + 14;
  const right = x > width * 0.6 ? width - x + 14 : undefined;
  return (
    <div className="tooltip" style={{ left, right, top: Math.max(0, y) }}>
      {children}
    </div>
  );
}

function Rows({ series, i, total }: { series: Series[]; i: number; total?: string }) {
  return (
    <>
      {[...series].reverse().map((s) => (
        <div className="t-row" key={s.id}>
          <span className="line-key" style={{ background: s.color }} />
          <span>{s.label}</span>
          <b>{money(s.values[i] ?? 0)}</b>
        </div>
      ))}
      {total && series.length > 1 && (
        <div className="t-row" style={{ marginTop: 4 }}>
          <span />
          <span>Total</span>
          <b>{total}</b>
        </div>
      )}
    </>
  );
}

const M = { top: 12, right: 12, bottom: 28, left: 56 };

/** Stacked balances over time, one layer per account. */
export function StackedArea({ series, dates, height = 260, label }: { series: Series[]; dates: string[]; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = dates.length;
  const totals = dates.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const yMax = niceMax(Math.max(...totals, 1));
  const iw = Math.max(10, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const x = (i: number) => M.left + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => M.top + ih - (v / yMax) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const cum = series.map((_, k) => dates.map((__, i) => series.slice(0, k + 1).reduce((s, x) => s + (x.values[i] ?? 0), 0)));
  const areas = series.map((s, k) => {
    const top = cum[k]!.map((v, i) => `${x(i)},${y(v)}`);
    const bottom = (k === 0 ? dates.map(() => 0) : cum[k - 1]!).map((v, i) => `${x(i)},${y(v)}`).reverse();
    return { s, d: `M${top.join('L')}L${bottom.join('L')}Z`, line: `M${top.join('L')}` };
  });
  const yearTicks = dates.map((d, i) => ({ d, i })).filter(({ d, i }) => i === 0 || (d.slice(5, 7) === '01' && i >= 4));
  const every = Math.ceil(yearTicks.length / Math.max(2, Math.floor(iw / 70)));

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / r.width) * (n - 1)))));
  };

  return (
    <div className="chart" ref={ref}>
      <Legend series={series} kind="rect" />
      <svg height={height} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {moneyShort(t)}
            </text>
          </g>
        ))}
        {yearTicks
          .filter((_, k) => k % every === 0)
          .map(({ d, i }) => (
            <text key={d} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : 'middle'}>
              {i === 0 ? new Date(d).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : d.slice(0, 4)}
            </text>
          ))}
        {areas.map(({ s, d }) => (
          <path key={s.id} d={d} fill={s.color} fillOpacity={0.72} />
        ))}
        {areas.map(({ s, line }) => (
          <path key={`${s.id}-edge`} d={line} fill="none" stroke="var(--paper)" strokeWidth={2} strokeLinejoin="round" />
        ))}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} stroke="var(--ink-3)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(totals[hover]!)} r={4} fill="var(--ink)" stroke="var(--paper)" strokeWidth={2} />
          </>
        )}
        <rect
          x={M.left}
          y={M.top}
          width={iw}
          height={ih}
          fill="transparent"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
          tabIndex={0}
          aria-label={`${label}: use the left and right arrow keys to read values`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
            if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
          }}
          onBlur={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover)} y={M.top} width={width}>
          <div className="t-head">{new Date(dates[hover]!).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</div>
          <Rows series={series} i={hover} total={money(totals[hover]!)} />
        </Tooltip>
      )}
    </div>
  );
}

function barPath(x: number, y: number, w: number, h: number, round: number): string {
  if (h <= 0) return '';
  const r = Math.min(round, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Stacked columns per category (e.g. financial year), total labelled on the cap. */
export function Columns({ series, categories, height = 240, label }: { series: Series[]; categories: string[]; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = categories.length;
  const totals = categories.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const yMax = niceMax(Math.max(...totals, 1) * 1.08);
  const iw = Math.max(10, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const band = iw / Math.max(1, n);
  const bw = Math.min(24, band * 0.6);
  const y = (v: number) => M.top + ih - (v / yMax) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const labelAll = n <= 12;

  return (
    <div className="chart" ref={ref}>
      <Legend series={series} kind="rect" />
      <svg height={height} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {moneyShort(t)}
            </text>
          </g>
        ))}
        {categories.map((c, i) => {
          const cx = M.left + band * i + band / 2;
          let acc = 0;
          const top = series.reduce((k, s, j) => ((s.values[i] ?? 0) > 0 ? j : k), -1);
          return (
            <g key={c} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${c}: ${money(totals[i]!)}`}>
              <rect x={cx - band / 2} y={M.top} width={band} height={ih} fill="transparent" />
              {series.map((s, j) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                const h = Math.max(0, y0 - y1 - (j < top ? 2 : 0));
                return j === top ? (
                  <path key={s.id} d={barPath(cx - bw / 2, y1, bw, y0 - y1, 4)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                ) : (
                  <rect key={s.id} x={cx - bw / 2} y={y0 - h} width={bw} height={h} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                );
              })}
              {(labelAll || hover === i) && totals[i]! > 0 && (
                <text x={cx} y={y(totals[i]!) - 6} textAnchor="middle" style={{ fill: 'var(--ink-2)' }}>
                  {moneyShort(totals[i]!)}
                </text>
              )}
              <text x={cx} y={height - 8} textAnchor="middle">
                {c}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip x={M.left + band * hover + band / 2} y={M.top} width={width}>
          <div className="t-head">{categories[hover]}</div>
          <Rows series={series} i={hover} total={money(totals[hover]!)} />
        </Tooltip>
      )}
    </div>
  );
}

export function DataTable({ head, rows, caption }: { head: string[]; rows: Array<Array<string | number>>; caption: string }) {
  return (
    <table className="data-table">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r[0])}>
            {r.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i}>{typeof c === 'number' ? money(c) : c}</td>))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
