---
name: eap-signal-compress
description: >
  Compress natural language memory files (CLAUDE.md, todos, preferences) into
  EAP-Signal prose to save input tokens. Preserves code, URLs, paths, structure.
  Backup under XDG data dir (or %LOCALAPPDATA%). Trigger: /eap-signal-compress
  FILEPATH or "compress memory file".
license: MIT
---

# EAP-Signal Compress

## Purpose

Compress natural language files into Signal style to reduce input tokens. Compressed version overwrites original. Original backed up out-of-tree (see `scripts/compress.py`).

## Trigger

`/eap-signal-compress <filepath>` or when user asks to compress a memory file.

## Process

1. Scripts live in `scripts/` adjacent to this SKILL.md. Search for `scripts/__main__.py` next to this SKILL.md if needed.

2. From the directory containing this SKILL.md, run:

```bash
python3 -m scripts <absolute_filepath>
```

3. The CLI will detect file type, call the model to compress, validate, retry up to 2 times, and report errors without touching the original on failure.

4. Return result to user.

## Compression Rules

### Remove
- Articles: a, an, the
- Filler: just, really, basically, actually, simply, essentially, generally
- Pleasantries / hedging / connective fluff

### Preserve EXACTLY
- Code blocks, inline code, URLs, paths, commands, technical terms, proper nouns, versions, env vars

### Preserve Structure
- Headings, lists, tables, frontmatter

CRITICAL: Anything inside ``` ... ``` or inline `` `...` `` is read-only.

## Boundaries

- ONLY compress natural language files (.md, .txt, .typ, .typst, .tex, extensionless)
- NEVER modify code/config extensions (.py, .js, .ts, .json, .yaml, .yml, .toml, .env, .lock, …)
- Never compress FILE.original.md backups
- See SECURITY.md for API/subprocess risk notes
