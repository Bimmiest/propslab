// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// The store's plain state: its defaults, every setter and toggle, and what it
// restores from localStorage. useAppStore.test.ts holds the rules with a story
// (per-event implies manual apply, dirty tracking); this holds the rest, which
// components exercise only in passing. Added with the store joining the
// mutation run (#508), where an untested setter is a mutant nothing kills.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore, selectSessionDirty, EMPTY_INPUTS, NO_PREVIEW_FILTERS } from '../useAppStore';

const THEME_KEY = 'propslab:theme';
const SETTINGS_KEY = 'propslab:settings';
const initial = useAppStore.getState();
const state = () => useAppStore.getState();

/** A store as if the page had just loaded, with `storage` already in localStorage. */
async function freshStore(storage: Record<string, string> = {}) {
  localStorage.clear();
  for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  vi.resetModules();
  return (await import('../useAppStore')).useAppStore.getState();
}

beforeEach(() => {
  useAppStore.setState(initial, true);
  localStorage.clear();
});

describe('defaults', () => {
  it('starts on an empty, clean simulator', async () => {
    const s = await freshStore();
    expect(s).toMatchObject({
      rawData: '',
      propsConf: '',
      transformsConf: '',
      metadata: { index: 'main', host: '', source: '', sourcetype: '' },
      isProcessing: false,
      pipelineOnMainThread: false,
      processingResult: null,
      validationDiagnostics: [],
      theme: 'dark',
      activeOutputTab: 'preview',
      activeView: 'simulator',
      mobileView: 'raw',
      regexPattern: '',
      regexClassName: 'custom',
      previewSubTab: 'raw',
      previewFilters: NO_PREVIEW_FILTERS,
      dictionarySelection: null,
      currentPage: 1,
      eventsPerPage: 10,
      collapsedPanels: {},
      helpOpen: false,
      helpStage: null,
      commandPaletteOpen: false,
      lastProcessingMs: null,
      settings: { perEventPipeline: false, manualApply: false },
      pipelineDirty: false,
      manualRunTick: 0,
      settingsOpen: false,
      scaffoldOpen: false,
    });
    expect(s.loadedInputs).toEqual(EMPTY_INPUTS);
    expect(EMPTY_INPUTS).toEqual({
      rawData: '',
      propsConf: '',
      transformsConf: '',
      metadata: { index: 'main', host: '', source: '', sourcetype: '' },
    });
  });

  it('does not share its metadata object with the baseline', () => {
    state().setMetadataField('host', 'web01');
    expect(EMPTY_INPUTS.metadata.host).toBe('');
  });
});

describe('setters', () => {
  const cases: [name: string, act: () => void, expected: Record<string, unknown>][] = [
    ['setIsProcessing', () => state().setIsProcessing(true), { isProcessing: true }],
    ['setPipelineOnMainThread', () => state().setPipelineOnMainThread(true), { pipelineOnMainThread: true }],
    ['setPropsConf', () => state().setPropsConf('[st]'), { propsConf: '[st]' }],
    ['setTransformsConf', () => state().setTransformsConf('[t]'), { transformsConf: '[t]' }],
    ['setActiveOutputTab', () => state().setActiveOutputTab('fields'), { activeOutputTab: 'fields' }],
    ['setActiveView', () => state().setActiveView('dictionary'), { activeView: 'dictionary' }],
    ['setMobileView', () => state().setMobileView('output'), { mobileView: 'output' }],
    ['setRegexPattern', () => state().setRegexPattern('(?<a>x)'), { regexPattern: '(?<a>x)' }],
    ['setRegexClassName', () => state().setRegexClassName('mine'), { regexClassName: 'mine' }],
    ['setPreviewSubTab', () => state().setPreviewSubTab('regex'), { previewSubTab: 'regex' }],
    ['setDictionarySelection', () => state().setDictionarySelection('KV_MODE'), { dictionarySelection: 'KV_MODE' }],
    ['setCurrentPage', () => state().setCurrentPage(4), { currentPage: 4 }],
    ['setHelpStage', () => state().setHelpStage(3), { helpStage: 3 }],
    ['setLastProcessingMs', () => state().setLastProcessingMs(12), { lastProcessingMs: 12 }],
    ['setPipelineDirty', () => state().setPipelineDirty(true), { pipelineDirty: true }],
  ];

  it.each(cases)('%s sets its field', (_name, act, expected) => {
    act();
    expect(state()).toMatchObject(expected);
  });

  it('setValidationDiagnostics and setProcessingResult store what they are given', () => {
    const diags = [{ severity: 'error', message: 'm', line: 1 }] as never;
    state().setValidationDiagnostics(diags);
    expect(state().validationDiagnostics).toBe(diags);
    const result = { events: [] } as never;
    state().setProcessingResult(result);
    expect(state().processingResult).toBe(result);
    state().setProcessingResult(null);
    expect(state().processingResult).toBeNull();
  });

  it('setRawData and setEventsPerPage go back to page one', () => {
    state().setCurrentPage(5);
    state().setRawData('x');
    expect(state()).toMatchObject({ rawData: 'x', currentPage: 1 });
    state().setCurrentPage(5);
    state().setEventsPerPage(50);
    expect(state()).toMatchObject({ eventsPerPage: 50, currentPage: 1 });
  });

  it('setPreviewFilters changes only what it is given and goes back to page one, unless told not to', () => {
    state().setCurrentPage(5);
    state().setPreviewFilters({ search: 'GET' });
    expect(state()).toMatchObject({ previewFilters: { ...NO_PREVIEW_FILTERS, search: 'GET' }, currentPage: 1 });
    state().setCurrentPage(5);
    const fields = new Set(['user']);
    state().setPreviewFilters({ fields }, true);
    expect(state().previewFilters).toEqual({ ...NO_PREVIEW_FILTERS, search: 'GET', fields });
    expect(state().currentPage).toBe(5);
    expect(NO_PREVIEW_FILTERS.search).toBe('');
  });

  it('setMetadataField changes one field and keeps the others; setMetadata replaces all', () => {
    state().setMetadataField('host', 'web01');
    state().setMetadataField('source', '/var/log/x');
    expect(state().metadata).toEqual({ index: 'main', host: 'web01', source: '/var/log/x', sourcetype: '' });
    state().setMetadata({ index: 'i', host: 'h', source: 's', sourcetype: 't' });
    expect(state().metadata).toEqual({ index: 'i', host: 'h', source: 's', sourcetype: 't' });
  });

  it('openDictionaryAt selects the directive and switches view together', () => {
    state().openDictionaryAt('TZ');
    expect(state()).toMatchObject({ dictionarySelection: 'TZ', activeView: 'dictionary' });
  });

  it('setDictionarySelection accepts null and leaves the view alone', () => {
    state().setDictionarySelection('TZ');
    state().setDictionarySelection(null);
    expect(state()).toMatchObject({ dictionarySelection: null, activeView: 'simulator' });
  });

  it('openHelpAt opens the reference at that stage', () => {
    state().openHelpAt(2);
    expect(state()).toMatchObject({ helpOpen: true, helpStage: 2 });
  });
});

describe('toggles', () => {
  const toggles: [action: 'toggleHelp' | 'toggleCommandPalette' | 'toggleSettings' | 'toggleScaffold', field: string][] = [
    ['toggleHelp', 'helpOpen'],
    ['toggleCommandPalette', 'commandPaletteOpen'],
    ['toggleSettings', 'settingsOpen'],
    ['toggleScaffold', 'scaffoldOpen'],
  ];

  it.each(toggles)('%s flips %s and flips it back', (action, field) => {
    const before = (state() as unknown as Record<string, boolean>)[field];
    state()[action]();
    expect((state() as unknown as Record<string, boolean>)[field]).toBe(!before);
    state()[action]();
    expect((state() as unknown as Record<string, boolean>)[field]).toBe(before);
  });

  it('togglePanelCollapse flips one panel and leaves the others', () => {
    state().togglePanelCollapse('a');
    state().togglePanelCollapse('b');
    state().togglePanelCollapse('a');
    expect(state().collapsedPanels).toEqual({ a: false, b: true });
  });

  it('triggerManualRun counts runs and clears the dirty flag', () => {
    state().setPipelineDirty(true);
    state().triggerManualRun();
    state().triggerManualRun();
    expect(state()).toMatchObject({ manualRunTick: 2, pipelineDirty: false });
  });
});

describe('theme', () => {
  it('toggles and persists each choice', () => {
    expect(state().theme).toBe('dark');
    state().toggleTheme();
    expect(state().theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    state().toggleTheme();
    expect(state().theme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('still toggles when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    state().toggleTheme();
    expect(state().theme).toBe('light');
  });

  it.each([
    ['a saved light theme', { [THEME_KEY]: 'light' }, 'light'],
    ['a saved dark theme', { [THEME_KEY]: 'dark' }, 'dark'],
    ['the pre-rename key', { 'splunk-toolkit:theme': 'light' }, 'light'],
    ['the new key over the old', { [THEME_KEY]: 'dark', 'splunk-toolkit:theme': 'light' }, 'dark'],
    ['an unknown value', { [THEME_KEY]: 'sepia' }, 'dark'],
    ['nothing saved', {}, 'dark'],
  ])('restores %s', async (_name, storage, expected) => {
    expect((await freshStore(storage)).theme).toBe(expected);
  });

  it('falls back to dark when storage cannot be read', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.resetModules();
    const s = (await import('../useAppStore')).useAppStore.getState();
    expect(s.theme).toBe('dark');
    expect(s.settings).toEqual({ perEventPipeline: false, manualApply: false });
  });
});

describe('settings restore', () => {
  const json = (o: unknown) => ({ [SETTINGS_KEY]: JSON.stringify(o) });

  it.each([
    ['both on', json({ perEventPipeline: true, manualApply: true }), { perEventPipeline: true, manualApply: true }],
    ['manual apply only', json({ perEventPipeline: false, manualApply: true }), { perEventPipeline: false, manualApply: true }],
    ['per-event alone implies manual apply', json({ perEventPipeline: true }), { perEventPipeline: true, manualApply: true }],
    ['per-event on, manual apply stored off', json({ perEventPipeline: true, manualApply: false }), { perEventPipeline: true, manualApply: true }],
    ['non-boolean values', json({ perEventPipeline: 'yes', manualApply: 1 }), { perEventPipeline: false, manualApply: false }],
    ['a JSON null', { [SETTINGS_KEY]: 'null' }, { perEventPipeline: false, manualApply: false }],
    ['a JSON number', { [SETTINGS_KEY]: '7' }, { perEventPipeline: false, manualApply: false }],
    ['malformed JSON', { [SETTINGS_KEY]: '{' }, { perEventPipeline: false, manualApply: false }],
    ['an empty string', { [SETTINGS_KEY]: '' }, { perEventPipeline: false, manualApply: false }],
    ['the pre-rename key', { 'splunk-toolkit:settings': JSON.stringify({ manualApply: true }) }, { perEventPipeline: false, manualApply: true }],
    ['nothing saved', {}, { perEventPipeline: false, manualApply: false }],
  ])('restores %s', async (_name, storage, expected) => {
    expect((await freshStore(storage)).settings).toEqual(expected);
  });

  it('togglePerEventPipeline turns manual apply on with it, and keeps it on when turned off', () => {
    state().togglePerEventPipeline();
    expect(state().settings).toEqual({ perEventPipeline: true, manualApply: true });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')).toEqual({ perEventPipeline: true, manualApply: true });
    state().togglePerEventPipeline();
    expect(state().settings).toEqual({ perEventPipeline: false, manualApply: true });
  });

  it('toggleManualApply persists, and survives a storage that refuses writes', () => {
    state().toggleManualApply();
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')).toEqual({ perEventPipeline: false, manualApply: true });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    state().toggleManualApply();
    expect(state().settings.manualApply).toBe(false);
    state().togglePerEventPipeline();
    expect(state().settings.perEventPipeline).toBe(true);
  });
});

describe('loadInputs', () => {
  const inputs = {
    rawData: 'r',
    propsConf: 'p',
    transformsConf: 't',
    metadata: { index: 'i', host: 'h', source: 's', sourcetype: 'st' },
  };

  it('replaces all four inputs, resets the page and makes them the baseline', () => {
    state().setCurrentPage(3);
    state().loadInputs(inputs);
    expect(state()).toMatchObject({ ...inputs, currentPage: 1, loadedInputs: inputs });
  });

  it('copies the metadata, so editing a field does not change the baseline', () => {
    state().loadInputs(inputs);
    state().setMetadataField('host', 'other');
    expect(state().loadedInputs.metadata.host).toBe('h');
    expect(inputs.metadata.host).toBe('h');
  });
});

describe('selectSessionDirty, field by field', () => {
  it.each(['index', 'host', 'source', 'sourcetype'] as const)('is dirty when only metadata.%s differs', (field) => {
    state().loadInputs({ ...EMPTY_INPUTS, metadata: { index: 'a', host: 'b', source: 'c', sourcetype: 'd' } });
    expect(selectSessionDirty(state())).toBe(false);
    state().setMetadataField(field, 'changed');
    expect(selectSessionDirty(state())).toBe(true);
  });

  it.each(['setRawData', 'setPropsConf', 'setTransformsConf'] as const)('is dirty when only %s changed something', (setter) => {
    state()[setter]('edit');
    expect(selectSessionDirty(state())).toBe(true);
  });
});
