const whole = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

export const money = (v: number) => whole.format(Math.round(v)).replace('A$', '$');

/** $950, $12.5k, $1.25M — for axes and tight spaces. */
export function moneyShort(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (a >= 10_000) return `${sign}$${Math.round(a / 1000)}k`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${sign}$${Math.round(a)}`;
}

export const pct = (r: number, dp = 2) => `${(r * 100).toFixed(dp)}%`;

export const signedPct = (r: number, dp = 2) => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(dp)}%`;

export function termLabel(months: number): string {
  if (months % 12 === 0 && months >= 12) return months === 12 ? '1 year' : `${months / 12} years`;
  return `${months} months`;
}

export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Parse what someone typed into a money field: "$150,000", "150k", "1.2m". */
export function parseMoney(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[$,\s]/g, '');
  const m = /^(\d*\.?\d+)([km])?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1);
  return Number.isFinite(n) ? n : null;
}

/** Product name without a repeated brand prefix: "Virgin Money Boost Saver" at Virgin Money Australia reads "Boost Saver". */
export function shortName(brand: string, name: string): string {
  const b = brand.toLowerCase().split(/\s+/);
  const words = name.trim().split(/\s+/);
  let k = 0;
  while (k < words.length - 1 && k < b.length && words[k]!.toLowerCase() === b[k]) k++;
  return k > 0 ? words.slice(k).join(' ') : name.trim();
}
