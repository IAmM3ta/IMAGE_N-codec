// Staged freeze / thaw frame parser (FREEZE-REVIEW.md step 2, 2026-11-19).
// src/sync/freezeFrame.ts is the shape check the lifting change will move into
// parseTdCommand. It is tested here against the SAME shared fixture TD's
// builders are (tests/fixtures/td-commands.v1.json, freeze_staged block), so
// "TD can build it" and "the browser would accept it" are pinned together
// before either side is switched on. Nothing imports it yet (guard below).
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFreezeFrame } from '../.test-build/freezeFrame.mjs';
import { parseTdCommand, MAX_COMMAND_BYTES } from '../.test-build/tdCommand.mjs';
import {
  MIN_FREEZE_MS,
  MAX_FREEZE_MS,
  isValidFreezeMs,
  createFreezeLease,
} from '../.test-build/freezeLease.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/td-commands.v1.json', import.meta.url), 'utf8'));
const staged = fixture.freeze_staged;
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// The parsed shape each fixture `build` row implies. The fixture has no
// `parsed` key for staged rows yet (it gains one when the rows move to the
// top-level `built` list), so derive it from what TD was asked to build.
function expectedFor([cmd, arg]) {
  if (cmd === 'freeze') return { cmd: 'freeze', ms: Number(arg) };
  if (cmd === 'thaw') return { cmd: 'thaw' };
  throw new Error(`unexpected staged build row ${cmd}`);
}

test('freezeFrame: every TD-built staged frame parses to its command', () => {
  assert.ok(staged.built.length >= 5, 'fixture still has the staged rows');
  for (const row of staged.built) {
    assert.deepEqual(parseFreezeFrame(row.raw), expectedFor(row.build), row.raw);
  }
  // Both ends of the range are inclusive; one past either end is refused.
  const f = (ms) => parseFreezeFrame(JSON.stringify({ v: 1, cmd: 'freeze', ms }));
  assert.deepEqual(f(MIN_FREEZE_MS), { cmd: 'freeze', ms: MIN_FREEZE_MS });
  assert.deepEqual(f(MAX_FREEZE_MS), { cmd: 'freeze', ms: MAX_FREEZE_MS });
  assert.equal(f(MIN_FREEZE_MS - 1), null);
  assert.equal(f(MAX_FREEZE_MS + 1), null);
});

test('freezeFrame: every staged browser refusal is refused (refuse, never clamp)', () => {
  for (const raw of staged.browser_refuses) assert.equal(parseFreezeFrame(raw), null, raw);
  // Same ms list the lease refuses, framed the way TD would send it.
  for (const ms of staged.lease_rejects_ms) {
    const raw = JSON.stringify({ v: 1, cmd: 'freeze', ms });
    assert.equal(parseFreezeFrame(raw), null, raw);
  }
  // Spellings JSON.stringify can't produce but a hand-typed TD script could.
  for (const raw of [
    '{"v":1,"cmd":"freeze","ms":NaN}',
    '{"v":1,"cmd":"freeze","ms":Infinity}',
    '{"v":1,"cmd":"freeze","ms":1e400}', // parses to Infinity
    '{"v":1,"cmd":"freeze","ms":-0}',
    '{"v":1,"cmd":"freeze","ms":[500]}',
    '{"v":1,"cmd":"freeze","ms":{"n":500}}',
    '{"v":1,"cmd":"freeze","ms":10000.5}',
  ]) {
    assert.equal(parseFreezeFrame(raw), null, raw);
  }
});

test('freezeFrame: exact keys only — extras refuse the whole frame', () => {
  for (const raw of [
    '{"v":1,"cmd":"freeze"}', // ms missing
    '{"v":1,"cmd":"freeze","ms":500,"reason":"cue"}',
    '{"v":1,"cmd":"freeze","ms":500,"__proto__":{"x":1}}',
    '{"v":1,"cmd":"thaw","reason":"cue"}',
    '{"v":1,"cmd":"thaw","ms":null}',
  ]) {
    assert.equal(parseFreezeFrame(raw), null, raw);
  }
  // Key order and JSON number spelling don't matter; the value does.
  assert.deepEqual(parseFreezeFrame('{"ms":1500,"cmd":"freeze","v":1}'), { cmd: 'freeze', ms: 1500 });
  assert.deepEqual(parseFreezeFrame('{"v":1,"cmd":"freeze","ms":2e3}'), { cmd: 'freeze', ms: 2000 });
  assert.deepEqual(parseFreezeFrame('{"cmd":"thaw","v":1}'), { cmd: 'thaw' });
});

test('freezeFrame: same envelope checks as parseTdCommand', () => {
  const ok = '{"v":1,"cmd":"thaw"}';
  for (const raw of [
    undefined,
    null,
    42,
    { v: 1, cmd: 'thaw' }, // already-parsed objects are not frames
    'not json',
    '[1,2,3]',
    'null',
    '"thaw"',
    '{"v":2,"cmd":"thaw"}',
    '{"v":"1","cmd":"thaw"}',
    '{"cmd":"thaw"}',
    '{"v":1,"cmd":"THAW"}', // case-sensitive, like every other cmd
    '{"v":1,"cmd":"Freeze","ms":500}',
    '{"v":1,"cmd":["thaw"]}',
  ]) {
    assert.equal(parseFreezeFrame(raw), null, String(raw));
  }
  // Size cap: padding with whitespace keeps it valid JSON, so only the cap refuses.
  const padded = ok.slice(0, -1) + ' '.repeat(MAX_COMMAND_BYTES - ok.length + 1) + '}';
  assert.equal(padded.length, MAX_COMMAND_BYTES + 1);
  assert.equal(parseFreezeFrame(padded), null);
  const atCap = ok.slice(0, -1) + ' '.repeat(MAX_COMMAND_BYTES - ok.length) + '}';
  assert.equal(atCap.length, MAX_COMMAND_BYTES);
  assert.deepEqual(parseFreezeFrame(atCap), { cmd: 'thaw' });
});

test('freezeFrame: not a general parser — every other command is null', () => {
  for (const row of fixture.built) assert.equal(parseFreezeFrame(row.raw), null, row.raw);
  for (const raw of fixture.browser_refuses) assert.equal(parseFreezeFrame(raw), null, raw);
});

test('freezeFrame: parser and lease agree on every ms (one range, one predicate)', () => {
  // Anything the parser accepts, a fresh lease must start; anything the lease
  // refuses, the parser must refuse. Swept across both edges plus junk.
  const samples = [];
  for (let ms = MIN_FREEZE_MS - 3; ms <= MIN_FREEZE_MS + 3; ms++) samples.push(ms);
  for (let ms = MAX_FREEZE_MS - 3; ms <= MAX_FREEZE_MS + 3; ms++) samples.push(ms);
  samples.push(0, -1, 1500, 2000, 250.5, 9999.999, Number.MAX_SAFE_INTEGER);
  for (const ms of samples) {
    const parsed = parseFreezeFrame(JSON.stringify({ v: 1, cmd: 'freeze', ms }));
    const lease = createFreezeLease();
    const started = lease.start(ms, 1_700_000_000_000);
    assert.equal(parsed !== null, isValidFreezeMs(ms), `parser vs isValidFreezeMs at ${ms}`);
    assert.equal(parsed !== null, started, `parser vs lease.start at ${ms}`);
    if (parsed) assert.equal(parsed.ms, ms);
  }
});

test('freezeFrame: returns a fresh object each call', () => {
  const a = parseFreezeFrame('{"v":1,"cmd":"freeze","ms":500}');
  const b = parseFreezeFrame('{"v":1,"cmd":"freeze","ms":500}');
  assert.notEqual(a, b);
  a.ms = 9;
  assert.equal(b.ms, 500);
});

// Parser half of the step order (wiring: freezeWiring.test.mjs, status line:
// freezeStatus.test.mjs, doc: tdCommandsDoc.test.mjs, TD: pytest). While
// parseTdCommand refuses freeze, the staged parser must stay test-only: no
// runtime module may import it, and parseTdCommand must still refuse every
// frame this parser would accept. Delete this test in the lifting change.
test('step order: freezeFrame is test-only while parseTdCommand refuses freeze', () => {
  const refused = parseTdCommand(JSON.stringify({ v: 1, cmd: 'freeze', ms: 1000 })) === null;
  if (!refused) return;
  for (const rel of ['../src/main.ts', '../src/sync/tdCommand.ts', '../src/sync/tdClient.ts']) {
    assert.doesNotMatch(src(rel), /freezeFrame|parseFreezeFrame/, `${rel} must not use the staged parser yet`);
  }
  for (const row of staged.built) {
    assert.notEqual(parseFreezeFrame(row.raw), null, row.raw);
    assert.equal(parseTdCommand(row.raw), null, `still refused at runtime: ${row.raw}`);
  }
});
