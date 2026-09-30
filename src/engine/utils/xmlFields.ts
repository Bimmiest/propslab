/**
 * The one walk from an XML element tree to the (name, value) pairs XML field
 * extraction reads: `KV_MODE = xml` (search time) and
 * `INDEXED_EXTRACTIONS = xml | xmlkv | xmlkv-winevt` (index time) both call
 * it, so the two cannot drift apart on naming (#483). What each does with the
 * pairs afterwards (KV_MODE's multivalue accumulation; the indexed filters and
 * cutoff) stays in its own processor.
 */

import { xmlChildElements, type XmlElement } from './xmlReader';

/**
 * How fields are named. `xml` is KV_MODE = xml's convention and the indexed
 * `xml` mode's: leaves by dotted path from the root (root included), a `Name`
 * attribute naming the leaf it sits on and also kept as `<tag>_Name`. The
 * other two are the indexed modes' readings; see xmlIndexedExtractions.ts.
 */
export type XmlNaming = 'xml' | 'xmlkv' | 'xmlkv-winevt';

/** One value the walk found, before any filter has looked at it. */
export interface XmlCandidate {
  name: string;
  value: string;
  /** The source form contained an entity or character reference. */
  encoded: boolean;
  /** Offset just past the markup that completes this value. */
  end: number;
}

// Iterative pre-order walk: the reader accepts any depth, so recursion here
// overflowed the stack on deeply nested input (#428). Paths are carried as
// joined strings rather than copied arrays, which made depth quadratic. Only a
// leaf has a value, so output order matches the recursive walk it replaced.
export function walkXmlFields(root: XmlElement, mode: XmlNaming, out: XmlCandidate[] = []): XmlCandidate[] {
  const stack: { el: XmlElement; path: string }[] = [{ el: root, path: root.localName }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { el, path } = top;
    const tag = el.localName;
    const children = xmlChildElements(el);
    const nameAttr = el.attributes.find((a) => a.name === 'Name');

    // A leaf's own text. Only a leaf has one: a parent's text is whitespace
    // between its children, or mixed content no mode names a field for.
    let value = '';
    let encoded = false;
    if (children.length === 0) {
      let text = '';
      for (const child of el.children) {
        if (child.kind !== 'text') continue;
        text += child.value;
        if (child.encoded) encoded = true;
      }
      value = text.trim();
    }

    // In xmlkv-winevt a Name attribute on a leaf with a value *is* that value's
    // field name, so it is consumed rather than also reported as `<tag>_Name`.
    // On an empty element (`<Provider Name='…'/>`) it names nothing and stays
    // Provider_Name. KV_MODE = xml reports both forms, and `xml` keeps that.
    const nameConsumed = mode === 'xmlkv-winevt' && value !== '' && Boolean(nameAttr?.value);

    for (const attr of el.attributes) {
      if (!attr.value) continue;
      if (attr === nameAttr && nameConsumed) continue;
      const useTagName = attr.name === 'Name' && mode !== 'xmlkv';
      out.push({
        name: useTagName ? `${tag}_Name` : attr.name,
        value: attr.value,
        encoded: attr.encoded === true,
        end: el.startTagEnd,
      });
    }

    for (const child of [...children].reverse()) {
      stack.push({ el: child, path: `${path}.${child.localName}` });
    }
    if (!value) continue;

    // `||`, not `??`: an empty Name attribute names nothing, and the leaf falls
    // back to its path or tag rather than becoming a field called "".
    let name: string;
    if (mode === 'xml') name = nameAttr?.value || path;
    else if (mode === 'xmlkv-winevt') name = nameAttr?.value || tag;
    else name = tag;
    out.push({ name, value, encoded, end: el.end });
  }
  return out;
}
