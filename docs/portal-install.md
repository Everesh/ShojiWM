# Installing xdg-desktop-portal-shojiwm

Bare-bones install guide for the in-tree portal backend. Phase 2 builds a
ScreenCast skeleton that responds to D-Bus calls; no PipeWire stream yet.

## What it does today

- Registers `org.freedesktop.impl.portal.desktop.shojiwm` on the session bus
- Serves `org.freedesktop.impl.portal.ScreenCast` at
  `/org/freedesktop/portal/desktop`
- `CreateSession` / `SelectSources` log the call and succeed
- `Start` returns an empty `streams` array — OBS will see the dialog complete
  but receive no video. Use this stage to verify the D-Bus plumbing only.

PipeWire stream creation and the picker UI come in later phases.

## Quick install (recommended)

`dist/install-portal.sh` does everything below in one go — release build,
copying the four files, writing the user portals.conf, and reloading systemd.

```sh
./dist/install-portal.sh             # build + install
./dist/install-portal.sh --no-build  # re-install existing target/release binary
```

Removal:

```sh
./dist/uninstall-portal.sh
```

The rest of this document spells out what the script does, for when you want
to do it by hand or package it for distribution.

## Build

```sh
cargo build --release -p xdg-desktop-portal-shojiwm
```

Output: `target/release/xdg-desktop-portal-shojiwm`.

## Files to install

| Source (in repo)                                                | Destination                                                            |
|-----------------------------------------------------------------|------------------------------------------------------------------------|
| `target/release/xdg-desktop-portal-shojiwm`                     | `/usr/bin/xdg-desktop-portal-shojiwm`                                  |
| `dist/shojiwm.portal`                                           | `/usr/share/xdg-desktop-portal/portals/shojiwm.portal`                 |
| `dist/org.freedesktop.impl.portal.desktop.shojiwm.service`      | `/usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.shojiwm.service` |
| `dist/xdg-desktop-portal-shojiwm.service`                       | `/usr/lib/systemd/user/xdg-desktop-portal-shojiwm.service`             |

Once installed, `xdg-desktop-portal` will D-Bus activate the binary on demand.

## Selecting the backend

`xdg-desktop-portal` chooses a backend per interface via `UseIn=` in
`.portal` files and `portals.conf` overrides.

The `.portal` file ships with `UseIn=ShojiWM`, which matches when
`XDG_CURRENT_DESKTOP=ShojiWM` (or contains `ShojiWM` as a component, e.g.
`ShojiWM:sway`).

To pin ScreenCast to shojiwm regardless of what else is installed, drop a file
at `~/.config/xdg-desktop-portal/shojiwm-portals.conf` (filename must be
lowercase — xdg-desktop-portal 1.20+ case-folds when matching):

```ini
[preferred]
default=shojiwm
org.freedesktop.impl.portal.ScreenCast=shojiwm
```

## Verifying

After installation, with ShojiWM running:

```sh
# Should show our binary getting activated and claiming the name
busctl --user introspect org.freedesktop.impl.portal.desktop.shojiwm \
    /org/freedesktop/portal/desktop

# Should list shojiwm and any other installed backends
ls /usr/share/xdg-desktop-portal/portals/

# Watch portal logs for backend selection
journalctl --user -fu xdg-desktop-portal -u xdg-desktop-portal-shojiwm
```

When OBS / Vesktop opens its screen-share dialog, the portal-shojiwm logs
should show `CreateSession` / `SelectSources` / `Start` getting called.

## Uninstall

Remove the four files installed above, then:

```sh
systemctl --user stop xdg-desktop-portal-shojiwm.service 2>/dev/null
systemctl --user daemon-reload
systemctl --user restart xdg-desktop-portal
```
