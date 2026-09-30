// ---------------------------------------------------------------------------
// makeEvent.ts
// The one SplunkEvent literal the tests share (#507).
//
// Fifty-odd test files each carried their own copy of this object, so adding a
// required field to SplunkEvent meant editing all of them, and each copy drifted
// (`lineNumbers` 0/0 here, 1/1 there; a different host). A test that cares about
// a field passes it; everything else is the same neutral event everywhere.
// ---------------------------------------------------------------------------

import type { SplunkEvent } from '../engine/types';

/**
 * A SplunkEvent with the given raw text, and any other field overridden.
 * Nested objects (`metadata`, `lineNumbers`) are replaced, not merged: pass the
 * whole value, so the event a test builds is the one it reads.
 */
export function makeEvent(raw = '', over: Partial<SplunkEvent> = {}): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
    ...over,
  };
}
