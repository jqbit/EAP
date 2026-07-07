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


if __name__ == "__main__":
    unittest.main()
