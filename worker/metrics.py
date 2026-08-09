"""Per-file static analysis for the Wayfinder worker.

Scoped to JavaScript/TypeScript and Python (v1). Two deliberate, documented
simplifications:
  * Imports are extracted with a lightweight regex scanner, not a full parser.
    We strip comments first and accept rare over/under-matches on unusual
    multi-line syntax. Cross-file type resolution is out of scope entirely.
  * For JS/TS, cyclomatic complexity is a *proxy* (branch keywords + functions +
    LOC). Python files get real cyclomatic complexity via radon. We say this
    plainly in the UI rather than overclaiming precision.
"""
import os
import posixpath
import re
from collections import defaultdict

from radon.complexity import cc_visit

SOURCE_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx", ".py"}

# Directories/components that are never analyzed.
SKIP_COMPONENTS = {
    "node_modules", "vendor", "dist", "build", "out", ".next", ".git",
    "__pycache__", ".venv", "venv", "coverage", "bower_components",
    "minified", "third_party", "libs", "static", "public", "assets",
    "examples", "example", "fixtures", "fonts", "images",
    "benchmarks", "docs", "spec", "tools",
}
SKIP_FILE_PATTERNS = (r"\.min\.js$", r"\.d\.ts$", r"\.lock$", r"\.map$")

JS_IMPORT_PATTERNS = [
    # import ... from '<spec>'  ([\s\S]{0,300}? tolerates multi-line import bodies)
    re.compile(r"""\bimport[\s\S]{0,300}?from\s+['"]([^'"]+)['"]"""),
    # import '<spec>' (side-effect only)
    re.compile(r"""\bimport\s+['"]([^'"]+)['"]"""),
    # dynamic import('<spec>')
    re.compile(r"""\bimport\s*\(\s*['"]([^'"]+)['"]"""),
    # require('<spec>')
    re.compile(r"""\brequire\s*\(\s*['"]([^'"]+)['"]"""),
]

JS_FUNC_RE = re.compile(r"""\b(function\s+[A-Za-z0-9_$]+|=>|class\s+[A-Za-z0-9_$]+|async\s+function)""")
JS_BRANCH_RE = re.compile(r"""\b(if|for|while|switch|catch|case|&&|\|\||\?)\b""")

PY_FROM_MODULE_RE = re.compile(r"""^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+""")
PY_FROM_RELATIVE_RE = re.compile(r"""^\s*from\s+(\.+[\w.]*)\s+import\s+(.+)$""")
PY_IMPORT_RE = re.compile(r"""^\s*import\s+([A-Za-z_][\w.]*)""")

# Roughly how big a file must be before we bother scoring it (keeps onboarding
# lists clean and analysis fast).
MAX_FILE_BYTES = 500 * 1024


def should_skip_path(path):
    parts = path.split("/")
    if any(part in SKIP_COMPONENTS for part in parts):
        return True
    return any(re.search(p, path) for p in SKIP_FILE_PATTERNS)


def _strip_js_comments(code):
    """Remove // and /* */ comments, keeping string contents intact so import
    specifiers survive. Not robust against comments *inside* strings, which is
    rare enough for the scan to tolerate."""
    no_line = re.sub(r"""//[^\n]*""", "", code)
    no_block = re.sub(r"""/\*.*?\*/""", "", no_line, flags=re.S)
    return no_block


def extract_imports_js(code):
    code = _strip_js_comments(code)
    specs = []
    for pattern in JS_IMPORT_PATTERNS:
        for m in pattern.finditer(code):
            spec = m.group(1)
            if spec and spec not in specs:
                specs.append(spec)
    return specs


def extract_imports_py(code):
    """Return a list of (kind, spec, names) triples.

    kinds:
      "js"      -> JS/TS bare/relative specifier (names=None)
      "py_abs"  -> absolute Python module, e.g. "requests.utils" (names=None)
      "py_rel"  -> relative Python import. `spec` is the dotted-relative part
                   (".", "..", ".utils"); `names` is the list of imported names
                   when spec is purely dots (e.g. `from . import a, b`).
    """
    items = []
    for line in code.splitlines():
        line = re.split(r"""\s+#""", line, maxsplit=1)[0]
        m = PY_FROM_MODULE_RE.match(line)
        if m:
            items.append(("py_abs", m.group(1), None))
            continue
        m = PY_FROM_RELATIVE_RE.match(line)
        if m:
            rel = m.group(1)
            names_part = m.group(2).replace("(", " ").replace(")", " ").split(",")
            names = [n.strip().split()[0] for n in names_part if n.strip()]
            use_names = rel.lstrip(".") == ""
            items.append(("py_rel", rel, names if use_names else None))
            continue
        m = PY_IMPORT_RE.match(line)
        if m:
            items.append(("py_abs", m.group(1), None))
    return items


def extract_imports(ext, code):
    if ext == ".py":
        return extract_imports_py(code)
    return [("js", s, None) for s in extract_imports_js(code)]


def norm(p):
    """Normalize a repo path to forward slashes (git convention). Critical on
    Windows, where os.path would otherwise emit backslashes and break path
    matching against git's tree paths."""
    return posixpath.normpath(p.replace("\\", "/"))


def build_stem_map(repo_files):
    """Map 'path/without/ext' -> [full relative paths] for fuzzy import resolution."""
    stem_map = defaultdict(list)
    for p in repo_files:
        stem_map[os.path.splitext(p)[0]].append(p)
    return stem_map


def _candidates_for(rel, stem_map):
    """All repo paths a normalized import target `rel` could refer to. Handles
    specifiers both with and without an explicit extension (modern ESM repos
    write `import x from './x.js'`; classic ones write `require('./x')`), plus
    index/__init__ resolution."""
    cands = []
    rel_stem = os.path.splitext(rel)[0]
    for key in (rel, rel_stem):
        if key in stem_map:
            cands += stem_map[key]
    for idx_name in ("index", "__init__"):
        idx = norm(rel_stem + "/" + idx_name)
        if idx in stem_map:
            cands += stem_map[idx]
    return cands


def resolve_import(spec, importer_path, stem_map):
    """Resolve an import specifier to an in-repo source file path, or None if
    it points outside the repo (external package, stdlib, URL, ...).

    Resolves: relative specifiers (./x, ../y, ./.z.ext) and, for Python,
    absolute package imports that clearly match top-level modules. JS/TS bare
    specifiers are treated as external, with one concession for '@/' style
    aliases common in Next.js repos."""
    importer_dir = posixpath.dirname(importer_path) or "."

    if spec.startswith("."):
        rel = norm(posixpath.join(importer_dir, spec))
    else:
        if spec.startswith("node:") or spec.startswith("http"):
            return None
        if spec.startswith("@"):
            rest = spec.lstrip("@")
            # '@/' aliases a source dir (commonly 'src/'); also try root-relative.
            for cand in (norm(posixpath.join("src", rest)), norm(rest)):
                if _candidates_for(cand, stem_map):
                    rel = cand
                    break
            else:
                return None
        else:
            rel = norm(spec.replace(".", "/"))
            if not _candidates_for(rel, stem_map):
                return None

    candidates = _candidates_for(rel, stem_map)

    # Prefer a source extension; otherwise fall back to any resolved file.
    for c in candidates:
        if os.path.splitext(c)[1] in SOURCE_EXTENSIONS:
            return c
    return candidates[0] if candidates else None


def resolve_import_py(kind, spec, importer_path, stem_map, names):
    """Resolve Python import triples from extract_imports_py to repo file paths."""
    if kind == "py_abs":
        rel = norm(spec.replace(".", "/"))
        # Try root-relative and src-layout ("requests.utils" -> src/requests/utils).
        for base in (rel, norm(posixpath.join("src", rel))):
            cands = _candidates_for(base, stem_map)
            if cands:
                return [cands[0]]
        return []

    # py_rel: spec is ".", "..", ".utils", ... relative to the importer's package.
    dots = len(spec) - len(spec.lstrip("."))
    tail = spec[dots:]
    parts = [p for p in importer_path.split("/") if p]
    base_dir = parts[:-1]
    pkg_dir = base_dir if dots <= 1 else base_dir[:-(dots - 1)]
    pkg = "/".join(pkg_dir)

    if tail:
        candidates = [norm(pkg + "/" + tail)]
    else:
        candidates = [norm(pkg + "/" + n) for n in (names or [])]

    out = []
    for rel in candidates:
        cands = _candidates_for(rel, stem_map)
        if cands:
            out.append(cands[0])
    return out


def resolve(kind, spec, importer_path, stem_map, names=None):
    """Dispatch to the right resolver for a (kind, spec, names) import triple."""
    if kind == "js":
        target = resolve_import(spec, importer_path, stem_map)
        return [target] if target else []
    return resolve_import_py(kind, spec, importer_path, stem_map, names)


def compute_complexity(ext, code, loc, function_count, import_count):
    """complexity_score for one file.

    Python: sum of real cyclomatic complexity over all functions (radon).
    JS/TS: documented proxy = branch keywords + function count + import count
    + one point per ~20 LOC, weighted so function-heavy / branchy code scores
    higher."""
    if ext == ".py":
        try:
            total = sum(b.complexity for b in cc_visit(code))
            if total > 0:
                return total
        except Exception:
            pass
        return function_count + import_count + max(1, loc // 20)

    branches = len(JS_BRANCH_RE.findall(code))
    return branches + function_count + import_count + max(1, loc // 20)


def analyze_file(path, ext, code, repo_files, stem_map):
    """Produce the per-file metrics dict for one commit sample."""
    imports_info = extract_imports(ext, code)
    resolved = []
    for kind, spec, names in imports_info:
        for target in resolve(kind, spec, path, stem_map, names):
            if target not in resolved:
                resolved.append(target)

    lines = code.splitlines()
    loc = sum(1 for ln in lines if ln.strip())

    if ext == ".py":
        function_count = len(re.findall(r"""^\s*(?:def|async\s+def)\s+\w+""", code, re.M))
    else:
        function_count = len(JS_FUNC_RE.findall(_strip_js_comments(code)))

    return {
        "path": path,
        "loc": loc,
        "complexity_score": compute_complexity(ext, code, loc, function_count, len(imports_info)),
        "import_count": len(imports_info),
        "imports": resolved,
        "function_count": function_count,
    }
