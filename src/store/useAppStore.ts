import { create } from 'zustand';
import type { EventMetadata, OutputTabId, ProcessingResult, ValidationDiagnostic } from '../engine/types';

/** Top-level workspace the activity rail switches between. */
export type ActiveView = 'simulator' | 'dictionary';

interface AppState {
  rawData: string;
  setRawData: (data: string) => void;

  isProcessing: boolean;
  setIsProcessing: (v: boolean) => void;
  /**
   * The last pipeline run happened on the main thread, with no watchdog,
   * because no worker could be had (#403). Cleared by the next worker answer.
   */
  pipelineOnMainThread: boolean;
  setPipelineOnMainThread: (v: boolean) => void;

  metadata: EventMetadata;
  setMetadataField: (field: keyof EventMetadata, value: string) => void;
  setMetadata: (meta: EventMetadata) => void;

  propsConf: string;
  setPropsConf: (text: string) => void;

  transformsConf: string;
  setTransformsConf: (text: string) => void;

  processingResult: ProcessingResult | null;
  setProcessingResult: (result: ProcessingResult | null) => void;

  validationDiagnostics: ValidationDiagnostic[];
  setValidationDiagnostics: (diags: ValidationDiagnostic[]) => void;

  theme: 'light' | 'dark';
  toggleTheme: () => void;

  activeOutputTab: OutputTabId;
  setActiveOutputTab: (tab: OutputTabId) => void;

  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;

  /**
   * Directive key the dictionary should show, set when something outside the
   * dictionary deep-links into it (editor hover, pipeline reference, command
   * palette). Null means "no selection yet" — the dictionary falls back to its
   * own first entry rather than forcing one.
   */
  dictionarySelection: string | null;
  /** Select a directive AND switch to the dictionary — the two always go together. */
  openDictionaryAt: (key: string) => void;
  setDictionarySelection: (key: string | null) => void;

  currentPage: number;
  setCurrentPage: (page: number) => void;

  eventsPerPage: number;
  setEventsPerPage: (count: number) => void;

  collapsedPanels: Record<string, boolean>;
  togglePanelCollapse: (panelId: string) => void;

  helpOpen: boolean;
  toggleHelp: () => void;

  commandPaletteOpen: boolean;
  toggleCommandPalette: () => void;

  lastProcessingMs: number | null;
  setLastProcessingMs: (ms: number | null) => void;

  settings: { perEventPipeline: boolean; manualApply: boolean };
  togglePerEventPipeline: () => void;
  toggleManualApply: () => void;

  pipelineDirty: boolean;
  setPipelineDirty: (v: boolean) => void;

  manualRunTick: number;
  triggerManualRun: () => void;

  settingsOpen: boolean;
  toggleSettings: () => void;

  scaffoldOpen: boolean;
  toggleScaffold: () => void;
}

const THEME_KEY = 'propslab:theme';
const SETTINGS_KEY = 'propslab:settings';

/**
 * Read a preference, falling back to the key it used before the app was renamed
 * from Splunk Toolkit. Writes only ever go to the new key, so a returning user
 * keeps their theme and settings and then quietly migrates on the next change.
 * Once no one is plausibly carrying a pre-rename `localStorage`, the legacy
 * argument and this comment can go.
 */
function readPreference(key: string, legacyKey: string): string | null {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(legacyKey);
  } catch {
    return null;
  }
}

/** Restore the persisted theme, defaulting to dark when unset or unreadable. */
function loadTheme(): 'light' | 'dark' {
  const saved = readPreference(THEME_KEY, 'splunk-toolkit:theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}

/**
 * Restore persisted settings, validating shape rather than trusting the parsed
 * JSON — a stale or hand-edited value could be the wrong shape (missing keys, or
 * non-booleans), which would otherwise flow straight into the store. Also keeps
 * the invariant that per-event mode implies manual-apply.
 */
function loadSettings(): { perEventPipeline: boolean; manualApply: boolean } {
  const fallback = { perEventPipeline: false, manualApply: false };
  try {
    const saved = readPreference(SETTINGS_KEY, 'splunk-toolkit:settings');
    if (!saved) return fallback;
    const parsed = JSON.parse(saved) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const o = parsed as Record<string, unknown>;
    const perEventPipeline = o.perEventPipeline === true;
    return {
      perEventPipeline,
      manualApply: perEventPipeline || o.manualApply === true,
    };
  } catch {
    return fallback;
  }
}

export const useAppStore = create<AppState>((set) => ({
  rawData: '',
  setRawData: (data) => set({ rawData: data, currentPage: 1 }),

  isProcessing: false,
  setIsProcessing: (v) => set({ isProcessing: v }),
  pipelineOnMainThread: false,
  setPipelineOnMainThread: (v) => set({ pipelineOnMainThread: v }),

  metadata: {
    index: 'main',
    host: '',
    source: '',
    sourcetype: '',
  },
  setMetadataField: (field, value) =>
    set((state) => ({
      metadata: { ...state.metadata, [field]: value },
    })),
  setMetadata: (meta) => set({ metadata: meta }),

  propsConf: '',
  setPropsConf: (text) => set({ propsConf: text }),

  transformsConf: '',
  setTransformsConf: (text) => set({ transformsConf: text }),

  processingResult: null,
  setProcessingResult: (result) => set({ processingResult: result }),

  validationDiagnostics: [],
  setValidationDiagnostics: (diags) => set({ validationDiagnostics: diags }),

  theme: loadTheme(),
  toggleTheme: () =>
    set((state) => {
      const theme = state.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
      return { theme };
    }),

  activeOutputTab: 'preview',
  setActiveOutputTab: (tab) => set({ activeOutputTab: tab }),

  // Deliberately NOT persisted: the simulator is the product, and restoring a
  // reload straight into the dictionary would bury it.
  activeView: 'simulator',
  setActiveView: (view) => set({ activeView: view }),

  dictionarySelection: null,
  openDictionaryAt: (key) => set({ dictionarySelection: key, activeView: 'dictionary' }),
  setDictionarySelection: (key) => set({ dictionarySelection: key }),

  currentPage: 1,
  setCurrentPage: (page) => set({ currentPage: page }),

  eventsPerPage: 10,
  setEventsPerPage: (count) => set({ eventsPerPage: count, currentPage: 1 }),

  collapsedPanels: {},
  togglePanelCollapse: (panelId) =>
    set((state) => ({
      collapsedPanels: {
        ...state.collapsedPanels,
        [panelId]: !state.collapsedPanels[panelId],
      },
    })),

  helpOpen: false,
  toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),

  commandPaletteOpen: false,
  toggleCommandPalette: () => set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

  lastProcessingMs: null,
  setLastProcessingMs: (ms) => set({ lastProcessingMs: ms }),

  settings: loadSettings(),
  togglePerEventPipeline: () =>
    set((state) => {
      const perEventPipeline = !state.settings.perEventPipeline;
      const manualApply = perEventPipeline ? true : state.settings.manualApply;
      const next = { ...state.settings, perEventPipeline, manualApply };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { settings: next };
    }),
  toggleManualApply: () =>
    set((state) => {
      // Per-event mode implies manual-apply (see the invariant above, enforced in
      // loadSettings and togglePerEventPipeline). Without this guard the toggle
      // could clear manualApply while perEventPipeline was still on, reaching a
      // state the invariant says cannot exist — and one that loadSettings would
      // silently "correct" on the next reload, so live and persisted state
      // disagreed until then.
      if (state.settings.perEventPipeline && state.settings.manualApply) return {};
      const next = { ...state.settings, manualApply: !state.settings.manualApply };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { settings: next };
    }),

  pipelineDirty: false,
  setPipelineDirty: (v) => set({ pipelineDirty: v }),

  manualRunTick: 0,
  triggerManualRun: () => set((state) => ({ manualRunTick: state.manualRunTick + 1, pipelineDirty: false })),

  settingsOpen: false,
  toggleSettings: () => set((state) => ({ settingsOpen: !state.settingsOpen })),

  scaffoldOpen: false,
  toggleScaffold: () => set((state) => ({ scaffoldOpen: !state.scaffoldOpen })),
}));
