import type { SplunkEvent } from '../types';
import type { TransformResult } from './regexTransform';
import { addFieldValue, deleteField, getField, hasField, setField } from '../utils/fieldBag';
import { dateFromEpochSeconds } from '../utils/epochTime';
import { indexedFields } from '../utils/metadataFields';
import { normaliseDestKey } from './destKeys';

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

/**
 * `meta` with a WRITE_META transform's fields appended. Splunk writes them to
 * `_meta`, where a later `$0` or `SOURCE_KEY = _meta` reads them and a later
 * DEST_KEY = _meta can replace them; the event shows them as fields too.
 */
function withMetaFields(meta: SplunkEvent['_meta'], fields: TransformResult['fields']): SplunkEvent['_meta'] {
  const out = { ...meta };
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) addFieldValue(out, key, v);
  }
  return out;
}

/**
 * DEST_KEY = _meta without WRITE_META: the FORMAT's pairs become the whole of
 * `_meta`, so the indexed fields earlier transforms wrote are gone unless FORMAT
 * carries them over with `$0` (#451). transforms.conf.spec: "If DEST_KEY = _meta
 * (not recommended) you should also add $0 to the start of your FORMAT
 * setting"; Getting Data In: "Each matching transform can overwrite _meta, so
 * use WRITE_META = true to append _meta."
 *
 * A field the event shows because a WRITE_META transform wrote it to `_meta`
 * follows `_meta`: it goes when `_meta` drops it, and takes `_meta`'s values
 * when FORMAT writes the key again. Every other field is left alone, and so is
 * the simulator's `_queue` slot, which is not part of `_meta` in Splunk.
 */
function replaceMeta(event: SplunkEvent, destValue: string): Pick<SplunkEvent, '_meta' | 'fields'> {
  const { _queue } = event._meta;
  const meta = withMetaPairs(_queue === undefined ? {} : { _queue }, destValue);
  const fields = { ...event.fields };
  for (const key of Object.keys(indexedFields(event._meta))) {
    if (!hasField(fields, key)) continue;
    const value = getField(meta, key);
    if (value === undefined) deleteField(fields, key);
    else setField(fields, key, value);
  }
  return { _meta: meta, fields };
}

export interface DestKeyOptions {
  /**
   * The transform has WRITE_META = true and runs at index time: its fields are
   * also written to `_meta`, and a DEST_KEY = _meta FORMAT is appended to
   * `_meta` rather than replacing it.
   */
  writeMeta?: boolean;
  /** Called with a DEST_KEY = _time value no Date can hold; `_time` is kept. */
  onTimeOutOfRange?: (value: string) => void;
}

export function applyDestKey(
  event: SplunkEvent,
  result: TransformResult,
  { writeMeta = false, onTimeOutOfRange }: DestKeyOptions = {},
): SplunkEvent {
  if (!result.matched || result.destKey === undefined || result.destValue === undefined) {
    // No routing, just add extracted fields.
    // Test for `undefined` rather than falsiness: a FORMAT that legitimately
    // expands to "" (e.g. blanking _raw, or anonymising a field to empty) must
    // still route — only an absent destKey/destValue means "no routing".
    const fields = { ...event.fields, ...result.fields };
    return writeMeta ? { ...event, _meta: withMetaFields(event._meta, result.fields), fields } : { ...event, fields };
  }

  // _MetaData:X → MetaData:X (Splunk alias); built-in keys like _raw, _meta
  // and _time keep their underscore.
  const destKey = normaliseDestKey(result.destKey);
  const destValue = result.destValue;

  switch (destKey) {
    case '_raw':
      return { ...event, _raw: destValue, fields: { ...event.fields, ...result.fields } };

    case '_meta': {
      if (writeMeta) {
        return {
          ...event,
          _meta: withMetaPairs(event._meta, destValue),
          fields: { ...event.fields, ...result.fields },
        };
      }
      const replaced = replaceMeta(event, destValue);
      return { ...event, _meta: replaced._meta, fields: { ...replaced.fields, ...result.fields } };
    }

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
