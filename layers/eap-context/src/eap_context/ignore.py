"""Gitignore-syntax ignore rules with subdirectory awareness.

Loads every ``.gitignore`` / ``.eapignore`` under the tree (not just the root).
Patterns are scoped to the directory that declared them (git semantics): a bare
name matches at any depth under that directory; a pattern containing ``/`` is
anchored to that directory. Within the merged list, last match wins.
``.eapignore`` entries are appended after ``.gitignore`` at the same directory
level so project overrides win. Hardcoded ``graph.DEFAULT_IGNORE`` still prunes
first on the walk — a negation can never re-include ``.git`` and friends.
"""

from __future__ import annotations

import os
import re

IGNORE_FILES = (".gitignore", ".eapignore")  # .eapignore last: wins conflicts

# Directories never descended when collecting nested ignore files.
_COLLECT_SKIP = frozenset({
    ".git", "node_modules", ".eap", "dist", "build", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", ".next", "target",
    "vendor", ".tox", "coverage", ".cache",
})


def _glob_regex(pat: str) -> str:
    """Translate one gitignore glob into a regex over a root-relative path."""
    out: list[str] = []
    i, n = 0, len(pat)
    while i < n:
        c = pat[i]
        if c == "*":
            if pat.startswith("**/", i):
                out.append(r"(?:.*/)?")
                i += 3
            elif pat.startswith("**", i):
                out.append(r".*")
                i += 2
            else:
                out.append(r"[^/]*")
                i += 1
        elif c == "?":
            out.append(r"[^/]")
            i += 1
        elif c == "[":
            j = pat.find("]", i + 1)
            if j == -1:
                out.append(re.escape(c))
                i += 1
            else:
                inner = pat[i + 1:j]
                if inner.startswith("!"):
                    inner = "^" + inner[1:]
                out.append("[" + inner.replace("\\", "\\\\") + "]")
                i = j + 1
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)


def _compile(line: str, base: str = "") -> tuple[bool, bool, re.Pattern] | None:
    """One gitignore line scoped under *base* (e.g. ``src/``) -> rule or None.

    *base* is the directory containing the ignore file, as a root-relative
    posix prefix ending in ``/`` (empty for the repo root).
    """
    if not line or line.startswith("#"):
        return None
    negated = line.startswith("!")
    if negated:
        line = line[1:]
    dir_only = line.endswith("/")
    line = line.rstrip("/")
    if not line:
        return None
    anchored = "/" in line  # slash anywhere → relative to the ignore file's dir
    line = line.lstrip("/")
    try:
        body = _glob_regex(line)
        if anchored:
            rx = re.compile("^" + re.escape(base) + body + r"\Z")
        else:
            # bare name: match at any depth under base
            rx = re.compile("^" + re.escape(base) + r"(?:.*/)?" + body + r"\Z")
    except re.error:
        return None
    return negated, dir_only, rx


class IgnoreRules:
    """Merged, ordered gitignore-style rules; last matching pattern wins."""

    def __init__(self, rules: list[tuple[bool, bool, re.Pattern]]):
        self._rules = rules

    def __bool__(self) -> bool:
        return bool(self._rules)

    def ignored(self, rel: str, is_dir: bool) -> bool:
        """True if the root-relative posix path *rel* is ignored."""
        verdict = False
        for negated, dir_only, rx in self._rules:
            if dir_only and not is_dir:
                continue
            if rx.match(rel):
                verdict = not negated
        return verdict


def load_rules(root: str) -> IgnoreRules:
    """Collect ``.gitignore`` / ``.eapignore`` from *root* and all subdirs.

    Walk order is depth-first sorted; within each directory ``.gitignore`` is
    compiled before ``.eapignore``. Deeper directories append after parents, so
    a nested ``.eapignore`` can override an ancestor rule (last match wins).
    """
    root = os.path.abspath(root)
    rules: list[tuple[bool, bool, re.Pattern]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in _COLLECT_SKIP and not d.startswith(".")
            and not os.path.islink(os.path.join(dirpath, d))
        )
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        base = "" if rel_dir == "." else rel_dir + "/"
        for fname in IGNORE_FILES:
            if fname not in filenames:
                continue
            try:
                with open(os.path.join(dirpath, fname), encoding="utf-8",
                          errors="replace") as fh:
                    lines = fh.read().splitlines()
            except OSError:
                continue
            for raw in lines:
                compiled = _compile(raw.rstrip(), base)
                if compiled is not None:
                    rules.append(compiled)
    return IgnoreRules(rules)
