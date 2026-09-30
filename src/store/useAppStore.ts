import { create, type StoreApi } from 'zustand';
import type { EventMetadata, OutputTabId, PreviewSubTabId, ValidationDiagnostic } from '../engine/types';
import type { ViewResult } from '../utils/viewResult';

/** Top-level workspace the activity rail switches between. */
export type ActiveView = 'simulator' | 'dictionary';

/** The simulator panels the mobile layout switches between. */
export type MobileView = 'raw' | 'props' | 'transforms' | 'output';

/** The four inputs an example, or "Clear all", replaces together. */
export interface SessionInputs {
  rawData: string;
  propsConf: string;
  transformsConf: string;
  metadata: EventMetadata;
}

/** What the Preview tab's filter bar narrows the events to. */
export interface PreviewFilters {
  search: string;
  fields: ReadonlySet<string>;
  status: ReadonlySet<string>;
  changeState: ReadonlySet<string>;
}

export const NO_PREVIEW_FILTERS: PreviewFilters = {
  search: '',
  fields: new Set(),
  status: new Set(),
  changeState: new Set(),
};

export const EMPTY_INPUTS: SessionInputs = {
  rawData: '',
  propsConf: '',
  transformsConf: '',
  metadata: { index: 'main', host: '', source: '', sourcetype: '' },
};

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

  /** What the inputs were last loaded as: empty at start, or an example. */
  loadedInputs: SessionInputs;
  /** Replace all four inputs at once and make that the new clean baseline. */
  loadInputs: (inputs: SessionInputs) => void;

  processingResult: ViewResult | null;
  setProcessingResult: (result: ViewResult | null) => void;

  validationDiagnostics: ValidationDiagnostic[];
  setValidationDiagnostics: (diags: ValidationDiagnostic[]) => void;

  theme: 'light' | 'dark';
  toggleTheme: () => void;

  activeOutputTab: OutputTabId;
  setActiveOutputTab: (tab: OutputTabId) => void;

  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;

  /**
   * The simulator panel the mobile layout shows, one at a time. In the store
   * rather than MobileShell so a jump to an editor line can switch to it.
   */
  mobileView: MobileView;
  setMobileView: (view: MobileView) => void;

  /**
   * The Regex tab's pattern and EXTRACT class name. Held here because the tab
   * unmounts on every sub-tab or output-tab switch, which cleared both.
   */
  regexPattern: string;
  setRegexPattern: (pattern: string) => void;
  regexClassName: string;
  setRegexClassName: (name: string) => void;

  /**
   * The Preview tab's sub-tab and filters, held here for the same reason: the
   * tab unmounts on every output-tab switch and on every phone tab switch,
   * and the whole simulator remounts across the phone breakpoint.
   */
  previewSubTab: PreviewSubTabId;
  setPreviewSubTab: (tab: PreviewSubTabId) => void;
  previewFilters: PreviewFilters;
  /**
   * Change some filters, and go back to the first page, which the narrower
   * set may not reach. `keepPage` is for a correction nobody asked for, such
   * as dropping a field the latest run no longer extracts.
   */
  setPreviewFilters: (patch: Partial<PreviewFilters>, keepPage?: boolean) => void;

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
  /** The pipeline reference's expanded stage, by step number. */
  helpStage: number | null;
  setHelpStage: (step: number | null) => void;
  /** Open the pipeline reference with one stage expanded. */
  openHelpAt: (step: number) => void;

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
    const perEventPipeline = o['perEventPipeline'] === true;
    return {
      perEventPipeline,
      manualApply: perEventPipeline || o['manualApply'] === true,
    };
  } catch {
    return fallback;
  }
}

type OutputTabState = Pick<
  AppState,
  | 'regexPattern' | 'setRegexPattern' | 'regexClassName' | 'setRegexClassName'
  | 'previewSubTab' | 'setPreviewSubTab' | 'previewFilters' | 'setPreviewFilters'
>;

/** What the output tabs keep across unmounting: the Regex tab's input, the Preview tab's sub-tab and filters. */
function outputTabState(set: StoreApi<AppState>['setState']): OutputTabState {
  return {
    regexPattern: '',
    setRegexPattern: (pattern) => set({ regexPattern: pattern }),
    regexClassName: 'custom',
    setRegexClassName: (name) => set({ regexClassName: name }),

    previewSubTab: 'raw',
    setPreviewSubTab: (tab) => set({ previewSubTab: tab }),
    previewFilters: NO_PREVIEW_FILTERS,
    setPreviewFilters: (patch, keepPage = false) =>
      set((state) => ({
        previewFilters: { ...state.previewFilters, ...patch },
        ...(keepPage ? {} : { currentPage: 1 }),
      })),
  };
}

export const useAppStore = create<AppState>((set) => ({
  rawData: '',
  setRawData: (data) => set({ rawData: data, currentPage: 1 }),

  isProcessing: false,
  setIsProcessing: (v) => set({ isProcessing: v }),
  pipelineOnMainThread: false,
  setPipelineOnMainThread: (v) => set({ pipelineOnMainThread: v }),

  metadata: { ...EMPTY_INPUTS.metadata },
  setMetadataField: (field, value) =>
    set((state) => ({
      metadata: { ...state.metadata, [field]: value },
    })),
  setMetadata: (meta) => set({ metadata: meta }),

  propsConf: '',
  setPropsConf: (text) => set({ propsConf: text }),

  transformsConf: '',
  setTransformsConf: (text) => set({ transformsConf: text }),

  loadedInputs: EMPTY_INPUTS,
  // Loading is a decision to look at these inputs, so in manual-apply mode it
  // runs them, as pressing Run would: otherwise an example card or a palette
  // command changes the editors and nothing else (#492).
  loadInputs: (inputs) =>
    set((state) => ({
      rawData: inputs.rawData,
      propsConf: inputs.propsConf,
      transformsConf: inputs.transformsConf,
      metadata: { ...inputs.metadata },
      loadedInputs: inputs,
      currentPage: 1,
      ...(state.settings.manualApply
        ? { manualRunTick: state.manualRunTick + 1, pipelineDirty: false }
        : {}),
    })),

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

  mobileView: 'raw',
  setMobileView: (view) => set({ mobileView: view }),

  ...outputTabState(set),

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
  helpStage: null,
  setHelpStage: (step) => set({ helpStage: step }),
  openHelpAt: (step) => set({ helpOpen: true, helpStage: step }),

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

/**
 * Whether the session holds work that replacing the inputs would lose: an
 * editor or metadata field differs from what was last loaded. Anything that
 * overwrites all the inputs (loading an example, clearing, the
 * beforeunload warning) asks this rather than keeping its own notion of dirty.
 */
export function selectSessionDirty(s: AppState): boolean {
  const base = s.loadedInputs;
  return (
    s.rawData !== base.rawData ||
    s.propsConf !== base.propsConf ||
    s.transformsConf !== base.transformsConf ||
    s.metadata.index !== base.metadata.index ||
    s.metadata.host !== base.metadata.host ||
    s.metadata.source !== base.metadata.source ||
    s.metadata.sourcetype !== base.metadata.sourcetype
  );
}
