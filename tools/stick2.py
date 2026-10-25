#!/usr/bin/env python3
"""Record the pad's raw key-state reports (report id 0x12) from the config HID node.

Usage: stick2.py SECONDS LABEL
Writes /tmp/opencode/rec-LABEL.bin (raw 64-byte reports, one after another).

Wake the pad first (press any button) and do the stick gesture while it runs.
"""

from __future__ import annotations

import os
import select
import sys
import time
from pathlib import Path

DEV = os.environ.get("HIDRAW", "/dev/hidraw6")
OUT = Path("/tmp/opencode")


def main(argv: list[str]) -> int:
    seconds = float(argv[1]) if len(argv) > 1 else 20.0
    label = argv[2] if len(argv) > 2 else "rec"
    path = OUT / f"rec-{label}.bin"

    fd = os.open(DEV, os.O_RDWR | os.O_NONBLOCK)
    reports: list[bytes] = []
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                continue
            try:
                data = os.read(fd, 64 * 32)
            except (BlockingIOError, InterruptedError):
                continue
            for off in range(0, len(data) - 63, 64):
                chunk = data[off : off + 64]
                if chunk and chunk[0] == 0x12:
                    reports.append(chunk)
    finally:
        os.close(fd)

    path.write_bytes(b"".join(reports))
    print(f"{len(reports)} key-state reports ({len(reports) * 64} bytes) -> {path}")
    if not reports:
        print("no reports: pad is asleep. Press a button on it, then run again.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
