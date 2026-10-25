#!/usr/bin/env python3
"""Dump every readable page plus a probe of unknown page numbers.

Usage: layout-dump.py OUTDIR [--probe]

Writes page-NN.bin for the known pages (1-5, 32) and, with --probe, also tries a
range of other page numbers and reports which ones answer. Read-only: it never
writes to the pad.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROBE_PAGES = [0, 6, 7, 8, 9, 10, 16, 20, 24, 28, 31, 33, 34, 40, 48, 56, 64, 128, 255]


def load_c2():
    spec = importlib.util.spec_from_file_location("c2", HERE / "c2.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("outdir", type=Path)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args(argv[1:])
    c2 = load_c2()

    args.outdir.mkdir(parents=True, exist_ok=True)
    summary: dict[str, object] = {"pages": [], "probe": []}

    with c2.Dev() as dev:
        dev.drain(0.1)
        dev.cmd(c2.CMD_ENTER_CFG)
        current = dev.cmd(c2.CMD_READ_CURRENT)
        if current:
            summary["activeProfile"] = current[0][2]
            print(f"активный профиль: {current[0][2]}")

        for page in (1, 2, 3, 4, 5, 32):
            total = c2.LIGHT_LEN if page == 32 else c2.PROFILE_LEN
            buf = c2.read_page(dev, page, total)
            (args.outdir / f"page-{page:02d}.bin").write_bytes(buf)
            summary["pages"].append(page)
            print(f"страница {page:>2}: {len(buf)} байт")

        if args.probe:
            for page in PROBE_PAGES:
                replies = dev.cmd(c2.CMD_READ_PROFILE, page, 0, 0, 58, wait=0.12)
                ok = bool(replies)
                summary["probe"].append({"page": page, "answered": ok, "bytes": replies[0][5] if ok else 0})
                print(f"проба страницы {page:>3}: {'отвечает' if ok else 'молчит'}")
                time.sleep(0.05)

        dev.cmd(c2.CMD_EXIT_CFG, 0)

    (args.outdir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"-> {args.outdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
