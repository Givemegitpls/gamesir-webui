#!/usr/bin/env python3
"""Locate calibration state bytes in the Cyclone 2 key-state stream.

Read-only apart from the calibration commands themselves:
  0xFE start/stop is the only thing written; nothing is stored until `finish`.

Usage:
  probe-calib.py [PART]          PART = motion (default) | triggers | sticks
Options:
  --hidraw PATH                  default /dev/hidraw6
  --seconds N                    calibration window, default 6

Flow: heartbeat -> baseline capture -> start -> capture -> finish -> capture.
Prints a per-byte diff so the cal state offsets can be identified.
"""

from __future__ import annotations

import argparse
import os
import select
import time
from collections import Counter

REPORT_OUT = 0x0F
REPORT_CFG_IN = 0x10
REPORT_KEYS_IN = 0x12

PART_BITS = {
    "sticks": 0b0011,
    "triggers": 0b1100,
    "motion": 0b10000,
    "triggers_sticks": 0b1111,
}


def frame(cmd: int, *args: int) -> bytes:
    data = bytearray(64)
    data[0] = REPORT_OUT
    data[1] = cmd
    for i, value in enumerate(args):
        data[2 + i] = value
    return bytes(data)


class Dev:
    def __init__(self, path: str) -> None:
        self.fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        self.buf = bytearray()

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass

    def write(self, data: bytes) -> None:
        os.write(self.fd, data)
        # drain the echo/ack so it does not pollute the next capture
        self.capture(0.15)

    def pump(self, seconds: float) -> list[bytes]:
        """Capture while keeping the pad awake: it stops the key-state stream
        when the host goes quiet for a while."""
        frames: list[bytes] = []
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            os.write(self.fd, frame(0xF2))
            frames.extend(self.capture(min(0.5, max(0.0, deadline - time.monotonic()))))
        return frames

    def capture(self, seconds: float) -> list[bytes]:
        """Collect raw reports for `seconds`."""
        frames: list[bytes] = []
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            ready, _, _ = select.select([self.fd], [], [], min(left, 0.05))
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 4096)
            except BlockingIOError:
                continue
            except OSError:
                break
            self.buf.extend(chunk)
            while len(self.buf) >= 64:
                frames.append(bytes(self.buf[:64]))
                del self.buf[:64]
        return frames


def hexs(data: bytes) -> str:
    return " ".join(f"{b:02x}" for b in data)


def summarise(label: str, frames: list[bytes]) -> dict[str, list[bytes]]:
    by_id: dict[str, list[bytes]] = {}
    for f in frames:
        by_id.setdefault(f"0x{f[0]:02x}", []).append(f)
    for rid, items in sorted(by_id.items()):
        print(f"  {label} {rid}: {len(items)} frames, first: {hexs(items[0][:32])}")
    return by_id


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("part", nargs="?", default="motion", choices=sorted(PART_BITS))
    ap.add_argument("--hidraw", default=os.environ.get("HIDRAW", "/dev/hidraw6"))
    ap.add_argument("--seconds", type=float, default=6.0)
    args = ap.parse_args()

    bits = PART_BITS[args.part]
    dev = Dev(args.hidraw)
    try:
        print(f"device {args.hidraw}, part {args.part} bits 0b{bits:05b}")

        # The pad pushes nothing until spoken to; the heartbeat opens the stream.
        os.write(dev.fd, frame(0xF2))
        baseline = dev.pump(2.0)
        print("baseline:")
        summarise("baseline", baseline)

        print(f"start calibration [0x0F,0xFE,0x00,0b{bits:05b}]")
        dev.write(frame(0xFE, 0x00, bits))
        during = dev.pump(args.seconds)
        print("during:")
        summarise("during", during)

        print("finish [0x0F,0xFE,0x01,0x00]")
        dev.write(frame(0xFE, 0x01, 0x00))
        after = dev.pump(2.0)
        print("after:")
        summarise("after", after)

        def keys(frames: list[bytes]) -> list[bytes]:
            return [f for f in frames if f[0] == REPORT_KEYS_IN]

        base, dur, aft = keys(baseline), keys(during), keys(after)
        if not base or not dur:
            print("! no 0x12 stream captured; try again after waking the pad")
            return 1

        # Frame layout: [0]=0x12, payload follows. Calibration state bytes are
        # constant in each phase, so ignore counters/noise that move anyway.
        common = min(len(f) for f in base + dur)
        changes = []
        for off in range(1, common):
            bvals = {f[off] for f in base}
            dvals = {f[off] for f in dur}
            if bvals == dvals:
                continue
            if len(bvals) <= 2 and len(dvals) <= 2:
                changes.append((off, sorted(bvals), sorted(dvals)))
        print("\nstable bytes that differ baseline -> during:")
        for off, b, d in changes:
            a = sorted({f[off] for f in aft}) if aft else []
            print(f"  off {off:2d}: base {b} -> during {d} -> after {a}")
        print("\nnoisy bytes that changed too (ignored above):")
        for off in range(1, common):
            bvals = {f[off] for f in base}
            dvals = {f[off] for f in dur}
            if bvals != dvals and not (len(bvals) <= 2 and len(dvals) <= 2):
                print(f"  off {off:2d}: base {len(bvals)} values -> during {len(dvals)} values")

        print("\nmost common values per candidate offset during:")
        for off, _, _ in changes[:12]:
            counter = Counter(f[off] for f in dur)
            print(f"  off {off:2d}: {counter.most_common(5)}")
        return 0
    finally:
        dev.close()


if __name__ == "__main__":
    raise SystemExit(main())
