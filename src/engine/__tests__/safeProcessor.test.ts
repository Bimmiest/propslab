// ---------------------------------------------------------------------------
// safeProcessor catches per event (#452): a stage that throws on one event is
// re-run one event at a time, so only that event misses the stage. A stage
// that reads across events falls back as a whole, as before.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

// Pass-through, except that a batch holding an event with "boom" in it throws,
// after reporting a config-level warning the way a real stage would.
vi.mock('../processors/fieldAlias', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processors/fieldAlias')>();
  return {
    ...actual,
    applyFieldAliases: (...args: Parameters<typeof actual.applyFieldAliases>) => {
      const [events, , ctx] = args;
      ctx.diagnostics.push({ level: 'warning', message: 'config warning', file: 'props.conf' });
      if (events.some((e) => e._raw.includes('boom'))) throw new Error('alias boom');
      return actual.applyFieldAliases(...args);
    },
  };
});

vi.mock('../processors/timestampExtractor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processors/timestampExtractor')>();
  return {
    ...actual,
    extractTimestamps: (...args: Parameters<typeof actual.extractTimestamps>) => {
      if (args[0].some((e) => e._raw.includes('tsfail'))) throw new Error('timestamp boom');
      return actual.extractTimestamps(...args);
    },
  };
});

const metadata: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const props = '[st]\nSHOULD_LINEMERGE = false\nEXTRACT-u = user=(?<user>\\w+)\nFIELDALIAS-a = user AS account\n';

function run(raw: string, perEventPipeline = false) {
  const { result, diagnostics } = runPipeline(raw, metadata, props, '', { perEventPipeline, now: 0 });
  return { events: result.events, diagnostics };
}

describe('safeProcessor', () => {
  it('keeps a per-event stage for every event but the one that throws', () => {
    const { events, diagnostics } = run('user=a\nuser=b boom\nuser=c');
    expect(events.map((e) => e.fields['account'])).toEqual(['a', undefined, 'c']);
    // The failing event still has what earlier stages gave it.
    expect(events[1]!.fields['user']).toBe('b');

    const errors = diagnostics.filter((d) => d.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'raw', line: 2 });
    expect(errors[0]!.message).toBe(
      'Processor "FIELDALIAS" failed on 1 event, which passes through it unchanged (alias boom).',
    );
  });

  it('does not repeat what the failed attempt already reported', () => {
    const { diagnostics } = run('user=a\nuser=b boom\nuser=c');
    expect(diagnostics.filter((d) => d.message === 'config warning')).toHaveLength(1);
  });

  it('counts every event that still throws', () => {
    const { diagnostics } = run('user=a boom\nuser=b boom\nuser=c');
    const errors = diagnostics.filter((d) => d.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'raw', line: 1 });
    expect(errors[0]!.message).toContain('failed on 2 events, which pass through it unchanged');
  });

  it('reports a one-event failure as before in per-event mode', () => {
    const { events, diagnostics } = run('user=a\nuser=b boom', true);
    expect(events.map((e) => e.fields['account'])).toEqual(['a', undefined]);
    const errors = diagnostics.filter((d) => d.level === 'error');
    expect(errors).toEqual([{ level: 'error', message: 'Processor "FIELDALIAS" failed: alias boom', file: 'props.conf' }]);
  });

  it('falls back as a whole for a batch stage', () => {
    // Timestamp extraction reads the previous event's _time, so it is not
    // retried one event at a time: every event keeps the _time it had (none).
    const { events, diagnostics } = run('2024-01-01 00:00:00 user=a\ntsfail user=b');
    expect(events.map((e) => e._time)).toEqual([null, null]);
    const errors = diagnostics.filter((d) => d.level === 'error');
    expect(errors).toEqual([{ level: 'error', message: 'Processor "Timestamp" failed: timestamp boom', file: 'props.conf' }]);
  });
});
