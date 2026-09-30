export const FORBIDDEN: RegExp;
export function staticImports(source: string): string[];
export function resolveImport(file: string, spec: string): string;
export function checkEntryGraph(
  html: string,
  readSource: (file: string) => string | null,
): { problems: string[]; seen: string[] };
