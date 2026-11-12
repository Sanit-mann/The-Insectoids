"""Strict YAML parse of every library frontmatter. Usage: py -I yaml_check.py <libraryDir>"""
import pathlib
import re
import sys

import yaml

lib = pathlib.Path(sys.argv[1])
files = list(lib.glob("agents/*/AGENT.md")) + list(lib.glob("skills/*/SKILL.md")) + list(lib.glob("tools/*.md"))
bad = 0
for f in files:
    text = f.read_text(encoding="utf-8")
    m = re.match(r"^---\r?\n(.*?)\r?\n---", text, re.S)
    try:
        data = yaml.safe_load(m.group(1))
        meta = data.get("metadata") or {}
        assert data.get("name") and data.get("description"), "name/description missing"
        assert isinstance(meta.get("sources"), list) and meta["sources"], "sources missing"
        for s in meta["sources"]:
            assert s.get("repo") and s.get("license"), f"source incomplete: {s}"
        assert len(str(data["description"])) <= 450, f"description {len(str(data['description']))} chars"
    except Exception as e:  # noqa: BLE001
        bad += 1
        print(f"{f.relative_to(lib)}: {e}")
print(f"{len(files)} files parsed, {bad} with problems")
