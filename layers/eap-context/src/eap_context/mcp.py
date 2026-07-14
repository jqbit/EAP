"""Minimal MCP server: JSON-RPC 2.0 over stdio (newline-delimited), stdlib only.

Tools exposed:
  eap_graph_build       — (re)index a directory into the .eap/graph.json cache
  eap_graph_query       — subgraph + file:line pointers for a text query
  eap_graph_neighbors   — edges around one symbol (BFS/DFS)
  eap_graph_stats       — graph size/shape summary
  eap_graph_godnodes    — most-connected symbols
  eap_graph_path        — shortest path between two symbols (pointers)
  eap_graph_communities — label-propagation community detection
  eap_graph_central     — betweenness/degree centrality ranking
  eap_graph_affected    — blast radius of changed files (reverse-dep closure)
  eap_graph_prs         — open PRs via the gh CLI
  eap_graph_pr_impact   — a PR's changed files -> affected closure
  eap_graph_reflect     — tag nodes preferred/contested (query-score overlay)
  eap_graph_get_node    — single-node card (explain-lite)
  eap_graph_explain     — structural "why this node" card
  eap_graph_get_community — members of one stored community id
  eap_graph_triage_prs  — structural PR ranking + overlap hints (no LLM)

Dispatch is a pure function (`handle_request`) so it is testable without the
stdio loop. Both MCP-style routing (initialize / tools/list / tools/call) and
direct method names (method == "eap_graph_query") are accepted.

Transports: newline-delimited JSON-RPC on stdio (`serve`, the default), or a
stateless localhost-by-default HTTP POST endpoint (`serve_http`) that reuses
the same dispatch and REQUIRES an API key on every request.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Allow running as a plain script — the installer registers the server as
# `python3 <repo>/layers/eap-context/src/eap_context/mcp.py <root>`, i.e. direct
# script execution with no package context, which would make the `from . import`
# below raise "attempted relative import with no known parent package". When run
# without a package, put the package's PARENT dir on sys.path and set
# __package__ so the relative imports resolve to eap_context.* (module form,
# `python3 -m eap_context.mcp`, still works unchanged).
if __package__ in (None, ""):  # pragma: no cover — exercised via subprocess test
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "eap_context"

from . import algorithms as alg_mod
from . import graph as graph_mod
from . import prs as prs_mod
from . import query as query_mod
from . import reflect as reflect_mod
from .query import DEFAULT_DEPTH, DEFAULT_LIMIT

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "eap-context", "version": "0.1.0"}

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _coerce_int(value, key: str) -> int:
    """Coerce a JSON param to int or raise INVALID_PARAMS at the boundary.

    Without this a non-int ``depth``/``limit`` raises ValueError and a non-int
    ``degree_cap`` raises TypeError deep inside query(), both surfacing as a
    generic INTERNAL_ERROR instead of a clean, caller-actionable JSON-RPC error.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise JsonRpcError(INVALID_PARAMS, f"param {key!r} must be an integer")
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        # OverflowError: int(float('inf')) — serve() uses json.loads (allow_nan
        # on by default), so a bare `Infinity` for depth/limit/top/degree_cap is
        # reachable on the wire and must surface as -32602, not -32603.
        raise JsonRpcError(INVALID_PARAMS, f"param {key!r} must be an integer")


class Engine:
    """Holds the target root and a lazily loaded graph."""

    def __init__(self, root: str = "."):
        self.root = root
        self._graph = None
        self._graph_key = None  # (mtime_ns, size) of the cache file when loaded

    @staticmethod
    def _cache_key(root):
        """(mtime_ns, size) of the graph cache file, or None if it is absent."""
        try:
            st = os.stat(graph_mod.cache_path(root))
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def graph(self):
        # Reload when the on-disk cache changed under us (C5): a rebuild by
        # another process — or this engine's own build() — rewrites graph.json,
        # so a graph pinned from a stale first load would hide new symbols.
        key = self._cache_key(self.root)
        if self._graph is None or key != self._graph_key:
            self._graph = graph_mod.load_or_build(self.root)
            self._graph_key = self._cache_key(self.root)
        return self._graph

    # -- tool implementations -------------------------------------------------

    def build(self, params: dict) -> dict:
        # A caller-supplied root is confined to within the server's configured
        # root: otherwise build_and_save would read every file under an
        # arbitrary absolute/`..`-escaping directory and write a cache there.
        root = params.get("root")
        if root is None:
            root = self.root
        else:
            # os.path.realpath raises TypeError on a non-str/PathLike (int, list,
            # bool, dict), which would surface as -32603; validate at the
            # boundary so a bad type is a clean -32602 like every other param.
            if not isinstance(root, str):
                raise JsonRpcError(INVALID_PARAMS, "param 'root' must be a string")
            if "\x00" in root:
                # os.path.realpath raises ValueError (not TypeError) on an
                # embedded NUL, which would surface as -32603; keep it a -32602.
                raise JsonRpcError(INVALID_PARAMS, "param 'root' contains a null byte")
            base = os.path.realpath(self.root)
            target = os.path.realpath(root)
            if target != base and not target.startswith(base + os.sep):
                raise JsonRpcError(INVALID_PARAMS, "root must be within the server root")
            root = target
        incremental = bool(params.get("incremental", False))
        g, path = graph_mod.build_and_save(root, incremental=incremental)
        self.root = root
        self._graph = g
        self._graph_key = self._cache_key(root)  # keep C5 reload in sync
        return {"cache": path, "incremental": incremental, **query_mod.stats(g)}

    def query(self, params: dict) -> dict:
        text = params.get("query") or params.get("text")
        if not text or not isinstance(text, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'query'")
        depth = _coerce_int(params.get("depth", DEFAULT_DEPTH), "depth")
        limit = _coerce_int(params.get("limit", DEFAULT_LIMIT), "limit")
        degree_cap = params.get("degree_cap")
        if degree_cap is not None:
            degree_cap = _coerce_int(degree_cap, "degree_cap")
        mode = params.get("mode", "bfs")
        if mode not in ("bfs", "dfs"):
            raise JsonRpcError(INVALID_PARAMS, "mode must be bfs|dfs")
        token_budget = params.get("token_budget")
        if token_budget is not None:
            token_budget = _coerce_int(token_budget, "token_budget")
        result = query_mod.query(
            self.graph(),
            text,
            depth=depth,
            limit=limit,
            degree_cap=degree_cap,
            tags=reflect_mod.load_tags(self.root),
            mode=mode,
            token_budget=token_budget,
        )
        reflect_mod.log_query(
            self.root, "eap_graph_query",
            {"query": text, "depth": depth, "limit": limit}, result)
        return result

    def neighbors(self, params: dict) -> dict:
        node = params.get("node") or params.get("name")
        if not node or not isinstance(node, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'node'")
        direction = params.get("direction", "both")
        if direction not in ("in", "out", "both"):
            raise JsonRpcError(INVALID_PARAMS, "direction must be in|out|both")
        mode = params.get("mode", "bfs")
        if mode not in ("bfs", "dfs"):
            raise JsonRpcError(INVALID_PARAMS, "mode must be bfs|dfs")
        depth = _coerce_int(params.get("depth", 1), "depth")
        limit = _coerce_int(params.get("limit", DEFAULT_LIMIT), "limit")
        return query_mod.neighbors(self.graph(), node, direction,
                                   mode=mode, depth=depth, limit=limit)

    def stats(self, params: dict) -> dict:
        return query_mod.stats(self.graph())

    def godnodes(self, params: dict) -> dict:
        top = _coerce_int(params.get("top", 10), "top")
        return {"god_nodes": query_mod.god_nodes(self.graph(), top=top)}

    def path(self, params: dict) -> dict:
        source = params.get("source") or params.get("from") or params.get("a")
        target = params.get("target") or params.get("to") or params.get("b")
        if not source or not isinstance(source, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'source'")
        if not target or not isinstance(target, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'target'")
        return alg_mod.shortest_path(self.graph(), source, target)

    def communities(self, params: dict) -> dict:
        min_size = _coerce_int(params.get("min_size", 1), "min_size")
        top = params.get("top")
        if top is not None:
            top = _coerce_int(top, "top")
        return alg_mod.communities(self.graph(), min_size=min_size, top=top)

    def central(self, params: dict) -> dict:
        top = _coerce_int(params.get("top", 10), "top")
        method = params.get("method", "auto")
        if method not in ("auto", "betweenness", "degree"):
            raise JsonRpcError(INVALID_PARAMS,
                               "method must be auto|betweenness|degree")
        return alg_mod.centrality(self.graph(), top=top, method=method)

    def affected(self, params: dict) -> dict:
        files = params.get("files")
        if files is not None and (not isinstance(files, list) or not all(
                isinstance(f, str) for f in files)):
            raise JsonRpcError(INVALID_PARAMS,
                               "param 'files' must be an array of strings")
        ref = params.get("ref")
        if ref is not None and not isinstance(ref, str):
            raise JsonRpcError(INVALID_PARAMS, "param 'ref' must be a string")
        if files is None and ref is None:
            raise JsonRpcError(INVALID_PARAMS,
                               "provide 'files' (array) or 'ref' (git revision)")
        depth = _coerce_int(
            params.get("depth", alg_mod.AFFECTED_DEFAULT_DEPTH), "depth")
        return alg_mod.affected(self.graph(), files=files, ref=ref,
                                root=self.root, depth=depth)

    def prs(self, params: dict) -> dict:
        return prs_mod.list_prs(self.root)

    def pr_impact(self, params: dict) -> dict:
        number = _coerce_int(params.get("number"), "number") \
            if params.get("number") is not None else None
        if number is None:
            raise JsonRpcError(INVALID_PARAMS,
                               "missing required integer param 'number'")
        depth = _coerce_int(
            params.get("depth", alg_mod.AFFECTED_DEFAULT_DEPTH), "depth")
        return prs_mod.pr_impact(self.graph(), number, root=self.root, depth=depth)

    def reflect(self, params: dict) -> dict:
        nodes = params.get("nodes")
        if nodes is None and isinstance(params.get("node"), str):
            nodes = [params["node"]]
        if (not isinstance(nodes, list) or not nodes
                or not all(isinstance(n, str) for n in nodes)):
            raise JsonRpcError(INVALID_PARAMS,
                               "param 'nodes' must be a non-empty array of strings")
        tag = params.get("tag")
        if tag not in (*reflect_mod.TAGS, "clear"):
            raise JsonRpcError(INVALID_PARAMS,
                               "tag must be preferred|contested|clear")
        return reflect_mod.set_tags(self.root, self.graph(), nodes, tag)

    def get_node(self, params: dict) -> dict:
        node = params.get("node") or params.get("name")
        if not node or not isinstance(node, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'node'")
        return query_mod.get_node(self.graph(), node)

    def explain(self, params: dict) -> dict:
        node = params.get("node") or params.get("name")
        if not node or not isinstance(node, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'node'")
        return query_mod.explain(self.graph(), node, root=self.root)

    def get_community(self, params: dict) -> dict:
        if params.get("id") is None and params.get("community") is None:
            raise JsonRpcError(INVALID_PARAMS,
                               "missing required integer param 'id'")
        cid = _coerce_int(params.get("id", params.get("community")), "id")
        return query_mod.get_community(self.graph(), cid, root=self.root)

    def triage_prs(self, params: dict) -> dict:
        depth = _coerce_int(
            params.get("depth", alg_mod.AFFECTED_DEFAULT_DEPTH), "depth")
        limit = _coerce_int(params.get("limit", 20), "limit")
        return prs_mod.triage_prs(self.graph(), root=self.root,
                                  depth=depth, limit=limit)


_TOOL_IMPLS = {
    "eap_graph_build": Engine.build,
    "eap_graph_query": Engine.query,
    "eap_graph_neighbors": Engine.neighbors,
    "eap_graph_stats": Engine.stats,
    "eap_graph_godnodes": Engine.godnodes,
    "eap_graph_path": Engine.path,
    "eap_graph_communities": Engine.communities,
    "eap_graph_central": Engine.central,
    "eap_graph_affected": Engine.affected,
    "eap_graph_prs": Engine.prs,
    "eap_graph_pr_impact": Engine.pr_impact,
    "eap_graph_reflect": Engine.reflect,
    "eap_graph_get_node": Engine.get_node,
    "eap_graph_explain": Engine.explain,
    "eap_graph_get_community": Engine.get_community,
    "eap_graph_triage_prs": Engine.triage_prs,
}


def _schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


TOOLS = [
    {
        "name": "eap_graph_build",
        "description": ("Index a codebase into the EAP symbol graph cache "
                        "(.eap/graph.json). Set incremental=true to re-extract "
                        "only files changed since the last build."),
        "inputSchema": _schema({
            "root": {"type": "string"},
            "incremental": {"type": "boolean", "default": False},
        }, []),
    },
    {
        "name": "eap_graph_query",
        "description": ("Query the code symbol graph; returns a compact subgraph and "
                        "file:line pointers (never file contents)."),
        "inputSchema": _schema({
            "query": {"type": "string"},
            "depth": {"type": "integer", "default": DEFAULT_DEPTH},
            "limit": {"type": "integer", "default": DEFAULT_LIMIT},
            "mode": {"type": "string", "enum": ["bfs", "dfs"], "default": "bfs"},
            "token_budget": {"type": "integer"},
        }, ["query"]),
    },
    {
        "name": "eap_graph_neighbors",
        "description": "List edges around one symbol (by id or name) with pointers.",
        "inputSchema": _schema({
            "node": {"type": "string"},
            "direction": {"type": "string", "enum": ["in", "out", "both"]},
            "mode": {"type": "string", "enum": ["bfs", "dfs"], "default": "bfs"},
            "depth": {"type": "integer", "default": 1},
            "limit": {"type": "integer", "default": DEFAULT_LIMIT},
        }, ["node"]),
    },
    {
        "name": "eap_graph_stats",
        "description": "Symbol-graph size and shape summary.",
        "inputSchema": _schema({}, []),
    },
    {
        "name": "eap_graph_godnodes",
        "description": "Most-connected (hub) symbols in the graph.",
        "inputSchema": _schema({"top": {"type": "integer", "default": 10}}, []),
    },
    {
        "name": "eap_graph_path",
        "description": ("Shortest path between two symbols (by id or name) over "
                        "the undirected graph; returns the node path as pointers."),
        "inputSchema": _schema({
            "source": {"type": "string"},
            "target": {"type": "string"},
        }, ["source", "target"]),
    },
    {
        "name": "eap_graph_communities",
        "description": ("Deterministic label-propagation community detection; "
                        "returns clusters of related symbols as pointers."),
        "inputSchema": _schema({
            "min_size": {"type": "integer", "default": 1},
            "top": {"type": "integer"},
        }, []),
    },
    {
        "name": "eap_graph_central",
        "description": ("Rank symbols by centrality (Brandes betweenness on small "
                        "graphs, degree fallback on large ones)."),
        "inputSchema": _schema({
            "top": {"type": "integer", "default": 10},
            "method": {"type": "string", "enum": ["auto", "betweenness", "degree"]},
        }, []),
    },
    {
        "name": "eap_graph_affected",
        "description": ("Blast radius of a change: symbols in the changed files "
                        "plus everything that depends on them (bounded "
                        "reverse-dependency closure, grouped by distance). "
                        "Pass 'files' explicitly or 'ref' to run "
                        "`git diff --name-only <ref>`."),
        "inputSchema": _schema({
            "files": {"type": "array", "items": {"type": "string"}},
            "ref": {"type": "string"},
            "depth": {"type": "integer",
                      "default": alg_mod.AFFECTED_DEFAULT_DEPTH},
        }, []),
    },
    {
        "name": "eap_graph_prs",
        "description": ("List open pull requests for the indexed repo "
                        "(via the gh CLI; requires gh installed + authed)."),
        "inputSchema": _schema({}, []),
    },
    {
        "name": "eap_graph_pr_impact",
        "description": ("Blast radius of one PR: its changed files (via the gh "
                        "CLI) fed through the affected reverse-dependency "
                        "closure, grouped by distance."),
        "inputSchema": _schema({
            "number": {"type": "integer"},
            "depth": {"type": "integer",
                      "default": alg_mod.AFFECTED_DEFAULT_DEPTH},
        }, ["number"]),
    },
    {
        "name": "eap_graph_reflect",
        "description": ("Tag graph nodes 'preferred' (query-score boost) or "
                        "'contested' (penalty), or 'clear' the tag. Persisted; "
                        "applied as a small overlay on future queries. Also "
                        "rewrites .eap/LESSONS.md for preferred tags."),
        "inputSchema": _schema({
            "nodes": {"type": "array", "items": {"type": "string"}},
            "tag": {"type": "string",
                    "enum": ["preferred", "contested", "clear"]},
        }, ["nodes", "tag"]),
    },
    {
        "name": "eap_graph_get_node",
        "description": ("Single-node card: metadata, degree, community id, "
                        "and a sample of neighboring edges."),
        "inputSchema": _schema({"node": {"type": "string"}}, ["node"]),
    },
    {
        "name": "eap_graph_explain",
        "description": ("Structural explanation of a symbol: hub status, "
                        "community, relation histogram, sample callers/callees. "
                        "No LLM."),
        "inputSchema": _schema({"node": {"type": "string"}}, ["node"]),
    },
    {
        "name": "eap_graph_get_community",
        "description": ("Members of one community (ids stamped at build time "
                        "by label propagation)."),
        "inputSchema": _schema({"id": {"type": "integer"}}, ["id"]),
    },
    {
        "name": "eap_graph_triage_prs",
        "description": ("Structural PR triage (no LLM): rank open PRs by "
                        "affected blast radius and flag overlapping "
                        "affected-file sets; includes git worktree map."),
        "inputSchema": _schema({
            "depth": {"type": "integer",
                      "default": alg_mod.AFFECTED_DEFAULT_DEPTH},
            "limit": {"type": "integer", "default": 20},
        }, []),
    },
]


# ---------------------------------------------------------------------------
# pure dispatch
# ---------------------------------------------------------------------------


def dispatch(method: str, params: dict, engine: Engine) -> dict:
    """Route one JSON-RPC method to a result dict. Raises JsonRpcError."""
    if method == "initialize":
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name = params.get("name")
        impl = _TOOL_IMPLS.get(name)
        if impl is None:
            raise JsonRpcError(INVALID_PARAMS, f"unknown tool: {name!r}")
        arguments = params.get("arguments")
        if arguments is None:
            arguments = {}
        elif not isinstance(arguments, dict):
            raise JsonRpcError(INVALID_PARAMS, "arguments must be an object")
        result = impl(engine, arguments)
        return {
            "content": [{"type": "text", "text": json.dumps(result, indent=1)}],
            "isError": False,
        }
    impl = _TOOL_IMPLS.get(method)
    if impl is not None:  # direct method form
        return impl(engine, params or {})
    raise JsonRpcError(METHOD_NOT_FOUND, f"method not found: {method}")


def handle_request(request: dict, engine: Engine) -> dict | None:
    """Handle one parsed JSON-RPC message. Returns a response dict, or None
    for notifications (no id)."""
    req_id = request.get("id")
    is_notification = "id" not in request
    method = request.get("method")
    if not isinstance(method, str):
        if is_notification:
            return None
        return _error(req_id, INVALID_REQUEST, "missing method")
    if method.startswith("notifications/"):
        return None
    params = request.get("params") or {}
    if not isinstance(params, dict):
        if is_notification:
            return None
        return _error(req_id, INVALID_PARAMS, "params must be an object")
    try:
        result = dispatch(method, params, engine)
    except JsonRpcError as exc:
        return None if is_notification else _error(req_id, exc.code, exc.message)
    except Exception as exc:  # noqa: BLE001 — surface as JSON-RPC internal error
        return None if is_notification else _error(
            req_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
    return None if is_notification else {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id,
            "error": {"code": code, "message": message}}


# ---------------------------------------------------------------------------
# stdio loop
# ---------------------------------------------------------------------------


def serve(root: str = ".", stdin=None, stdout=None) -> None:
    """Newline-delimited JSON-RPC over stdio until EOF."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    engine = Engine(root)
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            response = _error(None, PARSE_ERROR, "parse error")
        else:
            if not isinstance(request, dict):
                response = _error(None, INVALID_REQUEST, "request must be an object")
            else:
                response = handle_request(request, engine)
        if response is not None:
            stdout.write(json.dumps(response) + "\n")
            stdout.flush()


# ---------------------------------------------------------------------------
# HTTP transport (stateless JSON-RPC POST endpoint; stdio stays the default)
# ---------------------------------------------------------------------------

MAX_HTTP_BODY = 1 << 20  # 1 MiB: no graph query needs more; bounds memory
API_KEY_ENV = "EAP_CONTEXT_API_KEY"


def make_http_server(root: str = ".", host: str = "127.0.0.1", port: int = 8765,
                     api_key: str | None = None) -> tuple[ThreadingHTTPServer, str]:
    """Build the HTTP JSON-RPC server; returns (server, api_key).

    Every request must carry the key (``X-API-Key`` header, or
    ``Authorization: Bearer <key>``); the comparison is constant-time
    (hmac.compare_digest). Key precedence: explicit arg > $EAP_CONTEXT_API_KEY
    > freshly generated. Only POST is accepted, bodies are size-bounded, and
    the endpoint is stateless — one shared Engine behind a lock, no sessions.
    Binds 127.0.0.1 unless the caller explicitly asks otherwise.
    """
    key = api_key or os.environ.get(API_KEY_ENV) or secrets.token_hex(16)
    engine = Engine(root)
    lock = threading.Lock()  # eap-lean: global lock serializes requests —
    # upgrade path: per-request Engine or an RW lock if concurrent read
    # throughput ever matters.

    class Handler(BaseHTTPRequestHandler):
        server_version = "eap-context/" + SERVER_INFO["version"]
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # quiet by design
            pass

        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            supplied = self.headers.get("X-API-Key")
            if not supplied:
                auth = self.headers.get("Authorization", "")
                if auth.startswith("Bearer "):
                    supplied = auth[len("Bearer "):].strip()
            return bool(supplied) and hmac.compare_digest(
                supplied.encode("utf-8"), key.encode("utf-8"))

        def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler API
            if not self._authorized():
                return self._send(401, {"error": "missing or invalid API key"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._send(411, {"error": "Content-Length required"})
            if length < 0 or length > MAX_HTTP_BODY:
                return self._send(413, {"error": "request body too large"})
            try:
                request = json.loads(self.rfile.read(length))
            except ValueError:
                return self._send(200, _error(None, PARSE_ERROR, "parse error"))
            if not isinstance(request, dict):
                return self._send(
                    200, _error(None, INVALID_REQUEST, "request must be an object"))
            with lock:
                response = handle_request(request, engine)
            if response is None:  # notification
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._send(200, response)

        def _reject_method(self) -> None:
            self._send(405, {"error": "POST only"})

        do_GET = do_PUT = do_DELETE = do_PATCH = do_HEAD = _reject_method

    return ThreadingHTTPServer((host, port), Handler), key


def serve_http(root: str = ".", host: str = "127.0.0.1", port: int = 8765,
               api_key: str | None = None) -> None:
    """Serve the JSON-RPC endpoint over HTTP until interrupted."""
    generated = not (api_key or os.environ.get(API_KEY_ENV))
    server, key = make_http_server(root, host, port, api_key)
    bound_host, bound_port = server.server_address[:2]
    print(f"eap-context: http://{bound_host}:{bound_port}/ (POST, JSON-RPC 2.0)",
          file=sys.stderr)
    if generated:
        # printed once at startup so the operator can hand it to clients;
        # otherwise the configured key is never echoed back.
        print(f"eap-context: api key (generated): {key}", file=sys.stderr)
    else:
        print("eap-context: api key: (from "
              + ("--api-key" if api_key else API_KEY_ENV) + ")", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        pass
    finally:
        server.server_close()


if __name__ == "__main__":  # pragma: no cover
    serve(sys.argv[1] if len(sys.argv) > 1 else ".")
