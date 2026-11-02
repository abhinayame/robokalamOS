# Phase 22 – UI redesign (visual only)

No server, API, route or permission changed. Same screens, same buttons, new look.

## What changed
- **Design tokens** (`web/src/tokens.css`): colour roles, radii (8/12/16/24/pill), shadows, motion timings (120/220/380/600 ms), spring + ease curves, pastel tile hues. Font: Plus Jakarta Sans (self-hosted via `@fontsource-variable`).
- **One icon set** (`components/Icon.tsx`): ~90 duotone line icons plus `IconTile` (icon on a pastel square). Menu, bottom tabs, stat tiles, buttons and empty states use it instead of emoji.
- **Shell** (`shell.css`): light sidebar with icon rows and a brand-coloured active pill, glass top bar, floating pill bottom-tab bar on phones, gradient sign-in page.
- **Dashboard kit** (`components/kit.tsx`): `HeroBanner`, `ProgressRing`, `StreakChip`, `Pill`, `Sparkline`, `CategoryTile`. `Stat` now shows an auto-chosen icon tile (override with `icon` / `hue` / `trend`).
- **Polish** (`polish.css`): buttons, inputs, pill tabs, pastel badges, tables, progress bars, skeletons; modals become bottom sheets on phones.
- **Empty states**: animated icon scene (rotating ring, floating dots) instead of an emoji.
- **Reduced motion** is respected everywhere.

## Colour themes
Branding → *Theme* has one-tap presets: Violet Pop (new default), Ocean, Forest, Sunset, Slate, Classic Navy. A school's own colours always win over the defaults.
Schools that never chose colours (the old built-in navy/amber) now show **Violet Pop**; pick **Classic Navy** to keep a navy look.

## Notes for testing
- Buttons that began with “＋” or an emoji now start with an SVG icon, so text selectors should not include the glyph.

## Step 3 – dashboards
- **Admin / teacher**: glass KPI strip inside the hero; "Needs attention" action cards (overdue fees, learners without a batch, work to review, open leads — one call to action each, swipeable on phones); quick-action tiles gated by permission; compact "At a glance" stats.
- **Learner / parent**: child switcher chips, profile card with facts, "Today" strip, level card (XP bar to the next level + progress rings), quick-entry tiles.
- Compact empty states inside dashboard cards; error states and remaining button/lesson/notification glyphs use the icon set instead of emoji (learner-facing content such as badge and course icons keeps its emoji).

## Step 4 – courses
- Shared `CourseCard` / `CourseCover`: gradient cover from the course colour, floating course icon, level / joined chips, green rating pill ("New" when unrated), lessons and duration.
- Catalog: pill search and category tiles. My courses: "Continue learning" hero with a progress ring; course cards with rings.
- Landing page: gradient hero with fact pills; a sticky join bar on phones.
- Player: dark header with a progress ring; the outline folds into a "Course content" drawer on phones; bigger next / complete button.

## Step 5 – fees and learner profile
- Fee ledger (Learner 360 → Fees, My fees): outstanding as a big numeral with an overdue / clear pill, billed / paid / credit tiles, paid progress bar, colour-coded installment rows, receipts as paper slips on phones.
- Learner 360 header with a soft brand wash and stat tiles. Long tab strips fade the edge that hides more tabs.

## Step 6 – tables on phones
- Every `table.t` with a header row becomes stacked cards below 640 px (`components/tableCards.ts` copies each header into `data-label`; `tables.css` lays it out). Wide grids opt out with `keep-table` (gradebook, training matrix, batch comparison).

## Step 7 – QA
- Swept 31 screens × 390 / 768 / 1360 px across admin, teacher, learner and parent (93 checks): no page errors, no horizontal scroll.
- axe-core (WCAG 2 A/AA, serious + critical) is clean: muted text, status inks and the warning colour were darkened to reach 4.5:1; form labels are now tied to their inputs (`Field`); progress bars have names; links inside running text are underlined; sideways-scrolling tables are keyboard-focusable.
- Bundle vs. before steps 4–7: +2.3 kB JS and +2.8 kB CSS (gzip).
- Fixed on the way: the "My courses" menu item no longer lights up on `/learners` pages.
