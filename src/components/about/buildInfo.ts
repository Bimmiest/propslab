// ---------------------------------------------------------------------------
// buildInfo.ts
// The build-time facts about this bundle (see the defines in vite.config.ts),
// in the forms the status bar and the About dialog show.
// ---------------------------------------------------------------------------

/** Seven characters, the length `git log --oneline` and GitHub show. */
export const SHORT_COMMIT = __APP_COMMIT__.slice(0, 7);

/** What the bug report form asks for, for example "Propslab 1.3.0, build 9f9744f". */
export const BUILD_LABEL = `Propslab ${__APP_VERSION__}, build ${SHORT_COMMIT}`;

export const REPOSITORY_URL = __APP_REPOSITORY__;

/** The commit on GitHub, or null outside a git checkout, where there is no commit to link to. */
export const COMMIT_URL = __APP_COMMIT__ === 'unknown' ? null : `${REPOSITORY_URL}/commit/${__APP_COMMIT__}`;

/** The commit's date, or null when git could not give one. */
export const COMMIT_DATE = Number.isNaN(Date.parse(__APP_COMMIT_DATE__)) ? null : new Date(__APP_COMMIT_DATE__);
