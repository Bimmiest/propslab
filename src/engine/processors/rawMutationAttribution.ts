import type { ConfDirective, ParsedConf, ProcessingStep, SplunkEvent } from '../types';
import { extractFields } from './fieldExtractor';
import { applyTransforms } from './transformsProcessor';
import { applyKvMode } from './kvMode';
import { getField } from '../utils/fieldBag';
import { replayContext, type RunContext } from '../runContext';

type FieldBag = Record<string, string | string[]>;

/**
 * Attribute each index-time rewrite of `_raw` to the fields it changed or destroyed.
 *
 * SEDCMD and DEST_KEY = _raw operate on text. Neither takes a field, and neither
 * can name what it hit — the association between "these characters changed" and
 * "this field lost its value" is not a fact either processor holds. It exists
 * only as a comparison, and the extraction rules that make the comparison
 * possible do not run until search time, after both have already finished.
 *
 * So attribution is counterfactual: extract from the text as it was before the
 * rewrite, extract from the text as it was after, and diff the two field bags.
 * Anything else is guesswork from the raw text, which cannot separate two fields
 * that share a region (`pair=123-45-6789 tail=6789` — a text diff blames both).
 *
 * Only the extractors that read `_raw` are replayed: EXTRACT, REPORT, and
 * KV_MODE. FIELDALIAS and EVAL derive from *other fields*, so replaying them
 * would report calculated fields as modified whenever their inputs shifted —
 * true, but it buries the field the rule actually hit. Cascade effects are a
 * separate question from "what did this substitution destroy".
 *
 * Both sides of the diff start from the same empty field bag, so the missing
 * index-time fields (INDEXED_EXTRACTIONS, WRITE_META) distort neither side
 * relative to the other.
 */
export function attributeRawMutations(
  events: SplunkEvent[],
  resolveDirectives: (event: SplunkEvent, index: number) => ConfDirective[],
  transformsConf: ParsedConf,
  ctx: RunContext,
): SplunkEvent[] {
  const replay = replayContext(ctx);
  return events.map((event, index) => {
    const mutations = event.rawMutations;
    if (!mutations || mutations.length === 0) return strip(event);

    const directives = resolveDirectives(event, index);
    // Consecutive mutations share a string (one's "after" is the next one's
    // "before"), so memoising by raw text roughly halves the replay cost.
    const cache = new Map<string, FieldBag>();
    const extract = (raw: string): FieldBag => {
      const hit = cache.get(raw);
      if (hit) return hit;
      const fields = extractFromRaw(event, raw, directives, transformsConf, replay);
      cache.set(raw, fields);
      return fields;
    };

    const trace = [...event.processingTrace];
    for (const mutation of mutations) {
      const step = trace[mutation.traceIndex];
      if (!step) continue;
      trace[mutation.traceIndex] = {
        ...step,
        ...diffFields(extract(mutation.rawBefore), extract(mutation.rawAfter)),
      };
    }

    return strip({ ...event, processingTrace: trace });
  });
}

/**
 * Run the `_raw`-reading extractors over a hypothetical version of the event.
 * Diagnostics are deliberately dropped (`replay` reports nowhere): this is a
 * replay of rules that already reported themselves on the real pass, and
 * re-reporting would duplicate every warning once per mutation.
 */
function extractFromRaw(
  event: SplunkEvent,
  raw: string,
  directives: ConfDirective[],
  transformsConf: ParsedConf,
  replay: RunContext,
): FieldBag {
  const probe: SplunkEvent = {
    ...event,
    _raw: raw,
    fields: {},
    fieldOffsets: undefined,
    fieldSourceKeys: undefined,
    processingTrace: [],
    rawMutations: undefined,
  };
  let probed = [probe];
  try {
    // The replay context declines capture offsets: this probe returns `fields`
    // alone and starts from `fieldOffsets: undefined`, so every span the 'd'
    // flag would compute here is discarded.
    probed = extractFields(probed, directives, replay);
    probed = applyTransforms(probed, directives, transformsConf, 'search-time', replay);
    probed = applyKvMode(probed, directives, replay);
  } catch {
    // A replay that throws yields no attribution for this mutation rather than
    // failing the pipeline — the real pass already surfaced the error.
    return {};
  }
  return probed[0]?.fields ?? {};
}

function diffFields(before: FieldBag, after: FieldBag): Pick<ProcessingStep, 'fieldsModified' | 'fieldsRemoved'> {
  const fieldsModified: string[] = [];
  const fieldsRemoved: string[] = [];

  for (const [name, value] of Object.entries(before)) {
    const afterValue = getField(after, name);
    if (afterValue === undefined) {
      fieldsRemoved.push(name);
    } else if (!valuesEqual(value, afterValue)) {
      fieldsModified.push(name);
    }
  }

  // Always set both, including when empty: "this rewrite touched no extracted
  // field" is a real answer, and the acceptance criteria distinguish it from a
  // spurious attribution.
  return { fieldsModified, fieldsRemoved };
}

function valuesEqual(a: string | string[], b: string | string[]): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [a];
    const right = Array.isArray(b) ? b : [b];
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
  return a === b;
}

/** Drop the transient mutation record so it never reaches a caller. */
function strip(event: SplunkEvent): SplunkEvent {
  if (!event.rawMutations) return event;
  const { rawMutations: _rawMutations, ...rest } = event;
  return rest;
}
