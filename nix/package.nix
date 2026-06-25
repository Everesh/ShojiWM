{
  lib,
  stdenv,
  rustPlatform,
  buildNpmPackage,
  makeWrapper,
  clang,
  llvmPackages,
  libclang ? llvmPackages.libclang,
  pkg-config,
  nodejs_22,
  wayland,
  wayland-protocols,
  libxkbcommon,
  systemd,
  libinput,
  mesa,
  libglvnd,
  libgbm ? mesa,
  pixman,
  seatd,
  pipewire,
  libdrm,
  dbus,
  xwayland ? null,
  xwaylandSatellite ? null,
}:

let
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        name = baseNameOf path;
        rel = lib.removePrefix (toString ../. + "/") (toString path);
      in
      !(
        name == ".git"
        || name == "target"
        || name == "node_modules"
        || name == "build"
        || lib.hasPrefix "misc/" rel
        || lib.hasPrefix "docs/build/" rel
      );
  };

  runtime = buildNpmPackage {
    pname = "shojiwm-typescript-runtime";
    inherit version src;

    npmDepsHash = "sha256-FFyvtOiLBlufFsHF0wENj0xRkzEyTafaBzKJZWFXmqg=";

    dontNpmBuild = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/lib/shojiwm/packages" "$out/lib/shojiwm/tools"
      cp package.json package-lock.json tsconfig.json "$out/lib/shojiwm/"
      cp -R packages/shoji_wm "$out/lib/shojiwm/packages/"
      cp -R packages/config "$out/lib/shojiwm/packages/"
      cp tools/decoration-runtime.ts tools/evaluate-decoration.ts "$out/lib/shojiwm/tools/"
      cp -R node_modules "$out/lib/shojiwm/node_modules"

      runHook postInstall
    '';
  };

  runtimeBinPath =
    [
      nodejs_22
      dbus
    ]
    ++ lib.optional (xwayland != null) xwayland
    ++ lib.optional (xwaylandSatellite != null) xwaylandSatellite;

  runtimeLibraryPath = lib.makeLibraryPath [
    wayland
    libxkbcommon
    systemd
    libinput
    mesa
    libglvnd
    libgbm
    pixman
    seatd
    pipewire
    libdrm
  ];

  gbmBackendsPath = lib.makeSearchPath "lib/gbm" [
    mesa
  ];

  driDriversPath = lib.makeSearchPath "lib/dri" [
    mesa
  ];

  eglVendorLibraryDirs = lib.makeSearchPath "share/glvnd/egl_vendor.d" [
    mesa
  ];
in
rustPlatform.buildRustPackage {
  pname = "shojiwm";
  inherit version src;

  cargoLock = {
    lockFile = ../Cargo.lock;

    # The workspace currently depends on a Smithay git revision. Replace these
    # fake hashes with the values printed by Nix during the first build.
    outputHashes = {
      "smithay-0.7.0" = "sha256-g5dlLCXhqedqFBi8JcY3mCVkGafLst9pNpFp4mPgffo=";
      "smithay-drm-extras-0.1.0" = "sha256-g5dlLCXhqedqFBi8JcY3mCVkGafLst9pNpFp4mPgffo=";
    };
  };

  nativeBuildInputs = [
    clang
    makeWrapper
    pkg-config
  ];

  LIBCLANG_PATH = "${libclang.lib or libclang}/lib";

  buildInputs = [
    wayland
    wayland-protocols
    libxkbcommon
    systemd
    libinput
    mesa
    libglvnd
    libgbm
    pixman
    seatd
    pipewire
    libdrm
  ];

  cargoBuildFlags = [
    "-p"
    "shoji_wm"
    "-p"
    "xdg-desktop-portal-shojiwm"
  ];

  doCheck = false;

  installPhase = ''
    runHook preInstall

    shoji_bin="$(find target -path '*/release/shoji_wm' -type f -perm -0100 | head -n1)"
    portal_bin="$(find target -path '*/release/xdg-desktop-portal-shojiwm' -type f -perm -0100 | head -n1)"
    if [ -z "$shoji_bin" ] || [ -z "$portal_bin" ]; then
      echo "failed to locate built ShojiWM binaries" >&2
      exit 1
    fi

    install -Dm755 "$shoji_bin" "$out/bin/.shoji_wm-unwrapped"
    install -Dm755 "$portal_bin" "$out/bin/xdg-desktop-portal-shojiwm"

    mkdir -p "$out/lib"
    ln -s "${runtime}/lib/shojiwm" "$out/lib/shojiwm"

    shoji_wrapper_args=(
      --set-default SHOJI_RUNTIME_DIR "$out/lib/shojiwm"
      --set-default SHOJI_TSX "$out/lib/shojiwm/node_modules/.bin/tsx"
      --prefix PATH : "${lib.makeBinPath runtimeBinPath}"
      --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}"
      --suffix GBM_BACKENDS_PATH : "${gbmBackendsPath}"
      --suffix LIBGL_DRIVERS_PATH : "${driDriversPath}"
      --suffix __EGL_VENDOR_LIBRARY_DIRS : "${eglVendorLibraryDirs}"
      --set-default SHOJI_DECORATION_RUNTIME "$out/lib/shojiwm/tools/decoration-runtime.ts"
    )
    ${lib.optionalString (xwaylandSatellite != null) ''
      shoji_wrapper_args+=(
        --set-default SHOJI_XWAYLAND_SATELLITE_PATH "${xwaylandSatellite}/bin/xwayland-satellite"
      )
    ''}
    makeWrapper "$out/bin/.shoji_wm-unwrapped" "$out/bin/shoji_wm" "''${shoji_wrapper_args[@]}"

    wrapProgram "$out/bin/xdg-desktop-portal-shojiwm" \
      --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
      --suffix GBM_BACKENDS_PATH : "${gbmBackendsPath}" \
      --suffix LIBGL_DRIVERS_PATH : "${driDriversPath}" \
      --suffix __EGL_VENDOR_LIBRARY_DIRS : "${eglVendorLibraryDirs}"

    install -Dm644 /dev/stdin "$out/share/wayland-sessions/shojiwm.desktop" <<EOF
[Desktop Entry]
Name=ShojiWM
Comment=Start the ShojiWM Wayland compositor
Exec=$out/bin/shoji_wm --tty
Type=Application
DesktopNames=ShojiWM
EOF

    install -Dm644 /dev/stdin "$out/share/xdg-desktop-portal/portals/shojiwm.portal" <<EOF
[portal]
DBusName=org.freedesktop.impl.portal.desktop.shojiwm
Interfaces=org.freedesktop.impl.portal.ScreenCast
UseIn=ShojiWM
EOF

    install -Dm644 /dev/stdin "$out/share/dbus-1/services/org.freedesktop.impl.portal.desktop.shojiwm.service" <<EOF
[D-BUS Service]
Name=org.freedesktop.impl.portal.desktop.shojiwm
Exec=$out/bin/xdg-desktop-portal-shojiwm
SystemdService=xdg-desktop-portal-shojiwm.service
EOF

    install -Dm644 /dev/stdin "$out/share/systemd/user/xdg-desktop-portal-shojiwm.service" <<EOF
[Unit]
Description=Portal service (ShojiWM implementation)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=dbus
BusName=org.freedesktop.impl.portal.desktop.shojiwm
ExecStart=$out/bin/xdg-desktop-portal-shojiwm
Restart=always
RestartSec=500ms
TimeoutStopSec=10
EOF

    mkdir -p "$out/share/shojiwm/default-config"
    cp -R packages/config/. "$out/share/shojiwm/default-config/"

    install -Dm755 /dev/stdin "$out/bin/shojiwm-init-config" <<EOF
#!/usr/bin/env bash
set -euo pipefail

config_home="\''${XDG_CONFIG_HOME:-\''${HOME:?HOME is not set}/.config}"
user_config_dir="\$config_home/shojiwm"
created_config=0

if [ ! -e "\$user_config_dir/src/index.tsx" ]; then
  mkdir -p "\$user_config_dir"
  cp -R "$out/share/shojiwm/default-config/." "\$user_config_dir/"
  chmod -R u+w "\$user_config_dir"
  created_config=1
  echo "created ShojiWM config at \$user_config_dir"
else
  echo "keeping existing ShojiWM config at \$user_config_dir"
fi

mkdir -p "\$user_config_dir/node_modules"
ln -sfn "$out/lib/shojiwm/packages/shoji_wm" "\$user_config_dir/node_modules/shoji_wm"

if [ "\$created_config" = 1 ] || [ ! -e "\$user_config_dir/package.json" ]; then
  cat > "\$user_config_dir/package.json" <<'PACKAGE_JSON'
{
  "name": "shojiwm-user-config",
  "private": true,
  "type": "module",
  "dependencies": {
    "shoji_wm": "file:./node_modules/shoji_wm"
  }
}
PACKAGE_JSON
fi

if [ "\$created_config" = 1 ] || [ ! -e "\$user_config_dir/tsconfig.json" ]; then
  cat > "\$user_config_dir/tsconfig.json" <<'TSCONFIG_JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "shoji_wm",
    "strict": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  }
}
TSCONFIG_JSON
fi

echo "ShojiWM config is ready."
EOF

    runHook postInstall
  '';

  meta = {
    description = "A highly customizable Wayland compositor configured with TypeScript/TSX";
    homepage = "https://github.com/bea4dev/ShojiWM";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "shoji_wm";
  };
}
