import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { ProcessingStep } from '../types';

const meta = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

const props = (...lines: string[]) => ['[st]', ...lines].join('\n');

function stepFor(
  raw: string,
  propsConf: string,
  match: (s: ProcessingStep) => boolean,
  transformsConf = '',
): ProcessingStep {
  const { result } = runPipeline(raw, meta, propsConf, transformsConf);
  const step = result.events[0]!.processingTrace.find(match);
  if (!step) throw new Error('expected step not found in trace');
  return step;
}

const sedStep = (raw: string, propsConf: string) =>
  stepFor(raw, propsConf, (s) => s.processor.startsWith('SEDCMD'));

describe('SEDCMD field attribution', () => {
  it('names exactly the masked field when several are extracted', () => {
    const step = sedStep(
      'user=alice ssn=123-45-6789 action=login',
      props(
        'SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/g',
        'EXTRACT-ssn = ssn=(?<ssn>\\S+)',
        'EXTRACT-user = user=(?<user>\\S+)',
      ),
    );

    expect(step.fieldsModified).toEqual(['ssn']);
    expect(step.fieldsRemoved).toEqual([]);
  });

  it('reports an empty list when the substitution hits no extracted field', () => {
    // "connection refused" is free text — no extraction anchors on it.
    const step = sedStep(
      'connection refused user=alice',
      props('SEDCMD-mask = s/refused/denied/', 'EXTRACT-user = user=(?<user>\\S+)'),
    );

    expect(step.fieldsModified).toEqual([]);
    expect(step.fieldsRemoved).toEqual([]);
  });

  it('attributes a substitution beyond the old 200-character snapshot window', () => {
    const pad = 'a'.repeat(400);
    const step = sedStep(
      `${pad} ssn=123-45-6789 tail=end`,
      props('SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/g', 'EXTRACT-ssn = ssn=(?<ssn>\\S+)'),
    );

    expect(step.fieldsModified).toEqual(['ssn']);
  });

  it('separates a destroyed field from a merely devalued one', () => {
    const step = sedStep(
      'user=alice ssn=123-45-6789 action=login',
      props('SEDCMD-drop = s/ssn=\\S+ //', 'EXTRACT-ssn = ssn=(?<ssn>\\S+)', 'EXTRACT-user = user=(?<user>\\S+)'),
    );

    expect(step.fieldsRemoved).toEqual(['ssn']);
    expect(step.fieldsModified).toEqual([]);
  });

  it('does not blame a field that merely shares text with the masked one', () => {
    // `pair` and `tail` both contain "6789" — a snapshot text-diff blames both.
    const step = sedStep(
      'pair=123-45-6789 tail=6789',
      props(
        'SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/',
        'EXTRACT-pair = pair=(?<pair>\\S+)',
        'EXTRACT-tail = tail=(?<tail>\\S+)',
      ),
    );

    expect(step.fieldsModified).toEqual(['pair']);
  });

  it('attributes each SEDCMD separately rather than collapsing them', () => {
    const { result } = runPipeline(
      'ssn=123-45-6789 card=4111111111111111',
      meta,
      props(
        'SEDCMD-a_ssn = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/',
        'SEDCMD-b_card = s/4\\d{15}/CARD-REDACTED/',
        'EXTRACT-ssn = ssn=(?<ssn>\\S+)',
        'EXTRACT-card = card=(?<card>\\S+)',
      ),
      '',
    );
    const steps = result.events[0]!.processingTrace.filter((s) => s.processor.startsWith('SEDCMD'));

    expect(steps.map((s) => [s.processor, s.fieldsModified])).toEqual([
      ['SEDCMD-a_ssn', ['ssn']],
      ['SEDCMD-b_card', ['card']],
    ]);
  });

  it('attributes fields extracted by KV_MODE, not just EXTRACT', () => {
    const step = sedStep(
      'user=alice ssn=123-45-6789',
      props('SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/'),
    );

    expect(step.fieldsModified).toEqual(['ssn']);
  });

  it('attributes in per-event mode, using each event\'s own resolved directives', () => {
    const { result } = runPipeline(
      'ssn=123-45-6789',
      meta,
      props('SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/', 'EXTRACT-ssn = ssn=(?<ssn>\\S+)'),
      '',
      { perEventPipeline: true },
    );
    const step = result.events[0]!.processingTrace.find((s) => s.processor.startsWith('SEDCMD'));

    expect(step?.fieldsModified).toEqual(['ssn']);
  });

  it('never leaks the transient mutation record to the caller', () => {
    const { result } = runPipeline(
      'ssn=123-45-6789',
      meta,
      props('SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/'),
      '',
    );

    expect(result.events[0]).not.toHaveProperty('rawMutations');
  });
});

describe('DEST_KEY = _raw field attribution', () => {
  const transforms = [
    '[maskit]',
    'REGEX = (.*)ssn=\\S+(.*)',
    'FORMAT = $1ssn=REDACTED$2',
    'DEST_KEY = _raw',
  ].join('\n');

  it('attributes a _raw overwrite to the field it destroyed', () => {
    const step = stepFor(
      'user=alice ssn=123-45-6789',
      props('TRANSFORMS-m = maskit'),
      (s) => s.processor.includes('maskit'),
      transforms,
    );

    expect(step.fieldsModified).toEqual(['ssn']);
  });

  it('records before/after text for a _raw overwrite, which it previously did not', () => {
    const step = stepFor(
      'user=alice ssn=123-45-6789',
      props('TRANSFORMS-m = maskit'),
      (s) => s.processor.includes('maskit'),
      transforms,
    );

    expect(step.inputSnapshot).toContain('123-45-6789');
    expect(step.outputSnapshot).toContain('REDACTED');
  });

  it('leaves a non-_raw transform unattributed', () => {
    const step = stepFor(
      'user=alice ssn=123-45-6789',
      props('TRANSFORMS-m = tagit'),
      (s) => s.processor.includes('tagit'),
      ['[tagit]', 'REGEX = user=(\\w+)', 'FORMAT = owner::$1', 'DEST_KEY = _meta'].join('\n'),
    );

    expect(step.fieldsModified).toBeUndefined();
    expect(step.inputSnapshot).toBeUndefined();
  });
});

describe('INGEST_EVAL _raw= field attribution (#346)', () => {
  // The repro from #346. INGEST_EVAL's `_raw=` rewrites the event exactly as
  // DEST_KEY = _raw does, so it must be attributed the same way; it used to be
  // traced as a bare expression count, naming nothing it destroyed.
  const propsConf = props('TRANSFORMS-m = scrub', 'EXTRACT-s = secret=(?<secret>\\S+)');
  const viaIngestEval = '[scrub]\nINGEST_EVAL = _raw=replace(_raw,"secret=\\\\S+","")\n';
  const viaDestKey = '[scrub]\nREGEX = ^(.*)secret=\\S+(.*)$\nFORMAT = $1$2\nDEST_KEY = _raw\n';

  it('names the field an INGEST_EVAL _raw rewrite destroyed', () => {
    const step = stepFor('user=alice secret=hunter2', propsConf, (s) => s.processor === 'INGEST_EVAL', viaIngestEval);

    expect(step.fieldsRemoved).toEqual(['secret']);
    expect(step.fieldsModified).toEqual([]);
    expect(step.inputSnapshot).toContain('secret=hunter2');
    expect(step.outputSnapshot).not.toContain('secret');
  });

  it('agrees with the equivalent DEST_KEY = _raw transform', () => {
    const destKey = stepFor('user=alice secret=hunter2', propsConf, (s) => s.processor.includes('scrub'), viaDestKey);
    const ingest = stepFor('user=alice secret=hunter2', propsConf, (s) => s.processor === 'INGEST_EVAL', viaIngestEval);

    expect(ingest.fieldsRemoved).toEqual(destKey.fieldsRemoved);
    expect(ingest.fieldsModified).toEqual(destKey.fieldsModified);
  });

  it('leaves an INGEST_EVAL that does not touch _raw unattributed', () => {
    const step = stepFor(
      'user=alice secret=hunter2',
      propsConf,
      (s) => s.processor === 'INGEST_EVAL',
      '[scrub]\nINGEST_EVAL = tag="x"\n',
    );

    expect(step.fieldsRemoved).toBeUndefined();
    expect(step.inputSnapshot).toBeUndefined();
  });
});

describe('trace snapshots window on the change', () => {
  it('shows the substitution rather than a prefix that omits it', () => {
    const pad = 'a'.repeat(400);
    const step = sedStep(
      `${pad} ssn=123-45-6789 tail=end`,
      props('SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/'),
    );

    expect(step.inputSnapshot).toContain('123-45-6789');
    expect(step.outputSnapshot).toContain('XXX-XX-XXXX');
    expect(step.inputSnapshot).not.toEqual(step.outputSnapshot);
  });

  it('marks elision so a window is not mistaken for the whole event', () => {
    const pad = 'a'.repeat(400);
    const step = sedStep(`${pad} ssn=123-45-6789`, props('SEDCMD-mask = s/6789/0000/'));

    expect(step.inputSnapshot?.startsWith('…')).toBe(true);
  });

  it('leaves a short event unelided', () => {
    const step = sedStep('ssn=123-45-6789', props('SEDCMD-mask = s/6789/0000/'));

    expect(step.inputSnapshot).toBe('ssn=123-45-6789');
    expect(step.outputSnapshot).toBe('ssn=123-45-0000');
  });
});
