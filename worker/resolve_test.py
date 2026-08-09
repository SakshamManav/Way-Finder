"""Verify import extraction + resolution on real repo files (shallow clone)."""
import os
import sys
import tempfile
import shutil

import git
from metrics import extract_imports, resolve, build_stem_map, norm

url = sys.argv[1] if len(sys.argv) > 1 else "https://github.com/koajs/koa"
tmp = tempfile.mkdtemp(prefix="pf-resolve-")
try:
    path = os.path.join(tmp, "repo")
    git.Repo.clone_from(url, path, depth=1)
    repo = git.Repo(path)
    tree = repo.head.commit.tree
    files = []
    contents = {}
    for entry in tree.traverse():
        if entry.type == "blob":
            ext = os.path.splitext(entry.path)[1]
            if ext in (".js", ".ts", ".py"):
                files.append(entry.path)
                contents[entry.path] = entry.data_stream.read().decode("utf-8", "replace")
    stem = build_stem_map(files)
    print(f"source files: {len(files)}")
    total_edges = 0
    for p, code in contents.items():
        ext = os.path.splitext(p)[1]
        resolved = []
        for kind, spec, names in extract_imports(ext, code):
            for r in resolve(kind, spec, p, stem, names):
                if r not in resolved:
                    resolved.append(r)
        total_edges += len(resolved)
        if resolved:
            print(f"{p}: {resolved}")
    print(f"total internal edges: {total_edges}")
    repo.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)
