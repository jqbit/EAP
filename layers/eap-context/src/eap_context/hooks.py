"""Git-hook auto-rebuild: `hook install` / `hook uninstall`, no daemon.

Writes ``post-commit`` and ``post-checkout`` hooks that run the incremental
rebuild (``build <root> --update``) quietly after every commit/checkout, so the
graph cache never goes stale between agent sessions.

Non-clobbering: a pre-existing hook that is not ours is moved to
``<hook>.pre-eap`` and our script ``exec``s it afterwards (git invokes a hook
with ``$0`` = the hook path, so the chain needs no absolute paths). Uninstall
removes our script and restores the backup. The current interpreter path is
embedded at install time so the hook fires even where ``python3`` is not on
the invoking environment's PATH.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys

HOOK_NAMES = ("post-commit", "post-checkout")
MARKER = "# eap-context-hook"
BACKUP_SUFFIX = ".pre-eap"


def _git_hooks_dir(root: str) -> str | None:
    """The repo's hooks directory, or None when *root* is not a git repo.

    ``rev-parse --git-dir`` (not a bare ``.git`` check) so worktrees and
    ``core.hooksPath``-less clones resolve correctly.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", os.path.abspath(root), "rev-parse", "--git-path", "hooks"],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    path = proc.stdout.strip()
    if not path:
        return None
    return path if os.path.isabs(path) else os.path.join(os.path.abspath(root), path)


def _script(root: str) -> str:
    cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cli.py")
    py, cli_q, root_q = (shlex.quote(sys.executable), shlex.quote(cli),
                         shlex.quote(os.path.abspath(root)))
    return (
        "#!/bin/sh\n"
        f"{MARKER} — installed by `eap_context hook install`; do not edit.\n"
        f"{py} {cli_q} build {root_q} --update >/dev/null 2>&1 || true\n"
        f'if [ -x "$0{BACKUP_SUFFIX}" ]; then exec "$0{BACKUP_SUFFIX}" "$@"; fi\n'
    )


def _is_ours(path: str) -> bool:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return MARKER in fh.read(4096)
    except OSError:
        return False


def install(root: str = ".") -> dict:
    """Install (or refresh) the rebuild hooks. Chains any pre-existing hook."""
    hooks_dir = _git_hooks_dir(root)
    if hooks_dir is None:
        return {"error": f"not a git repository: {os.path.abspath(root)}"}
    os.makedirs(hooks_dir, exist_ok=True)
    installed, chained = [], []
    for name in HOOK_NAMES:
        path = os.path.join(hooks_dir, name)
        if os.path.exists(path) and not _is_ours(path):
            backup = path + BACKUP_SUFFIX
            if os.path.exists(backup):
                return {"error": f"both {name} and {name}{BACKUP_SUFFIX} exist; "
                                 "resolve manually before installing"}
            os.replace(path, backup)
            chained.append(name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(_script(root))
        os.chmod(path, 0o755)
        installed.append(name)
    return {"installed": installed, "chained": chained, "hooks_dir": hooks_dir}


def uninstall(root: str = ".") -> dict:
    """Remove our hooks and restore any chained originals."""
    hooks_dir = _git_hooks_dir(root)
    if hooks_dir is None:
        return {"error": f"not a git repository: {os.path.abspath(root)}"}
    removed, restored = [], []
    for name in HOOK_NAMES:
        path = os.path.join(hooks_dir, name)
        if os.path.exists(path) and _is_ours(path):
            os.remove(path)
            removed.append(name)
        backup = path + BACKUP_SUFFIX
        if os.path.exists(backup) and not os.path.exists(path):
            os.replace(backup, path)
            restored.append(name)
    return {"removed": removed, "restored": restored, "hooks_dir": hooks_dir}
