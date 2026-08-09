"""Full-pipeline test: seed a Mongo job and run analyzer.run() end to end."""
import sys
import time
from datetime import datetime

import db
import analyzer

url = sys.argv[1] if len(sys.argv) > 1 else "https://github.com/koajs/koa"
doc = {
    "url": analyzer.normalize_repo_url(url),
    "status": "queued",
    "created_at": datetime.utcnow(),
}
res = db.repos.insert_one(doc)
rid = res.inserted_id
print(f"seeded repo {rid}")
t0 = time.time()
code = analyzer.run(str(rid), url)
print(f"exit={code} elapsed={time.time() - t0:.1f}s")

repos_doc = db.repos.find_one({"_id": rid})
print("\n=== repo status ===")
print(repos_doc)
print("\n=== spikes ===")
for s in db.flagged_spikes.find({"repo_id": rid}):
    print(f"[{s['metric']}] {s['human_readable_reason']}  delta={s['delta']}")
print("\n=== ownership decay (top 5 by inactivity) ===")
for d in sorted(db.ownership_decay.find({"repo_id": rid}),
                key=lambda x: -x["inactive_duration_days"])[:5]:
    print(f"[{d['risk_level']}] {d['path']} owner={d['former_primary_owner']} "
          f"share={d['owner_commit_share']} inactive={d['inactive_duration_days']}d")
print("\n=== onboarding (top 8) ===")
op = db.onboarding_path.find_one({"repo_id": rid})
if op:
    for f in op["ordered_files"][:8]:
        print(f"{f['rank']}. {f['path']} (in={f['indegree']} cx={f['complexity_score']}) {f['reason']}")
