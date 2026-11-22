import { describe, expect, it } from 'vitest';
import { balanceToPos, posToBalance } from '../src/components/fields';
import { moneyShort, parseMoney, shortName } from '../src/format';
import { startDate, suggestDeposits } from '../src/model';
import type { CatalogueProduct } from '@asc/engine';

describe('format', () => {
  it('reads money the way people type it', () => {
    expect(parseMoney('$150,000')).toBe(150_000);
    expect(parseMoney('150k')).toBe(150_000);
    expect(parseMoney('1.2m')).toBe(1_200_000);
    expect(parseMoney('abc')).toBeNull();
  });

  it('shortens axis labels', () => {
    expect([moneyShort(950), moneyShort(1500), moneyShort(25_000), moneyShort(1_250_000)]).toEqual(['$950', '$1.5k', '$25k', '$1.25M']);
  });

  it('drops a brand name repeated in the product name', () => {
    expect(shortName('Virgin Money Australia', 'Virgin Money Boost Saver')).toBe('Boost Saver');
    expect(shortName('Up', 'Up Saver')).toBe('Saver');
    expect(shortName('ING', 'Savings Maximiser')).toBe('Savings Maximiser');
    expect(shortName('Up', 'Up')).toBe('Up');
  });
});

describe('balance slider', () => {
  it('round-trips on a log scale with tidy steps', () => {
    expect(posToBalance(0)).toBe(1000);
    expect(posToBalance(1000)).toBe(2_000_000);
    for (const v of [5000, 150_000, 600_000]) expect(Math.abs(posToBalance(balanceToPos(v)) - v) / v).toBeLessThan(0.02);
  });
});

describe('model', () => {
  it('starts simulations on the first of next month', () => {
    expect(startDate(new Date(2026, 10, 22))).toBe('2026-12-01');
    expect(startDate(new Date(2026, 11, 5))).toBe('2027-01-01');
  });

  it('gives each bonus account its deposit and the first account the rest', () => {
    const byKey = new Map([
      ['a', { key: 'a' } as CatalogueProduct],
      ['b', { key: 'b' } as CatalogueProduct],
      ['t', { key: 't' } as CatalogueProduct],
    ]);
    const need = (p: CatalogueProduct) => (p.key === 'b' ? 1000 : 0);
    const accounts = [
      { key: 'a', termMonths: null },
      { key: 'b', termMonths: null },
      { key: 't', termMonths: 12 },
    ];
    expect(suggestDeposits(accounts, byKey, 2500, need)).toEqual([1500, 1000, 0]);
    expect(suggestDeposits(accounts, byKey, 500, need)).toEqual([500, 0, 0]);
  });
});

describe('held accounts and calendar', () => {
  it('works out how far into a term a held deposit is', async () => {
    const { heldTdElapsed, heldAge, monthsBetween } = await import('../src/model');
    const td = { id: 't', key: 'k', custom: null, amount: 1, deposit: 0, termMonths: 12, opened: null, tdRate: 0.05, maturity: '2027-03', slot: 0 };
    expect(monthsBetween('2026-12-01', '2027-03')).toBe(3);
    expect(heldTdElapsed(td, '2026-12-01')).toBe(9);
    expect(heldAge({ ...td, termMonths: null, opened: '2026-10' }, '2026-12-01')).toBe(2);
    expect(heldAge({ ...td, termMonths: null, opened: null }, '2026-12-01')).toBe(999);
  });

  it('writes a valid, folded iCalendar file', async () => {
    const { buildIcs } = await import('../src/calendar');
    const ics = buildIcs(
      [{ uid: 'x', date: '2026-12-20', monthly: true, summary: 'Savings bonus check', description: `ING Savings Maximiser:\n- Deposit at least $1,000; ${'long '.repeat(30)}` }],
      new Date('2026-11-22T00:00:00Z'),
    );
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('DTSTART;VALUE=DATE:20261220');
    expect(lines).toContain('RRULE:FREQ=MONTHLY');
    expect(ics.replace(/\r\n /g, '')).toContain(String.raw`Deposit at least $1\,000\;`);
    expect(lines.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});
