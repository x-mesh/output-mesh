# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/). The version
lives in `package.json`; `output-mesh --version` and the explorer footer show it.

## [Unreleased]

### Added

- **collect:** documents in repositories an agent has worked in, including the ones an agent writes through the shell. The first run adds documents changed in the last 7 days; after that each repository is watched and new or edited documents show up within seconds. Source code is not collected this way
- **overview:** the "Just happened" feed says how many code and other changes the library hides, and one click shows them
- **overview:** each change in "Just happened" names its agent (Codex, Claude Code, Aside). A change seen on disk shows the agents that made the file with a dashed outline, since who made that change is unknown

### Changed

- "Just happened" sits below the activity graph
- changes found by watching the disk are labeled "seen on disk" instead of "outside an agent", since an agent may have made them through the shell
- files you import and documents found in repositories no longer count as agent sessions in the activity graph or the 24-hour count

### Fixed

- the server re-read every growing agent log from the start on each collection. While an agent was working, memory grew by about 66 MB every 30 seconds (it reached 3.9 GB). Logs are now read from where the last read stopped. The first run also got faster: 4.2 GB of logs in 4.3 s instead of 7.8 s, with peak memory down from 2.9 GB to 1.1 GB

## [0.1.0] - 2026-09-18

### Added

- **collect:** read-only collection from Aside session folders (enriched from Aside's `state.db`), Codex rollout logs, Claude Code transcripts, and folders you import. Files stay where they are; the catalog only points at them
- **library:** explorer with search, a period filter (all, today, 7, 30, 90 days), collapsible filters, and a tree grouped by repository, agent, app, date, or kind. Each file shows its document title, or the task that created it when the title says nothing
- **overview:** "Just happened" feed, agent activity per hour, day, or week, and breakdowns by kind, agent, and workspace; every bar is a filter
- **preview:** Markdown with front matter as a table, sandboxed HTML with the network closed, images, PDFs, and spreadsheets as simple value tables (first 200 rows and 30 columns per sheet)
- **provenance:** every session that touched a file, with tags, notes, favorites, and a "final" mark that sweeps never overwrite
- **realtime:** agent writes appear within seconds; files are re-checked every 30 seconds so edits and deletions made outside an agent show up too, marked "outside an agent"
- **activity:** live timeline of agent sessions and the files each one wrote
- **interface:** English and Korean, following the browser language with a KO / EN switch; light, dark, or system theme
- **cli:** `serve`, `sweep`, `import`, `coverage`, `doctor`, and `--version`; the first run shows progress while it reads every agent log
- **run without installing:** `bunx github:x-mesh/output-mesh`
