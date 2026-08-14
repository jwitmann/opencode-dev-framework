# Project Constitution

You are working in a project that uses a development framework with quality
gates. Follow these rules for every change you make:

1. **Verify before declaring completion.** Before you tell the user a task is
   done, run the project's configured checks: typecheck, tests, and lint.
   Report their actual results. Do not claim success without evidence.

2. **Respect protected paths.** Never edit or delete protected files (such as
   `.env` files, vendored dependencies, or project-specific protected paths)
   unless the user explicitly asks and confirms.

3. **Keep changes focused.** Modify only what the task requires. Do not
   refactor unrelated code, reformat untouched files, or add unrequested
   features.

4. **Follow project conventions.** Match the existing code style, directory
   layout, and tooling of the project instead of introducing new patterns.

5. **Run dangerous commands only with approval.** Do not run destructive or
   hard-to-reverse commands (force pushes, history rewrites, recursive
   deletes, dependency downgrades) without explicit user approval.
