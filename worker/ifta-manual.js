// worker/ifta-manual.js
// (c) dbappsystems.com | daddyboyapps.com
//
// ALIAS ONLY — the real implementation lives in ./ifta_manual.js (underscore),
// which is what worker/index.js imports. This hyphenated file was created by a
// parallel build; rather than leave dead clutter, it re-exports the single
// source of truth so any stray import of either name resolves to the same
// handler. No logic lives here. Safe to delete from the GitHub web editor.
export { handleIftaManual } from './ifta_manual.js';
