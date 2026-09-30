// ---------------------------------------------------------------------------
// timestampDirectivesPipeline.test.ts
// The timestamp directives that are simulated on documentation alone, driven
// through `runPipeline` from a props.conf stanza.
//
// timestampExtractor.test.ts asserts each of these against the extractor with
// hand-built directives. This file is the other half: it proves the directive
// written in a conf reaches the extractor through parsing, stanza resolution
// and the pipeline, which is where a wiring slip (a key read under the wrong
// name, a directive dropped when stanzas merge) would show. It is also what
// directiveEvidence.test.ts counts as the pipeline-level exercise of them.
//
// Doc-derived (props.conf.spec) throughout: no fidelity capture covers any of
// these directives, the corpus is closed, and the assertions are kept to what
// the spec states.
//   - DATETIME_CONFIG: CURRENT and NONE stand for the event's receipt time
//     instead of a timestamp read from the text.
//   - MAX_DAYS_AGO / MAX_DAYS_HENCE: a timestamp further than this many days
//     before / after the current time is not accepted.
//   - MAX_DIFF_SECS_AGO / MAX_DIFF_SECS_HENCE: a timestamp more than this many
//     seconds before / after the previous event's is accepted only in the same
//     exact format as the majority of the source's timestamps.
//   - TZ_ALIAS: remaps a timezone abbreviation read from the event text.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const NOW = Date.parse('2026-08-04T00:30:00Z');

/** One stanza, one line per event, the clock pinned. */
function times(raw: string, body: string): Array<string | undefined> {
  const { result } = runPipeline(raw, META, `[st]\nSHOULD_LINEMERGE = false\n${body}`, '', {
    perEventPipeline: false,
    captureOffsets: false,
    now: NOW,
  });
  return result.events.map((e) => e._time?.toISOString());
}

const FMT = 'TIME_FORMAT = %Y-%m-%d %H:%M:%S\n';
const CLOCK = new Date(NOW).toISOString();

describe('DATETIME_CONFIG through the pipeline', () => {
  const raw = '2024-01-15 10:00:00 has a perfectly good date';

  it('reads the timestamp from the text when unset', () => {
    expect(times(raw, FMT)).toEqual(['2024-01-15T10:00:00.000Z']);
  });

  it.each(['CURRENT', 'NONE'])('%s stamps the event with the current time instead', (value) => {
    expect(times(raw, `${FMT}DATETIME_CONFIG = ${value}\n`)).toEqual([CLOCK]);
  });
});

describe('MAX_DAYS_AGO / MAX_DAYS_HENCE through the pipeline', () => {
  it('accepts a timestamp 3 days back by default and rejects it under MAX_DAYS_AGO = 2', () => {
    const raw = '2026-08-01 00:30:00 x';
    expect(times(raw, FMT)).toEqual(['2026-08-01T00:30:00.000Z']);
    expect(times(raw, `${FMT}MAX_DAYS_AGO = 2\n`)).toEqual([CLOCK]);
  });

  it('rejects a timestamp 5 days ahead by default and accepts it under MAX_DAYS_HENCE = 10', () => {
    const raw = '2026-08-09 00:30:00 x';
    expect(times(raw, FMT)).toEqual([CLOCK]);
    expect(times(raw, `${FMT}MAX_DAYS_HENCE = 10\n`)).toEqual(['2026-08-09T00:30:00.000Z']);
  });
});

describe('MAX_DIFF_SECS_AGO / MAX_DIFF_SECS_HENCE through the pipeline', () => {
  // Under an explicit TIME_FORMAT every timestamp has the majority format, so
  // the spec's same-format exemption keeps a jump beyond the bound. What the
  // directive changes is which jumps are noted against it in the trace.
  const traceMentions = (raw: string, body: string, key: string): boolean => {
    const { result } = runPipeline(raw, META, `[st]\nSHOULD_LINEMERGE = false\n${body}`, '', {
      perEventPipeline: false,
      captureOffsets: false,
      now: NOW,
    });
    const step = result.events[1]?.processingTrace.find((t) => t.processor === 'timestampExtractor');
    return step?.description.includes(key) ?? false;
  };

  it('honours a jump backwards beyond MAX_DIFF_SECS_AGO because it is in the TIME_FORMAT', () => {
    const raw = '2026-08-03 10:00:00 first\n2026-08-03 08:00:00 two hours earlier';
    const body = `${FMT}MAX_DIFF_SECS_AGO = 3600\n`;
    expect(times(raw, body)).toEqual(['2026-08-03T10:00:00.000Z', '2026-08-03T08:00:00.000Z']);
    expect(traceMentions(raw, body, 'MAX_DIFF_SECS_AGO')).toBe(true);
    // The bound is the directive's: raised past the jump, it is no longer crossed.
    expect(traceMentions(raw, `${FMT}MAX_DIFF_SECS_AGO = 86400\n`, 'MAX_DIFF_SECS_AGO')).toBe(false);
  });

  it('honours a jump forwards beyond MAX_DIFF_SECS_HENCE because it is in the TIME_FORMAT', () => {
    const raw = '2026-08-01 10:00:00 first\n2026-08-04 00:00:00 three days later';
    const body = `${FMT}MAX_DIFF_SECS_HENCE = 3600\n`;
    expect(times(raw, body)).toEqual(['2026-08-01T10:00:00.000Z', '2026-08-04T00:00:00.000Z']);
    expect(traceMentions(raw, body, 'MAX_DIFF_SECS_HENCE')).toBe(true);
    expect(traceMentions(raw, `${FMT}MAX_DIFF_SECS_HENCE = 604800\n`, 'MAX_DIFF_SECS_HENCE')).toBe(false);
  });

  it('rejects a jump beyond MAX_DIFF_SECS_AGO in a minority format under auto-recognition', () => {
    // The second line's format is not the majority of those accepted so far,
    // so the earlier-than-allowed jump is refused and the previous event's
    // time is used.
    const raw = '2026-08-03T10:00:00 first\n08/03/2026 08:00:00 two hours earlier';
    expect(times(raw, 'MAX_DIFF_SECS_AGO = 3600\n')).toEqual(['2026-08-03T10:00:00.000Z', '2026-08-03T10:00:00.000Z']);
  });
});

describe('TZ_ALIAS through the pipeline', () => {
  const fmt = 'TIME_FORMAT = %Y-%m-%d %H:%M:%S %Z\n';
  const raw = '2024-01-15 10:00:00 EST x';

  it('resolves an aliased abbreviation to the offset the table names', () => {
    // The spec's own example: EST=GMT-5:00, so 10:00 EST is 15:00 UTC.
    expect(times(raw, `${fmt}TZ_ALIAS = EST=GMT-5:00,METT=GMT+1:00\n`)).toEqual(['2024-01-15T15:00:00.000Z']);
  });

  it('lets the alias win over the built-in reading of the abbreviation', () => {
    expect(times(raw, `${fmt}TZ_ALIAS = EST=GMT+10:00\n`)).toEqual(['2024-01-15T00:00:00.000Z']);
  });
});
