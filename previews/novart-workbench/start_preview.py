"""Bounded dependency bootstrap, then replace this process with the real gateway.

The checkout may be mounted read-only. Only pip's installation directory and
cache, and the gateway's separate sharing volume, need to be writable.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
INSTALL_TIMEOUT_SECONDS = 120


def required_pillow_version(root: Path = ROOT) -> str:
    lines = [line.strip() for line in (root / "requirements.txt").read_text("utf-8").splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    if len(lines) != 1 or not re.fullmatch(r"Pillow==[0-9]+\.[0-9]+\.[0-9]+", lines[0]):
        raise ValueError("Preview requirements must contain one exact Pillow version.")
    return lines[0].split("==", 1)[1]


def pillow_ready(expected: str) -> bool:
    try:
        if importlib.metadata.version("Pillow") != expected:
            return False
        image = importlib.import_module("PIL.Image")
        return image.__version__ == expected
    except (ImportError, OSError, AttributeError, importlib.metadata.PackageNotFoundError):
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=("127.0.0.1", "0.0.0.0"), default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--room", default="preview")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535 or not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", args.room):
        parser.error("Use a valid port and an alphanumeric room name separated by hyphens.")
    try:
        expected = required_pillow_version()
    except (OSError, ValueError) as error:
        print(f"Preview startup failed: {error}", file=sys.stderr, flush=True)
        return 78
    if not pillow_ready(expected):
        print(f"Installing preview dependency Pillow {expected} (maximum {INSTALL_TIMEOUT_SECONDS}s).", flush=True)
        command = [sys.executable, "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
                   "--no-input", "--only-binary=:all:", "--no-deps", "--timeout", "15", "--retries", "1",
                   "--index-url", "https://pypi.org/simple", "-r", str(ROOT / "requirements.txt")]
        cache = os.environ.get("PIP_CACHE_DIR")
        if cache:
            command.extend(["--cache-dir", cache])
        try:
            result = subprocess.run(command, timeout=INSTALL_TIMEOUT_SECONDS, check=False)
        except subprocess.TimeoutExpired:
            print("Preview startup failed: dependency installation timed out; gateway was not started.", file=sys.stderr, flush=True)
            return 124
        except OSError:
            print("Preview startup failed: dependency installer could not start; gateway was not started.", file=sys.stderr, flush=True)
            return 70
        if result.returncode:
            print(f"Preview startup failed: dependency installation exited {result.returncode}; gateway was not started.", file=sys.stderr, flush=True)
            return 70
        importlib.invalidate_caches()
        if not pillow_ready(expected):
            print("Preview startup failed: required Pillow version is not importable after installation.", file=sys.stderr, flush=True)
            return 70
    gateway = ROOT / "harness" / "share_runtime.py"
    try:
        os.chdir(ROOT)
        os.execv(sys.executable, [sys.executable, str(gateway), "--host", args.host,
                                "--port", str(args.port), "--room", args.room])
    except OSError:
        print("Preview startup failed: could not execute the gateway.", file=sys.stderr, flush=True)
        return 70
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
