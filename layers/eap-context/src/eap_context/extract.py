"""Per-file symbol extraction. Python stdlib only.

Each extractor returns a list of symbol dicts:

    {"name": str,          # qualified within the file, e.g. "Store.save"
     "kind": str,          # function | class | method | import
     "file": str,          # path as given (relative when the caller passes one)
     "line": int,          # 1-based definition line
     "refs": [str, ...]}   # bare names this symbol references (calls/bases/modules)

Languages:
  .py                  — ast module (FunctionDef/AsyncFunctionDef/ClassDef/Import/Call)
  .js .mjs .jsx .ts .tsx — conservative line-anchored regexes
  .go                  — conservative line-anchored regexes

Binary files (NUL byte in the head) and files over MAX_FILE_BYTES are skipped.
"""

from __future__ import annotations

import ast
import os
import re

MAX_FILE_BYTES = 1_000_000  # skip anything larger; source files this big are generated
MAX_LINE_BYTES = 2_000  # skip minified/generated lines before running any regex extractor

CODE_EXTENSIONS = {".py", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".go"}

# ---------------------------------------------------------------------------
# public entry point
# ---------------------------------------------------------------------------


def extract_file(path: str, rel: str | None = None) -> list[dict]:
    """Extract symbols from one file. Returns [] for unsupported/binary/huge files."""
    rel = rel if rel is not None else path
    ext = os.path.splitext(path)[1].lower()
    if ext not in CODE_EXTENSIONS:
        return []
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return []
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return []
    if b"\x00" in raw[:8192]:  # binary sniff
        return []
    text = raw.decode("utf-8", errors="replace")
    if ext == ".py":
        return _extract_python(text, rel)
    if ext in {".js", ".mjs", ".jsx", ".ts", ".tsx"}:
        return _extract_js(text, rel)
    if ext == ".go":
        return _extract_go(text, rel)
    return []


# ---------------------------------------------------------------------------
# Python — ast
# ---------------------------------------------------------------------------

_DEF_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def _call_refs(node: ast.AST) -> list[str]:
    """Names referenced by calls/decorators directly under *node*.

    Does not descend into nested function/class definitions — those get their
    own symbols with their own refs.
    """
    refs: list[str] = []
    stack = list(ast.iter_child_nodes(node))
    while stack:
        n = stack.pop()
        if isinstance(n, _DEF_NODES):
            continue  # nested definition: extracted separately
        if isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Name):
                refs.append(f.id)
            elif isinstance(f, ast.Attribute):
                refs.append(f.attr)
        stack.extend(ast.iter_child_nodes(n))
    return refs


def _name_of(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _extract_python(text: str, rel: str) -> list[dict]:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError):
        return []
    symbols: list[dict] = []

    def walk(body: list[ast.stmt], prefix: str, in_class: bool) -> None:
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = f"{prefix}{node.name}" if prefix else node.name
                refs = _call_refs(node)
                refs += [r for r in (_name_of(d) for d in node.decorator_list) if r]
                symbols.append({
                    "name": name,
                    "kind": "method" if in_class else "function",
                    "file": rel,
                    "line": node.lineno,
                    "refs": refs,
                })
                walk(node.body, name + ".", False)
            elif isinstance(node, ast.ClassDef):
                name = f"{prefix}{node.name}" if prefix else node.name
                refs = [r for r in (_name_of(b) for b in node.bases) if r]
                refs += [r for r in (_name_of(d) for d in node.decorator_list) if r]
                symbols.append({
                    "name": name,
                    "kind": "class",
                    "file": rel,
                    "line": node.lineno,
                    "refs": refs,
                })
                walk(node.body, name + ".", True)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    symbols.append({
                        "name": alias.asname or alias.name,
                        "kind": "import",
                        "file": rel,
                        "line": node.lineno,
                        "refs": [alias.name.split(".")[-1]],
                    })
            elif isinstance(node, ast.ImportFrom):
                mod = (node.module or "").split(".")[-1]
                for alias in node.names:
                    refs = [alias.name]
                    if mod:
                        refs.append(mod)
                    symbols.append({
                        "name": alias.asname or alias.name,
                        "kind": "import",
                        "file": rel,
                        "line": node.lineno,
                        "refs": refs,
                    })
            elif hasattr(node, "body") and isinstance(getattr(node, "body"), list):
                # if/try/with/for at top level can hide defs (e.g. TYPE_CHECKING)
                walk(node.body, prefix, in_class)
                for extra in ("orelse", "finalbody", "handlers"):
                    for sub in getattr(node, extra, []) or []:
                        if isinstance(sub, ast.excepthandler):
                            walk(sub.body, prefix, in_class)
                        elif isinstance(sub, ast.stmt):
                            walk([sub], prefix, in_class)

    walk(tree.body, "", False)
    return symbols


# ---------------------------------------------------------------------------
# JS / TS — conservative regex
# ---------------------------------------------------------------------------

_JS_KEYWORDS = frozenset(
    "if for while switch catch return function typeof new delete void await "
    "yield throw do else try in of instanceof super this constructor import "
    "export require console".split()
)

_JS_DEFS = [
    # function name(...) / export default async function name(
    # Whitespace after `function` is confined to `[ \t]` (never crosses a
    # newline) and the generator `*` is an optional group with its own fixed
    # `\*` anchor, so there are never two adjacent unbounded `\s*` groups on the
    # same run — the earlier `function\s*\*?\s*` form backtracked quadratically
    # on `"function" + "\n"*N` (a ReDoS reachable from file contents).
    ("function", re.compile(
        r"^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function[ \t]*(?:\*[ \t]*)?"
        r"([A-Za-z_$][\w$]*)", re.M)),
    # const name = (...) => / const name = x =>
    ("function", re.compile(
        r"^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"
        r"(?:async\s*)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*=>", re.M)),
    # const name = function
    ("function", re.compile(
        r"^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"
        r"(?:async\s+)?function\b", re.M)),
    # class Name extends Base
    ("class", re.compile(
        r"^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+"
        r"([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?", re.M)),
]

# Import-clause tokens ([\w{}$*,]+) are kept DISJOINT from the separating
# whitespace (\s+) so there is no overlapping-quantifier ambiguity: the old
# `[\w{}\s,*$]+?\s+from` had \s in the token class AND as the separator, which
# backtracks quadratically on adversarial input (ReDoS). This form is linear.
_JS_IMPORT = re.compile(
    r"^[ \t]*import\s+(?:[\w{}$*,]+(?:\s+[\w{}$*,]+)*\s+from\s+)?['\"]([^'\"]+)['\"]",
    re.M)
_JS_REQUIRE = re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)")
_CALL_RE = re.compile(r"\b([A-Za-z_$][\w$]*)\s*\(")


def _scannable(text: str) -> str:
    """Return *text* with over-long (minified/generated) lines neutralized.

    Each line longer than ``MAX_LINE_BYTES`` is replaced by an equal-length run
    of spaces, so no extractor regex ever runs across a pathological line while
    byte offsets and line numbers are preserved exactly (same length, same
    ``\\n`` positions). Cheap fast-paths skip the rebuild when nothing is long.
    """
    if len(text) <= MAX_LINE_BYTES:
        return text
    lines = text.split("\n")
    if all(len(ln) <= MAX_LINE_BYTES for ln in lines):
        return text
    return "\n".join(
        (" " * len(ln)) if len(ln) > MAX_LINE_BYTES else ln for ln in lines
    )


def _find_import_specs(text: str, regex) -> list[tuple[int, str]]:
    """Line-scan *text* for import/require specs, cheapest checks first.

    Skips lines with no quote (an import spec is always quoted) and lines over
    ``MAX_LINE_BYTES`` before ever running *regex*, so a pathological line can
    neither match nor cost anything. Returns (absolute_offset, spec) pairs.
    """
    specs: list[tuple[int, str]] = []
    offset = 0
    for line in text.split("\n"):
        if len(line) <= MAX_LINE_BYTES and ("'" in line or '"' in line):
            for m in regex.finditer(line):
                specs.append((offset + m.start(), m.group(1)))
        offset += len(line) + 1  # + 1 for the '\n' consumed by split
    return specs


def _line_at(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _module_ref(spec: str) -> str:
    """'./lib/web-utils.js' -> 'web-utils'; '@scope/pkg' -> 'pkg'."""
    base = spec.rstrip("/").rsplit("/", 1)[-1]
    return os.path.splitext(base)[0] or spec


def _refs_in_slice(chunk: str, keywords: frozenset, own: str) -> list[str]:
    refs = []
    for m in _CALL_RE.finditer(chunk):
        name = m.group(1)
        if name not in keywords and name != own:
            refs.append(name)
    return refs


def _extract_regex_lang(text: str, rel: str, defs, import_specs, keywords) -> list[dict]:
    found: list[tuple[int, str, str, str | None]] = []  # (pos, kind, name, extra_ref)
    for kind, rx in defs:
        for m in rx.finditer(text):
            extra = m.group(2) if (m.lastindex or 1) >= 2 else None
            found.append((m.start(), kind, m.group(1), extra))
    found.sort(key=lambda t: t[0])
    symbols: list[dict] = []
    for i, (pos, kind, name, extra) in enumerate(found):
        end = found[i + 1][0] if i + 1 < len(found) else len(text)
        refs = _refs_in_slice(text[pos:end], keywords, name)
        if extra:
            refs.append(extra.split(".")[-1])
        symbols.append({
            "name": name,
            "kind": kind,
            "file": rel,
            "line": _line_at(text, pos),
            "refs": sorted(set(refs)),
        })
    for pos, spec in import_specs:
        symbols.append({
            "name": _module_ref(spec),
            "kind": "import",
            "file": rel,
            "line": _line_at(text, pos),
            "refs": [_module_ref(spec)],
        })
    return symbols


def _extract_js(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = _find_import_specs(text, _JS_IMPORT)
    imports += _find_import_specs(text, _JS_REQUIRE)
    return _extract_regex_lang(text, rel, _JS_DEFS, imports, _JS_KEYWORDS)


# ---------------------------------------------------------------------------
# Go — conservative regex
# ---------------------------------------------------------------------------

_GO_KEYWORDS = frozenset(
    "if for switch select go defer return func make new len cap append copy "
    "delete panic recover print println close range map chan string int byte "
    "error bool float64 float32 int64 int32 uint uint64 interface struct".split()
)

_GO_DEFS = [
    ("function", re.compile(r"^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(", re.M)),
    ("class", re.compile(r"^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b", re.M)),
]

_GO_IMPORT_ONE = re.compile(r'^import\s+(?:\w+\s+)?"([^"]+)"', re.M)
# Only the block OPENER is a regex; the closing paren is resolved by a linear
# str.find (see _extract_go). The old `^import\s*\(([^)]*)\)` re-attempted an
# unbounded backtracking `([^)]*)` scan at every "import (" start, going
# quadratic on a file of many unterminated "import (" lines (measured: a 180KB
# .go file burned ~11s). Whitespace is confined to `[ \t]` (Go's `import (` is a
# single line).
_GO_IMPORT_BLOCK_START = re.compile(r"^import[ \t]*\(", re.M)
# Anchored per-line with re.M so finditer only re-attempts at line starts (every
# other def/import regex here is `^`-anchored for exactly this reason). The old
# UNANCHORED `(?:\w+\s+)?"..."` let finditer restart the greedy `\w+` alias scan
# at every offset inside a long word-run, going super-linear on a crafted import
# block body (measured: an ~800KB .go file took ~11s; now ~16ms). Whitespace is
# confined to `[ \t]` (an alias and its quoted path are always on one line).
_GO_IMPORT_LINE = re.compile(r'^[ \t]*(?:\w+[ \t]+)?"([^"]+)"', re.M)


def _extract_go(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = [(m.start(), m.group(1)) for m in _GO_IMPORT_ONE.finditer(text)]
    # Resolve each `import ( … )` block with a single forward str.find for the
    # closing paren (C-level, no backtracking), advancing the cursor past each
    # resolved block so tails are never rescanned — linear in file size.
    pos = 0
    while True:
        m = _GO_IMPORT_BLOCK_START.search(text, pos)
        if not m:
            break
        start = m.end()
        close = text.find(")", start)
        if close == -1:
            break  # no closing paren after this opener — stop, don't rescan
        for im in _GO_IMPORT_LINE.finditer(text[start:close]):
            imports.append((start + im.start(), im.group(1)))
        pos = close + 1
    return _extract_regex_lang(text, rel, _GO_DEFS, imports, _GO_KEYWORDS)
