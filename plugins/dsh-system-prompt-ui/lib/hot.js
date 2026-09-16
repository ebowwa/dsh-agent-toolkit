/**
 * Re-export shim over ./index.js — the cordis.patch.yml row points HERE, not
 * at the package name, because the running dsh process caches module URLs: a
 * same-URL re-import never re-reads node-half code, so live code swaps import
 * a fresh URL. This file held the full copy during the swap; it is now a shim
 * so boots always load ./index.js and the copy can never go stale. To ship a
 * future node-half change without restarting dsh: put the new code at a fresh
 * URL (e.g. hot2.js, a full copy), set the row's config.disabled=true, then
 * re-point name at the fresh file and set disabled=false; collapse to a shim
 * afterward. Do not hand-edit this file.
 */
export * from "./index.js";
