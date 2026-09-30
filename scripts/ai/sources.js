/* ============================================================
   SaveHatke AI — pipeline source inventory.

   `data/ai/training/compiled.json` is a build artefact: prepareData writes
   it and evaluate reads it. It is committed so `ai:eval` can run on a fresh
   checkout, which means it can go stale — edit a fixture, run only
   `ai:eval`, and the reported accuracy describes the previous data.

   A timestamp cannot detect that reliably (a fresh clone stamps every file
   with the checkout time, in arbitrary order), so a content fingerprint is
   used instead. prepareData records it; evaluate recomputes and compares.

   Both scripts import this module so the file list exists once.
   ============================================================ */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this file rather than from cwd. */
export const ROOT = path.resolve(HERE, '..', '..');

/** Every file the compiled artefact is derived from. */
export const SOURCE_FILES = [
  'data/ai/intents.json',
  'data/ai/knowledge.json',
  'data/ai/responses.json',
  'data/ai/training/intents.jsonl',
  'data/ai/training/examples.jsonl',
  'data/ai/training/conversations.jsonl',
  'data/ai/training/security.jsonl',
  'data/ai/eval/intents.jsonl',
  'data/ai/eval/entities.jsonl',
  'data/ai/eval/unknown.jsonl',
];

/**
 * Content fingerprint of every source fixture. Paths are included so that
 * moving a fixture between files also changes the result.
 *
 * @returns {string} 16 hex characters
 */
export function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const relative of SOURCE_FILES) {
    const full = path.join(ROOT, relative);
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.existsSync(full) ? fs.readFileSync(full) : '');
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
