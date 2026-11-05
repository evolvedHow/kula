#!/usr/bin/env python3
"""Convenience wrapper: ``python scripts/panchangam.py <command>``.

The engine itself lives in :mod:`scripts.panchang`.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from panchang.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
