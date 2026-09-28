import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { languages } from 'monaco-editor';
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

let languageRegistered = false;

/**
 * Idempotently register the splunk-conf language, providers and the
 * splunk-light/splunk-dark themes. Must run before any editor that references
 * those themes paints — including the plain-text Raw Log editor, which on
 * mobile can mount on its own before any SplunkEditor exists.
 */
export function ensureSplunkMonaco() {
  if (!languageRegistered) {
    languageRegistered = true;
    registerSplunkConfLanguage();
  }
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
      [/=\s*/, { token: 'delimiter', next: '@value' }],
      [/./, 'string'],
    ],
    stanza: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/[^\]]+/, 'tag'],
      [/\]/, { token: 'tag.bracket', next: '@pop' }],
    ],
    // Generic values (numbers, booleans, strftime, plain strings)
    value: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, { token: 'escape', next: '@valueCont' }],
      [/\b(true|false)\b/i, 'constant.language'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/%\d+[Nn]/, 'type'],
      [/%[YymdHeIMSpbBaAZzsTF]/, 'type'],
      [/./, 'string'],
    ],
    // Continuation states: same rules but only pop when a new directive starts (non-whitespace at line start)
    valueCont: [
      [/^\S/, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, 'escape'],
      [/\b(true|false)\b/i, 'constant.language'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/%\d+[Nn]/, 'type'],
      [/%[YymdHeIMSpbBaAZzsTF]/, 'type'],
      [/./, 'string'],
    ],
    // FIELDALIAS values: sourceField AS aliasField [, sourceField AS aliasField ...]
    fieldAliasValue: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, { token: 'escape', next: '@fieldAliasValueCont' }],
      [/\b(AS|as|As)\b/, 'keyword'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[a-zA-Z_][\w.{}*-]*/, 'variable'],
    ],
    fieldAliasValueCont: [
      [/^\S/, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, 'escape'],
      [/\b(AS|as|As)\b/, 'keyword'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[a-zA-Z_][\w.{}*-]*/, 'variable'],
    ],
    // Comma-separated stanza/transform references (REPORT, TRANSFORMS)
    listValue: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, { token: 'escape', next: '@listValueCont' }],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[^\s,\\]+/, 'tag'],
    ],
    listValueCont: [
      [/^\S/, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, 'escape'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[^\s,\\]+/, 'tag'],
    ],
    // LOOKUP values: lookup_name field1 (AS alias1)? field2 (AS alias2)? ...
    lookupValue: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, { token: 'escape', next: '@lookupValueCont' }],
      [/\b(AS|as|As)\b/, 'keyword'],
      [/\b(OUTPUT|OUTPUTNEW|output|outputnew)\b/, 'keyword'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[a-zA-Z_][\w.{}*-]*/, 'variable'],
    ],
    lookupValueCont: [
      [/^\S/, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, 'escape'],
      [/\b(AS|as|As)\b/, 'keyword'],
      [/\b(OUTPUT|OUTPUTNEW|output|outputnew)\b/, 'keyword'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
      [/[a-zA-Z_][\w.{}*-]*/, 'variable'],
    ],
    // Regex pattern values (EXTRACT, LINE_BREAKER, REGEX, etc.)
    regexValue: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, { token: 'escape', next: '@regexValueCont' }],
      [/\b(true|false)\b/i, 'constant.language'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/\(\?P?<\w+>/, 'regexp.escape'],
      [/\(\?[=!:]/, 'regexp.escape'],
      [/\\[rntdwsDWsSbB\\/.^$*+?()[\]{}|]/, 'regexp.escape'],
      [/[[\](){}|^$.*+?]/, 'regexp'],
      [/\$\d+/, 'variable.value'],
      [/./, 'string'],
    ],
    regexValueCont: [
      [/^\S/, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, 'escape'],
      [/\b(true|false)\b/i, 'constant.language'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/\(\?P?<\w+>/, 'regexp.escape'],
      [/\(\?[=!:]/, 'regexp.escape'],
      [/\\[rntdwsDWsSbB\\/.^$*+?()[\]{}|]/, 'regexp.escape'],
      [/[[\](){}|^$.*+?]/, 'regexp'],
      [/\$\d+/, 'variable.value'],
      [/./, 'string'],
    ],
    // EVAL expressions (SPL eval language)
    evalValue: [
      [/^./, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, { token: 'escape', next: '@evalValueCont' }],
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
    ],
    evalValueCont: [
      [/^\S/, { token: '@rematch', next: '@pop' }],
      [/\\\s*$/, 'escape'],
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
    ],
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

function registerSplunkConfLanguage() {
  monaco.languages.register({ id: PROPS_LANGUAGE_ID });
  monaco.languages.register({ id: TRANSFORMS_LANGUAGE_ID });

  // Backs the "Open in dictionary" link in directive hovers. Reached through
  // the store's vanilla API because Monaco commands run outside React — and
  // guarded on the argument type because the id is addressable from any
  // `command:` URI Monaco decides to trust.
  monaco.editor.registerCommand(OPEN_DICTIONARY_COMMAND_ID, (_accessor, ...args: unknown[]) => {
    const key = args[0];
    if (typeof key === 'string' && key.length > 0) {
      useAppStore.getState().openDictionaryAt(key);
    }
  });

  // Both languages share the same grammar and folding behaviour…
  monaco.languages.setMonarchTokensProvider(PROPS_LANGUAGE_ID, MONARCH_GRAMMAR);
  monaco.languages.setMonarchTokensProvider(TRANSFORMS_LANGUAGE_ID, MONARCH_GRAMMAR);
  monaco.languages.registerFoldingRangeProvider(PROPS_LANGUAGE_ID, createFoldingRangeProvider());
  monaco.languages.registerFoldingRangeProvider(TRANSFORMS_LANGUAGE_ID, createFoldingRangeProvider());

  // …but each gets only its own completions and hovers.
  monaco.languages.registerCompletionItemProvider(PROPS_LANGUAGE_ID, createCompletionProvider('props.conf'));
  monaco.languages.registerHoverProvider(PROPS_LANGUAGE_ID, createHoverProvider('props.conf'));
  monaco.languages.registerCompletionItemProvider(TRANSFORMS_LANGUAGE_ID, createCompletionProvider('transforms.conf'));
  monaco.languages.registerHoverProvider(TRANSFORMS_LANGUAGE_ID, createHoverProvider('transforms.conf'));

  // Quick fix for the mis-cased-attribute marker.
  monaco.languages.registerCodeActionProvider(PROPS_LANGUAGE_ID, createCodeActionProvider('props.conf'));
  monaco.languages.registerCodeActionProvider(TRANSFORMS_LANGUAGE_ID, createCodeActionProvider('transforms.conf'));

  monaco.editor.defineTheme('splunk-light', LIGHT_THEME);
  monaco.editor.defineTheme('splunk-dark', DARK_THEME);
}
