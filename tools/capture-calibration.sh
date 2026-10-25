#!/usr/bin/env bash
# Capture what the pad sends while YOU start calibration on the pad itself.
#
#   tools/capture-calibration.sh [SECONDS]     # default 60
#
# 1) wake the pad (press any button)
# 2) hold M + Menu for ~2 s, release - repeat 3 times
# 3) do not touch the sticks while the countdown runs
#
# Log goes to /tmp/gamesir-calibration.log; it is also printed.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
seconds=${1:-60}
out=/tmp/gamesir-calibration.log

cat <<'EOF'
== перед запуском
1) разбуди пад: нажми любую кнопку (индикатор HOME горит зелёным = XInput)
2) во время записи зажми M + Menu на ~2 секунды, отпусти; повтори 3 раза
3) пока идёт калибровка - не трогай стики
==
EOF

python3 "$here/watch.py" "$seconds" | tee "$out"

echo
echo "лог сохранён: $out"
echo "режим пада (должен быть 3537:xxxx, XInput):"
lsusb | grep -i 3537 || echo "  !! пад не в XInput-режиме"
