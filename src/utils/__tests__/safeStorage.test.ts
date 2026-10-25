// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { safeStorage } from '../safeStorage';

const unavailable = () => {
  throw new DOMException('denied', 'SecurityError');
};

describe('safeStorage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('reads and writes localStorage', () => {
    expect(safeStorage.get('k')).toBeNull();
    safeStorage.set('k', 'v');
    expect(localStorage.getItem('k')).toBe('v');
    expect(safeStorage.get('k', 'fallback')).toBe('v');
  });

  it('answers onError, null by default, when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(unavailable);
    expect(safeStorage.get('k')).toBeNull();
    expect(safeStorage.get('k', 'true')).toBe('true');
  });

  it('does nothing when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(unavailable);
    expect(() => safeStorage.set('k', 'v')).not.toThrow();
  });
});
