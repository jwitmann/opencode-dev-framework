---
name: match-patterns
description: >
  Before adding new code, find how the codebase already does the thing and
  conform to it — reuse existing helpers, follow the established pattern, and
  avoid introducing a second way to do it or an unjustified dependency. Use
  whenever you're about to create a new helper, abstraction, module, config
  key, or dependency.
---

# Match Existing Patterns

The fastest way to fragment a codebase is to write plausible new code instead
of consistent code. This skill is the "look before you write" discipline.

## When to use

Right before you introduce anything new: a function/helper, a type, a module or
file, a config key, an error/logging pattern, or a third-party dependency.

## Steps

1. **Name the concern.** State what you're about to add and the concern it
   addresses (e.g. "a helper to parse durations", "retry logic for HTTP calls",
   "input validation").

2. **Search for prior art.** Look for existing solutions before writing:

   ```bash
   # by likely name/symbol
   grep -rin "parse.*duration\|duration.*parse" --include=*.<ext> .
   # by the concern's call sites
   grep -rin "retry\|backoff" --include=*.<ext> .
   ```

   Also read the **nearest sibling files** to the code you're changing — they
   define the local convention.

3. **Decide and conform:**
   - If a helper/utility already exists → **reuse it** (extend it if it's
     almost right; don't fork a near-duplicate).
   - If an established pattern exists for this concern → **follow it**, even
     if you'd personally prefer another approach.
   - If a dependency already covers it → **use that**; do not add a new one.
   - Mirror the local naming, file placement, import ordering, and
     return/error shapes.

4. **Justify any genuine new thing.** If nothing exists and you must add
   something new, say so explicitly and explain why, and model the new thing on
   the closest existing example so it still fits. Call out any new dependency
   to the user.

5. **Verify consistency.** For non-trivial additions, delegate to the
   **pattern-guardian** agent to confirm you didn't duplicate or diverge.

## Output

State what you searched for, what prior art you found, and your decision (reuse
/ follow existing pattern / justified new addition). If introducing anything
new, include the justification and the existing example you modeled it on.
