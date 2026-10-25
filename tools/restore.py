#!/usr/bin/env python3
"""Restore profile pages on the pad from a backup.

Usage:
  restore.py --dir DIR PAGE [PAGE ...]     # DIR/page-NN.bin
  restore.py --json FILE PAGE [PAGE ...]   # pages map from the web UI export

Writes only the changed byte ranges (the same diff approach the vendor app uses),
then reads every page back and reports any remaining mismatch.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_device_module():
    spec = importlib.util.spec_from_file_location("c2", HERE / "c2.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def changed_ranges(before: bytes, after: bytes) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = -1
    for index in range(len(before) + 1):
        differs = index < len(before) and before[index] != after[index]
        if differs and start < 0:
            start = index
        if not differs and start >= 0:
            ranges.append((start, index))
            start = -1
    return ranges


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--dir", type=Path)
    source.add_argument("--json", type=Path)
    parser.add_argument("pages", type=int, nargs="+")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv[1:])

    c2 = load_device_module()

    if args.json:
        payload = json.loads(args.json.read_text())
        targets = {int(page): bytes(values) for page, values in payload["pages"].items()}
    else:
        targets = {}
        for page in args.pages:
            path = args.dir / f"page-{page:02d}.bin"
            if not path.exists():
                print(f"page {page}: {path} не найден — пропуск")
                continue
            targets[page] = path.read_bytes()

    missing = [page for page in args.pages if page not in targets]
    if missing:
        print(f"нет данных для страниц: {missing}")

    with c2.Dev() as dev:
        dev.drain(0.1)
        dev.cmd(c2.CMD_ENTER_CFG)
        for page in args.pages:
            target = targets.get(page)
            if target is None:
                continue
            before = c2.read_page(dev, page)
            if len(target) != len(before):
                print(f"страница {page}: размер {len(target)} != {len(before)} — пропуск")
                continue
            ranges = changed_ranges(before, target)
            if not ranges:
                print(f"страница {page}: уже совпадает")
                continue
            print(
                f"страница {page}: {sum(b - a for a, b in ranges)} байт в {len(ranges)} диапазон(ах): "
                + ", ".join(f"0x{a:02x}..0x{b - 1:02x}" for a, b in ranges[:8])
                + (" …" if len(ranges) > 8 else "")
            )
            if args.dry_run:
                continue
            for start, end in ranges:
                c2.write_range(dev, page, start, target[start:end])
                time.sleep(0.1)
            after = c2.read_page(dev, page)
            mismatch = [i for i in range(len(target)) if target[i] != after[i]]
            if mismatch:
                print(f"  ВНИМАНИЕ: после записи отличаются байты {[hex(i) for i in mismatch[:8]]}")
            else:
                print("  записано и прочитано назад: совпадает")
        dev.cmd(c2.CMD_EXIT_CFG, 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
