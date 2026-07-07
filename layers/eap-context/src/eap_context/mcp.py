"""Minimal MCP server: JSON-RPC 2.0 over stdio (newline-delimited), stdlib only.

Tools exposed:
  eap_graph_build      — (re)index a directory into the .eap/graph.json cache
  eap_graph_query      — subgraph + file:line pointers for a text query
  eap_graph_neighbors  — edges around one symbol
  eap_graph_stats      — graph size/shape summary
  eap_graph_godnodes   — most-connected symbols

Dispatch is a pure function (`handle_request`) so it is testable without the
stdio loop. Both MCP-style routing (initialize / tools/list / tools/call) and
direct method names (method == "eap_graph_query") are accepted.
"""

from __future__ import annotations

import json
import sys

from . import graph as graph_mod
from . import query as query_mod
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


class Engine:
    """Holds the target root and a lazily loaded graph."""

    def __init__(self, root: str = "."):
        self.root = root
        self._graph = None

    def graph(self):
        if self._graph is None:
            self._graph = graph_mod.load_or_build(self.root)
        return self._graph

    # -- tool implementations -------------------------------------------------

    def build(self, params: dict) -> dict:
        root = params.get("root", self.root)
        g, path = graph_mod.build_and_save(root)
        self.root = root
        self._graph = g
        return {"cache": path, **query_mod.stats(g)}

    def query(self, params: dict) -> dict:
        text = params.get("query") or params.get("text")
        if not text or not isinstance(text, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'query'")
        return query_mod.query(
            self.graph(),
            text,
            depth=int(params.get("depth", DEFAULT_DEPTH)),
            limit=int(params.get("limit", DEFAULT_LIMIT)),
            degree_cap=params.get("degree_cap"),
        )

    def neighbors(self, params: dict) -> dict:
        node = params.get("node") or params.get("name")
        if not node or not isinstance(node, str):
            raise JsonRpcError(INVALID_PARAMS, "missing required string param 'node'")
        direction = params.get("direction", "both")
        if direction not in ("in", "out", "both"):
            raise JsonRpcError(INVALID_PARAMS, "direction must be in|out|both")
        return query_mod.neighbors(self.graph(), node, direction)

    def stats(self, params: dict) -> dict:
        return query_mod.stats(self.graph())

    def godnodes(self, params: dict) -> dict:
        top = int(params.get("top", 10))
        return {"god_nodes": query_mod.god_nodes(self.graph(), top=top)}


_TOOL_IMPLS = {
    "eap_graph_build": Engine.build,
    "eap_graph_query": Engine.query,
    "eap_graph_neighbors": Engine.neighbors,
    "eap_graph_stats": Engine.stats,
    "eap_graph_godnodes": Engine.godnodes,
}


def _schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


TOOLS = [
    {
        "name": "eap_graph_build",
        "description": "Index a codebase into the EAP symbol graph cache (.eap/graph.json).",
        "inputSchema": _schema({"root": {"type": "string"}}, []),
    },
    {
        "name": "eap_graph_query",
        "description": ("Query the code symbol graph; returns a compact subgraph and "
                        "file:line pointers (never file contents)."),
        "inputSchema": _schema({
            "query": {"type": "string"},
            "depth": {"type": "integer", "default": DEFAULT_DEPTH},
            "limit": {"type": "integer", "default": DEFAULT_LIMIT},
        }, ["query"]),
    },
    {
        "name": "eap_graph_neighbors",
        "description": "List edges around one symbol (by id or name) with pointers.",
        "inputSchema": _schema({
            "node": {"type": "string"},
            "direction": {"type": "string", "enum": ["in", "out", "both"]},
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
        result = impl(engine, params.get("arguments") or {})
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


if __name__ == "__main__":  # pragma: no cover
    serve(sys.argv[1] if len(sys.argv) > 1 else ".")
