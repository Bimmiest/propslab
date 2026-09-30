// ---------------------------------------------------------------------------
// noOps.integration.test.ts
// The no-op explanations as a caller sees them, through runPipeline.
//
// The unit tests cover the reasoning; these cover the wiring, which is where
// this feature actually fails — a processor that computes a reason and drops it
// on the floor looks exactly like a directive that fired.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import { regexCompileCount } from '../../utils/splunkRegex';
import type { EventMetadata, DirectiveNoOp } from '../types';

const metadata: EventMetadata = {
  index: 'main',
  host: 'web01',
  source: '/var/log/app.log',
  sourcetype: 'my_app',
};

function noOpsFor(raw: string, props: string, transforms = ''): DirectiveNoOp[] {
  const result = runPipeline(raw, metadata, props, transforms, {
    perEventPipeline: false,
    captureOffsets: false,
  });
  return result.result.events.flatMap((e) => e.noOps ?? []);
}

const RAW = '2024-01-15 10:00:00 user=alice action=login\n';

describe('#84 — no-op explanations reach the caller', () => {
  it('says nothing when every directive fired', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nEXTRACT-user = user=(?<user>\\w+)\n');
    expect(noOps).toEqual([]);
  });

  it('explains an EXTRACT whose pattern did not match, with where it stopped', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nEXTRACT-email = user=(?<user>\\w+)@(?<domain>\\w+)\n');
    expect(noOps).toHaveLength(1);
    expect(noOps[0]?.directive).toBe('EXTRACT-email');
    expect(noOps[0]?.reason.kind).toBe('no-match');
    // It agrees as far as `user=alice`, then wants an `@` and finds a space.
    expect(noOps[0]?.reason).toMatchObject({ partialEnd: '2024-01-15 10:00:00 user=alice'.length });
  });

  it('locates the no-op on the line the directive is written on', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nSHOULD_LINEMERGE = false\nEXTRACT-x = ZZZ(?<a>\\d+)\n');
    expect(noOps[0]?.line).toBe(3);
    expect(noOps[0]?.file).toBe('props.conf');
  });

  it('explains an EXTRACT reading a source field the event does not have', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nEXTRACT-x = (?<a>\\w+) in missing_field\n');
    expect(noOps[0]?.reason).toEqual({ kind: 'source-key-empty', sourceKey: 'missing_field' });
  });

  it('explains a TRANSFORMS pointing at a stanza that is not defined', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nTRANSFORMS-mask = no_such_stanza\n');
    expect(noOps[0]?.reason).toEqual({ kind: 'transforms-stanza-missing', name: 'no_such_stanza' });
    expect(noOps[0]?.directive).toContain('no_such_stanza');
  });

  it('explains a transform whose REGEX did not match', () => {
    const noOps = noOpsFor(
      RAW,
      '[my_app]\nTRANSFORMS-mask = maskit\n',
      '[maskit]\nREGEX = password=(\\w+)\nFORMAT = password=REDACTED\nDEST_KEY = _raw\n',
    );
    expect(noOps[0]?.reason.kind).toBe('no-match');
  });

  it('explains a SEDCMD that left _raw untouched', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nSEDCMD-mask = s/password=\\w+/password=X/g\n');
    expect(noOps).toHaveLength(1);
    expect(noOps[0]?.directive).toBe('SEDCMD-mask');
    expect(noOps[0]?.reason.kind).toBe('no-match');
    expect(noOps[0]?.phase).toBe('index-time');
  });

  it('says nothing about a SEDCMD that did rewrite the event', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nSEDCMD-mask = s/alice/REDACTED/g\n');
    expect(noOps).toEqual([]);
  });

  it('explains a FIELDALIAS whose source field is absent', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nFIELDALIAS-cim = nonexistent AS dvc\n');
    expect(noOps[0]?.reason).toEqual({ kind: 'source-key-empty', sourceKey: 'nonexistent' });
  });

  it('explains an EVAL that computed null', () => {
    // len() of an absent field propagates null, so no field is written.
    const noOps = noOpsFor(RAW, '[my_app]\nEVAL-ulen = len(missing_field)\n');
    expect(noOps[0]?.directive).toBe('EVAL-ulen');
    expect(noOps[0]?.reason).toMatchObject({ kind: 'eval-null', expression: 'len(missing_field)' });
  });

  it('says nothing about an EVAL that produced a value', () => {
    const noOps = noOpsFor(RAW, '[my_app]\nEXTRACT-user = user=(?<user>\\w+)\nEVAL-ulen = len(user)\n');
    expect(noOps).toEqual([]);
  });

  it('reports each failing directive separately rather than merging them', () => {
    const noOps = noOpsFor(
      RAW,
      '[my_app]\nEXTRACT-a = AAA(?<a>\\d+)\nEXTRACT-b = BBB(?<b>\\d+)\nSEDCMD-c = s/zzz/x/g\n',
    );
    expect(noOps.map((n) => n.directive).sort()).toEqual(['EXTRACT-a', 'EXTRACT-b', 'SEDCMD-c']);
  });

  it('keeps no-ops out of the processing trace', () => {
    // processingTrace means "work that happened", and the Pipeline tab counts
    // its length — a no-op there would inflate both.
    const { result } = runPipeline(RAW, metadata, '[my_app]\nEXTRACT-x = ZZZ(?<a>\\d+)\n', '', {
      perEventPipeline: false,
      captureOffsets: false,
    });
    const event = result.events[0]!;
    expect(event.noOps).toHaveLength(1);
    expect(event.processingTrace.some((s) => s.processor.startsWith('EXTRACT'))).toBe(false);
  });
});

describe('#415 — explaining no-ops stays cheap at volume', () => {
  it('runs 500 events past 16 mostly non-matching EXTRACTs without recompiling', () => {
    // Each explanation probes one truncated pattern per atom. Through the
    // pipeline's own 256-entry cache those probes evicted the EXTRACTs
    // themselves, and this took about 17 s.
    const ids = ['106023', '302013', '302014', '305011', '106100', '313001', '710003', '419002'];
    const raw = Array.from(
      { length: 500 },
      (_, i) =>
        `Jan 15 10:00:${String(i % 60).padStart(2, '0')} fw01 %ASA-6-${ids[i % ids.length]}: ` +
        `Deny tcp src outside:10.0.${i % 256}.${i % 200}/${1024 + i} dst inside:192.168.1.${i % 250}/443 ` +
        `by access-group "outside_in" [0x0, 0x0]`,
    ).join('\n');
    const extracts = Array.from(
      { length: 16 },
      (_, n) =>
        `EXTRACT-asa${n} = %ASA-\\d-${900000 + n}: (?<action${n}>\\w+) (?<proto${n}>\\w+) src ` +
        `(?<szone${n}>\\w+):(?<src${n}>[\\d.]+)/(?<sport${n}>\\d+) dst (?<dzone${n}>\\w+):(?<dst${n}>[\\d.]+)/(?<dport${n}>\\d+)`,
    ).join('\n');
    const props = `[my_app]\nSHOULD_LINEMERGE = false\nLINE_BREAKER = ([\\r\\n]+)\n${extracts}\n`;

    const before = regexCompileCount();
    const { result } = runPipeline(raw, metadata, props, '', { perEventPipeline: false, captureOffsets: false });
    const compiles = regexCompileCount() - before;

    expect(result.events).toHaveLength(500);
    expect(result.events[0]?.noOps).toHaveLength(16);
    // Compiles, not wall time: under coverage on a loaded runner a 1 s run
    // took 10 s. Thrashing recompiled the config for every event: about 200,000
    // compiles for these 500 events; a working cache compiles each pattern and probe
    // about once.
    expect(compiles).toBeLessThan(2000);
    // The pipeline itself takes seconds under coverage instrumentation.
  }, 30_000);
});

describe('#452 — explanations are capped per directive per run', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `user=u${i} action=login`).join('\n');
  const LIMIT = 50;

  function kindsFor(directive: string, props: string, transforms: string, perEventPipeline: boolean) {
    const { result } = runPipeline(lines(LIMIT + 10), metadata, props, transforms, {
      perEventPipeline,
      captureOffsets: false,
    });
    return result.events.map((e) => e.noOps?.find((n) => n.directive === directive)?.reason.kind);
  }

  const cases: [string, string, string][] = [
    ['EXTRACT-email', '[my_app]\nSHOULD_LINEMERGE = false\nEXTRACT-email = user=(?<user>\\w+)@\n', ''],
    ['SEDCMD-mask', '[my_app]\nSHOULD_LINEMERGE = false\nSEDCMD-mask = s/password=\\S+/password=xxx/g\n', ''],
    [
      'TRANSFORMS-t → [route]',
      '[my_app]\nSHOULD_LINEMERGE = false\nTRANSFORMS-t = route\n',
      '[route]\nREGEX = ^DEBUG\nDEST_KEY = queue\nFORMAT = nullQueue\n',
    ],
    [
      'REPORT-r → [pairs]',
      '[my_app]\nSHOULD_LINEMERGE = false\nREPORT-r = pairs\n',
      '[pairs]\nREGEX = (\\w+):(\\d+)\nFORMAT = $1::$2\n',
    ],
  ];

  for (const perEventPipeline of [false, true]) {
    it.each(cases)(
      `analyses the first ${LIMIT} misses of %s, then says it stopped (perEvent=${perEventPipeline})`,
      (directive, props, transforms) => {
        const kinds = kindsFor(directive, props, transforms, perEventPipeline);
        expect(kinds.slice(0, LIMIT).every((k) => k === 'no-match')).toBe(true);
        expect(kinds.slice(LIMIT)).toEqual(Array(10).fill('not-explained'));
      },
    );
  }

  it('counts each directive apart', () => {
    const props = '[my_app]\nSHOULD_LINEMERGE = false\nEXTRACT-a = user=(?<a>\\w+)@\nEXTRACT-b = user=(?<b>\\w+)#\n';
    const { result } = runPipeline(lines(LIMIT), metadata, props, '', { perEventPipeline: false });
    const kinds = result.events.flatMap((e) => (e.noOps ?? []).map((n) => n.reason.kind));
    expect(kinds).toHaveLength(2 * LIMIT);
    expect(kinds.every((k) => k === 'no-match')).toBe(true);
  });
});
