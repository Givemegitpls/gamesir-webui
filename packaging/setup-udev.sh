#!/usr/bin/env bash
# Grant the local user access to the GameSir (vendor 0x3537) hidraw nodes.
#
# Idempotent: copies packaging/70-gamesir.rules into /etc/udev/rules.d/, reloads
# rules and re-applies them to already connected devices.
#
#   sudo packaging/setup-udev.sh
#
# Uninstall: sudo rm /etc/udev/rules.d/70-gamesir.rules
#            sudo udevadm control --reload-rules
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RULE_SRC="$HERE/70-gamesir.rules"
RULE_DST=/etc/udev/rules.d/70-gamesir.rules
OUT=/tmp/gamesir-udev.txt

[ -f "$RULE_SRC" ] || { echo "missing $RULE_SRC" >&2; exit 1; }

{
  echo "== before"
  ls -l /dev/hidraw* 2>/dev/null | tail -3

  install -m 0644 "$RULE_SRC" "$RULE_DST"
  echo
  echo "== installed $RULE_DST"
  cat "$RULE_DST"

  udevadm control --reload-rules
  udevadm trigger --action=change --subsystem-match=hidraw
  sleep 1

  echo
  echo "== devices of vendor 3537"
  for h in /sys/class/hidraw/hidraw*; do
    dev="/dev/$(basename "$h")"
    [ -e "$dev" ] || continue
    if [ "$(cat "$h/device/../idVendor" 2>/dev/null)" = "3537" ]; then
      ls -l "$dev"
      getfacl "$dev" 2>/dev/null || true
    fi
  done

  echo
  echo "expected: user:$SUDO_USER (or the seat user) with rw- in the ACL"
} 2>&1 | tee "$OUT"

echo
echo "log: $OUT"
