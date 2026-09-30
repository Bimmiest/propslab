// The assets an HTML document loads: `src` of each <script>, `href` of each
// <link>, with what refers to them. Parsed by jsdom rather than matched with a
// regex, since a tag regex misses upper-case tags, single-quoted or unquoted
// attributes, and a `>` inside an attribute value, and a gate that misses a
// reference passes a build it should fail. Scripts are parsed, never run.

import { JSDOM } from 'jsdom';

/**
 * @param {string} html
 * @returns {{ via: string, url: string }[]} `via` is `script`, or the link's `rel`.
 */
export function documentAssets(html) {
  const { document } = new JSDOM(html).window;
  return [...document.querySelectorAll('script[src], link[href]')].map((el) =>
    el.localName === 'script'
      ? { via: 'script', url: el.getAttribute('src') ?? '' }
      : { via: el.getAttribute('rel') ?? 'link', url: el.getAttribute('href') ?? '' },
  );
}
