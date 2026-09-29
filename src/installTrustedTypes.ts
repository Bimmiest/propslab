// Imported FIRST by main.tsx, for its side effect (#509).
//
// The CSP requires Trusted Types, and the default policy is what lets a
// worker's same-origin URL through (see trustedTypes.ts). ES modules evaluate
// in import order, so the install has to be a module of its own that the entry
// lists before everything else: a call in main.tsx's body runs only after every
// import — App, and the Monaco chunk if anything ever pulls it in statically —
// has evaluated. That was safe only because workers are created lazily; this
// makes it safe by construction, and main.test.tsx pins the order.
import { installDefaultTrustedTypesPolicy } from './trustedTypes';

installDefaultTrustedTypesPolicy();
