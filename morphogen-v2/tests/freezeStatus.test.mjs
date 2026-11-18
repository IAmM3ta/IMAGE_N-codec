// Morphogen v2 freeze status-line tests (node:test, no browser) — 2026-11-18.
// Run: npm test   (esbuild bundles app/freezeStatus.ts → .test-build/)
// Answers FREEZE-REVIEW.md's "which status text wins while frozen?" open
// question: a pinned "FROZEN by TD · 3.2s" countdown, a TD preset appends,
// and every thaw reason holds for THAW_STATUS_HOLD_MS then returns to the
// normal line. The module is not imported by main.ts (step-order guard below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createFreezeStatus,
  describeFrozen,
  describeThawReason,
  formatCountdown,
  FROZEN_PREFIX,
  THAW_STATUS_HOLD_MS,
  THAW_TEXT,
} from '../.test-build/freezeStatus.mjs';
import { parseTdCommand } from '../.test-build/tdCommand.mjs';

const EPOCH = 1_763_100_000_000;

function clock(start = EPOCH) {
  const c = { now: start, tick(ms) { c.now += ms; return c.now; } };
  return c;
}

function status(opts = {}) {
  const c = clock(opts.start);
  return { c, s: createFreezeStatus({ now: () => c.now, holdMs: opts.holdMs }) };
}

// --- formatCountdown / describeFrozen -------------------------------------

test('formatCountdown uses one decimal, rounds up, and clamps at 0.0', () => {
  assert.equal(formatCountdown(3200), '3.2');
  assert.equal(formatCountdown(3150), '3.2', '3150 ms is already 3.15 s; ceil to 3.2');
  assert.equal(formatCountdown(3101), '3.2', 'any leftover ms rounds up a tenth');
  assert.equal(formatCountdown(3100), '3.1');
  assert.equal(formatCountdown(1000), '1.0');
  assert.equal(formatCountdown(100), '0.1');
  assert.equal(formatCountdown(10), '0.1', 'any positive leftover never reads 0.0');
  assert.equal(formatCountdown(1), '0.1');
  assert.equal(formatCountdown(0), '0.0');
  assert.equal(formatCountdown(-1), '0.0', 'never negative');
  assert.equal(formatCountdown(-2500), '0.0');
  assert.equal(formatCountdown(null), null);
  assert.equal(formatCountdown(NaN), null);
  assert.equal(formatCountdown(Infinity), null);
});

test('describeFrozen pins FROZEN by TD with a live countdown, optional preset append', () => {
  assert.equal(describeFrozen(3200), 'FROZEN by TD · 3.2s');
  assert.equal(describeFrozen(10), 'FROZEN by TD · 0.1s');
  assert.equal(describeFrozen(0), 'FROZEN by TD · 0.0s');
  assert.equal(describeFrozen(-1), 'FROZEN by TD · 0.0s');
  assert.equal(describeFrozen(null), FROZEN_PREFIX, 'unknown clock: no made-up number');
  assert.equal(describeFrozen(3200, 'Coral'), 'FROZEN by TD · 3.2s · preset: Coral');
  assert.equal(describeFrozen(null, 'Coral'), 'FROZEN by TD · preset: Coral');
  assert.equal(describeFrozen(3200, null), 'FROZEN by TD · 3.2s');
});

// --- live freeze line, including a TD preset append -----------------------

test('while frozen the line is pinned and a later normal() is remembered, not shown', () => {
  const { c, s } = status();
  s.normal('idle');
  assert.equal(s.mode(), 'normal');
  assert.equal(s.text(), 'idle');

  s.frozen(3200);
  assert.equal(s.mode(), 'frozen');
  assert.equal(s.text(), 'FROZEN by TD · 3.2s');

  s.normal('hum muted'); // mute / lock / setParams: kept, not shown
  assert.equal(s.text(), 'FROZEN by TD · 3.2s');
  assert.equal(s.mode(), 'frozen');

  s.frozen(2100); // next frame: live countdown
  assert.equal(s.text(), 'FROZEN by TD · 2.1s');

  s.thawed('expired');
  assert.equal(s.mode(), 'thawed');
  c.tick(THAW_STATUS_HOLD_MS);
  assert.equal(s.mode(), 'normal');
  assert.equal(s.text(), 'hum muted', 'the muted line is what comes back after the hold');
});

test('a TD preset during a freeze appends rather than replacing the countdown', () => {
  const { s } = status();
  s.normal('idle');
  assert.equal(s.preset('Coral'), false, 'ignored while not frozen');
  assert.equal(s.text(), 'idle');

  s.frozen(3200);
  assert.equal(s.preset('Coral'), true);
  assert.equal(s.text(), 'FROZEN by TD · 3.2s · preset: Coral');

  s.frozen(2100); // later frames keep the suffix
  assert.equal(s.text(), 'FROZEN by TD · 2.1s · preset: Coral');

  assert.equal(s.preset('  Worms  '), true, 'a newer TD preset replaces the suffix');
  assert.equal(s.text(), 'FROZEN by TD · 2.1s · preset: Worms');

  assert.equal(s.preset(''), false);
  assert.equal(s.preset('   '), false);
  assert.equal(s.text(), 'FROZEN by TD · 2.1s · preset: Worms');
});

// --- every thaw reason, hold expiry, return to normal ---------------------

const REASONS = {
  local: 'thawed — you took over',
  expired: "thawed — time's up",
  silence: 'thawed — TD went quiet',
  thaw: 'thawed — TD released',
  disconnect: 'thawed — TD disconnected',
};

test('every thaw reason has a phrase and holds for THAW_STATUS_HOLD_MS then returns to normal', () => {
  assert.equal(THAW_STATUS_HOLD_MS, 1500);
  for (const [reason, phrase] of Object.entries(REASONS)) {
    const { c, s } = status();
    s.normal('idle · https (sync path A/B/C)');
    s.frozen(1000);
    if (reason === 'local') s.preset('Coral'); // the suffix must drop on thaw
    s.thawed(reason);
    assert.equal(s.mode(), 'thawed', reason);
    assert.equal(s.text(), phrase, reason);
    assert.equal(describeThawReason(reason), phrase, reason);
    assert.equal(s.text().includes('preset:'), false, `${reason} dropped the preset suffix`);

    c.tick(THAW_STATUS_HOLD_MS - 1);
    assert.equal(s.mode(), 'thawed', `${reason} still holding at ${THAW_STATUS_HOLD_MS - 1} ms`);
    assert.equal(s.text(), phrase, reason);

    s.normal('Field: Coral (9/10) · feed 0.0545 · kill 0.0620'); // arrives during the hold
    assert.equal(s.text(), phrase, `${reason}: a normal update during the hold is not shown yet`);

    c.tick(1);
    assert.equal(s.mode(), 'normal', `${reason} hold ends at exactly ${THAW_STATUS_HOLD_MS} ms`);
    assert.equal(
      s.text(),
      'Field: Coral (9/10) · feed 0.0545 · kill 0.0620',
      `${reason}: the update that arrived during the hold is what comes back`,
    );
  }
});

test('a clock that is unusable or runs backwards ends the thaw hold rather than extending it', () => {
  const c = { now: EPOCH };
  const s = createFreezeStatus({ now: () => c.now });
  s.normal('idle');
  s.frozen(1000);
  s.thawed('local');
  assert.equal(s.text(), 'thawed — you took over');

  c.now = EPOCH - 10_000; // backwards
  assert.equal(s.mode(), 'normal');
  assert.equal(s.text(), 'idle');

  const s2 = createFreezeStatus({ now: () => NaN });
  s2.normal('idle');
  s2.frozen(1000);
  s2.thawed('expired');
  assert.equal(s2.mode(), 'normal', 'unusable clock: no un-timed hold');
  assert.equal(s2.text(), 'idle');
});

test('a new freeze during a thaw hold replaces the reason with the countdown', () => {
  const { c, s } = status();
  s.normal('idle');
  s.frozen(1000);
  s.thawed('expired');
  assert.equal(s.text(), "thawed — time's up");
  s.frozen(5000);
  assert.equal(s.mode(), 'frozen');
  assert.equal(s.text(), 'FROZEN by TD · 5.0s');
  c.tick(THAW_STATUS_HOLD_MS);
  assert.equal(s.mode(), 'frozen', 'the old hold must not yank the new freeze off the line');
  assert.equal(s.text(), 'FROZEN by TD · 5.0s');
});

// --- exhaustiveness vs freezeLease.ts -------------------------------------

test('THAW_TEXT is exhaustive against every ThawReason in freezeLease.ts', () => {
  const lease = readFileSync(new URL('../src/sync/freezeLease.ts', import.meta.url), 'utf8');
  const m = lease.match(/export type ThawReason = ([^;]+);/);
  assert.ok(m, 'freezeLease.ts still exports type ThawReason');
  const reasons = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.ok(reasons.length >= 5, `expected at least the five known reasons, got ${reasons}`);
  assert.deepEqual(Object.keys(THAW_TEXT).sort(), [...reasons].sort(),
    'THAW_TEXT keys must match the ThawReason union exactly — add a phrase when a reason is added');
  for (const r of reasons) {
    assert.equal(typeof THAW_TEXT[r], 'string');
    assert.ok(THAW_TEXT[r].startsWith('thawed — '), `${r} phrase starts with "thawed — "`);
    assert.equal(describeThawReason(r), THAW_TEXT[r]);
    assert.equal(REASONS[r], THAW_TEXT[r], `test table covers ${r}`);
  }
});

// Browser half of the step order, like freezeWiring.test.mjs:
// main.ts may import freezeStatus only in the same change that lets the
// parser accept `freeze`. Delete this test in that change.
test('step order: main.ts does not import freezeStatus while freeze is refused', () => {
  const refused = parseTdCommand(JSON.stringify({ v: 1, cmd: 'freeze', ms: 1000 })) === null;
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  if (refused) assert.doesNotMatch(main, /freezeStatus|createFreezeStatus|THAW_TEXT|describeFrozen|describeThawReason/);
});
