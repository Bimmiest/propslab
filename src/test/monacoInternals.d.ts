// Monaco ships no declarations for its internal modules. The tests reach two of
// them, through src/test/monacoRegistry.ts, to read the provider registries of
// the real editor -- the public API can register a provider but not count them.

declare module 'monaco-editor/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { get(serviceId: unknown): unknown };
}

declare module 'monaco-editor/editor/common/services/languageFeatures.js' {
  export const ILanguageFeaturesService: unknown;
}
