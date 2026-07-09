"""Gitignore-syntax ignore rules: `.gitignore` + `.eapignore` at the root.

Both files use gitignore syntax: blank lines and ``#`` comments are skipped,
``!`` negates, a trailing ``/`` restricts a pattern to directories, ``*`` and
``?`` never cross a ``/``, ``**`` does, and a pattern containing a ``/`` is
anchored to the root while a bare name matches at any depth. The two files are
merged with ``.eapignore`` evaluated LAST, so its patterns win on conflict.
Within the merged list the last matching pattern wins — the same rule git
applies. These rules run on top of graph.DEFAULT_IGNORE (which always prunes
first), so a negation can never re-include `.git`, `node_modules`, etc.
"""

# eap-lean: root-level ignore files only (no per-subdirectory .gitignore
# scoping) — upgrade path: collect rules per directory during the walk if
# nested ignore files show up in real trees.

from __future__ import annotations

import os
import re

IGNORE_FILES = (".gitignore", ".eapignore")  # .eapignore last: wins conflicts


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


def _compile(line: str) -> tuple[bool, bool, re.Pattern] | None:
    """One gitignore line -> (negated, dir_only, regex), or None to skip."""
    if not line or line.startswith("#"):
        return None
    negated = line.startswith("!")
    if negated:
        line = line[1:]
    dir_only = line.endswith("/")
    line = line.rstrip("/")
    if not line:
        return None
    anchored = "/" in line  # a slash anywhere anchors the pattern to the root
    line = line.lstrip("/")
    try:
        rx = re.compile(
            ("" if anchored else r"(?:.*/)?") + _glob_regex(line) + r"\Z")
    except re.error:
        return None  # a malformed pattern is skipped, never a crash
    return negated, dir_only, rx


class IgnoreRules:
    """Merged, ordered gitignore-style rules; last matching pattern wins."""

    def __init__(self, rules: list[tuple[bool, bool, re.Pattern]]):
        self._rules = rules

    def __bool__(self) -> bool:
        return bool(self._rules)

    def ignored(self, rel: str, is_dir: bool) -> bool:
        """True if the root-relative posix path *rel* is ignored.

        The walk prunes ignored directories, so files under them are never
        even tested — which also gives git's "can't re-include under an
        excluded directory" behaviour for free.
        """
        verdict = False
        for negated, dir_only, rx in self._rules:
            if dir_only and not is_dir:
                continue
            if rx.match(rel):
                verdict = not negated
        return verdict


def load_rules(root: str) -> IgnoreRules:
    """Parse `.gitignore` then `.eapignore` at *root* into merged rules.

    A missing or unreadable file contributes nothing; the result is usable
    (and empty) even when neither file exists.
    """
    rules: list[tuple[bool, bool, re.Pattern]] = []
    for fname in IGNORE_FILES:
        try:
            with open(os.path.join(root, fname), encoding="utf-8",
                      errors="replace") as fh:
                lines = fh.read().splitlines()
        except OSError:
            continue
        for raw in lines:
            compiled = _compile(raw.rstrip())
            if compiled is not None:
                rules.append(compiled)
    return IgnoreRules(rules)
