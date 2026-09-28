// A worker entry loads the regex engine with `fetch`, which Node cannot point
// at a file. These stand in for the asset server: the real module's bytes, or
// a failed load.
import { vi } from 'vitest';

declare const __PCRE2_WASM_PATH__: string;
type GetBuiltinModule = (id: 'node:fs') => { readFileSync(path: string): Uint8Array<ArrayBuffer> };

/** Serve the real pcre2.wasm to every `fetch`, as the static host would. */
export function stubWasmFetch(): void {
  const { getBuiltinModule } = (globalThis as unknown as { process: { getBuiltinModule: GetBuiltinModule } }).process;
  const bytes = getBuiltinModule('node:fs').readFileSync(__PCRE2_WASM_PATH__);
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response(bytes, { headers: { 'content-type': 'application/wasm' } })),
  );
}

/** Fail every `fetch`, as a missing or blocked asset would. */
export function stubFailingWasmFetch(): void {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('asset unavailable')));
}
