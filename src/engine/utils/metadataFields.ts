import type { SplunkEvent } from '../types';

/**
 * Resolution of an event's routing metadata (host / source / sourcetype /
 * index) in the two forms Splunk exposes it.
 *
 * **As search-time fields** — `host`, `source`, `sourcetype` and `index` are
 * default fields on every event, so `EXTRACT-x = … in source`,
 * `FIELDALIAS-cim = host AS dvc` and `EVAL-idx = index` all work in Splunk
 * without anything having extracted them first.
 *
 * **As index-time SOURCE_KEY targets** — the same values are readable from the
 * `MetaData:*` keys, where host, source and sourcetype carry a `<name>::`
 * prefix. That prefix is not cosmetic: it is why `DEST_KEY = MetaData:Sourcetype`
 * requires `FORMAT = sourcetype::…`, and matching on it
 * (`REGEX = source::/var/log/foo`) is a documented idiom. `_MetaData:Index` is
 * the exception — transforms.conf.spec has it take the bare index name — so it
 * carries no prefix on either side. The two accessors below keep the read and
 * write sides symmetric.
 */

/** The default fields Splunk materialises from event metadata at search time. */
const METADATA_FIELD_NAMES = ['host', 'source', 'sourcetype', 'index'] as const;

type MetadataFieldName = (typeof METADATA_FIELD_NAMES)[number];

function isMetadataFieldName(name: string): name is MetadataFieldName {
  return (METADATA_FIELD_NAMES as readonly string[]).includes(name);
}

/**
 * The value of a metadata-backed default field, or undefined when `name` is not
 * one. Callers consult their own `event.fields` first, so an explicitly
 * extracted field of the same name still wins.
 */
export function getMetadataField(event: SplunkEvent, name: string): string | undefined {
  return isMetadataFieldName(name) ? event.metadata[name] : undefined;
}

/** Serialise `_meta` back to the space-separated `key::value` form Splunk stores. */
function serialiseMeta(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([key, value]) => (/\s/.test(value) ? `${key}::"${value}"` : `${key}::${value}`))
    .join(' ');
}

/**
 * The value an index-time `SOURCE_KEY` reads, or undefined when the key is not
 * one of the pipeline's built-in slots (the caller then treats it as a field
 * name). `_MetaData:X` is accepted as an alias of `MetaData:X`, matching the
 * DEST_KEY side.
 */
export function getSourceKeyValue(event: SplunkEvent, sourceKey: string): string | undefined {
  switch (sourceKey.replace(/^_(?=MetaData:)/i, '')) {
    case '_raw':
      return event._raw;
    case '_time':
      return event._time ? String(event._time.getTime() / 1000) : '';
    case '_meta':
      return serialiseMeta(event._meta);
    case 'queue':
      // Events that no transform has rerouted are still bound for the index, so
      // `SOURCE_KEY = queue` reads `indexQueue` rather than nothing.
      return event._meta._queue ?? 'indexQueue';
    case 'MetaData:Host':
      return `host::${event.metadata.host}`;
    case 'MetaData:Index':
      // The index key holds the bare name — it is written without a prefix
      // (`FORMAT = my_index`), so it reads back without one too.
      return event.metadata.index;
    case 'MetaData:Source':
      return `source::${event.metadata.source}`;
    case 'MetaData:Sourcetype':
      return `sourcetype::${event.metadata.sourcetype}`;
    default:
      return undefined;
  }
}
