import * as monaco from 'monaco-editor/editor';
import type { IDisposable, languages } from 'monaco-editor';
import { createCompletionProvider } from '../../monaco/splunkConfCompletion';
import { createHoverProvider } from '../../monaco/splunkConfHover';
import { createFoldingRangeProvider } from '../../monaco/splunkConfFolding';
import { createCodeActionProvider } from '../../monaco/splunkConfCodeActions';
import { OPEN_DICTIONARY_COMMAND_ID } from '../../monaco/dictionaryCommand';
import { useAppStore } from '../../store/useAppStore';

/**
 * The two conf files share one syntax (and one Monarch grammar) but expose
 * different directive sets. Registering them as distinct language IDs lets
 * each editor surface only its own completions/hovers, so the props editor
 * never suggests transforms-only keys or the reverse.
 */
export const PROPS_LANGUAGE_ID = 'splunk-props';
export const TRANSFORMS_LANGUAGE_ID = 'splunk-transforms';

/**
 * What registration handed back: every provider, tokenizer and command
 * disposable, kept so the whole set can be taken down again. Null until
 * registration has SUCCEEDED, so an attempt that threw part-way is retried
 * instead of leaving the editor half-registered for good.
 */
let registration: IDisposable[] | null = null;

/**
 * Idempotently register the splunk-conf language, providers and the
 * splunk-light/splunk-dark themes. Must run before any editor that references
 * those themes paints — including the plain-text Raw Log editor, which on
 * mobile can mount on its own before any SplunkEditor exists.
 */
export function ensureSplunkMonaco() {
  if (registration) return;
  const disposables: IDisposable[] = [];
  try {
    registerSplunkConfLanguage(disposables);
  } catch (error) {
    // Undo what was registered so the retry does not stack a second set on it.
    disposeAll(disposables);
    throw error;
  }
  registration = disposables;
}

/** Take down everything `ensureSplunkMonaco` registered; the next call registers afresh. */
export function disposeSplunkMonaco() {
  if (!registration) return;
  const disposables = registration;
  registration = null;
  disposeAll(disposables);
}

function disposeAll(disposables: IDisposable[]) {
  for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
}

// In dev, editing a provider module re-evaluates this one, and the next mount
// would register a second set of completion, hover, folding and code action
// providers beside the old (duplicate hovers). Dispose the old set first.
if (import.meta.hot) {
  import.meta.hot.dispose(disposeSplunkMonaco);
}

type MonarchRule = languages.IMonarchLanguageRule;

/**
 * The states that tokenize one kind of directive value, with continuations read
 * the way the parser reads them.
 *
 * A value continues onto the next line when its line ends with an ODD number of
 * backslashes, the last one being the very last character (an even run is
 * escaped backslashes; a backslash followed by a space is a literal one). The
 * next line is then more of the value WHATEVER it starts with, so `[a-z]+`,
 * `#x` and `KEY = v` on it are value text, not a header, a comment or a
 * directive; and it continues further only if it too ends in an odd run.
 * Indentation has nothing to do with it.
 *
 *   `name`      the value's first line, and the state a finished value rests in
 *               until the next line starts (which pops it).
 *   `nameCont`  a line that follows a trailing backslash, at its first
 *               character: decides whether the line continues again (`More`)
 *               or ends the value (`Last`), by looking ahead over the whole
 *               line, and consumes that first character or escaped pair as
 *               text so the state it moves to is not popped on this same line.
 *   `nameMore`  the rest of such a line, ending in a backslash that returns to
 *               `nameCont` for the next one.
 *   `nameLast`  the rest of the line that ends the value.
 *
 * `body` is the highlighting for the kind of value; `pairToken` colours an
 * escaped backslash pair, which must be taken as a pair before a trailing
 * backslash is looked for.
 */
function valueStates(name: string, pairToken: string, body: MonarchRule[]): Record<string, MonarchRule[]> {
  const pair: MonarchRule = [/\\\\/, pairToken];
  return {
    [name]: [
      [/^./, { token: '@rematch', next: '@pop' }],
      pair,
      [/\\$/, { token: 'escape', switchTo: `@${name}Cont` }],
      ...body,
    ],
    [`${name}Cont`]: [
      // A line that is just the backslash: still a continuation.
      [/^\\$/, 'escape'],
      // Ends in an odd run of backslashes: this line continues too.
      [/^(?=(?:[^\\]|\\.)*\\$)(?:\\.|.)/, { token: 'string', switchTo: `@${name}More` }],
      // An empty line ends the value (the parser appends nothing to it).
      [/^$/, { token: '', next: '@pop' }],
      [/^(?:\\.|.)/, { token: 'string', switchTo: `@${name}Last` }],
    ],
    [`${name}More`]: [
      pair,
      [/\\$/, { token: 'escape', switchTo: `@${name}Cont` }],
      ...body,
    ],
    [`${name}Last`]: [
      [/^./, { token: '@rematch', next: '@pop' }],
      ...body,
    ],
  };
}

const MONARCH_GRAMMAR: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.splunk-conf',

  // All known directive keywords
  keywords: [
    'TIME_PREFIX', 'TIME_FORMAT', 'MAX_TIMESTAMP_LOOKAHEAD', 'TZ',
    'DATETIME_CONFIG', 'MAX_DAYS_AGO', 'MAX_DAYS_HENCE',
    'SHOULD_LINEMERGE', 'BREAK_ONLY_BEFORE', 'BREAK_ONLY_BEFORE_DATE',
    'MUST_BREAK_AFTER', 'LINE_BREAKER', 'TRUNCATE',
    'EVENT_BREAKER_ENABLE', 'EVENT_BREAKER',
    'KV_MODE', 'AUTO_KV_JSON', 'INDEXED_EXTRACTIONS',
    'CHARSET', 'ANNOTATE_PUNCT', 'MATCH_LIMIT', 'DEPTH_LIMIT',
    'LEARN_SOURCETYPE', 'SEGMENTATION', 'NO_BINARY_CHECK',
    'REGEX', 'FORMAT', 'SOURCE_KEY', 'DEST_KEY', 'WRITE_META', 'OUTPUT',
    'INGEST_EVAL', 'CLONE_SOURCETYPE',
    'filename', 'match_type', 'default_match', 'max_matches', 'min_matches',
    'MAX_DIFF_SECS_AGO', 'MAX_DIFF_SECS_HENCE',
  ],

  // Keywords whose values are regex patterns
  regexKeywords: [
    'LINE_BREAKER', 'BREAK_ONLY_BEFORE', 'MUST_BREAK_AFTER',
    'EVENT_BREAKER', 'TIME_PREFIX', 'REGEX',
  ],

  evalFunctions: [
    'if', 'case', 'coalesce', 'nullif', 'validate',
    'lower', 'upper', 'len', 'substr', 'replace', 'trim', 'ltrim', 'rtrim',
    'urldecode', 'split', 'mvjoin', 'tonumber', 'tostring', 'typeof',
    'isnull', 'isnotnull', 'isint', 'isnum', 'isbool', 'isstr',
    'abs', 'ceiling', 'ceil', 'floor', 'round', 'sqrt', 'pow',
    'log', 'ln', 'exp', 'pi', 'min', 'max', 'random',
    'mvcount', 'mvindex', 'mvfilter', 'mvappend', 'mvdedup', 'mvfind', 'mvsort', 'mvzip',
    'md5', 'sha1', 'sha256', 'sha512',
    'now', 'time', 'strftime', 'strptime', 'relative_time',
    'like', 'match', 'cidrmatch', 'null',
  ],

  tokenizer: {
    root: [
      // Splunk .conf comments are `#` only. Colouring `;` lines as comments
      // contradicted computeDiagnostics, which flags them as unrecognised —
      // the editor painted a line green and underlined it as a problem at the
      // same time, teaching an idiom Splunk does not accept.
      [/^#.*$/, 'comment'],
      [/^\[/, { token: 'tag.bracket', next: '@stanza' }],
      // EVAL directives → evalValue state (SPL expressions)
      [/^(EVAL)(-[^\s=]+)?(\s*=)/,
        ['keyword', 'variable.name', { token: 'delimiter', next: '@evalValue' }]],
      // INGEST_EVAL → evalValue state (semicolon-separated SPL expressions)
      [/^(INGEST_EVAL)(\s*=)/,
        ['keyword', { token: 'delimiter', next: '@evalValue' }]],
      // EXTRACT/SEDCMD directives → regexValue state (regex patterns)
      [/^(EXTRACT|SEDCMD)(-[^\s=]+)?(\s*=)/,
        ['keyword', 'variable.name', { token: 'delimiter', next: '@regexValue' }]],
      // FIELDALIAS → fieldAliasValue state (sourceField AS aliasField)
      [/^(FIELDALIAS)(-[^\s=]+)?(\s*=)/,
        ['keyword', 'variable.name', { token: 'delimiter', next: '@fieldAliasValue' }]],
      // REPORT/TRANSFORMS → listValue state (comma-separated stanza refs)
      [/^(REPORT|TRANSFORMS)(-[^\s=]+)?(\s*=)/,
        ['keyword', 'variable.name', { token: 'delimiter', next: '@listValue' }]],
      // LOOKUP → lookupValue state
      [/^(LOOKUP)(-[^\s=]+)?(\s*=)/,
        ['keyword', 'variable.name', { token: 'delimiter', next: '@lookupValue' }]],
      // Standard keywords — route regex-valued ones to regexValue
      [/^([A-Z_][A-Z_0-9]*)(\s*=)/, {
        cases: {
          '$1@regexKeywords': ['keyword', { token: 'delimiter', next: '@regexValue' }],
          '$1@keywords': ['keyword', { token: 'delimiter', next: '@value' }],
          '@default': ['identifier', { token: 'delimiter', next: '@value' }],
        },
      }],
      [/^([a-z_][a-z_0-9]*)(\s*=)/, ['keyword.other', { token: 'delimiter', next: '@value' }]],
      // Any other directive, by the parser's own rule (DIRECTIVE_RE): the key starts
      // at column 0 with something other than whitespace, `=` or `[`. An indented
      // `key = value` is malformed to the parser, so it starts no value here either.
      [/^([^\s=[][^=]*?)(\s*=\s*)/, ['identifier', { token: 'delimiter', next: '@value' }]],
      // A key still being typed, before its `=`. Not a string: the editor's
      // quickSuggestions are off in strings, so painting it as one would stop
      // completion from offering the directive the user is typing.
      [/^[^\s=[#][^=]*$/, 'identifier'],
      [/./, 'string'],
    ],
    stanza: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/[^\]]+/, 'tag'],
      [/\]/, { token: 'tag.bracket', next: '@pop' }],
    ],
    // Generic values (numbers, booleans, strftime, plain strings)
    ...valueStates('value', 'string', [
      [/\b(true|false)\b/i, 'constant.language'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/%\d+[Nn]/, 'type'],
      [/%[YymdHeIMSpbBaAZzsTF]/, 'type'],
      [/./, 'string'],
    ]),
    // FIELDALIAS values: sourceField AS aliasField [, sourceField AS aliasField ...]
    ...valueStates('fieldAliasValue', 'variable', [
      [/\b(AS|as|As)\b/, 'keyword'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[a-zA-Z_][\w.{}*-]*/, 'variable'],
    ]),
    // Comma-separated stanza/transform references (REPORT, TRANSFORMS)
    ...valueStates('listValue', 'tag', [
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[^\s,\\]+/, 'tag'],
    ]),
    // LOOKUP values: lookup_name field1 (AS alias1)? field2 (AS alias2)? ...
    ...valueStates('lookupValue', 'variable', [
      [/\b(AS|as|As)\b/, 'keyword'],
      [/\b(OUTPUT|OUTPUTNEW|output|outputnew)\b/, 'keyword'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[a-zA-Z_][\w.{}*-]*/, 'variable'],
    ]),
    // Regex pattern values (EXTRACT, LINE_BREAKER, REGEX, etc.)
    ...valueStates('regexValue', 'regexp.escape', [
      [/\b(true|false)\b/i, 'constant.language'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/\(\?P?<\w+>/, 'regexp.escape'],
      [/\(\?[=!:]/, 'regexp.escape'],
      [/\\[rntdwsDWsSbB\\/.^$*+?()[\]{}|]/, 'regexp.escape'],
      [/[[\](){}|^$.*+?]/, 'regexp'],
      [/\$\d+/, 'variable.value'],
      [/./, 'string'],
    ]),
    // EVAL expressions (SPL eval language)
    ...valueStates('evalValue', 'string', [
      [/"[^"]*"/, 'string'],
      [/'[^']*'/, 'variable'],
      [/\b(true|false|null)\b/i, 'constant.language'],
      [/\b(AND|OR|NOT)\b/i, 'keyword'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/==|!=|>=|<=|&&|\|\||\./, 'operator'],
      [/[+\-*/%<>=!]/, 'operator'],
      [/[(),;]/, 'delimiter'],
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@evalFunctions': 'support.function',
          '@default': 'variable',
        },
      }],
      [/./, ''],
    ]),
  },
};

// Light theme
const LIGHT_THEME: monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '71717a', fontStyle: 'italic' },   /* zinc-500 */
    { token: 'tag', foreground: '7c3aed' },                            /* violet-700 */
    { token: 'tag.bracket', foreground: '7c3aed' },
    { token: 'keyword', foreground: '4f46e5' },                        /* indigo-600 */
    { token: 'keyword.other', foreground: '4f46e5' },
    { token: 'variable.name', foreground: 'c2410c' },                  /* orange-700 */
    { token: 'delimiter', foreground: '27272a' },
    { token: 'string', foreground: '3730a3' },                         /* indigo-800 */
    { token: 'number', foreground: '047857' },                         /* emerald-700 */
    { token: 'constant.language', foreground: '4f46e5' },
    { token: 'regexp', foreground: 'b91c1c' },                         /* red-700 */
    { token: 'regexp.escape', foreground: 'b91c1c', fontStyle: 'bold' },
    { token: 'type', foreground: '0f766e' },                           /* teal-700 */
    { token: 'variable.value', foreground: 'c2410c' },
    { token: 'identifier', foreground: '6d28d9' },                     /* violet-700 */
    { token: 'support.function', foreground: '92400e' },               /* amber-800 */
    { token: 'operator', foreground: '27272a' },
    { token: 'variable', foreground: 'c2410c' },
    { token: 'escape', foreground: '71717a', fontStyle: 'bold' },
  ],
  colors: {
    'editor.background': '#ffffff',        /* --color-bg-elevated */
    'editor.foreground': '#27272a',
    'editorLineNumber.foreground': '#63636b',  /* --color-text-muted */
    'editorLineNumber.activeForeground': '#27272a',
    'editor.selectionBackground': '#6366f130',
    'editor.lineHighlightBackground': '#f4f4f5',  /* --color-bg-secondary */
    'editorCursor.foreground': '#6366f1',
  },
};

// Dark theme
const DARK_THEME: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '86b86f', fontStyle: 'italic' },
    { token: 'tag', foreground: 'c586c0' },
    { token: 'tag.bracket', foreground: 'c586c0' },
    { token: 'keyword', foreground: 'a5b4fc' },      /* indigo-300: 400 is below 4.5:1 here */
    { token: 'keyword.other', foreground: 'a5b4fc' },
    { token: 'variable.name', foreground: 'fb923c' }, /* orange-400 */
    { token: 'delimiter', foreground: 'e4e4e7' },
    { token: 'string', foreground: 'c7d2fe' },        /* indigo-200 */
    { token: 'number', foreground: '34d399' },        /* emerald-400 */
    { token: 'constant.language', foreground: 'a5b4fc' },
    { token: 'regexp', foreground: 'f87171' },        /* red-400 */
    { token: 'regexp.escape', foreground: 'f87171', fontStyle: 'bold' },
    { token: 'type', foreground: '2dd4bf' },          /* teal-400 */
    { token: 'variable.value', foreground: 'fbbf24' },
    { token: 'identifier', foreground: '93c5fd' },
    { token: 'support.function', foreground: 'fbbf24' },
    { token: 'operator', foreground: 'e4e4e7' },
    { token: 'variable', foreground: '93c5fd' },
    { token: 'escape', foreground: '86b86f', fontStyle: 'bold' },
  ],
  colors: {
    'editor.background': '#303036',        /* --color-bg-elevated */
    'editor.foreground': '#f4f4f5',
    'editorLineNumber.foreground': '#acacb4',  /* --color-text-muted */
    'editorLineNumber.activeForeground': '#f4f4f5',
    'editor.selectionBackground': '#818cf850',
    'editor.inactiveSelectionBackground': '#818cf830',
    'editor.selectionHighlightBackground': '#818cf825',
    'editor.lineHighlightBackground': '#27272a',  /* --color-bg-secondary */
    'editorCursor.foreground': '#818cf8',
  },
};

function registerSplunkConfLanguage(disposables: IDisposable[]) {
  monaco.languages.register({ id: PROPS_LANGUAGE_ID });
  monaco.languages.register({ id: TRANSFORMS_LANGUAGE_ID });

  // Backs the "Open in dictionary" link in directive hovers. Reached through
  // the store's vanilla API because Monaco commands run outside React — and
  // guarded on the argument type because the id is addressable from any
  // `command:` URI Monaco decides to trust.
  disposables.push(monaco.editor.registerCommand(OPEN_DICTIONARY_COMMAND_ID, (_accessor, ...args: unknown[]) => {
    const key = args[0];
    if (typeof key === 'string' && key.length > 0) {
      useAppStore.getState().openDictionaryAt(key);
    }
  }));

  // Both languages share the same grammar and folding behaviour…
  disposables.push(monaco.languages.setMonarchTokensProvider(PROPS_LANGUAGE_ID, MONARCH_GRAMMAR));
  disposables.push(monaco.languages.setMonarchTokensProvider(TRANSFORMS_LANGUAGE_ID, MONARCH_GRAMMAR));
  disposables.push(monaco.languages.registerFoldingRangeProvider(PROPS_LANGUAGE_ID, createFoldingRangeProvider()));
  disposables.push(monaco.languages.registerFoldingRangeProvider(TRANSFORMS_LANGUAGE_ID, createFoldingRangeProvider()));

  // …but each gets only its own completions and hovers.
  disposables.push(monaco.languages.registerCompletionItemProvider(PROPS_LANGUAGE_ID, createCompletionProvider('props.conf')));
  disposables.push(monaco.languages.registerHoverProvider(PROPS_LANGUAGE_ID, createHoverProvider('props.conf')));
  disposables.push(monaco.languages.registerCompletionItemProvider(TRANSFORMS_LANGUAGE_ID, createCompletionProvider('transforms.conf')));
  disposables.push(monaco.languages.registerHoverProvider(TRANSFORMS_LANGUAGE_ID, createHoverProvider('transforms.conf')));

  // Quick fix for the mis-cased-attribute marker.
  disposables.push(monaco.languages.registerCodeActionProvider(PROPS_LANGUAGE_ID, createCodeActionProvider('props.conf')));
  disposables.push(monaco.languages.registerCodeActionProvider(TRANSFORMS_LANGUAGE_ID, createCodeActionProvider('transforms.conf')));

  monaco.editor.defineTheme('splunk-light', LIGHT_THEME);
  monaco.editor.defineTheme('splunk-dark', DARK_THEME);
}
