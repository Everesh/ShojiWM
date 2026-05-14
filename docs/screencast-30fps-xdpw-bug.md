# Screencast capped at ~30 fps via xdg-desktop-portal-wlr

When recording the screen through OBS (or any other PipeWire-based screencast
consumer that uses `org.freedesktop.portal.ScreenCast`), the captured stream
may be capped at ~19-30 fps even though the target is 60 fps and ShojiWM
itself is rendering at the output's full refresh rate.

**This is an upstream bug in `xdg-desktop-portal-wlr` (xdpw).**
ShojiWM's `wlr-screencopy-unstable-v1` implementation is not at fault — direct
wlr-screencopy consumers (e.g. `wf-recorder`) record at full output rate
without any workaround.

## Symptoms

- OBS / Discord screen share / Vesktop reports ~19-30 fps even though the
  source is set to 60 fps.
- `pw-top` shows the `xdg-desktop-portal-wlr` PipeWire stream sharing the
  `QUANT` of an audio device (typically `1024/48000` ≈ 21.3 ms).
- `wf-recorder -F fps=60 -o <output> ...` records at 60 fps with no issues
  (this rules out ShojiWM's compositor side).
- Hyprland sessions are unaffected because Hyprland ships
  `xdg-desktop-portal-hyprland` (xdph), which never picked up the regression
  described below.

## Root cause

In [xdpw commit `ca7a3e2e`][regression-commit] (June 2022), the screencast
PipeWire stream lost its `PW_STREAM_FLAG_DRIVER` flag:

```diff
- (PW_STREAM_FLAG_DRIVER | PW_STREAM_FLAG_ALLOC_BUFFERS),
+ PW_STREAM_FLAG_ALLOC_BUFFERS,
```

Without that flag the screencast node is no longer a graph driver. It is
scheduled by whichever audio sink ends up driving the PipeWire graph,
typically at the default audio quantum of `1024/48000` ≈ 21.3 ms.

xdpw's per-frame loop only requests the next screencopy frame from the
compositor *inside* its `pwr_handle_stream_on_process` callback. With the
callback firing at 21.3 ms intervals, plus the wlr-screencopy round-trip and
the compositor's own vblank gating, the steady-state cycle settles at
~33-50 ms per frame:

```
audio tick:         |---21.3ms---|---21.3ms---|---21.3ms---|
xdpw on_process:    *            *            *            *
                    └─ request next capture only here
ShojiWM render:        ▲            ▲            ▲      (1 vblank wait)
client sees:           f1           f2           f3     ≈ 30 fps
```

xdph keeps the `PW_STREAM_FLAG_DRIVER` flag and therefore owns its own graph
node with its own tick rate — completely decoupled from audio. That is why
the same xdph + PipeWire + OBS chain runs at 60 fps under Hyprland on the
same hardware.

[regression-commit]: https://github.com/emersion/xdg-desktop-portal-wlr/commit/ca7a3e2eaff4a5458dd58c53ac1a0c57c7758e32

## Upstream status

- Tracking issue: [emersion/xdg-desktop-portal-wlr#351][issue-351]
  ("Screencast portal lags around 30fps with new version")
- Proposed fix: [PR #370][pr-370] (open, not merged as of writing) restores
  `PW_STREAM_FLAG_DRIVER` and adds an explicit `pw_stream_trigger_process`.
- The maintainer (@emersion) prefers a "lazy scheduling" / PipeWire-timer
  approach over the straight DRIVER restoration; PR #370 has known regressions
  for offscreen toplevel captures and browser screen-sharing edge cases,
  hence the review hold.

Until upstream merges a fix, end users have two workable options.

[issue-351]: https://github.com/emersion/xdg-desktop-portal-wlr/issues/351
[pr-370]: https://github.com/emersion/xdg-desktop-portal-wlr/pull/370

## Workarounds

### Option 0 — Use `xdg-desktop-portal-shojiwm` (recommended on ShojiWM)

ShojiWM ships its own portal backend
(`src/xdg-desktop-portal-shojiwm/`) which sidesteps the bug entirely:

- The PipeWire stream is connected with
  `PW_STREAM_FLAG_DRIVER | PW_STREAM_FLAG_ALLOC_BUFFERS`.
- The wlr-screencopy client and the PipeWire stream live on a **single thread**
  (the wayland fd is attached to the PipeWire main loop via `add_io`).
- Each wlr-screencopy `ready` event directly calls `pw_stream_queue_buffer`,
  which both delivers the frame to consumers and drives the PipeWire cycle.
  Cycle pacing therefore tracks the compositor's vblank rate, not the audio
  sink's quantum.

Verified result on this machine: OBS observed at **~65fps** on a 66 Hz output
with `clock.force-quantum=0` (PipeWire default), versus **46.875 fps** on
xdpw under the same conditions.

The remaining options below are kept as fallbacks for users running xdpw.

### Option A — Force a smaller PipeWire graph quantum

Force the entire PipeWire graph to tick at a shorter interval, so that even
when the video stream is scheduled by the audio driver it is no longer
bottlenecked at 21.3 ms.

Run once per session (or hook it into a startup task):

```sh
pw-metadata -n settings 0 clock.force-quantum 256
```

`256 / 48000 ≈ 5.3 ms`, which is short enough to let the video cycle complete
within one display vblank (16.67 ms @ 60 Hz). The audio cost is negligible on
any modern desktop CPU.

**ShojiWM ships this workaround behind an explicit knob in the user config.**
See `packages/config/src/index.tsx` — search for `pw-metadata` — for the
`process.once("pipewire-video-quantum", …)` registration. The line is
commented out by default; uncomment it if you screencast through OBS / portal
based tools.

### Option B — Use a patched xdpw from PR #370

For users who want the proper fix at the source, install the fork from
[PR #370][pr-370] (AUR `xdg-desktop-portal-wlr-git` pointing at funk443's
branch). Comes with the known side-effects above.

### Option C — Bypass xdpw entirely

For recording-only use cases, `wf-recorder` (and similar tools that use
`wlr-screencopy-unstable-v1` directly, without PipeWire portal) hits the
full output refresh rate with no special configuration:

```sh
wf-recorder -F fps=60 -o eDP-1 -f recording.mp4
```

OBS-side workflows that *must* use the portal source cannot use this path.

## Why this is not a ShojiWM bug

We verified each layer of the stack independently:

| Test | Result | Conclusion |
|---|---|---|
| ShojiWM's `render_surface` call rate | ~180/s on a 66 Hz output | Compositor render loop is healthy. |
| Render-side `dmabuf bind+render` of a screencopy frame | ≈ 0.3 ms | Compositor's screencopy hot path is not the bottleneck. |
| `wf-recorder` direct wlr-screencopy capture | 60 fps stable | wlr-screencopy implementation is correct. |
| `submit → next copy_with_damage` round-trip via xdpw | 30-47 ms (alternating) | Stall is on the xdpw / PipeWire side. |
| Setting `clock.force-quantum=256` in PipeWire | OBS jumps to 60 fps | Confirms audio-quantum coupling is the bottleneck. |
| Restricting `linux-dmabuf` feedback to LINEAR only | No change | Rules out compressed-modifier slow path. |
| Setting `xdpw` `max_fps=240` | No change | Rules out xdpw's own rate limiter. |
| Running our `xdg-desktop-portal-shojiwm` with DRIVER + ALLOC_BUFFERS + wayland-driven queue | OBS at ~65fps on a 66 Hz output | Confirms the architectural fix and matches what xdph upstream PR #370 attempts. |

The combination — wf-recorder fine, modifier-agnostic, audio-quantum-sensitive,
xdph-fork-fixes-it, our DRIVER-flag rewrite reproduces the fix — uniquely
points at the missing `PW_STREAM_FLAG_DRIVER` in xdpw post `ca7a3e2e`.
