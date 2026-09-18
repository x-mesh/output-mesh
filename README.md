<p align="center">
  🇰🇷 <a href="./README.ko.md">한국어</a> | 🇺🇸 English
</p>

<h1 align="center">output-mesh</h1>

<p align="center">
  A local catalog of what your AI agents made.<br />
  Find any artifact in seconds, preview it safely, and see which agent and session wrote it.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/bun-%3E%3D1.3-black" alt="Bun >= 1.3" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="Platform: macOS" />
  <img src="https://img.shields.io/badge/runtime%20deps-0-brightgreen" alt="Zero runtime dependencies" />
</p>

## Why

Agents write reports, PRDs, spreadsheets, HTML prototypes, and images into session folders and repositories. A week later you remember the work, not the file name or where it landed. Half of the files are called `README.md` or `SKILL.md`.

output-mesh reads those places **without touching them** and gives you one library: searchable by file name, body, and the task that produced it, with the originating agent, session, and repository attached to every file.

## Quick start

Requires macOS and [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/x-mesh/output-mesh.git
cd output-mesh
bun bin/output-mesh.mjs
```

Open http://127.0.0.1:19843. The interface is currently in Korean.

The first run reads every agent log once and shows progress while it does (about 20 seconds for 3.6 GB of Codex logs on an Apple Silicon Mac). Later starts only read what changed.

Once published to npm, it runs without cloning:

```bash
bunx output-mesh
```

`npx` will not work: output-mesh uses Bun's built-in SQLite.

## What it collects

| Source | Where | How |
|---|---|---|
| Aside | `~/.aside/u/<account>/sessions/<date>_<id>/artifacts/` | Watches the folder, enriches from Aside's `state.db` (opened read-only) |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | Paths from `apply_patch` markers in session logs |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `file_path` of `Write` / `Edit` tool calls |
| Anything else | A folder or file you choose | `output-mesh import <path>` |

Codex and Claude Code do not keep artifacts anywhere special. Their logs record which paths they wrote, so output-mesh attaches provenance to files that are still in your repositories and leaves them where they are.

The library shows documents, web pages, images, spreadsheets, and bundles. Source code and unknown formats are collected but hidden by default; pick them from the Kind filter when you need them.

## Using it

**Explorer (left).** Search, a period (all, today, 7, 30, 90 days), collapsible filters, and a tree. Group the tree by repository, agent, app, date, or kind. Every file shows a subtitle: the document's own title, or the task that created it when the title says nothing ("README", "Product").

**Overview (right, nothing selected).** Agent activity per hour, day, or week depending on the period, plus breakdowns by kind, agent, and workspace. Every bar is a filter.

**Detail (right, file selected).** The preview takes the space. Markdown renders with its front matter shown as a table. The inspector lists every session that touched the file, with tags, notes, and a "final" mark.

**Activity.** A live timeline of agent sessions and the files each one wrote.

Keyboard: `↑` `↓` move and open, `←` `→` collapse and expand, `/` search. Click the title to return to the overview; the browser back button works too.

## Commands

```bash
output-mesh                  # same as serve
output-mesh serve [--port N] # http://127.0.0.1:19843 by default
output-mesh sweep            # collect once and exit
output-mesh import <path>    # register a folder or file (never copied)
output-mesh coverage         # what was excluded and why
output-mesh doctor           # source paths, database, and FTS5 health
```

All commands accept `--db <path>` to use a different catalog file.

## What it will not do

- **Write to your sources.** Session folders, logs, and repositories are only read. Aside's `state.db` is opened read-only.
- **Copy your files.** The index points at the originals.
- **Listen beyond your machine.** The server binds to `127.0.0.1` only.
- **Let agent HTML phone home.** Previews render in sandboxed frames without same-origin access, under `connect-src 'none'`. Scripts stay blocked unless you allow them per file, and even then the network stays closed.

Your catalog lives in `~/Library/Application Support/AgentOutputCatalog/catalog.db`. Everything in it can be rebuilt from disk except your tags, notes, favorites, and final marks, which sweeps never overwrite.

## Notes

- Spreadsheet text extraction uses the system `unzip`.
- Importing from `~/Downloads`, `~/Desktop`, or `~/Documents` needs Full Disk Access for the `bun` binary once.
- Files Claude Code writes through the shell (not the `Write` tool) leave no path in the log and are not discovered.
- PDF previews work; PDF text search does not yet. Images are not OCR'd.

## Development

```bash
bun test      # test suite
make check    # lint + tests
```

Design notes live in [DESIGN.md](./DESIGN.md), and the reasoning behind the data model in [CLAUDE.md](./CLAUDE.md).

## License

[MIT](./LICENSE)
