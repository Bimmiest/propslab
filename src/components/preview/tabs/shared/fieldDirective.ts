// ---------------------------------------------------------------------------
// fieldDirective.ts
// The props.conf directive that made a field, for a field menu's "Jump to
// config" (#745), and the FIELDALIAS line its "Create FIELDALIAS…" writes.
// ---------------------------------------------------------------------------

import { parseConf } from '../../../../engine/parser/confParser';
import { resolveStanzasForEvent } from '../../../../engine/parser/stanzaMatcher';
import { resolveEffectiveConfig } from '../../../../engine/parser/effectiveConfig';
import { fieldNameNeedsQuoting, unquoteFieldName } from '../../../../engine/utils/fieldRef';
import type { EventMetadata } from '../../../../engine/types';
import type { ViewEvent } from '../../../../utils/viewResult';
import { useAppStore } from '../../../../store/useAppStore';

/** The processors of the steps that added `field`, read from the first event that has it. */
export function processorsOf(field: string, events: readonly ViewEvent[]): string[] {
  const event = events.find((e) => Object.hasOwn(e.fields, field));
  if (!event) return [];
  return event.processingTrace.filter((s) => s.fieldsAdded?.includes(field)).map((s) => s.processor);
}

const ALIAS_TARGET = /\bAS(?:NEW)?\s+('[^']*'|"[^"]*"|\S+)/gi;

/** Whether `key = value` is a directive that can have made `field` in a step named `processor`. */
function made(processor: string, field: string, key: string, value: string): boolean {
  // A step is named for its key, with a detail after it: `KV_MODE(json)`,
  // `INDEXED_EXTRACTIONS(csv)`, `REPORT-x:stanza`. EVAL and FIELDALIAS steps
  // cover every directive of their kind, so the field picks the directive.
  const base = (processor.replace(/\(.*\)$/, '').split(':')[0] ?? '').toUpperCase();
  const k = key.toUpperCase();
  if (base === 'EVAL') return k === `EVAL-${field.toUpperCase()}`;
  if (base === 'FIELDALIAS') {
    return (
      k.startsWith('FIELDALIAS-') &&
      [...value.matchAll(ALIAS_TARGET)].some((m) => unquoteFieldName(m[1] ?? '') === field)
    );
  }
  return k === base;
}

/**
 * The line of the directive in effect that made `field`, or null when none
 * did: a default (KV_MODE = auto with no line of its own), the metadata, or a
 * processor props.conf does not name. `metadata` is tried in order.
 */
export function fieldDirectiveLine(
  field: string,
  processors: readonly string[],
  propsConf: string,
  metadata: readonly EventMetadata[],
): number | null {
  if (processors.length === 0) return null;
  const { stanzas } = parseConf(propsConf, 'props.conf');
  for (const meta of metadata) {
    const effective = resolveEffectiveConfig(resolveStanzasForEvent(stanzas, meta).stanzas);
    for (const processor of processors) {
      const hit = effective.find((d) => made(processor, field, d.key, d.value));
      if (hit) return hit.line;
    }
  }
  return null;
}

/**
 * `fieldDirectiveLine` against the editor's props.conf, whose lines the jump
 * lands on, and the run's metadata. Read when a menu opens rather than
 * subscribed: each row has a menu, and subscribed to props.conf every row
 * would render again on each keystroke.
 */
export function currentFieldDirectiveLine(field: string, sources?: Iterable<string>): number | null {
  const { propsConf, metadata, processingResult } = useAppStore.getState();
  const processors = sources ? [...sources] : processorsOf(field, processingResult?.events ?? []);
  const input = processingResult?.inputMetadata ?? metadata;
  const renamed = processingResult?.renamedSourcetype;
  // Search-time directives come from the rename target's stanza (ADR 0002).
  const metas = renamed ? [{ ...input, sourcetype: renamed }, input] : [input];
  return fieldDirectiveLine(field, processors, propsConf, metas);
}

/** A field name as a directive references it: quoted when it has a character outside [A-Za-z0-9_]. */
export const fieldRef = (name: string) => (fieldNameNeedsQuoting(name) ? `'${name}'` : name);

/** The FIELDALIAS directive that gives `source` the name `alias`. */
export function fieldAliasDirective(source: string, alias: string): { key: string; value: string } {
  return {
    key: `FIELDALIAS-${alias.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    value: `${fieldRef(source)} AS ${fieldRef(alias)}`,
  };
}
