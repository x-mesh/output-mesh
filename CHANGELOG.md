# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/). The version
lives in `package.json`; `output-mesh --version` and the explorer footer show it.

## [Unreleased]

### Added

- **cli:** the startup screen shows an `Update` line when npm has a newer version. It makes one request to the npm registry and sends no data about you. Set `OUTPUT_MESH_NO_UPDATE_CHECK=1` to turn it off

## [0.8.0] - 2026-10-01

### Added

- **explorer:** show the logos of the agents that made the files in each folder, next to the folder name
- **explorer:** group the agent view by vendor first (Claude, Codex, Cursor), then by product (Claude Code, Claude Desktop)
- **explorer:** open filters in a panel over the preview, so the tree stays in place. Selected filters stay as tokens next to the Filters button, and `f` opens the panel
- **explorer:** pick several values in one filter group, for example Codex and Claude Code. Values in one group match any of them, and different groups must all match
- **explorer:** show agent logos in the filter panel and on filter tokens
- **explorer:** show the Aside logo for Aside sessions and the Aside app, and use logos on the first level of the app grouping
- **overview:** draw the widget resize handle as a diagonal corner grip, so it reads as two-way resizing and stands out
- **overview:** switch the activity widget between chart and table in place. The table fills the chart's area, keeps its header row in view, and the choice is remembered
- **overview:** draw wider activity bars with narrower gaps, so sparse weeks no longer look empty
- **ui:** rewrite Korean labels that read like literal translations, for example the change feed is now "최근 변경"
- **ui:** align the Output Mesh title with the node chip and the view switch in the top bar
- **ui:** clicking the top-bar collection error opens the errors and marks them as seen, so the bar returns to the live state until a newer error arrives
- **cli:** the startup screen tells errors from this run apart from earlier ones in the last hour, and shows the time of the latest one
- **collect:** a broken line in a Gemini transcript is reported once, not again after each restart
- **ui:** the collection error list, the top bar, and `doctor` read errors directly, so warnings no longer push them out of view
- **collect:** collection errors and warnings older than 30 days are deleted, like the change history
- **ui:** the Collection status widget shows errors from the last hour only, like the top bar. Older errors stay in the error list
- **cli:** `coverage` and `compact` print English, like the rest of the terminal output
- **ui:** the English change feed is now "Recent changes" (was "Just happened")
- **docs:** bring both READMEs up to date (service install, overview widgets, filters panel, several machines, collection errors, `compact`) and rewrite awkward phrasing
- **collect:** collect the images that the Codex image generation tool made (`~/.codex/generated_images/`) with their Codex session. They follow the temporary-images switch and show a "generated" mark
- **activity:** a **Follow** switch in the Activity header jumps to the top whenever new work arrives, even while you scroll down. It is off by default
- **activity:** the Activity view always shows temporary images, with a **Small | Large** preview size. Large previews show what a screenshot is. New cards and images are highlighted for a few seconds, and while you scroll down, the card you read stays in place under a "new tasks" button
- **ui:** the temporary-images switch moved from the filter panel to the end of the filter row, where it is always visible
- **ui:** temporary images are hidden by default. **Show temporary images** in the filter panel shows them in the list, the feed, Activity, and the counts, and the choice is remembered. The overview header and the feed say how many are hidden
- **overview:** a Temporary images widget, on by default, shows the scratch-folder images grouped by session as small previews. In the Activity view, each session shows these images apart from its other files, with a "temporary" mark
- **collect:** show images from Claude Code session scratch folders, for example screenshots that an agent took with a script. They carry a "temporary" mark, are not copied, and leave the library when the folder is deleted. The change feed shows one line per set of images from a session
- **collect:** watch the git worktrees of each repository that an agent worked in, so documents edited there with shell commands are collected. The first scan of a worktree skips the files that its checkout wrote
- **collect:** collect Gemini Antigravity session artifacts and the files that its write tools changed. A broken transcript line is skipped with one warning that names the file and line

## [0.7.0] - 2026-10-01

### Added

- **collect:** read Claude Desktop artifacts from its local HTTP cache. output-mesh keeps a local copy of each complete artifact HTML and never calls Claude APIs
- **collect:** collect files that Claude Desktop chats wrote, downloaded chat files, and chat widgets from the cached conversations. The periodic sweep picks them up within 30 seconds
- **preview:** give Claude Desktop widgets a minimal style, so hidden headings stay hidden and diagram boxes stay readable

## [0.6.0] - 2026-09-21

### Added

- **preview:** highlight code with `@speed-highlight/core`. Tokens become DOM nodes, so search matches stay visible inside them
- **preview:** number the lines of a code file. Each line carries its own number, so a wrapped line keeps the number beside its first row, and a copy leaves the numbers out

### Fixed

- **collect:** stop two commands on one catalog from writing at the same time

## [0.5.1] - 2026-09-21

### Fixed

- **mesh:** remove the word "false" that appeared in the top bar beside the node names

## [0.5.0] - 2026-09-21

### Added

- **mesh:** list every tailnet node with its state. A node that runs output-mesh becomes a link; the rest are counted, with the command to add one

## [0.4.1] - 2026-09-21

### Fixed

- **cli:** take the port before collecting. A second instance used to parse every log first and fail at the end
- **cli:** record the running instance, so `stop` and `status` also find one started by hand. Before this, only `pkill` could stop it

## [0.4.0] - 2026-09-21

### Added

- **mesh:** switch to another tailnet node from the top bar. Each node keeps its own catalog and serves its own files
- **cli:** run it as a background service with `install`, and control it with `start`, `stop`, `restart`, and `status`

### Changed

- published to npm: run it with `bunx output-mesh`

### Fixed

- `package.json` lists the command as `bin/output-mesh.mjs` without `./`, so npm 11 no longer warns that it removed the command when publishing

## [0.3.0] - 2026-09-21

### Added

- **collect:** read Cursor composer records and attach their files to the catalog
- **preview:** show `.drawio` files in a read-only viewer with page navigation and zoom
- **overview:** add a configurable widget grid and tab title notifications
- **cli:** add the `compact` command to reclaim unused database pages

### Changed

- **collect:** group Aside sessions by session, restore session titles, and preserve multiple artifact origins
- **collect:** group git worktrees under their main repository
- **library:** add worktree locations, improved document titles, two-character search, and bundle members
- **overview:** align search, feed, workspace, activity, and period filters
- **cli:** show catalog status and use English terminal output

## [0.2.0] - 2026-09-18

### Added

- **collect:** documents in repositories an agent has worked in, including the ones an agent writes through the shell. The first run adds documents changed in the last 7 days; after that each repository is watched and new or edited documents show up within seconds. Source code is not collected this way
- **overview:** the "Just happened" feed says how many code and other changes the library hides, and one click shows them
- **overview:** each change in "Just happened" names its agent (Codex, Claude Code, Aside). A change seen on disk shows the agents that made the file with a dashed outline, since who made that change is unknown

### Changed

- the overview reads top to bottom as charts, then lists: activity, the kind / agent / workspace breakdowns, then "Just happened" beside the final files
- "Just happened" scrolls inside its own box and loads older changes as you reach the end, 30 at a time, instead of stopping at the latest 8
- removed the "Recently changed" list from the overview; "Just happened" shows the same files with what changed, which agent, and when
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
