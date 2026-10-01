// ---------------------------------------------------------------------------
// annotatePunct.test.ts
// ANNOTATE_PUNCT and the punct signature.
//
// Doc-derived: the signature shape follows the worked example in Splunk's
// search documentation, and props.conf.spec's ANNOTATE_PUNCT (default true)
// decides whether the punct field is created at all.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { buildPunct } from '../processors/punctAnnotator';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

const METADATA: EventMetadata = {
  index: 'main',
  host: 'h',
  source: 's',
  sourcetype: 'st',
};

function run(props: string, input: string) {
  return runPipeline(input, METADATA, `[st]\n${props}`, '').result.events;
}

describe('buildPunct', () => {
  it('drops letters and digits, keeps punctuation, maps spaces to underscores', () => {
    // The shape of the worked example in Splunk's search documentation.
    expect(buildPunct('172.26.34.223 - - [01/Jul/2005:12:05:27 -0700]')).toBe('..._-_-_[//:::_-]');
  });

  it('is empty for a purely alphanumeric event', () => {
    expect(buildPunct('abc123')).toBe('');
  });
});

describe('ANNOTATE_PUNCT in the pipeline (#185)', () => {
  it('generates punct by default, with no configuration at all', () => {
    const events = run('SHOULD_LINEMERGE = false\n', '2026-01-15T10:00:00Z user=alice\n');
    expect(events[0]?.fields['punct']).toBe('--::_=');
  });

  it('is disabled by ANNOTATE_PUNCT = false', () => {
    const events = run('SHOULD_LINEMERGE = false\nANNOTATE_PUNCT = false\n', '2026-01-15T10:00:00Z user=alice\n');
    expect(events[0]?.fields['punct']).toBeUndefined();
  });

  it('reflects _raw as indexed, after SEDCMD has rewritten it', () => {
    const events = run(
      'SHOULD_LINEMERGE = false\nSEDCMD-strip = s/user=\\w+/[MASKED]/\n',
      '2026-01-15T10:00:00Z user=alice\n',
    );
    // `user=alice` became `[MASKED]`, so the signature holds brackets, not `=`.
    expect(events[0]?.fields['punct']).toBe('--::_[]');
  });
});
