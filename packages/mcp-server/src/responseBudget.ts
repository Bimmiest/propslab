/**
 * One size budget for every tool's response (#414), counted in what the
 * server actually writes: UTF-8 bytes of the JSON-RPC line on stdout.
 *
 * A success carries its payload twice — as `structuredContent`, and as the
 * compact JSON of the same object in the text block, where that JSON is a
 * string and so escaped again (every `"` and `\` doubles). Counting UTF-16
 * characters of one copy undercounted by more than five times for non-ASCII
 * or quote-heavy output. With the text copy compact, both copies are exact
 * functions of the payload's compact JSON, and so is each array element's
 * share of them, so the lists can be cut to fit without trial serialization.
 *
 * The bounding runs in the sandbox worker wherever the payload is built
 * there, so an oversized result never crosses to the server's thread.
 */
import type { ValidationDiagnostic } from '../../../src/engine/types';
import type { ExplainResponse, ExplainStanza, ValidateResponse } from './protocol';

/**
 * Largest response line, envelope included. Below the 10 MiB beyond which
 * the SDK's client drops a line, and room for one event of the full 1M-character
 * sample in both copies even when every character is three bytes of CJK.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Held back from the payload for the JSON-RPC envelope around it:
 * `{"result":{"content":[{"type":"text","text":…}],"structuredContent":…},
 * "jsonrpc":"2.0","id":…}` and an ordinary request id.
 */
const ENVELOPE_BYTES = 4 * 1024;

/** What the payload itself may take of `MAX_RESPONSE_BYTES`. */
export const MAX_PAYLOAD_BYTES = MAX_RESPONSE_BYTES - ENVELOPE_BYTES;

/**
 * Bytes a piece of compact JSON costs across both copies: itself, plus itself
 * again as string content with its quotes and backslashes escaped. Compact
 * JSON holds no raw control characters (JSON.stringify escaped them), so
 * nothing else grows on the second pass.
 */
function wireBytes(json: string): number {
  let escapes = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) escapes++;
  }
  return 2 * Buffer.byteLength(json) + escapes;
}

/** Bytes a payload whose compact JSON is `json` costs: both copies, and the text's quotes. */
export const jsonResponseBytes = (json: string): number => wireBytes(json) + 2;

export const responseBytes = (payload: unknown): number =>
  jsonResponseBytes(JSON.stringify(payload));

/** Bytes one array element adds to a response: its JSON in both copies, plus a comma in each. */
export const elementBytes = (value: unknown): number => wireBytes(JSON.stringify(value)) + 2;

/** How many leading items fit in `budget`, given each one's cost, and what they cost. */
function fit<T>(
  items: readonly T[],
  cost: (item: T) => number,
  budget: number,
): { count: number; used: number } {
  let used = 0;
  let count = 0;
  for (const item of items) {
    const next = used + cost(item);
    if (next > budget) break;
    used = next;
    count++;
  }
  return { count, used };
}

/** How many leading items fit in `budget`, given each one's cost. */
export function fitting<T>(items: readonly T[], cost: (item: T) => number, budget: number): number {
  return fit(items, cost, budget).count;
}

/** The sentence a cut list contributes to a `truncationNote`. */
export const cutNote = (what: string, kept: number, total: number): string =>
  `Only the first ${kept} of ${total} ${what} are returned.`;

export const CAP_NOTE = `The response is capped at ${MAX_RESPONSE_BYTES} bytes.`;

/**
 * A running budget, measured after the response's fixed parts are paid for
 * with every truncation count and note in place — so adding them once the
 * cuts are known cannot tip the total. The shell's notes say "first 0 of N";
 * the slack covers the digits the real kept counts add.
 */
class Budget {
  constructor(private left: number) {}

  /** How many leading items to keep, spending at most `share` of what is left. */
  take<T>(items: readonly T[], share = 1): number {
    const { count, used } = fit(items, elementBytes, this.left * share);
    this.left -= used;
    return count;
  }

  /** Spend `bytes` if they fit. */
  spend(bytes: number): boolean {
    if (bytes > this.left) return false;
    this.left -= bytes;
    return true;
  }
}

const NOTE_DIGITS_SLACK = 256;

const budgetAfter = (shell: object) =>
  new Budget(MAX_PAYLOAD_BYTES - NOTE_DIGITS_SLACK - responseBytes(shell));

/**
 * A response with one list, cut to fit: `build(kept)` makes the response
 * with the first `kept` items, adding its count and note when some are cut.
 */
export function cutToFit<T, R extends object>(items: readonly T[], build: (kept: number) => R): R {
  return build(budgetAfter(build(0)).take(items));
}

export function boundValidate(diagnostics: ValidationDiagnostic[]): ValidateResponse {
  const total = diagnostics.length;
  return cutToFit(diagnostics, (kept) =>
    kept < total
      ? {
          diagnostics: diagnostics.slice(0, kept),
          diagnosticCount: total,
          truncationNote: `${cutNote('diagnostics', kept, total)} ${CAP_NOTE}`,
        }
      : { diagnostics },
  );
}

/**
 * Cuts, in order of what the agent asked: parse errors take at most a quarter
 * of the budget, the resolution (when requested) at most half of what is
 * left, and stanzas the rest. The last stanza returned may carry only some of
 * its directives, with `directiveCount` saying how many it has.
 */
export function boundExplain(full: ExplainResponse): ExplainResponse {
  const { parseErrors, stanzas, resolution } = full;
  const matched = resolution?.matchedStanzas ?? [];
  const effective = resolution?.effectiveDirectives ?? [];

  const build = (k: {
    parseErrors: number;
    stanzas: ExplainStanza[];
    matched: number;
    effective: number;
    /** Directives the last stanza kept, and of how many, when it was cut. */
    partial?: [number, number];
  }): ExplainResponse => {
    const notes: string[] = [];
    const count = <K extends string>(key: K, kept: number, total: number, what: string) => {
      if (kept >= total) return {};
      notes.push(cutNote(what, kept, total));
      return { [key]: total } as Record<K, number>;
    };
    const response: ExplainResponse = {
      parseErrors: parseErrors.slice(0, k.parseErrors),
      stanzas: k.stanzas,
      ...count('parseErrorCount', k.parseErrors, parseErrors.length, 'parse errors'),
      ...count('stanzaCount', k.stanzas.length, stanzas.length, 'stanzas'),
    };
    if (k.partial) {
      notes.push(
        `The last stanza returned carries only its first ${k.partial[0]} of ${k.partial[1]} ` +
          'directives (directiveCount).',
      );
    }
    if (resolution) {
      response.resolution = {
        ...resolution,
        matchedStanzas: matched.slice(0, k.matched),
        effectiveDirectives: effective.slice(0, k.effective),
        ...count('matchedStanzaCount', k.matched, matched.length, 'matched stanzas'),
        ...count('effectiveDirectiveCount', k.effective, effective.length, 'effective directives'),
      };
    }
    if (notes.length > 0) response.truncationNote = `${notes.join(' ')} ${CAP_NOTE}`;
    return response;
  };

  // Every cut at once is the longest the fixed parts can be.
  const mostDirectives = stanzas.reduce((n, s) => Math.max(n, s.directives.length), 0);
  const budget = budgetAfter({
    ...build({
      parseErrors: 0,
      stanzas: [],
      matched: 0,
      effective: 0,
      partial: [mostDirectives, mostDirectives],
    }),
    parseErrorCount: parseErrors.length,
    stanzaCount: stanzas.length,
    ...(resolution
      ? {
          resolution: {
            ...resolution,
            matchedStanzas: [],
            effectiveDirectives: [],
            matchedStanzaCount: matched.length,
            effectiveDirectiveCount: effective.length,
          },
        }
      : {}),
  });

  const keptErrors = budget.take(parseErrors, 0.25);
  const keptMatched = budget.take(matched, 0.25);
  const keptEffective = budget.take(effective, 0.5);

  const kept: ExplainStanza[] = [];
  let partial: [number, number] | undefined;
  for (const stanza of stanzas) {
    const shell = { ...stanza, directives: [], directiveCount: stanza.directives.length };
    if (!budget.spend(elementBytes(shell))) break;
    const n = budget.take(stanza.directives);
    if (n === stanza.directives.length) {
      kept.push(stanza);
      continue;
    }
    // A stanza with none of its directives says nothing the count does not.
    if (n === 0) break;
    kept.push({
      ...stanza,
      directives: stanza.directives.slice(0, n),
      directiveCount: stanza.directives.length,
    });
    partial = [n, stanza.directives.length];
    break;
  }

  return build({
    parseErrors: keptErrors,
    stanzas: kept,
    matched: keptMatched,
    effective: keptEffective,
    ...(partial ? { partial } : {}),
  });
}
