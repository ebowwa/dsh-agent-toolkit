/**
 * Fresh-URL shim over lib/index.js.
 *
 * The running dsh process caches modules by URL, so a patch row whose name
 * points at this exact file forever returns the code it imported first.
 * Future CODE changes to this plugin: put the full new code at a NEW fresh
 * URL (e.g. lib/hot2.js as a full copy, not a shim over a changed index),
 * then flip the patch row: disabled=true → change name → disabled=false.
 * This shim itself never changes content after first import.
 */
export * from "./index.js";
