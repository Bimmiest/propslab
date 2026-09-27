import type { SplunkEvent, ConfDirective, DirectiveNoOp, ValidationDiagnostic } from '../types';
import { safeRegex, convertSplunkToJsRegex, validateRegex } from '../../utils/splunkRegex';
import { longestPartialMatch, type NoOpReason } from '../noOpExplainer';
import { isInternalField } from '../utils/internalFields';
import { byClassName } from '../utils/asciiCompare';
import { unquoteFieldName } from '../utils/fieldRef';
import { getMetadataField } from '../utils/metadataFields';
import { getField, hasField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';

/**
 * @param captureOffsets Compile with `'d'` so positional extractions record the
 *   capture spans that `fieldOffsets` — and therefore the highlighter — needs.
 *   Defaults to `true`, which is what the browser wants.
 *
 *   A caller that renders no highlights should pass `false`, because the flag
 *   is not free off the browser. V8 can abandon backtracking mid-match and
 *   finish on its linear-time engine under
 *   `--enable-experimental-regexp-engine-on-excessive-backtracks`, but that
 *   engine **cannot compile a regex carrying `d`, `i` or `u`**. Compiling every
 *   EXTRACT with `'d'` therefore puts the largest user-controlled regex surface
 *   the engine has outside what the fallback can bound.
 *
 *   This narrows the unbounded surface; it does not remove it. The fallback is
 *   Node-only (a web page cannot set the flag), and a pattern still declines it
 *   if it uses lookahead or a backreference — both ordinary in Splunk regexes.
 *   A caller executing hostile patterns still needs a terminable thread.
 */
export function extractFields(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
  captureOffsets: boolean = true,
): SplunkEvent[] {
  const extractDirectives = directives
    .filter((d) => d.directiveType === 'EXTRACT')
    .sort(byClassName);

  if (extractDirectives.length === 0) return events;

  const extractions = extractDirectives.map((dir) => {
    const { pattern, sourceField } = parseExtractValue(dir.value);
    const jsPattern = pattern ? convertSplunkToJsRegex(pattern) : null;
    // 'd' records capture offsets for positional extractions, and is requested
    // only when the caller will read them (see `captureOffsets`). NOT global:
    // inline EXTRACT extracts the FIRST match only (max_match defaults to 1);
    // multivalue extraction requires a transforms.conf REGEX with MV_ADD, which
    // EXTRACT lacks.
    const regex = jsPattern ? safeRegex(jsPattern, captureOffsets ? 'd' : undefined) : null;
    // safeRegex returns null for invalid PCRE-isms AND for patterns the ReDoS
    // heuristic refuses. Either way the extraction is silently skipped, so surface it.
    if (jsPattern && !regex && diagnostics) {
      diagnostics.push({
        level: 'warning',
        message: `EXTRACT-${dir.className ?? ''} was skipped: its pattern could not be compiled safely (invalid regex or rejected as ReDoS-prone). No fields were extracted.`,
        file: 'props.conf',
        ...atDirective(dir),
        directiveKey: dir.key,
      });
    }
    return { directive: dir, regex, sourceField };
  });

  const reportedStrippedRefs = new Set<string>();

  return events.map((event) => {
    const newFields = { ...event.fields };
    const newOffsets: Record<string, Array<[number, number]>> = { ...(event.fieldOffsets ?? {}) };
    let offsetsChanged = false;
    const traces: SplunkEvent['processingTrace'] = [];

    // Every directive that reaches a `continue` below changed nothing, which is
    // the case the preview has never explained (#84).
    const noOps: DirectiveNoOp[] = [];
    const noteNoOp = (dir: ConfDirective, reason: NoOpReason) => {
      noOps.push({
        directive: dir.key,
        file: 'props.conf',
        line: dir.line,
        phase: 'search-time',
        reason,
      });
    };

    for (const extraction of extractions) {
      if (!extraction.regex) {
        const { pattern } = parseExtractValue(extraction.directive.value);
        noteNoOp(extraction.directive, {
          kind: 'regex-invalid',
          error: validateRegex(pattern) ?? 'refused by the ReDoS guard — it can backtrack catastrophically',
        });
        continue;
      }

      const sourceValue = extraction.sourceField
        ? getFieldValue(event, extraction.sourceField)
        : event._raw;
      // Offsets only authoritative when extracting from _raw — a captured position in a
      // derived source field cannot be translated back to _raw coordinates reliably.
      const isPositional = !extraction.sourceField;

      if (!sourceValue) {
        if (
          diagnostics &&
          extraction.sourceField &&
          extraction.sourceField.startsWith('_') &&
          !isInternalField(extraction.sourceField) &&
          !reportedStrippedRefs.has(extraction.sourceField)
        ) {
          const stripped = extraction.sourceField.replace(/^_+/, '');
          if (stripped && hasField(event.fields, stripped)) {
            reportedStrippedRefs.add(extraction.sourceField);
            diagnostics.push({
              level: 'warning',
              message: `EXTRACT-${extraction.directive.className ?? ''} references source field "${extraction.sourceField}", but index-time extractions strip leading underscores — Splunk will resolve this as "${stripped}".`,
              file: 'props.conf',
              ...atDirective(extraction.directive),
              directiveKey: extraction.directive.key,
              suggestion: `Replace "in ${extraction.sourceField}" with "in ${stripped}"`,
            });
          }
        }
        noteNoOp(extraction.directive, {
          kind: 'source-key-empty',
          sourceKey: extraction.sourceField ?? '_raw',
        });
        continue;
      }

      // Inline EXTRACT takes the first match only.
      const m = extraction.regex.exec(sourceValue);
      if (!m || !m.groups) {
        const { pattern } = parseExtractValue(extraction.directive.value);
        const partial = longestPartialMatch(pattern, sourceValue);
        noteNoOp(
          extraction.directive,
          partial
            ? { kind: 'no-match', partialEnd: partial.end, partialPattern: partial.prefix }
            : { kind: 'no-match' },
        );
        continue;
      }
      const indices = isPositional
        ? (m as RegExpExecArray & { indices?: { groups?: Record<string, [number, number] | undefined> } }).indices?.groups
        : undefined;

      const added: string[] = [];
      const alreadySet: string[] = [];
      for (const [name, value] of Object.entries(m.groups)) {
        if (value === undefined) continue;
        // First-wins (simplification — SEM-12): this engine keeps the value from
        // the first extraction and discards later ones for the same field name.
        // Real Splunk's behaviour when two search-time extractions yield the same
        // field is closer to producing a multivalue field; verify against a live
        // indexer before relying on the collision outcome here.
        if (hasField(newFields, name)) {
          alreadySet.push(name);
          continue;
        }
        setField(newFields, name, value);
        added.push(name);
        const span = indices?.[name];
        if (span) {
          setField(newOffsets, name, [[span[0], span[1]]]);
          offsetsChanged = true;
        }
      }

      if (added.length > 0) {
        traces.push({
          processor: `EXTRACT-${extraction.directive.className ?? ''}`,
          phase: 'search-time',
          description: `Extracted fields: ${added.join(', ')}`,
          fieldsAdded: added,
        });
      } else if (alreadySet.length > 0) {
        // It matched and still produced nothing, which looks identical in the
        // preview to a pattern that never matched at all.
        noteNoOp(extraction.directive, { kind: 'fields-already-set', fields: alreadySet });
      }
    }

    return {
      ...event,
      fields: newFields,
      ...(offsetsChanged ? { fieldOffsets: newOffsets } : {}),
      processingTrace: [...event.processingTrace, ...traces],
      ...(noOps.length > 0 ? { noOps: [...(event.noOps ?? []), ...noOps] } : {}),
    };
  });
}

export function parseExtractValue(value: string): { pattern: string; sourceField?: string } {
  const trimmed = value.trim();
  // Greedy match: consume as much as possible before the last " in <field>" suffix.
  // This avoids mis-splitting on regex bodies that contain the word "in". The source
  // field may be single/double-quoted so a nested-JSON name with a period survives
  // as one token (Splunk requires quoting for such names); strip the quotes here.
  const inMatch = trimmed.match(/^([\s\S]+)\s+in\s+('[^']*'|"[^"]*"|[\w.]+)\s*$/);
  if (inMatch) {
    return { pattern: inMatch[1] ?? '', sourceField: unquoteFieldName(inMatch[2] ?? '') };
  }
  return { pattern: trimmed };
}

function getFieldValue(event: SplunkEvent, fieldName: string): string | undefined {
  if (fieldName === '_raw') return event._raw;
  const val = getField(event.fields, fieldName);
  if (Array.isArray(val)) return val[0];
  // `EXTRACT-app = …(?<app>\w+)… in source` is a staple TA idiom: host/source/
  // sourcetype/index are default fields at search time, so extraction can run
  // against them without anything having extracted them first.
  if (val === undefined) return getMetadataField(event, fieldName);
  return val;
}
