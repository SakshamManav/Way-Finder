import sys
from bson import ObjectId
import db

rid = ObjectId(sys.argv[1])
order = {"high": 0, "medium": 1, "low": 2}
rows = sorted(db.ownership_decay.find({"repo_id": rid}),
              key=lambda x: (order[x["risk_level"]], -x["inactive_duration_days"]))
print("=== decay by risk ===")
for d in rows[:15]:
    print(f"[{d['risk_level']:6s}] {d['path']:45s} {d['former_primary_owner']:22s} "
          f"share={d['owner_commit_share']} inactive={d['inactive_duration_days']}d")
print(f"total decay: {len(rows)}")
