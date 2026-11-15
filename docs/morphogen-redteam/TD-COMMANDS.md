# Morphogen v2 — TD → app command channel (v1)

_Architecture + operator note, added 2026-10-27. One page that ties together the
pieces landed 2026-10-21 → 2026-10-26 (parser, TD helper, contract fixture, both
tallies, Sync panel chip). The code comments stay the source of truth; this page
is the map. `tests/tdCommandsDoc.test.mjs` fails if the numbers below drift from
`src/sync/tdCommand.ts` or the contract fixture._

## Who owns what

| Side | File | Role |
| --- | --- | --- |
| Browser | `morphogen-v2/src/sync/tdCommand.ts` | The only parser for inbound TD frames (`parseTdCommand`), the rate gate (`createCommandGate`), the pong shape (`pongFor`), the tally line (`describeCommandStats`) and the TD RTT line (`describeTdRtt`). Pure, no DOM. |
| Browser | `morphogen-v2/src/sync/tdClient.ts` | `handleCommand` routes each authed frame through parse → gate → ping/apply and counts it in `commandStats()`; keeps the latest TD `status` RTT in `tdRtt()` (cleared on every fresh ack). |
| Browser | `morphogen-v2/src/ui/panels.ts` | `mountSyncCommandLine` shows the tally as the `#syncCmds` chip while the session is authed; `mountSyncRttLine` shows TD's latest RTT as the `#syncRtt` chip once a `status` frame arrived this session (amber when `lost` > 0). |
| TD | `morphogen-v2/td/morphogen_sync_commands.py` | Frame builders (`make_preset_command`, `make_ping_command`, `make_setparams_command`, `make_status_command` / `RttTracker.status_frame()`), `CommandPacer` (same bucket as the browser), `RttTracker` (RTT samples, 5 s lost-ping expiry, `describe_rtt`), `StatusHeartbeat` (when the next periodic status frame is due), `SendStats` / `describe_send_stats`. |
| TD | `morphogen-v2/td/morphogen_sync_callbacks.py` | `send_preset(dat, id)` / `send_params(dat, feed=, kill=)` / `send_ping(dat)` / `send_status(dat)` broadcast to **authed clients only**; `status_tick(dat)` is the every-frame-safe way to keep status flowing (≤ 1 per second, only while authed, immediate after a fresh ack, idle ticks untallied); pongs and lost / outstanding pings go to `morphogen_rtt` (`rtt_line()` prints one line), send tallies to `morphogen_cmds`, `send_stats_line()` prints one line. |
| Both | `morphogen-v2/tests/fixtures/td-commands.v1.json` | Golden contract: exact frame bytes, refusals, pong shape, gate verdicts and the shared RTT line (`rtt_lines`). Read by the node suite and by pytest. |

## Lifecycle

```mermaid
sequenceDiagram
  participant B as Browser (TdClient)
  participant T as TouchDesigner (callbacks)
  B->>T: hello {auth}
  T-->>B: {ack, ok:true}
  Note over B: tally reset, gate refilled to burst
  T->>B: {v:1, cmd:"preset", id:"coral"}
  Note over B: parse, gate, then createPresetCycler().set
  T->>B: {v:1, cmd:"ping", t:1000}
  B-->>T: {v:1, pong:"morphogen", t:1000}
  Note over T: RttTracker updates morphogen_rtt
  T->>B: {v:1, cmd:"status", rtt:{last_ms, median_ms, samples, outstanding, lost}}
  Note over B: tdRtt() keeps the latest, describeTdRtt prints it
  T->>B: {v:1, cmd:"setParams", feed:0.056, kill:0.062}
  Note over B: range-checked, partial sim.setParams, sliders snap to it
```

Nothing is parsed as a command before the ack. A fresh ack (reconnect, new
session) resets the browser tally and refills the gate; TD resets `SendStats`
and its pacer when a new client authenticates.

## Frames

Accepted (v1):

- `{"v":1,"cmd":"preset","id":"coral"}` switches the Field preset. Ids are
  trimmed and lower-cased; an unknown but well-formed id parses fine and is a
  no-op in `createPresetCycler().set`.
- `{"v":1,"cmd":"ping","t":1000}` is answered by TdClient itself with
  `{"v":1,"pong":"morphogen","t":1000}`. A missing or non-finite `t` echoes as `null`.
- `{"v":1,"cmd":"status","rtt":{"last_ms":8.0,"median_ms":9.5,"samples":3,"outstanding":0,"lost":1}}`
  (added 2026-10-29) carries TD's own round-trip figures, the same fields as
  the `morphogen_rtt` table, so the browser can see lost pings that only TD
  can detect. Every field is required; ms values are `null` (no pong yet) or
  0 to `MAX_STATUS_MS`, counts are integers 0 to `MAX_STATUS_COUNT`, and one bad
  field refuses the whole frame. The browser keeps the latest one per session
  (`tdRtt()`, and `tdRtt` in the `?debug=1` snapshot) and `describeTdRtt` prints
  the same line TD's `rtt_line()` does. It counts as `applied` and spends a gate
  token, so send it from a slow timer (about once a second). Adding it was not
  wire-breaking: an older browser simply counts it as `refused`.

- `{"v":1,"cmd":"setParams","feed":0.056,"kill":0.062}` (added 2026-11-05)
  moves the Field **feed** / **kill** sliders from TD. Send one knob or both
  (`send_params(dat, feed=0.056)` in TD). The browser applies it exactly like a
  slider move (a partial `sim.setParams`, so `sanitizeParams` still guards the
  kernel), snaps both sliders to the result and ends the status line in
  `· from TD`. Limits review, all enforced by `parseTdCommand` and mirrored by
  `make_setparams_command`:
  - only `feed` and `kill`; a frame with `du`, `dv`, `dt` or any other extra
    key is refused whole (diffusion rates set the stable time step, so a
    remote peer must not move them);
  - each value must already be inside `REMOTE_PARAM_RANGE` (the slider travel,
    inside the kernel's `PARAM_LIMITS`); out-of-range values are **refused,
    not clamped**, so TD never believes it set a number the browser isn't
    running, and the mistake shows up in the `refused` tally;
  - values are rounded to 4 decimals (the slider step); TD rounds first, so
    both sides agree on the exact number;
  - at least one knob; a bare `setParams` is refused;
  - it counts as `applied` and spends a gate token like `preset`, so drive it
    from a slowed CHOP (≤ 10/s), never every frame.

Refused (parse returns `null`, frame dropped, session untouched):
`freeze` and `thaw` (still reserved; its limits review — a browser-ended lease,
so a dropped TD can't leave the Field stuck — is in
[FREEZE-REVIEW.md](FREEZE-REVIEW.md); the frames are staged below), out-of-range or
extra-key `setParams` frames,
any `v` other than `1`, missing `cmd`, arrays, non-JSON, malformed preset ids,
and anything over the size cap.

## Staged: `freeze` / `thaw` (refused today)

_Added 2026-11-15 (FREEZE-REVIEW.md step 5, written ahead of the code). Every
frame in this section is **refused** by the current build and counts as
`refused` in the `#syncCmds` tally; nothing in TD sends them yet (there is no
`send_freeze` / `send_thaw`). The section exists so the operator-facing text is
reviewed, and drift-tested, before the refusal is lifted rather than written in
the same rush. `tests/tdCommandsDoc.test.mjs` checks that every frame below is
one of the fixture's `freeze_staged.built` rows **and** that `parseTdCommand`
still returns `null` for it, and that the staged limits match
`src/sync/freezeLease.ts`. Lifting the refusal = move this section into
"Frames → Accepted", move the staged limit rows into the Limits table, delete
the "staged frames stay refused" doc test, in the same change as the parser
cases and the `main.ts` call into `createFreezeWiring`
(`src/app/freezeWiring.ts`)._

Planned frames (exact TD bytes from `make_freeze_command` / `make_thaw_command`
in `td/morphogen_sync_commands.py`):

- `{"v":1,"cmd":"freeze","ms":1500}` — hold the Field (no kernel steps; the
  canvas keeps drawing the last field, Hum keeps its tone) for a **lease** of
  `ms` milliseconds on the browser's clock. The browser ends it by itself when
  the lease runs out; to hold longer, TD re-sends `freeze` before expiry (each
  valid frame renews from "now"). `ms` must be an integer inside the staged
  range below; anything else is **refused, not clamped**, like `setParams`.
- `{"v":1,"cmd":"thaw"}` — end any lease at once. Accepted even when nothing
  is frozen (a no-op that still counts as `applied`), so a cue-stack reset can
  send it defensively.

Every way out of a freeze is driven by the browser, so none of them needs TD
to be alive: lease expiry; `thaw`; the Sync session leaving `open` (socket
close, ack timeout, give-up, disconnect — before any reconnect is scheduled);
a fresh ack (a new session never inherits a freeze); performer input (canvas
press, ENTER, Reset, a preset step, a slider move — the performer outranks TD);
and silence (no TD frame of any kind for `FREEZE_SILENCE_MS` while still
`open`, which is why `status_tick(dat)` must keep running during a hold).

While held the status line will read `frozen by TD · N s left`
(`describeFreeze`); when a lease ends it reads `thawed (<reason>)`
(`describeThaw`: `expired`, `thaw`, `disconnect`, `local` or `silence`), and
`?debug=1` gains `freeze: {until, reason, held}`.

| Staged limit | Value | Constant (browser / TD) |
| --- | --- | --- |
| Shortest lease (inclusive) | 250 ms | `MIN_FREEZE_MS` |
| Longest lease (inclusive) | 10000 ms | `MAX_FREEZE_MS` |
| TD silence that ends a lease | 3000 ms | `FREEZE_SILENCE_MS` |

Planned troubleshooting rows (move them into the table under "Reading the two
tallies" when the refusal is lifted):

| What you see | Likely meaning | What to check |
| --- | --- | --- |
| The field stops moving and the status line says `frozen by TD · N s left` | TD holds a lease; it ends on its own within `MAX_FREEZE_MS`. | TD's cue stack; send `thaw`, or press the canvas. |
| The field stops moving and the status line does **not** say `frozen by TD` | Not a freeze: the tab is hidden, or the loop stopped. | `document.hidden`, the HUD, the browser console. |
| A long hold keeps ending early with `thawed (silence)` | TD stopped sending frames while the session stayed open. | That `status_tick(dat)` is still called every frame during the hold. |
| A hold ends early with `thawed (expired)` | TD's renew came later than `ms`, or was paced out. | Re-send `freeze` well before expiry, at ≤ 10/s. |
| `freeze` frames only grow the `refused` tally | `ms` outside the staged range or not an integer (refused, not clamped) — or a build from before the refusal was lifted, which refuses every `freeze`. | `make_freeze_command` raises on the same values; the fixture's `freeze_staged.browser_refuses`. |

## Limits

| Limit | Value | Constant (browser / TD) |
| --- | --- | --- |
| Max frame size | 512 B | `MAX_COMMAND_BYTES` |
| Max preset id length | 32 chars | `MAX_PRESET_ID_LEN` |
| Sustained command rate | 10 per second | `COMMAND_RATE_PER_S` |
| Burst | 5 frames | `COMMAND_BURST` |
| Max status RTT value | 3600000 ms | `MAX_STATUS_MS` |
| Max status counter | 1000000000 | `MAX_STATUS_COUNT` |
| Remote feed range (inclusive) | 0.01 to 0.09 | `REMOTE_PARAM_RANGE.feed` |
| Remote kill range (inclusive) | 0.045 to 0.07 | `REMOTE_PARAM_RANGE.kill` |

The gate is a token bucket. A backwards or non-finite clock refills nothing, so
a bad timestamp can only make it stricter. Refused frames are counted **before**
the gate and do not spend a token; pings **do** pass through the gate.

## Reading the two tallies side by side

The browser counts what it **received** (`TD cmds: …`, in the `#syncCmds` chip
and the `?debug=1` snapshot as `tdCommands`). TD counts what it **tried to send**
(`TD sent: …` from `send_stats_line()`, rows in `morphogen_cmds`). Within one
session, `applied + pings + refused + paced === frames` on the browser side.

| What you see | Likely meaning | What to check |
| --- | --- | --- |
| TD `presets` matches browser `applied` | Healthy. | Nothing. |
| TD `with no authed client` grows, browser chip hidden | No authed browser: TD dropped the send locally. | `Syncsecret` on the TD COMP, the browser's Sync URL, the Sync chip state. |
| TD `paced` grows | TD's own pacer held the frame back; it never hit the wire. | Slow the cue stack or spread cues out. |
| Browser `paced` grows (chip turns amber) | Frames reached the browser faster than 10/s burst 5, so TD's pacer was bypassed or the clocks disagree. | Something sending without `send_preset` / `send_ping`; a second TD sender. |
| Browser `refused` grows | TD sent frames this build doesn't accept (reserved command, newer `v`, bad id, a `setParams` value outside `REMOTE_PARAM_RANGE` or with `du` / `dv`). | TD script version vs. this contract; the fixture's `browser_refuses` list. |
| TD `setParams` count matches browser `applied` but the sliders don't move | Older `index.html` without `#feedSlider` / `#killSlider`: the kernel still changes, there is just nothing to snap. | The status line should still end in `· from TD`. |
| Browser `handler errors` > 0 | The preset handler threw; telemetry kept flowing. | Browser console, `main.ts` preset routing. |
| `morphogen_rtt` `lost` grows (or `rtt_line()` ends in `· N lost`) | Pings got no pong within 5 s (`RttTracker.timeout_ms`), or were pushed out by the 32-outstanding cap. Late pongs are ignored. | Network, the browser tab being backgrounded or frozen, reconnect count in the Sync chip. |
| `#syncRtt` chip never appears while `#syncCmds` is live | TD hasn't sent a `status` frame since this session's ack (the chip waits for one, so it never shows the previous session's figures). | Call `status_tick(dat)` every frame (e.g. an Execute DAT's `onFrameStart`) or `send_status(dat)` from a ~1 s timer; `TD sent:` should show `statuses`. |
| Browser `tdRtt` line (or the amber `#syncRtt` chip) ends in `· N lost` but TD's `rtt_line()` looks fine | The browser shows TD's figures as of the last `status` frame, so it lags by up to one status interval. | Whether `status_tick` / `send_status` is still being called; `TD sent:` should show a climbing `statuses` count. A paced-out status waits a full interval before the next try. |
| `outstanding` stays above 0 but `lost` stays 0 | Pings in flight younger than the timeout; expiry is checked on the next ping or pong, not on a timer. | Send another ping, or wait for the next cue. |

## Changing the contract

1. Edit the rule on **both** sides (`tdCommand.ts` and `morphogen_sync_commands.py`).
2. Update `tests/fixtures/td-commands.v1.json` (bump `version` and the file name
   for a wire-breaking change).
3. Update the Limits table above if a number moved.
4. Run `npm test` in `morphogen-v2/` and the TD pytest suite; both must pass.
