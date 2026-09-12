# Implementation
1. Implement schedule service and focused tests (worker owns src/schedule.js and tests/schedule.test.mjs).
2. Main session implements card renderer, background enrichment lifecycle, styles, connect grant, README and browser fixture.
3. Run npm run verify; inspect wide/narrow browser cards, switching members, selection, fallback. Review integration and scoped diff.
4. Sync generated userscript; commit scoped source/artifacts with detailed Chinese body. No push.

## Verification results
36 tests passed via npm run verify (2.2.0). Wide/360px narrow browser card checks, calendar failure and late-request cancellation passed. Avatar image failure visually checked. June 53 and September 26 real calendar events parsed by worker. Code review found no blockers; narrowed calendar failure wording. Local scaffold predates task and remains outside product commit.
