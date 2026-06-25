{ self }:

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.shojiwm;
  system = pkgs.stdenv.hostPlatform.system;
  defaultPackage = self.packages.${system}.default;
  defaultSatellite = pkgs.xwayland-satellite or null;
  gtkPortal = pkgs.xdg-desktop-portal-gtk or null;

  shojiPackage =
    if cfg.package ? override then
      cfg.package.override {
        xwaylandSatellite =
          if cfg.xwaylandSatellite.enable then cfg.xwaylandSatellite.package else null;
      }
    else
      cfg.package;
in
{
  options.programs.shojiwm = {
    enable = lib.mkEnableOption "ShojiWM";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage;
      defaultText = "ShojiWM flake default package";
      description = "ShojiWM package to install.";
    };

    portal.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to enable xdg-desktop-portal-shojiwm for screen capture.";
    };

    portal.gtkFallback = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to install xdg-desktop-portal-gtk as the fallback portal backend.";
    };

    xwaylandSatellite.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to configure ShojiWM to use xwayland-satellite.";
    };

    xwaylandSatellite.package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = defaultSatellite;
      defaultText = lib.literalExpression "pkgs.xwayland-satellite or null";
      description = ''
        xwayland-satellite package used by ShojiWM. Override this with a forked
        package, for example a Unity compatibility branch, when needed.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.xwaylandSatellite.enable || cfg.xwaylandSatellite.package != null;
        message = ''
          programs.shojiwm.xwaylandSatellite.enable is true, but pkgs.xwayland-satellite
          is not available. Set programs.shojiwm.xwaylandSatellite.package explicitly,
          or disable xwaylandSatellite.
        '';
      }
      {
        assertion = !cfg.portal.enable || !cfg.portal.gtkFallback || gtkPortal != null;
        message = ''
          programs.shojiwm.portal.gtkFallback is true, but xdg-desktop-portal-gtk
          is not available in this nixpkgs. Disable gtkFallback or provide a newer nixpkgs.
        '';
      }
    ];

    environment.systemPackages =
      [
        shojiPackage
        pkgs.xorg.xwayland
      ]
      ++ lib.optional (cfg.xwaylandSatellite.enable && cfg.xwaylandSatellite.package != null)
        cfg.xwaylandSatellite.package
      ++ lib.optional (cfg.portal.enable && cfg.portal.gtkFallback && gtkPortal != null) gtkPortal;

    services.displayManager.sessionPackages = [ shojiPackage ];

    xdg.portal = lib.mkIf cfg.portal.enable {
      enable = true;
      extraPortals =
        [ shojiPackage ]
        ++ lib.optional (cfg.portal.gtkFallback && gtkPortal != null) gtkPortal;
      config.ShojiWM =
        {
          "org.freedesktop.impl.portal.ScreenCast" = [ "shojiwm" ];
        }
        // lib.optionalAttrs cfg.portal.gtkFallback {
          default = [ "gtk" ];
        };
    };

    systemd.user.services.xdg-desktop-portal-shojiwm = lib.mkIf cfg.portal.enable {
      description = "Portal service (ShojiWM implementation)";
      partOf = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "dbus";
        BusName = "org.freedesktop.impl.portal.desktop.shojiwm";
        ExecStart = "${shojiPackage}/bin/xdg-desktop-portal-shojiwm";
        Restart = "always";
        RestartSec = "500ms";
        TimeoutStopSec = "10";
      };
    };
  };
}
