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
