#!/usr/bin/env python3
"""Record which build this bundle is, in its app.yaml.

`version` and `revision` are the bundle's own labels. Nothing in the
access point reads them: they are recorded when the bundle is
published, so that "which build was running in October?" is answerable
from the audit trail without having kept the artifacts. A digest
identifies a build uniquely and tells a person nothing.

Usage: stamp-manifest.py <app.yaml> [version] [revision]

Rewrites the file in place. An empty or absent value leaves that key
alone, so `make bundle` with no VERSION is exactly what it was.

Deliberately not a YAML library: this runs in CI and from a Makefile,
and a dependency for two string keys would be the only one in the
repository. The file is the template's own app.yaml, whose shape is
known -- so the rule is narrow and the failure is loud.
"""

import re
import sys


def stamp(text: str, key: str, value: str) -> str:
    if not value:
        return text
    if "\n" in value or '"' in value:
        raise SystemExit(f"{key}: refusing a value with a quote or a newline: {value!r}")
    line = f"{key}: {value}"
    # An existing key is replaced where it stands, so a hand-written
    # comment above it keeps its subject.
    pattern = re.compile(rf"^{key}:.*$", re.MULTILINE)
    if pattern.search(text):
        return pattern.sub(line, text, count=1)
    return text.rstrip("\n") + "\n" + line + "\n"


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    version = sys.argv[2] if len(sys.argv) > 2 else ""
    revision = sys.argv[3] if len(sys.argv) > 3 else ""

    with open(path, encoding="utf-8") as f:
        text = f.read()
    text = stamp(text, "version", version)
    text = stamp(text, "revision", revision)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


if __name__ == "__main__":
    main()
