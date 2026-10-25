#!/usr/bin/env python3
"""Extract the vendor action-code dictionary from the app bundle.

Reads `resources/app.asar` (or an already extracted main.js) and writes
`web/js/actions.json` with every assignable target:
  { "code": 92, "constant": "PROFILE_KEYBOARD_INDEX_A", "name": "KB_A" }

The pad stores these codes in the mapping records (map_value1..3) and in macro
steps (step_data), so the UI needs the table to show names instead of numbers.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "web" / "js" / "actions.json"


def extract_main_js(asar: Path) -> str:
    """Pull dist/electron/main.js out of app.asar without extra tooling."""
    with asar.open("rb") as fh:
        header = fh.read(16)
        _u1, _u2, _u3, json_len = (int.from_bytes(header[i : i + 4], "little") for i in (0, 4, 8, 12))
        index = json.loads(fh.read(json_len))
        base = 16 + json_len

        def walk(node, prefix=""):
            for key, value in node.get("files", {}).items():
                path = f"{prefix}/{key}"
                if "files" in value:
                    yield from walk(value, path)
                elif path.endswith("/main.js") and "offset" in value:
                    fh.seek(base + int(value["offset"]))
                    yield fh.read(value["size"]).decode("utf-8", "replace")

        return next(walk(index), None) or ""


def object_body(source: str, start_pattern: str) -> str:
    match = re.search(start_pattern, source)
    if not match:
        raise SystemExit(f"не найдено: {start_pattern}")
    index = source.index("{", match.start())
    depth = 0
    for pos in range(index, len(source)):
        if source[pos] == "{":
            depth += 1
        elif source[pos] == "}":
            depth -= 1
            if depth == 0:
                return source[index + 1 : pos]
    raise SystemExit("незакрытый объект")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asar", type=Path, default=Path("/tmp/opencode/gsx/dist/electron/main.js"))
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv[1:])

    if args.asar.suffix == ".asar":
        source = extract_main_js(args.asar)
    else:
        source = args.asar.read_text(encoding="utf-8", errors="replace")
    if not source:
        raise SystemExit("main.js не найден внутри asar")

    xa_body = object_body(source, r"xa=\{")
    constants = {name: int(value) for name, value in re.findall(r"(PROFILE_[A-Z0-9_]+):(-?\d+)", xa_body)}
    # the same regex over the whole bundle catches constants defined elsewhere
    for name, value in re.findall(r"(PROFILE_[A-Z0-9_]+):(-?\d+)", source):
        constants.setdefault(name, int(value))

    # wa = [{name:Ua.Button.X,value:xa.PROFILE_...}, ...]
    wa_match = re.search(r"\bwa=\[(.*?)\];", source, re.S)
    body = wa_match.group(1) if wa_match else ""
    entries: list[dict[str, object]] = []
    for match in re.finditer(r"\{name:Ua\.Button\.([A-Za-z0-9_]+)\s*,\s*value:xa\.(PROFILE_[A-Z0-9_]+)\}", body):
        name, constant = match.group(1), match.group(2)
        if constant not in constants:
            continue
        entries.append({"code": constants[constant], "constant": constant, "name": name})

    # keep the button enum too, it names the mappable physical buttons
    buttons = {}
    btn_body = object_body(source, r"Button:\{")
    for name, value in re.findall(r"([A-Za-z0-9_]+):\"([^\"]+)\"", btn_body):
        buttons[name] = value

    entries.sort(key=lambda item: (item["code"], item["name"]))
    payload = {
        "source": str(args.asar),
        "count": len(entries),
        "actions": entries,
        "buttons": buttons,
        "constants": len(constants),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    print(f"{len(entries)} действий, {len(buttons)} кнопок, {len(constants)} констант -> {args.out}")
    for item in entries[:12]:
        print(f"  {item['code']:>4} {item['name']:<18} {item['constant']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
