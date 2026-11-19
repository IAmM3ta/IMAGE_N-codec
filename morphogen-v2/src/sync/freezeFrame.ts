/**
 * Staged browser parser for the TD `freeze` / `thaw` frames (2026-11-19).
 *
 * FREEZE-REVIEW.md step 2 says "Browser: `parseTdCommand` cases". Every other
 * piece of that step is already staged (freezeLease.ts, freezeControl.ts,
 * src/app/freezeWiring.ts, src/app/freezeStatus.ts), but the *shape check*
 * for the two frames was still unwritten — so the lifting change would have
 * had to write new untrusted-input parsing on the same day it opened the door.
 * This module writes it now, on its own, tested against the shared fixture.
 *
 * NOT WIRED. Nothing imports this file except tests: `parseTdCommand` in
 * ./tdCommand.ts still returns null for `freeze` and `thaw`, and
 * tests/freezeFrame.test.mjs fails if tdCommand.ts, tdClient.ts or main.ts
 * import it while that is true (the parser half of the step-order guard; the
 * wiring and status halves live in freezeWiring / freezeStatus tests).
 *
 * Accepted (exact keys, nothing else):
 *   { v:1, cmd:"freeze", ms:<int> }  ms an integer in [MIN_FREEZE_MS, MAX_FREEZE_MS]
 *                                     = [250, 10 000] (freezeLease.ts), decided by
 *                                     the same isValidFreezeMs the lease uses, so
 *                                     the parser and the lease can never disagree
 *                                     about which `ms` is in range.
 *   { v:1, cmd:"thaw" }              no payload. Accepted even when nothing is
 *                                     frozen (rule 2: TD may send it defensively).
 *
 * Refused (→ null), per FREEZE-REVIEW rules 1 and 8:
 *   - `ms` missing, non-number, non-integer (1.5), non-finite, or outside the
 *     range — refused, never clamped: TD must not believe it holds a 60 s
 *     freeze the browser is running as 10 s.
 *   - any extra key (`until`, `reason`, a `ms` on `thaw`, …) — the whole frame
 *     is refused rather than half-applied, same as setParams.
 *   - everything parseTdCommand already refuses before looking at `cmd`:
 *     non-strings, frames over MAX_COMMAND_BYTES, bad JSON, arrays, `v` ≠ 1.
 *   - every other command. This is deliberately *not* a general parser: it
 *     returns null for preset / ping / status / setParams, so lifting the
 *     refusal is one delegation inside parseTdCommand, not a second parser.
 *
 * Note on numbers: JSON has one number type, so `2000`, `2000.0` and `2e3`
 * all arrive as the integer 2000 and are accepted. TD's builder always emits
 * the plain form (fixture row `["freeze", 2000.0]` → `"ms":2000`); the browser
 * judges the value, not the spelling — the same rule as setParams.
 *
 * Lifting the refusal (one reviewed change, see FREEZE-REVIEW "Order of
 * work"): move the two `cmd` branches below into parseTdCommand, before its
 * final `return null` (inline them rather than import this file: this module
 * imports MAX_COMMAND_BYTES from tdCommand.ts, so the reverse import would be a
 * cycle), add TdFreezeFrame's members to the TdCommand union, route the result
 * in main.ts to freeze.freeze(ms) / freeze.thaw(), point
 * tests/freezeFrame.test.mjs at parseTdCommand, and delete the step-order
 * guards and the fixture's `freeze_staged` split — then delete this file.
 */

import { MAX_COMMAND_BYTES } from './tdCommand';
import { isValidFreezeMs } from './freezeLease';

export type TdFreezeCommand = { cmd: 'freeze'; ms: number };
export type TdThawCommand = { cmd: 'thaw' };
/** What a well-formed freeze-family frame parses to once the refusal is lifted. */
export type TdFreezeFrame = TdFreezeCommand | TdThawCommand;

/** Exact key sets: a frame with any other key is refused whole (rule 8). */
const FREEZE_KEYS: ReadonlySet<string> = new Set(['v', 'cmd', 'ms']);
const THAW_KEYS: ReadonlySet<string> = new Set(['v', 'cmd']);

/** True when every own key of `m` is in `allowed` (missing keys are checked by the caller). */
function onlyKeys(m: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const k of Object.keys(m)) if (!allowed.has(k)) return false;
  return true;
}

/**
 * Parse one raw WebSocket frame as a staged `freeze` / `thaw` command.
 * Returns a fresh object, or null for anything else (see header). Pure: no
 * clock, no DOM, no lease — *whether* a valid freeze takes effect (authed
 * session, gate token, ENTER pressed) stays TdClient's and freezeWiring's job.
 */
export function parseFreezeFrame(raw: unknown): TdFreezeFrame | null {
  // Same pre-checks, in the same order, as parseTdCommand.
  if (typeof raw !== 'string' || raw.length > MAX_COMMAND_BYTES) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (m.v !== 1 || typeof m.cmd !== 'string') return null;

  if (m.cmd === 'freeze') {
    if (!onlyKeys(m, FREEZE_KEYS)) return null;
    // hasOwnProperty guards against a prototype-provided `ms` (JSON.parse
    // can't produce one, but the check is free and documents intent).
    if (!Object.prototype.hasOwnProperty.call(m, 'ms')) return null;
    const ms = m.ms;
    if (!isValidFreezeMs(ms)) return null; // refuse, never clamp (rule 1)
    // `-0` can't reach here (it is < MIN_FREEZE_MS), so `ms` is a plain positive int.
    return { cmd: 'freeze', ms };
  }
  if (m.cmd === 'thaw') {
    if (!onlyKeys(m, THAW_KEYS)) return null;
    return { cmd: 'thaw' };
  }
  // preset / ping / status / setParams / unknown: not this parser's business.
  return null;
}
