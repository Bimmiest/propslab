import type { languages, editor, Position, CancellationToken } from 'monaco-editor';
import { getDirectivesForFile, getDirectivesByCategory, type DirectiveInfo } from '../engine/directiveRegistry';
import { describeTimeFormat, renderTimeFormatPreview } from './timeFormatPreview';

// Monaco CompletionItemKind numeric values (monaco-editor doesn't export the enum at runtime
// when imported as `type`, so we maintain this local mapping for readability).
const CIK = {
  Enum: 5,
  Property: 9,
  Value: 12,
  Snippet: 14,
  Constant: 21,
} as const;

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

      // Inside stanza brackets - suggest stanza types
      if (textBefore.startsWith('[')) {
        return {
          suggestions: getStanzaSuggestions(model, position),
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

      // At start of line - suggest directive keys
      return {
        suggestions: getDirectiveSuggestions(model, position, fileType),
      };
    },
  };
}

function getStanzaSuggestions(model: editor.ITextModel, position: Position): languages.CompletionItem[] {
  const range = getWordRange(model, position);
  return [
    {
      label: 'default',
      kind: CIK.Enum,
      detail: 'Default stanza - applies to all sourcetypes',
      insertText: 'default]',
      range,
    },
    {
      label: 'source::',
      kind: CIK.Enum,
      detail: 'Source-based stanza (highest precedence)',
      insertText: 'source::${1:path}]',
      insertTextRules: InsertAsSnippet,
      range,
    },
    {
      label: 'host::',
      kind: CIK.Enum,
      detail: 'Host-based stanza',
      insertText: 'host::${1:hostname}]',
      insertTextRules: InsertAsSnippet,
      range,
    },
  ];
}

function getDirectiveSuggestions(
  model: editor.ITextModel,
  position: Position,
  fileType: 'props.conf' | 'transforms.conf'
): languages.CompletionItem[] {
  const directives = getDirectivesForFile(fileType);
  const categories = getDirectivesByCategory(fileType);
  const range = getWordRange(model, position);

  const items: languages.CompletionItem[] = [];

  // Group by category for better organization
  let sortOrder = 0;
  for (const [category, categoryDirectives] of categories) {
    for (const dir of categoryDirectives) {
      const item = directiveToCompletionItem(dir, range, category, sortOrder++);
      items.push(item);

      // For class-based directives, also add the pattern with placeholder
      if (dir.isClassBased) {
        items.push({
          label: `${dir.key}-`,
          kind: CIK.Snippet,
          detail: `${dir.key}-<class> (${category})`,
          documentation: dir.description,
          insertText: `${dir.key}-\${1:classname} = \${2:value}`,
          insertTextRules: InsertAsSnippet,
          sortText: String(sortOrder++).padStart(4, '0'),
          range,
        });
      }
    }
  }

  // Also add directives not categorized
  for (const dir of directives) {
    if (!items.some((i) => i.label === dir.key)) {
      items.push(directiveToCompletionItem(dir, range, dir.category, sortOrder++));
    }
  }

  return items;
}

function directiveToCompletionItem(
  dir: DirectiveInfo,
  range: languages.CompletionItem['range'],
  category: string,
  sortOrder: number
): languages.CompletionItem {
  const insertText = dir.isClassBased
    ? `${dir.key}-\${1:classname} = \${2:value}`
    : `${dir.key} = \${1:${dir.defaultValue || 'value'}}`;

  // A key the preview does not honour still belongs in the list -- it is valid
  // Splunk config and refusing to complete it would be its own wrong answer --
  // but the list is where the user decides, so it says so there (#153).
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
      // this documentation has none, so marking it trusted granted every
      // command for no benefit — one interpolated string away from the hover
      // bug in #296. If a link is ever added here, trust exactly its command
      // (`{ enabledCommands: [...] }`) and escape anything from the document
      // with ./markdown, as the directive hover does.
    },
    insertText,
    insertTextRules: InsertAsSnippet,
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
      // Same live rendering the hover gives (#90): picking between five opaque
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
