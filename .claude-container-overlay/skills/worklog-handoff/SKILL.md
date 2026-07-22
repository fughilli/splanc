---
name: worklog-handoff
description: Use a WORKLOG.md alongside git commit history so a freshly-started agent (fresh context, no memory of prior sessions) can reliably pick up where the last one left off. Read this at the START of a session to orient before touching code, and follow it at the END to hand off cleanly. Trigger when starting work on an unfamiliar repo, resuming a multi-session task, being asked "where did we leave off", or wrapping up a session that isn't fully finished.
---

# WORKLOG.md + git history for cross-session handoff

A fresh agent starts with **no memory** of what previous agents did. Two
durable records survive a session; used together they let the next agent resume
without re-deriving everything:

- **Git commit history** — the authoritative record of *what is done, committed,
  and verified*. It is trustworthy (it reflects the actual tree) and immutable.
  But it is retrospective: it says what happened, not what's half-finished, why a
  path was abandoned, or what to do next.
- **`WORKLOG.md`** — a single checked-in file holding the *current state of
  play*: what's in flight, what's next, open questions, blockers, and dead ends
  not to retry. It is the forward-looking, volatile complement to git.

The division of labor is the whole point:

> **Git records the past. The WORKLOG points at the future.** Never duplicate
> in the WORKLOG what a `git log` already tells you — reference commits by hash
> instead. Keep in the WORKLOG only what is *not* recoverable from the tree.

---

## Startup ritual (do this before touching code)

When you begin a session on a repo that uses this convention:

1. **Read `WORKLOG.md`** (repo root). It tells you the goal, the current focus,
   and the intended next step.
2. **Reconcile it against git.** Run:
   ```
   git log --oneline -20
   git status
   git diff            # uncommitted work in progress, if any
   ```
   The WORKLOG can be stale (an agent may have committed but not updated it, or
   crashed mid-task). Git is ground truth for *what exists*; the WORKLOG is the
   *intent*. Where they disagree, trust the tree for facts and the WORKLOG for
   direction — and note the discrepancy.
3. **Check for uncommitted work.** A dirty tree from a prior session means work
   was interrupted. Read the diff before deciding whether to build on it,
   commit it, or discard it — don't blindly `git checkout`.
4. **Confirm the "Next up" item still makes sense** given what git shows as
   already done. Then start there.

If there is no `WORKLOG.md`, create one (template below) once you've figured out
the current state — the next agent will thank you.

---

## Shutdown ritual (do this before the session ends)

Leave the repo so the next agent can start cold. Before you stop:

1. **Commit completed, verified work** with a descriptive message (see commit
   style below). Committed work is the handoff for *what's done* — don't also
   narrate it in the WORKLOG.
2. **Update `WORKLOG.md`** to reflect reality *now*:
   - Move finished items out of "In progress"; point at their commit hashes.
   - Rewrite "Next up" so it's the very first thing the next agent should do.
   - Record any blocker, half-finished edit, or decision-in-flight under "State
     of play" — especially anything **not** captured by a commit (an
     uncommitted experiment, a failing test you're mid-diagnosis on, a design
     choice you're still weighing).
   - Add dead ends to "Don't retry" with a one-line why, so the next agent
     doesn't burn a session re-exploring them.
3. **Leave the tree in a known state.** Prefer either a clean tree (everything
   committed) or, if you must stop mid-edit, a WORKLOG note that says exactly
   what the uncommitted diff is and whether it's meant to be kept.

---

## `WORKLOG.md` template

Keep it short and current — it is a live status board, not a diary. Prune
resolved items; the git history is the archive.

```markdown
# WORKLOG

_Last updated: 2026-07-09 by an agent session. Read together with `git log`._

## Goal
One or two sentences: what we're ultimately trying to achieve.

## State of play
Where things stand right now — the part you can't get from `git log`:
- What's working and verified (link commits: `see a1b2c3d`).
- What's partially done and how far (e.g. "solver wired, not yet gated on RMS").
- Any uncommitted work in the tree and whether to keep it.

## Next up
The single most immediate next action, concretely. Then anything after it.
1. …
2. …

## Open questions / blockers
- Decisions not yet made; things waiting on the user or an external fact.

## Don't retry (dead ends)
- Approach X — why it failed / was rejected (one line), so nobody re-explores it.
```

Guidelines:

- **One file, repo root, committed.** `WORKLOG.md` travels with the code and is
  visible to every agent and to the user. (If the repo prefers `docs/`, put it
  there and say so in `CLAUDE.md`.)
- **Absolute dates, not relative.** "2026-07-09", never "yesterday" — the next
  agent doesn't know when you wrote it.
- **Link, don't duplicate.** Reference commits by short hash rather than
  restating what changed; the commit body already holds that detail.
- **Volatile only.** Durable architecture/rationale belongs in `CLAUDE.md`, a
  decision log, or code comments — not the WORKLOG. The WORKLOG is for *now*.

---

## Make the commit history carry its weight

The WORKLOG only works as the "future" half if the "past" half — git — is
genuinely informative. Write commits a future agent can reconstruct intent from:

- **Descriptive subject** (what changed, imperative mood), then a **body** that
  explains *why* and notes verification (tests run, results observed). The
  strong existing commits in a well-kept repo read like mini design notes — a
  subject line plus a paragraph of rationale and a bullet list of the concrete
  changes and their measured effect.
- **Commit in coherent units.** One logical change per commit makes the history
  a readable narrative the next agent can scan with `git log --oneline`.
- **State verification in the body.** "26 test targets green", "recovers
  140 mm → 0.34 mm" — so the next agent knows what was actually confirmed versus
  merely written.
- Follow the repo's commit conventions (trailers, co-author lines, PR-linking).
  Check an existing `git log` before writing your first commit.

A good split: if information is **durable and tied to a specific change**, it
goes in the **commit**. If it's **volatile and about what to do next**, it goes
in the **WORKLOG**. When unsure, ask "will this still be true and useful after
the next three commits?" — if yes, it's commit/CLAUDE.md material; if it's about
the present moment, it's the WORKLOG.

---

## Failure modes to avoid

- **WORKLOG as changelog.** If it just restates commit subjects, it rots and
  adds no value. Keep it forward-looking.
- **Stale "Next up".** An out-of-date next step is worse than none — it sends
  the next agent down a path git already shows as done. Always reconcile against
  `git log` on the way in *and* out.
- **Trusting the WORKLOG over the tree for facts.** It can lie (crashes, forgot
  to update). Git is ground truth for *what exists*; the WORKLOG is *intent*.
- **Uncommitted work with no note.** A dirty tree the next agent can't interpret
  is a trap. Either commit it or describe it in "State of play".
