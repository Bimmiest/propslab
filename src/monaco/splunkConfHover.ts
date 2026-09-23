import type { languages, editor, Position, CancellationToken, MarkdownStringTrustedOptions } from 'monaco-editor';
import { getDirectiveInfo, getClassBasedDirectiveBase } from '../engine/directiveRegistry';
import { classifyStanza } from '../engine/stanzaRegistry';
import { getStagesForDirective } from '../engine/pipelineStages';
import { OPEN_DICTIONARY_COMMAND_ID, openDictionaryCommandUri } from './dictionaryCommand';
import { escapeMarkdown, inlineCode } from './markdown';
import { buildTimeFormatPreview, renderTimeFormatPreview } from './timeFormatPreview';
import { useAppStore } from '../store/useAppStore';

/**
 * The first non-empty line of the loaded raw data, which is what the preview
 * tries the format against. Read straight from the store rather than threaded
 * through the provider: Monaco constructs these once at setup, long before any
 * data is loaded, so a value captured at registration would always be stale.
 */
function firstSampleLine(): string | undefined {
  const raw = useAppStore.getState().rawData;
  return raw.split('\n').find((l) => l.trim() !== '');
}

/**
 * The TIME_PREFIX in force for a line: the last one defined above it within the
 * same stanza. The engine anchors TIME_FORMAT immediately after TIME_PREFIX, so
 * a preview that ignored it would answer a different question from the pipeline.
 */
function timePrefixFor(model: editor.ITextModel, lineNumber: number): string | undefined {
  let prefix: string | undefined;
  for (let i = 1; i < lineNumber; i++) {
    const text = model.getLineContent(i).trim();
    if (text.startsWith('[')) {
      prefix = undefined; // a new stanza resets it
      continue;
    }
    const eq = text.indexOf('=');
    if (eq > 0 && text.substring(0, eq).trim() === 'TIME_PREFIX') {
      prefix = text.substring(eq + 1).trim();
    }
  }
  return prefix;
}

export function createHoverProvider(fileType: 'props.conf' | 'transforms.conf'): languages.HoverProvider {
  return {
    provideHover(
      model: editor.ITextModel,
      position: Position,
      _token: CancellationToken
    ): languages.ProviderResult<languages.Hover> {
      const line = model.getLineContent(position.lineNumber);

      // Check if hovering over a stanza header. Trim first: confParser's STANZA_RE
      // tolerates surrounding whitespace, so matching the raw line made hover
      // stricter than parsing and `[foo] ` got no hover at all.
      const stanzaMatch = line.trim().match(/^\[(.+)\]$/);
      if (stanzaMatch) {
        const stanzaName = stanzaMatch[1] ?? '';
        return {
          contents: [{ value: getStanzaHoverContent(stanzaName) }],
          range: {
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: line.length + 1,
          },
        };
      }

      const eqIdx = line.indexOf('=');

      // Hovering over the VALUE of a strftime directive renders it (#90).
      // Timestamp config fails silently, so making the pattern show its own
      // output is worth more here than restating the directive's docs.
      if (eqIdx > 0 && position.column - 1 > eqIdx) {
        const key = line.substring(0, eqIdx).trim();
        const info = getDirectiveInfo(key, fileType);
        if (info?.valueType === 'strftime') {
          const value = line.substring(eqIdx + 1);
          const markdown = renderTimeFormatPreview(
            buildTimeFormatPreview(value, {
              sampleLine: firstSampleLine(),
              timePrefix: timePrefixFor(model, position.lineNumber),
            }),
          );
          if (markdown !== '') {
            return {
              contents: [{ value: markdown }],
              range: {
                startLineNumber: position.lineNumber,
                startColumn: eqIdx + 2,
                endLineNumber: position.lineNumber,
                endColumn: line.length + 1,
              },
            };
          }
        }
      }

      // Check if hovering over a directive key (before =)
      if (eqIdx > 0 && position.column - 1 <= eqIdx) {
        const key = line.substring(0, eqIdx).trim();

        // Try exact match first
        let info = getDirectiveInfo(key, fileType);

        // Try class-based match
        if (!info) {
          const parsed = getClassBasedDirectiveBase(key);
          if (parsed) {
            info = getDirectiveInfo(parsed.base, fileType);
          }
        }

        if (info) {
          const keyStart = line.indexOf(key) + 1;
          return {
            // Trust is what lets the "Open in dictionary" command link work;
            // Monaco ignores `command:` URIs in untrusted Markdown. It is
            // narrowed to that one command rather than `true`, because the
            // content is NOT purely registry text: the heading is the key as
            // typed. formatDirectiveHover escapes it, so the document cannot
            // add a link — and if an escape were ever missed, the most a
            // forged link could do is open the dictionary (#296).
            contents: [{ value: formatDirectiveHover(info, key), isTrusted: DIRECTIVE_HOVER_TRUST }],
            range: {
              startLineNumber: position.lineNumber,
              startColumn: keyStart,
              endLineNumber: position.lineNumber,
              endColumn: keyStart + key.length,
            },
          };
        }
      }

      return null;
    },
  };
}

/** The only command a directive hover may run: its "Open in dictionary" link. */
const DIRECTIVE_HOVER_TRUST: MarkdownStringTrustedOptions = {
  enabledCommands: [OPEN_DICTIONARY_COMMAND_ID],
};

/**
 * Markdown for a directive-key hover. `actualKey` is document text, so it (and
 * the class name cut from it) is escaped; everything else is registry text.
 */
function formatDirectiveHover(
  info: import('../engine/directiveRegistry').DirectiveInfo,
  actualKey: string,
): string {
  const parts: string[] = [];

  parts.push(`### ${escapeMarkdown(actualKey)}`);

  if (info.isClassBased && actualKey.includes('-')) {
    const className = actualKey.split('-').slice(1).join('-');
    parts.push(`*Class-based directive* (${inlineCode(`${info.key}-<${className}>`)})`);
  }

  parts.push('');
  parts.push(info.description);
  parts.push('');

  // Said before the specification table rather than after it: whether the
  // preview honours the directive changes how everything below should be read.
  if (info.support !== 'simulated') {
    const tracking = info.supportIssue ? ` Tracked as #${info.supportIssue}.` : '';
    parts.push(
      info.support === 'ignored'
        ? `> ⚠️ **Not simulated.** ${info.supportNote ?? ''}${tracking}`.trim()
        : `> ℹ️ **Outside the simulation.** ${info.supportNote ?? ''}`.trim(),
    );
    parts.push('');
  } else if (info.supportNote) {
    parts.push(`> **Partly simulated.** ${info.supportNote}`);
    parts.push('');
  }

  parts.push('| Property | Value |');
  parts.push('|----------|-------|');
  parts.push(`| **Category** | ${info.category} |`);
  parts.push(`| **Phase** | ${info.phase} |`);
  parts.push(`| **Type** | ${info.valueType} |`);
  parts.push(`| **Default** | \`${info.defaultValue || '(none)'}\` |`);
  parts.push(`| **Applies to** | ${info.appliesTo} |`);

  const stages = getStagesForDirective(info.key);
  if (stages.length > 0) {
    parts.push(`| **Stage** | ${stages.map((s) => `${s.step}. ${s.name}`).join(', ')} |`);
  }

  if (info.enumValues && info.enumValues.length > 0) {
    parts.push(`| **Valid values** | ${info.enumValues.map((v) => `\`${v}\``).join(', ')} |`);
  }

  parts.push('');
  parts.push(`**Example:**`);
  parts.push(`\`\`\``);
  parts.push(info.example);
  parts.push(`\`\`\``);

  if (info.deprecated) {
    parts.push('');
    parts.push('> **Deprecated:** This directive is deprecated and may be removed in future versions.');
  }

  // Links to the canonical key, not `actualKey`: the dictionary documents
  // `EXTRACT`, and "EXTRACT-client_ip" is one instance of it.
  parts.push('');
  parts.push(`[Open in dictionary](${openDictionaryCommandUri(info.key)})`);

  return parts.join('\n');
}

/**
 * Render a stanza header hover from the shared stanza registry, so this and the
 * dictionary describe precedence identically.
 *
 * This hover is untrusted, so a forged `command:` link would not run — but the
 * stanza name is document text all the same, and unescaped it could still
 * restyle the hover or plant an ordinary link, so it is escaped too.
 */
function getStanzaHoverContent(stanzaName: string): string {
  const { kind, pattern } = classifyStanza(stanzaName);

  const parts: string[] = [`### \\[${escapeMarkdown(stanzaName)}\\]`, '', kind.description, ''];

  if (kind.id === 'sourcetype' && pattern) {
    parts.push(`Applies to events with ${inlineCode(`sourcetype=${pattern}`)}.`, '');
  } else if (pattern) {
    parts.push(`Matching pattern: ${inlineCode(pattern)}`, '');
  }

  parts.push(`**Precedence:** ${kind.precedence}`);

  if (kind.patternSyntax.length > 0) {
    parts.push('', '**Pattern syntax:**');
    for (const line of kind.patternSyntax) parts.push(`- ${line}`);
  }

  return parts.join('\n');
}
