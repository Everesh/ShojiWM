# OBS/Qt Fractional-Scale Subsurface Input Offset

## Summary

OBS's preview area can receive hover and click input at a position offset from
the drawn preview when running under fractional scale. The compositor-side
surface hit-test and Wayland pointer coordinates have been verified to match the
drawn subsurface geometry, so this is currently treated as an OBS/Qt client-side
bug rather than a ShojiWM input-coordinate bug.

This issue should be revisited after the window manager policy can be written in
TypeScript. The preferred long-term workaround is to express the client-specific
policy in config, rather than baking an OBS-specific hack into the Rust
compositor core.

## Observed Behavior

- OBS preview input is offset until the OBS toplevel is resized.
- Resizing the window causes OBS/Qt to recompute its internal preview mapping,
  after which hover and click positions line up with the rendered preview.
- The issue does not reproduce when the output scale is `1.0`.
- The issue reproduces with fractional scale, for example `1.25`.
- The issue was also reproduced on `cosmic-comp` when using fractional scale and
  avoiding the initial resize path. Cosmic often hides the issue because it
  appears to trigger an early resize/configure sequence for OBS.

## Log Findings

In ShojiWM logs, pointer dispatch and OBS `WAYLAND_DEBUG` coordinates match.
For example, ShojiWM sent:

```text
sent_client_pos=(134.350896..., 261.308149...)
```

OBS received:

```text
wl_pointer.motion(..., 134.34765625, 261.30468750)
```

Another sample:

```text
sent_client_pos=(133.750930..., 260.008193...)
wl_pointer.motion(..., 133.75000000, 260.00781250)
```

ShojiWM's hit-test also matched the rendered subsurface:

```text
root surface: wl_surface#26
preview subsurface: wl_surface#33
subsurface offset: (161, 27)
hit focus surface: wl_surface#33
```

This indicates that ShojiWM sends the expected Wayland-local coordinates to the
preview subsurface.

## Scale Details

For fractional scale `1.25`, ShojiWM advertises:

```text
wl_output.scale(2)
wp_fractional_scale.preferred_scale(150)
```

`preferred_scale` uses 120 units per logical scale unit:

```text
120 => 1.0
150 => 1.25
192 => 1.6
240 => 2.0
```

The legacy `wl_output.scale` value is integer-only, so compositors commonly use
the ceiling of the fractional scale for compatibility. The presence of
`wl_output.scale(2)` does not mean the real scale is `2.0`; the fractional scale
protocol value is the precise scale.

## Current Hypothesis

OBS/Qt initializes the preview subsurface's internal input mapping incorrectly
under fractional scale. A toplevel resize forces Qt/OBS through a layout path
that refreshes the mapping and fixes the offset.

The compositor should not globally adjust subsurface input coordinates to work
around this. Doing so would break correct clients because ShojiWM already sends
the protocol coordinates that match the surface tree.

## Future Workaround Direction

Once window manager behavior can be controlled from TypeScript, add a
client-specific workaround in config. The workaround should be documented and
limited to OBS or affected Qt clients.

Example shape:

```ts
COMPOSITOR.event.onOpen((window) => {
  // Workaround for OBS/Qt Wayland fractional-scale subsurface input bug.
  // OBS may initialize preview subsurface input mapping incorrectly until the
  // toplevel goes through a resize configure.
  if (window.appId === "com.obsproject.Studio" && window.output.scale !== 1) {
    window.requestResizeJiggle({ dx: 1, dy: 0 });
  }
});
```

The Rust-side API needed for this should be general, not OBS-specific. Possible
API names:

- `window.requestResizeJiggle({ dx, dy })`
- `window.requestClientRelayout()`
- `window.configure({ size })`

If an immediate workaround is required before TypeScript window-manager policy
exists, keep it environment-gated and app-specific, with a comment explaining
that it is a temporary workaround for an OBS/Qt fractional-scale subsurface
initialization bug.
