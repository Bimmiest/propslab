import { afterEach, describe, it, expect, vi } from 'vitest';
import { orExit } from './orExit.mjs';

// The read-or-exit step of the scripts in scripts/ (#865).
describe('orExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns what the read returns', () => {
    expect(orExit(() => 42, 'not used')).toBe(42);
  });

  it('prints the message and exits 1 when the read throws', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    orExit(() => {
      throw new Error('ENOENT');
    }, 'No build output at dist/assets — run `npm run build` first.');
    expect(error).toHaveBeenCalledWith('No build output at dist/assets — run `npm run build` first.');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
