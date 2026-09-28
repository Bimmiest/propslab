// ---------------------------------------------------------------------------
// annotatePunct.test.ts
// ANNOTATE_PUNCT and the punct signature.
//
// Capture-derived: the punct-* captures from Splunk 10.4.0 (tab encodes as the
// letter `t`, newlines are dropped, the cap is 50 characters).
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
    expect(buildPunct('172.26.34.223 - - [01/Jul/2005:12:05:27 -0700]')).toBe(
      '..._-_-_[//:::_-]',
    );
  });

  it('maps a tab to the literal letter t (punct-whitespace-and-multiline)', () => {
    expect(buildPunct('\tat com.example.Main(Main.java:1)')).toBe('t_..(.:)');
  });

  it('drops newlines entirely (punct-whitespace-and-multiline)', () => {
    expect(buildPunct('a=1\nb=2')).toBe('==');
  });

  it('caps the signature at 50 characters (punct-cap)', () => {
    const punct = buildPunct('.'.repeat(100));
    expect(punct).toBe('.'.repeat(50));
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
    const events = run(
      'SHOULD_LINEMERGE = false\nANNOTATE_PUNCT = false\n',
      '2026-01-15T10:00:00Z user=alice\n',
    );
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
