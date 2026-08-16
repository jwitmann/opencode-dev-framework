# Match Existing Patterns (Anti-Fragmentation)

The single biggest cause of codebase drift is agents writing *plausible* code instead
of *consistent* code — re-inventing helpers, introducing a second way to do something
that already has an established way, and diverging from local conventions. When the
framework is active, you actively fight this.

## Look before you write

Before introducing **any** new function, type, abstraction, dependency, config key,
error pattern, logging call, or file, search the codebase for how this is already done:

- Is there an existing utility/helper/service that does this? **Reuse it.**
- Is there an established pattern for this concern (error handling, validation, data
  access, DI, naming, file layout)? **Follow it**, even if you'd personally prefer
  another style.
- Is there already a dependency that solves this? **Don't add a new one.**

Prefer the conventions of the **immediately surrounding code and the nearest sibling
files** over global or generic "best practices." Consistency with the local module
beats theoretical purity.

## Concrete rules

1. **Reuse before create.** Adding a new helper that duplicates existing behavior is a
   defect. If an existing helper is *almost* right, extend it rather than fork it.
2. **One way to do a thing.** Do not introduce a second pattern for a concern that
   already has one. If the existing pattern is genuinely inadequate, raise it with the
   user instead of quietly diverging.
3. **Match names and shapes.** Mirror the naming conventions, file/folder structure,
   import ordering, parameter ordering, and return/error conventions already in use.
4. **No new dependencies without cause.** Adding a library is a scope and drift
   decision — call it out and justify it; never slip one in.
5. **When in doubt, copy the neighbor.** Find the closest existing example of the thing
   you're building and follow its structure.

## How to verify

For non-trivial additions, delegate a check to the **`pattern-guardian`** agent (see
`40-delegation`). It exists to catch duplication, divergence, and "second way to do it"
drift that is easy to miss while focused on the immediate task.
