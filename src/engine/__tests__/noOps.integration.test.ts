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
