// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useApplyDirective.test.tsx
// Which stanza a generated directive is written into (#611).
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useApplyDirective } from '../useApplyDirective';
import { useAppStore } from '../../../../../store/useAppStore';
import { runPipeline } from '../../../../../engine/pipeline';
import { AT_FIXED_NOW } from '../../../../../engine/__tests__/runCtx';
import { toViewResult } from '../../../../../utils/viewResult';
import type { EventMetadata } from '../../../../../engine/types';

const initial = useAppStore.getState();

/** Put a real run of `props` over `metadata` in the store, as the pipeline hook does. */
function settle(props: string, metadata: EventMetadata): void {
  const { result } = runPipeline('user=bob', metadata, props, '', AT_FIXED_NOW);
  useAppStore.setState({ ...initial, metadata, propsConf: props, processingResult: toViewResult(result) }, true);
}

/** The props.conf stanza `key` ended up in, by header, or undefined. */
function stanzaHolding(key: string): string | undefined {
  let stanza: string | undefined;
  for (const line of useAppStore.getState().propsConf.split('\n')) {
    const header = /^\[(.+)\]$/.exec(line.trim());
    if (header) stanza = header[1];
    else if (line.trim().startsWith(`${key} `)) return stanza;
  }
  return undefined;
}

beforeEach(() => {
  useAppStore.setState(initial, true);
});

describe('useApplyDirective (#611)', () => {
  it('writes into the sourcetype a [source::] stanza assigned at input, not the one typed', () => {
    settle('[source::/var/log/app.log]\nsourcetype = app_log\n\n[app_log]\nSHOULD_LINEMERGE = false\n', {
      index: 'main',
      host: 'h',
      source: '/var/log/app.log',
      sourcetype: 'generic',
    });
    const { result } = renderHook(() => useApplyDirective());
    expect(result.current.stanza).toBe('app_log');
    act(() => result.current.apply('EXTRACT-u', 'user=(?<u>\\w+)'));
    expect(stanzaHolding('EXTRACT-u')).toBe('app_log');
    expect(useAppStore.getState().metadata.sourcetype).toBe('generic');
  });

  it("follows the event's own sourcetype when the event menu passes one", () => {
    settle('[st]\nSHOULD_LINEMERGE = false\n', { index: 'main', host: 'h', source: 's', sourcetype: 'st' });
    const { result } = renderHook(() => useApplyDirective('cloned'));
    act(() => result.current.apply('EXTRACT-u', 'user=(?<u>\\w+)'));
    expect(stanzaHolding('EXTRACT-u')).toBe('cloned');
  });

  it('sends a search-time directive to the rename target and an index-time one to the original', () => {
    settle('[orig]\nrename = renamed\n\n[renamed]\nKV_MODE = none\n', {
      index: 'main',
      host: 'h',
      source: 's',
      sourcetype: 'orig',
    });
    const { result } = renderHook(() => useApplyDirective());
    expect(result.current.stanza).toBe('renamed');
    expect(result.current.stanzaFor('TIME_PREFIX')).toBe('orig');
    act(() => result.current.apply('EXTRACT-u', 'user=(?<u>\\w+)'));
    act(() => result.current.apply('TIME_PREFIX', 'ts='));
    expect(stanzaHolding('EXTRACT-u')).toBe('renamed');
    expect(stanzaHolding('TIME_PREFIX')).toBe('orig');
  });

  it('writes a placeholder stanza and points the metadata at it when there is no sourcetype', () => {
    useAppStore.setState({ ...initial, metadata: { index: 'main', host: 'h', source: 's', sourcetype: '' } }, true);
    const { result } = renderHook(() => useApplyDirective());
    expect(result.current.isPlaceholderStanza).toBe(true);
    act(() => result.current.apply('EXTRACT-u', 'user=(?<u>\\w+)'));
    expect(stanzaHolding('EXTRACT-u')).toBe('my:sourcetype');
    expect(useAppStore.getState().metadata.sourcetype).toBe('my:sourcetype');
  });
});
