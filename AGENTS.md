# Agent workflow

## Branches and worktrees

- Before starting each major change, create a new, dedicated Git branch and a new Git worktree for that branch. Perform the change in that worktree.
- Major changes include new features, substantial bug fixes, refactors, migrations, and changes spanning multiple components. When in doubt, treat the work as a major change.
- Use descriptive branch names that explain the actual change, for example `feat/nested-archive-support`, `fix/archive-scanning`, or `docs/agent-workflow`. Branch names must never contain `codex`.
- Create the branch and worktree before editing files, for example: `git worktree add -b <descriptive-branch-name> <new-worktree-path> <base-branch>`.
- Do not reuse a branch or worktree from a different major change, or perform major changes directly on the default branch.

## Commits

- Commit every meaningful change as a separate, focused commit once its relevant checks pass. Do not defer all commits until the end of a larger task or combine unrelated changes.
- Use semantic commit messages following Conventional Commits: `<type>(<optional-scope>): <description>`, for example `feat(scanner): support nested archives` or `docs: define agent workflow`.
- Choose the type that describes the change, such as `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, or `chore`. Mark breaking changes with `!` and explain them in the commit body.
- Review the diff and stage only files belonging to that meaningful change. Preserve unrelated user changes and never commit secrets or generated artifacts unless they are intentionally tracked.

## Review, merge, and cleanup

- Before merging a branch, use the user's [`@review` skill from Artilities](https://github.com/AngelaDMerkel/artilities/blob/main/.agents/skills/review/SKILL.md). Read and follow the current skill, including its independent review and publication requirements.
- Merge only the reviewed revision after its checks, findings, and required approvals are satisfied. Preserve semantic commits; follow the skill's merge method.
- After verifying the merge, remove the task's merged branches and dedicated worktrees. Preserve unrelated work and never discard unmerged commits or uncommitted changes during cleanup.
