import type { ConfDirective, ParsedConf, ValidationDiagnostic } from './types';
import { atDirective, atStanza } from './parser/provenance';
import { SIMULATED_DEST_KEYS, VALID_UNSIMULATED_DEST_KEYS, normaliseDestKey } from './transforms/destKeys';
import { getDirectiveSupport, isUndocumentedAttribute } from './directiveSupport';
import { lintInertTransformSettings, lintDirectiveValues } from './directiveLint';

// Config lint: the diagnostics `runPipeline` reports about the conf files
// themselves, split out of the pipeline so that file reads as the order of
// processing and nothing else (#301). Nothing here changes an event; each
// function only appends to `diagnostics`.

/**
 * Lint that depends on the conf text alone — unsimulated and unknown
 * directives, DEST_KEY/FORMAT pairing, dangling and unreferenced transforms,
 * inert settings and mistyped values.
 */
export function lintConfigs(
  propsConf: ParsedConf,
  transformsConf: ParsedConf,
  diagnostics: ValidationDiagnostic[],
): void {
  // Warn about LOOKUP directives — lookup table execution is not simulated
  for (const stanza of propsConf.stanzas) {
    for (const dir of stanza.directives) {
      if (dir.directiveType === 'LOOKUP') {
        diagnostics.push({
          level: 'warning',
          message: `LOOKUP-${dir.className ?? dir.key} is configured but lookup table execution is not simulated — fields will not be populated`,
          file: 'props.conf',
          ...atDirective(dir),
          directiveKey: dir.key,
        });
      }
    }
  }

  // Say so when a directive the user has written is not honoured by the preview
  // (#153). Without this the tool is confidently wrong: the key autocompletes,
  // hovers with real documentation, passes validation, and then the output is
  // rendered as though the line were not there. A stated limitation is worth
  // more than a plausible wrong answer.
  //
  // LOOKUP is skipped because it already has a more specific warning above, and
  // repeating it per attribute would bury the one that names the class.
  for (const [file, conf] of [
    ['props.conf', propsConf],
    ['transforms.conf', transformsConf],
  ] as const) {
    for (const stanza of conf.stanzas) {
      for (const dir of stanza.directives) {
        if (dir.directiveType === 'LOOKUP') continue;
        // A class-based key is written `EXTRACT-foo`; classification is by base.
        const baseKey = dir.className ? dir.directiveType : dir.key;
        const entry = getDirectiveSupport(baseKey);

        // A real attribute the registry has never heard of reaches this loop with
        // no entry and would leave it silently, which is the one way a valid line
        // can vanish without being declared. #178 swept the registry against the
        // 10.4.3 spec files so the set is empty today, but a later Splunk release
        // adds attributes and this is what stops them passing unnoticed. It gets
        // the same warning as an `ignored` key, because from where the user is
        // sitting it is the same event: they wrote a directive and it was ignored.
        //
        // Deliberately cites no issue number. The previous text named #178, which
        // has since closed -- a diagnostic pointing a user at a finished issue is
        // the rot #227 was about, reaching the product surface this time.
        if (!entry) {
          if (!isUndocumentedAttribute(baseKey)) continue;
          diagnostics.push({
            level: 'warning',
            message:
              `${dir.key} is a valid Splunk attribute that this simulator does not ` +
              `document or honour, so the preview ignores this line. Please report it ` +
              `so it can be classified.`,
            file,
            ...atDirective(dir),
            directiveKey: dir.key,
          });
          continue;
        }
        if (entry.support === 'simulated') continue;

        const tracking = entry.issue ? ` Tracked as #${entry.issue}.` : '';
        diagnostics.push({
          // `ignored` is a gap we intend to close, so it is a warning: the
          // preview is wrong and will change. `documented` is a deliberate,
          // permanent edge, so it is informational.
          level: entry.support === 'ignored' ? 'warning' : 'info',
          message:
            `${dir.key} is recognised but not simulated — the preview ignores it. ` +
            `${entry.note ?? ''}${tracking}`.trim(),
          file,
          ...atDirective(dir),
          directiveKey: dir.key,
        });
      }
    }
  }

  // Validate DEST_KEY=MetaData:* stanzas require the matching prefix in FORMAT.
  // Index is deliberately absent: transforms.conf.spec has `_MetaData:Index`
  // take the bare index name, and the prefix rule covers these three only (#281).
  const DEST_KEY_REQUIRED_PREFIX: Record<string, string> = {
    'MetaData:Host': 'host::',
    'MetaData:Source': 'source::',
    'MetaData:Sourcetype': 'sourcetype::',
  };
  // DEST_KEY only accepts a documented set of routing keys; the simulator otherwise
  // falls back to "treat as a field name", which Splunk does not do. The key sets
  // are shared with the router so config-time and match-time agree (#75.3).
  for (const stanza of transformsConf.stanzas) {
    // Last definition wins, as it does at runtime: with default/ + local/
    // layers the effective FORMAT is the local one, and linting the default's
    // would warn about a line that no longer applies (or miss the one that does).
    const destKeyDir = stanza.directives.filter((d) => d.key === 'DEST_KEY').at(-1);
    const formatDir = stanza.directives.filter((d) => d.key === 'FORMAT').at(-1);
    if (!destKeyDir) continue;

    // Normalise the _MetaData: alias the same way the router does.
    const destKey = normaliseDestKey(destKeyDir.value);

    if (VALID_UNSIMULATED_DEST_KEYS.has(destKey)) {
      diagnostics.push({
        level: 'warning',
        message: `DEST_KEY = ${destKeyDir.value.trim()} is a valid Splunk routing key but is not simulated — events will not be cloned/routed in the preview.`,
        file: 'transforms.conf',
        ...atDirective(destKeyDir),
        directiveKey: destKeyDir.key,
      });
    } else if (!SIMULATED_DEST_KEYS.has(destKey)) {
      diagnostics.push({
        level: 'warning',
        message: `DEST_KEY = ${destKeyDir.value.trim()} is not a recognised Splunk DEST_KEY. Splunk only accepts the documented keys (queue, _raw, _meta, _time, MetaData:Host/Source/Sourcetype/Index, _TCP_ROUTING, _SYSLOG_ROUTING). An unrecognised key has no routing effect.`,
        file: 'transforms.conf',
        ...atDirective(destKeyDir),
        directiveKey: destKeyDir.key,
      });
    }

    if (formatDir) {
      const requiredPrefix = DEST_KEY_REQUIRED_PREFIX[destKey];
      if (requiredPrefix && !formatDir.value.includes(requiredPrefix)) {
        diagnostics.push({
          level: 'warning',
          message: `DEST_KEY = ${destKeyDir.value.trim()} requires FORMAT to include the "${requiredPrefix}" prefix (e.g. FORMAT = ${requiredPrefix}$1). Without it Splunk silently skips the metadata update.`,
          file: 'transforms.conf',
          ...atDirective(formatDir),
          directiveKey: formatDir.key,
          suggestion: `Change FORMAT = ${formatDir.value.trim()} to FORMAT = ${requiredPrefix}${formatDir.value.trim()}`,
        });
      }
      // The mirror-image mistake: carrying the prefix habit over to the index
      // key. Splunk does not strip it, so the event is routed to an index
      // literally named `index::…`, which almost certainly does not exist.
      const format = formatDir.value.trim();
      if (destKey === 'MetaData:Index' && format.startsWith('index::')) {
        diagnostics.push({
          level: 'warning',
          message: `DEST_KEY = ${destKeyDir.value.trim()} takes the bare index name, not an "index::" prefix. Splunk does not strip it, so this routes events to an index literally named "${format}".`,
          file: 'transforms.conf',
          ...atDirective(formatDir),
          directiveKey: formatDir.key,
          suggestion: `Change FORMAT = ${format} to FORMAT = ${format.slice('index::'.length)}`,
        });
      }
    }
  }

  // Cross-reference validation: check TRANSFORMS/REPORT references exist, and collect
  // referenced stanza names in one pass (avoids iterating props stanzas twice).
  const referencedTransforms = new Set<string>();
  // How props.conf reaches each transforms stanza decides that stanza's phase,
  // which is what makes the inert-setting lint below possible. A stanza named by
  // both TRANSFORMS- and REPORT- is 'both', and is left alone.
  const transformPhase = new Map<string, 'index-time' | 'search-time' | 'both'>();
  for (const stanza of propsConf.stanzas) {
    for (const dir of stanza.directives) {
      if (dir.directiveType === 'TRANSFORMS' || dir.directiveType === 'REPORT') {
        const phase = dir.directiveType === 'TRANSFORMS' ? 'index-time' : 'search-time';
        const stanzaNames = dir.value.split(',').map((s) => s.trim()).filter(Boolean);
        for (const name of stanzaNames) {
          referencedTransforms.add(name);
          const seen = transformPhase.get(name);
          transformPhase.set(name, seen === undefined || seen === phase ? phase : 'both');
          if (!transformsConf.stanzas.find((s) => s.name === name)) {
            diagnostics.push({
              level: 'error',
              message: `Referenced transform stanza "${name}" not found in transforms.conf`,
              file: 'props.conf',
              ...atDirective(dir),
              directiveKey: dir.key,
            });
          }
        }
      }
    }
  }
  for (const stanza of transformsConf.stanzas) {
    if (stanza.type !== 'default' && !referencedTransforms.has(stanza.name)) {
      diagnostics.push({
        level: 'warning',
        message: `Transform stanza "${stanza.name}" is defined but never referenced from props.conf`,
        file: 'transforms.conf',
        ...atStanza(stanza),
      });
    }
  }

  // Two classes of mistake Splunk itself is silent about: a transforms setting
  // that is inert in the phase its stanza is used in (#177), and a value that is
  // not the type the directive documents (#179). Both load clean and then do
  // nothing, so this tool is the only place a user could find out.
  lintInertTransformSettings(transformsConf.stanzas, transformPhase, diagnostics);
  lintDirectiveValues(propsConf.stanzas, 'props.conf', diagnostics);
  lintDirectiveValues(transformsConf.stanzas, 'transforms.conf', diagnostics);
}

/**
 * Lint that depends on which stanzas matched the event: combinations of
 * effective settings that load cleanly and then misbehave.
 */
export function lintMatchedDirectives(
  directives: ConfDirective[],
  diagnostics: ValidationDiagnostic[],
): void {
  // Warn when INDEXED_EXTRACTIONS = json is paired with search-time JSON extraction.
  // Splunk extracts the fields at BOTH index time and search time, producing duplicate
  // (multivalue) values. The simulator currently suppresses the duplicate in the preview,
  // so without this warning an operator could ship a config that misbehaves in Splunk.
  const indexedExtJson = directives.find((d) => d.key === 'INDEXED_EXTRACTIONS')?.value.trim().toLowerCase() === 'json';
  if (indexedExtJson) {
    const kvModeDir = directives.find((d) => d.key === 'KV_MODE');
    const kvMode = kvModeDir?.value.trim().toLowerCase();
    const autoKvJsonDir = directives.find((d) => d.key === 'AUTO_KV_JSON');
    const autoKvJson = autoKvJsonDir ? autoKvJsonDir.value.trim().toLowerCase() !== 'false' : true;
    const searchTimeJson =
      kvMode === 'json' ||
      ((kvMode === undefined || kvMode === 'auto' || kvMode === 'auto_escaped') && autoKvJson);
    if (kvMode !== 'none' && searchTimeJson) {
      const kvDesc = kvMode ? `KV_MODE = ${kvMode}` : 'the default KV_MODE = auto';
      diagnostics.push({
        level: 'warning',
        message:
          `INDEXED_EXTRACTIONS = json already extracts fields at index time, but ${kvDesc} extracts them again at search time. ` +
          'In Splunk this produces duplicate (multivalue) field values. Set KV_MODE = none for this sourcetype when using INDEXED_EXTRACTIONS = json.',
        file: 'props.conf',
        ...atDirective(kvModeDir ?? directives.find((d) => d.key === 'INDEXED_EXTRACTIONS')),
      });
    }
  }
}
