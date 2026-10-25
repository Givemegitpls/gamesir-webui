#!/usr/bin/env python3
"""GameSir Cyclone 2 config tool (hidraw, no vendor DLLs).

Transport: report id 0x0F OUT (64 bytes) = [0x0F, cmd, p1, p2, p3, p4, ...payload],
replies on report id 0x10.

Usage:
  c2.py dump [--out DIR]        read pages 1-4, 5 (shift), 32 (light) -> backups
  c2.py read PAGE               print one page
  c2.py verify PAGE FILE        compare a page on the device with a file
  c2.py set PAGE OFFSET VALUE   change a single byte, write only the diff, verify

Commands used (same as the vendor app's main.js):
  0x01 enter profile config, 0x02 exit, 0x03 write chunk, 0x04 read chunk,
  0x0B read current profile index.
"""

from __future__ import annotations

import os
import select
import sys
import time
from pathlib import Path

DEV = os.environ.get("HIDRAW", "/dev/hidraw6")
CHUNK = 58
PROFILE_LEN = 680
LIGHT_LEN = 635
SHIFT_PAGE = 5
LIGHT_PAGE = 32

CMD_ENTER_CFG = 1
CMD_EXIT_CFG = 2
CMD_WRITE_PROFILE = 3
CMD_READ_PROFILE = 4
CMD_READ_CURRENT = 11


class DeviceGone(RuntimeError):
    pass


class Dev:
    def __init__(self, path: str = DEV) -> None:
        self.fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        self.skipped = 0

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass

    def __enter__(self) -> Dev:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def drain(self, timeout: float = 0.05) -> list[bytes]:
        out: list[bytes] = []
        while True:
            r, _, _ = select.select([self.fd], [], [], timeout)
            if not r:
                break
            try:
                out.append(os.read(self.fd, 64))
            except (BlockingIOError, InterruptedError):
                break
        return out

    def send(self, pkt: list[int], wait: float = 0.12) -> list[bytes]:
        raw = bytes(pkt + [0] * (64 - len(pkt)))
        try:
            select.select([], [self.fd], [], 0.5)
            os.write(self.fd, raw)
            time.sleep(wait)
            reps = self.drain()
        except OSError as exc:
            self.close()
            raise DeviceGone(f"{exc} (device re-enumerated?)") from exc
        cfg: list[bytes] = []
        for rep in reps:
            if rep and rep[0] == 0x10:
                cfg.append(rep)
            else:
                self.skipped += 1
        return cfg

    def cmd(self, cmd: int, *args: int, wait: float = 0.12) -> list[bytes]:
        return self.send([0x0F, cmd, *args], wait)


def open_device(path: str = DEV, timeout: float = 30.0) -> Dev:
    """Wait until the hidraw node exists and is readable+writable."""
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            return Dev(path)
        except OSError as exc:
            last = str(exc)
            time.sleep(0.5)
    raise DeviceGone(f"{path} not usable within {timeout:.0f}s: {last}")


def read_page(dev: Dev, page: int, total: int = PROFILE_LEN) -> bytearray:
    buf = bytearray(total)
    off = 0
    while off < total:
        n = min(CHUNK, total - off)
        replies: list[bytes] = []
        for attempt in range(4):
            replies = dev.cmd(CMD_READ_PROFILE, page, (off >> 8) & 0xFF, off & 0xFF, n, wait=0.08)
            if replies:
                break
            time.sleep(0.05 * (attempt + 1))
        if not replies:
            raise RuntimeError(f"no reply reading page {page} at offset {off}")
        for r in replies:
            d_off = (r[3] << 8) | r[4]
            buf[d_off : d_off + r[5]] = r[6 : 6 + r[5]]
        off += n
    return buf


def write_range(dev: Dev, page: int, offset: int, data: bytes) -> None:
    """[0x0F, 0x03, page, offHi, offLo, len, payload...] in 58-byte payload chunks."""
    sent = 0
    while sent < len(data):
        n = min(CHUNK, len(data) - sent)
        off = offset + sent
        pkt = [0x0F, CMD_WRITE_PROFILE, page, (off >> 8) & 0xFF, off & 0xFF, n, *data[sent : sent + n]]
        dev.send(pkt, wait=0.12)
        sent += n
    time.sleep(0.2)


def hx(bs: bytes, n: int | None = None) -> str:
    return " ".join(f"{b:02x}" for b in (bs if n is None else bs[:n]))


def dump(buf: bytes, title: str) -> None:
    print(f"### {title}: {len(buf)} bytes")
    for off in range(0, len(buf), 16):
        print(f"  {off:04x}  {hx(buf[off : off + 16])}")


def cmd_dump(outdir: Path, pages: list[int]) -> int:
    outdir.mkdir(parents=True, exist_ok=True)
    dev = open_device()
    try:
        dev.drain(0.1)
        dev.cmd(CMD_ENTER_CFG)
        replies = dev.cmd(CMD_READ_CURRENT)
        if replies:
            print(f"active profile index: {replies[0][2]}")
        for page in pages:
            total = LIGHT_LEN if page == LIGHT_PAGE else PROFILE_LEN
            for attempt in range(3):
                try:
                    buf = read_page(dev, page, total)
                    break
                except DeviceGone as exc:
                    print(f"page {page}: {exc}; waiting for the device to come back (attempt {attempt + 1})")
                    dev = open_device()
                    dev.cmd(CMD_ENTER_CFG)
            else:
                print(f"page {page}: giving up")
                continue
            path = outdir / f"page-{page:02d}.bin"
            path.write_bytes(buf)
            print(f"page {page:>2}: {len(buf)} bytes -> {path}")
        try:
            dev.cmd(CMD_EXIT_CFG, 0)
        except DeviceGone:
            pass
    finally:
        dev.close()
    return 0


def cmd_read(page: int) -> int:
    total = LIGHT_LEN if page == LIGHT_PAGE else PROFILE_LEN
    with Dev() as dev:
        dev.drain(0.1)
        dev.cmd(CMD_ENTER_CFG)
        buf = read_page(dev, page, total)
        dev.cmd(CMD_EXIT_CFG, 0)
    dump(buf, f"page {page}")
    return 0


def cmd_verify(page: int, path: Path) -> int:
    total = LIGHT_LEN if page == LIGHT_PAGE else PROFILE_LEN
    with Dev() as dev:
        dev.drain(0.1)
        dev.cmd(CMD_ENTER_CFG)
        buf = read_page(dev, page, total)
        dev.cmd(CMD_EXIT_CFG, 0)
    want = path.read_bytes()
    if bytes(buf) == want:
        print("identical")
        return 0
    diffs = [(i, want[i], buf[i]) for i in range(min(len(buf), len(want))) if buf[i] != want[i]]
    print(f"{len(diffs)} differing byte(s):")
    for i, w, g in diffs:
        print(f"  {i:#06x}  file={w:#04x}  device={g:#04x}")
    return 1


def cmd_set(page: int, offset: int, value: int) -> int:
    with Dev() as dev:
        dev.drain(0.1)
        dev.cmd(CMD_ENTER_CFG)
        before = read_page(dev, page)
        if before[offset] == value:
            print(f"byte {offset:#06x} already {value:#04x}, nothing to do")
            dev.cmd(CMD_EXIT_CFG, 0)
            return 0
        print(f"page {page} byte {offset:#06x}: {before[offset]:#04x} -> {value:#04x}")
        write_range(dev, page, offset, bytes([value]))
        after = read_page(dev, page)
        dev.cmd(CMD_EXIT_CFG, 0)

    changed = [i for i in range(len(before)) if before[i] != after[i]]
    print(f"changed bytes after write: {[hex(i) for i in changed]}")
    if changed == [offset] and after[offset] == value:
        print("OK: exactly the requested byte changed")
        return 0
    print("WARN: unexpected diff! full before/after differing bytes listed above")
    return 2


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    op, *rest = argv[1:]
    if op == "dump":
        outdir = Path(rest[0]) if rest else Path("/tmp/opencode/c2-backup")
        return cmd_dump(outdir, [1, 2, 3, 4, SHIFT_PAGE, LIGHT_PAGE])
    if op == "read":
        return cmd_read(int(rest[0]))
    if op == "verify":
        return cmd_verify(int(rest[0]), Path(rest[1]))
    if op == "set":
        return cmd_set(int(rest[0]), int(rest[1], 0), int(rest[2], 0))
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
