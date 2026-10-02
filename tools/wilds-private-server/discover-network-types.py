"""Read named network metadata candidates from a local binary without loading it.

Output contains identifier strings only, never nearby memory or runtime values.
A string occurrence does not establish that a type exists in the runtime TDB.
"""

import argparse
import hashlib
import json
import mmap
from pathlib import Path
import re


IDENTIFIER = re.compile(
    rb"(?<![A-Za-z0-9_.])(?:app|via)\.[A-Za-z_][A-Za-z0-9_.+`]{2,160}(?=[\x00\s])"
)


def discover(data):
    symbols = sorted({
        match.group().decode("ascii")
        for match in IDENTIFIER.finditer(data)
        if match.group().startswith((b"via.network.", b"app.NetworkRequestManager.", b"app.net_"))
    })
    candidates = {}
    for symbol in symbols:
        # app.NetworkRequestManager.IService.method strings establish a candidate
        # declaring type, not a reflected method signature or supported API.
        if symbol.startswith("app.NetworkRequestManager."):
            name = symbol.rsplit(".", 1)[0]
            source = "inferred_declaring_type_from_member_string"
        else:
            name = symbol
            source = "literal_identifier_string"
        candidates.setdefault(name, {"name": name, "evidence": source})
    return {
        "schemaVersion": 1,
        "runtimeValidated": False,
        "note": "Identifier occurrences only; no endpoint, session protocol or callable API is established.",
        "symbolCount": len(symbols),
        "candidateCount": len(candidates),
        "candidates": sorted(candidates.values(), key=lambda item: item["name"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    source = args.input.resolve(strict=True)
    target = args.out.resolve()
    if source == target:
        parser.error("The report cannot overwrite its input")
    if source.stat().st_size == 0:
        parser.error("The input is empty")
    with source.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        result = discover(data)
        result["source"] = {"path": str(source), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    target.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation preserves previous reports and unrelated output files.
    with target.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"report": str(target), "candidates": result["candidateCount"], "runtimeValidated": False}))


if __name__ == "__main__":
    main()
