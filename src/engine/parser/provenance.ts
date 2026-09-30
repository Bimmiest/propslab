/**
 * Helpers for pointing a diagnostic at the place in the config it came from.
 *
 * With a single flat conf a `line` alone locates a problem. Once the conf is
 * read as layers (`default/props.conf` then `local/props.conf`) it does not:
 * both files have a line 7, and a consumer told only "props.conf line 7" cannot
 * open the right one. Every diagnostic derived from a directive or stanza
 * therefore carries that element's `layer` alongside its line.
 *
 * The layer key is omitted entirely (rather than set to `undefined`) for
 * unlayered input, so diagnostics from a flat parse are byte-for-byte what they
 * have always been.
 */

import type { ConfDirective, ConfStanza } from '../types';

type Position = { line?: number; layer?: string };

/** Spread into a diagnostic to locate it at `directive`. */
export function atDirective(directive: Pick<ConfDirective, 'line' | 'layer'> | undefined): Position {
  if (!directive) return {};
  return directive.layer === undefined ? { line: directive.line } : { line: directive.line, layer: directive.layer };
}

/** Spread into a diagnostic to locate it at the start of `stanza`. */
export function atStanza(stanza: Pick<ConfStanza, 'lineRange' | 'layer'>): Position {
  return stanza.layer === undefined
    ? { line: stanza.lineRange.start }
    : { line: stanza.lineRange.start, layer: stanza.layer };
}
