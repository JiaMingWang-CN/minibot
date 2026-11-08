---
name: ask-plan
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write implementation plans for an engineer who has not seen this codebase or this spec. Assume they write idiomatic code in the project's language and make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and types connect the tasks, how each piece should work, which values and limits the spec pins, and which behaviors prove each task. Document those as **approach (思路) and constraints (约束)** — never as code. The implementer writes every test and every function body. DRY. YAGNI. TDD. Frequent commits (when the project is a git repository).

**Announce at start:** "I'm using the ask-plan skill to create the implementation plan."

**Input:** A spec/design doc (typically in `docs/specs/`), or requirements your human partner gave you directly. If there is no written spec, the requirements from the conversation are the spec: summarize them in the plan header, and if something that would change the plan is missing, ask about it before writing.

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- (User preferences for plan location override this default)

**Git is optional:** Check once whether the project is a git repository. If it is, plans include commit steps and the plan itself is committed. If it is not, leave out every commit step and just save the file.

## No Code in Plans

- No test code, no function bodies, no class or module skeletons, no code blocks of source.
- Describe tests as behaviors: `condition → expected result`, with the spec's exact values.
- Describe implementation as approach: what happens in what order, which library call or data structure, what the algorithm does — in prose or short bullets.
- Allowed literals, inline in backticks: names and type signatures in the Interfaces block, exact values the spec pins (numbers, paths, URLs, error copy, regexes, enum values), and the commands to run.
- If you feel the need to write code to make a step unambiguous, write the missing decision as a constraint instead.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs when it was written. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Each task's requirements include the Global Constraints below; each task's Interfaces block tells you the names and types neighboring tasks use. The plan gives approach and constraints only — you write the tests and the code. Steps use checkbox (`- [ ]`) syntax for tracking — tick each one as it is done.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements — executors
read both. If there is no written spec, a short summary of the
requirements as your human partner gave them.]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

## Review Focus

[The five input classes or failure modes the spec implies but no task's
acceptance list covers that are most likely to bite a person using this
software — one line each, naming the input or condition and the behavior a
reasonable person would expect, most likely first. The spec's silence on an
input is not permission for that input to break the program. Then, for each
line, add an acceptance item to the task that owns the code.]

---
```

## Task Structure

```markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts`
- Test: `tests/exact/path/to/file.test.ts`

**Interfaces:**
- Consumes: [names and signatures this task uses from earlier tasks, one line each]
- Produces: [names, parameter and return types later tasks rely on, one line each — signatures only, no bodies]

**思路:**
- [How it works: order of operations, library calls, data structures, the algorithm in words. Only what the signatures and constraints leave open.]

**约束:**
- [Exact values, limits, error copy, platform rules, security rules, what must NOT be done — each one line, values copied from the spec.]

**验收:**
- [`test name`: condition → expected result, with exact values. One behavior per line. These are the tests the implementer writes.]

- [ ] **Step 1:** Write the tests in **验收**; run `<command>` — expect FAIL.
- [ ] **Step 2:** Implement per **思路** and **约束**.
- [ ] **Step 3:** Run `<command>` — expect PASS.
- [ ] **Step 4:** Commit (git repositories only — omit otherwise).
```

For UI, copy or style work, Step 1–3 become: implement → run build/typecheck (`<command>`) → manual check with the exact things to look at or screenshot.

## What Each Section Contains

A task is done being written when the implementer can build exactly one reasonable thing from it — unambiguous, not complete.

- **Interfaces:** names and types only. This is the contract between tasks; it is the one place signatures appear.
- **思路:** decisions about *how*, stated in words. Skip anything an experienced engineer would do the same way without being told.
- **约束:** decisions about *what must hold*. Every value the spec pins lives here or in Global Constraints, verbatim.
- **验收:** decisions about *what proves it*. Each line names a test and states input and expected output precisely enough that two implementers would write equivalent tests.

Lines that decide nothing ("TBD", "handle edge cases", "add appropriate validation", "write tests for the above", a type or function no task defines) are a gap. Code is a transcript. The self-review catches both.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. No code:** Search the plan for code blocks and test bodies. Every code block other than a command to run is removed and replaced by approach, constraints or acceptance lines.

**3. Ambiguity scan:** For each task, could two implementers build materially different things from 思路 + 约束 + 验收? If so, add the missing decision. If a line decides nothing, delete it or make it decide something.

**4. Type consistency:** Do names, signatures and property names in later tasks match the Interfaces blocks of earlier tasks? `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**5. Review Focus:** For each input class or failure mode the spec implies, is there an acceptance line that covers it? The five uncovered ones most likely to bite a person go in the Review Focus section, and each gets an acceptance line in its owning task. An empty section means you checked and found none.

**6. Proportion:** The plan should be no longer than the spec it implements, give or take. Much longer means it is describing code; cut to decisions.

**7. Git consistency:** In a git repository, tasks end with a commit step; outside one, no step mentions git.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After saving and self-reviewing the plan, link it for your human partner
to read. If they have already explicitly supplied an execution method, ask
them to review the plan and confirm it captures what they want; wait for that
review before implementation, then use the preserved method. Otherwise, ask
them to review the plan and choose an execution method before implementation.

**When no execution method has already been supplied:**

**"Plan complete and saved to `docs/plans/<filename>.md`. Please review the plan. Which execution approach would you prefer?**

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-change review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole change. Cheapest and fastest; no independent review until the end.

**For this plan I recommend <one of the two>, because <one sentence from the plan: how much the tasks depend on each other's interfaces, how many there are, what a shipped mistake would cost>. Does the plan capture what you want, and which approach should we use?"**

**When an execution method has already been supplied:**

**"Plan complete and saved to `docs/plans/<filename>.md`. Please review the plan. Does it capture what you want?"**

**If Subagent-driven chosen:**
- For each task, in order: dispatch a fresh implementer subagent with the plan path, the spec path, and the task number. It reads the plan header (Global Constraints, Review Focus) and its own task, writes the tests from **验收**, implements per **思路** and **约束**, ticks the checkboxes, and reports what it did and the test output.
- Then dispatch a fresh reviewer subagent with the same paths and task number. It checks the change against the task's Interfaces, 思路, 约束, 验收 and the Global Constraints, runs the task's tests, and reports problems ranked by severity.
- Fix what the reviewer found (yourself or via the implementer) before starting the next task.
- After the last task, dispatch one fresh reviewer for the whole change against the spec and the Review Focus list. Report the result to your human partner.

**If Native chosen:**
- Work through the tasks yourself, in order, ticking each checkbox when done. If a step's result doesn't match its expected outcome, stop and fix before moving on.
- After the last task, dispatch one fresh reviewer subagent on the most capable model to check the whole change against the spec and the Review Focus list. Fix what it finds, then report the result to your human partner.
