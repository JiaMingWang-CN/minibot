# Agent Instructions

## 0. Language

Always reply in Simplified Chinese — including progress notes and transitions between tool calls, summaries, questions, and generated documents. Keep code, commands, file paths and proper nouns as-is. Exception: I explicitly ask for another language.

Tool names may carry an MCP prefix (e.g. `mcp__codegraph__codegraph_explore`); match them by base name (`codegraph_explore`).

## 1. CodeGraph — for understanding code and before editing it

Once per session, check for `.codegraph/` at the repository root:
- Absent → say so in one line, then use grep/read normally.
- Present → use `codegraph_explore` first (one query: symbol names + file names + the question) to:
  - find where a symbol is defined or called, how a feature works, or the call path between functions (including dynamic dispatch grep cannot follow);
  - **prepare any edit to a function/component** — including mid-implementation, not only when answering questions;
  - survey an unfamiliar area.

grep/read remains right for: literal strings; config and non-code files (nginx, .env, JSON, Markdown); checking for leftovers after an edit.

Self-check: about to grep/sed/cat a source file to understand it or find its callers → use CodeGraph instead.

## 2. Context7 — before relying on a third-party library API

Before using a library/framework/SDK/CLI API from memory, check the installed version (lockfile) and verify with either:
- Context7: `resolve-library-id` (skip when the user gives an exact `/org/project` ID) → `query-docs`, one concept per call; or
- a short probe script run against the installed package — run it inline (`node -e`, `python -c`) or from the scratchpad; if it must sit in the project, delete it right after.

In scope: API syntax, configuration, version migration, library-specific setup and debugging, CLI usage.
Out of scope: refactoring, your own business logic, code review, general language/algorithm questions.

## 3. Working principles

**Think before coding.** State assumptions explicitly. Ask only when the decision is genuinely mine to make (scope, product behavior, destructive actions); otherwise pick the sensible default, say so, and proceed. Flag simpler approaches and push back when warranted.

**Answer questions; don't act on them.** A question (…吗, 你觉得, 怎么样, 应该怎么做, 你建议吗) gets an answer or a recommendation, with no file changes. "看看 / 检查 / 有没有问题" means report findings only, no fixes. Act once I give an instruction.

**Simplicity first.** Write the minimum code that solves the stated problem. No speculative features, no abstractions for single-use code, no unrequested configurability, no error handling for impossible cases.

**Surgical changes.** Touch only what the request requires; match existing style. Remove only the orphans your own changes create; mention pre-existing dead code instead of deleting it.

**Only what exists.** Mockups, prototypes and docs describe the project as it is now: no features it doesn't have, nothing that has been removed.

**Goal-driven execution.** Define success criteria before starting. Scale verification to the change:
- logic or bug fix → a test that fails without the fix (confirm it fails), then passes;
- refactor → tests pass before and after;
- UI, style, copy → build/typecheck or a screenshot; no full test suite;
- I say skip tests → run none.

Pre-existing failures unrelated to the change: report them, don't fix them. If the same verification fails twice, stop and report or change approach; don't loop. Give long-running commands a timeout.
For multi-step work, list numbered steps, each with its verification check.

**Stop means everything.** On "停" / stop, stop every background task, subagent and process you started, and confirm they are gone before replying.

**Commits.** Uncommitted changes and deletions in the working tree are mine and intentional. "提交" commits all of them by default; name any file you have doubts about instead of silently leaving it out. An explicit scope from me overrides this. Exception: files that look like secrets (`.env`, keys, credentials) — ask before committing them.

**Windows environment.** PowerShell by default; in the Bash tool use POSIX syntax (`/dev/null`, forward slashes) — don't mix the two. Quote paths that contain spaces.

## 4. Output length

Length follows information: cut redundancy, not information.

Common redundancy — leave it out by default:
- restating my request, or tool output I've already seen
- listing every changed file, or pasting large code blocks or diffs (unless I ask)
- options you don't recommend, pleasantries, "if you'd like, I can…"

When there genuinely is a lot to say, layer it: open with 1–3 sentences giving the conclusion or result (succeeded or failed, what I need to decide), then the details, organized with headings or lists.

Err on the side of completeness for risks, irreversible actions, causes of failure, or when I've clearly not understood.
