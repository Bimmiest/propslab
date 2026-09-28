// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../useAppStore';

const SETTINGS_KEY = 'propslab:settings';
const initial = useAppStore.getState();

describe('settings — per-event mode implies manual apply (#27)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    localStorage.clear();
  });

  it('turning per-event mode on forces manual apply on', () => {
    useAppStore.getState().togglePerEventPipeline();
    const { perEventPipeline, manualApply } = useAppStore.getState().settings;
    expect(perEventPipeline).toBe(true);
    expect(manualApply).toBe(true);
  });

  it('manual apply cannot be turned off while per-event mode is on', () => {
    useAppStore.getState().togglePerEventPipeline();
    useAppStore.getState().toggleManualApply();
    expect(useAppStore.getState().settings.manualApply).toBe(true);
  });

  it('leaves persisted state consistent with live state', () => {
    useAppStore.getState().togglePerEventPipeline();
    useAppStore.getState().toggleManualApply();
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    expect(saved.manualApply).toBe(true);
    expect(saved.perEventPipeline).toBe(true);
  });

  it('manual apply toggles freely when per-event mode is off', () => {
    useAppStore.getState().toggleManualApply();
    expect(useAppStore.getState().settings.manualApply).toBe(true);
    useAppStore.getState().toggleManualApply();
    expect(useAppStore.getState().settings.manualApply).toBe(false);
  });
});

describe('dictionary navigation', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    localStorage.clear();
  });

  it('starts on the simulator', () => {
    expect(useAppStore.getState().activeView).toBe('simulator');
    expect(useAppStore.getState().dictionarySelection).toBeNull();
  });

  it('openDictionaryAt both selects the directive and switches view', () => {
    useAppStore.getState().openDictionaryAt('TIME_FORMAT');
    expect(useAppStore.getState().activeView).toBe('dictionary');
    expect(useAppStore.getState().dictionarySelection).toBe('TIME_FORMAT');
  });

  it('keeps the selection when switching back to the simulator', () => {
    useAppStore.getState().openDictionaryAt('KV_MODE');
    useAppStore.getState().setActiveView('simulator');
    expect(useAppStore.getState().dictionarySelection).toBe('KV_MODE');
  });

  it('does not persist the active view — a reload belongs on the simulator', () => {
    useAppStore.getState().setActiveView('dictionary');
    const persisted = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '');
    expect(persisted.some((v) => v.includes('dictionary'))).toBe(false);
  });
});

describe('openHelpAt', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('opens the pipeline reference with that stage expanded', () => {
    useAppStore.getState().openHelpAt(4);
    expect(useAppStore.getState().helpOpen).toBe(true);
    expect(useAppStore.getState().helpStage).toBe(4);
  });
});
