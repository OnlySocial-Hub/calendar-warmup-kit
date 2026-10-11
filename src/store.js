// store.js — a tiny crash-safe JSON store.
// ---------------------------------------------------------------------------
// The calendar/warm-up state (accounts, their clocks, their scheduled posts) has
// to survive restarts — a bot restarts a lot (code changes, crashes, power). The
// naive `writeFileSync(JSON.stringify(...))` is dangerous: die mid-write and the
// file is left half-written, and the next boot reads it as empty — silently
// wiping every account's schedule and warm-up clock.
//
// So writes are atomic: write a temp file, keep the previous good copy as .bak,
// then rename over the real file (rename is atomic on one filesystem). Reads
// recover from .bak on a corrupt file instead of pretending it was empty. This is
// the one piece of "plumbing" in the kit, kept because it's the difference
// between a reliable farm and one that quietly forgets everything.

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { if (existsSync(file)) copyFileSync(file, `${file}.bak`); } catch { /* a missing backup must never block the write */ }
  renameSync(tmp, file);
}

export function readJsonSafe(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt — recover below */ }
  try {
    if (existsSync(`${file}.bak`)) return JSON.parse(readFileSync(`${file}.bak`, 'utf8'));
  } catch { /* backup bad too */ }
  return fallback;
}
