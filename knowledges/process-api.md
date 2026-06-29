# Runtime Process API

ShojiWM now exposes a TypeScript-side process controller at `COMPOSITOR.process`.

The API is split into three different meanings:

- `once(id, spec)`
  - Run a command once.
  - Intended for session bootstrap tasks.
- `service(id, spec)`
  - Keep a long-lived process managed by ShojiWM.
  - Intended for bars, notification daemons, wallpaper daemons, etc.
- `spawn(spec)`
  - Fire-and-forget imperative execution.
  - Intended for event handlers and ad-hoc commands.

This split is important for future config hot reload support. Top-level startup declarations are
treated as desired state and diffed by `id`; imperative spawns are not diffed.

## API shape

```ts
COMPOSITOR.process.once(id, {
  command: ["fcitx5", "-d"],
  cwd?: "/absolute/or/config-relative/path",
  env?: { KEY: "value" },
  runPolicy?: "once-per-session" | "once-per-config-version",
});

COMPOSITOR.process.service(id, {
  command: ["waybar"],
  cwd?: "/absolute/or/config-relative/path",
  env?: { KEY: "value" },
  restart?: "never" | "on-failure" | "on-exit",
  reload?: "keep-if-unchanged" | "always-restart",
});

COMPOSITOR.process.spawn({
  command: ["notify-send", "hello"],
  cwd?: "/absolute/or/config-relative/path",
  env?: { KEY: "value" },
});
```

`command` can be replaced with `shell`:

```ts
COMPOSITOR.process.spawn({
  shell: "notify-send 'Firefox focused'",
});
```

Relative `cwd` values are resolved relative to the config file.

## Semantics

### `once`

- `id` is the stable identity.
- `once-per-session`
  - Runs at most once per ShojiWM session.
  - Hot reload should not re-run it.
- `once-per-config-version`
  - Runs again when the desired process manifest changes generation.
  - This is intended for future config hot reload.

### `service`

- Services are diffed by `id`.
- If a service disappears from config, ShojiWM stops it.
- If the spec changes, ShojiWM replaces it.
- `restart`
  - `never`: do not restart after exit.
  - `on-failure`: restart only on non-zero exit.
  - `on-exit`: restart on any exit.
- `reload`
  - `keep-if-unchanged`: keep the running process if the spec is unchanged.
  - `always-restart`: restart on the next config generation even if unchanged.

### `spawn`

- Not managed after launch.
- Not diffed.
- Safe to use from event handlers.

## Recommended usage

```ts
COMPOSITOR.process.once("fcitx5", {
  command: ["fcitx5", "-d"],
});

COMPOSITOR.process.service("waybar", {
  command: ["waybar"],
  restart: "on-exit",
});

COMPOSITOR.process.service("mako", {
  command: ["mako"],
  restart: "on-failure",
  reload: "keep-if-unchanged",
});

COMPOSITOR.event.onFocus((window, focused) => {
  if (focused && window.appId() === "firefox") {
    COMPOSITOR.process.spawn({
      command: ["notify-send", "Firefox focused"],
    });
  }
});
```

## Design notes

- Startup declarations are sent from the TS runtime as a process manifest.
- Rust owns the actual process lifecycle and reconciles the current state against the manifest.
- The manifest-based design is the part that makes future hot reload practical; a raw top-level
  `exec()` API would not have enough structure to diff safely.
