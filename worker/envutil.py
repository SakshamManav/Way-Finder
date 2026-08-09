"""Tiny .env loader for the worker (no third-party dependency).

The Express API loads the project-root .env via dotenv and spawned workers
inherit it, but running the worker directly (tests, retrofits) needs its own
load. Real environment variables always win over the file.
"""
import os

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ENV_PATH = os.path.join(_PROJECT_ROOT, ".env")
_loaded = False


def load_env():
    global _loaded
    if _loaded:
        return
    _loaded = True
    if not os.path.exists(_ENV_PATH):
        return
    with open(_ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
