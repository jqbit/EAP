"""Tests for the EAP-Context symbol-graph engine (stdlib only).

Run either way from the repo root:

    python3 tests/test_context_engine.py
    python3 -m unittest tests.test_context_engine
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "layers" / "eap-context" / "src"
sys.path.insert(0, str(SRC))

from eap_context import algorithms, extract, graph, mcp, query  # noqa: E402

ALPHA_PY = '''\
"""Fixture: config loading."""
import json


def load_config(path):
    with open(path) as fh:
        return json.load(fh)


def parse_entry(raw):
    cfg = load_config("cfg.json")
    return raw.strip(), cfg


class Store:
    def save(self, entry):
        record = parse_entry(entry)
        return record
'''

BETA_PY = '''\
from alpha import parse_entry, Store


def run_pipeline(items):
    store = Store()
    for item in items:
        parsed = parse_entry(item)
        store.save(parsed)
    return store
'''

WEB_JS = '''\
import { helper } from "./alpha";

const fetchData = async (url) => {
  const res = await fetch(url);
  return res.json();
};

function render(target) {
  const data = fetchData("/api");
  target.innerHTML = data;
}

class Widget extends Base {
  refresh() {
    render(this.el);
  }
}
'''


def _hub_py(callers: int = 30) -> str:
    parts = ["def log(msg):\n    return msg\n"]
    for i in range(callers):
        parts.append(f"\n\ndef task_{i}():\n    log('t{i}')\n")
    return "".join(parts)


class ContextEngineTest(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="eap-ctx-fixture-")
        write = lambda name, body: Path(cls.root, name).write_text(body)  # noqa: E731
        write("alpha.py", ALPHA_PY)
        write("beta.py", BETA_PY)
        write("web.js", WEB_JS)
        write("hub.py", _hub_py())
        # decoys that MUST be ignored
        for ignored in (".git", "node_modules", "dist"):
            d = Path(cls.root, ignored)
            d.mkdir()
            (d / "decoy.py").write_text("def should_not_appear():\n    pass\n")
        # binary masquerading as source: must be skipped, not crash
        Path(cls.root, "blob.py").write_bytes(b"\x00\x01\x02binary")
        cls.graph = graph.build(cls.root)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    # -- extraction ----------------------------------------------------------

    def test_python_symbols_extracted(self):
        syms = extract.extract_file(os.path.join(self.root, "alpha.py"), "alpha.py")
        by_name = {s["name"]: s for s in syms}
        self.assertIn("load_config", by_name)
        self.assertIn("parse_entry", by_name)
        self.assertIn("Store", by_name)
        self.assertIn("Store.save", by_name)
        self.assertEqual(by_name["load_config"]["kind"], "function")
        self.assertEqual(by_name["Store"]["kind"], "class")
        self.assertEqual(by_name["Store.save"]["kind"], "method")
        self.assertEqual(by_name["json"]["kind"], "import")
        self.assertIn("load_config", by_name["parse_entry"]["refs"])
        self.assertIn("parse_entry", by_name["Store.save"]["refs"])
        # line numbers point at the real definitions
        self.assertEqual(by_name["parse_entry"]["line"],
                         ALPHA_PY.splitlines().index("def parse_entry(raw):") + 1)

    def test_js_symbols_extracted(self):
        syms = extract.extract_file(os.path.join(self.root, "web.js"), "web.js")
        by_name = {s["name"]: s for s in syms}
        self.assertEqual(by_name["fetchData"]["kind"], "function")
        self.assertEqual(by_name["render"]["kind"], "function")
        self.assertEqual(by_name["Widget"]["kind"], "class")
        self.assertIn("fetchData", by_name["render"]["refs"])
        self.assertIn("Base", by_name["Widget"]["refs"])
        self.assertEqual(by_name["alpha"]["kind"], "import")

    def test_binary_and_ignored_dirs_skipped(self):
        names = {n["name"] for n in self.graph.nodes.values()}
        self.assertNotIn("should_not_appear", names)
        files = {n["file"] for n in self.graph.nodes.values()}
        self.assertNotIn("blob.py", files)
        self.assertFalse(any(f.startswith((".git/", "node_modules/", "dist/"))
                             for f in files))

    # -- graph build ---------------------------------------------------------

    def test_cross_file_call_edge(self):
        edges = [(e["source"], e["target"], e["relation"], e["provenance"])
                 for e in self.graph.edges]
        self.assertIn(
            ("beta.py::run_pipeline", "alpha.py::parse_entry", "calls", "INFERRED"),
            edges)
        # same-file call is EXTRACTED
        self.assertIn(
            ("alpha.py::parse_entry", "alpha.py::load_config", "calls", "EXTRACTED"),
            edges)
        # explicit import statement links to the definition
        self.assertIn(
            ("beta.py::parse_entry", "alpha.py::parse_entry", "imports", "INFERRED"),
            edges)

    # -- query: pointers, never contents --------------------------------------

    def test_query_returns_pointers_not_source(self):
        res = query.query(self.graph, "parse entry pipeline", depth=3, limit=20)
        self.assertTrue(res["pointers"], "query returned no pointers")
        ptr_re = re.compile(r"^[\w./-]+:\d+  \S")
        for p in res["pointers"]:
            self.assertRegex(p, ptr_re)
            self.assertNotIn("def ", p)      # no source text
            self.assertNotIn("{", p)
        joined = "\n".join(res["pointers"])
        self.assertIn("alpha.py:", joined)
        # the parse_entry pointer carries its true line number
        want_line = ALPHA_PY.splitlines().index("def parse_entry(raw):") + 1
        self.assertIn(f"alpha.py:{want_line}", joined)
        self.assertLessEqual(len(res["nodes"]), 20)
        # subgraph edges only connect returned nodes
        ids = {n["id"] for n in res["nodes"]}
        for e in res["edges"]:
            self.assertIn(e["source"], ids)
            self.assertIn(e["target"], ids)

    # -- god-node cap ----------------------------------------------------------

    def test_hub_node_is_capped(self):
        hub_id = "hub.py::log"
        self.assertGreaterEqual(self.graph.degree(hub_id), 30)
        # log is flagged as a god node
        god_ids = [n["id"] for n in query.god_nodes(self.graph, top=5)]
        self.assertIn(hub_id, god_ids)
        # with the cap: BFS keeps the hub but does not fan out through it
        capped = query.query(self.graph, "task_3", depth=3, limit=100, degree_cap=5)
        capped_ids = {n["id"] for n in capped["nodes"]}
        self.assertIn("hub.py::task_3", capped_ids)
        self.assertIn(hub_id, capped_ids)
        task_count = sum(1 for i in capped_ids
                         if i.startswith("hub.py::task_") and i != "hub.py::task_3")
        self.assertLess(task_count, 5,
                        "cap failed: hub expansion dragged in sibling callers")
        # without the cap, the same query explodes through the hub
        uncapped = query.query(self.graph, "task_3", depth=3, limit=100,
                               degree_cap=10_000)
        self.assertGreater(len(uncapped["nodes"]), len(capped["nodes"]) + 10)

    # -- cache round-trip --------------------------------------------------------

    def test_json_cache_round_trips(self):
        g, path = graph.build_and_save(self.root)
        self.assertTrue(path.endswith(os.path.join(".eap", "graph.json")))
        self.assertTrue(os.path.isfile(path))
        loaded = graph.load(path)
        self.assertEqual(set(loaded.nodes), set(g.nodes))
        self.assertEqual(loaded.nodes, g.nodes)
        self.assertEqual(len(loaded.edges), len(g.edges))
        self.assertEqual(
            {(e["source"], e["target"], e["relation"]) for e in loaded.edges},
            {(e["source"], e["target"], e["relation"]) for e in g.edges})
        # degrees survive (adjacency rebuilt correctly)
        for nid in g.nodes:
            self.assertEqual(loaded.degree(nid), g.degree(nid))
        # file is valid node-link JSON
        data = json.loads(Path(path).read_text())
        self.assertIn("nodes", data)
        self.assertIn("links", data)

    # -- mcp dispatch ---------------------------------------------------------

    def test_mcp_dispatch_query_and_unknown_method(self):
        engine = mcp.Engine(self.root)
        # direct method form
        res = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 1, "method": "eap_graph_query",
             "params": {"query": "run pipeline", "limit": 10}}, engine)
        self.assertEqual(res["id"], 1)
        self.assertIn("result", res)
        self.assertTrue(res["result"]["pointers"])
        self.assertNotIn("error", res)
        # MCP tools/call form
        res2 = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": "eap_graph_stats", "arguments": {}}}, engine)
        payload = json.loads(res2["result"]["content"][0]["text"])
        self.assertGreater(payload["nodes"], 0)
        # unknown method -> -32601
        err = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 3, "method": "eap_graph_teleport",
             "params": {}}, engine)
        self.assertEqual(err["error"]["code"], -32601)
        # bad params -> -32602, and notifications get no response
        bad = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 4, "method": "eap_graph_query", "params": {}},
            engine)
        self.assertEqual(bad["error"]["code"], -32602)
        self.assertIsNone(mcp.handle_request(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}, engine))

    def test_mcp_tools_list_names(self):
        engine = mcp.Engine(self.root)
        res = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 9, "method": "tools/list"}, engine)
        names = {t["name"] for t in res["result"]["tools"]}
        self.assertEqual(names, {
            "eap_graph_query", "eap_graph_build", "eap_graph_neighbors",
            "eap_graph_stats", "eap_graph_godnodes", "eap_graph_path",
            "eap_graph_communities", "eap_graph_central",
            "eap_graph_affected", "eap_graph_prs", "eap_graph_pr_impact",
            "eap_graph_reflect"})

    # -- security regressions ------------------------------------------------
    # Each test below fails against the pre-hardening code and locks in a fix
    # from the adversarial review. Do not delete without re-auditing the class.

    def test_import_regex_stays_linear_on_adversarial_input(self):
        # ReDoS regression: the old JS import regex mixed \\s into the import-
        # clause class AND used \\s as the separator, so a long run of
        # "word space word space ..." that never reaches `from`/a quote forced
        # super-linear backtracking. The current form keeps the token class
        # disjoint from the separator. A re-introduced bad pattern blows past
        # the ceiling; a linear pattern finishes in well under a millisecond.
        evil_import = "import " + ("a " * 50000) + "!"   # never reaches from/quote
        evil_require = "require(" + ("a " * 50000)       # never closes the call
        for pattern, evil in ((extract._JS_IMPORT, evil_import),
                              (extract._JS_REQUIRE, evil_require)):
            start = time.perf_counter()
            self.assertIsNone(pattern.search(evil))
            self.assertLess(time.perf_counter() - start, 2.0,
                            "import/require regex is super-linear (ReDoS)")
        # full stack: an overlong (minified/generated) line must not hang
        # extraction — the scannable-line guard neutralizes it.
        big = tempfile.mkdtemp(prefix="eap-redos-")
        self.addCleanup(shutil.rmtree, big, ignore_errors=True)
        Path(big, "min.js").write_text("import " + ("x," * 200000) + " from 'm'\n")
        start = time.perf_counter()
        extract.extract_file(os.path.join(big, "min.js"), "min.js")
        self.assertLess(time.perf_counter() - start, 2.0)

    def test_symlink_out_of_tree_is_not_indexed(self):
        # A symlink under the root that points outside it must never pull
        # out-of-tree source into the graph under an in-tree path.
        root = tempfile.mkdtemp(prefix="eap-sym-root-")
        outside = tempfile.mkdtemp(prefix="eap-sym-out-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        Path(root, "real.py").write_text("def in_tree():\n    pass\n")
        Path(outside, "secret.py").write_text("def out_of_tree_secret():\n    pass\n")
        Path(outside, "pkg").mkdir()
        Path(outside, "pkg", "more.py").write_text("def also_secret():\n    pass\n")
        try:
            os.symlink(os.path.join(outside, "secret.py"),
                       os.path.join(root, "linked.py"))
            os.symlink(os.path.join(outside, "pkg"),
                       os.path.join(root, "linkeddir"))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not permitted on this platform")
        g = graph.build(root)
        names = {n["name"] for n in g.nodes.values()}
        self.assertIn("in_tree", names)
        self.assertNotIn("out_of_tree_secret", names)
        self.assertNotIn("also_secret", names)
        root_real = os.path.realpath(root)
        for n in g.nodes.values():
            ap = os.path.realpath(os.path.join(root, n["file"]))
            self.assertTrue(ap == root_real or ap.startswith(root_real + os.sep),
                            f"indexed node escapes root: {n['file']!r}")

    def test_poisoned_cache_pointer_is_rejected(self):
        # The cache is untrusted input. A node whose file is absolute or
        # escapes the tree with ".." must be rejected, not handed to the agent
        # as a file:line pointer.
        root = tempfile.mkdtemp(prefix="eap-cache-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        Path(root, "ok.py").write_text("def ok():\n    pass\n")
        _, path = graph.build_and_save(root)
        good = json.loads(Path(path).read_text())
        for bad_file in ("/etc/passwd", "../../../etc/passwd", "..\\..\\secret",
                         "C:\\Windows\\x", "//host/share/x", "sub/../../out"):
            data = json.loads(json.dumps(good))  # deep copy
            data["nodes"].append({"id": "evil", "name": "evil", "kind": "function",
                                  "file": bad_file, "line": 1})
            Path(path).write_text(json.dumps(data))
            with self.assertRaises(graph.CacheFormatError):
                graph.load(path)
        # load_or_build must silently rebuild rather than surface the pointer
        data = json.loads(json.dumps(good))
        data["nodes"].append({"id": "evil", "name": "evil", "kind": "function",
                              "file": "/etc/passwd", "line": 1})
        Path(path).write_text(json.dumps(data))
        rebuilt = graph.load_or_build(root)
        for n in rebuilt.nodes.values():
            self.assertTrue(graph._is_safe_relpath(n["file"]),
                            f"unsafe pointer survived rebuild: {n['file']!r}")

    def test_corrupt_cache_triggers_clean_rebuild(self):
        # Any unreadable/malformed/wrong-shaped cache must rebuild from source,
        # never crash the caller.
        root = tempfile.mkdtemp(prefix="eap-corrupt-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        Path(root, "ok.py").write_text("def ok():\n    pass\n")
        cpath = graph.cache_path(root)
        os.makedirs(os.path.dirname(cpath), exist_ok=True)
        corrupt_payloads = (
            b"\xff\xfe not utf-8 or json",             # UnicodeDecodeError
            b"{ this is : broken",                     # JSONDecodeError
            json.dumps({"nodes": "notalist"}).encode(),      # wrong shape
            json.dumps([1, 2, 3]).encode(),                  # top-level not a dict
            json.dumps({"nodes": [1], "links": []}).encode(),  # node not an object
            (b"[" * 100000 + b"]" * 100000),           # RecursionError in json.load
        )
        for corrupt in corrupt_payloads:
            Path(cpath).write_bytes(corrupt)
            g = graph.load_or_build(root)  # must NOT raise
            self.assertIn("ok", {n["name"] for n in g.nodes.values()})

    def test_mcp_rejects_bad_param_types(self):
        # Malformed params are a client error (-32602) caught at the boundary,
        # never an uncaught crash surfacing as -32603.
        engine = mcp.Engine(self.root)

        def q(params):
            r = mcp.handle_request(
                {"jsonrpc": "2.0", "id": 1, "method": "eap_graph_query",
                 "params": params}, engine)
            return r.get("error", {}).get("code")

        self.assertEqual(q({"query": "x", "depth": []}), -32602)
        self.assertEqual(q({"query": "x", "depth": True}), -32602)   # bool is not int
        self.assertEqual(q({"query": "x", "limit": {"a": 1}}), -32602)
        self.assertEqual(q({"query": 123}), -32602)                  # non-string query
        # float infinity: int(inf) raises OverflowError — must be caught at the
        # boundary as -32602, not surface as -32603 (Fix 4).
        self.assertEqual(q({"query": "x", "depth": float("inf")}), -32602)
        self.assertEqual(q({"query": "x", "limit": float("inf")}), -32602)

        def gn(params):
            r = mcp.handle_request(
                {"jsonrpc": "2.0", "id": 5, "method": "eap_graph_godnodes",
                 "params": params}, engine)
            return r.get("error", {}).get("code")

        self.assertEqual(gn({"top": float("inf")}), -32602)          # top inf too

        def nb(params):
            r = mcp.handle_request(
                {"jsonrpc": "2.0", "id": 2, "method": "eap_graph_neighbors",
                 "params": params}, engine)
            return r.get("error", {}).get("code")

        self.assertEqual(nb({"node": "x", "direction": "sideways"}), -32602)
        self.assertEqual(nb({"node": 5}), -32602)                    # non-string node

    def test_mcp_tools_call_rejects_non_dict_arguments(self):
        # A truthy non-dict `arguments` under tools/call previously reached the
        # tool impl and raised AttributeError -> -32603 INTERNAL_ERROR. It is a
        # client error: validate at dispatch and return -32602 INVALID_PARAMS.
        engine = mcp.Engine(self.root)

        def call(arguments):
            r = mcp.handle_request(
                {"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                 "params": {"name": "eap_graph_path", "arguments": arguments}},
                engine)
            return r.get("error", {}).get("code")

        self.assertEqual(call([1, 2, 3]), -32602)     # list
        self.assertEqual(call("string"), -32602)      # string
        self.assertEqual(call(42), -32602)            # int
        # Absent/empty arguments still succeed (default to {}); missing required
        # tool args become a tool-level error, not a dispatch crash.
        ok = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 10, "method": "tools/call",
             "params": {"name": "eap_graph_stats"}}, engine)
        self.assertNotIn("error", ok)

    def test_function_def_regex_stays_linear(self):
        # ReDoS regression (Fix 1): the old JS "function" pattern
        # `function\s*\*?\s*` had two adjacent unbounded \s* groups; \s crosses
        # newlines, so "function\n" + "\n"*N (each blank line < MAX_LINE_BYTES,
        # so _scannable does NOT neutralize it) drove O(N^2) backtracking. The
        # confined `function[ \t]*(?:\*[ \t]*)?` form cannot cross newlines.
        s = "function\n" + "\n" * 20000
        # prove the overlong-line guard does NOT neutralize this input (else the
        # test would be vacuous — the regex would never see the payload).
        self.assertEqual(extract._scannable(s), s)
        start = time.perf_counter()
        extract._extract_js(s, "t.js")
        self.assertLess(time.perf_counter() - start, 0.3,
                        "JS function-def regex is super-linear (ReDoS)")
        # same-line-spaces variant: many wide lines must not hang either.
        s2 = "\n".join(["function" + " " * 1999 for _ in range(400)])
        start = time.perf_counter()
        extract._extract_js(s2, "t.js")
        self.assertLess(time.perf_counter() - start, 0.3)

    def test_go_import_line_regex_stays_linear(self):
        # ReDoS regression (Fix 1 audit): the old UNANCHORED _GO_IMPORT_LINE
        # `(?:\w+\s+)?"..."` let finditer restart its greedy alias scan at every
        # offset inside a long word-run, so a crafted import-block body went
        # super-linear (an ~800KB .go file measured ~11s). Anchoring it per-line
        # (^…re.M, like every other def/import regex here) makes it linear.
        big = tempfile.mkdtemp(prefix="eap-go-redos-")
        self.addCleanup(shutil.rmtree, big, ignore_errors=True)
        # each line < MAX_LINE_BYTES so _scannable keeps it; no quotes; closed ')'
        body = "\n".join("a" * 1990 for _ in range(400))
        Path(big, "m.go").write_text("import (\n" + body + "\n)\n")
        start = time.perf_counter()
        extract.extract_file(os.path.join(big, "m.go"), "m.go")
        self.assertLess(time.perf_counter() - start, 1.0,
                        "_GO_IMPORT_LINE is super-linear (ReDoS)")

    def test_cache_rejects_non_int_line(self):
        # Fix 2: pointer() emits f"{file}:{line}", so a cache whose node "line"
        # is a non-int (e.g. "1\n/etc/passwd:1") would forge an absolute pointer
        # even though "file" passed the relpath check. load() must reject any
        # line that is not a positive int. build() only emits line >= 1, so this
        # rejects no valid cache.
        root = tempfile.mkdtemp(prefix="eap-line-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        Path(root, "mod.py").write_text("def ok():\n    pass\n")
        _, path = graph.build_and_save(root)
        good = json.loads(Path(path).read_text())
        for bad_line in ("1\n/etc/passwd:1", "/etc/passwd:1", 1.5, True, 0, -1):
            data = json.loads(json.dumps(good))  # deep copy
            data["nodes"].append({"id": "evil", "name": "x", "kind": "function",
                                  "file": "safe/mod.py", "line": bad_line})
            Path(path).write_text(json.dumps(data))
            with self.assertRaises(graph.CacheFormatError):
                graph.load(path)
        # a valid positive-int line still loads
        data = json.loads(json.dumps(good))
        data["nodes"].append({"id": "fine", "name": "x", "kind": "function",
                              "file": "safe/mod.py", "line": 1})
        Path(path).write_text(json.dumps(data))
        loaded = graph.load(path)
        self.assertEqual(loaded.pointer("fine"), "safe/mod.py:1")

    def test_mcp_build_root_confined(self):
        # Fix 5: eap_graph_build must confine a caller-supplied root to within
        # the server root — never index/write a cache under an arbitrary
        # absolute or ..-escaping directory.
        engine = mcp.Engine(self.root)

        def build_call(args):
            return mcp.handle_request(
                {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                 "params": {"name": "eap_graph_build", "arguments": args}}, engine)

        outside = tempfile.mkdtemp(prefix="eap-outside-")
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        self.assertEqual(build_call({"root": outside}).get("error", {}).get("code"),
                         -32602)
        self.assertEqual(build_call({"root": "/etc"}).get("error", {}).get("code"),
                         -32602)
        # build with no root still succeeds (defaults to the server root)
        r_default = build_call({})
        self.assertNotIn("error", r_default)
        self.assertFalse(r_default["result"]["isError"])
        # build with root == the server root still succeeds
        r_same = build_call({"root": self.root})
        self.assertNotIn("error", r_same)
        self.assertFalse(r_same["result"]["isError"])

    # -- security regressions (round 2: re-verification) ---------------------

    def test_go_import_block_stays_linear(self):
        # ReDoS regression (_GO_IMPORT_BLOCK): a .go file of many unterminated
        # "import (" lines drove O(N^2) through the old `([^)]*)\\)` group. The
        # str.find-based block resolver is linear.
        payload = "import (\n" * 20000
        start = time.perf_counter()
        extract._extract_go(payload, "t.go")
        self.assertLess(time.perf_counter() - start, 0.5,
                        "Go import-block extraction is super-linear (ReDoS)")
        # a real import block + func still extract correctly
        syms = extract._extract_go(
            'import (\n\t"fmt"\n\t_ "os"\n)\n\nfunc Run() {}\n', "t.go")
        names = {s["name"] for s in syms}
        self.assertIn("Run", names)
        self.assertIn("fmt", names)
        self.assertIn("os", names)

    def test_cache_rejects_control_chars_and_defaults_provenance(self):
        # A poisoned cache splices a newline into an output-bound string field
        # (name/kind/file, or a link relation) to forge an extra pointer/neighbor
        # line. load() must reject any control char, and default a missing link
        # provenance so neighbors() cannot KeyError.
        root = tempfile.mkdtemp(prefix="eap-ctrl-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        Path(root, "a.py").write_text(
            "def h():\n    return alpha()\n\n\ndef alpha():\n    pass\n")
        _, path = graph.build_and_save(root)
        good = json.loads(Path(path).read_text())

        for node in (
            {"id": "a.py::e", "name": "h\n/etc/passwd:1 x [f]", "kind": "function", "file": "a.py", "line": 2},
            {"id": "a.py::e", "name": "e", "kind": "function\n/etc/x:1", "file": "a.py", "line": 2},
            {"id": "a.py::e", "name": "e", "kind": "function", "file": "a.py\n/etc/x", "line": 2},
        ):
            data = json.loads(json.dumps(good))
            data["nodes"].append(node)
            Path(path).write_text(json.dumps(data))
            with self.assertRaises(graph.CacheFormatError):
                graph.load(path)

        # control char in a link field is rejected too
        data = json.loads(json.dumps(good))
        self.assertTrue(data["links"], "fixture must have at least one link")
        data["links"][0]["relation"] = "calls\n/etc/x:1 y [f]"
        Path(path).write_text(json.dumps(data))
        with self.assertRaises(graph.CacheFormatError):
            graph.load(path)

        # a link missing "provenance" loads (defaulted) and neighbors() is safe
        data = json.loads(json.dumps(good))
        for lk in data["links"]:
            lk.pop("provenance", None)
        Path(path).write_text(json.dumps(data))
        g = graph.load(path)  # must not raise
        for nid in g.nodes:
            query.neighbors(g, nid, "both")  # must not KeyError

    def test_mcp_build_rejects_non_string_root(self):
        # A non-string root reaches os.path.realpath (TypeError -> -32603) unless
        # validated at the boundary; it must be a clean -32602.
        engine = mcp.Engine(self.root)

        def code(root_val):
            r = mcp.handle_request(
                {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                 "params": {"name": "eap_graph_build",
                            "arguments": {"root": root_val}}}, engine)
            return r.get("error", {}).get("code")

        for bad in (123, ["/etc"], True, 1.5, {}):
            self.assertEqual(code(bad), -32602, f"root={bad!r} should be -32602")

    # -- security regressions (round 3: deep closure) ------------------------

    def test_extract_file_with_many_imports_is_linear(self):
        # Non-regex quadratic: _line_at was text.count("\\n", 0, pos) per symbol,
        # O(n^2) across a file with many symbols. A ~1MB Go file with a large
        # import block stalled extraction ~21s; the bisect line index is linear.
        root = tempfile.mkdtemp(prefix="eap-line-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        big = "import (\n" + ('\t"fmt"\n' * 60000) + ")\n"  # ~440KB, 60k imports
        Path(root, "f.go").write_text(big)
        start = time.perf_counter()
        syms = extract.extract_file(os.path.join(root, "f.go"), "f.go")
        self.assertLess(time.perf_counter() - start, 1.5,
                        "extract_file is super-linear in symbol count (_line_at)")
        self.assertGreater(len(syms), 50000)
        # line numbers are still correct after the index change
        js = extract._extract_js(
            'import x from "a"\n\nfunction foo() {}\n\nclass Bar {}\n', "w.js")
        by = {s["name"]: s["line"] for s in js}
        self.assertEqual(by["a"], 1)
        self.assertEqual(by["foo"], 3)
        self.assertEqual(by["Bar"], 5)

    def test_cache_rejects_dangling_link_endpoint(self):
        # A poisoned cache whose link references an undefined node loads past the
        # scalar checks, then crashes the read layer (g.nodes[endpoint]) with an
        # uncaught KeyError load_or_build can't catch. load() must reject it.
        root = tempfile.mkdtemp(prefix="eap-dangling-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        Path(root, "a.py").write_text("def foo():\n    return foo()\n")
        _, path = graph.build_and_save(root)
        data = json.loads(Path(path).read_text())
        data["links"].append({"source": "a.py::foo", "target": "ghost::ghost",
                              "relation": "calls", "provenance": "INFERRED"})
        Path(path).write_text(json.dumps(data))
        with self.assertRaises(graph.CacheFormatError):
            graph.load(path)
        # and load_or_build rebuilds cleanly rather than crashing
        g = graph.load_or_build(root)
        self.assertIn("foo", {n["name"] for n in g.nodes.values()})

    def test_mcp_build_rejects_nul_in_root(self):
        # os.path.realpath raises ValueError (not TypeError) on an embedded NUL;
        # a valid str like "a\\x00b" must be -32602, not a -32603 realpath crash.
        engine = mcp.Engine(self.root)
        for bad in ("\x00", "a\x00b", self.root + "\x00"):
            r = mcp.handle_request(
                {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                 "params": {"name": "eap_graph_build",
                            "arguments": {"root": bad}}}, engine)
            self.assertEqual(r.get("error", {}).get("code"), -32602,
                             f"root={bad!r} should be -32602")

    def test_mcp_server_runs_as_a_plain_script(self):
        # The installer registers the server as `python3 .../mcp.py <root>` —
        # DIRECT script execution with no package context. The module uses
        # relative imports (`from . import graph`), which raise ImportError as a
        # script unless the entry point bootstraps its package. The other tests
        # IMPORT the module, so they miss this; only a subprocess exec (exactly
        # how the agent launches it) catches a broken server that would fail for
        # every agent, Claude included.
        mcp_py = str(SRC / "eap_context" / "mcp.py")
        req = ('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
               '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n')
        proc = subprocess.run([sys.executable, mcp_py, self.root],
                              input=req, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        tools: set = set()
        for line in proc.stdout.splitlines():
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("id") == 2:
                tools = {t["name"] for t in obj["result"]["tools"]}
        self.assertIn("eap_graph_query", tools)
        self.assertIn("eap_graph_build", tools)
        self.assertIn("eap_graph_path", tools)
        self.assertIn("eap_graph_communities", tools)
        self.assertIn("eap_graph_central", tools)
        self.assertIn("eap_graph_affected", tools)
        self.assertIn("eap_graph_reflect", tools)
        self.assertEqual(len(tools), 12)


# ===========================================================================
# New-capability regressions: languages, graph algorithms, fuzzy, incremental.
# ===========================================================================

# Per-language fixtures. Each exercises functions/classes/methods, imports, and
# an intra-file reference so the ref-slice collector is covered too.
RUST_SRC = '''\
use std::collections::HashMap;
use crate::util::{helper, other};

pub fn compute(x: i32) -> i32 {
    helper(x)
}

async fn fetch() -> u32 { 0 }

pub struct Widget {
    count: u32,
}

enum Color { Red, Green }

trait Drawable {
    fn draw(&self);
}
'''

JAVA_SRC = '''\
package com.example;

import java.util.List;
import static java.lang.Math.PI;

public class Service {
    public void run() {
        helper();
    }
    private static int add(int a, int b) {
        return a + b;
    }
    public Service() {}
}

interface Repository {}
'''

C_SRC = '''\
#include <stdio.h>
#include "local.h"

int main(int argc, char **argv) {
    return compute(argc);
}

static void helper(void) {
    printf("hi");
}

struct Point { int x; };
'''

CPP_SRC = '''\
#include <vector>

class Widget : public Base {
public:
    void refresh();
};

void Widget::refresh() {
    render();
}

int Foo::bar() {
    return baz();
}
'''

CS_SRC = '''\
using System;
using System.Collections.Generic;

namespace App {
    public class Service {
        public void Run() {
            Helper();
        }
        private static int Add(int a, int b) {
            return a + b;
        }
    }
}
'''

RUBY_SRC = '''\
require 'json'
require_relative 'foo/bar'

class Store < Base
  def save(entry)
    parse(entry)
  end

  def self.build
  end
end

module Helpers
end
'''

PHP_SRC = '''\
<?php
namespace App;

use App\\Models\\User;

class Service extends Base {
    public function run() {
        $this->helper();
    }
    private function add($a, $b) {
        return $a + $b;
    }
}

interface Repository {}
'''


class NewLanguageExtractionTest(unittest.TestCase):
    """Each new regex language extracts functions/classes/imports/refs and stays
    linear-time on adversarial input (the same discipline as the JS/Go pair)."""

    def _symbols(self, name, src):
        d = tempfile.mkdtemp(prefix="eap-lang-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        Path(d, name).write_text(src)
        return extract.extract_file(os.path.join(d, name), name)

    def _extract(self, name, src):
        return {s["name"]: s for s in self._symbols(name, src)}

    def _assert_linear(self, name, adversarial):
        # each new extractor must finish an adversarial input well under a
        # generous ceiling — a re-introduced backtracking pattern blows past it.
        d = tempfile.mkdtemp(prefix="eap-lang-redos-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        Path(d, name).write_text(adversarial)
        start = time.perf_counter()
        extract.extract_file(os.path.join(d, name), name)
        self.assertLess(time.perf_counter() - start, 2.0,
                        f"{name} extractor is super-linear (ReDoS)")

    def test_rust(self):
        by = self._extract("m.rs", RUST_SRC)
        self.assertEqual(by["compute"]["kind"], "function")
        self.assertEqual(by["fetch"]["kind"], "function")
        self.assertEqual(by["Widget"]["kind"], "class")
        self.assertEqual(by["Color"]["kind"], "class")
        self.assertEqual(by["Drawable"]["kind"], "class")
        self.assertIn("helper", by["compute"]["refs"])
        self.assertEqual(by["HashMap"]["kind"], "import")
        # `use crate::util::{...}` keeps the module segment `util`
        self.assertIn("util", by)
        # newline flood + wide keyword lines both stay linear
        self._assert_linear("m.rs", "fn\n" + "\n" * 20000)
        self._assert_linear("m2.rs", "\n".join("pub " * 490 for _ in range(400)))

    def test_java(self):
        syms = self._symbols("M.java", JAVA_SRC)
        by = {s["name"]: s for s in syms}
        # `Service` is both a class and its constructor (a method) — both extract
        kinds = {(s["name"], s["kind"]) for s in syms}
        self.assertIn(("Service", "class"), kinds)
        self.assertIn(("Service", "method"), kinds)   # the constructor
        self.assertEqual(by["run"]["kind"], "method")
        self.assertEqual(by["add"]["kind"], "method")
        self.assertEqual(by["Repository"]["kind"], "class")
        self.assertIn("helper", by["run"]["refs"])
        self.assertEqual(by["List"]["kind"], "import")
        self.assertIn("PI", by)  # import static ...Math.PI
        self._assert_linear("M.java", "public\n" + "\n" * 20000)
        self._assert_linear("M2.java",
                            "\n".join("public static final abstract" for _ in range(20000)))

    def test_c(self):
        by = self._extract("m.c", C_SRC)
        self.assertEqual(by["main"]["kind"], "function")
        self.assertEqual(by["helper"]["kind"], "function")
        self.assertEqual(by["Point"]["kind"], "class")
        self.assertIn("compute", by["main"]["refs"])
        self.assertEqual(by["stdio"]["kind"], "import")
        self.assertIn("local", by)
        # the historically dangerous case: a return-type word + long space run
        # with no name/paren must not go O(n^2).
        self._assert_linear("m.c", "\n".join("int" + " " * 1900 for _ in range(400)))
        self._assert_linear("m2.c", "\n".join("a b c d e f g h" for _ in range(20000)))

    def test_cpp(self):
        by = self._extract("m.cpp", CPP_SRC)
        self.assertEqual(by["Widget"]["kind"], "class")
        # out-of-line member definitions keep their Class:: qualifier
        self.assertEqual(by["Widget::refresh"]["kind"], "function")
        self.assertEqual(by["Foo::bar"]["kind"], "function")
        self.assertIn("render", by["Widget::refresh"]["refs"])
        self.assertEqual(by["vector"]["kind"], "import")
        self._assert_linear("m.cpp", "\n".join("int" + " *" * 950 for _ in range(400)))

    def test_csharp(self):
        by = self._extract("M.cs", CS_SRC)
        self.assertEqual(by["Service"]["kind"], "class")
        self.assertEqual(by["Run"]["kind"], "method")
        self.assertEqual(by["Add"]["kind"], "method")
        self.assertIn("Helper", by["Run"]["refs"])
        self.assertEqual(by["Generic"]["kind"], "import")  # using System.Collections.Generic
        self._assert_linear("M.cs", "\n".join("public " * 280 for _ in range(400)))

    def test_ruby(self):
        by = self._extract("m.rb", RUBY_SRC)
        self.assertEqual(by["Store"]["kind"], "class")
        self.assertEqual(by["save"]["kind"], "method")
        self.assertEqual(by["build"]["kind"], "method")  # def self.build
        self.assertEqual(by["Helpers"]["kind"], "class")  # module
        self.assertIn("parse", by["save"]["refs"])
        self.assertIn("Base", by["Store"]["refs"])       # class Store < Base
        self.assertEqual(by["json"]["kind"], "import")
        self.assertIn("bar", by)                          # require_relative 'foo/bar'
        self._assert_linear("m.rb", "\n".join("def a" for _ in range(20000)))

    def test_php(self):
        by = self._extract("m.php", PHP_SRC)
        self.assertEqual(by["Service"]["kind"], "class")
        self.assertEqual(by["run"]["kind"], "function")
        self.assertEqual(by["add"]["kind"], "function")
        self.assertEqual(by["Repository"]["kind"], "class")
        self.assertIn("Base", by["Service"]["refs"])     # class Service extends Base
        self.assertEqual(by["User"]["kind"], "import")   # use App\Models\User
        self._assert_linear("m.php", "\n".join("function" + " " * 1900 for _ in range(400)))
        self._assert_linear("m2.php", "\n".join("public " * 280 for _ in range(400)))

    def test_new_languages_are_indexed_end_to_end(self):
        # a mixed-language tree builds a graph whose symbols span every new lang.
        root = tempfile.mkdtemp(prefix="eap-multilang-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        for name, src in (("m.rs", RUST_SRC), ("M.java", JAVA_SRC), ("m.c", C_SRC),
                          ("m.cpp", CPP_SRC), ("M.cs", CS_SRC), ("m.rb", RUBY_SRC),
                          ("m.php", PHP_SRC)):
            Path(root, name).write_text(src)
        g = graph.build(root)
        names = {n["name"] for n in g.nodes.values()}
        for want in ("compute", "Service", "main", "Widget::refresh", "Run",
                     "Store", "add"):
            self.assertIn(want, names)
        # every new extension reached CODE_EXTENSIONS + dispatch
        for ext in (".rs", ".java", ".c", ".h", ".cpp", ".cc", ".cxx",
                    ".hpp", ".hh", ".hxx", ".cs", ".rb", ".php"):
            self.assertIn(ext, extract.CODE_EXTENSIONS)


class GraphAlgorithmsTest(unittest.TestCase):
    """shortest_path / communities / centrality on a known two-clique fixture:
    cliques A={a1,a2,a3} and B={b1,b2,b3}, each a triangle, joined by one bridge
    a1--b1, plus an isolated node."""

    def _fixture(self):
        g = graph.SymbolGraph()
        for nid in ("a1", "a2", "a3", "b1", "b2", "b3", "iso"):
            g.add_node(nid, nid, "function", nid + ".py", 1)

        def link(s, t):
            g.add_edge(s, t, "calls", "EXTRACTED")

        link("a1", "a2"); link("a2", "a3"); link("a1", "a3")
        link("b1", "b2"); link("b2", "b3"); link("b1", "b3")
        link("a1", "b1")  # the only bridge
        return g

    def test_shortest_path(self):
        g = self._fixture()
        res = algorithms.shortest_path(g, "a3", "b3")
        self.assertTrue(res["found"])
        self.assertEqual(res["length"], 3)
        self.assertEqual([p["id"] for p in res["path"]], ["a3", "a1", "b1", "b3"])
        # pointers are file:line strings, never source text
        for p in res["pointers"]:
            self.assertRegex(p, r"^[\w./-]+:\d+  \S")
        # same node -> zero-length path
        self.assertEqual(algorithms.shortest_path(g, "a1", "a1")["length"], 0)
        # unreachable -> found False (not a crash)
        self.assertFalse(algorithms.shortest_path(g, "a1", "iso")["found"])
        # unknown symbol -> found False with a reason
        miss = algorithms.shortest_path(g, "a1", "nope")
        self.assertFalse(miss["found"])
        self.assertIn("nope", miss["error"])

    def test_communities(self):
        g = self._fixture()
        res = algorithms.communities(g)
        nc = res["node_community"]
        # each clique is one community; the single bridge does not merge them
        self.assertEqual(nc["a1"], nc["a2"])
        self.assertEqual(nc["a2"], nc["a3"])
        self.assertEqual(nc["b1"], nc["b2"])
        self.assertEqual(nc["b2"], nc["b3"])
        self.assertNotEqual(nc["a1"], nc["b1"])
        self.assertNotIn(nc["iso"], (nc["a1"], nc["b1"]))  # isolated -> own community
        # deterministic across runs
        self.assertEqual(json.dumps(algorithms.communities(g)),
                         json.dumps(algorithms.communities(g)))

    def test_centrality(self):
        g = self._fixture()
        res = algorithms.centrality(g, top=7)
        self.assertEqual(res["method"], "betweenness")  # small graph
        top2 = {res["central"][0]["id"], res["central"][1]["id"]}
        self.assertEqual(top2, {"a1", "b1"})  # the bridge endpoints
        # explicit degree method + determinism
        deg = algorithms.centrality(g, top=3, method="degree")
        self.assertEqual(deg["method"], "degree")
        self.assertEqual(json.dumps(algorithms.centrality(g, top=7)),
                         json.dumps(algorithms.centrality(g, top=7)))
        # the node-count guard forces degree fallback above the cap
        self.assertLessEqual(algorithms.BETWEENNESS_NODE_CAP, 100000)


class FuzzySeedTest(unittest.TestCase):
    """A misspelled query term still seeds via bounded Levenshtein over a
    trigram-pruned candidate set — but only as a fallback."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="eap-fuzzy-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        Path(self.root, "m.py").write_text(
            "def configure_widget(opts):\n    return opts\n\n"
            "def serialize_payload(x):\n    return x\n\n"
            "class InventoryManager:\n    def rebalance(self):\n        pass\n")
        self.graph = graph.build(self.root)

    def _seed_names(self, text):
        scored = query.seed_scores(self.graph, text)
        return [self.graph.nodes[nid]["name"] for _, nid in scored]

    def test_typo_still_seeds(self):
        # 'confgure' (dropped 'i') is edit-distance 1 from 'configure'
        names = self._seed_names("confgure")
        self.assertTrue(any("configure" in n for n in names),
                        f"typo did not seed: {names}")
        # a distance-1 typo on a CamelCase name token
        names2 = self._seed_names("inventorymanger")
        self.assertTrue(any("Inventory" in n for n in names2), names2)

    def test_exact_query_does_not_use_fuzzy(self):
        # an exact/substring query returns the real match and is unchanged by the
        # fuzzy fallback (which only fires when seeds are scarce).
        names = self._seed_names("configure widget")
        self.assertIn("configure_widget", names)

    def test_garbage_token_seeds_nothing(self):
        # far-from-everything token must not manufacture a bogus seed
        self.assertEqual(self._seed_names("zzzxqwvk"), [])

    def test_bounded_levenshtein(self):
        self.assertEqual(query._bounded_levenshtein("kitten", "sitting", 3), 3)
        self.assertEqual(query._bounded_levenshtein("abc", "abc", 2), 0)
        # cap: once the budget is blown it returns max_dist + 1, not the true cost
        self.assertEqual(query._bounded_levenshtein("abcdef", "uvwxyz", 2), 3)

    def test_trigram_index_prunes(self):
        idx = query.build_trigram_index(self.graph)
        self.assertIn("con", idx)  # from configure_widget
        # the index values are node ids; the configure_widget node is reachable
        # from its own trigrams
        hits = [nid for ids in idx.values() for nid in ids
                if "configure_widget" in nid]
        self.assertTrue(hits)


class IncrementalIndexingTest(unittest.TestCase):
    """Incremental re-index re-extracts only changed files and yields a graph
    byte-identical to a full build."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="eap-incr-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        Path(self.root, "a.py").write_text(
            "import json\n\ndef load(p):\n    return json.load(p)\n")
        Path(self.root, "b.py").write_text(
            "from a import load\n\ndef run():\n    return load('x')\n")
        Path(self.root, "c.py").write_text("def util():\n    return 1\n")

    def _spy_extract(self):
        calls = []
        orig = extract.extract_file_hashed

        def spy(path, rel=None):
            calls.append(rel)
            return orig(path, rel)

        extract.extract_file_hashed = spy
        self.addCleanup(setattr, extract, "extract_file_hashed", orig)
        return calls

    @staticmethod
    def _edge_set(g):
        return {(e["source"], e["target"], e["relation"]) for e in g.edges}

    def test_unchanged_tree_reextracts_nothing(self):
        graph.build_and_save(self.root)  # seed the fingerprint cache
        self.assertTrue(os.path.isfile(graph.file_index_path(self.root)))
        calls = self._spy_extract()
        g = graph.build(self.root, incremental=True)
        self.assertEqual(calls, [], f"unchanged files were re-extracted: {calls}")
        self.assertGreater(len(g.nodes), 0)

    def test_only_changed_file_reextracted_and_graph_matches_full(self):
        graph.build_and_save(self.root)  # snapshot current fingerprints
        # change ONE file; append so size differs (mtime-independent detection)
        Path(self.root, "b.py").write_text(
            "from a import load\n\ndef run():\n    return load('x')\n\n"
            "def extra():\n    return util()\n")
        calls = self._spy_extract()
        g_incr = graph.build(self.root, incremental=True)
        self.assertEqual(sorted(calls), ["b.py"],
                         f"incremental touched more than the changed file: {calls}")
        # identical to a from-scratch full build of the modified tree
        g_full = graph.build(self.root)
        self.assertEqual(g_incr.nodes, g_full.nodes)
        self.assertEqual(self._edge_set(g_incr), self._edge_set(g_full))
        # the new cross-file edge is present
        self.assertIn(("b.py::extra", "c.py::util", "calls"),
                      self._edge_set(g_incr))

    def test_deleted_file_falls_out(self):
        graph.build_and_save(self.root)
        os.remove(os.path.join(self.root, "c.py"))
        g = graph.build(self.root, incremental=True)
        self.assertNotIn("c.py::util", g.nodes)
        files = {n["file"] for n in g.nodes.values()}
        self.assertNotIn("c.py", files)

    def test_poisoned_file_index_is_ignored_not_trusted(self):
        # the fingerprint cache is untrusted input: an out-of-tree symbol path or
        # a control-char splice must drop the whole cache and force re-extraction,
        # never surface as a pointer.
        graph.build_and_save(self.root)
        fpath = graph.file_index_path(self.root)
        good = json.loads(Path(fpath).read_text())
        for poison in (
            {"a.py": {"size": 1, "mtime_ns": 1, "sha256": "x",
                      "symbols": [{"name": "evil", "kind": "function",
                                   "file": "/etc/passwd", "line": 1, "refs": []}]}},
            {"a.py": {"size": 1, "mtime_ns": 1, "sha256": "x",
                      "symbols": [{"name": "evil\n/etc/passwd:1", "kind": "function",
                                   "file": "a.py", "line": 1, "refs": []}]}},
            {"../evil.py": {"size": 1, "mtime_ns": 1, "sha256": "x", "symbols": []}},
        ):
            data = {"version": 1, "files": poison}
            Path(fpath).write_text(json.dumps(data))
            self.assertEqual(graph.load_file_index(self.root), {},
                             "poisoned fingerprint cache was trusted")
        # a valid cache still loads
        Path(fpath).write_text(json.dumps(good))
        self.assertGreater(len(graph.load_file_index(self.root)), 0)

    def test_corrupt_file_index_degrades_to_full_extraction(self):
        graph.build_and_save(self.root)
        fpath = graph.file_index_path(self.root)
        for corrupt in (b"\xff not json", b"{ broken",
                        json.dumps({"files": "notadict"}).encode(),
                        (b"[" * 100000 + b"]" * 100000)):  # RecursionError
            Path(fpath).write_bytes(corrupt)
            self.assertEqual(graph.load_file_index(self.root), {})  # no crash
            # a full incremental build still succeeds despite the bad cache
            g = graph.build(self.root, incremental=True)
            self.assertIn("load", {n["name"] for n in g.nodes.values()})

    def test_incremental_hash_reuse_on_mtime_bump(self):
        # C4: size + content byte-identical, only mtime bumped -> the sha guard
        # reuses cached symbols instead of re-extracting. Pre-fix (sha written but
        # never compared) the mtime bump forced a full re-extract of a.py.
        graph.build_and_save(self.root)
        os.utime(os.path.join(self.root, "a.py"), ns=(1, 1))  # bump mtime only
        calls = self._spy_extract()
        g = graph.build(self.root, incremental=True)
        self.assertEqual(calls, [],
                         f"content-identical mtime bump re-extracted: {calls}")
        self.assertIn("load", {n["name"] for n in g.nodes.values()})

    def test_load_or_build_detects_same_size_content_change(self):
        # C4 (top-priority correctness): a cached graph must NOT be served when a
        # file's CONTENT changed even though its byte-size AND mtime are
        # unchanged. Pre-fix, load_or_build returned the stale cache blindly.
        p = Path(self.root, "a.py")
        p.write_text("def alpha():\n    return 1\n")
        graph.build_and_save(self.root)  # cache holds `alpha`
        st = os.stat(p)
        p.write_text("def bravo():\n    return 1\n")  # SAME byte length
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))  # restore old mtime
        self.assertEqual(os.stat(p).st_size, st.st_size)  # size truly identical
        g = graph.load_or_build(self.root)
        names = {n["name"] for n in g.nodes.values()}
        self.assertIn("bravo", names, "content change (same size+mtime) not picked up")
        self.assertNotIn("alpha", names, "stale symbol survived the sha guard")

    def test_load_or_build_rebuild_is_incremental(self):
        # when the graph cache is missing, load_or_build rebuilds reusing the
        # fingerprint cache — only genuinely changed files are re-extracted.
        graph.build_and_save(self.root)
        os.remove(graph.cache_path(self.root))  # graph gone, fingerprints remain
        calls = self._spy_extract()
        g = graph.load_or_build(self.root)
        self.assertEqual(calls, [], "load_or_build rebuild ignored the cache")
        self.assertGreater(len(g.nodes), 0)


class NewAlgorithmToolsTest(unittest.TestCase):
    """The three new graph-algorithm MCP tools dispatch and validate params."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="eap-algo-mcp-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        Path(self.root, "a.py").write_text(
            "def load(p):\n    return read(p)\n\ndef read(p):\n    return p\n")
        Path(self.root, "b.py").write_text(
            "from a import load\n\ndef run():\n    return load('x')\n")
        self.engine = mcp.Engine(self.root)

    def _call(self, name, args):
        return mcp.handle_request(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": name, "arguments": args}}, self.engine)

    def _payload(self, name, args):
        return json.loads(self._call(name, args)["result"]["content"][0]["text"])

    def test_path_tool(self):
        res = self._payload("eap_graph_path", {"source": "run", "target": "read"})
        self.assertTrue(res["found"])
        self.assertEqual([p["name"] for p in res["path"]], ["run", "load", "read"])

    def test_communities_tool(self):
        res = self._payload("eap_graph_communities", {})
        self.assertGreaterEqual(res["count"], 1)
        self.assertIn("communities", res)

    def test_central_tool(self):
        res = self._payload("eap_graph_central", {"top": 3})
        self.assertIn(res["method"], ("betweenness", "degree"))
        self.assertLessEqual(len(res["central"]), 3)

    def test_new_tools_validate_params(self):
        # missing required path endpoint -> -32602
        self.assertEqual(
            self._call("eap_graph_path", {"source": "run"}).get("error", {}).get("code"),
            -32602)
        # unknown centrality method -> -32602
        self.assertEqual(
            self._call("eap_graph_central", {"method": "pagerank"})
            .get("error", {}).get("code"), -32602)
        # non-int min_size for communities -> -32602
        self.assertEqual(
            self._call("eap_graph_communities", {"min_size": float("inf")})
            .get("error", {}).get("code"), -32602)

    def test_build_incremental_param(self):
        res = self._payload("eap_graph_build", {"incremental": True})
        self.assertTrue(res["incremental"])
        self.assertGreater(res["nodes"], 0)


class QueryCorrectnessAndPerfTest(unittest.TestCase):
    """C1/C2/C3/C6 query fixes and C5 engine cache reload."""

    def _build(self, files):
        root = tempfile.mkdtemp(prefix="eap-qfix-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        for name, body in files.items():
            Path(root, name).write_text(body)
        return root, graph.build(root)

    def test_god_nodes_exclude_module_nodes(self):
        # C2: a big file's synthetic `module` node has the highest raw degree
        # (one `defines` edge per symbol) but is structural noise, not a hub.
        src = "".join(f"def f{i}():\n    return {i}\n\n" for i in range(12))
        _, g = self._build({"m.py": src})
        # threshold=1 forces every node past the hub cut, so only the module
        # filter can keep the module node out.
        gods = query.god_nodes(g, top=10, threshold=1)
        ids = {n["id"] for n in gods}
        self.assertNotIn("m.py", ids)  # module node id is the relpath
        self.assertFalse(any(n["kind"] == "module" for n in gods))

    def test_seed_selection_guarantees_each_query_token(self):
        # C3: token 'handler' exact-matches 8 symbols (they crowd the score-
        # sorted top slice); token 'payload' only substring-matches ONE symbol.
        # Per-token coverage must still seed that payload node.
        src = "".join(f"def handler_{c}(x):\n    return x\n\n"
                      for c in "abcdefgh")
        src += "def serialize_payloader(y):\n    return y\n"
        _, g = self._build({"m.py": src})
        res = query.query(g, "handler payload")
        seed_names = {g.nodes[s]["name"] for s in res["seeds"]}
        self.assertTrue(any("payload" in n for n in seed_names),
                        f"substring-only token was not seeded: {seed_names}")
        # sanity: the crowding term did seed too
        self.assertTrue(any("handler" in n for n in seed_names), seed_names)

    def test_query_stopwords_filtered(self):
        # C6: stopwords must not drive seeding. 'work' would otherwise substring-
        # match 'worker'; only 'cache' should seed.
        _, g = self._build({"m.py":
            "def cache_lookup(k):\n    return k\n\n"
            "def worker():\n    return 1\n"})
        scored = query.seed_scores(g, "how does the cache work")
        names = [g.nodes[nid]["name"] for _, nid in scored]
        self.assertTrue(names, "stopword-heavy query seeded nothing")
        self.assertEqual(names[0], "cache_lookup")
        self.assertNotIn("worker", names)
        # a symbol literally named a stopword stays findable (node tokens are
        # never filtered; all-stopword query falls back to unfiltered)
        _, g2 = self._build({"n.py": "def work():\n    return 1\n"})
        self.assertTrue(query.seed_scores(g2, "work"))

    def test_query_memoization_is_stable_and_populated(self):
        # C1: caches are pure functions of graph state -> byte-identical results
        # across runs, and the cache dicts fill on first use.
        _, g = self._build({"m.py": "def parse_entry(x):\n    return x\n"})
        self.assertEqual(g._node_tokens_cache, {})
        self.assertEqual(g._idf_cache, {})
        r1 = query.query(g, "parse entry")
        self.assertTrue(g._node_tokens_cache, "node-token cache not populated")
        self.assertTrue(g._idf_cache, "idf cache not populated")
        r2 = query.query(g, "parse entry")
        self.assertEqual(r1, r2, "memoized query output drifted")

    def test_engine_reloads_graph_on_cache_change(self):
        # C5: the MCP engine must reload when the on-disk cache changes, or a
        # symbol added by a later rebuild stays invisible to the pinned graph.
        root = tempfile.mkdtemp(prefix="eap-reload-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        Path(root, "m.py").write_text("def alpha():\n    return 1\n")
        graph.build_and_save(root)
        engine = mcp.Engine(root)
        r1 = engine.query({"query": "alpha"})
        self.assertIn("alpha", {n["name"] for n in r1["nodes"]})
        # rebuild with a new symbol (rewrites graph.json -> new mtime/size)
        Path(root, "m.py").write_text(
            "def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n")
        graph.build_and_save(root)
        r2 = engine.query({"query": "beta"})
        self.assertIn("beta", {n["name"] for n in r2["nodes"]},
                      "engine served a stale graph after the cache changed")


# ===========================================================================
# Workstream C: .eapignore, affected, git hooks, PR tooling, HTTP, reflect.
# ===========================================================================

from eap_context import hooks, ignore, prs, reflect  # noqa: E402


class EapignoreTest(unittest.TestCase):
    """.eapignore (gitignore syntax) merged with .gitignore drives the walk."""

    def test_eapignore_merged_with_gitignore(self):
        root = tempfile.mkdtemp(prefix="eap-ignore-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        Path(root, "a.py").write_text("def alpha():\n    pass\n")
        Path(root, "skip_one.py").write_text("def s_one():\n    pass\n")
        Path(root, "skip_keep.py").write_text("def s_keep():\n    pass\n")
        Path(root, "gen").mkdir()
        Path(root, "gen", "g.py").write_text("def gee():\n    pass\n")
        Path(root, "logs").mkdir()
        Path(root, "logs", "l.py").write_text("def ell():\n    pass\n")
        Path(root, ".gitignore").write_text("logs/\n")
        Path(root, ".eapignore").write_text(
            "# generated code\ngen/\nskip_*.py\n!skip_keep.py\n")
        g = graph.build(root)
        names = {n["name"] for n in g.nodes.values()}
        self.assertIn("alpha", names)
        self.assertIn("s_keep", names, "negation (!) did not re-include")
        self.assertNotIn("s_one", names, ".eapignore glob not applied")
        self.assertNotIn("gee", names, ".eapignore dir pattern not applied")
        self.assertNotIn("ell", names, ".gitignore not merged")
        # without ignore files, everything is indexed (rules are additive only)
        os.remove(os.path.join(root, ".gitignore"))
        os.remove(os.path.join(root, ".eapignore"))
        names_all = {n["name"] for n in graph.build(root).nodes.values()}
        for want in ("alpha", "s_one", "s_keep", "gee", "ell"):
            self.assertIn(want, names_all)

    def test_pattern_semantics(self):
        r = ignore.IgnoreRules([c for c in map(ignore._compile, [
            "*.log", "build/", "/top.py", "docs/**", "!docs/keep.md",
        ]) if c])
        self.assertTrue(r.ignored("x/y/err.log", False))     # bare glob, any depth
        self.assertTrue(r.ignored("build", True))            # dir-only pattern
        self.assertFalse(r.ignored("build", False))          # ...not a plain file
        self.assertTrue(r.ignored("top.py", False))          # anchored
        self.assertFalse(r.ignored("sub/top.py", False))     # anchored: not nested
        self.assertTrue(r.ignored("docs/a/b.md", False))     # ** crosses dirs
        self.assertFalse(r.ignored("docs/keep.md", False))   # last match wins (!)


class AffectedTest(unittest.TestCase):
    """affected(): bounded reverse-dependency closure grouped by distance."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="eap-affected-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        Path(self.root, "a.py").write_text("def base():\n    return 1\n")
        Path(self.root, "b.py").write_text(
            "from a import base\n\ndef mid():\n    return base()\n")
        Path(self.root, "c.py").write_text(
            "from b import mid\n\ndef top():\n    return mid()\n")
        self.graph = graph.build(self.root)

    @staticmethod
    def _ids_at(result, distance):
        for group in result["affected"]:
            if group["distance"] == distance:
                return {s["id"] for s in group["symbols"]}
        return set()

    def test_explicit_files_closure_by_distance(self):
        res = algorithms.affected(self.graph, files=["a.py"], root=self.root,
                                  depth=2)
        self.assertEqual(res["matched_files"], ["a.py"])
        self.assertIn("a.py::base", self._ids_at(res, 0))
        self.assertIn("b.py::mid", self._ids_at(res, 1),
                      "direct dependent missing from distance 1")
        self.assertIn("c.py::top", self._ids_at(res, 2),
                      "transitive dependent missing from distance 2")
        # every pointer is file:line, never source text
        for p in res["pointers"]:
            self.assertRegex(p, r"^d=\d+  [\w./-]+:\d+  \S")
        # depth bound holds: depth=1 must not reach c.py::top
        shallow = algorithms.affected(self.graph, files=["a.py"],
                                      root=self.root, depth=1)
        self.assertNotIn("c.py::top",
                         {s["id"] for grp in shallow["affected"]
                          for s in grp["symbols"]})

    def test_git_ref_and_validation(self):
        # a hostile "ref" must never reach git argv as an option
        self.assertIn("error",
                      algorithms.affected(self.graph, ref="--upload-pack=/bin/sh",
                                          root=self.root))
        self.assertIn("error", algorithms.affected(self.graph, root=self.root))
        # real git plumbing (skipped where git is unavailable)
        if shutil.which("git") is None:
            self.skipTest("git not installed")
        env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null",
               "GIT_CONFIG_SYSTEM": "/dev/null"}
        run = lambda *a: subprocess.run(  # noqa: E731
            ["git", "-C", self.root, *a], capture_output=True, text=True, env=env)
        run("init", "-q")
        run("config", "user.email", "t@e.st")
        run("config", "user.name", "t")
        run("add", "-A")
        run("commit", "-qm", "init")
        Path(self.root, "a.py").write_text("def base():\n    return 2\n")
        res = algorithms.affected(self.graph, ref="HEAD", root=self.root, depth=2)
        self.assertEqual(res["changed_files"], ["a.py"])
        self.assertIn("b.py::mid", self._ids_at(res, 1))

    def test_mcp_affected_tool(self):
        engine = mcp.Engine(self.root)

        def call(args):
            return mcp.handle_request(
                {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                 "params": {"name": "eap_graph_affected", "arguments": args}},
                engine)

        res = call({"files": ["a.py"], "depth": 2})
        payload = json.loads(res["result"]["content"][0]["text"])
        self.assertGreaterEqual(payload["total"], 3)
        # neither files nor ref, and bad types -> -32602
        self.assertEqual(call({}).get("error", {}).get("code"), -32602)
        self.assertEqual(call({"files": "a.py"}).get("error", {}).get("code"),
                         -32602)
        self.assertEqual(call({"ref": 7}).get("error", {}).get("code"), -32602)


class GitHookTest(unittest.TestCase):
    """hook install/uninstall: quiet incremental rebuild, chained originals."""

    def setUp(self):
        if shutil.which("git") is None:
            self.skipTest("git not installed")
        self.root = tempfile.mkdtemp(prefix="eap-hook-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null",
                    "GIT_CONFIG_SYSTEM": "/dev/null"}
        self._git("init", "-q")
        self._git("config", "user.email", "t@e.st")
        self._git("config", "user.name", "t")

    def _git(self, *args):
        return subprocess.run(["git", "-C", self.root, *args],
                              capture_output=True, text=True, env=self.env)

    def test_install_chains_and_uninstall_restores(self):
        legacy = "#!/bin/sh\necho legacy > legacy.out\n"
        hooks_dir = os.path.join(self.root, ".git", "hooks")
        os.makedirs(hooks_dir, exist_ok=True)
        Path(hooks_dir, "post-commit").write_text(legacy)
        os.chmod(os.path.join(hooks_dir, "post-commit"), 0o755)

        res = hooks.install(self.root)
        self.assertEqual(sorted(res["installed"]),
                         ["post-checkout", "post-commit"])
        self.assertEqual(res["chained"], ["post-commit"])
        installed = Path(hooks_dir, "post-commit").read_text()
        self.assertIn(hooks.MARKER, installed)
        self.assertIn("--update", installed)
        self.assertEqual(Path(hooks_dir, "post-commit.pre-eap").read_text(),
                         legacy)
        # reinstall is idempotent: our own hook is refreshed, not backed up
        res2 = hooks.install(self.root)
        self.assertEqual(res2["chained"], [])
        self.assertEqual(Path(hooks_dir, "post-commit.pre-eap").read_text(),
                         legacy)

        # a real commit fires the hook: graph rebuilt AND the legacy hook ran
        Path(self.root, "m.py").write_text("def committed():\n    pass\n")
        self._git("add", "-A")
        proc = self._git("commit", "-qm", "x")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(os.path.isfile(graph.cache_path(self.root)),
                        "post-commit hook did not rebuild the graph")
        g = graph.load(graph.cache_path(self.root))
        self.assertIn("committed", {n["name"] for n in g.nodes.values()})
        self.assertTrue(os.path.isfile(os.path.join(self.root, "legacy.out")),
                        "pre-existing hook was not chained")

        res3 = hooks.uninstall(self.root)
        self.assertIn("post-commit", res3["removed"])
        self.assertEqual(res3["restored"], ["post-commit"])
        self.assertEqual(Path(hooks_dir, "post-commit").read_text(), legacy)
        self.assertFalse(os.path.exists(
            os.path.join(hooks_dir, "post-checkout")))

    def test_not_a_repo_is_a_clean_error(self):
        plain = tempfile.mkdtemp(prefix="eap-norepo-")
        self.addCleanup(shutil.rmtree, plain, ignore_errors=True)
        self.assertIn("error", hooks.install(plain))
        self.assertIn("error", hooks.uninstall(plain))


class PrToolingTest(unittest.TestCase):
    """prs/pr_impact ride the gh CLI and degrade gracefully without it."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="eap-prs-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        Path(self.root, "a.py").write_text("def base():\n    return 1\n")
        Path(self.root, "b.py").write_text(
            "from a import base\n\ndef mid():\n    return base()\n")
        self.graph = graph.build(self.root)

    def _patch_gh(self, fn):
        orig = prs._run_gh
        prs._run_gh = fn
        self.addCleanup(setattr, prs, "_run_gh", orig)

    def test_missing_gh_is_a_graceful_error(self):
        orig = prs.shutil.which
        prs.shutil.which = lambda name: None
        self.addCleanup(setattr, prs.shutil, "which", orig)
        for res in (prs.list_prs(self.root),
                    prs.pr_impact(self.graph, 1, root=self.root)):
            self.assertIn("error", res)
            self.assertIn("gh CLI not found", res["error"])
            self.assertIn("cli.github.com", res["error"])
        # via MCP: an error payload, never a crash / -32603
        engine = mcp.Engine(self.root)
        r = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": "eap_graph_prs", "arguments": {}}}, engine)
        self.assertNotIn("error", r)  # JSON-RPC level ok
        self.assertIn("gh CLI not found",
                      json.loads(r["result"]["content"][0]["text"])["error"])

    def test_pr_list_and_impact_with_canned_gh(self):
        def fake_gh(args, root):
            if args[:2] == ["pr", "list"]:
                return [{"number": 7, "title": "t", "url": "u",
                         "headRefName": "br", "updatedAt": "now",
                         "author": {"login": "dev"}}], None
            if args[:2] == ["pr", "view"]:
                return {"number": 7, "title": "t", "url": "u",
                        "files": [{"path": "a.py"}]}, None
            return None, "unexpected gh call"

        self._patch_gh(fake_gh)
        listing = prs.list_prs(self.root)
        self.assertEqual(listing["count"], 1)
        self.assertEqual(listing["prs"][0]["author"], "dev")
        impact = prs.pr_impact(self.graph, 7, root=self.root, depth=2)
        self.assertEqual(impact["number"], 7)
        ids = {s["id"] for grp in impact["affected"] for s in grp["symbols"]}
        self.assertIn("a.py::base", ids)
        self.assertIn("b.py::mid", ids)
        # bad PR numbers are rejected before gh runs
        self.assertIn("error", prs.pr_impact(self.graph, 0, root=self.root))
        self.assertIn("error", prs.pr_impact(self.graph, True, root=self.root))
        # MCP surface: missing number -> -32602
        engine = mcp.Engine(self.root)
        r = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": "eap_graph_pr_impact", "arguments": {}}}, engine)
        self.assertEqual(r["error"]["code"], -32602)


class HttpTransportTest(unittest.TestCase):
    """serve --transport http: keyed, POST-only, bounded, same dispatch."""

    @classmethod
    def setUpClass(cls):
        import threading
        cls.root = tempfile.mkdtemp(prefix="eap-http-")
        Path(cls.root, "m.py").write_text("def handler():\n    return 1\n")
        graph.build_and_save(cls.root)
        cls.key = "test-key-123"
        cls.server, key = mcp.make_http_server(cls.root, host="127.0.0.1",
                                               port=0, api_key=cls.key)
        assert key == cls.key
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.root, ignore_errors=True)

    def _post(self, body: bytes, headers=None):
        import urllib.error
        import urllib.request
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/", data=body, method="POST",
            headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def test_key_required_and_query_served(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1,
                           "method": "eap_graph_query",
                           "params": {"query": "handler"}}).encode()
        # no key / wrong key -> 401, no result leaks
        status, raw = self._post(body)
        self.assertEqual(status, 401)
        self.assertNotIn(b"pointers", raw)
        status, _ = self._post(body, {"X-API-Key": "wrong"})
        self.assertEqual(status, 401)
        # right key -> 200 with pointers; Bearer form works too
        for headers in ({"X-API-Key": self.key},
                        {"Authorization": f"Bearer {self.key}"}):
            status, raw = self._post(body, headers)
            self.assertEqual(status, 200)
            res = json.loads(raw)
            self.assertTrue(res["result"]["pointers"])
        # notification -> 204, no body
        note = json.dumps({"jsonrpc": "2.0",
                           "method": "notifications/initialized"}).encode()
        status, raw = self._post(note, {"X-API-Key": self.key})
        self.assertEqual(status, 204)
        self.assertEqual(raw, b"")

    def test_non_post_rejected(self):
        import urllib.error
        import urllib.request
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/",
            headers={"X-API-Key": self.key})  # GET
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 405)

    def test_oversized_body_rejected(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(conn.close)
        conn.putrequest("POST", "/")
        conn.putheader("X-API-Key", self.key)
        conn.putheader("Content-Length", str(mcp.MAX_HTTP_BODY + 1))
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)


class ReflectAndQuerylogTest(unittest.TestCase):
    """Query log JSONL + reflect tag overlay on seed scoring."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="eap-reflect-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        Path(self.root, "m.py").write_text(
            "def alpha_handler():\n    return 1\n\n\n"
            "def beta_handler():\n    return 2\n")
        graph.build_and_save(self.root)

    def test_querylog_appends_jsonl(self):
        engine = mcp.Engine(self.root)
        engine.query({"query": "handler"})
        engine.query({"query": "alpha"})
        log_path = reflect.querylog_path(self.root)
        self.assertTrue(log_path.endswith(
            os.path.join(".eap", "context", "querylog.jsonl")))
        lines = Path(log_path).read_text().splitlines()
        self.assertEqual(len(lines), 2)  # append-only, one record per query
        rec = json.loads(lines[0])
        self.assertEqual(rec["tool"], "eap_graph_query")
        self.assertEqual(rec["args"]["query"], "handler")
        self.assertTrue(rec["top"])
        self.assertIn("ts", rec)
        for p in rec["top"]:
            self.assertNotIn("def ", p)  # pointers, never source text

    def test_reflect_tags_bias_ranking(self):
        engine = mcp.Engine(self.root)
        # equal-scoring symbols: alpha wins the id tie-break by default
        base = engine.query({"query": "handler"})
        names = [n["name"] for n in base["nodes"] if n["kind"] == "function"]
        self.assertEqual(names[0], "alpha_handler")
        # tag beta preferred -> it outranks alpha
        res = engine.reflect({"nodes": ["beta_handler"], "tag": "preferred"})
        self.assertEqual(res["nodes"], ["m.py::beta_handler"])
        self.assertTrue(os.path.isfile(reflect.reflect_path(self.root)))
        boosted = engine.query({"query": "handler"})
        names = [n["name"] for n in boosted["nodes"] if n["kind"] == "function"]
        self.assertEqual(names[0], "beta_handler",
                         "preferred tag did not boost ranking")
        # contested pushes it back down
        engine.reflect({"nodes": ["beta_handler"], "tag": "contested"})
        names = [n["name"] for n in engine.query({"query": "handler"})["nodes"]
                 if n["kind"] == "function"]
        self.assertEqual(names[0], "alpha_handler")
        # clear restores neutrality and unknown refs are reported, not fatal
        cleared = engine.reflect({"nodes": ["beta_handler", "ghost"],
                                  "tag": "clear"})
        self.assertEqual(cleared["unknown"], ["ghost"])
        self.assertEqual(reflect.load_tags(self.root), {})
        # bad params at the MCP boundary -> -32602
        r = mcp.handle_request(
            {"jsonrpc": "2.0", "id": 1, "method": "eap_graph_reflect",
             "params": {"nodes": ["x"], "tag": "amazing"}}, engine)
        self.assertEqual(r["error"]["code"], -32602)

    def test_malformed_reflect_file_degrades_to_no_tags(self):
        os.makedirs(reflect.context_dir(self.root), exist_ok=True)
        for payload in (b"{ broken", b"[1,2]",
                        json.dumps({"m.py::x": "bogus-tag"}).encode()):
            Path(reflect.reflect_path(self.root)).write_bytes(payload)
            self.assertEqual(reflect.load_tags(self.root), {})


if __name__ == "__main__":
    unittest.main()
