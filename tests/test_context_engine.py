"""Tests for the EAP-Context symbol-graph engine (stdlib only).

Run either way from the repo root:

    python3 tests/test_context_engine.py
    python3 -m unittest tests.test_context_engine
"""

import json
import os
import re
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "layers" / "eap-context" / "src"
sys.path.insert(0, str(SRC))

from eap_context import extract, graph, mcp, query  # noqa: E402

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
            "eap_graph_stats", "eap_graph_godnodes"})

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


if __name__ == "__main__":
    unittest.main()
