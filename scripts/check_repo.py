#!/usr/bin/env python3
"""Offline checks for the preparation scaffold; no application tests yet."""

from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "README.md", ".env.example", "docs/brief.md", "docs/plan.md",
    "docs/hackalem-analysis.md", "docs/decisions.md", "docs/progress.md",
    "docs/demo.md", "docs/research.md", "src/README.md", "tests/README.md",
    "data/examples/README.md",
)


def main():
    errors = [f"Missing or empty: {p}" for p in REQUIRED
              if not (ROOT / p).is_file() or not (ROOT / p).stat().st_size]
    tracked = subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=ROOT
    ).decode().split("\0")
    for name in filter(None, tracked):
        path = Path(name)
        if ((path.name == ".env" or path.name.startswith(".env."))
                and not path.name.endswith(".example")):
            errors.append(f"Environment file is tracked: {name}")
        if name.startswith((".tools/", "unfairgaps-os/", "data/private/", ".venv/")):
            errors.append(f"Local-only file is tracked: {name}")
    for args in (["git", "diff", "--check"], ["git", "diff", "--cached", "--check"]):
        result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
        if result.returncode:
            errors.append(result.stdout + result.stderr)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Scaffold OK: documents present, tracked paths checked, diff whitespace clean.")
    print("This is not an application test or a full secret scan.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
