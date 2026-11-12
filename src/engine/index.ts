// The engine's public API (ADR 0023). Code outside src/engine imports only
// from this file: the app, the MCP server, and propslab-sb and propslab-ent.
// A name that is not here is internal and can change without notice. To add
// one, export it here; to remove or rename one, search the consumers first.
export * from './types';
export { CIM_MODELS, type CimModel, CIM_VERSION } from './cim/cimModelsData';
export { type CimValidationResult, validateCimCompliance } from './cim/cimModels';
export { lintConfigs } from './configLint';
export { lintDirectiveValues, lintInertTransformSettings } from './directiveLint';
export {
  type DirectiveInfo,
  getAllDirectives,
  getCanonicalDirectiveKey,
  getClassBasedDirectiveBase,
  getDirectiveInfo,
  getDirectivesByCategory,
  getDirectivesForFile,
  wrongFileCanonical,
  WRONG_FILE_MESSAGE,
} from './directiveRegistry';
export { isUndocumentedAttribute } from './directiveSupport';
export { type GroupedNoOp, groupNoOps } from './groupNoOps';
export { misspelledCanonical, MISSPELLED_MESSAGE } from './misspelledDirective';
export { describeNoOp } from './noOpExplainer';
export { DIRECTIVE_RE, miscasedCanonical, MISCASED_MESSAGE, parseConf, STANZA_RE } from './parser/confParser';
export {
  type EffectiveDirective,
  type OverriddenByStanza,
  resolveEffectiveConfig,
  type StanzaOrigin,
} from './parser/effectiveConfig';
export { atDirective } from './parser/provenance';
export { isStanzaDisabled, matchStanzas, mergeDirectives, resolveStanzasForEvent } from './parser/stanzaMatcher';
export { getStagesForDirective, PHASE_LABELS, PIPELINE_STAGES, type PipelineStage } from './pipelineStages';
export { runPipeline } from './pipeline';
export { regexFailureMessage } from './processors/eval/builtins';
export { type Node, parseExpression } from './processors/eval/parser';
export { parseExtractValue } from './processors/fieldExtractor';
export { applySedCommands, parseSedExpression, sedPattern } from './processors/sedCmd';
export { extractTimestamps, EXTRA_TIME_FIELD_NAMES, resolveLookahead } from './processors/timestampExtractor';
export { readTimestampLocation } from './processors/timestampRecognizer';
export { matchInputs, type RegexMatchInfo } from './regexMatch';
export { createRunContext, type RunContext } from './runContext';
export { RUN_STAGES, type RunStage } from './runStages';
export { SAMPLE_CONFIGS, type SampleConfig } from './sampleData';
export { detectLogFormat } from './scaffold/analyzers/logFormat';
export { locateTimestamp } from './scaffold/analyzers/timestamp';
export { buildExtractFromSelection, timePrefixFromSelection, toCaptureGroupName } from './scaffold/fromSelection';
export { scaffoldConfig } from './scaffold/scaffoldConfig';
export { appendStanza, renderStanza, stanzaNameError, upsertDirectiveInStanza } from './scaffold/serialize';
export { type Confidence, type ScaffoldResult, type ScaffoldSuggestion } from './scaffold/types';
export { classifyStanza, STANZA_KINDS, type StanzaKind } from './stanzaRegistry';
export {
  probeTimestamps,
  probeTimestamp,
  type TimeConfig,
  type TimestampMatch,
  type TimestampProbe,
} from './timestampMatch';
export { ingestEvalTrees } from './transforms/ingestEval';
export {
  endsWithContinuation,
  isDisallowedNegative,
  isEnumMember,
  isIntegerLiteral,
  isSplunkBoolLiteral,
  parseSplunkBool,
  regexProblem,
} from './utils/directiveValues';
export { getField, hasField } from './utils/fieldBag';
export { fieldNameNeedsQuoting, unquoteFieldName } from './utils/fieldRef';
export { getMetadataField, indexedFields, METADATA_FIELD_NAMES } from './utils/metadataFields';
export { hasReDoSRisk } from './utils/redosHeuristic';
export {
  escapeRegex,
  extractionLimits,
  initRegexEngineSync,
  initRegexEngine,
  isRegexEngineReady,
  type RegexEngineModule,
  regexEngineModule,
  regexError,
  type RegexLimits,
  safeRegex,
  SplunkRegex,
  validateRegex,
} from './utils/splunkRegex';
export {
  formatSpecifiers,
  formatStrftime,
  parseTimestamp,
  strftimeToRegex,
  supportedSpecifiers,
  unsupportedSpecifiers,
} from './utils/strftime';
