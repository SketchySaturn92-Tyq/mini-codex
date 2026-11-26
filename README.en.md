**[中文](README.md) · [English](README.en.md)**

# mini-codex

A minimal, actually working local coding assistant. Zero third-party dependencies, only the modules that ship with Node.

What it does in one sentence: **it gives a model that can only talk, and forgets everything, a pair of hands.** The model decides what to do next; the program really reads files, edits files and runs commands, then hands the results back, round after round, until the job is done.

---

## 1. Quickest Start: Open the Web UI

```sh
cd ~/Desktop/mini-codex
./start.command          # or run node bin/mini-codex.js --web in a terminal
```

The browser opens `http://127.0.0.1:3333` automatically.

First time through, click "Settings" in the top-right corner, paste your model API key and save (the key is stored in `config.json` on your machine, permissions 600, so only you can read it). After that just talk to the box at the bottom, for example:

```
Create a hello.js in this directory that prints today's date when run
```

The right-hand panel shows every tool call as it happens. When it needs to change a file or run a command, a confirmation card appears on the right — click "Allow" and only then does it run.

---

## 2. What You Need

1. **Node 18 or newer on your machine.** `node -v` printing `v18` or above is enough.
2. **An API key for a model endpoint.** Anything OpenAI-compatible works (OpenAI, DeepSeek, Qwen, Moonshot, a local Ollama, and so on).

There are two ways to supply the key, pick one:

- Fill it in on the web page (recommended, less hassle): click "Settings" after launch.
- Environment variable (for the command-line crowd):
  ```sh
  export MINI_CODEX_API_KEY="your-key"
  ```
  To make it apply in every new terminal, append that line to the end of `~/.zshrc`.

---

## 3. Command-Line Usage

```sh
# Open the web UI
node bin/mini-codex.js --web

# Command-line conversation mode
node bin/mini-codex.js

# Do one job and exit when it's done
node bin/mini-codex.js -t "List the TODO comments in this project"

# Look but don't change anything, the safest option
node bin/mini-codex.js --readonly -t "Explain the structure of the src directory"

# Continue the previous session
node bin/mini-codex.js --resume

# Stream output as it thinks
node bin/mini-codex.js --stream

# Fully automatic, no per-action approval prompts
node bin/mini-codex.js -y

# Only check that the config is sane, no network, no cost
node bin/mini-codex.js --dry-run
```

In conversation mode, type `exit` to quit and `/reset` to clear the context.

---

## 4. Permission Modes (Important)

It can change your files and run your commands, so the default is **conservative**.

| Mode | How to turn it on | Behaviour |
| --- | --- | --- |
| Read-only | `--readonly`, or pick readonly in the web UI | Look only; any file write and any mutating command is refused |
| Ask (default) | no extra flags | Only pure inspection commands (ls/cat/git status etc.) run directly; file edits and every other command ask you first |
| Auto | `-y`, or pick auto in the web UI | Stops asking, though dangerous commands are still hard-blocked |

Whichever mode you pick, the following are **blocked outright**, with no room to negotiate: recursive force delete, privilege escalation, disk formatting, shutdown or reboot, force-push to a remote, hard reset, download-and-execute, and so on.

On top of that, every file operation is confined to the project directory you specify — going out with `../` or writing an absolute path is rejected. Read-only mode also forbids newline chaining, backticks, `$()`, pipes and redirects in commands, so something like `ls | rm` can't be used to slip past the rules.

---

## 5. Which Tools It Uses

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file by line, with line numbers, supports paging |
| `edit_file` | Replace one small section precisely, smallest possible change (recommended) |
| `write_file` | Write a whole file (new files or very short configs) |
| `list_dir` | List a directory, skipping node_modules and friends automatically |
| `grep` | Find code or errors by regex |
| `move_file` | Move or rename, refuses if the target already exists |
| `delete_file` | Delete a single file or an empty directory, refuses non-empty ones |
| `git_info` | Look at git status, commit history, diffs (read-only) |
| `run_shell` | Run tests, builds and other commands |
| `todo_write` | Keep a to-do list so long tasks stay on track |
| `fetch_url` | Fetch a public web page or API (requires the network switch) |
| `web_search` | Search the web, trying DuckDuckGo and then Bing (requires the network switch) |
| `open_item` | Open a file, folder or URL with the default app (requires the desktop switch) |
| `screenshot` | Save a screenshot inside the project (requires the desktop switch plus system Screen Recording permission) |
| `clipboard` | Read and write the system clipboard (requires the desktop switch) |
| `notify` | Send a system notification (requires the desktop switch) |
| `applescript` | Run AppleScript to control the system (requires the desktop switch plus Accessibility permission) |

## 6. Network Access and Desktop Control

Both of these reach outside the project directory, so they are **off by default** and have to be turned on explicitly when you need them.

Web UI: "Settings" in the top-right → "Extended capabilities", tick "Allow network access" and "Allow desktop control", then save.
Command line: add `--allow-network` / `--allow-desktop`, or write `"allowNetwork": true` in `config.json`.

Once enabled they are still not unlimited:

- In Ask mode, every network or desktop action still pops a card and waits for you to approve it; only Auto mode stops interrupting you.
- In read-only mode both categories are refused outright.
- Network access is limited to public http/https. Localhost, 127.0.0.1, 192.168.x, 10.x, 172.16-31.x, `.local` and `.internal` are all blocked, so the model can't use page fetches to probe your LAN or router.
- `open_item` can only open files inside the project directory, or public URLs.
- `applescript` may not contain `do shell script` (that amounts to running commands around the approval step); if you need to run commands, use `run_shell`, which has its own approval.

First use may need a system permission, granted once and done:

- Screenshots: System Settings → Privacy & Security → Screen Recording, tick the terminal you use.
- AppleScript keystroke simulation: Privacy & Security → Accessibility, tick the terminal.
- Without the grant, the tool returns a clear message instead of failing silently.

## 7. Terminal Access and the Mirror Window

The `terminal` tool doesn't give you "a new process per command" — it gives you a **long-lived login shell**:

- It starts with `zsh -il`, so it reads your `~/.zprofile` and `~/.zshrc`, which means PATH, aliases and nvm all match the terminal you open yourself.
- `cd`, `export`, virtualenv activation and nvm switches all persist — the next command continues from the previous state.
- Responses carry the exit code and current directory, so the model knows where it is.
- To start over clean, pass `reset: true` and it opens a fresh session.

Sitting alongside it is `run_shell`: that one really is "one command at a time, forgotten afterwards", which suits builds, tests and other independent commands.

**Mirror window**: after you turn on "Mirror to terminal window" in Settings, every command the agent runs is displayed live in a newly opened Terminal window, so you can watch what it gets up to. This is display only, nothing is executed twice — the window runs `tail -f` against `.mini-codex/mirror.log` inside the project. Pushing commands straight into a terminal that way would execute each command a second time, which is exactly why that approach wasn't taken.

Known limits: this session has no pty allocated, so full-screen programs like vim and top can't draw their interface, and interactive prompts (the questions in `npm init`, for example) can't run either. For those, use `applescript` from the desktop capabilities to hand the job to a real Terminal.

## 8. Directory Structure

```
mini-codex/
├── start.command          double-click to launch the web UI (macOS)
├── bin/mini-codex.js      command-line entry point
├── public/                web UI (zero dependencies, plain native)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/
│   ├── main.js            argument parsing, printing, asking for confirmation, starting the server
│   ├── server.js          local web server and approval channel
│   ├── loop.js            main loop (the heart): ask the model → run tools → feed results back
│   ├── model.js           model interface, supports streaming output
│   ├── router.js          model routing: use a small model for simple tasks
│   ├── tools.js           tool registry and the ten built-in tools
│   ├── context.js         context management: truncation and compression
│   ├── prompt.js          system prompt, in three parts
│   ├── safety.js          path validation, command blacklist, permission modes
│   ├── settings.js        reading and writing web settings
│   ├── resume.js          session resume summaries
│   ├── config.js          configuration loading
│   └── session.js         session logs (.mini-codex/sessions/)
├── tests/                 offline tests, no network
└── config.example.json    example config, copy to config.json and edit
```

---

## 9. FAQ

**It says it can't find the key?**
Click "Settings" in the top-right of the web page and fill it in once; or run `echo $MINI_CODEX_API_KEY` in a terminal to confirm the environment variable is set.

**Want to switch model or endpoint?**
Change it directly under "Settings" on the web page; it's saved to `config.json` inside the project. The command-line flags `--model` and `--base-url` take priority.

**Why is it sometimes really fast?**
Once a fast model is configured, short exchanges are routed to the small model to save money: a one-sentence simple question goes to the fast model, anything involving code changes or error hunting goes to the main model. Add `"fastModel": "some cheap model"` to `config.json` to switch it on.

**What if it breaks something?**
It doesn't back anything up automatically, but all changes land inside your project. Use `git status` to see which files it touched, and `git checkout` to roll back. Best to use it in a clean git repository.

**Will it be expensive?**
Cost is based on the volume of text sent and received. The program already does three things to keep costs down: verbose tool output is truncated automatically, history is compressed automatically when a run goes long, and simple questions are routed to a small model automatically. It also has a turn limit (25 rounds by default), so it won't spin forever.

**It got stuck halfway through?**
Press Ctrl+C to stop. Logs are in the project's `.mini-codex/sessions/` directory; `node bin/mini-codex.js --list-sessions` lists them and `--replay <file path>` replays what happened. To carry on from last time, use `node bin/mini-codex.js --resume`.

**How do I check the program itself isn't broken?**
```sh
cd ~/Desktop/mini-codex
node tests/offline.test.js && node tests/features.test.js
```
All 28 tests across the two suites passing means the main loop, the tools, the safety blocks, context compression, model routing and the web endpoints are all working. The tests use a fake model, so no network and no cost.

---

## 10. Not Built Yet

- Full persistence of multi-turn conversations (resuming today means compressing the previous log into a summary, not restoring it word for word)
- Parallel subtasks (splitting a big job across several sub-agents)
- Finer-grained approval rules (set per directory or per command type)
