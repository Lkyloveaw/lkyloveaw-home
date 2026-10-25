# Interface Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the motion timing the user approved to real login feedback, action notices, and menu opening.

**Architecture:** Keep HTML forms and current authentication; add a JSON representation of login for a small progressively enhanced browser script. Shared CSS supplies the approved motion and respects reduced motion.

**Tech Stack:** Existing Fastify, TypeScript, native JavaScript/CSS; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-interface-motion-design.md`

## Global Constraints

- Success hold 520ms, exit and entrance 220ms, displacement 6px; no artificial request delay.
- Reduced motion removes new animation and success delay. Failed login remains retryable; no automatic second POST.
- HTML login still returns 401 or redirects 302; all write origin and redirect guards remain.
- Keep native menu keyboard/touch behavior, preserve other working-tree changes, and do not deploy from this task.

## Review Focus

- Failed or malformed responses must not show success or navigate.
- Delayed replies and double submits must not create multiple requests or leave controls stuck.
- Unsafe return paths and missing/untrusted Origin must remain rejected or sanitized by the server.
- Back/forward cache restoration and page departure must cancel old callbacks.
- Existing cached CSS and reduced-motion users must get a complete, usable login.

### Task 1: Real login feedback and shared interface motion

**Files:**
- Create: `public/motion.js`, `scripts/motion-check.mjs`, `scripts/motion-browser-check.mjs`.
- Modify: `src/server.ts`, `src/auth.ts`, `src/views.ts`, `public/style.css`, `package.json`, the existing style verification expectation for the CSS URL.

**Interfaces:**
- Consumes: current `isSafeNextPath`, `isKnownPath`, `verifyPassword`, `setSession`, and common `renderNotice`.
- Produces: JSON login contract in spec; anonymous `/motion.js`; shared feedback markers; `npm run check:motion` in `verify`.

- [x] Write real-server tests for JSON login success, wrong credentials, origin failure, safe return paths, usable issued session, unchanged HTML fallback, anonymous resources and cache migration, and accessible feedback markers.
- [x] Run `npm run build && node scripts/motion-check.mjs` and observe missing JSON/asset/marker behavior fail.
- [x] Add browser state tests executing the product script: pending, duplicate submit, success timing, failed/invalid/network/timeout responses, reduced motion, unsafe response target, and page restoration cancellation. Run and observe missing script fail.
- [x] Implement the JSON branch, resource caching, native form enhancement, markup and CSS with the exact spec timing.
- [x] Run `npm run typecheck && npm run check:motion && npm run check:menu && npm run check:style`; expect exit 0 with no failures. Fix regressions before committing.
- [x] Commit only this task's code, tests and design/plan records; exclude the earlier deployment document change and user files.
- [x] Run `npm run check:all` for final task completion; expect exit 0. Verify real browser flows with an isolated preview database, never the development server's data.
- [x] Complete one independent whole-branch review and address material findings in one test-first pass if needed. Keep branch ready for review without merging or deployment.

## Execution record

The approved prototype and timing are the authorization to proceed; implementation details and inline execution are routine choices. No additional style or plan approval is needed. One final reviewer will check the completed change. The existing deployment record remains a separate uncommitted change.

## Completed verification

- Final `npm run check:all`: exit 0, E2E **584/584**. Motion routes/print **8/8**, browser state **11/11**, menu **12/12**, style **187/187**. Full log retained at `.dsh-progress/motion-execution/task-1-tests.log`.
- Independent read-only review: `gpt-6-astra`, original feature range `1466683..51ab06c`. One important URL-normalization issue and one print regression, both reproduced before fixing and covered by regression tests. The print regression was treated as functional breakage and fixed in the same pass. No deferred findings.
- Decisions: navigate using the validated absolute URL; preserve the documented printing workflow via a small shared HTML preparation helper; use local real HTTP fixtures for E2E, probe integration, restart and leak acceptance. These fixtures test the application pipeline and deliberately do not test public-internet reachability. No production probe behavior changed.
- Two initial broad runs exposed network-dependent legacy failures (E2E **576/584** from example.com timing out at 4019ms; probe integration **9/11** from a 4s assertion preceding a 5s external timeout). All original status, timeout, restart and timing assertions remain; controlled local fixtures removed the network dependency. Final broad run passed.
- Real browser against temporary database and synthetic `preview` account: wrong password, successful original-destination return, save notice, account menu, mobile native drawer, dark mode and back-navigation retry verified. At 390px the content/viewport both measured 375px; browser warnings/errors **0**. Reduced-motion navigation and timers covered by the browser script checks.
- Real browser screenshots: `.dsh-progress/motion-shots/feedback.png` and `desktop.png`. Local isolated app preview: `http://localhost:43966/`. Development server untouched by this task; deployment state was outside the review and remains outside this implementation.
- Approved standalone prototype archived separately in local branch `codex/prototype-interface-motion` (`motion-preview.html`), with the user verdict. No prototype UI or fake data is included in the application branch.
