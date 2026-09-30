// Reads the provider registries of the REAL Monaco, by asking its language
// features service how many providers each feature has for a language.
//
// This is a test aid: it reaches two internal modules (declared in
// monacoInternals.d.ts), because `monaco.languages.register*Provider` returns a
// disposable but nothing to count. It exists so a registration test can assert
// against what Monaco actually holds, which a mocked `monaco.languages` cannot.

import * as monaco from 'monaco-editor/editor';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
import { ILanguageFeaturesService } from 'monaco-editor/editor/common/services/languageFeatures.js';

interface Registry {
  all(model: monaco.editor.ITextModel): readonly unknown[];
}

interface LanguageFeatures {
  hoverProvider: Registry;
  completionProvider: Registry;
  foldingRangeProvider: Registry;
  codeActionProvider: Registry;
}

export interface ProviderCounts {
  hover: number;
  completion: number;
  folding: number;
  codeAction: number;
}

/** How many providers of each kind Monaco would consult for a model in `languageId`. */
export function providerCounts(languageId: string): ProviderCounts {
  const features = StandaloneServices.get(ILanguageFeaturesService) as LanguageFeatures;
  const model = monaco.editor.createModel('', languageId);
  try {
    return {
      hover: features.hoverProvider.all(model).length,
      completion: features.completionProvider.all(model).length,
      folding: features.foldingRangeProvider.all(model).length,
      codeAction: features.codeActionProvider.all(model).length,
    };
  } finally {
    model.dispose();
  }
}
