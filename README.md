# Context Brain

**See what Claude Code is holding in its head, and what to cut.** Context Brain turns a Claude Code session into a live 3D brain: every file it read, every shell output, rule, skill and tool result becomes a neuron in its own region, and you watch light flow from the context into each answer. A built-in context doctor then tells you where tokens leak and how to get them back.

**[▶ Live demo](https://context-brain.pages.dev)** (no install, replays a sample session) · [한국어](README.ko.md)

![Context Brain replaying a session](docs/brain.gif)

```bash
npx github:workdd/context-brain
```

That's it. It opens your browser and follows your most recent Claude Code session in real time, staying within that project. Nothing to configure: it only reads the session logs Claude Code already writes.

## What it answers

| Question | Where you see it |
|---|---|
| What is filling my context? | Region badges with token totals, neuron size, name tags on the biggest items |
| What did this answer actually use? | Lines from each item used in the turn to the Response region (thickness = tokens returned, brighter = the answer names it). A line is a record of use, not live attention |
| What is just taking up space? | Red pulsing neurons: 800+ tokens, not used again for more than 2 turns |
| How close am I to auto-compaction? | The ring in the corner, against where this model auto-compacted before. If past auto-compactions are too spread out to call a threshold, it shows the range instead of a percentage |
| When and why did the context grow? | The context history strip under the brain: size per API call by region, the biggest jumps labeled with their cause, compactions marked |
| What should I change? | Context doctor: each leak with its size and a concrete fix, in the browser, the terminal and the Claude Code status line |

## Context doctor

![Context doctor](docs/doctor.png)

| Finding | Fix it suggests |
|---|---|
| Same file read in full more than once | Read with offset/limit, Grep first, summarize once |
| Oversized tool output (4k+ tokens in one result) | Pipe through head/grep/tail, quiet flags |
| Items never used again (800+ tokens, idle 2+ turns) | `/compact` or `/clear` at the task boundary |
| MCP server instructions loaded but never called | Disable the server for this project |
| Tool schemas loaded but unused | Name the tool in the prompt |
| Repeated tool failures | Tell Claude the cause |
| Large fixed context (rules, skills, hooks) | Trim CLAUDE.md, disable unused skills and plugins |
| About to auto-compact | `/compact` now with a note on what to keep |

The "reclaimable now" number counts only what leaves the context if you act: unused items still in context, unused MCP instructions and unused schemas.

```text
$ npx github:workdd/context-brain doctor
Context doctor · Fix login 401
context 232k / compacts at 810k (29%) · 24 turns
reclaimable now: ~15.6k tokens

HIGH  8 items never used again · 13.1k
      Run /compact or /clear at the task boundary to drop this. ...
      - src/orders/orders.service.ts  3.2k · idle 2 turns
```

## Project doctor

![Project doctor](docs/project.png)

One session can be a coincidence. The project doctor reads the project's 20 most recent sessions and keeps only what repeats:

| Finding | Why it is a strong signal |
|---|---|
| MCP server loaded in many sessions, never called | Its instructions are paid for in every session for nothing. Safe to disable for this project |
| File re-read in session after session | A few lines in CLAUDE.md about it save reading it whole each time |
| Command with consistently large output | Grouped by program (`npm`, `gh`, `pytest` …). File readers like `cat` and `sed` are excluded |
| Fixed context in every session | What is spent before your first prompt: system prompt, skill list, CLAUDE.md files, hooks |

Click "Analyze recent sessions" under the brain, or run `doctor --project` in the terminal. Click a session bar to open that session.

### In the Claude Code status line

Add this to `~/.claude/settings.json` and the reclaimable amount follows you in every session:

```json
{ "statusLine": { "type": "command", "command": "npx -y github:workdd/context-brain statusline" } }
```

```text
🧠 ctx 232k (29%) · reclaim 16k · 2 high
```

It reads `transcript_path` from the status line input and caches the compaction point for 10 minutes. For speed, clone the repo and point `command` at `node /path/to/context-brain/bin/context-brain.js statusline`.

## Features

- **Live**: tails the session log every 0.4 s and pushes events over Server-Sent Events. Tool calls flash in their region, results flow back in white.
- **Context history strip**: along the bottom of the brain, one point per API call. Stacked bands show what the context is made of (same colors as the regions), the white line is the measured size, red marks compactions and the compaction point. The biggest jumps carry the name of what caused them.
  - Hover a point: the context's makeup at that call and every item that came in since the previous call. Growth the log has no content for (thinking, response text) is shown separately.
  - Click a point: the brain, panels and doctor go back to that moment. `←` `→` step one API call, "Now" returns to live.
  - Replay at 4×, 16× or 64× is still there for watching a session unfold.
- **Turn stepping**: `[` and `]` (or ◀ ▶) re-light the brain for a past turn: which items it used, which beams fed the answer.
- **Share as one HTML file**: export a session as a single self-contained HTML that opens without a server and replays itself. Redaction is on by default.
- **Click anything**: a region badge zooms the camera and lists its items. A neuron shows the full command or edit, the start of its output, its use history and the turns it appeared in.
- **Context doctor**: ranked findings with their size, a concrete fix, and chips you can hover to find the item in the brain. Also `doctor` in the terminal and `statusline` for Claude Code.
- **What takes up the space**: a treemap of everything still in context, sized by estimated tokens. The biggest never-used-again items are outlined in red, the same ones that pulse red in the brain.
- **This turn**: the turn the brain is showing, with its tool-call flow (failures in red) and each answer sentence with chips for the items it names. Pick another turn with ◀ ▶ or the history strip.
- **English and Korean UI**: follows your browser language. Switch in the header.

![Context Brain viewer](docs/brain-en.png)

## Brain regions

| Region | What lands there |
|---|---|
| Response | Thinking and answers. Every beam ends here |
| Rules (CLAUDE.md) | One neuron per loaded CLAUDE.md |
| Tool list | Skill list, agent list, MCP instructions, deferred tool schemas |
| Subagents · Web | Agent calls (by type), WebSearch and WebFetch (by host) |
| Skills · MCP | Skill calls and skill bodies, `mcp__server__tool` calls (by server) |
| Dialog · Shell | Your prompts and compaction summaries, Bash commands (one neuron per command, named by its description) |
| Files | Read, Edit, Write, Grep, Glob |
| Memory (hooks) | Extra context injected by SessionStart and other hooks |
| System prompt | System prompt, environment, date, model |

## Commands

```bash
npx github:workdd/context-brain                     # viewer on http://localhost:7788, opens the browser
npx github:workdd/context-brain demo                # sample session, no Claude Code needed
npx github:workdd/context-brain export latest --redact -o my-session.html
npx github:workdd/context-brain doctor              # findings in the terminal (--json for scripts)
npx github:workdd/context-brain doctor --project    # repeated leaks across the project's recent sessions
npx github:workdd/context-brain calibrate           # fit token estimates to your own sessions
```

| Option | Meaning |
|---|---|
| `--port <n>` | Port (falls through to the next free one) |
| `--no-open` | Do not open the browser |
| `export [file.jsonl\|latest]` | Save a session as one HTML file that replays itself |
| `--redact` | Leave out tool output previews, commands, prompts and answer text. Home paths always become `~` |
| `doctor [file.jsonl\|latest]` | Print findings and fixes. `--json` for machine output |
| `doctor --project [--limit 20]` | Look across the project's recent sessions |
| `statusline` | One line for the Claude Code status line |
| `calibrate [--dry-run]` | Fit token coefficients to your own logs and save them to `~/.config/context-brain/tokens.json` |

From a clone: `npm install && npm start`. Node.js 18+, no runtime dependencies. three.js loads from a CDN in the browser.

## How it works

```
~/.claude/projects/<project>/<session>.jsonl    written by Claude Code
        │  read new lines every 0.4 s (lib/tail.js)
        ▼
parser (lib/parse.js)
  attachment (instructions, skill_listing …)  → loaded
  assistant tool_use                          → used
  user tool_result (matched by tool_use_id)   → result
  assistant text                              → answer + named items
  usage                                       → context size (measured)
  system turn_duration / compact_boundary     → turn end / compaction
        │  Server-Sent Events (server.js, 127.0.0.1 only)
        ▼
lib/tokens.js        token estimate (fitted coefficients, image size) · lib/calibrate.js fits them
lib/project.js       parses a project's recent sessions (cached by mtime)
browser: public/app.js (three.js brain, panels, history strip) + public/model.js (treemap, evidence, doctor, project doctor)
terminal: bin/context-brain.js doctor | statusline (same public/model.js)
```

- Read-only. It never touches Claude Code settings or hooks.
- The server binds to `127.0.0.1` and refuses any path outside `~/.claude/projects`.
- Subagent sidechains and claude-mem observer sessions are skipped.

## How accurate the numbers are

Per-item token counts are estimated from text, because the log only records the total context size per API call. The estimator is fitted to that measured total, not guessed:

- Between two API calls where exactly one tool result arrived, the growth in measured context is that result's real cost. Regressing it on character counts gives the coefficients.
- Fitted on 235 such samples from 455 real sessions: **ASCII 2.25 chars per token, Hangul 1.45 tokens per char**, other scripts 2.43 tokens per char, plus 34 tokens per tool result.
- Images are counted by size, width × height / 750, which matched measured growth within 3% on 19 screenshots.

| Estimator | Median error per result | Estimated / measured total |
|---|---|---|
| characters / 4 (the usual rule of thumb) | 53% | 0.42 |
| fitted coefficients | **6%** (9% on held-out sessions) | **1.00** (0.95 held out) |

On whole sessions, the sum of item estimates now lands at 0.8 to 1.0 of the measured context. The rest is what the log never shows, such as tool definitions and message framing. These coefficients come from one person's sessions on one model, so run `calibrate` to fit your own.

## Read it with care

- **Light is not attention.** Beams and evidence come from what actually happened: tool calls, results, and item names appearing in the answer text. A sentence that uses a file without naming it shows no evidence.
- **Neuron tokens are estimates** fitted to measured usage (see above). Only the ring and "Context now" are measured by the API directly.
- **The compaction point is observed**, from automatic compactions of the same model in recent sessions (manual `/compact` is ignored). A model's sessions can run with different context windows, so when those sizes spread by more than 25% no threshold is claimed.
- **"Never used again" is a hint.** It only knows an item was not called or named again. The model re-reads the whole context on every call, and the log does not say which parts it attended to. Rules and other quietly consulted context are excluded.
- **The log format is not a public spec.** A Claude Code update can hide some items. Unknown entries are skipped.

## Development

```bash
npm test             # jest with coverage for lib/ and public/model.js
npm run demo         # sample session that keeps adding steps live
npm run build:web    # build web/index.html (the live demo)
```

`CLAUDE_PROJECTS_DIR` points the viewer at another log folder.

## License

MIT
