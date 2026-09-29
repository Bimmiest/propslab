import type { languages, editor, Position, CancellationToken } from 'monaco-editor';
import { getDirectivesForFile, getDirectivesByCategory, type DirectiveInfo } from '../engine/directiveRegistry';
import { languages as monacoLanguages } from 'monaco-editor/editor';
import { describeTimeFormat, renderTimeFormatPreview } from './timeFormatPreview';

// The runtime enum from the editor API, not a hand-kept copy of its numbers: the
// values are Monaco's to renumber (0.57 has Class=5, Unit=12, Constant=14,
// Reference=21, and Enum=15, Value=13, Snippet=28), and a stale copy drew every
// suggestion with the wrong icon.
const CIK = monacoLanguages.CompletionItemKind;

// Monaco CompletionItemInsertTextRule — 4 = InsertAsSnippet
const InsertAsSnippet = 4;

export function createCompletionProvider(fileType: 'props.conf' | 'transforms.conf'): languages.CompletionItemProvider {
  return {
    triggerCharacters: ['=', '[', '\n'],

    provideCompletionItems(
      model: editor.ITextModel,
      position: Position,
      _context: languages.CompletionContext,
      _token: CancellationToken
    ): languages.ProviderResult<languages.CompletionList> {
      const line = model.getLineContent(position.lineNumber);
      const textBefore = line.substring(0, position.column - 1).trimStart();

      // A comment says nothing a completion could finish.
      if (line.trimStart().startsWith('#')) return { suggestions: [] };

      // The line after a trailing backslash is more of the previous value, in
      // whatever shape it takes, so it is neither a key nor a fresh value.
      if (position.lineNumber > 1 && endsWithContinuation(model.getLineContent(position.lineNumber - 1))) {
        return { suggestions: [] };
      }

      // Inside stanza brackets - suggest stanza types. Once the bracket is
      // closed the header is finished: nothing belongs after it.
      if (textBefore.startsWith('[')) {
        return {
          suggestions: textBefore.includes(']') ? [] : getStanzaSuggestions(model, position, fileType),
        };
      }

      // After = sign - suggest values for the directive
      const eqIdx = line.indexOf('=');
      if (eqIdx >= 0 && position.column - 1 > eqIdx) {
        const key = line.substring(0, eqIdx).trim();
        return {
          suggestions: getValueSuggestions(key, model, position, fileType),
        };
      }

      // At start of line - suggest directive keys. When the line already has its
      // `= value`, the caret is in the key: complete the key alone rather than
      // inserting a second `= default`.
      return {
        suggestions: getDirectiveSuggestions(model, position, fileType, eqIdx >= 0),
      };
    },
  };
}

/** Whether `line` ends with an odd number of backslashes, which is a continuation. */
function endsWithContinuation(line: string): boolean {
  let count = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

/** Escape what a snippet body reads specially, so a default is inserted as written. */
function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&');
}

/** The stanza-name prefixes a file's headers can start with. */
function getStanzaSuggestions(
  model: editor.ITextModel,
  position: Position,
  fileType: 'props.conf' | 'transforms.conf',
): languages.CompletionItem[] {
  const range = getWordRange(model, position);
  const items: languages.CompletionItem[] = [
    {
      label: 'default',
      kind: CIK.Enum,
      detail: 'Default stanza - applies to all sourcetypes',
      insertText: 'default]',
      range,
    },
  ];
  // transforms.conf stanzas are named transforms: source::, host:: and the rest
  // are props.conf's way of naming what an event matched.
  if (fileType === 'transforms.conf') return items;

  const prefixed = (label: string, detail: string, placeholder: string): languages.CompletionItem => ({
    label,
    kind: CIK.Enum,
    detail,
    insertText: `${label}\${1:${placeholder}}]`,
    insertTextRules: InsertAsSnippet,
    range,
  });
  items.push(
    prefixed('source::', 'Source-based stanza (highest precedence)', 'path'),
    prefixed('host::', 'Host-based stanza', 'hostname'),
    prefixed('rule::', 'Rule-based sourcetype classification', 'rulename'),
    prefixed('delayedrule::', 'Delayed rule-based sourcetype classification (checked last)', 'rulename'),
  );
  return items;
}

function getDirectiveSuggestions(
  model: editor.ITextModel,
  position: Position,
  fileType: 'props.conf' | 'transforms.conf',
  hasValue: boolean,
): languages.CompletionItem[] {
  const directives = getDirectivesForFile(fileType);
  const categories = getDirectivesByCategory(fileType);
  const range = getWordRange(model, position);

  const items: languages.CompletionItem[] = [];

  // Group by category for better organization
  let sortOrder = 0;
  for (const [category, categoryDirectives] of categories) {
    for (const dir of categoryDirectives) {
      const item = directiveToCompletionItem(dir, range, category, sortOrder++, hasValue);
      items.push(item);

      // For class-based directives, also add the pattern with placeholder
      if (dir.isClassBased) {
        items.push({
          label: `${dir.key}-`,
          kind: CIK.Snippet,
          detail: `${dir.key}-<class> (${category})`,
          documentation: dir.description,
          insertText: hasValue ? `${dir.key}-\${1:classname}` : `${dir.key}-\${1:classname} = \${2:value}`,
          insertTextRules: InsertAsSnippet,
          sortText: String(sortOrder++).padStart(4, '0'),
          range,
        });
      }
    }
  }

  // Also add directives not categorized. Tracked by key rather than compared
  // against `label`, which is an object for unsimulated directives and so never
  // equalled the key -- every one of those was listed twice.
  const listed = new Set<string>();
  for (const [, categoryDirectives] of categories) {
    for (const dir of categoryDirectives) listed.add(dir.key);
  }
  for (const dir of directives) {
    if (!listed.has(dir.key)) {
      listed.add(dir.key);
      items.push(directiveToCompletionItem(dir, range, dir.category, sortOrder++, hasValue));
    }
  }

  return items;
}

function directiveToCompletionItem(
  dir: DirectiveInfo,
  range: languages.CompletionItem['range'],
  category: string,
  sortOrder: number,
  hasValue: boolean,
): languages.CompletionItem {
  // With `= value` already on the line, only the key is inserted.
  const insertText = dir.isClassBased
    ? hasValue
      ? `${dir.key}-\${1:classname}`
      : `${dir.key}-\${1:classname} = \${2:value}`
    : hasValue
      ? dir.key
      : `${dir.key} = \${1:${escapeSnippet(dir.defaultValue || 'value')}}`;

  // A key the preview does not honour still belongs in the list -- it is valid
  // Splunk config and refusing to complete it would be its own wrong answer --
  // but the list is where the user decides, so it says so there.
  const unsimulated = dir.support !== 'simulated';
  const supportSuffix = dir.support === 'ignored' ? ' — not simulated' : dir.support === 'documented' ? ' — out of scope' : '';

  return {
    label: unsimulated ? { label: dir.key, description: supportSuffix.slice(3) } : dir.key,
    kind: dir.isClassBased ? CIK.Snippet : CIK.Property,
    detail: `${category} (${dir.phase})${supportSuffix}`,
    documentation: {
      value: [
        `**${dir.key}**`,
        '',
        ...(unsimulated
          ? [
              dir.support === 'ignored'
                ? `> ⚠️ **Not simulated.** ${dir.supportNote ?? ''}${dir.supportIssue ? ` Tracked as #${dir.supportIssue}.` : ''}`
                : `> ℹ️ **Outside the simulation.** ${dir.supportNote ?? ''}`,
              '',
            ]
          : []),
        dir.description,
        '',
        `**Default:** \`${dir.defaultValue || '(none)'}\` &nbsp; **Phase:** ${dir.phase} &nbsp; **Type:** ${dir.valueType}`,
        '',
        '**Example:**',
        '```',
        dir.example,
        '```',
      ].join('\n'),
      // Deliberately untrusted. Trust only matters for `command:` links, and
      // this documentation has none, so marking it trusted would grant every
      // command for no benefit — one interpolated string away from a forged
      // command link. If a link is ever added here, trust exactly its command
      // (`{ enabledCommands: [...] }`) and escape anything from the document
      // with ./markdown, as the directive hover does.
    },
    insertText,
    ...(hasValue && !dir.isClassBased ? {} : { insertTextRules: InsertAsSnippet }),
    sortText: String(sortOrder).padStart(4, '0'),
    range,
  };
}

function getValueSuggestions(
  key: string,
  model: editor.ITextModel,
  position: Position,
  fileType: 'props.conf' | 'transforms.conf'
): languages.CompletionItem[] {
  const directives = getDirectivesForFile(fileType);
  const baseKey = key.includes('-') ? key.split('-')[0] : key;
  const dir = directives.find((d) => d.key === key || d.key === baseKey);
  if (!dir) return [];

  const range = getWordRange(model, position);
  const items: languages.CompletionItem[] = [];

  if (dir.valueType === 'boolean') {
    items.push(
      { label: 'true', kind: CIK.Value, insertText: 'true', range, detail: 'Boolean true' },
      { label: 'false', kind: CIK.Value, insertText: 'false', range, detail: 'Boolean false' },
    );
  }

  if (dir.valueType === 'enum' && dir.enumValues) {
    for (const val of dir.enumValues) {
      items.push({
        label: val,
        kind: CIK.Value,
        insertText: val,
        range,
        detail: `Valid value for ${dir.key}`,
      });
    }
  }

  // Suggest common strftime tokens for TIME_FORMAT
  if (dir.valueType === 'strftime') {
    const strftimeTokens = [
      { token: '%Y-%m-%dT%H:%M:%S', desc: 'ISO 8601 datetime' },
      { token: '%Y-%m-%d %H:%M:%S', desc: 'Standard datetime' },
      { token: '%b %d %H:%M:%S', desc: 'Syslog format' },
      { token: '%s', desc: 'Epoch seconds' },
      { token: '%Y-%m-%dT%H:%M:%S.%3N%z', desc: 'ISO 8601 with milliseconds and timezone' },
    ];
    for (const { token, desc } of strftimeTokens) {
      // Same live rendering the hover gives: picking between five opaque
      // token strings is guesswork until you can see what each one produces.
      const preview = renderTimeFormatPreview(describeTimeFormat(token));
      items.push({
        label: token,
        kind: CIK.Constant,
        insertText: token,
        range,
        detail: desc,
        ...(preview !== '' ? { documentation: { value: preview } } : {}),
      });
    }
  }

  return items;
}

function getWordRange(model: editor.ITextModel, position: Position): languages.CompletionItem['range'] {
  const word = model.getWordAtPosition(position);
  if (word) {
    // `%` is not a word character, so on `TIME_FORMAT = %Y` the word is just `Y`.
    // Accepting a strftime suggestion then replaced only the `Y` and left the
    // user's `%` behind: `TIME_FORMAT = %%Y-%m-%dT%H:%M:%S`. Extend the range
    // back over an immediately preceding `%` so it is replaced too.
    const line = model.getLineContent(position.lineNumber);
    const precededByPercent = word.startColumn > 1 && line[word.startColumn - 2] === '%';
    return {
      startLineNumber: position.lineNumber,
      startColumn: precededByPercent ? word.startColumn - 1 : word.startColumn,
      endLineNumber: position.lineNumber,
      endColumn: word.endColumn,
    };
  }
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}
