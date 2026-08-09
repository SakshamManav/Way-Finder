"""Quick smoke test for clone + sampling + per-sample tree analysis."""
import os
import sys
import tempfile
import shutil

import git

import analyzer
import metrics

TARGET = "https://github.com/sindresorhus/is"

tmp = tempfile.mkdtemp(prefix="pf-smoke-")
try:
    print("cloning...")
    path = analyzer.clone_repo(TARGET, tmp)
    g = git.Repo(path)
    shas = analyzer.collect_commits(g)
    print(f"total commits: {len(shas)}")
    idx = analyzer.choose_sample_indices(len(shas))
    print(f"sample count: {len(idx)}, first={idx[0]}, last={idx[-1]}")
    for i in [idx[0], idx[len(idx)//2], idx[-1]]:
        doc = analyzer.analyze_tree_at_commit(g, shas[i], None)
        print(f"\n--- sample commit {shas[i][:8]} files={doc['total_files']} "
              f"complexity={doc['total_complexity']} edges={doc['total_edges']} ---")
        for f in doc["files"][:5]:
            print(f"  {f['path']}: loc={f['loc']} cx={f['complexity_score']} "
                  f"imp={f['import_count']} -> {f['imports'][:3]}")
    g.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)
