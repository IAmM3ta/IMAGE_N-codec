// Morphogen v2 freeze rule 5 input map (node:test, no browser) — 2026-11-17.
// Run: npm test
//
// FREEZE-REVIEW.md rule 5 says "local input wins" and names five inputs;
// main.ts has more input sites than that, and two obvious homes for
// freeze.local() are wrong (canvas onPress only starts a *stopped* loop, and
// the preset cycler's apply is shared with TD's `preset` command). The
// review's "Rule 5 input map" decides every site. These tests keep that table
// and main.ts in step, so a new input can't arrive without answering "does
// this end a TD freeze?", and check the two code facts the map leans on.
// Keep them after the refusal is lifted: the map stays true then too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountFieldSliders } from '../.test-build/fieldTune.mjs';

const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const REVIEW = readFileSync(
  new URL('../../docs/morphogen-redteam/FREEZE-REVIEW.md', import.meta.url),
  'utf8',
);

// The calls whose option objects carry main.ts's input handlers.
const MOUNTS = [
  'createPresetCycler',
  'mountFieldSliders',
  'createFrameLoop',
  'mountPointerSeeding',
  'mountPanelStubs',
  'mountKeyboardShortcuts',
];

/** Input sites in main.ts: `<mount>.<handler>`, `<target>:<event>`, `td.onX`. */
function inputSites(src) {
  const sites = new Set();
  const mountRe = new RegExp(`\\b(${MOUNTS.join('|')})\\(`, 'g');
  for (const m of src.matchAll(/\b(on[A-Z]\w*|apply)\s*:/g)) {
    let owner = null;
    for (const c of src.slice(0, m.index).matchAll(mountRe)) owner = c[1];
    assert.ok(owner, `handler ${m[1]} at offset ${m.index} is outside every known mount call`);
    sites.add(`${owner}.${m[1]}`);
  }
  for (const m of src.matchAll(/\b(\w+)\.addEventListener\(\s*'(\w+)'/g)) sites.add(`${m[1]}:${m[2]}`);
  for (const m of src.matchAll(/\btd\.(on[A-Z]\w*)\s*=/g)) sites.add(`td.${m[1]}`);
  return sites;
}

/** Rows of the review's "Rule 5 input map" table: site → thaws column. */
function mapRows(md) {
  const start = md.indexOf('## Rule 5 input map');
  assert.ok(start >= 0, 'FREEZE-REVIEW.md has no "Rule 5 input map" section');
  const end = md.indexOf('\n## ', start + 1);
  const body = md.slice(start, end < 0 ? undefined : end);
  const rows = new Map();
  for (const m of body.matchAll(/^\| `([^`]+)` \| ([^|]+?) \|/gm)) {
    assert.ok(!rows.has(m[1]), `duplicate row ${m[1]}`);
    rows.set(m[1], m[2].trim());
  }
  return rows;
}

test('site scanner finds the inputs it is meant to (not vacuous)', () => {
  const sites = inputSites(MAIN);
  for (const s of ['mountPointerSeeding.onPress', 'mountFieldSliders.apply', 'createPresetCycler.apply', 'enter:click', 'td.onCommand']) {
    assert.ok(sites.has(s), `scanner missed ${s}`);
  }
  // A planted site in a copy of main.ts must show up.
  const planted = inputSites(MAIN.replace('onReset:', 'onPanic: () => {},\n    onReset:'));
  assert.ok(planted.has('mountPanelStubs.onPanic'));
});

test('every main.ts input site has exactly one row in the rule 5 map, and no stale rows', () => {
  const sites = [...inputSites(MAIN)].sort();
  const rows = [...mapRows(REVIEW).keys()].sort();
  assert.deepEqual(rows, sites, 'FREEZE-REVIEW "Rule 5 input map" out of step with src/main.ts');
});

test('the thaws column is decided for every row and pins the rule 5 list', () => {
  const rows = mapRows(REVIEW);
  for (const [site, v] of rows) {
    assert.ok(['yes', 'no', 'n/a', 'field only'].includes(v), `${site}: thaws column "${v}"`);
  }
  const yes = [...rows].filter(([, v]) => v === 'yes').map(([s]) => s).sort();
  // Rule 5: canvas press, ENTER, Reset, a preset step, a slider move.
  assert.deepEqual(yes, [
    'enter:click',
    'mountFieldSliders.apply',
    'mountKeyboardShortcuts.onPresetNext',
    'mountKeyboardShortcuts.onPresetPrev',
    'mountPanelStubs.onReset',
    'mountPointerSeeding.onPress',
  ]);
  assert.equal(rows.get('mountPanelStubs.onPanel'), 'field only');
  // The two traps: anything TD can reach must never count as local.
  assert.equal(rows.get('td.onCommand'), 'no');
  assert.equal(rows.get('createPresetCycler.apply'), 'no');
});

test('map fact: td.onCommand never reaches stepPreset (so local() can live there)', () => {
  const start = MAIN.indexOf('td.onCommand =');
  assert.ok(start >= 0);
  const end = MAIN.indexOf('\n  };', start);
  assert.ok(end > start, 'could not find the end of td.onCommand');
  const body = MAIN.slice(start, end);
  assert.doesNotMatch(body, /stepPreset|onPresetNext|onPresetPrev/);
  // ...and stepPreset is reached only from local handlers.
  const callers = [...MAIN.matchAll(/stepPreset\(/g)].length;
  assert.equal(callers, 3, 'stepPreset callers changed: Field panel, ] and [ expected');
});

test('map fact: sliders.sync() never calls apply (TD presets / setParams cannot thaw through it)', () => {
  const el = () => {
    const ls = new Set();
    return {
      value: '', min: '', max: '', step: '',
      addEventListener: (_t, cb) => ls.add(cb),
      removeEventListener: (_t, cb) => ls.delete(cb),
      fire() { for (const cb of ls) cb(); },
    };
  };
  const els = { feed: el(), kill: el() };
  const applied = [];
  const s = mountFieldSliders(els, {
    initial: { feed: 0.0367, kill: 0.0649 },
    apply: (patch) => applied.push(patch),
  });
  s.sync({ feed: 0.03, kill: 0.06 });
  s.sync({ feed: 0.055, kill: 0.062 });
  assert.equal(applied.length, 0, 'sync() must not route through apply');
  // A real slider move still does (the "yes" row).
  els.feed.value = '0.0400';
  els.feed.fire();
  assert.equal(applied.length, 1);
  s.unmount();
});
