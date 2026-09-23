import { addFieldValue } from './fieldBag';

const MAX_DEPTH = 10;

/**
 * Flattens parsed JSON into Splunk-style dot/brace notation fields, matching
 * how Splunk's `spath` / `KV_MODE=json` / `INDEXED_EXTRACTIONS=json` name fields:
 *
 * - Nested objects produce dotted leaf keys (`user.name`). The container itself
 *   is **not** emitted as a field — Splunk does not create a `user` field holding
 *   the stringified object.
 * - Arrays use the `{}` marker and collapse across elements into a multivalue field:
 *     `{"tags":["a","b"]}`            → `tags{}`        = [a, b]
 *     `{"items":[{"id":1},{"id":2}]}` → `items{}.id`    = [1, 2]
 * - Scalars become strings; JSON `null` yields an empty value.
 * - Arrays nested directly inside arrays are stringified (Splunk's deeper `{}{}`
 *   notation is not simulated).
 * - Returns true if the depth limit was hit (caller can surface a diagnostic).
 */
export interface FlattenOptions {
  /**
   * When true, strip leading underscores from each key at every nesting level.
   * Splunk reserves leading `_` for internal fields (`_raw`, `_time`, `_meta`, `_indextime`),
   * so INDEXED_EXTRACTIONS drops them from extracted JSON field names.
   */
  stripLeadingUnderscore?: boolean;
  /**
   * If provided, records strippedFieldName → originalRawKey mappings whenever stripping
   * changes a key. Used by the highlighter so it can find values using the original JSON
   * key (e.g. `"_GID":"100"`) rather than the stripped name (`GID`).
   */
  sourceKeys?: Record<string, string>;
  /**
   * JSON_TRIM_BRACES_IN_ARRAY_NAMES: name array fields without the `{}` marker,
   * so `data.mount_point{}` is `data.mount_point` and `items{}.id` is
   * `items.id`. Only INDEXED_EXTRACTIONS passes it — the spec scopes the
   * attribute to the index-time JSON parser and warns that it makes index-time
   * names disagree with spath's, which keeps the braces.
   */
  trimArrayBraces?: boolean;
}

/** Append a value to a field, promoting to a multivalue array on repeated keys. */
function addValue(
  fields: Record<string, string | string[]>,
  added: string[],
  name: string,
  value: string,
): void {
  // `addFieldValue` is hasOwnProperty-guarded and `__proto__`-safe, so keys that
  // collide with Object.prototype members (`toString`, `constructor`, …) are
  // extracted verbatim instead of reading back an inherited function.
  if (addFieldValue(fields, name, value)) {
    added.push(name);
  }
}

/**
 * A JSON leaf that has a meaningful string form.
 *
 * Everything reaching the flatteners comes from `JSON.parse`, so once null,
 * arrays and objects are ruled out only these remain. Saying so keeps `String()`
 * off values whose default stringification is "[object Object]" — a field value
 * that looks extracted but carries nothing.
 */
function isJsonScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Dispatch a single JSON value to the right handler. Returns true if depth limit hit. */
function flattenValue(
  value: unknown,
  fields: Record<string, string | string[]>,
  added: string[],
  name: string,
  depth: number,
  options: FlattenOptions,
): boolean {
  if (value === null || value === undefined) {
    addValue(fields, added, name, '');
    return false;
  }
  if (Array.isArray(value)) {
    return flattenArray(value, fields, added, name, depth, options);
  }
  if (typeof value === 'object') {
    return flattenJson(value as Record<string, unknown>, fields, added, name, depth + 1, options);
  }
  if (isJsonScalar(value)) {
    addValue(fields, added, name, String(value));
  }
  return false;
}

/**
 * Flatten a JSON array into `<name>{}` multivalue fields (and `<name>{}.<key>`
 * for arrays of objects), collapsing every element into the same field.
 */
export function flattenArray(
  arr: unknown[],
  fields: Record<string, string | string[]>,
  added: string[],
  name: string,
  depth = 0,
  options: FlattenOptions = {},
): boolean {
  if (depth > MAX_DEPTH) return true;
  // A top-level array has no name to trim back to, and an empty string is not
  // a field name, so it keeps its bare `{}` even when trimming.
  const arrayName = options.trimArrayBraces && name !== '' ? name : `${name}{}`;
  for (const item of arr) {
    if (item === null || item === undefined) continue;
    if (Array.isArray(item)) {
      // Array-of-arrays: stringify (Splunk's `{}{}` notation is not simulated).
      addValue(fields, added, arrayName, JSON.stringify(item));
    } else if (typeof item === 'object') {
      if (flattenJson(item as Record<string, unknown>, fields, added, arrayName, depth + 1, options)) {
        return true;
      }
    } else if (isJsonScalar(item)) {
      addValue(fields, added, arrayName, String(item));
    }
  }
  return false;
}

export function flattenJson(
  obj: Record<string, unknown>,
  fields: Record<string, string | string[]>,
  added: string[],
  prefix = '',
  depth = 0,
  options: FlattenOptions = {},
): boolean {
  if (depth > MAX_DEPTH) return true;

  for (const [rawKey, value] of Object.entries(obj)) {
    const key = options.stripLeadingUnderscore ? rawKey.replace(/^_+/, '') : rawKey;
    if (!key) continue;
    // Keys colliding with Object.prototype members (`constructor`, `__proto__`,
    // …) are no longer dropped: Splunk's spath/KV_MODE=json extract them, and
    // the hasOwn-guarded, `__proto__`-safe field writers make that safe.
    const fieldName = prefix ? `${prefix}.${key}` : key;

    if (options.sourceKeys && key !== rawKey) {
      options.sourceKeys[fieldName] = rawKey;
    }

    if (flattenValue(value, fields, added, fieldName, depth, options)) return true;
  }
  return false;
}
