/**
 * Morphogen v2 — frozen status line (2026-11-18).
 *
 * Answers FREEZE-REVIEW.md's open question "Which status text wins while
 * frozen?" (raised 2026-11-17 with the rule 5 input map). Like the rest of
 * the freeze work this is STAGED, NOT WIRED: parseTdCommand still refuses
 * `freeze` / `thaw`, main.ts does not import this file (guarded by
 * tests/freezeStatus.test.mjs), so landing it changes no runtime behaviour.
 *
 * The problem: while TD holds a lease, several things that do NOT thaw (per
 * the rule 5 input map) still call main.ts's `setStatus` — a TD `preset` or
 * `setParams`, the mute button / key, lock-loop. Each would overwrite the
 * rule 7 "frozen" line, and the operator would lose the one visible sign that
 * the still field is a hold and not a crash.
 *
 * The decision (approved 2026-11-18):
 *   - While frozen the status line is PINNED to `FROZEN by TD · <s>s`, a live
 *     countdown with one decimal (e.g. `FROZEN by TD · 3.2s`). Seconds are
 *     rounded UP to the next tenth, so a lease with any time left never reads
 *     `0.0s`; the value is clamped at 0.0 and is never negative. An unknown
 *     clock (lease.remaining() → null) prints just `FROZEN by TD`.
 *   - A TD `preset` during a hold APPENDS instead of replacing:
 *     `FROZEN by TD · 3.2s · preset: Coral`. The suffix belongs to that hold
 *     (renewals keep it, a newer TD preset replaces it, a thaw drops it).
 *   - Every other status text sent while frozen (TD setParams, mute, lock
 *     loop) is remembered as the "normal" line but not shown — each of those
 *     already has its own on-screen state (sliders snap via sliders.sync, the
 *     mute button's label / aria-pressed, the HUD loop counter), so nothing
 *     is lost; the line comes back after the thaw.
 *   - On thaw the line shows WHY for THAW_STATUS_HOLD_MS (1500 ms), one
 *     phrase per ThawReason (THAW_TEXT below), then returns to the latest
 *     normal line. A normal update that arrives during the hold is recorded
 *     and shown when the hold ends, so the reason is always readable.
 *
 * Pure + injected clock: nothing here calls Date.now. The controller reads
 * `deps.now`, which main.ts should give the same clock as the freeze wiring
 * (Date.now). A non-finite or backwards clock ENDS a thaw hold rather than
 * extending it, so a clock problem can only make the reason vanish early,
 * never pin "thawed — …" on screen.
 *
 * Intended main.ts wiring when the refusal is lifted (not done yet):
 *   const freezeStatus = createFreezeStatus({ now: Date.now });
 *   const freeze = createFreezeWiring({ …, onThaw: (r) => freezeStatus.thawed(r) });
 *   const paint = () => { const t = freezeStatus.text(); if (status.textContent !== t) status.textContent = t; };
 *   setStatus = (s) => { freezeStatus.normal(s); paint(); };
 *   onFrame:  steps = freeze.frame(steps);
 *             if (freeze.held()) freezeStatus.frozen(freeze.remaining());
 *             paint();                       // live countdown + hold expiry
 *   td.onCommand preset branch: if (freeze.held()) freezeStatus.preset(PRESETS[now].name);
 * `paint` goes after `freeze.frame` and BEFORE onFrame's `document.hidden`
 * return, next to the frame call, so a thaw that happens on a throttled
 * hidden-tab frame still updates the line.
 */

import type { ThawReason } from '../sync/freezeLease';

/** How long the thaw reason stays on the status line before the normal line returns. */
export const THAW_STATUS_HOLD_MS = 1_500;

/** Prefix of the pinned line; tests and TD-COMMANDS.md key off it. */
export const FROZEN_PREFIX = 'FROZEN by TD';

/**
 * One phrase per lease end reason. `satisfies Record<ThawReason, string>`
 * makes this exhaustive at typecheck (`npx tsc --noEmit` in CI): adding a
 * reason to ThawReason without a phrase here, or leaving a stale key, fails
 * the build. tests/freezeStatus.test.mjs also compares these keys with the
 * union as written in freezeLease.ts.
 *   local      — performer input (rule 5)          → "you took over"
 *   expired    — lease ran out, check()            → "time's up"
 *   silence    — no TD frame for FREEZE_SILENCE_MS, or the 11-13 clock guard → "TD went quiet"
 *   thaw       — TD's explicit `thaw` frame (rule 2) → "TD released"
 *   disconnect — TdClient left 'open', or a fresh ack found a lease (rules 3, 4) → "TD disconnected"
 */
export const THAW_TEXT = {
  local: 'thawed — you took over',
  expired: "thawed — time's up",
  silence: 'thawed — TD went quiet',
  thaw: 'thawed — TD released',
  disconnect: 'thawed — TD disconnected',
} as const satisfies Record<ThawReason, string>;

/**
 * Countdown text for `remainingMs`: tenths of a second, rounded up, clamped
 * at 0.0. `3150` → "3.2", `10` → "0.1", `0` / negative → "0.0". Null or
 * non-finite (unknown clock) → null, so the caller prints no number at all
 * rather than a made-up one.
 */
export function formatCountdown(remainingMs: number | null): string | null {
  if (remainingMs === null || !Number.isFinite(remainingMs)) return null;
  const tenths = Math.ceil(Math.max(0, remainingMs) / 100);
  // `+ 0` turns a -0 from ceil into 0 so toFixed can never print "-0.0".
  return (tenths / 10 + 0).toFixed(1);
}

/** The pinned line: "FROZEN by TD · 3.2s", optionally "· preset: Coral". */
export function describeFrozen(remainingMs: number | null, preset: string | null = null): string {
  const s = formatCountdown(remainingMs);
  const base = s === null ? FROZEN_PREFIX : `${FROZEN_PREFIX} · ${s}s`;
  return preset ? `${base} · preset: ${preset}` : base;
}

/** The thaw line for one reason, e.g. "thawed — you took over". */
export function describeThawReason(reason: ThawReason): string {
  return THAW_TEXT[reason];
}

export type FreezeStatusDeps = {
  /** Clock for the thaw hold (epoch-style ms). Same clock as the freeze wiring. */
  now: () => number;
  /** Hold override for tests; non-finite / negative falls back to THAW_STATUS_HOLD_MS. */
  holdMs?: number;
};

export type FreezeStatus = {
  /** Every ordinary setStatus text. Remembered; shown when not frozen and not in a thaw hold. */
  normal(text: string): void;
  /** Each frame while the wiring holds steps, with the lease's remaining ms (null = unknown clock). */
  frozen(remainingMs: number | null): void;
  /** A TD preset applied during the hold. False (ignored) when not frozen or the name is empty. */
  preset(name: string): boolean;
  /** The wiring's onThaw: leave the frozen state and show the reason for the hold. */
  thawed(reason: ThawReason): void;
  /** What the status line should read right now. */
  text(): string;
  /** Debug / tests: which of the three states the line is in. */
  mode(): 'frozen' | 'thawed' | 'normal';
};

export function createFreezeStatus(deps: FreezeStatusDeps): FreezeStatus {
  const holdMs =
    typeof deps.holdMs === 'number' && Number.isFinite(deps.holdMs) && deps.holdMs >= 0
      ? deps.holdMs
      : THAW_STATUS_HOLD_MS;
  let normalText = '';
  let isFrozen = false;
  let remaining: number | null = null;
  let presetName: string | null = null;
  let thawText: string | null = null; // reason line, while its hold lasts
  let thawAt = 0;

  // Read the clock defensively: a throwing getter counts as unusable.
  const now = (): number => {
    try {
      return deps.now();
    } catch {
      return NaN;
    }
  };

  // True while the thaw reason should still show. Clears itself when the
  // hold has elapsed, or when the clock is unusable / went backwards.
  const holding = (): boolean => {
    if (thawText === null) return false;
    const elapsed = now() - thawAt;
    if (elapsed >= 0 && elapsed < holdMs) return true; // NaN fails both
    thawText = null;
    return false;
  };

  return {
    normal(text) {
      normalText = String(text);
    },
    frozen(remainingMs) {
      isFrozen = true;
      remaining = remainingMs;
      thawText = null; // a new hold replaces any reason still showing
    },
    preset(name) {
      const n = typeof name === 'string' ? name.trim() : '';
      if (!isFrozen || n === '') return false;
      presetName = n;
      return true;
    },
    thawed(reason) {
      // A reason outside the map (a JS caller, a future reason before this
      // file is updated) still thaws; it just prints the generic word.
      const text: string | undefined = (THAW_TEXT as Record<string, string>)[reason];
      isFrozen = false;
      remaining = null;
      presetName = null;
      thawText = text ?? 'thawed';
      const t = now();
      // An unusable clock means no hold at all: the reason can't be timed, so
      // it is skipped rather than risk pinning it.
      if (Number.isFinite(t)) thawAt = t;
      else thawText = null;
    },
    text() {
      if (isFrozen) return describeFrozen(remaining, presetName);
      if (holding()) return thawText as string;
      return normalText;
    },
    mode() {
      if (isFrozen) return 'frozen';
      return holding() ? 'thawed' : 'normal';
    },
  };
}
