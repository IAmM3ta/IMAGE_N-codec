// Morphogen v2 TD command doc drift test (2026-10-27, node:test, no browser).
// Run: npm test
// docs/morphogen-redteam/TD-COMMANDS.md is the human map of the TD -> app
// control plane. This test keeps it honest: the Limits table must match the
// real constants in src/sync/tdCommand.ts, every example frame the doc calls
// "accepted" must parse (and its pong must match), every reserved command the
// doc names must be refused, and the doc must point at the live fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_COMMAND_BYTES,
  MAX_PRESET_ID_LEN,
  COMMAND_RATE_PER_S,
  COMMAND_BURST,
  MAX_STATUS_MS,
  MAX_STATUS_COUNT,
  REMOTE_PARAM_RANGE,
  parseTdCommand,
  pongFor,
} from '../.test-build/tdCommand.mjs';
import { MIN_FREEZE_MS, MAX_FREEZE_MS, FREEZE_SILENCE_MS, describeFreeze, describeThaw } from '../.test-build/freezeLease.mjs';

const doc = readFileSync(new URL('../../docs/morphogen-redteam/TD-COMMANDS.md', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/td-commands.v1.json', import.meta.url), 'utf8'));

/** Value cell of the Limits table row whose last cell names `constant`. */
function limitRow(constant) {
  const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${constant}\``));
  assert.ok(row, `Limits table has a row for ${constant}`);
  const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
  const n = Number.parseFloat(cells[1]);
  assert.ok(Number.isFinite(n), `numeric value for ${constant}: ${cells[1]}`);
  return n;
}

test('Limits table matches tdCommand.ts constants', () => {
  assert.equal(limitRow('MAX_COMMAND_BYTES'), MAX_COMMAND_BYTES);
  assert.equal(limitRow('MAX_PRESET_ID_LEN'), MAX_PRESET_ID_LEN);
  assert.equal(limitRow('COMMAND_RATE_PER_S'), COMMAND_RATE_PER_S);
  assert.equal(limitRow('COMMAND_BURST'), COMMAND_BURST);
  assert.equal(limitRow('MAX_STATUS_MS'), MAX_STATUS_MS);
  assert.equal(limitRow('MAX_STATUS_COUNT'), MAX_STATUS_COUNT);
});

test('accepted example frames parse, and the ping example pong matches the doc', () => {
  const preset = parseTdCommand('{"v":1,"cmd":"preset","id":"coral"}');
  assert.deepEqual(preset, { cmd: 'preset', id: 'coral' });
  assert.ok(doc.includes('`{"v":1,"cmd":"preset","id":"coral"}`'));

  const ping = parseTdCommand('{"v":1,"cmd":"ping","t":1000}');
  assert.deepEqual(ping, { cmd: 'ping', t: 1000 });
  const pong = JSON.stringify(pongFor(ping));
  assert.ok(doc.includes(`\`${pong}\``), `doc shows the real pong ${pong}`);
  assert.deepEqual(pongFor(ping), fixture.pong.reply);
});

test('status example in the doc parses to the fixture row (2026-10-29)', () => {
  const raw = '{"v":1,"cmd":"status","rtt":{"last_ms":8.0,"median_ms":9.5,"samples":3,"outstanding":0,"lost":1}}';
  assert.ok(doc.includes(`\`${raw}\``), 'doc shows the status frame');
  const row = fixture.built.find((r) => r.raw === raw);
  assert.ok(row, 'fixture has the same status frame');
  assert.deepEqual(parseTdCommand(raw), row.parsed);
});

test('reserved commands named in the doc are refused', () => {
  // setParams left the reserved list on 2026-11-05, but a bare one (no knob) is still refused.
  for (const cmd of ['freeze', 'setParams']) {
    assert.ok(doc.includes(`\`${cmd}\``), `doc names ${cmd}`);
    assert.equal(parseTdCommand(JSON.stringify({ v: 1, cmd })), null);
  }
});

test('setParams example and range rows in the doc match the code (2026-11-05)', () => {
  const raw = '{"v":1,"cmd":"setParams","feed":0.056,"kill":0.062}';
  assert.ok(doc.includes(`\`${raw}\``), 'doc shows the setParams frame');
  const row = fixture.built.find((r) => r.raw === raw);
  assert.ok(row, 'fixture has the same setParams frame');
  assert.deepEqual(parseTdCommand(raw), row.parsed);
  for (const knob of ['feed', 'kill']) {
    const line = doc.split('\n').find((l) => l.startsWith('|') && l.includes(`\`REMOTE_PARAM_RANGE.${knob}\``));
    assert.ok(line, `Limits table has REMOTE_PARAM_RANGE.${knob}`);
    const nums = line.split('|')[2].match(/[0-9.]+/g).map(Number);
    assert.deepEqual(nums, [...REMOTE_PARAM_RANGE[knob]], `${knob} range row`);
  }
});

test('doc points at the live fixture and the code files it maps', () => {
  assert.equal(fixture.version, 1);
  for (const path of [
    'tests/fixtures/td-commands.v1.json',
    'src/sync/tdCommand.ts',
    'td/morphogen_sync_commands.py',
    'td/morphogen_sync_callbacks.py',
  ]) {
    assert.ok(doc.includes(path), `doc mentions ${path}`);
  }
});

// ---- freeze / thaw, staged docs (FREEZE-REVIEW.md step 5, 2026-11-15) ------
// TD-COMMANDS.md now carries the operator text for freeze / thaw ahead of the
// code, in a section whose heading says "refused today". These tests keep that
// section honest in both directions: its numbers must match freezeLease.ts,
// every frame it shows must be a fixture-built TD frame (so the doc can't show
// bytes TD would never send), and — the doc half of the step-order guard —
// every one of those frames must still be refused by parseTdCommand. When the
// refusal is lifted, the section moves into "Frames → Accepted" and the third
// test below is deleted in the same change (see the section's own note).

/** Lines of the "## Staged: `freeze` / `thaw` …" section, up to the next `## `. */
function stagedSection() {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## Staged:') && l.includes('`freeze`'));
  assert.ok(start >= 0, 'TD-COMMANDS.md has a "## Staged: `freeze` / `thaw`" section');
  assert.match(lines[start], /refused today/, 'staged heading says the frames are refused today');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Numeric value cell of the staged-limits row naming `constant`, read only
 * inside the staged section (the troubleshooting rows there also mention the
 * constants, so match on the third cell being exactly that constant).
 */
function stagedLimitRow(constant) {
  const rows = stagedSection()
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean))
    .filter((cells) => cells.length === 3 && cells[2] === `\`${constant}\``);
  assert.equal(rows.length, 1, `exactly one staged limit row for ${constant}`);
  const n = Number.parseFloat(rows[0][1]);
  assert.ok(Number.isFinite(n), `numeric value for ${constant}: ${rows[0][1]}`);
  return n;
}

/** Every inline-code JSON frame `{"v":1,…}` in the staged section. */
function stagedFrames() {
  return [...stagedSection().join('\n').matchAll(/`(\{"v":1,[^`]*\})`/g)].map((m) => m[1]);
}

test('staged freeze limits in the doc match freezeLease.ts and the fixture (2026-11-15)', () => {
  assert.equal(stagedLimitRow('MIN_FREEZE_MS'), MIN_FREEZE_MS);
  assert.equal(stagedLimitRow('MAX_FREEZE_MS'), MAX_FREEZE_MS);
  assert.equal(stagedLimitRow('FREEZE_SILENCE_MS'), FREEZE_SILENCE_MS);
  const range = fixture.freeze_staged.freeze_ms_range;
  assert.deepEqual([stagedLimitRow('MIN_FREEZE_MS'), stagedLimitRow('MAX_FREEZE_MS')], [range.min, range.max]);
  // The staged rows must not leak into the live Limits table yet: an operator
  // reading "Limits" would otherwise take freeze for a working command.
  const live = doc.split('\n## Limits\n')[1].split('\n## ')[0];
  for (const c of ['MIN_FREEZE_MS', 'MAX_FREEZE_MS', 'FREEZE_SILENCE_MS']) {
    assert.ok(!live.includes(`\`${c}\``), `${c} stays out of the live Limits table until freeze is accepted`);
  }
});

test('staged freeze / thaw frames in the doc are exactly fixture-built TD bytes (2026-11-15)', () => {
  const frames = stagedFrames();
  const built = new Set(fixture.freeze_staged.built.map((r) => r.raw));
  assert.ok(frames.some((f) => JSON.parse(f).cmd === 'freeze'), 'doc shows a freeze frame');
  assert.ok(frames.some((f) => JSON.parse(f).cmd === 'thaw'), 'doc shows a thaw frame');
  for (const f of frames) assert.ok(built.has(f), `doc frame ${f} is a freeze_staged.built row`);
});

test('every staged frame the doc shows is still refused — delete when freeze is accepted (2026-11-15)', () => {
  for (const f of stagedFrames()) assert.equal(parseTdCommand(f), null, `still refused: ${f}`);
  // The "Accepted" list must not mention freeze / thaw yet either.
  const accepted = doc.split('Accepted (v1):')[1].split('Refused (parse returns')[0];
  assert.ok(!/"cmd":"(freeze|thaw)"/.test(accepted), 'no freeze / thaw frame under Accepted');
});

test('staged status-line texts in the doc are the ones freezeLease.ts prints (2026-11-15)', () => {
  const text = stagedSection().join('\n');
  // describeFreeze(1500) -> "frozen by TD · 2 s left"; the doc shows it with N.
  assert.equal(describeFreeze(1500), 'frozen by TD · 2 s left');
  assert.ok(text.includes('`frozen by TD · N s left`'));
  assert.ok(text.includes('`thawed (<reason>)`'));
  for (const r of ['expired', 'thaw', 'disconnect', 'local', 'silence']) {
    assert.equal(describeThaw(r), `thawed (${r})`);
    assert.ok(text.includes(`\`${r}\``), `doc lists thaw reason ${r}`);
  }
  for (const path of ['src/sync/freezeLease.ts', 'src/app/freezeWiring.ts', 'td/morphogen_sync_commands.py']) {
    assert.ok(text.includes(path), `staged section mentions ${path}`);
  }
});
