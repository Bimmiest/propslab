// ---------------------------------------------------------------------------
// buildInfo.ts
// The build-time facts about this bundle and the engine in it (see the
// defines in vite.config.ts), in the forms the status bar and the About
// dialog show.
// ---------------------------------------------------------------------------

/** Seven characters, the length `git log --oneline` and GitHub show. */
export const SHORT_COMMIT = __APP_COMMIT__.slice(0, 7);

/** The app's half of the build label, for example "Propslab 1.3.0, build 9f9744f". */
export const APP_BUILD = `Propslab ${__APP_VERSION__}, build ${SHORT_COMMIT}`;

/** The engine's half of the build label, for example "engine 0.4.0, build 34c37e0". */
export const ENGINE_BUILD = `engine ${__ENGINE_VERSION__}, build ${__ENGINE_COMMIT__.slice(0, 7)}`;

/**
 * What the bug report form asks for, for example
 * "Propslab 1.3.0, build a3fa8a3; engine 0.4.0, build 34c37e0". A wrong
 * simulation result can come from either, so the label names both (#940).
 */
export const BUILD_LABEL = `${APP_BUILD}; ${ENGINE_BUILD}`;

export const REPOSITORY_URL = __APP_REPOSITORY__;

/** The commit on GitHub, or null outside a git checkout, where there is no commit to link to. */
export const COMMIT_URL = __APP_COMMIT__ === 'unknown' ? null : `${REPOSITORY_URL}/commit/${__APP_COMMIT__}`;

/** The commit's date, or null when git could not give one. */
export const COMMIT_DATE = Number.isNaN(Date.parse(__APP_COMMIT_DATE__)) ? null : new Date(__APP_COMMIT_DATE__);

export const ENGINE_REPOSITORY_URL = __ENGINE_REPOSITORY__;

/** The pinned engine commit on GitHub. The build stops when the pin names no commit, so there is always one. */
export const ENGINE_COMMIT_URL = `${ENGINE_REPOSITORY_URL}/commit/${__ENGINE_COMMIT__}`;
