---
sidebar_position: 1
---

# Installation

ShojiWM installs from source with a single script, `dist/install.sh`. It builds
everything, installs the compositor and its TypeScript runtime, drops in a
default user config, and registers a Wayland session so ShojiWM shows up in your
login manager.

:::info[Packaged installs are coming]
Distribution packages (AUR and similar) are planned for **just before the
official release**. Until then, install from source as described below.
:::

## Prerequisites

- A Linux system with a working Wayland / DRM setup
- A recent Rust toolchain (`cargo`)
- Node.js 18 or newer (with `npm`)
- The following native libraries (with their development headers), which ShojiWM
  links against:
  - `libwayland`
  - `libxkbcommon`
  - `libudev`
  - `libinput`
  - `libgbm`
  - `libseat`
  - `xwayland` — the Xwayland server itself (driven by `xwayland-satellite` below)
- [`xwayland-satellite`](https://github.com/Supreeeme/xwayland-satellite) — for
  running X11 / Xwayland applications (see the note below)
- `sudo` — the installer copies files into `/usr` and registers the session

:::note[Installing the native libraries]
Package names vary by distribution. For example:

```bash
# Debian / Ubuntu
sudo apt install libwayland-dev libxkbcommon-dev libudev-dev libinput-dev \
  libgbm-dev libseat-dev xwayland

# Arch Linux
sudo pacman -S wayland libxkbcommon systemd-libs libinput mesa seatd xorg-xwayland
```
:::

:::note[xwayland-satellite is required]
ShojiWM uses `xwayland-satellite` to run X11 applications. The recommended way to
install it is to clone its repository and install directly with Cargo:

```bash
git clone https://github.com/Supreeeme/xwayland-satellite.git
cd xwayland-satellite
cargo install --path ./
```

This places the `xwayland-satellite` binary on your `PATH` (typically under
`~/.cargo/bin`). Install it before starting a session.
:::

## Install

```bash
git clone https://github.com/bea4dev/ShojiWM.git
cd ShojiWM
./dist/install.sh
```

The script will prompt for `sudo` when it needs to copy files into system
directories. It performs the following:

- **Builds** the compositor and the xdg-desktop-portal backend (`cargo`), and
  installs the TypeScript runtime dependencies (`npm ci`).
- Installs the compositor to `/usr/bin/shoji_wm` and the runtime to
  `/usr/lib/shojiwm`.
- Creates a **default user config** at `~/.config/shojiwm` (an existing config is
  left untouched).
- Registers a **Wayland session entry**, so **ShojiWM appears in your login
  manager** — just pick it on the login screen.
- Installs the ShojiWM **xdg-desktop-portal** backend (screen casting, etc.).

### Install options

| Flag | Effect |
| --- | --- |
| `--no-build` | Skip the `cargo` / `npm` build and use existing binaries |
| `--no-portal` | Don't install the xdg-desktop-portal backend |
| `--no-config` | Don't create or update the user config |

Run `./dist/install.sh --help` to see this list.

## Running

- **From your login manager:** choose **ShojiWM** as the session and log in.
- **From a TTY:** run `shoji_wm --tty`.
- **Development (nested window):** run `cargo run --release -p shoji_wm -- --dev`
  from the source tree — handy for iterating without leaving your current session.

## Optional: desktop shell

ShojiWM is just the compositor — it does not ship a bar, launcher, or other shell
UI on its own. A standard shell implementation is provided separately:

- **shoji-bar-2** — [github.com/bea4dev/shoji-bar-2](https://github.com/bea4dev/shoji-bar-2)

Follow the setup instructions in that repository's `README.md` to install and
enable it. (The default ShojiWM config already launches `shoji-bar-2` if it is
present.)
