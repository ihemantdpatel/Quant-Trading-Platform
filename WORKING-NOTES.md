# Working Notes

## Working Style

- Before implementing a change, restate the requirement, identify any ambiguous decisions, and recommend sensible defaults before writing code.
- Inspect existing patterns before introducing new abstractions, dependencies, or architectural changes. Match the repository's conventions first.
- Prefer the smallest change that solves the problem. Avoid unrelated refactoring.
- Explain the implementation plan briefly before making significant code changes.
- When debugging, identify and verify the root cause before proposing a fix.
- Consider failure paths (failed requests, empty data, invalid input, unexpected states) before considering a task complete.
- Before finishing, review the implementation against the original request and identify anything incomplete or any assumptions that were made.

## Development Guidelines

These are guiding principles, not rigid rules. When trade-offs exist, explain them briefly and choose the approach that best fits the existing architecture.

Prefer solutions that:

- Preserve existing architecture and coding conventions.
- Keep changes localized and easy to review.
- Minimize coupling between components and modules.
- Localize loading and error handling where appropriate.
- Preserve clear ownership of state and data.
- Optimize for correctness, readability, and maintainability before optimization.

## Communication

- When multiple reasonable approaches exist, recommend one and explain the trade-offs.
- State assumptions explicitly instead of silently choosing one interpretation.
- Keep explanations concise and focused on engineering decisions.

## Next.js Conventions

Defaults for this repo, not hard rules — deviate when a requirement or existing pattern doesn't fit, and say why.

- **Server vs. Client Components.** Default to Server Components. Add `'use client'` only where `useState`/`useEffect`/event handlers/browser APIs are needed, and prefer isolating just the interactive piece over converting the whole component.
- **Server Action vs. Route Handler.** Default to a Server Action for mutations from this app's own UI. Use a Route Handler (`route.ts`) only for endpoints called from outside the app (webhooks, third-party clients).
- **Data fetching location.** Fetch in Server Components or Server Actions, not `useEffect` — a Client Component should receive data as props or from a Server Action's return value, except for genuinely client-only cases (polling, client-only state).
- **Colocation.** Route-specific components/actions/types live next to the route (`app/characters/`) until reused by more than one route, or unless the repo's existing structure already centralizes that kind of code.
- **Loading/error boundaries.** Add `loading.tsx`/`error.tsx` per segment where a slow or failing fetch would otherwise block or crash something that doesn't need to be — skip where the boilerplate outweighs the benefit.
- **Dynamic segment naming.** Match existing bracket conventions (`[id]` vs `[slug]`) where a sibling route sets one; if none exists, pick the clearest name and note you're setting precedent.

## Code Comments

Comment **why**, not **what**.

Use comments to explain:

- Non-obvious design decisions.
- Edge-case handling.
- Framework or API behavior that isn't immediately apparent.
- Important trade-offs.

Avoid comments that simply restate what the code already expresses.
