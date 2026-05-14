#!/usr/bin/env bash
# Remove everything install-portal.sh put in place.

set -euo pipefail

echo ">> stopping service"
systemctl --user stop xdg-desktop-portal-shojiwm.service 2>/dev/null || true

echo ">> removing files (sudo)"
sudo rm -f \
    /usr/bin/xdg-desktop-portal-shojiwm \
    /usr/share/xdg-desktop-portal/portals/shojiwm.portal \
    /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.shojiwm.service \
    /usr/lib/systemd/user/xdg-desktop-portal-shojiwm.service

rm -f "$HOME/.config/xdg-desktop-portal/shojiwm-portals.conf"

echo ">> reloading systemd + restarting xdg-desktop-portal"
systemctl --user daemon-reload
systemctl --user restart xdg-desktop-portal

echo "done."
