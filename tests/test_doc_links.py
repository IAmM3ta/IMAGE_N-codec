"""Doc / path drift guards (added 2026-11-16).

Background: on 2026-11-16 the repository was renamed from MORPHOS to
IMAGE_N-codec and `docs/MORPHOS-AND-MORPHOGEN.md` moved to
`docs/IMAGE_N-AND-MORPHOGEN.md`. Every reference was fixed by hand that day,
but nothing stopped the next rename (or a moved test / TD module) from leaving
a dead link behind: the TS and Python suites only check the files they import.
A careful sweep on 2026-11-16 found zero dead references; these tests keep it
that way.

What is checked (stdlib only, so it runs in the torch-free CI job):

1. Every relative Markdown link `[text](path)` in a `.md` file resolves to a
   file or directory that exists (anchors and URLs are ignored, fenced code
   blocks are skipped).
2. Every repo path cited in prose or comments — `docs/...`, `tests/...`,
   `scripts/...`, `src/...`, `td/...`, `public/...`, `morphogen-v2/...` ending
   in a known extension — exists relative to the repo root, `morphogen-v2/`, or
   the citing file's own directory. (Morphogen code says `td/x.py` and
   `tests/x.test.mjs` meaning `morphogen-v2/...`; that is accepted.)
3. No link to the old slug `github.com/IAmM3ta/MORPHOS` (MORPHOS-APP, the
   Living Field instrument, is a different repo and is fine), and the README CI
   badge points at `IMAGE_N-codec`.

Exempt: STATUS.md, a dated append-only log whose old entries may name paths
and slugs as they were on that day (e.g. the rename note itself), and this
file, whose examples name dead paths on purpose.
If you move or rename a file, update every reference these tests report, or
add a dated STATUS note — don't add more exemptions.
"""

import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MORPHOGEN = os.path.join(ROOT, "morphogen-v2")

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".pytest_cache", "dist", "build", ".venv", "venv"}
SKIP_FILES = {"package-lock.json"}
# Dated history + this file's own deliberate dead examples; see module docstring.
EXEMPT = {"STATUS.md", "tests/test_doc_links.py"}
TEXT_EXT = (".md", ".py", ".ts", ".mjs", ".js", ".sh", ".yml", ".yaml", ".json", ".ini", ".html", ".toe.txt")

MD_LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
FENCE = re.compile(r"^```.*?^```", re.S | re.M)
URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
REPO_PATH = re.compile(
    r"(?<![\w./-])((?:\.\./|\./)*(?:docs|morphogen-v2|tests|scripts|td|src|public)/"
    r"[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:md|py|ts|mjs|sh|json|yml|html))"
)
OLD_SLUG = re.compile(r"github\.com/IAmM3ta/MORPHOS(?![\w-])")


def _rel(path):
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def _text_files(root=ROOT, exts=TEXT_EXT):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name in SKIP_FILES or not name.endswith(exts):
                continue
            path = os.path.join(dirpath, name)
            if _rel(path) in EXEMPT:
                continue
            yield path


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def dead_md_links(path):
    """Relative Markdown link targets in `path` that don't exist on disk."""
    text = FENCE.sub("", _read(path))
    base = os.path.dirname(path)
    dead = []
    for m in MD_LINK.finditer(text):
        target = m.group(1)
        if URL_SCHEME.match(target) or target.startswith("#"):
            continue
        rel = target.split("#", 1)[0].split("?", 1)[0]
        if rel and not os.path.exists(os.path.normpath(os.path.join(base, rel))):
            dead.append(target)
    return dead


def dead_path_mentions(path):
    """Repo paths cited in `path` that resolve under none of the accepted bases."""
    bases = (ROOT, MORPHOGEN, os.path.dirname(path))
    dead = []
    for m in REPO_PATH.finditer(_read(path)):
        cited = m.group(1)
        if not any(os.path.exists(os.path.normpath(os.path.join(b, cited))) for b in bases):
            dead.append(cited)
    return dead


def test_relative_markdown_links_resolve():
    bad = {}
    for path in _text_files(exts=(".md",)):
        dead = dead_md_links(path)
        if dead:
            bad[_rel(path)] = dead
    assert not bad, f"dead relative Markdown links (file -> targets): {bad}"


def test_cited_repo_paths_exist():
    bad = {}
    for path in _text_files():
        dead = dead_path_mentions(path)
        if dead:
            bad[_rel(path)] = sorted(set(dead))
    assert not bad, f"repo paths cited but missing (file -> paths): {bad}"


def test_no_links_to_old_repo_slug():
    hits = [_rel(p) for p in _text_files() if OLD_SLUG.search(_read(p))]
    assert not hits, f"github.com/IAmM3ta/MORPHOS is now IMAGE_N-codec; update: {hits}"


def test_readme_ci_badge_uses_current_slug():
    readme = _read(os.path.join(ROOT, "README.md"))
    assert "github.com/IAmM3ta/IMAGE_N-codec/actions/workflows/ci.yml/badge.svg" in readme


def test_old_docs_map_name_is_gone():
    assert not os.path.exists(os.path.join(ROOT, "docs", "MORPHOS-AND-MORPHOGEN.md"))
    assert os.path.exists(os.path.join(ROOT, "docs", "IMAGE_N-AND-MORPHOGEN.md"))


# --- the scanners must actually catch things (so a regex typo can't make the
# --- guards above pass vacuously) -------------------------------------------


def test_scanner_flags_dead_markdown_link(tmp_path):
    (tmp_path / "real.md").write_text("x", encoding="utf-8")
    doc = tmp_path / "doc.md"
    doc.write_text(
        "[ok](real.md) [ok2](./real.md#sec) [web](https://example.com/x.md) [anchor](#top)\n"
        "[gone](docs/MORPHOS-AND-MORPHOGEN.md)\n"
        "```\n[in fence](nowhere.md)\n```\n",
        encoding="utf-8",
    )
    assert dead_md_links(str(doc)) == ["docs/MORPHOS-AND-MORPHOGEN.md"]


def test_scanner_flags_dead_path_mention(tmp_path):
    src = tmp_path / "note.py"
    src.write_text(
        "# see docs/IMAGE_N-AND-MORPHOGEN.md and td/morphogen_sync_commands.py\n"
        "# moved: docs/MORPHOS-AND-MORPHOGEN.md, tests/gone.test.mjs\n",
        encoding="utf-8",
    )
    assert dead_path_mentions(str(src)) == ["docs/MORPHOS-AND-MORPHOGEN.md", "tests/gone.test.mjs"]


@pytest.mark.parametrize(
    "text,hit",
    [
        ("https://github.com/IAmM3ta/MORPHOS", True),
        ("https://github.com/IAmM3ta/MORPHOS.git", True),
        ("https://github.com/IAmM3ta/MORPHOS/actions", True),
        ("https://github.com/IAmM3ta/MORPHOS-APP", False),
        ("https://github.com/IAmM3ta/IMAGE_N-codec", False),
    ],
)
def test_old_slug_pattern(text, hit):
    assert bool(OLD_SLUG.search(text)) is hit
