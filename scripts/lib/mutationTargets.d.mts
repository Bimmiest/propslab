// The one hand-written declaration left in scripts/ (#575). The other scripts'
// types come from their JSDoc through allowJs, but mutationTargets.mjs imports
// stryker.config.mjs, which needs Node's types, and the app project that
// type-checks the tests has none. Keep it in step with mutationTargets.mjs.
export const MUTATE_GLOBS: string[];
export function selectMutated(files: string[], globs: string[]): string[];
export function isTestFile(file: string): boolean;
export function importedSources(testFile: string, source: string, exists: (path: string) => boolean): string[];
