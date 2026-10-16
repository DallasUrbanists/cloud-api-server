---
name: staged-commit
description: Review staged Git changes, write a concise commit message that reflects them, and create the commit when the user asks to commit staged work.
user-invocable: true
---

# Staged Commit

Use this skill when asked to prepare a commit message for staged changes or to commit staged changes.

## Workflow

1. Inspect repository status and the staged diff (`git status --short`, `git diff --cached --stat`, and `git diff --cached`). Base the message only on changes that are actually staged. Do not include unstaged or untracked work in the commit.
2. If nothing is staged, explain that and stop; do not create an empty commit or stage files on the user's behalf.
3. Identify the main purpose of the staged changes and write a short imperative subject, usually under 72 characters. Use the repository's established commit style if it is evident from recent history. Add a body only when it clarifies important context or distinct changes.
4. If the user asks only for a message, return the proposed message without committing. If they ask to commit, execute `git commit -m "..."` with the selected message. The request to commit authorizes that commit; do not ask again.
5. If Git refuses the commit (for example, hooks fail), report the result and relevant output. Do not bypass hooks, amend, reset, or retry with a different scope unless the user requests it.
6. After a successful commit, report the commit hash and subject, and check status to show whether other changes remain.

## Message Quality

- Describe the user-facing purpose or behavior, not a file inventory.
- Keep wording specific and factual; avoid claiming effects that the diff does not establish.
- Follow any explicit format requested by the user (such as Conventional Commits).
- Never alter the staged set as part of composing the message.
