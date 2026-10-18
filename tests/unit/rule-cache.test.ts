import { describe, expect, it } from 'vitest';
import { RuleCache } from '../../packages/core/src/rule-cache.js';

const rules = (count: number, offset = 0) => ({
  rules: Array.from({ length: count }, (_, i) => ({
    x1: offset + i,
    y1: 10.5,
    x2: offset + i + 100,
    y2: 10.5,
    width: 0.25,
  })),
  truncated: false,
});

describe('RuleCache', () => {
  it('round-trips rules and the truncated flag exactly', () => {
    const cache = new RuleCache(100);
    cache.set(3, { ...rules(4), truncated: true });
    expect(cache.get(3)).toEqual({ ...rules(4), truncated: true });
    expect(cache.get(4)).toBeUndefined();
    expect(cache.cachedLines).toBe(4);
  });
  it('evicts the pages cached first when the budget is exceeded', () => {
    // Room for 10 lines.
    const cache = new RuleCache(10);
    cache.set(0, rules(4));
    cache.set(1, rules(4, 1000));
    cache.set(2, rules(4, 2000));
    expect(cache.get(0)).toBeUndefined();
    expect(cache.get(1)).toEqual(rules(4, 1000));
    expect(cache.get(2)).toEqual(rules(4, 2000));
    expect(cache.cachedLines).toBe(8);
    // Replacing a page releases its old entry first; a page above the budget is not cached.
    cache.set(2, rules(1));
    expect(cache.cachedLines).toBe(5);
    cache.set(5, rules(11));
    expect(cache.get(5)).toBeUndefined();
    cache.clear();
    expect(cache.cachedLines).toBe(0);
  });
});
