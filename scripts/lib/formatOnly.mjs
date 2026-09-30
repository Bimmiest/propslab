// Whether a change to a file is formatting only: Prettier, with the file's own
// config, prints the old and the new text identically. Such a change cannot
// alter what the code does, so it gives mutation testing nothing new to test.
// Text that does not parse is never formatting only.

import prettier from 'prettier';

/**
 * @param {string} filePath Path used to pick the parser and resolve the config.
 * @param {string} before The file's text on the base branch.
 * @param {string} after The file's text now.
 * @returns {Promise<boolean>}
 */
export async function isFormattingOnly(filePath, before, after) {
  const options = { ...(await prettier.resolveConfig(filePath)), filepath: filePath };
  try {
    return (await prettier.format(before, options)) === (await prettier.format(after, options));
  } catch {
    return false;
  }
}
