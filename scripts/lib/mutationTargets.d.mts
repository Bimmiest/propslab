export const MUTATE_GLOBS: string[];
export function selectMutated(files: string[], globs: string[]): string[];
export function isTestFile(file: string): boolean;
export function importedSources(testFile: string, source: string, exists: (path: string) => boolean): string[];
