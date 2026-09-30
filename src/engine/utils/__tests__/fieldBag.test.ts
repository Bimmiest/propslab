import { describe, it, expect } from 'vitest';
import { hasField, setField, addFieldValue } from '../fieldBag';

describe('fieldBag', () => {
  it('hasField only reports own properties, not inherited ones', () => {
    const bag: Record<string, string> = { real: 'v' };
    expect(hasField(bag, 'real')).toBe(true);
    expect(hasField(bag, 'toString')).toBe(false);
    expect(hasField(bag, 'constructor')).toBe(false);
    expect(hasField(bag, '__proto__')).toBe(false);
  });

  it('setField writes prototype-named keys as own data properties', () => {
    const bag: Record<string, string> = {};
    setField(bag, 'toString', 'x');
    setField(bag, 'constructor', 'y');
    expect(hasField(bag, 'toString')).toBe(true);
    expect(bag['toString']).toBe('x');
    expect(bag['constructor']).toBe('y');
  });

  it('setField stores __proto__ without mutating the prototype chain', () => {
    const bag: Record<string, unknown> = {};
    setField(bag, '__proto__', 'pwned');
    expect(hasField(bag, '__proto__')).toBe(true);
    expect(bag['__proto__']).toBe('pwned');
    expect(Object.getPrototypeOf(bag)).toBe(Object.prototype);
    // A pristine object is unaffected — no global prototype pollution.
    expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
  });

  it('addFieldValue promotes repeated keys to a multivalue array', () => {
    const bag: Record<string, string | string[]> = {};
    expect(addFieldValue(bag, 'k', 'a')).toBe(true); // newly added
    expect(addFieldValue(bag, 'k', 'b')).toBe(false); // appended
    expect(addFieldValue(bag, 'k', 'c')).toBe(false);
    expect(bag['k']).toEqual(['a', 'b', 'c']);
  });

  it('addFieldValue treats a prototype-named key as an ordinary field', () => {
    const bag: Record<string, string | string[]> = {};
    expect(addFieldValue(bag, 'valueOf', '1')).toBe(true);
    expect(addFieldValue(bag, 'valueOf', '2')).toBe(false);
    expect(bag['valueOf']).toEqual(['1', '2']);
  });
});

describe('addFieldValue — never mutates a caller-shared array (#63)', () => {
  it('replaces the array instead of pushing into it', () => {
    const shared = ['one'];
    const source = { f: shared };
    const copy: Record<string, string | string[]> = { ...source };

    addFieldValue(copy, 'f', 'two');

    expect(copy['f']).toEqual(['one', 'two']);
    // The shallow copy shares the array with `source`; pushing would have
    // rewritten the original event's field from a pure processor.
    expect(shared).toEqual(['one']);
    expect(source.f).toEqual(['one']);
  });

  it('promotes a scalar to a two-value array', () => {
    const fields: Record<string, string | string[]> = { f: 'one' };
    expect(addFieldValue(fields, 'f', 'two')).toBe(false);
    expect(fields['f']).toEqual(['one', 'two']);
  });

  it('reports true only when the field is newly created', () => {
    const fields: Record<string, string | string[]> = {};
    expect(addFieldValue(fields, 'f', 'one')).toBe(true);
    expect(fields['f']).toBe('one');
  });
});
