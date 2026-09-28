// ---------------------------------------------------------------------------
// effectiveConfig.ts
// Which directive actually applies to an event, and what it beat to get there.
//
// This is the stanza axis of provenance. The layer axis -- `default/` vs
// `local/` -- is resolved during parsing and travels on each ConfDirective as
// `layer` / `overrides` (see docs/engine.md). The two are independent, and both
// have to be answered before "why is this value in effect?" has an answer:
// `local/props.conf` can win the layer contest inside a `[sourcetype]` stanza
// that then loses the stanza contest to a `[source::...]` stanza entirely.
//
// `mergeDirectives` already picks the winners, but it returns bare directives:
// the stanza each came from, and the stanzas that defined the same key and
// lost, are dropped. Those are exactly what `btool ... --debug` prints and
// what makes a precedence surprise legible, so this resolves the same order
// and keeps them.
// ---------------------------------------------------------------------------

import type { ConfDirective, ConfStanza, OverriddenDirective } from '../types';

/** A stanza, named the way the user wrote it, with where to find it. */
export interface StanzaOrigin {
  name: string;
  type: ConfStanza['type'];
  /** First line of the stanza header, for jumping the editor to it. */
  line: number;
  /** Highest-precedence layer defining the stanza. Absent for flat input. */
  layer?: string;
}

/** A definition of a key that lost the stanza contest. */
export interface OverriddenByStanza extends StanzaOrigin {
  /** Line of the losing directive itself, not of its stanza header. */
  directiveLine: number;
  value: string;
}

export interface EffectiveDirective {
  key: string;
  value: string;
  /** Line of the winning directive. */
  line: number;
  /** Layer the winning directive was read from. Absent for flat input. */
  layer?: string;
  /** The stanza that won for this event. */
  stanza: StanzaOrigin;
  /**
   * Definitions of the same key in stanzas that matched this event but lost the
   * precedence contest, in the order they were beaten (nearest rival first). A
   * non-empty list is the case worth showing: the config says two things and
   * only one of them is happening.
   */
  overriddenByStanza: OverriddenByStanza[];
  /**
   * What the winning directive beat *within* its own stanza -- a lower layer, or
   * an earlier repeat of the key in the same file. Carried through from parsing
   * so a consumer has both axes in one row.
   */
  overrides?: OverriddenDirective[];
}

function originOf(stanza: ConfStanza): StanzaOrigin {
  return {
    name: stanza.name,
    type: stanza.type,
    line: stanza.lineRange.start,
    ...(stanza.layer !== undefined ? { layer: stanza.layer } : {}),
  };
}

/**
 * Splunk's rule inside one stanza: the last definition of a key wins. Applied
 * per stanza before the cross-stanza contest, so a stanza that defines a key
 * twice competes with the value it would actually use.
 */
function lastDefinitionPerKey(stanza: ConfStanza): Map<string, ConfDirective> {
  const latest = new Map<string, ConfDirective>();
  for (const directive of stanza.directives) latest.set(directive.key, directive);
  return latest;
}

/**
 * Resolve the effective configuration for an event.
 *
 * `stanzas` must arrive in precedence order, highest first -- which is what
 * `matchStanzas` returns for a given event's metadata. Passing them in any other
 * order produces a confident, wrong answer, so callers should not sort them
 * themselves.
 *
 * The result is ordered by the winning stanza's precedence and then by the line
 * the directive is written on, so reading top to bottom follows the same path
 * Splunk took rather than an arbitrary map iteration.
 */
export function resolveEffectiveConfig(stanzas: ConfStanza[]): EffectiveDirective[] {
  const winners = new Map<string, EffectiveDirective>();

  for (const stanza of stanzas) {
    const origin = originOf(stanza);

    for (const [key, directive] of lastDefinitionPerKey(stanza)) {
      const existing = winners.get(key);

      if (existing === undefined) {
        winners.set(key, {
          key,
          value: directive.value,
          line: directive.line,
          ...(directive.layer !== undefined ? { layer: directive.layer } : {}),
          stanza: origin,
          overriddenByStanza: [],
          ...(directive.overrides !== undefined ? { overrides: directive.overrides } : {}),
        });
        continue;
      }

      // A lower-precedence stanza defining the same key. It has no effect, but
      // it is the thing the user is usually looking at when they ask why their
      // value is being ignored -- so it is recorded rather than discarded.
      existing.overriddenByStanza.push({
        ...origin,
        directiveLine: directive.line,
        value: directive.value,
      });
    }
  }

  const precedence = new Map(stanzas.map((s, i) => [s.name, i]));
  return Array.from(winners.values()).sort((a, b) => {
    const byStanza = (precedence.get(a.stanza.name) ?? 0) - (precedence.get(b.stanza.name) ?? 0);
    return byStanza !== 0 ? byStanza : a.line - b.line;
  });
}

/**
 * The subset whose value is contested across stanzas. This is the answer to
 * "what is surprising here?", which is a different question from "what is in
 * effect?" and worth asking separately.
 */
export function contestedDirectives(effective: EffectiveDirective[]): EffectiveDirective[] {
  return effective.filter((d) => d.overriddenByStanza.length > 0);
}
