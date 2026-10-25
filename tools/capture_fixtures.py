#!/usr/bin/env python3
"""Capture raw config-channel frames (report id 0x10) as a test fixture.

Usage: capture_fixtures.py [OUT.json]

Writes JSON: {"frames": [{"cmd": <int>, "hex": "<64-byte frame>"}]} and the
reassembled 680-byte profile page 1 as "page1_hex".
The fixture is used to validate the browser-side protocol parser in Node.
"""

from __future__ import annotations

import json
import os
import select
import sys
import time
from pathlib import Path

DEV = os.environ.get("HIDRAW", "/dev/hidraw6")
CHUNK = 58
PROFILE_LEN = 680


def open_ready(path: str = DEV, timeout: float = 20.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        except OSError:
            time.sleep(0.5)
            continue
        # the pad sleeps: it answers only when awake
        os.write(fd, bytes([0x0F, 0xF2, 0x00] + [0] * 61))
        time.sleep(0.15)
        if drain(fd, 0.3):
            return fd
        os.close(fd)
        time.sleep(0.5)
    raise SystemExit("device never answered (asleep?) - press a button on the pad")


def drain(fd: int, timeout: float = 0.2) -> list[bytes]:
    out: list[bytes] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            data = os.read(fd, 64 * 16)
        except (BlockingIOError, InterruptedError):
            continue
        for off in range(0, len(data) - 63, 64):
            out.append(data[off : off + 64])
    return out


def send(fd: int, cmd: int, *args: int, wait: float = 0.1) -> list[bytes]:
    os.write(fd, bytes([0x0F, cmd, *args] + [0] * (63 - len(args) - 1)))
    time.sleep(wait)
    return [f for f in drain(fd) if f[0] == 0x10]


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else Path(__file__).parent / "fixtures" / "page1-frames.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    fd = open_ready()
    frames: list[dict[str, object]] = []

    def rec(cmd: int, reps: list[bytes]) -> None:
        for f in reps:
            frames.append({"cmd": cmd, "hex": f.hex()})

    try:
        rec(0xF2, send(fd, 0xF2, 0x00))
        rec(0x09, send(fd, 0x09))
        rec(0x01, send(fd, 0x01))
        rec(0x0B, send(fd, 0x0B))

        page = bytearray(PROFILE_LEN)
        off = 0
        while off < PROFILE_LEN:
            n = min(CHUNK, PROFILE_LEN - off)
            reps = send(fd, 0x04, 1, (off >> 8) & 0xFF, off & 0xFF, n, wait=0.08)
            if not reps:
                time.sleep(0.2)
                reps = send(fd, 0x04, 1, (off >> 8) & 0xFF, off & 0xFF, n, wait=0.12)
            rec(0x04, reps)
            for r in reps:
                d_off = (r[3] << 8) | r[4]
                page[d_off : d_off + r[5]] = r[6 : 6 + r[5]]
            off += n

        rec(0x02, send(fd, 0x02, 0x00))
    finally:
        os.close(fd)

    payload = {"frames": frames, "page1_hex": bytes(page).hex()}
    out.write_text(json.dumps(payload, indent=1))
    print(f"{len(frames)} frames, page1 {len(page)} bytes -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
