import { describe, it, expect, vi } from 'vitest';
import { fcSeed } from './fcSeed';

describe('fcSeed', () => {
  it('returns the default when FC_SEED is unset', () => {
    vi.stubEnv('FC_SEED', undefined);
    expect(fcSeed(513)).toBe(513);
  });

  it('returns FC_SEED when it is an integer, negative included', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('FC_SEED', '1234');
    expect(fcSeed(513)).toBe(1234);
    // fast-check prints negative seeds too, and a replay passes them back.
    vi.stubEnv('FC_SEED', '-1819918769');
    expect(fcSeed(513)).toBe(-1819918769);
  });

  it.each(['', ' ', '1.5', '12abc', '0x10', '1e3', 'not a number', '99999999999999999999'])(
    'throws for FC_SEED=%j rather than running a seed nobody chose',
    (raw) => {
      vi.stubEnv('FC_SEED', raw);
      expect(() => fcSeed(513)).toThrow(`FC_SEED must be an integer, got ${JSON.stringify(raw)}`);
    },
  );
});
