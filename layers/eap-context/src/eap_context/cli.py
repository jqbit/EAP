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
from . import graph as graph_mod
from . import mcp as mcp_mod
from . import query as query_mod
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
                             degree_cap=args.degree_cap)
    if args.json:
        print(json.dumps(result, indent=1))
        return 0
    print(f"query: {result['query']}  (depth={result['depth']} "
          f"limit={result['limit']} cap={result['degree_cap']})")
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
    result = query_mod.neighbors(_load(args.root), args.node, args.direction)
    if result.get("node") is None:
        print(result.get("error", "not found"), file=sys.stderr)
        return 1
    node = result["node"]
    print(f"{node['name']} [{node['kind']}] degree={node['degree']}  {node['pointer']}")
    for e in result["neighbors"]:
        print(f"  {e['direction']} {e['name']} [{e['relation']}/"
              f"{e['provenance']}]  {e['pointer']}")
    return 0


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


def cmd_serve(args) -> int:
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
    p.set_defaults(fn=cmd_neighbors)

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

    p = sub.add_parser("serve", help="MCP JSON-RPC server on stdio")
    p.add_argument("--root", default=".")
    p.set_defaults(fn=cmd_serve)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
