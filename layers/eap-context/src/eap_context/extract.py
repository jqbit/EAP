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
  .rs                  — Rust, conservative line-anchored regexes
  .java                — Java, conservative line-anchored regexes
  .c .h .cpp .cc .cxx .hpp .hh .hxx — C/C++, conservative line-anchored regexes
  .cs                  — C#, conservative line-anchored regexes
  .rb                  — Ruby, conservative line-anchored regexes
  .php                 — PHP, conservative line-anchored regexes

Every regex extractor follows the same discipline as the JS/Go pair: patterns
are ``^``-anchored per line (``re.M``), inter-token whitespace is confined to
``[ \\t]`` (never ``\\s``, which crosses newlines), captures are single bounded
tokens with no two adjacent unbounded quantifiers over an overlapping class, and
minified/oversized lines are neutralized up front — so extraction stays
provably linear-time (no catastrophic backtracking) on adversarial input.

Binary files (NUL byte in the head) and files over MAX_FILE_BYTES are skipped.
"""

from __future__ import annotations

import ast
import bisect
import hashlib
import os
import re

MAX_FILE_BYTES = 1_000_000  # skip anything larger; source files this big are generated
MAX_LINE_BYTES = 2_000  # skip minified/generated lines before running any regex extractor

CODE_EXTENSIONS = {
    ".py",
    ".js", ".mjs", ".jsx", ".ts", ".tsx",
    ".go",
    ".rs",
    ".java",
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
    ".cs",
    ".rb",
    ".php",
}

_C_FAMILY_EXTS = {".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"}
_JS_EXTS = {".js", ".mjs", ".jsx", ".ts", ".tsx"}

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
    return _extract_from_bytes(raw, ext, rel)


def extract_file_hashed(path: str, rel: str | None = None) -> tuple[list[dict], str, int]:
    """Like ``extract_file`` but also returns a content sha256 and byte size.

    Used by incremental indexing to fingerprint a file in the same single read
    that extracts it. Returns ``(symbols, sha256_hex, size)``; for an
    oversized/unreadable file the symbols are ``[]`` and the sha is ``""`` (an
    oversized file is never read, only stat-sized, so it cannot be hashed).
    """
    rel = rel if rel is not None else path
    ext = os.path.splitext(path)[1].lower()
    if ext not in CODE_EXTENSIONS:
        return [], "", 0
    try:
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            return [], "", size  # never read a huge/generated file
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return [], "", 0
    sha = hashlib.sha256(raw).hexdigest()
    return _extract_from_bytes(raw, ext, rel), sha, len(raw)


def _extract_from_bytes(raw: bytes, ext: str, rel: str) -> list[dict]:
    """Dispatch already-read bytes to the per-language extractor."""
    if b"\x00" in raw[:8192]:  # binary sniff
        return []
    text = raw.decode("utf-8", errors="replace")
    if ext == ".py":
        return _extract_python(text, rel)
    if ext in _JS_EXTS:
        return _extract_js(text, rel)
    if ext == ".go":
        return _extract_go(text, rel)
    if ext == ".rs":
        return _extract_rust(text, rel)
    if ext == ".java":
        return _extract_java(text, rel)
    if ext in _C_FAMILY_EXTS:
        return _extract_c_family(text, rel)
    if ext == ".cs":
        return _extract_csharp(text, rel)
    if ext == ".rb":
        return _extract_ruby(text, rel)
    if ext == ".php":
        return _extract_php(text, rel)
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


def _find_import_specs(text: str, regex, guards=("'", '"')) -> list[tuple[int, str]]:
    """Line-scan *text* for import/require/include specs, cheapest checks first.

    Skips lines lacking any *guards* character (an import spec is always quoted
    or bracketed) and lines over ``MAX_LINE_BYTES`` before ever running *regex*,
    so a pathological line can neither match nor cost anything. *regex* only ever
    runs on a single sub-``MAX_LINE_BYTES`` line, so even an unanchored pattern
    stays linear. Returns (absolute_offset, spec) pairs.
    """
    specs: list[tuple[int, str]] = []
    offset = 0
    for line in text.split("\n"):
        if len(line) <= MAX_LINE_BYTES and any(g in line for g in guards):
            for m in regex.finditer(line):
                specs.append((offset + m.start(), m.group(1)))
        offset += len(line) + 1  # + 1 for the '\n' consumed by split
    return specs


def _anchored_specs(text: str, regex) -> list[tuple[int, str]]:
    """Collect (offset, spec) for a ``^``-anchored, backtracking-free import
    regex run over the whole (already-``_scannable``-guarded) text.

    Used for namespace-style imports (Rust ``use``, Java ``import``, C# ``using``,
    PHP ``use``) whose capture is a single bounded ``[\\w.:\\\\]``-class token, so
    finditer over the full text is linear with no per-line pre-filter needed.
    """
    return [(m.start(), m.group(1)) for m in regex.finditer(text)]


def _newline_offsets(text: str) -> list[int]:
    """Byte offsets of every '\\n' in *text*, computed once via C-level find."""
    out: list[int] = []
    idx = text.find("\n")
    while idx != -1:
        out.append(idx)
        idx = text.find("\n", idx + 1)
    return out


def _line_at(newlines: list[int], pos: int) -> int:
    """1-based line for byte offset *pos*, via bisect over precomputed newline
    offsets — O(log n) per lookup. The old ``text.count("\\n", 0, pos)`` was
    O(pos) and summed to O(n^2) across a file's symbols (a ~1MB file with a large
    import block stalled extraction ~20s)."""
    return bisect.bisect_left(newlines, pos) + 1


def _module_ref(spec: str) -> str:
    """'./lib/web-utils.js' -> 'web-utils'; '@scope/pkg' -> 'pkg'."""
    base = spec.rstrip("/").rsplit("/", 1)[-1]
    return os.path.splitext(base)[0] or spec


def _last_segment(spec: str, sep: str) -> str:
    """Last non-empty, non-'*' segment of a *sep*-separated namespace path.

    'std::collections::HashMap' -> 'HashMap'; 'std::collections::' -> 'collections'
    (a trailing '::' from a `use a::b::{...}` group brace); 'java.util.*' -> 'util'.
    """
    parts = [p for p in spec.split(sep) if p and p != "*"]
    return parts[-1] if parts else spec


def _colon_ref(spec: str) -> str:
    return _last_segment(spec, "::")


def _dot_ref(spec: str) -> str:
    return _last_segment(spec, ".")


def _backslash_ref(spec: str) -> str:
    return _last_segment(spec, "\\")


def _refs_in_slice(chunk: str, keywords: frozenset, own: str) -> list[str]:
    refs = []
    for m in _CALL_RE.finditer(chunk):
        name = m.group(1)
        if name not in keywords and name != own:
            refs.append(name)
    return refs


def _extract_regex_lang(text: str, rel: str, defs, import_specs, keywords,
                        module_ref=_module_ref) -> list[dict]:
    newlines = _newline_offsets(text)  # computed once; line lookups are O(log n)
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
            "line": _line_at(newlines, pos),
            "refs": sorted(set(refs)),
        })
    for pos, spec in import_specs:
        ref = module_ref(spec)
        symbols.append({
            "name": ref,
            "kind": "import",
            "file": rel,
            "line": _line_at(newlines, pos),
            "refs": [ref],
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


# ---------------------------------------------------------------------------
# Shared regex-extractor discipline for the languages below
# ---------------------------------------------------------------------------
# Every def pattern is `^`-anchored (`re.M`); a modifier prefix, when present, is
# `(?:KEYWORD[ \t]+)*` — a star of a keyword-then-fixed-whitespace concatenation,
# which is linear (each iteration consumes a full token, and the following literal
# differs from the keyword class, so there is no `a*a*`/`(a+)+` ambiguity). Every
# capture is a single bounded identifier token. Namespace `use`/`import`/`using`
# specs are captured with a single `[\w.:\\]`-class token (no whitespace inside),
# so `_anchored_specs` over the whole text is linear; quoted/bracketed includes
# and requires go through `_find_import_specs` (guarded, per-line, sub-line).


# ---------------------------------------------------------------------------
# Rust — conservative regex
# ---------------------------------------------------------------------------

_RUST_KEYWORDS = frozenset(
    "as break const continue crate dyn else enum extern false fn for if impl in "
    "let loop match mod move mut pub ref return self Self static struct super "
    "trait true type unsafe use where while async await where box "
    "Some None Ok Err Vec String str vec println print format panic assert "
    "assert_eq write writeln matches".split()
)

_RUST_DEFS = [
    ("function", re.compile(
        r"^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?(?:default[ \t]+)?(?:const[ \t]+)?"
        r"(?:async[ \t]+)?(?:unsafe[ \t]+)?(?:extern[ \t]+\"[^\"\n]*\"[ \t]+)?"
        r"fn[ \t]+([A-Za-z_]\w*)", re.M)),
    ("class", re.compile(
        r"^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?struct[ \t]+([A-Za-z_]\w*)", re.M)),
    ("class", re.compile(
        r"^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?enum[ \t]+([A-Za-z_]\w*)", re.M)),
    ("class", re.compile(
        r"^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?trait[ \t]+([A-Za-z_]\w*)", re.M)),
]

# `use a::b::c;` / `use a::b::{c, d};` — capture the leading `::`-path token only
# (bounded `[\w:]` class, no whitespace); `_colon_ref` keeps its last real segment.
_RUST_USE = re.compile(r"^[ \t]*(?:pub[ \t]+)?use[ \t]+([A-Za-z_][\w:]*)", re.M)


def _extract_rust(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = _anchored_specs(text, _RUST_USE)
    return _extract_regex_lang(text, rel, _RUST_DEFS, imports, _RUST_KEYWORDS,
                               module_ref=_colon_ref)


# ---------------------------------------------------------------------------
# Java — conservative regex
# ---------------------------------------------------------------------------

_JAVA_KEYWORDS = frozenset(
    "if for while switch catch return new throw throws try do else instanceof "
    "super this void int long short byte char float double boolean class "
    "interface enum extends implements import package public private protected "
    "static final abstract synchronized native default assert break continue "
    "case System String Integer Object List Map".split()
)

# A class/type declaration, with any run of Java modifiers first.
_JAVA_CLASS = re.compile(
    r"^[ \t]*(?:(?:public|private|protected|abstract|final|static|sealed|"
    r"non-sealed|strictfp)[ \t]+)*(?:class|interface|enum|record)[ \t]+"
    r"([A-Za-z_]\w*)", re.M)
# A method/constructor: at least one modifier, an optional single-token return
# type, then `name(`. Requiring a modifier keeps `if (`/`return foo(` out. The
# return-type token has no whitespace in its class, so it cannot overlap the
# `[ \t]+` before the name.
_JAVA_METHOD = re.compile(
    r"^[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized|"
    r"native|default|strictfp)[ \t]+)+(?:[A-Za-z_][\w<>\[\].]*[ \t]+)?"
    r"([A-Za-z_]\w*)[ \t]*\(", re.M)
_JAVA_DEFS = [("class", _JAVA_CLASS), ("method", _JAVA_METHOD)]

# `import java.util.List;` / `import static java.lang.Math.PI;` / `import a.b.*;`
_JAVA_IMPORT = re.compile(
    r"^[ \t]*import[ \t]+(?:static[ \t]+)?([A-Za-z_][\w.]*(?:\.\*)?)", re.M)


def _extract_java(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = _anchored_specs(text, _JAVA_IMPORT)
    return _extract_regex_lang(text, rel, _JAVA_DEFS, imports, _JAVA_KEYWORDS,
                               module_ref=_dot_ref)


# ---------------------------------------------------------------------------
# C / C++ — conservative regex
# ---------------------------------------------------------------------------

_C_KEYWORDS = frozenset(
    "if for while switch return sizeof typeof do else goto case break continue "
    "struct union enum class namespace template typename public private protected "
    "static const volatile inline extern void int char long short float double "
    "unsigned signed bool auto new delete typedef using operator throw catch try "
    "printf malloc free memcpy memset strlen strcmp".split()
)

# A function DEFINITION/declaration at column 0 (definitions and top-level
# prototypes are unindented; bodies are indented, keeping call-sites out). A
# leading reject list drops control-flow / declaration keywords so `if (…)` or
# `struct Foo bar(` are not read as functions. `(?:word[ \t*&]+)+` (return-type
# words, with pointer `*`/`&` folded into the separator) is a linear
# star-of-concatenation, and the name token `[A-Za-z_]` is non-space so it cannot
# overlap the preceding separator — there are deliberately no two adjacent
# whitespace-consuming groups (an earlier `(?:word[ \t]+)+[*&\t ]*name` form went
# O(n^2) on `int` + a long space run with no name). The name may carry a C++
# `Class::` qualifier.
_C_FUNC = re.compile(
    r"^(?!(?:return|if|while|for|switch|else|do|case|goto|sizeof|typedef|struct|"
    r"class|enum|union|namespace|template|using|public|private|protected|extern"
    r")\b)(?:[A-Za-z_]\w*[ \t*&]+)+([A-Za-z_][\w:]*)[ \t]*\(", re.M)
_C_CLASS = re.compile(r"^[ \t]*(?:class|struct)[ \t]+([A-Za-z_]\w*)", re.M)
_C_FAMILY_DEFS = [("function", _C_FUNC), ("class", _C_CLASS)]

# `#include <stdio.h>` / `#include "local.h"` — path-style spec, resolved by
# `_module_ref` (basename without extension). Guarded on `<`/`"` per line.
_C_INCLUDE = re.compile(r'^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\n]+)[>"]', re.M)


def _extract_c_family(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = _find_import_specs(text, _C_INCLUDE, guards=("<", '"'))
    return _extract_regex_lang(text, rel, _C_FAMILY_DEFS, imports, _C_KEYWORDS)


# ---------------------------------------------------------------------------
# C# — conservative regex
# ---------------------------------------------------------------------------

_CS_KEYWORDS = frozenset(
    "if for foreach while switch return new throw try catch finally using "
    "namespace class interface struct enum record public private protected "
    "internal static virtual override abstract sealed async await void var "
    "int long string bool double float object base this params ref out get set "
    "Console String List Dictionary".split()
)

_CS_CLASS = re.compile(
    r"^[ \t]*(?:(?:public|private|protected|internal|abstract|sealed|static|"
    r"partial|readonly|unsafe)[ \t]+)*(?:class|interface|struct|enum|record)"
    r"[ \t]+([A-Za-z_]\w*)", re.M)
_CS_METHOD = re.compile(
    r"^[ \t]*(?:(?:public|private|protected|internal|static|virtual|override|"
    r"abstract|async|sealed|extern|unsafe|new|partial)[ \t]+)+"
    r"(?:[A-Za-z_][\w<>\[\].,]*[ \t]+)?([A-Za-z_]\w*)[ \t]*\(", re.M)
_CS_DEFS = [("class", _CS_CLASS), ("method", _CS_METHOD)]

# `using System.Collections.Generic;` / `using static X;` / `using Foo = Bar;`
_CS_USING = re.compile(
    r"^[ \t]*using[ \t]+(?:static[ \t]+)?([A-Za-z_][\w.]*)", re.M)


def _extract_csharp(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = _anchored_specs(text, _CS_USING)
    return _extract_regex_lang(text, rel, _CS_DEFS, imports, _CS_KEYWORDS,
                               module_ref=_dot_ref)


# ---------------------------------------------------------------------------
# Ruby — conservative regex
# ---------------------------------------------------------------------------

_RUBY_KEYWORDS = frozenset(
    "def end class module if elsif else unless while until for in do return "
    "yield begin rescue ensure raise require require_relative attr_accessor "
    "attr_reader attr_writer new self super nil true false and or not then "
    "puts print p lambda proc loop each map".split()
)

_RUBY_DEFS = [
    # `def name` / `def self.name` / `def name?`; the base ref (group 2) is unused
    # here but kept as None via lastindex handling.
    ("method", re.compile(r"^[ \t]*def[ \t]+(?:self\.)?([A-Za-z_]\w*[!?=]?)", re.M)),
    ("class", re.compile(
        r"^[ \t]*class[ \t]+([A-Za-z_]\w*)"
        r"(?:[ \t]*<[ \t]*([A-Za-z_][\w:]*))?", re.M)),
    ("class", re.compile(r"^[ \t]*module[ \t]+([A-Za-z_]\w*)", re.M)),
]

# `require 'foo'` / `require_relative "foo/bar"` — quoted, path-style spec.
_RUBY_REQUIRE = re.compile(
    r"^[ \t]*require(?:_relative)?[ \t]+['\"]([^'\"\n]+)['\"]", re.M)


def _extract_ruby(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = _find_import_specs(text, _RUBY_REQUIRE)
    return _extract_regex_lang(text, rel, _RUBY_DEFS, imports, _RUBY_KEYWORDS)


# ---------------------------------------------------------------------------
# PHP — conservative regex
# ---------------------------------------------------------------------------

_PHP_KEYWORDS = frozenset(
    "if for foreach while switch return new throw try catch finally function "
    "class interface trait extends implements public private protected static "
    "final abstract const var namespace use echo print require require_once "
    "include include_once array list isset empty unset self parent this true "
    "false null and or".split()
)

_PHP_DEFS = [
    ("function", re.compile(
        r"^[ \t]*(?:(?:public|private|protected|static|final|abstract)[ \t]+)*"
        r"function[ \t]+(?:&[ \t]*)?([A-Za-z_]\w*)[ \t]*\(", re.M)),
    ("class", re.compile(
        r"^[ \t]*(?:(?:abstract|final)[ \t]+)*(?:class|interface|trait)[ \t]+"
        r"([A-Za-z_]\w*)(?:[ \t]+extends[ \t]+([A-Za-z_][\w\\]*))?", re.M)),
]

# `use App\Models\User;` / `use A\B as C;` — capture the leading namespace token
# (bounded `[\w\\]` class); `_backslash_ref` keeps its last segment.
_PHP_USE = re.compile(r"^[ \t]*use[ \t]+(?:function[ \t]+)?([A-Za-z_][\w\\]*)", re.M)


def _extract_php(text: str, rel: str) -> list[dict]:
    text = _scannable(text)
    imports = _anchored_specs(text, _PHP_USE)
    return _extract_regex_lang(text, rel, _PHP_DEFS, imports, _PHP_KEYWORDS,
                               module_ref=_backslash_ref)
