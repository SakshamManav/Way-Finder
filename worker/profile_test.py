"""Profile where time goes: clone, tree analysis, ownership walk."""
import os
import sys
import time
import tempfile
import shutil

import git

import analyzer
import db
from bson import ObjectId

url = sys.argv[1] if len(sys.argv) > 1 else "https://github.com/koajs/koa"
tmp = tempfile.mkdtemp(prefix="pf-prof-")
t0 = time.time()
path = analyzer.clone_repo(url, tmp)
print(f"clone: {time.time()-t0:.1f}s")
g = git.Repo(path)

t0 = time.time()
shas = analyzer.collect_commits(g)
print(f"collect_commits: {time.time()-t0:.1f}s ({len(shas)})")

idx = analyzer.choose_sample_indices(len(shas))
t0 = time.time()
for i in idx[:10]:
    analyzer.analyze_tree_at_commit(g, shas[i], None)
print(f"10 tree analyses: {time.time()-t0:.1f}s")
t0 = time.time()
for i in idx[10:]:
    analyzer.analyze_tree_at_commit(g, shas[i], None)
print(f"rest ({len(idx)-10}) tree analyses: {time.time()-t0:.1f}s")

t0 = time.time()
out = g.git.log("--format=%x00%H%x01%ct%x01%an%x01%ae", "--name-only", "--no-renames")
print(f"git log --name-only: {time.time()-t0:.1f}s, len={len(out)}")
g.close()
shutil.rmtree(tmp, ignore_errors=True)
