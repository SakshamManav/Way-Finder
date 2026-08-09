"""Database + progress helpers for the Wayfinder analysis worker.

Assumption: local MongoDB and Redis are reachable on default ports (overridable
via env vars). The worker writes analysis results to MongoDB (document-shaped)
and lightweight progress ticks to Redis, which the Express API polls.
"""
import json
import os
from datetime import datetime

from pymongo import MongoClient
from redis import Redis

MONGO_URL = os.environ.get("WAYFINDER_MONGO_URL", "mongodb://127.0.0.1:27017")
REDIS_HOST = os.environ.get("WAYFINDER_REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.environ.get("WAYFINDER_REDIS_PORT", "6379"))
REDIS_PASSWORD = os.environ.get("WAYFINDER_REDIS_PASSWORD") or None

_client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
_db = _client["wayfinder"]

repos = _db["repos"]
commit_samples = _db["commit_samples"]
file_metrics = _db["file_metrics"]
flagged_spikes = _db["flagged_spikes"]
ownership_decay = _db["ownership_decay"]
onboarding_path = _db["onboarding_path"]

_redis = Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD,
               decode_responses=True, socket_connect_timeout=0.5)
_redis_ok = None  # None = unknown, True/False cached


def _redis_available():
    """Redis is optional for correctness: without it, progress ticks are
    skipped but analysis still completes. We probe once and cache the result
    so a dead Redis can't stall the pipeline (~2s per call previously)."""
    global _redis_ok
    if _redis_ok is None:
        try:
            _redis.ping()
            _redis_ok = True
        except Exception:
            _redis_ok = False
    return _redis_ok


def ping():
    _client.admin.command("ping")
    _redis_available()  # probe but do not raise if Redis is down


def set_status(repo_id, status, **extra):
    """Update the repo/job status doc. This is the single source of truth for
    job state; progress ticks live in Redis on top of it. `updated_at` is a
    heartbeat so an external poller can reclaim jobs stuck in "running"."""
    doc = {"status": status, "updated_at": datetime.utcnow()}
    doc.update(extra)
    repos.update_one({"_id": repo_id}, {"$set": doc})


def set_progress(repo_id, stage, message, percent):
    """Write a progress tick to Redis. Kept off MongoDB to avoid write churn.
    Best-effort: never blocks or fails the job if Redis is unavailable."""
    if not _redis_available():
        return
    try:
        _redis.set(
            f"job:{repo_id}:progress",
            json.dumps({"stage": stage, "message": message, "percent": percent}),
        )
    except Exception:
        pass
