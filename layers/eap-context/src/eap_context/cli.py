"""CLI for manual use.

    PYTHONPATH=layers/eap-context/src python3 -m eap_context build <dir>
    PYTHONPATH=layers/eap-context/src python3 -m eap_context query "text" [--root DIR]
    PYTHONPATH=layers/eap-context/src python3 -m eap_context stats|godnodes|neighbors|serve
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Run either as a module (`python3 -m eap_context …`, the documented form) or as
# a plain script (`python3 .../eap_context/cli.py`); bootstrap the package
# context in the latter so the relative imports below resolve.
if __package__ in (None, ""):  # pragma: no cover
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "eap_context"

from . import algorithms as alg_mod
from . import export as export_mod
from . import graph as graph_mod
from . import hooks as hooks_mod
from . import mcp as mcp_mod
from . import prs as prs_mod
from . import query as query_mod
from . import reflect as reflect_mod
from .query import DEFAULT_DEPTH, DEFAULT_LIMIT


def _load(root: str, rebuild: bool = False):
    return graph_mod.load_or_build(root, rebuild=rebuild)


def cmd_build(args) -> int:
    g, path = graph_mod.build_and_save(args.dir, incremental=args.update)
    s = query_mod.stats(g)
    mode = "updated" if args.update else "built"
    print(f"{mode} {s['nodes']} nodes / {s['edges']} edges "
          f"from {s['files']} files -> {path}")
    return 0


def cmd_query(args) -> int:
    g = _load(args.root)
    result = query_mod.query(g, args.text, depth=args.depth, limit=args.limit,
                             degree_cap=args.degree_cap,
                             tags=reflect_mod.load_tags(args.root),
                             mode=getattr(args, "mode", "bfs"),
                             token_budget=getattr(args, "token_budget", None))
    reflect_mod.log_query(args.root, "query",
                          {"query": args.text, "depth": args.depth,
                           "limit": args.limit}, result)
    if args.json:
        print(json.dumps(result, indent=1))
        return 0
    print(f"query: {result['query']}  (depth={result['depth']} "
          f"limit={result['limit']} cap={result['degree_cap']} "
          f"mode={result.get('mode', 'bfs')})")
    print(f"nodes: {len(result['nodes'])}  edges: {len(result['edges'])}"
          + ("  [truncated]" if result["truncated"] else ""))
    for p in result["pointers"]:
        print(f"  {p}")
    return 0


def cmd_stats(args) -> int:
    print(json.dumps(query_mod.stats(_load(args.root)), indent=1))
    return 0


def cmd_godnodes(args) -> int:
    for n in query_mod.god_nodes(_load(args.root), top=args.top):
        print(f"  {n['degree']:>4}  {n['name']} [{n['kind']}]  {n['pointer']}")
    return 0


def cmd_neighbors(args) -> int:
    result = query_mod.neighbors(
        _load(args.root), args.node, args.direction,
        mode=getattr(args, "mode", "bfs"),
        depth=getattr(args, "depth", 1),
        limit=getattr(args, "limit", DEFAULT_LIMIT))
    if result.get("node") is None:
        print(result.get("error", "not found"), file=sys.stderr)
        return 1
    node = result["node"]
    print(f"{node['name']} [{node['kind']}] degree={node['degree']}  {node['pointer']}")
    for e in result["neighbors"]:
        if "direction" in e:
            print(f"  {e['direction']} {e['name']} [{e.get('relation', '')}/"
                  f"{e.get('provenance', '')}]  {e['pointer']}")
        else:
            print(f"  {e['name']} [{e['kind']}]  {e['pointer']}")
    return 0


def cmd_explain(args) -> int:
    result = query_mod.explain(_load(args.root), args.node, root=args.root)
    if args.json:
        print(json.dumps(result, indent=1))
        return 1 if result.get("node") is None else 0
    if result.get("node") is None:
        print(result.get("error", "not found"), file=sys.stderr)
        return 1
    node = result["node"]
    print(f"{node['name']} [{node['kind']}] degree={node['degree']}  "
          f"{node['pointer']}")
    for w in result.get("why") or []:
        print(f"  why: {w}")
    for c in result.get("callers") or []:
        print(f"  caller  {c}")
    for c in result.get("callees") or []:
        print(f"  callee  {c}")
    return 0


def cmd_export(args) -> int:
    g = _load(args.root)
    out = args.output
    fmt = args.format
    if fmt == "graphml":
        path = export_mod.export_graphml(g, out)
    elif fmt == "svg":
        path = export_mod.export_svg(g, out, max_nodes=args.max_nodes)
    else:
        path = export_mod.export_html(g, out, max_nodes=args.max_nodes)
    print(path)
    return 0


def cmd_merge_graphs(args) -> int:
    graphs = []
    for d in args.dirs:
        graphs.append(graph_mod.load_or_build(d))
    merged = export_mod.merge_graphs(graphs, namespace_by_root=not args.no_prefix)
    if args.global_name:
        path = export_mod.save_global(merged, args.global_name)
    else:
        path = graph_mod.save(merged, args.output)
    print(f"merged {len(graphs)} graphs -> {path} "
          f"({len(merged.nodes)} nodes / {len(merged.edges)} edges)")
    return 0


def cmd_watch(args) -> int:
    """Poll mtimes and run incremental rebuild when sources change."""
    import time
    root = os.path.abspath(args.root)
    interval = max(1.0, float(args.interval))
    print(f"watching {root} every {interval:.0f}s (Ctrl-C to stop)",
          file=sys.stderr)
    last = None
    try:
        while True:
            stamp = _tree_mtime_stamp(root)
            if stamp != last:
                g, path = graph_mod.build_and_save(root, incremental=True)
                s = query_mod.stats(g)
                print(f"updated {s['nodes']} nodes / {s['edges']} edges -> {path}",
                      flush=True)
                last = stamp
            time.sleep(interval)
    except KeyboardInterrupt:
        print("stopped", file=sys.stderr)
        return 0


def _tree_mtime_stamp(root: str) -> tuple:
    """Cheap fingerprint: sorted (rel, mtime_ns, size) for source+manifest files."""
    rows = []
    for abspath, rel in graph_mod.iter_source_files(root):
        try:
            st = os.stat(abspath)
            rows.append((rel, st.st_mtime_ns, st.st_size))
        except OSError:
            continue
    rows.sort()
    return tuple(rows)


def cmd_path(args) -> int:
    result = alg_mod.shortest_path(_load(args.root), args.source, args.target)
    if args.json:
        print(json.dumps(result, indent=1))
        return 0
    if not result.get("found"):
        print(result.get("error", "no path"), file=sys.stderr)
        return 1
    print(f"path ({result['length']} hops):")
    for p in result["pointers"]:
        print(f"  {p}")
    return 0


def cmd_communities(args) -> int:
    result = alg_mod.communities(_load(args.root), min_size=args.min_size,
                                 top=args.top)
    if args.json:
        print(json.dumps(result, indent=1))
        return 0
    print(f"{result['count']} communities "
          f"(of {result['total_communities']} total):")
    for c in result["communities"]:
        print(f"  community {c['id']}  size={c['size']}")
        for m in c["members"]:
            print(f"    {m['pointer']}  {m['name']} [{m['kind']}]")
    return 0


def cmd_central(args) -> int:
    result = alg_mod.centrality(_load(args.root), top=args.top, method=args.method)
    if args.json:
        print(json.dumps(result, indent=1))
        return 0
    print(f"centrality ({result['method']}, {result['node_count']} nodes):")
    for c in result["central"]:
        print(f"  {c['score']:>8.4f}  {c['name']} [{c['kind']}]  {c['pointer']}")
    return 0


def _print_affected(result) -> int:
    if "error" in result:
        print(result["error"], file=sys.stderr)
        return 1
    print(f"{len(result['changed_files'])} changed file(s), "
          f"{len(result['matched_files'])} in graph -> "
          f"{result['total']} affected symbol(s) (depth={result['depth']})")
    for group in result["affected"]:
        print(f"  distance {group['distance']}:")
        for s in group["symbols"]:
            print(f"    {s['pointer']}  {s['name']} [{s['kind']}]")
    return 0


def cmd_affected(args) -> int:
    result = alg_mod.affected(_load(args.root), files=args.files or None,
                              ref=args.ref, root=args.root, depth=args.depth)
    if args.json:
        print(json.dumps(result, indent=1))
        return 1 if "error" in result else 0
    return _print_affected(result)


def cmd_hook(args) -> int:
    result = (hooks_mod.install if args.action == "install"
              else hooks_mod.uninstall)(args.root)
    if "error" in result:
        print(result["error"], file=sys.stderr)
        return 1
    for verb in ("installed", "chained", "removed", "restored"):
        if result.get(verb):
            print(f"{verb}: {', '.join(result[verb])}")
    print(f"hooks dir: {result['hooks_dir']}")
    return 0


def cmd_prs(args) -> int:
    if args.number is None:
        result = prs_mod.list_prs(args.root)
        if args.json:
            print(json.dumps(result, indent=1))
            return 1 if "error" in result else 0
        if "error" in result:
            print(result["error"], file=sys.stderr)
            return 1
        for p in result["prs"]:
            print(f"  #{p['number']}  {p['title']}  "
                  f"[{p['branch']}] @{p['author']}")
        print(f"{result['count']} open PR(s)")
        return 0
    result = prs_mod.pr_impact(_load(args.root), args.number,
                               root=args.root, depth=args.depth)
    if args.json:
        print(json.dumps(result, indent=1))
        return 1 if "error" in result else 0
    if "error" in result:
        print(result["error"], file=sys.stderr)
        return 1
    print(f"PR #{result['number']}  {result['title']}")
    return _print_affected(result)


def cmd_serve(args) -> int:
    if args.transport == "http":
        mcp_mod.serve_http(args.root, host=args.host, port=args.port,
                           api_key=args.api_key)
    else:
        mcp_mod.serve(args.root)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="eap_context",
        description="EAP-Context symbol-graph engine (stdlib only).")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build", help="index a directory into .eap/graph.json")
    p.add_argument("dir")
    p.add_argument("--update", action="store_true",
                   help="incremental: re-extract only files changed since last build")
    p.set_defaults(fn=cmd_build)

    p = sub.add_parser("query", help="subgraph + file:line pointers for a query")
    p.add_argument("text")
    p.add_argument("--root", default=".")
    p.add_argument("--depth", type=int, default=DEFAULT_DEPTH)
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    p.add_argument("--degree-cap", type=int, default=None)
    p.add_argument("--mode", choices=["bfs", "dfs"], default="bfs")
    p.add_argument("--token-budget", type=int, default=None, dest="token_budget")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_query)

    p = sub.add_parser("stats", help="graph summary")
    p.add_argument("--root", default=".")
    p.set_defaults(fn=cmd_stats)

    p = sub.add_parser("godnodes", help="most-connected symbols")
    p.add_argument("--root", default=".")
    p.add_argument("--top", type=int, default=10)
    p.set_defaults(fn=cmd_godnodes)

    p = sub.add_parser("neighbors", help="edges around one symbol")
    p.add_argument("node")
    p.add_argument("--root", default=".")
    p.add_argument("--direction", choices=["in", "out", "both"], default="both")
    p.add_argument("--mode", choices=["bfs", "dfs"], default="bfs")
    p.add_argument("--depth", type=int, default=1)
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    p.set_defaults(fn=cmd_neighbors)

    p = sub.add_parser("explain", help="why a symbol matters (structural card)")
    p.add_argument("node")
    p.add_argument("--root", default=".")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_explain)

    p = sub.add_parser("export", help="export graph as graphml|html|svg (stdlib)")
    p.add_argument("--root", default=".")
    p.add_argument("--format", choices=["graphml", "html", "svg"], default="graphml")
    p.add_argument("--output", "-o", required=True)
    p.add_argument("--max-nodes", type=int, default=200, dest="max_nodes")
    p.set_defaults(fn=cmd_export)

    p = sub.add_parser("merge-graphs",
                       help="merge per-root graphs (optional ~/.eap/global)")
    p.add_argument("dirs", nargs="+")
    p.add_argument("--output", "-o", default="merged-graph.json")
    p.add_argument("--global", dest="global_name", default=None,
                   help="save under ~/.eap/global/<name>.json")
    p.add_argument("--no-prefix", action="store_true",
                   help="do not namespace node ids by root basename")
    p.set_defaults(fn=cmd_merge_graphs)

    p = sub.add_parser("watch",
                       help="poll mtimes and incremental-rebuild on change")
    p.add_argument("--root", default=".")
    p.add_argument("--interval", type=float, default=2.0,
                   help="seconds between polls (default 2)")
    p.set_defaults(fn=cmd_watch)

    p = sub.add_parser("path", help="shortest path between two symbols")
    p.add_argument("source")
    p.add_argument("target")
    p.add_argument("--root", default=".")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_path)

    p = sub.add_parser("communities", help="label-propagation community detection")
    p.add_argument("--root", default=".")
    p.add_argument("--min-size", type=int, default=1, dest="min_size")
    p.add_argument("--top", type=int, default=None)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_communities)

    p = sub.add_parser("central", help="centrality ranking (betweenness/degree)")
    p.add_argument("--root", default=".")
    p.add_argument("--top", type=int, default=10)
    p.add_argument("--method", choices=["auto", "betweenness", "degree"],
                   default="auto")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_central)

    p = sub.add_parser("affected",
                       help="blast radius of changed files (reverse-dep closure)")
    p.add_argument("files", nargs="*",
                   help="changed files (graph-relative); omit to use --ref")
    p.add_argument("--ref", default=None,
                   help="git revision: changed files from `git diff --name-only REF`")
    p.add_argument("--root", default=".")
    p.add_argument("--depth", type=int, default=alg_mod.AFFECTED_DEFAULT_DEPTH)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_affected)

    p = sub.add_parser("hook",
                       help="install/uninstall git post-commit/post-checkout "
                            "hooks that run `build --update` quietly")
    p.add_argument("action", choices=["install", "uninstall"])
    p.add_argument("--root", default=".")
    p.set_defaults(fn=cmd_hook)

    p = sub.add_parser("prs", help="open PRs (gh CLI); with a number, its "
                                   "changed files -> affected closure")
    p.add_argument("number", nargs="?", type=int, default=None)
    p.add_argument("--root", default=".")
    p.add_argument("--depth", type=int, default=alg_mod.AFFECTED_DEFAULT_DEPTH)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_prs)

    p = sub.add_parser("serve", help="MCP JSON-RPC server (stdio, or --transport http)")
    p.add_argument("--root", default=".")
    p.add_argument("--transport", choices=["stdio", "http"], default="stdio")
    p.add_argument("--host", default="127.0.0.1",
                   help="HTTP bind host (default localhost-only)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--api-key", default=None, dest="api_key",
                   help="HTTP API key (default: $EAP_CONTEXT_API_KEY or generated)")
    p.set_defaults(fn=cmd_serve)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
