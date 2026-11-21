import { describe, expect, it } from 'vitest';
import { fcsExposure, FCS_LIMIT } from '../src/catalogue.js';

describe('fcsExposure', () => {
  it('adds sole balances and equal shares of joint balances per person per institution', () => {
    const out = fcsExposure([
      { group: 'abn:1', balance: 300_000, owners: { p1: 0.5, p2: 0.5 } },
      { group: 'abn:1', balance: 120_000, owners: { p1: 1 } },
      { group: 'abn:2', balance: 400_000, owners: { p1: 0.5, p2: 0.5 } },
    ]);
    expect(out).toEqual([
      { group: 'abn:1', person: 'p1', amount: 270_000, limit: FCS_LIMIT, uncovered: 20_000 },
      { group: 'abn:1', person: 'p2', amount: 150_000, limit: FCS_LIMIT, uncovered: 0 },
      { group: 'abn:2', person: 'p1', amount: 200_000, limit: FCS_LIMIT, uncovered: 0 },
      { group: 'abn:2', person: 'p2', amount: 200_000, limit: FCS_LIMIT, uncovered: 0 },
    ]);
  });

  it('splits joint accounts equally even when ownership shares are uneven', () => {
    const [a, b] = fcsExposure([{ group: 'g', balance: 600_000, owners: { p1: 0.8, p2: 0.2 } }]);
    expect(a!.amount).toBe(300_000);
    expect(b!.amount).toBe(300_000);
    expect(a!.uncovered + b!.uncovered).toBe(100_000);
  });

  it('ignores empty holdings', () => {
    expect(fcsExposure([{ group: 'g', balance: 0, owners: { p1: 1 } }])).toEqual([]);
  });
});
