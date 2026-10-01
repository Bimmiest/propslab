/**
 * Punct Annotator
 *
 * Simulates ANNOTATE_PUNCT: Splunk's annotation processor indexes a `punct`
 * field holding the event's punctuation signature, used to find structurally
 * similar events. It runs in the typing pipeline after regex replacement, so
 * the signature reflects the event as indexed — after SEDCMD and index-time
 * transforms have rewritten `_raw`.
 *
 * The signature rules follow observed Splunk behaviour:
 *  - letters and digits are dropped, every other character survives in order;
 *  - a space becomes `_`;
 *  - a tab becomes the literal letter `t`, and a newline is dropped entirely —
 *    not what the widely-repeated `\t`/`\n` escape-sequence folklore says;
 *  - the signature caps at exactly 50 characters.
 *
 * Carriage returns are dropped like newlines, by analogy with them rather than
 * from an observation of their own.
 */

import type { ConfDirective, SplunkEvent } from '../types';
import { setField } from '../utils/fieldBag';
import { effectiveBool } from '../utils/directiveValues';
import type { RunContext } from '../runContext';

const PUNCT_MAX_LENGTH = 50;

/** Build the punctuation signature for one event's `_raw`. */
export function buildPunct(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (out.length >= PUNCT_MAX_LENGTH) break;
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) continue;
    if (ch === ' ') out += '_';
    else if (ch === '\t') out += 't';
    else if (ch === '\n' || ch === '\r') continue;
    else out += ch;
  }
  return out;
}

/** Takes the run context like every stage, though punct reads nothing from it and reports nothing. */
export function annotatePunct(events: SplunkEvent[], directives: ConfDirective[], _ctx: RunContext): SplunkEvent[] {
  // Splunk's default is true; only an explicit false disables the field.
  if (!effectiveBool(directives, 'ANNOTATE_PUNCT', true)) return events;

  return events.map((event) => {
    const punct = buildPunct(event._raw);
    const fields = { ...event.fields };
    setField(fields, 'punct', punct);
    return {
      ...event,
      fields,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'ANNOTATE_PUNCT',
          phase: 'index-time' as const,
          description: `Annotated punctuation signature punct="${punct}"`,
          fieldsAdded: ['punct'],
        },
      ],
    };
  });
}
