import { describe, it, expect } from 'vitest';
import { createCollector, createRunContext, DEFAULT_LIMITS, replayContext, withDiagnostics } from '../runContext';
import type { ValidationDiagnostic } from '../types';

const warn = (message: string, line?: number): ValidationDiagnostic => ({
  level: 'warning',
  message,
  file: 'props.conf',
  ...(line !== undefined ? { line } : {}),
});

describe('DiagnosticsCollector', () => {
  it('appends to the sink it was given, in order', () => {
    const sink: ValidationDiagnostic[] = [];
    const c = createCollector(sink);
    c.push(warn('a'), warn('b'));
    c.push(warn('a'));
    expect(sink.map((d) => d.message)).toEqual(['a', 'b', 'a']);
    expect(c.list).toBe(sink);
  });

  it('reports a key once per run', () => {
    const c = createCollector();
    expect(c.once('k')).toBe(true);
    expect(c.once('k')).toBe(false);
    c.report('r', warn('first'));
    c.report('r', warn('second'));
    expect(c.list.map((d) => d.message)).toEqual(['first']);
  });

  it('drops visible duplicates through a deduplicating view, which shares the ledger', () => {
    const c = createCollector();
    c.push(warn('before'));
    const view = c.deduplicating();
    view.push(warn('x', 1), warn('x', 1), warn('x', 2));
    // Not seeded, so the view does not know about what the parent holds.
    view.push(warn('before'));
    expect(c.list.map((d) => `${d.message}${d.line ?? ''}`)).toEqual(['before', 'x1', 'x2', 'before']);

    expect(view.once('shared')).toBe(true);
    expect(c.once('shared')).toBe(false);
  });

  it('seeds a deduplicating view with diagnostics already reported', () => {
    const c = createCollector();
    c.push(warn('seen'));
    c.deduplicating(c.list).push(warn('seen'), warn('new'));
    expect(c.list.map((d) => d.message)).toEqual(['seen', 'new']);
  });
});

describe('createRunContext', () => {
  it('is frozen and carries the defaults', () => {
    const ctx = createRunContext({ now: 5 });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.now).toBe(5);
    expect(ctx.captureOffsets).toBe(true);
    expect(ctx.limits).toEqual(DEFAULT_LIMITS);
  });

  it('overrides only the limits it is given', () => {
    const ctx = createRunContext({ now: 0, limits: { maxRawChars: 10 } });
    expect(ctx.limits.maxRawChars).toBe(10);
  });

  it('swaps the collector and keeps everything else', () => {
    const ctx = createRunContext({ now: 7, captureOffsets: false });
    const other = createCollector();
    const swapped = withDiagnostics(ctx, other);
    expect(swapped.diagnostics).toBe(other);
    expect(swapped.now).toBe(7);
    expect(swapped.captureOffsets).toBe(false);
  });

  it('replays on the same clock, reporting nowhere', () => {
    const sink: ValidationDiagnostic[] = [];
    const ctx = createRunContext({ now: 9, diagnostics: sink });
    const replay = replayContext(ctx);
    replay.diagnostics.push(warn('dropped'));
    expect(sink).toEqual([]);
    expect(replay.now).toBe(9);
    expect(replay.captureOffsets).toBe(false);
  });
});
