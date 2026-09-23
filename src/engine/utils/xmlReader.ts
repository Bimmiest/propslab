/**
 * A small, strict XML 1.0 reader for `KV_MODE = xml`.
 *
 * This exists because the engine used to call `DOMParser`, which is a *window*
 * API: it does not exist in a Web Worker, where the app runs the pipeline, nor
 * under Node, where the MCP server does. The call threw, a try/catch swallowed
 * it, and XML extraction silently produced nothing everywhere except the jsdom
 * test environment -- the one place nobody uses the engine.
 *
 * What it reads: elements, attributes, text, CDATA, comments, processing
 * instructions, an XML declaration and a DOCTYPE (skipped), the five predefined
 * entities and numeric character references. What it does not: entities
 * declared in a DOCTYPE's internal subset (a reference to one is reported as
 * undefined, so the document is rejected rather than half-read), validation,
 * and anything else a DTD would add.
 *
 * It is deliberately as strict as `DOMParser(…, 'text/xml')` rather than
 * forgiving. `extractXml` relies on a malformed document being rejected
 * *outright* -- that is how it tells "a fragment that needs a wrapper" from "a
 * whole document", and how non-XML text extracts nothing instead of whatever a
 * lenient reader guessed at. A reader that recovered from errors would change
 * which events extract fields at all. Namespace well-formedness is enforced
 * for the same reason: a namespace-aware DOMParser rejects an unbound prefix.
 */

export interface XmlAttribute {
  /** Qualified name as written, e.g. `Name`, `xmlns`, `xml:lang`. */
  name: string;
  /** Value with references decoded and attribute-value whitespace normalised. */
  value: string;
}

export interface XmlElement {
  kind: 'element';
  /** Qualified name as written, e.g. `ns:Event`. */
  name: string;
  /** The name without its namespace prefix, as DOM `localName` reports it. */
  localName: string;
  /** In source order. */
  attributes: XmlAttribute[];
  /** Elements and text (CDATA included). Comments and PIs are not retained. */
  children: XmlNode[];
}

export interface XmlText {
  kind: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

/** Concatenated text of every descendant text node, as DOM `textContent`. */
export function xmlTextContent(el: XmlElement): string {
  let out = '';
  for (const child of el.children) {
    out += child.kind === 'text' ? child.value : xmlTextContent(child);
  }
  return out;
}

/** The element children only, as DOM `Element.children`. */
export function xmlChildElements(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.kind === 'element');
}

/**
 * Parse a complete XML document and return its root element, or `null` if the
 * input is not well-formed. Never throws.
 */
export function parseXmlDocument(input: string): XmlElement | null {
  try {
    return new Reader(input).document();
  } catch (e) {
    if (e instanceof XmlSyntaxError) return null;
    throw e;
  }
}

class XmlSyntaxError extends Error {}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

// XML 1.0 (Fifth Edition) productions [4] and [4a]. Written out rather than
// approximated with \w because the two disagree on real names: `\w` rejects
// `é` and accepts nothing that XML treats specially, so an approximation would
// reject documents a browser accepts.
const NAME_START =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD' +
  '\\u{10000}-\\u{EFFFF}';
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
// The rule reads the U+0300–U+036F combining-mark *range* as a combined
// character; it is a range endpoint, not a glyph sequence.
// eslint-disable-next-line no-misleading-character-class
const NAME_RE = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'uy');
/** A qualified name under Namespaces in XML: at most one colon, not at either end. */
const QNAME_RE = /^[^:]+(?::[^:]+)?$/;
/** Anything outside production [2] `Char` (lone surrogates included, via the `u` flag). */
const INVALID_CHAR_RE = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
const XML_DECL_RE =
  /^<\?xml\s+version\s*=\s*(["'])1\.[0-9]+\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/;
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  apos: "'",
  quot: '"',
};

interface OpenElement {
  el: XmlElement;
  /** Prefix -> namespace URI bindings in scope at this element. */
  scope: ReadonlyMap<string, string>;
}

class Reader {
  private readonly src: string;
  private pos = 0;

  constructor(input: string) {
    // End-of-line handling (spec 2.11): every CRLF and lone CR reaches the
    // application as LF, which is what DOMParser hands back too.
    this.src = input.replace(/\r\n?/g, '\n');
    if (INVALID_CHAR_RE.test(this.src)) this.fail();
  }

  document(): XmlElement {
    // The declaration is only legal as the very first thing in the entity --
    // not after whitespace, and not inside an element, which is what rejects
    // a declaration in a wrapped fragment and sends extractXml to its
    // unwrapped retry.
    if (/^<\?xml[\s?]/.test(this.src)) {
      const decl = XML_DECL_RE.exec(this.src);
      if (!decl) this.fail();
      this.pos = decl[0].length;
    }
    this.misc();
    if (this.src.startsWith('<!DOCTYPE', this.pos)) {
      this.doctype();
      this.misc();
    }
    if (this.src[this.pos] !== '<') this.fail();
    const root = this.element();
    this.misc();
    if (this.pos !== this.src.length) this.fail();
    return root;
  }

  private fail(): never {
    throw new XmlSyntaxError(`malformed XML at offset ${this.pos}`);
  }

  private eat(literal: string): void {
    if (!this.src.startsWith(literal, this.pos)) this.fail();
    this.pos += literal.length;
  }

  /** Skip whitespace; report whether there was any. */
  private space(): boolean {
    const start = this.pos;
    while (this.pos < this.src.length && ' \t\n'.includes(this.src[this.pos] ?? '')) this.pos++;
    return this.pos > start;
  }

  private name(): string {
    NAME_RE.lastIndex = this.pos;
    const m = NAME_RE.exec(this.src);
    if (!m) this.fail();
    this.pos += m[0].length;
    return m[0];
  }

  /** Comments, PIs and whitespace, the only things allowed around the root. */
  private misc(): void {
    for (;;) {
      this.space();
      if (this.src.startsWith('<!--', this.pos)) this.comment();
      else if (this.src.startsWith('<?', this.pos)) this.pi();
      else return;
    }
  }

  private comment(): void {
    this.pos += 4;
    const end = this.src.indexOf('--', this.pos);
    // `--` may only appear as the start of the terminator, so `a -- b` and
    // `a--->` are both errors, per production [15].
    if (end === -1 || this.src[end + 2] !== '>') this.fail();
    this.pos = end + 3;
  }

  private pi(): void {
    this.pos += 2;
    const target = this.name();
    if (target.toLowerCase() === 'xml') this.fail();
    const end = this.src.indexOf('?>', this.pos);
    if (end === -1) this.fail();
    if (end > this.pos && !this.space()) this.fail();
    this.pos = end + 2;
  }

  /**
   * Skip a DOCTYPE, including any internal subset. Only the brackets and quoted
   * strings matter for finding its end; the declarations inside are not read.
   */
  private doctype(): void {
    this.pos += '<!DOCTYPE'.length;
    if (!this.space()) this.fail();
    this.name();
    let depth = 0;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '"' || ch === "'") {
        const close = this.src.indexOf(ch, this.pos + 1);
        if (close === -1) this.fail();
        this.pos = close + 1;
        continue;
      }
      if (depth > 0 && this.src.startsWith('<!--', this.pos)) {
        this.comment();
        continue;
      }
      this.pos++;
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '>' && depth === 0) return;
      if (depth < 0) this.fail();
    }
    this.fail();
  }

  /** `&…;` at `pos`, decoded. */
  private reference(): string {
    const semi = this.src.indexOf(';', this.pos);
    if (semi === -1) this.fail();
    const body = this.src.slice(this.pos + 1, semi);
    this.pos = semi + 1;
    if (body.startsWith('#')) {
      const code = /^#x[0-9A-Fa-f]+$/.test(body)
        ? parseInt(body.slice(2), 16)
        : /^#[0-9]+$/.test(body)
          ? parseInt(body.slice(1), 10)
          : NaN;
      // A reference is held to the same Char production as literal text, so
      // `&#0;` and `&#xD800;` are errors rather than a way to smuggle them in.
      if (!(code <= 0x10ffff)) this.fail();
      const ch = String.fromCodePoint(code);
      if (INVALID_CHAR_RE.test(ch)) this.fail();
      return ch;
    }
    const named = Object.hasOwn(PREDEFINED_ENTITIES, body) ? PREDEFINED_ENTITIES[body] : undefined;
    if (named === undefined) this.fail();
    return named;
  }

  private attributeValue(): string {
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") this.fail();
    this.pos++;
    let value = '';
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined || ch === '<') this.fail();
      if (ch === quote) {
        this.pos++;
        return value;
      }
      if (ch === '&') {
        // Decoded characters are exempt from the whitespace normalisation
        // below, so `&#10;` survives as a newline -- spec 3.3.3.
        value += this.reference();
        continue;
      }
      value += ch === '\t' || ch === '\n' ? ' ' : ch;
      this.pos++;
    }
  }

  /**
   * Read a start tag at `pos`. Returns the element, its namespace scope, and
   * whether it was self-closing.
   */
  private startTag(parentScope: ReadonlyMap<string, string>): { open: OpenElement; empty: boolean } {
    this.pos++; // '<'
    const name = this.name();
    const attributes: XmlAttribute[] = [];
    for (;;) {
      const spaced = this.space();
      if (this.src.startsWith('/>', this.pos) || this.src[this.pos] === '>') break;
      // Attributes must be separated from the name and from each other.
      if (!spaced) this.fail();
      const attrName = this.name();
      this.space();
      this.eat('=');
      this.space();
      const value = this.attributeValue();
      if (attributes.some((a) => a.name === attrName)) this.fail();
      attributes.push({ name: attrName, value });
    }
    const empty = this.src[this.pos] === '/';
    this.pos += empty ? 2 : 1;

    const scope = this.bindNamespaces(attributes, parentScope);
    this.checkQName(name, scope);
    for (const a of attributes) {
      if (a.name !== 'xmlns' && !a.name.startsWith('xmlns:')) this.checkQName(a.name, scope);
    }
    const colon = name.indexOf(':');
    const el: XmlElement = {
      kind: 'element',
      name,
      localName: colon === -1 ? name : name.slice(colon + 1),
      attributes,
      children: [],
    };
    return { open: { el, scope }, empty };
  }

  private bindNamespaces(
    attributes: XmlAttribute[],
    parentScope: ReadonlyMap<string, string>,
  ): ReadonlyMap<string, string> {
    let scope = parentScope;
    for (const a of attributes) {
      if (!a.name.startsWith('xmlns:')) continue;
      const prefix = a.name.slice('xmlns:'.length);
      // Namespaces in XML 1.0 forbids un-declaring a prefix, binding the
      // reserved `xmlns` prefix at all, and binding `xml` to anything else.
      if (!QNAME_RE.test(a.name) || a.value === '' || prefix === 'xmlns') this.fail();
      if ((prefix === 'xml') !== (a.value === XML_NS)) this.fail();
      if (scope === parentScope) scope = new Map(parentScope);
      (scope as Map<string, string>).set(prefix, a.value);
    }
    return scope;
  }

  private checkQName(name: string, scope: ReadonlyMap<string, string>): void {
    if (!QNAME_RE.test(name)) this.fail();
    const colon = name.indexOf(':');
    if (colon !== -1 && !scope.has(name.slice(0, colon))) this.fail();
  }

  /**
   * Read the element at `pos` and everything inside it. Iterative, with an
   * explicit stack, so nesting depth is bounded by memory rather than by the
   * call stack -- event data is untrusted input.
   */
  private element(): XmlElement {
    const rootScope = new Map([['xml', XML_NS]]);
    const first = this.startTag(rootScope);
    if (first.empty) return first.open.el;
    const stack: OpenElement[] = [first.open];
    let text = '';

    const flushText = (into: XmlElement): void => {
      if (text) into.children.push({ kind: 'text', value: text });
      text = '';
    };

    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) return first.open.el;
      const ch = this.src[this.pos];
      if (ch === undefined) this.fail();

      if (ch === '&') {
        text += this.reference();
      } else if (ch !== '<') {
        const next = this.src.slice(this.pos).search(/[<&]/);
        const end = next === -1 ? this.src.length : this.pos + next;
        const run = this.src.slice(this.pos, end);
        // `]]>` is reserved as the CDATA terminator even in ordinary text.
        if (run.includes(']]>')) this.fail();
        text += run;
        this.pos = end;
      } else if (this.src.startsWith('<![CDATA[', this.pos)) {
        const end = this.src.indexOf(']]>', this.pos + 9);
        if (end === -1) this.fail();
        text += this.src.slice(this.pos + 9, end);
        this.pos = end + 3;
      } else if (this.src.startsWith('<!--', this.pos)) {
        this.comment();
      } else if (this.src.startsWith('<?', this.pos)) {
        this.pi();
      } else if (this.src.startsWith('</', this.pos)) {
        this.pos += 2;
        if (this.name() !== top.el.name) this.fail();
        this.space();
        this.eat('>');
        flushText(top.el);
        stack.pop();
      } else {
        flushText(top.el);
        const child = this.startTag(top.scope);
        top.el.children.push(child.open.el);
        if (!child.empty) stack.push(child.open);
      }
    }
  }
}
