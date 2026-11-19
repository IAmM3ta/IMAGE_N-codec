# Morphogen v2 — `freeze` limits review (TD → app)

_Design review, added 2026-11-07. Status: **still refused.** `parseTdCommand`
returns `null` for `{v:1, cmd:"freeze"}` today, and
`tests/tdCommandsDoc.test.mjs` asserts that. This page answers the question the
`src/sync/tdCommand.ts` header has carried since 2026-10-21 — "who un-freezes
the sim if TD drops?" — so the next implementation pass starts from agreed
rules instead of re-deriving them. No code changed with this note._

_Progress 2026-11-08: step 2's pure helper has landed on its own —
`morphogen-v2/src/sync/freezeLease.ts` (`createFreezeLease`, `isValidFreezeMs`,
`MIN_FREEZE_MS` 250 / `MAX_FREEZE_MS` 10 000 / `FREEZE_SILENCE_MS` 3 000,
`describeFreeze` / `describeThaw`) with 12 node tests in
`tests/freezeLease.test.mjs`. It is not imported by `main.ts` and the parser
still refuses `freeze`, so runtime behaviour is unchanged. Still to do: the
fixture rows (step 1), `parseTdCommand` cases and `main.ts` / `TdClient`
wiring (rest of step 2), the TD twin (step 3) and the integration tests in
step 4._

_Progress 2026-11-09: step 3's pure builders have landed —
`td/morphogen_sync_commands.py` has `MIN_FREEZE_MS` / `MAX_FREEZE_MS` (pinned
to `freezeLease.ts` by a pytest), `make_freeze_command(ms)` and
`make_thaw_command()`, with the same refuse-not-clamp rules. `send_freeze` /
`send_thaw` and the `freeze` row in `morphogen_cmds` wait until the browser
accepts the frame; `test_no_freeze_sender_until_the_browser_accepts_it`
enforces that order and should be deleted in that change._

_Progress 2026-11-10: step 1 is staged in the shared fixture as a separate
`freeze_staged` block in `tests/fixtures/td-commands.v1.json` — `freeze_ms_range`
(250 / 10 000), five TD-built frames (`freeze` 250 / 1500 / 2000.0→2000 /
10 000 and a bare `thaw`), ten builder rejects, eight browser refusals and the
`ms` values the lease must refuse. Both suites read it: pytest checks TD's
bytes, rejects and limits; `tdContract.test.mjs` checks the range against
`freezeLease.ts` and that **every** staged frame, well-formed or not, is still
refused by `parseTdCommand`. That last test is the browser half of the
step-order guard. Lifting the refusal = move the `built` rows (with a `parsed`
shape) into the top-level `built` list, drop the plain `freeze` row from
`browser_refuses`, delete both guard tests — in one change, alongside step 2's
wiring and step 4's tests._

_Progress 2026-11-11: step 4's behaviour tests now exist, against a pure
binding rather than `main.ts` — `morphogen-v2/src/sync/freezeControl.ts`
(`createFreezeControl({halt, resume, onThaw})`) owns *who restarts the loop and
when*: `freeze(ms, now)` halts once (renewals don't re-halt; refused frames
and frames before an authed `open` touch nothing), `thaw()`, `status(s)` thaws
synchronously on leaving `open` — TdClient fires `onStatus('reconnecting')`
before it arms the backoff timer, so the field is running before any retry —
and on a fresh `open`, `local()` and `tick(now, lastFrameAt)` for expiry /
silence. It only resumes a loop it halted itself. 14 cases in
`tests/freezeControl.test.mjs`. Still unwired: the parser refuses `freeze`, and
lifting that remains the one reviewed change described above (parser cases,
`main.ts` calls into this binding, `send_freeze` / `send_thaw`, fixture move,
`TD-COMMANDS.md`)._

_Progress 2026-11-12: wiring correction. The 11-11 note planned
`halt` / `resume` = `loop.stop()` / `loop.start()` with "a per-frame `tick`" —
those two can't both be true: a stopped loop has no frames, so nothing would
call `tick` and an expired or silent freeze would never end. `createStepHold()`
in `src/app/loop.ts` is the replacement: `halt` / `resume` = `hold.hold` /
`hold.release`, and `onFrame` runs `steps = hold.gate(steps)` after
`freeze.tick(now, td.commandStats().lastAt)`. The loop keeps running, so the HUD, Hum
modulation and the tick stay alive; `paceSteps` keeps consuming time while
held, so a thaw never bursts; `release` never calls `loop.start()`. Six cases
in `tests/stepHold.test.mjs` drive the real loop + real binding with a fake
rAF. One known gap, accepted: `onFrame` returns early while
`document.hidden`, and browsers pause rAF in hidden tabs anyway, so a freeze
that expires in a background tab is ended on the first frame after the tab
returns. Still refused; lifting it is the same one change as before._

_Progress 2026-11-13: clock correction. The 11-12 wiring line fed onFrame's
rAF `now` (ms since page load) to `freeze.tick`, but `TdClient` stamps
`commandStats().lastAt` with `Date.now` (epoch ms). With the lease started on
either clock and checked on the other, `left()` clamps elapsed at 0 (never
expires) and the newest-heard time sits in the future (silence never fires).
Fix: the wiring uses `Date.now()` for both `freeze.freeze` and `freeze.tick`
(header in `src/app/loop.ts` updated), and `freezeLease.check` gained a seat
belt — a `now` more than the silence window behind the lease start thaws with
`silence`, and a `lastFrameAt` ahead of `now` is ignored. Four new node tests;
three of them fail with the guard removed. Still refused._

_Progress 2026-11-14: wiring packaged. The 11-12 / 11-13 recipe (hold +
binding + "use `Date.now()` in two places") is now one object,
`createFreezeWiring({now, lastFrameAt, onThaw})` in
`morphogen-v2/src/app/freezeWiring.ts`. None of its methods take a time:
`freeze(ms)`, `frame(steps)` (tick, then gate — the frame that crosses expiry
already runs its steps), `status(s)`, `local()`, `thaw()`, `describe()` (rule 7
line while held) and `snapshot()` (`?debug=1`, plus `held`) all read the one
injected clock, which `main.ts` must set to TdClient's (`Date.now`). A throwing
or non-finite `lastFrameAt` getter counts as "no frame", so it can only end a
hold, never wedge one. The header says to call `frame` before onFrame's
`document.hidden` early return, so browsers that still give hidden tabs
throttled frames keep ticking. Ten node tests in `tests/freezeWiring.test.mjs`
(real loop, fake rAF on a page-load clock, wall clock on epoch ms), including
a browser-side step-order guard: `main.ts` must not import the wiring while
`parseTdCommand` refuses `freeze` — delete it in the lifting change. Stale
`halt` / `resume` doc comments in `freezeControl.ts` (still said
`loop.stop()` / `loop.start()`) corrected. Still refused; lifting it is now
parser cases + `main.ts` calling this object + `send_freeze` / `send_thaw` +
fixture move + `TD-COMMANDS.md`._

_Progress 2026-11-15: step 5's operator docs written ahead of the code.
`TD-COMMANDS.md` has a new "Staged: `freeze` / `thaw` (refused today)" section —
the two frames (exact fixture-built TD bytes), what a lease does, every exit
path, the rule-7 status texts, a staged limits table (`MIN_FREEZE_MS` 250,
`MAX_FREEZE_MS` 10 000, `FREEZE_SILENCE_MS` 3 000) kept out of the live Limits
table, and planned "screen stopped" troubleshooting rows. Four new cases in
`tests/tdCommandsDoc.test.mjs` pin it: the limits equal `freezeLease.ts` and
the fixture range; every frame shown is a `freeze_staged.built` row; every one
is still refused by `parseTdCommand` and none sits under "Accepted" (the
doc's half of the step-order guard — delete it in the lifting change); the
status texts are what `describeFreeze` / `describeThaw` print. Step 2 below
corrected: it still said `main.ts` wires the lease to `loop.stop()` /
`loop.start()` (superseded on 11-12). Still refused; lifting it no longer
includes writing `TD-COMMANDS.md`, only moving the staged section._

_Progress 2026-11-17: rule 5 mapped onto the real inputs. "Local input wins"
named five inputs, but `main.ts` has seventeen input sites, and two of the
obvious places to put `freeze.local()` are wrong: the canvas `onPress` only
calls `start()` when the loop is *not* running (a held loop is running, so that
branch never fires while frozen), and the preset cycler's `apply` is shared
with TD's own `preset` command (a TD preset would end TD's freeze and be
labelled "thawed (local)"). The new "Rule 5 input map" section below decides
every site; `tests/freezeInputs.test.mjs` fails if `main.ts` gains, loses or
renames an input site without a row here, pins the yes / no column, and checks
the two facts the map relies on (`sliders.sync()` never calls `apply`;
`td.onCommand` never reaches `stepPreset`). Still refused; the lifting change
now has an exact list of where `local()` goes._

_Progress 2026-11-18: status-line precedence decided and staged (closes the
11-17 open question below). New `morphogen-v2/src/app/freezeStatus.ts`
(`createFreezeStatus({now})`, injected clock, no `Date.now` inside): while
held the line is **pinned** to `FROZEN by TD · <s>s`, a live countdown in
tenths rounded up and clamped at `0.0s` (an unusable clock prints just
`FROZEN by TD`); a TD `preset` during the hold **appends**
(`FROZEN by TD · 3.2s · preset: Coral`); every other status text (TD
`setParams`, mute, lock loop) is remembered as the normal line and shown after
the hold. On thaw the reason shows for `THAW_STATUS_HOLD_MS` (1500 ms), then
the newest normal line returns. `THAW_TEXT` maps every `ThawReason` and is
declared `satisfies Record<ThawReason, string>`, so a new reason fails
`tsc --noEmit` until it has a phrase. `createFreezeWiring` gained
`remaining()` (lease ms on its own clock while held) to feed the countdown.
Nine node tests in `tests/freezeStatus.test.mjs` (formatting / clamp, preset
append, every reason + hold expiry, bad clocks, re-freeze during a hold,
exhaustiveness against `freezeLease.ts`, and a step-order guard: `main.ts`
must not import it while `freeze` is refused — delete it in the lifting
change), one for `remaining()` in `tests/freezeWiring.test.mjs`;
`TD-COMMANDS.md`'s staged section and `tests/tdCommandsDoc.test.mjs` now use
the new texts. Still refused; lifting it now also means routing `setStatus`
through this object (wiring recipe in the `freezeStatus.ts` header)._

_Progress 2026-11-19: step 2's "`parseTdCommand` cases" staged as their own
parser. New `morphogen-v2/src/sync/freezeFrame.ts` (`parseFreezeFrame(raw)`)
is the shape check the lifting change will move into `parseTdCommand`: the
same envelope pre-checks (string, `MAX_COMMAND_BYTES`, JSON object, `v` 1),
then exactly `{v, cmd:"freeze", ms}` with `ms` judged by the lease's own
`isValidFreezeMs` (so parser and lease share one range and one predicate), or
exactly `{v, cmd:"thaw"}`. Out-of-range / non-integer / missing `ms` and any
extra key refuse the whole frame (rules 1, 8); every other command returns
null, so it is not a second general parser. Eight node tests in
`tests/freezeFrame.test.mjs` read the shared fixture: every
`freeze_staged.built` row parses to the command its `build` row implies, every
`freeze_staged.browser_refuses` row and `lease_rejects_ms` value is refused,
hand-typed junk (`NaN`, `1e400`, `-0`, arrays) too, the size cap is exact,
every top-level fixture frame is null, a sweep across both range edges shows
the parser accepts exactly what `createFreezeLease().start` accepts, and a
step-order guard: `main.ts`, `tdCommand.ts` and `tdClient.ts` must not import
it while `parseTdCommand` refuses `freeze` — delete it in the lifting change.
Still refused; lifting no longer writes new untrusted-input parsing, it moves
two tested branches (inline them — `freezeFrame.ts` imports from
`tdCommand.ts`, so the reverse import would be a cycle)._

## Why `freeze` is different from `preset` and `setParams`

`preset` and `setParams` are **idempotent and self-healing**: if TD vanishes
mid-show, the Field keeps animating with the last numbers it was given, and the
performer can still move the sliders or step presets locally. Nothing is stuck.

`freeze` is the first command whose effect is **a missing thing** (no kernel
steps). If TD sends `freeze` and then the link dies, the browser shows a still
image indefinitely, and from the audience's side that is indistinguishable from
a crashed tab. So the review is mostly about the exits, not the entry.

## What the code already gives us (checked on `main` this run)

| Fact | Where | Why it matters for `freeze` |
| --- | --- | --- |
| A dropped authed socket goes `open` → `reconnecting` in `ws.onclose`, then retries with capped backoff (`RECONNECT_BASE_MS` 500, `RECONNECT_MAX_MS` 15 000, `RECONNECT_MAX_ATTEMPTS` 8). | `src/sync/tdClient.ts` | There is a single, reliable place to notice "TD is gone": the status leaving `open`. Reconnect can take tens of seconds, or give up entirely. |
| Every fresh ack resets the command gate, the tally and `tdRtt()`. | `tdClient.ts` (`onmessage` ack branch) | A freeze must not survive a reconnect either — a new session starts clean, same as the tally. |
| TD sends a `status` frame ≤ 1/s, only while a browser is authed (`StatusHeartbeat`, `status_tick`). | `td/morphogen_sync_callbacks.py` | The browser already receives a steady pulse from a healthy TD. A freeze can be tied to it without a new TD timer. |
| The sim loop is a single rAF chain with idempotent `start` / `stop`, and a restart resets the clock so stopped time is never replayed. | `src/app/loop.ts` | Un-freezing cannot cause a catch-up burst; resuming is cheap and safe. |
| Local input already calls `loop.start()` when the loop isn't running (canvas press, ENTER). | `src/main.ts` | A performer touch is a natural manual override. |

## Rules (proposed — the frame stays refused until these are implemented and tested)

1. **Freeze is a lease, never a latch.** Frame shape:
   `{v:1, cmd:"freeze", ms:<int>}` with `ms` in **[250, 10 000]**
   (proposed `MAX_FREEZE_MS` = 10 000). The browser pauses kernel steps (render
   keeps drawing the last field, Hum keeps its current tone) and **thaws on its
   own when the lease runs out**. TD that wants a longer hold re-sends `freeze`
   before expiry; each frame spends a gate token, so at ≤ 10/s and burst 5 this
   is cheap. Out-of-range, missing, non-integer or non-finite `ms` is
   **refused, not clamped** — the same reasoning as `setParams`: TD must never
   believe it holds a 60 s freeze the browser is running as 10 s.
2. **`thaw` is explicit.** `{v:1, cmd:"thaw"}` ends the lease at once. It is
   accepted even when no freeze is active (a no-op, still counts as `applied`)
   so TD can send it defensively on cue-stack resets.
3. **Leaving `open` thaws immediately.** Any `TdClient` status change away from
   `open` (socket close, ack timeout on a retry, `fail()`, `disconnect()`)
   cancels the lease **before** the reconnect is scheduled. A frozen screen
   must never outlive the session that froze it. This is the direct answer to
   "who un-freezes if TD drops?": the browser does, at the same moment it
   notices the drop, without waiting for backoff.
4. **A fresh ack never inherits a freeze.** Same rule as the gate and tally:
   a new session starts running.
5. **Local input wins.** A canvas press, ENTER, Reset, a preset step or a
   slider move thaws and cancels the lease. The performer in the room always
   outranks the remote peer. The status line says `thawed (local)` so the
   operator at TD can see why their hold ended.
6. **Silence thaws too (belt and braces).** If the session is still `open` but
   no TD frame of any kind arrived for `2 × status interval + 1 s` (≈ 3 s with
   the current 1 Hz heartbeat), thaw. This covers a TD that is wedged but has
   not closed its socket. It reuses `commandStats().lastAt`, which `TdClient`
   already updates on every authed frame.
7. **Visible state.** While frozen, the status line is pinned to
   `FROZEN by TD · <s>s` (live, one decimal; a TD preset appends
   `· preset: <name>`), and after a thaw it names the reason for 1.5 s
   (`thawed — you took over` / `time's up` / `TD went quiet` /
   `TD released` / `TD disconnected`) — see "Status-line precedence" below.
   _Amended 2026-11-18; the 11-07 text was `frozen by TD · N s left`._ The
   `#syncCmds` tally counts the frame as `applied`. `?debug=1` snapshot gains
   `freeze: {until, reason}`.
8. **No new trust.** Same parser, same size cap, same gate, authed sessions
   only, extra keys refused whole.

## Rule 5 input map (staged 2026-11-17)

Every input site in `morphogen-v2/src/main.ts`, keyed as
`<mount call>.<handler>` or `<target>:<event>`, and whether it calls
`freeze.local()` once the refusal is lifted. `tests/freezeInputs.test.mjs`
keeps this table and `main.ts` in step: a new site without a row (or a row
whose site is gone) fails, so the next input added to the page has to answer
"does this end a TD freeze?" on the way in.

| Site | Thaws? | Where `local()` goes / why |
| --- | --- | --- |
| `mountPointerSeeding.onPress` | yes | First line of `onPress`, **unconditionally** — today it only calls `start()` when `!loop.isRunning()`, and a held loop is still running (11-12), so hanging the thaw off that branch would never fire. |
| `mountPointerSeeding.onSeed` | no | The press that began the stroke already thawed. |
| `enter:click` | yes | In `start()`. A lease accepted before ENTER (session open, loop not yet started) is ended by ENTER, not inherited by the first frames. |
| `mountPanelStubs.onPanel` | field only | The `field` branch thaws via `stepPreset`; `sync` and the stub panels only print help text. |
| `mountPanelStubs.onReset` | yes | After the confirm is accepted; a cancelled confirm changes nothing, lease included. |
| `mountPanelStubs.onLockLoop` | no | HUD loop counter; the field is untouched. |
| `mountPanelStubs.onMuteToggle` | no | Sound only, and Hum holds during a freeze (open question 2). |
| `mountKeyboardShortcuts.onMuteToggle` | no | Same as the button. |
| `mountKeyboardShortcuts.onLockLoop` | no | Same as the button. |
| `mountKeyboardShortcuts.onPresetNext` | yes | Via `stepPreset`, which only local inputs call. |
| `mountKeyboardShortcuts.onPresetPrev` | yes | Via `stepPreset`. |
| `mountFieldSliders.apply` | yes | Slider `input` events only — `sliders.sync()` (after any preset, TD's included) never calls `apply`, so TD can't thaw through it. |
| `createPresetCycler.apply` | no | **Not here:** TD's `preset` command reaches it through `field.set`; thawing here would end TD's own freeze as "thawed (local)". |
| `createFrameLoop.onFrame` | n/a | Calls `freeze.frame(steps)` before the `document.hidden` return (freezeWiring.ts header). |
| `td.onCommand` | no | Remote. `freeze` / `thaw` route to `freeze.freeze(ms)` / `freeze.thaw()`; a TD `preset` / `setParams` during a hold changes the params and the steps stay held. |
| `document:visibilitychange` | no | Hidden tabs are the accepted gap (11-12 note), not a performer action. |
| `window:beforeunload` | n/a | Teardown. |

## Status-line precedence (staged 2026-11-18)

Built in `morphogen-v2/src/app/freezeStatus.ts`, tested in
`morphogen-v2/tests/freezeStatus.test.mjs`, **not imported by `main.ts`**
(guard test) — so runtime behaviour is unchanged until the refusal is lifted.

| State | Status line | Notes |
| --- | --- | --- |
| Frozen | `FROZEN by TD · 3.2s` | Live: re-rendered every frame from `freeze.remaining()`. Tenths, rounded **up** (any time left never reads `0.0s`), clamped at `0.0s`, never negative. Unusable clock → `FROZEN by TD`. |
| Frozen + TD `preset` | `FROZEN by TD · 3.2s · preset: Coral` | Appends, never replaces. Renewals keep it, a newer TD preset replaces it, a thaw drops it. |
| Frozen + any other `setStatus` | (unchanged freeze line) | TD `setParams`, mute, lock loop: remembered as the normal line, shown after the thaw hold. Their own UI (sliders, mute button, HUD counter) already shows the change. |
| Thawed, `local` | `thawed — you took over` | Performer input (rule 5). |
| Thawed, `expired` | `thawed — time's up` | Lease ran out (rule 1). |
| Thawed, `silence` | `thawed — TD went quiet` | No TD frame for `FREEZE_SILENCE_MS`, or the 11-13 clock guard (rule 6). |
| Thawed, `thaw` | `thawed — TD released` | TD's explicit `thaw` (rule 2). |
| Thawed, `disconnect` | `thawed — TD disconnected` | Session left `open`, or a fresh ack found a lease (rules 3, 4). |
| After `THAW_STATUS_HOLD_MS` (1500 ms) | newest normal line | A normal update during the hold is kept and shown when the hold ends, so the reason is always readable. |

Staged limits and safety: the reason map is `satisfies Record<ThawReason,
string>` (a new `ThawReason` fails `tsc --noEmit`; the test also compares the
keys with the union in `freezeLease.ts`). The clock is injected; a
non-finite, throwing or backwards clock ends a thaw hold instead of extending
it, so a clock fault can only hide a reason early, never pin one. A new freeze
during a hold replaces the reason with the countdown. Lifting the refusal
means: `setStatus` → `freezeStatus.normal(s)` + paint; `onThaw` →
`freezeStatus.thawed(r)`; each frame `freezeStatus.frozen(freeze.remaining())`
while held, then paint; the TD `preset` branch calls `freezeStatus.preset(name)`
while held; delete the guard test.

## Exit paths, in one picture

```mermaid
stateDiagram-v2
  [*] --> Running
  Running --> Frozen: freeze{ms} (authed, in range)
  Frozen --> Frozen: freeze{ms} again (lease renewed)
  Frozen --> Running: lease expires
  Frozen --> Running: thaw
  Frozen --> Running: TdClient leaves "open"
  Frozen --> Running: local input
  Frozen --> Running: no TD frame for ~3 s
```

Every arrow out of `Frozen` is driven by the browser. None of them needs TD to
be alive.

## Order of work when this is picked up

Following the 2026-10-23 contract rule (fixture first, then both twins):

1. `tests/fixtures/td-commands.v1.json`: add `freeze_ms_range`, built
   `freeze` / `thaw` frames, builder rejects, and browser refusals (bare
   `freeze`, `ms` 0 / 249 / 10 001 / 1.5 / `"500"` / `null`, extra key).
   Remove the plain "freeze is refused" row only in the same change.
2. Browser: `parseTdCommand` cases; a small pure `createFreezeLease(now)`
   helper (start / renew / thaw / `remaining(now)`, NaN- and backwards-clock
   safe, like `createCommandGate`), unit-tested on its own; `main.ts` wires it
   to the `TdClient` status / command callbacks and gates kernel steps through
   `createFreezeWiring` (`src/app/freezeWiring.ts`). _Corrected 2026-11-15:
   this step originally said `loop.stop()` / `loop.start()`, which can't work —
   a stopped loop never ticks the lease (see the 11-12 note)._
   _Staged 2026-11-19: the parser cases are `parseFreezeFrame` in
   `src/sync/freezeFrame.ts`, fixture-tested; lifting = move its two branches
   into `parseTdCommand`._
3. TD: `MAX_FREEZE_MS` / `MIN_FREEZE_MS`, `make_freeze_command(ms)`,
   `make_thaw_command()`, `send_freeze(dat, ms)` / `send_thaw(dat)`, new
   `freeze` row in `morphogen_cmds`.
4. Tests that must exist before the refusal is lifted: lease expiry; renewal;
   socket close while frozen thaws before reconnect; fresh ack starts running;
   local press thaws; silence timeout; out-of-range refused not clamped;
   `tdCommandsDoc` drift rows for the new limits.
5. Docs: `TD-COMMANDS.md` frame section, Limits rows and troubleshooting
   ("screen stopped" → check `#syncCmds` and the lease line); this page's
   status line flips to "implemented". _Staged 2026-11-15: all of it is
   written in `TD-COMMANDS.md`'s "Staged" section; lifting = move it into
   "Accepted" / Limits / the troubleshooting table and delete the doc guard._

## Open questions (for whoever picks this up)

- ~~Should a frozen field keep **rendering**?~~ **Answered 2026-11-12: yes.**
  It has to, not just may: the frame loop is what calls `tick`, so freeze gates
  kernel steps (`createStepHold`) instead of stopping the loop. The cost is the
  canvas blit, not the kernel.
- ~~Does Hum hold its tone or fade during a freeze?~~ **Answered 2026-11-12:
  holds.** `hum.modulate` keeps receiving the unchanged field energy, so the
  partials stay where they were. A fade is an artistic choice TD can make with
  a later command.
- Is 10 s the right ceiling? It is long enough for a dramatic hold and short
  enough that a lost renew is noticed within one musical phrase. Revisit after
  a live rehearsal.
- ~~Which status text wins while frozen?~~ _Raised 2026-11-17._ **Answered
  2026-11-18: the freeze line wins, and is pinned.** A TD `preset` /
  `setParams`, or a mute / lock-loop press (none of which thaw, per the rule 5
  input map), still calls `setStatus`. Decision and staged code: see
  "Status-line precedence (staged 2026-11-18)" above.
