import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ValidationDiagnostic } from '../../../../src/engine/types';
import type { ExplainResponse, ExplainStanza } from '../protocol';
import {
  boundExplain,
  boundValidate,
  elementBytes,
  MAX_PAYLOAD_BYTES,
  responseBytes,
} from '../responseBudget';
import { exitOnStdoutError } from '../server';

// The budget counts both copies of a payload in UTF-8 (#414): the object as
// structuredContent, and its compact JSON again as an escaped string.
const wire = (payload: unknown) => {
  const text = JSON.stringify(payload);
  return Buffer.byteLength(JSON.stringify(text)) + Buffer.byteLength(text);
};

// ASCII, quote/backslash-heavy (escaped twice), CJK (3 bytes), astral (4).
const UNITS = ['a', '"\\', '日本語', '😀'];

describe('responseBytes', () => {
  it('is exactly the bytes of both copies', () => {
    for (const unit of UNITS) {
      const payload = { s: unit.repeat(1000), n: [1, null, { k: `${unit}\n\t` }] };
      expect(responseBytes(payload)).toBe(wire(payload));
    }
  });

  it('prices an array element at what it adds to the whole', () => {
    const items = UNITS.map((u) => ({ v: u.repeat(10) }));
    const whole = responseBytes({ items });
    const empty = responseBytes({ items: [] });
    // Each element pays for a comma it only has when it is not the last.
    expect(items.reduce((n, i) => n + elementBytes(i), 0) - 2).toBe(whole - empty);
  });
});

describe('boundValidate', () => {
  it('cuts diagnostics to the budget in bytes, whatever the characters', () => {
    for (const unit of UNITS) {
      const diagnostics: ValidationDiagnostic[] = Array.from({ length: 20_000 }, (_, i) => ({
        level: 'error',
        message: `${i} ${unit.repeat(200)}`,
        file: 'props.conf',
        line: i,
      }));
      const out = boundValidate(diagnostics);
      expect(wire(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(out.diagnostics.length).toBeLessThan(20_000);
      expect(out.diagnosticCount).toBe(20_000);
      expect(out.truncationNote).toMatch(new RegExp(`first ${out.diagnostics.length} of 20000`));
      // It fills the budget rather than stopping short.
      expect(wire(out) + elementBytes(diagnostics[out.diagnostics.length])).toBeGreaterThan(
        MAX_PAYLOAD_BYTES - 1024,
      );
    }
  });

  it('adds nothing when nothing was cut', () => {
    const diagnostics: ValidationDiagnostic[] = [{ level: 'warning', message: 'm', file: 'raw' }];
    expect(boundValidate(diagnostics)).toEqual({ diagnostics });
  });
});

describe('boundExplain', () => {
  const directive = (i: number, unit: string) => ({ key: `k${i}`, value: unit.repeat(50), line: i });
  const stanza = (name: string, n: number, unit: string): ExplainStanza => ({
    name,
    type: 'sourcetype',
    lineRange: { start: 1, end: n },
    directives: Array.from({ length: n }, (_, i) => directive(i, unit)),
  });
  const metadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

  it('cuts one huge stanza part-way, with its directive count', () => {
    for (const unit of UNITS) {
      const full: ExplainResponse = { parseErrors: [], stanzas: [stanza('st', 100_000, unit)] };
      const out = boundExplain(full);
      expect(wire(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(out.stanzas).toHaveLength(1);
      expect(out.stanzas[0]?.directives.length).toBeLessThan(100_000);
      expect(out.stanzas[0]?.directiveCount).toBe(100_000);
      expect(out).not.toHaveProperty('stanzaCount');
      expect(out.truncationNote).toMatch(/directiveCount/);
    }
  });

  it('cuts stanzas, parse errors and the resolution, each with its count', () => {
    for (const unit of UNITS) {
      const stanzas = Array.from({ length: 20_000 }, (_, i) => stanza(`s${i}`, 2, unit));
      const effective = Array.from({ length: 50_000 }, (_, i) => ({
        ...directive(i, unit),
        stanza: 'st',
      }));
      const full: ExplainResponse = {
        parseErrors: Array.from({ length: 50_000 }, (_, i) => ({
          level: 'error' as const,
          message: `${i} ${unit.repeat(50)}`,
          file: 'props.conf' as const,
        })),
        stanzas,
        resolution: {
          metadata,
          effectiveMetadata: metadata,
          matchedStanzas: stanzas.map((s) => ({ name: s.name, type: s.type })),
          effectiveDirectives: effective,
        },
      };
      const out = boundExplain(full);
      expect(wire(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(out.parseErrorCount).toBe(50_000);
      expect(out.stanzaCount).toBe(20_000);
      expect(out.resolution?.effectiveDirectiveCount).toBe(50_000);
      expect(out.parseErrors.length).toBeGreaterThan(0);
      expect(out.stanzas.length).toBeGreaterThan(0);
      expect(out.resolution?.effectiveDirectives.length).toBeGreaterThan(0);
      // No stanza is returned with none of its directives.
      expect(out.stanzas.every((s) => s.directives.length > 0)).toBe(true);
    }
  });

  it('adds nothing when nothing was cut', () => {
    const full: ExplainResponse = { parseErrors: [], stanzas: [stanza('st', 3, 'a')] };
    expect(boundExplain(full)).toEqual(full);
  });
});

describe('exitOnStdoutError', () => {
  it('logs and exits instead of throwing on a failed stdout write', () => {
    const stdout = new PassThrough();
    const exit = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitOnStdoutError(stdout, exit);
    stdout.emit('error', Object.assign(new Error('write ENOBUFS'), { code: 'ENOBUFS' }));
    expect(exit).toHaveBeenCalledWith(1);
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(exit).toHaveBeenLastCalledWith(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ENOBUFS/));
    log.mockRestore();
  });
});
