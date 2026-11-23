# UI redesign plan (approved and built; see the outcome in PLAN.md)

**Goal:** rebuild the web app's look as the approved dark design, without changing what the app does, its API
or its accessible names. Source of truth for the look: the design artifact
(`https://claude.ai/artifact/7jrKLP7xLZKEvGC5EQ8ogQ`: `index.html` for exact CSS values, `screens/*.png` for
every page at 1440px and 390px, `DESIGN-BRIEF.md` for the handoff notes, `fonts/` for Inter). No code has been
written yet. Approved by the owner on 2026-11-06. The owner answered the twelve open questions on 2026-11-06; their
answers are folded in below and listed in [Owner decisions](#owner-decisions).

## Decisions

| Area             | Decision                                                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope            | `web/` only. No API, schema or migration changes. Every new tile ("This week", stats KPIs and bars, lead avatars) uses data the API already returns                                                                                                                                                 |
| Theme            | Dark now, light later: only the dark theme is built, but every colour is a token (CSS variable) and components never hard-code colours, so a later light theme only redefines the tokens. Tailwind's `dark:` variant is "always on" from R1, so pages not yet restyled still render coherently dark |
| Tokens           | Defined once in `@theme` in `web/src/index.css` (`bg-s1`, `text-fg-2`, `shadow-line`, `--color-st-applied`…). No raw palette classes (`slate-*`, `blue-600`) left by the end                                                                                                                        |
| Shared pieces    | CSS in `@layer components` (`.btn-w`, `.btn-d`, `.btn-red`, `.glow`, `.pill`, `.inp`, `.seg`); small React parts in `web/src/components/ui/`                                                                                                                                                        |
| Font             | Inter variable (the provided `inter-latin.woff`, which has `fvar`/`gvar` tables) imported from CSS so Vite hashes it into `/assets/` (cached cache-first by the service worker). OFL licence shipped next to it at `web/public/fonts/Inter-OFL.txt`                                                 |
| Motion           | CSS only where possible (keyframes, `@starting-style`, scroll-driven animation on sign-in). JS only for the pointer spotlight and count-up, both behind one `useReducedMotion()` check. `prefers-reduced-motion: reduce` turns all of it off                                                        |
| Accessible names | Unchanged everywhere (list below). Where the design would change one, the markup keeps the name and the look comes from CSS (`order`, `sr-only`, `aria-hidden` decoration)                                                                                                                          |
| Tests            | E2E page objects keep their locators; three specs change on purpose (interview date format, stats "Total" row, the sign-in page's two demo buttons), each in its phase. New logic gets unit tests; new e2e checks for the CSP, "This week" and a toast                                              |
| Branch           | Straight to `main`, per the standing instruction: every small green commit is pushed to `main` and redeploys production. Production shows the dark look from R1, with some pages less polished until their phase lands                                                                              |

## Phases

Each phase is a few small commits, each green (lint, format, type-check, unit, e2e), and ends with a stop for review.

### R0. Guard rails first (no visual change)

Makes later phases safer: today nothing checks the CSP in tests (e2e runs against the Vite dev server, which sends
no CSP), and animations would make e2e timing less predictable.

| Files                         | Change                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/vite.config.ts`          | `preview.headers` sends the same `Content-Security-Policy` as `vercel.json` (read from that file, so there is one source)                                                                             |
| `e2e/playwright.config.ts`    | `reducedMotion: 'reduce'` for all projects, so counts, blur-ins and drop animations never race an assertion                                                                                           |
| `e2e/tests/csp.spec.ts` (new) | Against the production build (`:4173`): visit sign-in, list, board, a detail page, the form, leads, stats, account, privacy and 404; fail on any `securitypolicyviolation` event or CSP console error |

Tests: the new CSP spec (desktop and phone), green on the current UI before anything changes.

### R1. Foundations: tokens, font, base styles

| Files                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/src/index.css`                           | `@font-face` (Inter, `font-display: swap`), `@theme` tokens (colours, stage colours, radii, ease; `fg-3` at 50% white for text, `fg-4` at 38% for decoration only; grouped under one `:root` block that a light theme can later override), `@custom-variant dark` always on, body type (15px, `-0.011em`, `cv11`, `ss01`, `font-optical-sizing:auto`), `:focus-visible` ring, `@layer components` classes, reduced-motion and forced-colours blocks |
| `web/src/assets/fonts/inter-latin.woff` (new) | The provided font                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `web/public/fonts/Inter-OFL.txt` (new)        | Licence, required by the OFL to ship with the font                                                                                                                                                                                                                                                                                                                                                                                                  |
| `web/index.html`                              | `color-scheme: dark`, one `theme-color` `#000000`, status-bar style `black-translucent`                                                                                                                                                                                                                                                                                                                                                             |
| `web/public/manifest.webmanifest`             | `background_color` and `theme_color` `#000000` (name, display and icons unchanged: the installable test checks them)                                                                                                                                                                                                                                                                                                                                |
| `web/vite.config.ts`                          | `build.assetsInlineLimit` set so fonts are never inlined as `data:` (CSP `font-src 'self'` blocks `data:` fonts)                                                                                                                                                                                                                                                                                                                                    |

The old classes (`.btn-primary`, `.btn-secondary`, `.btn-danger`, `.input`) are re-pointed at the new looks
(`btn-w`, `btn-d`, `btn-red`, `inp`) so every page changes at once and stays usable; later phases replace them and
R10 deletes the aliases.

Tests: none new (CSS only); the R0 CSP spec covers the font loading.

### R2. Shell and shared components

| Files                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/Layout.tsx`                       | Sticky blurred nav, logo mark, links **Applications**, Leads, Stats, Account with `aria-current="page"` on the active one, Sign out pill; phones: links on a second scrollable row (44px targets); demo and offline banners restyled, same text; board width rule kept                                                                                                                                        |
| `components/ConfirmDialog.tsx`                | Native `<dialog>` kept; blurred `::backdrop`, scale-in via `@starting-style`                                                                                                                                                                                                                                                                                                                                  |
| `pages/ApplicationPages.tsx` (`NotFoundPage`) | Large gradient "404" over a glow; "Page not found" stays the `h1`                                                                                                                                                                                                                                                                                                                                             |
| `components/ui/` (new)                        | `Glow` (+ `useSpotlight`: sets `--mx/--my` with `style.setProperty`, pointer-fine devices only), `Pill`, `StageBars`, `Avatar`, `Segmented`, `PageHeader` with `RevealHeading`, `useCountUp`, `useReducedMotion`, `useSlashToFocus`                                                                                                                                                                           |
| `components/Toast.tsx` (new)                  | White pill at the bottom, `role="status"` (polite, never `alert`), one at a time, gone after 4 s, kept while hovered or focused; a `ToastProvider` in `Layout` so a toast survives the navigation after a save. Used for: application saved or deleted, moved (list menu and board), lead saved, note added, interview saved, import Undo and Dismiss. Confirmations only, no undo button (Phase 11 decision) |
| `web/src/stage.ts` (new)                      | Pure helpers: stage index and fill for the bars (closed stages empty), stage colour token, `initials(name)`                                                                                                                                                                                                                                                                                                   |

`RevealHeading` splits words into spans **with real space text nodes between them**, so the heading's accessible
name stays e.g. "Acme Robotics" (CSS gaps would make it "AcmeRobotics" and break `heading(company)`).

Tests (unit/component): `stage.test.ts` (fill per stage, closed empty, initials for one word, several words,
non-Latin and empty names); `RevealHeading` keeps its text content and name; `Layout` marks the current link
with `aria-current`; `useCountUp` renders the final value at once under reduced motion; `Toast` is a polite
`status`, replaces the previous toast, and dismisses itself; `useSlashToFocus` focuses the search on "/" and does
nothing while typing in a field, with a modifier key, or with a dialog open.

### R3. Applications list

| Files                        | Change                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/ApplicationsPage.tsx` | Header with H1 "Applications" and the summary sentence ("2 need a follow-up and you have 1 interview this week"), Pipeline tile + This week tile, filter bar (search with icon and a desktop-only "/" hint, follow-up pill with count, List/Board segmented, a compact sort select and an "Export CSV" dark pill, wrapping to a second row on phones), rows in one glow surface |
| `components/PipelineBar.tsx` | Inside the Pipeline tile: big count over the dotted stage name, funnel bars that grow in. **Stage name stays first in the DOM** (count shown above it with CSS `order`) so button names still start with the stage                                                                                                                                                              |
| `components/StatusBadge.tsx` | `Pill` variants; `FollowUpFlag` keeps the text "Needs follow-up" (clearer than the design's "Follow up", and the same words as the filter)                                                                                                                                                                                                                                      |
| `components/StatusMenu.tsx`  | The native `<select>` stays (combobox "Move X to"), styled as the Stage cell: stage bars + label + chevron; height raised from 36px to 44px                                                                                                                                                                                                                                     |
| `web/src/thisWeek.ts` (new)  | Pure: upcoming interviews (`nextInterviewOn`) and next-step dates from today through the next 6 days ("next 7 days", so it is never empty just because it is Sunday), in the user's time zone, open applications only, sorted by day; tile subtitle e.g. "Nov 6 to 12"                                                                                                          |
| `format.ts`, `timeline.ts`   | Interview dates read as on the design: "Interview Wed, Nov 12" for this year, "Interview Mon, Jan 4, 2027" for another year (today in the user's time zone)                                                                                                                                                                                                                     |
| `api/hooks.ts`               | The This week tile reads an unfiltered `useApplications({})` (cached by TanStack Query; at most 500 items), so a stage filter or search does not empty it                                                                                                                                                                                                                       |

Layout rules that protect the locators: the column headings (Company / Signals / Applied / Stage) are a
decorative `aria-hidden` row **outside** the `<ul>`; the rows stay `<li>` in the **last** list on the page (the
This week tile's list comes before it); the search keeps an `sr-only` label "Search"; the company link still
covers the row and the menu sits above it; closed rows are muted without dropping text below 4.5:1.

Tests: `thisWeek.test.ts` (window edges, today counts, day 7 does not, time zone across midnight, closed
excluded, interview and next step on the same day); `format.test.ts`/`timeline.test.ts` for the new interview
date (this year, next year, a date in late December seen from early January); update the regex in
`e2e/tests/interviews.spec.ts` to `/Interview \w{3}, \w{3} \d{1,2}(, \d{4})?/` (its interview is 10 days out, so it
can cross a year end); one e2e assertion that moving a card with the list menu shows the "Moved" toast; update `App.test.tsx` PipelineBar test to `/^Applied/` (stricter, matching e2e);
new e2e `this-week.spec.ts` (seed an application with an interview in 3 days through the API, see it in the tile;
needs an `Api.createInterview` helper in `e2e/fixtures.ts`).

### R4. Board

| Files                      | Change                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/BoardView.tsx` | Columns and cards restyled; source card at 28% while dragging; `DragOverlay` copy tilted 2.5°, scaled 1.04, deep shadow, blue glow; `isOver` column tint + stage-colour outline + white heading; drop pop and count bump; keyboard pick-up ring in the stage colour; phone tabs restyled |

Unchanged on purpose: sensors and their activation constraints, `announcements`, `oneColumnPerArrow`, the
phone breakpoint (`max-width: 639px`), column `region` names starting with the stage, "No applications", tab
names "Stage N", `Drag {company}` handles. The drop pop is a CSS class added on the new column's card after a
successful move, so it never delays the optimistic update. A one-line hint above the desktop board (`fg-2`):
"Drag a card to another stage, or focus ⠿ and use Space and the arrow keys." Hidden on phones, where moves use
the menu.

Tests: no new ones; run `board.spec.ts` with `--repeat-each=10` once locally (as in Phase 11), because the drag
look changes the overlay's size and the mouse-drag helper depends on bounding boxes.

### R5. Application detail, form and interviews

| Files                              | Change                                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/ApplicationPages.tsx`       | Detail: back link with nudge, pills above the company H1, Edit / Delete pills, Details tile (2-column `dl`), History as a vertical timeline (still a `section` named "History" with an `ol`), "from Gmail" pill. New/Edit page headers |
| `components/InterviewsSection.tsx` | Interviews tile with date blocks; same labels ("Day", "Round"), buttons and "None yet"                                                                                                                                                 |
| `components/ApplicationForm.tsx`   | Fill-from-link panel with the blue/violet wash; form in a glow surface, 2-column grid on wide screens; filled fields flash once (CSS class, reduced motion off)                                                                        |

Watch: the History list items keep their exact text order ("Applied → Interviewing", "Created as Applied",
"Interview: Onsite"); pills inside an item must not come before that text. Only one button named "Delete" on
the detail page (dialog aside).

Tests: none new beyond the existing e2e (add, edit, history, delete, interviews, fill from link).

### R6. Leads

| Files                 | Change                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/LeadPages.tsx` | List as a 3-column card grid (still `ul`/`li`) with initials avatar, application-count pill ("1 application"), latest note; detail with big avatar + name, Contact and Applications tiles, notes tile with the add-note form; lead forms restyled |

Watch: the notes region can be titled "Conversation notes" (still matches "Notes"), but its label stays "What
was said"; application links on the lead page keep the accessible name "Globex · Senior SDET" (avatar and stage
pill `aria-hidden`, or an explicit `aria-label`).

Tests: `initials` is covered in R2; existing `leads.spec.ts`.

### R7. Stats

| Files                 | Change                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/StatsPage.tsx` | KPI tiles (Applications, Applied, Responded, Response rate in gradient text) as a `dl`, from `totals`; "Response rate by source" bars (decorative bar + visible percentage); table and phone cards restyled |

Watch: KPI tiles and bars stay **outside** the table and the phone list named "Applications by source"; the
table keeps six cells per row in the same order; the footer row and the last phone card are renamed "Total" (as
designed, the usual word for a footer row), so `e2e/tests/stats.spec.ts` calls `figures('Total')`; a `null` rate still shows "–" and a zero-width bar.

Tests: component test for the KPI tiles (values from `totals`, "–" for a null rate); existing `stats.spec.ts`.

### R8. Account, Gmail import results, Privacy

| Files                         | Change                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pages/AccountPage.tsx`       | Each section a tile with an icon (`aria-hidden`); delete tile with a red tint                                                 |
| `pages/ImportResultsPage.tsx` | Changes made / Needs your review (amber outline) / Skipped tiles; Undo and Dismiss pills; card headings keep their text first |
| `pages/PrivacyPage.tsx`       | Readable prose column, copy unchanged; stays outside `Layout` (public)                                                        |

Tests: existing `account.spec.ts` and `import.spec.ts`.

### R9. Sign-in page (last, because its copy needs approval and its screenshot shows the new list)

| Files                                      | Change                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/LoginPage.tsx`                      | Hero: "New" eyebrow, headline "Every application. One calm place." (approved), existing sub-copy, Google link + demo button, existing footnote with the Privacy link, error alert, tilted screenshot, the three feature cards as designed; drifting orb |
| `components/Layout.tsx`                    | The header as designed for signed-out visitors too: app links (they lead to sign-in with `next=`, then to that page), "Try the demo" and "Sign in" (same Google link as the hero). Shared by the sign-in and privacy pages                              |
| `web/src/assets/signin-preview.webp` (new) | A static screenshot of the restyled list with sample data, decorative (`alt=""`): not a live DOM copy, which would add a second "Applications" heading and extra links                                                                                  |

With two "Try the demo" buttons on the page, the unscoped `getByRole('button', { name: 'Try the demo' })`
matches twice, so the tests target the hero's button: `getByRole('main').getByRole(...)` in
`e2e/tests/auth.spec.ts` (both uses) and `within(screen.getByRole('main'))` in `App.test.tsx`. The tilt-on-scroll uses CSS scroll-driven animation
(`animation-timeline: view()`), static where unsupported or with reduced motion.

Tests: `App.test.tsx`: the header's demo button signs in too, and there is one Privacy link; the scoped
`auth.spec.ts` and the privacy test.

### R10. Clean-up and wrap

- Delete the R1 aliases (`btn-primary`/`btn-secondary`/`btn-danger`/`input`), the temporary `--color-slate-*`
  remap in `index.css`, and any `slate-*`/`blue-*`/`rose-*` classes left (`grep` must find none in `web/src`).
- Manual pass on a phone and a desktop: keyboard-only through every page, Windows forced-colours (emulated in
  Chrome DevTools), 200% zoom, reduced motion, VoiceOver on the board.
- Docs: README screenshots and features, this plan's outcome in `plans/PLAN.md`, and `CLAUDE.md`'s convention
  "light/dark mode" changed to "dark theme (tokens ready for a light theme later)".

## E2E locators that must stay stable

From `e2e/pages/*.ts` and `e2e/tests/*.ts`, plus `web/src/*.test.tsx`. Playwright matches a string `name` as a
case-insensitive substring unless `exact: true`; regexes as written.

| Page               | Locator (role / text)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell              | button "Sign out"; text "You are using the shared demo account."; text "You're offline. Your applications will load when you're back online."                                                                                                                                                                                                                                                                                                                                       |
| Sign-in            | button "Try the demo" inside `main` (a second one sits in the header); link "Continue with Google" with its `href`; `alert` with the Google error text; **one** link "Privacy"                                                                                                                                                                                                                                                                                                      |
| Applications       | heading "Applications" level 1; link "Add application"; searchbox "Search"; button `/Needs follow-up/`; `group` "Pipeline stages" → buttons `/^{Stage}/` with the count in their text and `aria-pressed`; `group` "View" → buttons "List", "Board"; `getByRole('list').last()` → `listitem` per application; text "No applications here yet."; card text contains the stage, "Needs follow-up" and the interview date (regex updated in R3); `alert` "… was changed somewhere else" |
| Status menu        | combobox "Move {company} to" with stage values                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Board              | `region` "Board" → `region` `/^{Stage}/`, `listitem` per card, text "No applications"; button "Drag {company}"; phones: `tablist` "Stages", tabs "{Stage} {count}" with `aria-selected`, `tabpanel`                                                                                                                                                                                                                                                                                 |
| Application form   | labels "Company", "Role", "Status" (exact), "Job posting link", "Salary from", "Lead" (exact, option "Name (Company)"); buttons `/^Save/`, "Fill from link"; text `/Filled 4 fields from the posting/`, `/needs a sign-in/`                                                                                                                                                                                                                                                         |
| Detail             | heading {company} level 1; link "Edit"; button "Delete"; `region` "History" (exact) → `listitem`s in order; `dialog` with "Cancel" and "Delete"; link to the lead by name                                                                                                                                                                                                                                                                                                           |
| Interviews         | `region` "Interviews"; buttons "Add interview", "Save interview", "Remove"; labels "Day", "Round"; `listitem` text `/Onsite\s*Upcoming/`; dialog button "Remove interview"; text "None yet"                                                                                                                                                                                                                                                                                         |
| Leads              | link "Add lead"; labels "Name *", "Company" (exact), "What was said"; buttons "Save lead", "Add note"; heading {name} level 1; `region` "Notes" → `listitem`s; `region` "Applications" → link "Globex · Senior SDET"; list item with the name contains "1 application"                                                                                                                                                                                                              |
| Stats              | heading "Stats by source" level 1; `table` "Applications by source" → rows `/^{Source}/` and "Total" (renamed in R7), six cells; phones: `list` "Applications by source" → items with a heading and six `definition`s; breakpoint 640px                                                                                                                                                                                                                                             |
| Account and import | button "Delete my account" (page and dialog); `list` "Past imports" → link text "1 changed · 1 to review · 0 skipped"; heading "Gmail import" level 1; lists "Changes made", "Needs your review" → cards whose heading starts with the headline; buttons "Undo", "Dismiss"                                                                                                                                                                                                          |
| Privacy            | heading "Privacy" level 1                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Installable        | manifest `name` "Job Application Tracker", `display` "standalone", a maskable icon, PNG icons                                                                                                                                                                                                                                                                                                                                                                                       |

Where the design conflicts with a locator, and what was decided:

| Design shows                                   | Breaks                            | Plan                                              |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| Count before the stage name in Pipeline        | buttons `/^{Stage}/`              | DOM order name first, visual order by CSS (R3)    |
| Search with only a placeholder                 | searchbox "Search"                | `sr-only` label (R3)                              |
| Column headings row on the list                | `list().last()` item count        | `aria-hidden` row outside the `ul` (R3)           |
| Pill text "Follow up"                          | card contains "Needs follow-up"   | keep the text (owner: clearer for users)          |
| "Interview Wed, Nov 12" (no year)              | `/Interview \w+ \d+, \d{4}/`      | design format; spec regex updated (R3)            |
| Stats footer row "Total"                       | `figures('All sources')`          | "Total"; spec updated (R7)                        |
| Sign-in header "Try the demo" + app links      | one "Try the demo" button         | header as designed; tests scoped to `main` (R9)   |
| Lead page application row with avatar and pill | link "Globex · Senior SDET"       | keep the link text, decoration `aria-hidden` (R6) |
| Toast after a move                             | `getByRole('alert')` strict match | toasts use `role="status"` (R2)                   |

## CSP risks

The production CSP (`vercel.json`) is `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
data:; font-src 'self'; …`.

- **Fonts:** no Google Fonts; the preview embeds Inter as a `data:` URI, which `font-src 'self'` blocks, so the
  font is a file. Vite inlines small assets as `data:` by default: the limit is set so fonts never are (R1).
- **No inline `<style>` or `<script>`** in `index.html`, and no `style="…"` strings in static HTML. The
  preview's `style="--d:300ms"` stagger delays become utility classes (`rise-1` … `rise-8`).
- **React `style` props are fine** (applied through CSSOM, which CSP allows): dnd-kit's transforms already work
  in production, and the spotlight's `--mx/--my` use `style.setProperty`. Never `setAttribute('style', …)` or
  `dangerouslySetInnerHTML` with styles.
- **Images:** the sign-in screenshot is a same-origin file; CSS background SVGs may be inlined as `data:`
  (`img-src` allows it).
- **Not caught today:** e2e runs on the dev server without a CSP. R0 adds the CSP to `vite preview` and a spec
  that fails on any violation, so every later phase is checked.

## Accessibility risks

- **Contrast:** `fg-3` (white at 38%) on black is about 3.4:1, under 4.5:1 for the 12–13px labels it is
  meant for. Decided: 50% (about 5.3:1) for text, 38% only for decoration. Muted closed rows
  must stay at 4.5:1 or more. Stage colour `#3a3a40` is used for dots and bars only, never text.
- **Forced colours (Windows high contrast):** borders drawn with `box-shadow: inset` and gradient text
  (`background-clip: text; color: transparent`) disappear. A `@media (forced-colors: active)` block gives
  surfaces a real `border` and gradient text a solid colour (R1).
- **Colour never alone:** stage bars and dots are `aria-hidden`, always next to the stage name; pills always
  have text; the spotlight is decoration.
- **Touch targets 44px:** the status menu is 36px today (raised in R3); nav links on the phone row; pills that
  are buttons.
- **Headings that animate:** word spans keep space text nodes; `aria-hidden` must not be put on the spans.
- **Reduced motion:** CSS covers keyframes and transitions; the count-up and spotlight check
  `matchMedia('(prefers-reduced-motion: reduce)')` themselves; the sign-in orb and tilt stop.
- **Dark only, for now:** `color-scheme: dark` so native selects, date inputs and scrollbars are dark. Visitors
  who prefer light get dark until the light theme is built (tokens make that a contained change).
- **Toasts:** polite `status`, never moved focus, long enough to read (4 s, paused on hover and focus); toast
  text must not repeat a company name where a test uses an unscoped `getByText(company)` (only
  `installable.spec.ts` does, and it saves nothing through the UI).
- **Keyboard:** visible focus on every glow surface and on the stretched row links (focus ring on the row via
  `focus-within`); the board keeps its keyboard drag and announcements; the "/" search shortcut must not fire inside
  fields, with modifier keys or with a dialog open.
- **Dialog:** native `<dialog>` keeps focus trapping and Escape; the scale-in respects reduced motion.

## Owner decisions

Asked one at a time on 2026-11-06.

| #   | Question                | Answer                                                                                                                                                                           |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | New pieces              | Keep all: sign-in hero with the headline and three feature cards as designed, "This week" tile, stats KPI tiles and bars, lead avatars                                           |
| 2   | Theme                   | Dark now, light later: build dark only, with tokens structured so a light theme is a later, contained phase                                                                      |
| 3   | Branch                  | Straight to `main`, phase by phase                                                                                                                                               |
| 4   | Toasts                  | Add them (confirmations only, `role="status"`)                                                                                                                                   |
| 5   | Text the design changed | Owner: "do whatever makes sense for the end user". Chosen: keep "Needs follow-up"; interview dates as "Interview Wed, Nov 12" (year only when not this year); footer row "Total" |
| 6   | Sort and CSV export     | Keep both in the filter bar                                                                                                                                                      |
| 7   | "This week" window      | Next 7 days (today plus 6), interviews and next-step dates, open applications only                                                                                               |
| 8   | Sign-in header          | As designed (app links, "Try the demo", "Sign in"); tests scoped to the hero                                                                                                     |
| 9   | "/" to focus search     | Add it (Applications and Leads)                                                                                                                                                  |
| 10  | Board hint line         | Add it (desktop only)                                                                                                                                                            |
| 11  | `fg-3` contrast         | 50% white for text; 38% for decoration only                                                                                                                                      |
| 12  | Sign-in screenshot      | Static image of the real restyled list                                                                                                                                           |

## Not included

Light theme (a later phase), new features beyond the tiles above, API changes, visual regression
snapshots (not adopted in the main plan), axe checks (dropped in the scope change; could return cheaply here if
wanted).
