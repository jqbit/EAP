"""Graph export: GraphML + minimal HTML/SVG. Stdlib only (xml.etree, html).

No D3, no networkx, no browser framework — a readable GraphML file for Gephi /
yEd, and a simple force-free SVG layout (deterministic grid / circle) embedded
in a tiny HTML page.
"""

from __future__ import annotations

import html
import math
import os
import xml.etree.ElementTree as ET

from .graph import SymbolGraph

GLOBAL_DIR = os.path.join(os.path.expanduser("~"), ".eap", "global")


def export_graphml(g: SymbolGraph, path: str) -> str:
    """Write GraphML of *g* to *path*; returns *path*."""
    NS = "http://graphml.graphdrawing.org/xmlns"
    ET.register_namespace("", NS)
    root = ET.Element(f"{{{NS}}}graphml")
    for key_id, attr_name, for_, atype in (
        ("d0", "name", "node", "string"),
        ("d1", "kind", "node", "string"),
        ("d2", "file", "node", "string"),
        ("d3", "line", "node", "int"),
        ("d4", "relation", "edge", "string"),
        ("d5", "provenance", "edge", "string"),
    ):
        ET.SubElement(root, f"{{{NS}}}key", id=key_id,
                      **{"for": for_, "attr.name": attr_name,
                         "attr.type": atype})
    graph_el = ET.SubElement(root, f"{{{NS}}}graph", id="G",
                             edgedefault="directed")
    # GraphML ids must be XML-safe; use a compact index map.
    id_map = {nid: f"n{i}" for i, nid in enumerate(sorted(g.nodes))}
    for nid, node in sorted(g.nodes.items()):
        n_el = ET.SubElement(graph_el, f"{{{NS}}}node", id=id_map[nid])
        for key, val in (("d0", node["name"]), ("d1", node["kind"]),
                         ("d2", node["file"]), ("d3", str(node["line"]))):
            d = ET.SubElement(n_el, f"{{{NS}}}data", key=key)
            d.text = val
    for i, e in enumerate(g.edges):
        if e["source"] not in id_map or e["target"] not in id_map:
            continue
        e_el = ET.SubElement(
            graph_el, f"{{{NS}}}edge", id=f"e{i}",
            source=id_map[e["source"]], target=id_map[e["target"]])
        for key, val in (("d4", e["relation"]), ("d5", e.get("provenance", ""))):
            d = ET.SubElement(e_el, f"{{{NS}}}data", key=key)
            d.text = val
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    tree = ET.ElementTree(root)
    tree.write(path, encoding="utf-8", xml_declaration=True)
    return path


def export_svg(g: SymbolGraph, path: str, max_nodes: int = 200) -> str:
    """Write a deterministic circular SVG layout (top-*max_nodes* by degree)."""
    ranked = sorted(g.nodes, key=lambda n: (-g.degree(n), n))[:max_nodes]
    n = len(ranked)
    size = 800
    cx = cy = size / 2
    r = size * 0.4
    pos = {}
    for i, nid in enumerate(ranked):
        if n == 1:
            pos[nid] = (cx, cy)
        else:
            ang = 2 * math.pi * i / n
            pos[nid] = (cx + r * math.cos(ang), cy + r * math.sin(ang))
    chosen = set(ranked)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">',
        '<rect width="100%" height="100%" fill="#fafafa"/>',
    ]
    for e in g.edges:
        if e["source"] in chosen and e["target"] in chosen:
            x1, y1 = pos[e["source"]]
            x2, y2 = pos[e["target"]]
            parts.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                f'stroke="#bbb" stroke-width="1"/>')
    for nid in ranked:
        x, y = pos[nid]
        label = html.escape(g.nodes[nid]["name"][:40])
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="#333"/>'
            f'<text x="{x + 6:.1f}" y="{y + 3:.1f}" font-size="9" '
            f'font-family="monospace">{label}</text>')
    parts.append("</svg>")
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))
    return path


def export_html(g: SymbolGraph, path: str, max_nodes: int = 200) -> str:
    """Minimal HTML shell embedding the SVG export inline."""
    svg_path = path + ".partial.svg"
    export_svg(g, svg_path, max_nodes=max_nodes)
    with open(svg_path, encoding="utf-8") as fh:
        svg = fh.read()
    try:
        os.remove(svg_path)
    except OSError:
        pass
    meta = g.meta or {}
    title = html.escape(str(meta.get("root", "eap-context graph")))
    body = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        f"<title>{title}</title></head><body>"
        f"<h1>{title}</h1>"
        f"<p>{meta.get('nodes', len(g.nodes))} nodes / "
        f"{meta.get('edges', len(g.edges))} edges</p>"
        f"{svg}</body></html>"
    )
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    return path


def merge_graphs(graphs: list[SymbolGraph],
                 namespace_by_root: bool = True) -> SymbolGraph:
    """Union graphs; optionally prefix node ids with each root basename."""
    out = SymbolGraph()
    for g in graphs:
        root = (g.meta or {}).get("root", "graph")
        prefix = (os.path.basename(os.path.abspath(root)) + "::"
                  if namespace_by_root else "")
        id_map: dict[str, str] = {}
        for nid, node in g.nodes.items():
            new_id = prefix + nid
            # file stays as stored; namespaced for multi-repo clarity
            file = (prefix + node["file"]) if namespace_by_root else node["file"]
            actual = out.add_node(new_id, node["name"], node["kind"],
                                  file, node["line"])
            id_map[nid] = actual
            if "community" in node:
                out.nodes[actual]["community"] = node["community"]
        for e in g.edges:
            s, t = id_map.get(e["source"]), id_map.get(e["target"])
            if s and t:
                out.add_edge(s, t, e["relation"], e.get("provenance", "EXTRACTED"))
    out.meta = {
        "merged": len(graphs),
        "nodes": len(out.nodes),
        "edges": len(out.edges),
    }
    return out


def save_global(g: SymbolGraph, name: str = "merged") -> str:
    """Optional cross-repo cache under ``~/.eap/global/<name>.json``."""
    from . import graph as graph_mod
    os.makedirs(GLOBAL_DIR, exist_ok=True)
    path = os.path.join(GLOBAL_DIR, f"{name}.json")
    return graph_mod.save(g, path)
