#!/usr/bin/env bash
# Dev only: a Linux desktop for the scenario lab (test/scenarios.lab.test.ts). A virtual screen, a window manager, the session
# D-Bus and the accessibility bus (agent-desktop reads apps through AT-SPI), and copies of Electron named like the apps they play
# (ms-teams, gnome-terminal), because agent-desktop names an app by its process. Prints the env lines to source.
# Needs: Xvfb, openbox, xdotool, dbus-launch, at-spi2-core (apt install xvfb openbox xdotool dbus-x11 at-spi2-core).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
state=${BEE_LAB_DIR:-/tmp/bee-lab}
mkdir -p "$state"
display=${BEE_LAB_DISPLAY:-:77}
if ! xdpyinfo -display "$display" >/dev/null 2>&1 && ! DISPLAY=$display xdotool getdisplaygeometry >/dev/null 2>&1; then
  Xvfb "$display" -screen 0 1600x1000x24 >"$state/xvfb.log" 2>&1 &
  sleep 1
fi
if [ ! -f "$state/dbus.env" ]; then
  dbus-launch --sh-syntax | grep DBUS_SESSION_BUS_ADDRESS >"$state/dbus.env"
fi
. "$state/dbus.env"
export DBUS_SESSION_BUS_ADDRESS DISPLAY=$display
# Chromium apps (the lab apps, Bee) publish their accessibility tree only when asked to.
export ACCESSIBILITY_ENABLED=1 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
pgrep -x openbox >/dev/null || (openbox >"$state/openbox.log" 2>&1 &)
pgrep -x at-spi-bus-laun >/dev/null || (/usr/libexec/at-spi-bus-launcher --launch-immediately >"$state/atspi.log" 2>&1 &)
dist=$(dirname "$(readlink -f "$root/node_modules/electron/dist/electron")")
for name in ms-teams gnome-terminal; do [ -x "$dist/$name" ] || cp "$dist/electron" "$dist/$name"; done
sleep 1
cat <<ENV
export DISPLAY=$display
export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'
export ACCESSIBILITY_ENABLED=1 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
export BEE_LAB=1
ENV
