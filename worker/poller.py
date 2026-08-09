"""Long-running worker entrypoint for deployed (Zerops) environments.

The Express API can stop spawning child processes by setting
WAYFINDER_EXTERNAL_WORKER=true — it then just records a job with status
"queued" in MongoDB and this process picks it up. It runs the full analysis
pipeline (worker/analyzer.py) one job at a time, forever.

Run:
    python poller.py
"""
import time
from datetime import datetime, timedelta

import analyzer
import db
import envutil

POLL_INTERVAL_SECONDS = 2
# A job stuck in "running" longer than this (e.g. after a worker crash or
# restart) is reclaimed back to "queued" so it gets processed again.
STALE_RUNNING_AFTER = timedelta(minutes=30)


def reclaim_stale_running():
    """Jobs leave an `updated_at` heartbeat on every status change; anything
    that stopped heartbeating for a while was abandoned mid-run."""
    threshold = datetime.utcnow() - STALE_RUNNING_AFTER
    res = db.repos.update_many(
        {"status": "running", "updated_at": {"$lt": threshold}},
        {"$set": {"status": "queued"}},
    )
    if res.modified_count:
        analyzer.log(f"  reclaimed {res.modified_count} stale running job(s)")


def next_job():
    return db.repos.find_one({"status": "queued"}, sort=[("created_at", 1)])


def run():
    envutil.load_env()
    db.ping()
    analyzer.log(f"poller started (interval {POLL_INTERVAL_SECONDS}s, "
                 f"stale-running reclaim {STALE_RUNNING_AFTER})")
    while True:
        try:
            reclaim_stale_running()
            doc = next_job()
            if doc is None:
                time.sleep(POLL_INTERVAL_SECONDS)
                continue
            analyzer.log(f"poller picked up job {doc['_id']} ({doc.get('url')})")
            analyzer.run(doc["_id"], doc["url"])
        except Exception as e:
            analyzer.log(f"poller loop error: {e}")
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    run()
