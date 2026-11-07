#!/usr/bin/env python3
"""Probe the motion payload of the Cyclone 2 in the key-state stream (0x12).

Read-only apart from the keep-alive heartbeat 0xF2: no config is written.

Layout found on this unit (64-byte frame, offsets from the report id):
  [1..4] LS/RS axes, [5] LT, [6] RT, [10..11] 16-bit timestamp,
  [13..18] gyroscope X/Y/Z, [19..24] accelerometer X/Y/Z - both little-endian
  16-bit pairs; accelerometer scale is 8192 counts per 1 g.

Usage: probe-motion.py [--phases "still:10,yaw:6,rest:3,roll:6,..."] [--out DIR]

Phases are captured back to back, each saved as NN-name.bin, then summarised:
mean gyro/accel vector and gyro noise per phase, plus per-byte jitter. Label the
phases after the movement to map axes and signs (yaw / roll / pitch).
"""

from __future__ import annotations

import argparse
import os
import select
import time
from collections import Counter
from pathlib import Path

REPORT_OUT = 0x0F
REPORT_CFG_IN = 0x10
REPORT_KEYS_IN = 0x12
HEARTBEAT = 0xF2

SYSFS = Path("/sys/class/hidraw")


def find_node() -> str | None:
    """hidraw node that belongs to vendor 0x3537 on the config/consumer interface."""
    for entry in sorted(SYSFS.glob("hidraw*")):
        uevent = entry / "device" / "uevent"
        try:
            text = uevent.read_text()
        except OSError:
            continue
        if "v00003537" in text:
            return f"/dev/{entry.name}"
    return None


def frame(cmd: int) -> bytes:
    data = bytearray(64)
    data[0] = REPORT_OUT
    data[1] = cmd
    return bytes(data)


class Dev:
    def __init__(self, path: str, out_dir: Path | None = None) -> None:
        self.fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        self.buf = bytearray()
        self.out_dir = out_dir
        if out_dir is not None:
            out_dir.mkdir(parents=True, exist_ok=True)

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass

    def write(self, data: bytes) -> None:
        try:
            os.write(self.fd, data)
        except OSError:
            pass

    def phase(self, seconds: float, label: str) -> tuple[list[bytes], Counter]:
        """Capture reports while keeping the pad awake with the heartbeat."""
        frames: list[bytes] = []
        counts: Counter = Counter()
        deadline = time.monotonic() + seconds
        beat = 0.0
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= beat:
                self.write(frame(HEARTBEAT))
                beat = now + 0.3
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 64 * 16)
            except BlockingIOError:
                continue
            except OSError:
                break
            self.buf.extend(chunk)
            while len(self.buf) >= 64:
                report = bytes(self.buf[:64])
                del self.buf[:64]
                counts[report[0]] += 1
                if report[0] == REPORT_KEYS_IN:
                    frames.append(report)
        print(f"  {label}: {len(frames)} key frames, ids {dict(counts)}", flush=True)
        if self.out_dir is not None:
            (self.out_dir / f"{label}.bin").write_bytes(b"".join(frames))
        return frames, counts


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def jitter(frames: list[bytes], off: int) -> float:
    """Mean absolute frame-to-frame change: gyro moves fast, noise stays low."""
    vals = [f[off] for f in frames]
    return mean([abs(b - a) for a, b in zip(vals, vals[1:])])


GYRO = (13, 15, 17)   # little-endian 16-bit pairs, counts
ACCEL = (19, 21, 23)
ACCEL_PER_G = 8192


def i16(frame: bytes, off: int) -> int:
    value = frame[off] | (frame[off + 1] << 8)
    return value - 65536 if value >= 32768 else value


def triple(frame: bytes, offs: tuple[int, int, int]) -> tuple[int, int, int]:
    return (i16(frame, offs[0]), i16(frame, offs[1]), i16(frame, offs[2]))


def parse_phases(spec: str) -> list[tuple[str, float]]:
    phases = []
    for item in spec.split(","):
        name, _, seconds = item.partition(":")
        if not name or not seconds:
            raise SystemExit(f"bad phase spec: {item}")
        phases.append((name, float(seconds)))
    return phases


PHASE_HINTS = {
    "still": "pad flat on the table, do not touch",
    "rest": "put the pad flat again, do not touch",
    "yaw": "keep the pad flat, turn it 90° to the LEFT (counter-clockwise from above) and hold",
    "roll": "tilt the LEFT edge down to vertical and hold",
    "pitch": "tilt the FAR edge down to vertical and hold",
    "move": "rotate and tilt the pad in your hands",
    "hold": "put the pad down in another position",
}
PREP_SECONDS = 1.5


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hidraw", default=os.environ.get("HIDRAW") or find_node() or "/dev/hidraw5")
    ap.add_argument("--phases", default="still:5,yaw:6,rest:3,roll:6,rest:3,pitch:6,rest:4")
    ap.add_argument("--out", default="/tmp/opencode/motion-capture")
    args = ap.parse_args()

    spec = parse_phases(args.phases)
    print(f"device {args.hidraw}, raw frames -> {args.out}", flush=True)

    dev = Dev(args.hidraw, Path(args.out))
    captured: dict[str, list[bytes]] = {}
    try:
        for index, (name, seconds) in enumerate(spec):
            hint = PHASE_HINTS.get(name, "")
            print(f"\n[{index + 1}/{len(spec)}] {name.upper()} — {seconds:.0f} s: {hint}", flush=True)
            time.sleep(PREP_SECONDS)
            print("  recording...", flush=True)
            label = f"{index:02d}-{name}"
            frames, _ = dev.phase(seconds, label)
            captured[label] = frames
    finally:
        dev.close()

    if not any(captured.values()):
        print("! no key-state stream captured; is the pad asleep?", flush=True)
        return 1

    print("\nmotion block per phase (gyroscope and accelerometer, little-endian):")
    print(" phase              gyro x,y,z (mean)            gyro sd        accel x,y,z (mean)          |a|/g")
    for label, frames in captured.items():
        if not frames:
            continue
        gyro = [triple(f, GYRO) for f in frames]
        accel = [triple(f, ACCEL) for f in frames]
        gmean = [mean([v[k] for v in gyro]) for k in range(3)]
        gsd = [
            (sum((v[k] - gmean[k]) ** 2 for v in gyro) / len(gyro)) ** 0.5
            for k in range(3)
        ]
        amean = [mean([v[k] for v in accel]) for k in range(3)]
        amag = mean([(x * x + y * y + z * z) ** 0.5 for x, y, z in accel]) / ACCEL_PER_G
        print(
            f" {label:<16} {gmean[0]:8.1f} {gmean[1]:8.1f} {gmean[2]:8.1f}   "
            f"{gsd[0]:6.2f} {gsd[1]:6.2f} {gsd[2]:6.2f}   "
            f"{amean[0]:8.1f} {amean[1]:8.1f} {amean[2]:8.1f}   {amag:6.3f}"
        )

    labels = list(captured)
    length = min(len(f) for f in captured.values() if f)
    length = min(length, 64)
    print("\nper-byte frame-to-frame movement (jitter) by phase:")
    print(" off " + " ".join(f"{label:>15}" for label in labels))
    ranked = []
    for off in range(1, length):
        values = [jitter(captured[label], off) if captured[label] else 0.0 for label in labels]
        ranked.append((off, values))
    for off, values in sorted(ranked, key=lambda item: max(item[1]) - min(item[1]), reverse=True)[:16]:
        print(f" {off:3d} " + " ".join(f"{v:15.2f}" for v in values))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
