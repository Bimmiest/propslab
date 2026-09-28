// Directive keys and DEST_KEY values are user input, and the linters look them
// up in plain-object tables. Without an own-property guard, `constructor` or
// `toString` finds the inherited Object.prototype member and its source text
// leaks into a diagnostic (#426).
import { describe, it, expect } from 'vitest';
import type { editor } from 'monaco-editor';
import { runPipeline } from '../pipeline';
import { computeDiagnostics } from '../../monaco/splunkConfDiagnostics';
import type { EventMetadata } from '../types';

const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype);

const metadata: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function engineMessages(props: string, transforms: string): string[] {
  return runPipeline('2026-01-15T10:00:00Z hello world\n', metadata, props, transforms, {
    perEventPipeline: false,
    captureOffsets: false,
  }).diagnostics.map((d) => d.message);
}

function editorMessages(text: string, fileType: 'props.conf' | 'transforms.conf'): string[] {
  const lines = text.split('\n');
  const model = {
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getValue: () => text,
  } as unknown as editor.ITextModel;
  return computeDiagnostics(model, fileType).map((m) => m.message);
}

function expectClean(messages: string[], name: string): void {
  for (const m of messages) {
    expect(m).not.toContain('[native code]');
    expect(m).not.toMatch(new RegExp(`^${name.replace(/[$]/g, '\\$&')} is recognised`));
    expect(m).not.toContain(' does nothing here');
  }
}

describe('Object.prototype member names are not table hits (#426)', () => {
  it('covers the names the issue lists', () => {
    expect(PROTO_NAMES).toEqual(
      expect.arrayContaining(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']),
    );
  });

  it.each(PROTO_NAMES)('%s as a props.conf and transforms.conf directive key', (name) => {
    const props = `[st]\n${name} = 1\nTRANSFORMS-i = ti\nREPORT-s = ts\n`;
    const transforms =
      `[ti]\nREGEX = (\\w+)\nFORMAT = a::$1\n${name} = 1\n\n` +
      `[ts]\nREGEX = (?<a>\\w+)\n${name} = 1\n`;
    expectClean(engineMessages(props, transforms), name);
    expectClean(editorMessages(props, 'props.conf'), name);
    expectClean(editorMessages(transforms, 'transforms.conf'), name);
  });

  it.each(PROTO_NAMES)('%s as a DEST_KEY value', (name) => {
    const props = '[st]\nTRANSFORMS-i = ti\n';
    const transforms = `[ti]\nREGEX = (\\w+)\nFORMAT = $1\nDEST_KEY = ${name}\n`;
    const messages = engineMessages(props, transforms);
    expectClean(messages, name);
    expect(messages.some((m) => m.includes('requires FORMAT to include'))).toBe(false);
    expectClean(editorMessages(transforms, 'transforms.conf'), name);
  });
});
