"""EAP-Context — stdlib-only code symbol-graph engine (input membrane).

Indexes a codebase into a symbol graph and answers queries with a small
subgraph plus file:line pointers instead of file contents.

Concept-derived from the MIT-licensed graphify project (see repo NOTICE and
docs/legal/ATTRIBUTION.md). No graphify code or dependencies are used: this
implementation is Python standard library only.
"""

__version__ = "0.1.0"

from . import algorithms, extract, graph, mcp, query  # noqa: F401

__all__ = ["algorithms", "extract", "graph", "query", "mcp", "__version__"]
