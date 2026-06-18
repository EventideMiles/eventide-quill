# AGENTS.local.example.md

Per-developer agent overrides template. This file is **not** read by agents.

To activate your local overrides:

1. Copy this file to `.local/AGENTS.md` (the `.local/` folder is gitignored):
   `cp AGENTS.local.example.md .local/AGENTS.md`
2. Edit `.local/AGENTS.md` to reflect your environment.

The root `AGENTS.md` tells agents to read `.local/AGENTS.md` at session start
when it exists, layering your rules on top of the shared ones. Put anything in
it that is true in YOUR setup but should not be forced on other contributors.

---

Everything below the line is a sample of what `.local/AGENTS.md` might contain.
Replace it with your own reality.

# My local agent overrides

Per-developer, gitignored. Layered on top of the root `AGENTS.md`. Use this
file for environment-specific guidance that is not part of the shared project
rules.

## Git tooling

The opencode `git_*` tools (`git_add`, `git_commit`, `git_diff`, `git_log`,
etc.) are scoped to a different repository in this opencode config and reject
calls with "outside the allowed repository" when invoked here. Run all git
operations through the Bash tool instead (`git add`, `git commit`, etc.).

## Local environment

Example entries — hardware, endpoints, or paths that change how the agent
should run builds and tests on this machine.

- Ollama runs at http://localhost:11434 with a 7B model; prefer it for quick
  smoke tests of provider code.
- Builds are slow on this machine; run `npm run build` once at the end of a
  change rather than after every edit.

## Personal workflow

Example entries — your own preferences, scoped to you.

- Keep commit message subjects under 72 characters.
- When I ask to "clean up", I mean lint and formatting only, no behavior
  changes.
