import sys
from bson import ObjectId
import db

rid = ObjectId(sys.argv[1])
samples = list(db.commit_samples.find({"repo_id": rid}).sort("commit_date", 1))
print("=== complexity series ===")
for s in samples:
    print(f"{s['commit_sha'][:7]} avg_cx={round(s['avg_complexity'],1)} "
          f"edges={s['total_edges']} files={s['total_files']}")
print("\n=== spikes ===")
for s in db.flagged_spikes.find({"repo_id": rid}):
    print(f"[{s['metric']}] {s['human_readable_reason']}")
print("\n=== decay count ===")
print(db.ownership_decay.count_documents({"repo_id": rid}))
print("=== onboarding files ===")
op = db.onboarding_path.find_one({"repo_id": rid})
for f in op["ordered_files"]:
    print(f"{f['rank']}. {f['path']} (in={f['indegree']} cx={f['complexity_score']})")
print("\n=== file_metrics sample (top by share) ===")
for fm in sorted(db.file_metrics.find({"repo_id": rid}), key=lambda x: -x["owner_commit_share"])[:6]:
    print(f"{fm['path']} owner={fm['primary_owner']} share={fm['owner_commit_share']} "
          f"commits={fm['commit_count']} last={fm['last_modified_date'].date()}")
