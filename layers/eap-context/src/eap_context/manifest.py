"""Manifest ingest: project dependency files → ``depends_on`` edges.

Parses ``pyproject.toml``, ``package.json``, ``go.mod``, ``Cargo.toml``, and
``requirements.txt`` with the stdlib only (``tomllib`` on 3.11+, tiny TOML
fallback for the tables we need, ``json`` for package.json, line scan for
go.mod / requirements.txt).

Each dependency becomes a synthetic node under the manifest file's module, with
a ``depends_on`` edge. No network resolution — names only.
"""

from __future__ import annotations

import json
import os
import re
import sys

# tomllib is stdlib since 3.11; kept optional so the import surface stays clean.
if sys.version_info >= (3, 11):
    import tomllib as _tomllib
else:  # pragma: no cover
    _tomllib = None

MANIFEST_NAMES = frozenset({
    "pyproject.toml", "package.json", "go.mod", "Cargo.toml", "requirements.txt",
})

_REQ_LINE = re.compile(
    r"^[ \t]*([A-Za-z0-9_.-]+)")
_GO_REQUIRE = re.compile(
    r"^[ \t]*([A-Za-z0-9_.\-/]+)[ \t]+v[0-9]")
_GO_REQUIRE_BLOCK = re.compile(r"^require[ \t]*\(", re.M)


def is_manifest(rel: str) -> bool:
    return os.path.basename(rel) in MANIFEST_NAMES


def extract_manifest(path: str, rel: str) -> list[dict]:
    """Return symbol dicts for dependencies declared in *path*.

    Each symbol: ``{name, kind: "dependency", file, line, refs: [name]}``.
    """
    base = os.path.basename(rel)
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return []
    if b"\x00" in raw[:8192]:
        return []
    text = raw.decode("utf-8", errors="replace")
    if base == "package.json":
        return _from_package_json(text, rel)
    if base == "pyproject.toml":
        return _from_pyproject(text, rel)
    if base == "Cargo.toml":
        return _from_cargo(text, rel)
    if base == "go.mod":
        return _from_go_mod(text, rel)
    if base == "requirements.txt":
        return _from_requirements(text, rel)
    return []


def _syms(names: list[tuple[str, int]], rel: str) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for name, line in names:
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({
            "name": name, "kind": "dependency", "file": rel,
            "line": max(1, line), "refs": [name],
        })
    return out


def _from_package_json(text: str, rel: str) -> list[dict]:
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return []
    if not isinstance(data, dict):
        return []
    names: list[tuple[str, int]] = []
    for key in ("dependencies", "devDependencies", "peerDependencies",
                "optionalDependencies"):
        block = data.get(key)
        if isinstance(block, dict):
            for name in block:
                if isinstance(name, str):
                    names.append((name, 1))
    return _syms(names, rel)


def _load_toml(text: str) -> dict | None:
    if _tomllib is not None:
        try:
            return _tomllib.loads(text)
        except Exception:
            return None
    # eap-lean: tiny table parser for 3.10 — upgrade path: require 3.11+.
    return _naive_toml_tables(text)


def _naive_toml_tables(text: str) -> dict:
    """Pull string-keyed tables of string values from TOML text (stdlib-free)."""
    root: dict = {}
    table: dict = root
    section_re = re.compile(r"^[ \t]*\[([^\]]+)\][ \t]*$")
    kv_re = re.compile(r'^[ \t]*([A-Za-z0-9_.-]+)[ \t]*=[ \t]*"([^"]*)"')
    for line in text.splitlines():
        sm = section_re.match(line)
        if sm:
            parts = sm.group(1).split(".")
            cur = root
            for p in parts:
                cur = cur.setdefault(p, {})
            table = cur if isinstance(cur, dict) else root
            continue
        km = kv_re.match(line)
        if km and isinstance(table, dict):
            table[km.group(1)] = km.group(2)
    return root


def _from_pyproject(text: str, rel: str) -> list[dict]:
    data = _load_toml(text)
    if not data:
        return []
    names: list[tuple[str, int]] = []
    proj = data.get("project") if isinstance(data.get("project"), dict) else {}
    deps = proj.get("dependencies") if isinstance(proj, dict) else None
    if isinstance(deps, list):
        for d in deps:
            if isinstance(d, str):
                names.append((_pep508_name(d), 1))
    opt = proj.get("optional-dependencies") if isinstance(proj, dict) else None
    if isinstance(opt, dict):
        for group in opt.values():
            if isinstance(group, list):
                for d in group:
                    if isinstance(d, str):
                        names.append((_pep508_name(d), 1))
    tool = data.get("tool") if isinstance(data.get("tool"), dict) else {}
    poetry = tool.get("poetry") if isinstance(tool, dict) else None
    if isinstance(poetry, dict):
        for key in ("dependencies", "dev-dependencies"):
            block = poetry.get(key)
            if isinstance(block, dict):
                for name in block:
                    if isinstance(name, str) and name != "python":
                        names.append((name, 1))
    return _syms(names, rel)


def _pep508_name(spec: str) -> str:
    return re.split(r"[<=>!~;[\s]", spec.strip(), maxsplit=1)[0].strip()


def _from_cargo(text: str, rel: str) -> list[dict]:
    data = _load_toml(text)
    if not data:
        return []
    names: list[tuple[str, int]] = []
    for key in ("dependencies", "dev-dependencies", "build-dependencies"):
        block = data.get(key)
        if isinstance(block, dict):
            for name in block:
                if isinstance(name, str):
                    names.append((name, 1))
    return _syms(names, rel)


def _from_go_mod(text: str, rel: str) -> list[dict]:
    names: list[tuple[str, int]] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^[ \t]*require[ \t]+([A-Za-z0-9_.\-/]+)[ \t]+v", line)
        if m:
            names.append((m.group(1).rsplit("/", 1)[-1], i + 1))
            i += 1
            continue
        if _GO_REQUIRE_BLOCK.match(line):
            i += 1
            while i < len(lines) and ")" not in lines[i]:
                mm = _GO_REQUIRE.match(lines[i])
                if mm:
                    names.append((mm.group(1).rsplit("/", 1)[-1], i + 1))
                i += 1
        i += 1
    return _syms(names, rel)


def _from_requirements(text: str, rel: str) -> list[dict]:
    names: list[tuple[str, int]] = []
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("-"):
            continue
        m = _REQ_LINE.match(s)
        if m:
            names.append((m.group(1), i))
    return _syms(names, rel)
