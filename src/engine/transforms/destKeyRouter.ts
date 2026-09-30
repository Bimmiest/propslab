import type { SplunkEvent } from '../types';
import type { TransformResult } from './regexTransform';
import { addFieldValue } from '../utils/fieldBag';
import { dateFromEpochSeconds } from '../utils/epochTime';

/**
 * `meta` with the `key::value` pairs of a DEST_KEY = _meta FORMAT added.
 *
 * The pairs are space-separated. Values may be quoted to contain spaces
 * (key::"two words"), so parse with quote awareness rather than a naive
 * whitespace split that would break a quoted value apart. Indexed fields are
 * multivalue, so a repeated key (`tag::a tag::b`, or one pair per REPEAT_MATCH
 * match) keeps every value rather than the last. `_queue` is the event's
 * single-valued routing slot, not an indexed field, so a `_queue::` pair is
 * not written into it: only DEST_KEY = queue routes.
 */
function withMetaPairs(meta: SplunkEvent['_meta'], destValue: string): SplunkEvent['_meta'] {
  const out = { ...meta };
  const pairRe = /(\S+?)::(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(destValue)) !== null) {
    const key = m[1];
    if (key !== undefined && key !== '_queue') addFieldValue(out, key, m[2] ?? m[3] ?? '');
  }
  return out;
}

export function applyDestKey(
  event: SplunkEvent,
  result: TransformResult,
  /** Called with a DEST_KEY = _time value no Date can hold; `_time` is kept. */
  onTimeOutOfRange?: (value: string) => void,
): SplunkEvent {
  if (!result.matched || result.destKey === undefined || result.destValue === undefined) {
    // No routing, just add extracted fields.
    // Test for `undefined` rather than falsiness: a FORMAT that legitimately
    // expands to "" (e.g. blanking _raw, or anonymising a field to empty) must
    // still route — only an absent destKey/destValue means "no routing".
    return {
      ...event,
      fields: { ...event.fields, ...result.fields },
    };
  }

  // Normalise _MetaData:X → MetaData:X (Splunk alias).
  // Only strip the leading _ when followed by "MetaData:" — never strip from
  // built-in keys like _raw, _meta, _time.
  const destKey = result.destKey.replace(/^_(?=MetaData:)/i, '');
  const destValue = result.destValue;

  switch (destKey) {
    case '_raw':
      return { ...event, _raw: destValue, fields: { ...event.fields, ...result.fields } };

    case '_meta':
      return { ...event, _meta: withMetaPairs(event._meta, destValue), fields: { ...event.fields, ...result.fields } };

    case '_time': {
      const epoch = parseFloat(destValue);
      const time = isNaN(epoch) ? null : dateFromEpochSeconds(epoch);
      if (!time && !isNaN(epoch)) onTimeOutOfRange?.(destValue);
      return {
        ...event,
        _time: time ?? event._time,
        fields: { ...event.fields, ...result.fields },
      };
    }

    case 'queue':
      // DEST_KEY = queue just writes the queue value onto the event. It is NOT
      // a final decision: a later transform in the same list can overwrite it
      // (last-wins), which is the basis of the canonical "drop everything except
      // X" pattern (setnull → nullQueue on .*, then setparsing → indexQueue on
      // the keepers). Record the value and let the transform list run to
      // completion; the caller decides what a final `nullQueue` means.
      return {
        ...event,
        _meta: { ...event._meta, _queue: destValue },
        fields: { ...event.fields, ...result.fields },
      };

    case 'MetaData:Host':
      // Splunk requires FORMAT to include "host::" prefix; without it the update is silently skipped.
      if (!destValue.startsWith('host::')) {
        return { ...event, fields: { ...event.fields, ...result.fields } };
      }
      return {
        ...event,
        metadata: { ...event.metadata, host: destValue.slice('host::'.length) },
        fields: { ...event.fields, ...result.fields },
      };

    case 'MetaData:Index':
      // Unlike the three keys around it, the index key takes the BARE index name
      // (transforms.conf.spec: `FORMAT = my_index`); the `<name>::` prefix
      // requirement is documented for Host, Source and Sourcetype only. Nothing
      // is stripped, so `FORMAT = index::foo` routes to an index literally named
      // `index::foo` — which is what Splunk does, and what the config lint warns about.
      return {
        ...event,
        metadata: { ...event.metadata, index: destValue },
        fields: { ...event.fields, ...result.fields },
      };

    case 'MetaData:Source':
      if (!destValue.startsWith('source::')) {
        return { ...event, fields: { ...event.fields, ...result.fields } };
      }
      return {
        ...event,
        metadata: { ...event.metadata, source: destValue.slice('source::'.length) },
        fields: { ...event.fields, ...result.fields },
      };

    case 'MetaData:Sourcetype':
      if (!destValue.startsWith('sourcetype::')) {
        return { ...event, fields: { ...event.fields, ...result.fields } };
      }
      return {
        ...event,
        metadata: { ...event.metadata, sourcetype: destValue.slice('sourcetype::'.length) },
        fields: { ...event.fields, ...result.fields },
      };

    default:
      // A key this tool does not model changes nothing on the event. That is
      // true of a documented routing key (_TCP_ROUTING and friends) and of a
      // key outside the documented set, which Splunk ignores: writing either
      // out as a field named after the key would invent a field Splunk never
      // creates. The config-time lint says which of the two it is.
      return { ...event, fields: { ...event.fields, ...result.fields } };
  }
}
