#!/usr/bin/env python3
"""Watch the GameSir config channel and print what the pad sends on its own.

Usage: watch.py [SECONDS] [--all]

Prints frames of report id 0x10 (config/state) with their byte layout, tolerating
re-enumeration (the pad may change USB identity while a combo is held, which
destroys the hidraw node - the watcher reopens it).

Typical use: run it, then hold M + Menu on the pad for ~2 s and repeat.
"""

from __future__ import annotations

import os
import select
import sys
import time
from pathlib import Path

STATE_NAMES = {
    1: "EnterProfileConfig",
    2: "ExitProfileConfig",
    3: "WriteProfile",
    4: "ReadProfile",
    5: "ReadProfileAck",
    6: "Ack",
    7: "SwitchProfile",
    9: "ReadFirmwareVersion",
    10: "ReadFirmwareVersionAck",
    11: "ReadCurrentProfile",
    12: "ReadCurrentProfileAck",
    13: "ReadRGB",
    14: "ReadRGBAck",
    15: "ProfileChanged",
    16: "RefreshProfile",
    17: "RefreshProfileAck",
    18: "WriteEEPRom",
    19: "WriteEEPRomAck",
    20: "ReadEEPRom",
    21: "ReadEEPRomAck",
    240: "Download",
    241: "DownloadAck",
    242: "HeartBeat",
    243: "ReadKeyStatus",
    244: "ReadKeyStatusAck",
    252: "RequestToUpgrade",
}

SYSFS = Path("/sys/class/hidraw")


def find_node() -> tuple[str, str] | None:
    """hidraw node of vendor 0x3537 -> (path, product id)."""
    for entry in sorted(SYSFS.glob("hidraw*")):
        dev = entry / "device"
        try:
            usb = dev.resolve().parent.parent
            vendor = (usb / "idVendor").read_text().strip()
            product = (usb / "idProduct").read_text().strip()
        except OSError:
            continue
        if vendor == "3537":
            return f"/dev/{entry.name}", product
    return None


def open_node() -> tuple[int, str, str]:
    for _ in range(60):
        found = find_node()
        if found:
            path, product = found
            try:
                return os.open(path, os.O_RDWR | os.O_NONBLOCK), path, product
            except OSError:
                pass
        time.sleep(0.5)
    raise SystemExit("no GameSir hidraw node found - is the pad connected?")


def main(argv: list[str]) -> int:
    seconds = float(argv[1]) if len(argv) > 1 and argv[1].replace(".", "").isdigit() else 45.0
    show_all = "--all" in argv

    fd, path, product = open_node()
    print(f"watching {path} (pid {product}) for {seconds:.0f}s; hold M + Menu on the pad")
    deadline = time.time() + seconds
    counts: dict[int, int] = {}
    last_seen: dict[bytes, int] = {}

    while time.time() < deadline:
        try:
            r, _, _ = select.select([fd], [], [], 0.25)
        except OSError:
            r = []
        if not r:
            continue
        try:
            data = os.read(fd, 64 * 32)
        except OSError as exc:
            print(f"[{time.time():.2f}] node gone ({exc}); waiting for re-enumeration")
            os.close(fd)
            fd, path, product = open_node()
            print(f"[{time.time():.2f}] reopened {path} (pid {product})")
            continue
        for off in range(0, len(data) - 63, 64):
            frame = data[off : off + 64]
            if not frame:
                continue
            rid = frame[0]
            counts[rid] = counts.get(rid, 0) + 1
            if rid != 0x10 and not show_all:
                continue
            state = frame[1]
            name = STATE_NAMES.get(state, f"state 0x{state:02x}")
            now = time.time()
            if rid == 0x10:
                body = " ".join(f"{b:02x}" for b in frame[:16])
                extra = f" | [5]={frame[5]} [6]=0x{frame[6]:02x} bits={''.join(n for n, b in (('LT', 1), ('RT', 2), ('LS', 4), ('RS', 8), ('Sensor', 16)) if frame[6] & b)}"
                delta = now - last_seen.get(frame[:8], now)
                last_seen[frame[:8]] = now
                print(f"[{now - deadline + seconds:6.2f}s] 0x{rid:02x} {name:<24} {body}{extra}  (+{delta:.2f}s)")
            else:
                print(f"[{now - deadline + seconds:6.2f}s] 0x{rid:02x} (key state) {frame[1:12].hex()}")

    os.close(fd)
    print("frame id counts:", {f"0x{k:02x}": v for k, v in sorted(counts.items())})
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
