# Prompt: premium, minimal, Zepto/Swiggy-style UI for Robokalam Learner OS (no functional change)

> Paste everything below the line into a new Claude Code session on this repository.

---

## Role
You are the global Head of Product Design & Engineering for a consumer super-app in the class of **Swiggy / Zepto**, now responsible for **Robokalam Learner OS**: a multi-tenant school SaaS (React 19 + Vite, hand-written CSS in `web/src/styles.css` + `web/src/premium.css`; Express/TypeScript API). Redesign the **look and motion only**. Every route, API call, permission, form field and test must keep working exactly as today.

## Hard rules
1. **No functional change.** Do not touch `server/`, route paths, API payloads, permissions, or business logic. Only `web/` presentation: CSS, icons, layout wrappers, copy-neutral markup, animation.
2. **Each school keeps its own brand colours** (`--brand`, `--accent` come from Settings → Branding). Ship a new default theme but derive every tint/gradient from those two variables with `color-mix()`.
3. **Accessibility stays**: AA contrast, visible focus, keyboard paths, `prefers-reduced-motion` turns all motion off, no information by colour alone.
4. **Performance**: animate `transform`/`opacity` only; no layout-shifting animation; icons are inline SVG (tree-shaken), no icon fonts, no emoji as UI chrome; page JS growth < 25 KB gz.
5. Mobile first (390 px), then tablet, then desktop. No horizontal scroll at 390 px.
6. All existing tests must pass (`server`: `npx vitest run`, `web`: `npx tsc --noEmit`, `npm run build`) and Playwright runs `e2e16`–`e2e21` style flows must still pass. Add `data-testid` only where needed; never rename existing visible text that tests use.

## What the app is (analysis of the current build)
Roles: owner/admin, branch admin, teacher, counsellor, accountant, learner, parent. ~80 screens in 14 areas:
- **Home**: role dashboards (admin KPI grid, learner "my progress", parent portal).
- **People**: learners (Learner 360 with tabs: overview, parents, batches, courses, fees, **journey**, certificates, timeline), parents, teachers, import.
- **Batches & Classroom**: batches, classroom (stream, classwork, attendance, **live** polls + QR check-in, grades, achievements, people), timetable, messages (family chat).
- **Learning (LMS)**: course studio (content with chapters → sections → lessons, details, learners, work to review, Q&A, reviews, numbers, announcements), course catalog + landing page, player (video, quiz, assignment, notes, Q&A), learning paths, question bank, team training matrix, learning record, certificates (5 templates).
- **Gamification**: XP, levels, 3D badges, leaderboards, shareable image cards.
- **Money**: fees (dues, payments, plans, receipts & discounts), discounts, payment edit/cancel, receipt designs.
- **Growth**: CRM leads, follow-ups, demo booking, WhatsApp campaigns, auto reminders, admissions.
- **Admin**: branding, programs & courses, staff & roles, audit, system status (live provider tests), reports, analytics.

Current look: dark navy sidebar with emoji icons, white rounded cards (14 px), Inter, navy/amber palette, premium.css adds gradients, hover lift, count-up, shimmer. **Weaknesses**: emoji icons render differently per device and look childish next to the data; dense 12-stat grids with no hierarchy; sameness of cards (everything is a white box); tables carry too much on mobile; little illustration or personality in empty states; the learner/parent experience (our growth loop) looks like the admin experience.

## Reference analysis (attached Zepto board)
What makes it feel premium and fast:
- **Colour**: one confident hero hue (deep violet `#4B1D8F → #7B2FF7`) plus a hot accent (magenta/coral `#FF3D7F → #FF7A59`), a gold highlight (`#FFC93C`) for rewards, mint/green only for success/ratings. Everything else is white and soft **tinted pastels** (lavender, peach, mint, butter) behind icons.
- **Shape**: 20–28 px radii, pill chips, full-bleed gradient hero banners, big rounded tiles in a 3–4 column grid, generous 16–24 px gutters.
- **Icons**: illustrated, slightly 3D objects on pastel tiles (not outline glyphs) - friendly and scannable.
- **Typography**: heavy rounded display numerals ("90% OFF") against small calm labels; two weights do all the work.
- **Motion**: carousel dots, subtle float/scale on promo art, springy press feedback, shimmering skeletons, count-ups.
- **Information design**: one idea per card, a single obvious CTA ("Grab offers", "Order now"), social proof pills (rating 4.56 in green, "Cleith user ratings").

## Competitor comparison (what to borrow)
| | Graphy / Teachable | Coursera / Udemy | Unacademy / BYJU's | Swiggy / Zepto | **Do in Robokalam** |
|---|---|---|---|---|---|
| Strength | Creator-branded storefront, clean white, one bold colour | Course cards with rating, level, duration; syllabus accordions | Streaks, daily goals, gamified rewards | Hero banners, category tiles, instant micro-delight, bottom nav | Branded hero + category tiles + streak/goal widgets + bottom nav |
| Weakness | Plain dashboards, no motion | Utilitarian | Noisy, ad-heavy | Not built for study | Keep calm: motion with purpose |
| Learner home | Course grid | "Continue learning" strip | Daily goal ring | "Reorder" row | **Continue learning** hero + goal ring + streak + next class + badges row |
| Admin home | Revenue chart | n/a | n/a | Ops dashboard with live counters | KPI hero + trend sparklines + "needs attention" queue |

## Design system to build (all in `web/src`)
1. **Tokens** (`tokens.css`): colour roles (`--surface`, `--surface-2`, `--hero-from/to`, `--accent`, `--gold`, `--ok/--warn/--bad` + soft tints), radius scale (8/12/16/24/pill), shadow scale (rest/hover/modal), spacing 4-pt, type scale. Default theme "Violet Pop" (violet/magenta/gold) AND keep any school's branding override; add 5 selectable themes in Branding (Violet Pop, Ocean, Forest, Sunset, Slate) as presets of `--brand/--accent`.
2. **Typography**: `Plus Jakarta Sans` (or Manrope) variable, self-hosted; 700/800 for numerals and headings, 500 body. Tabular numbers for money.
3. **Icon system** (`components/Icon.tsx`): one set of ~90 inline SVG icons (duotone: stroke + tinted fill) mapped to every nav item and card; `IconTile` = icon on a pastel rounded square with a soft inner gradient, in 6 hues. Replace emoji in the sidebar, page headers, stat cards, empty states, tabs and buttons. Keep emoji only where it is learner-facing content (badge names, reactions).
4. **Illustrations**: 12 lightweight SVG empty-state scenes (no courses, no payments, no messages, no classes today, etc.) in the brand palette.
5. **Layout**: desktop = slim light sidebar (icon + label, active pill) or collapsible icon rail; top bar with search, bell, avatar; mobile = bottom tab bar (Home, Classes, Learn, Messages, Me) with floating centre action. Max content width 1280, 24 px gutters.
6. **Components**: `HeroBanner` (gradient, floating art, one CTA), `StatTile` (IconTile + big numeral + delta pill + sparkline), `CategoryTile` grid, `CourseCard` (cover gradient, level chip, rating pill, progress ring), `ProgressRing`, `StreakChip`, `Pill`/`Chip`, `RatingPill` (green), `PriceTag`, `Skeleton` variants, `Toast`, sheet-style modals on mobile (slide up from the bottom).

## Screen-by-screen direction
- **Admin dashboard**: replace the 13-card grid with (1) a gradient **hero KPI strip** (Learners, Collected this month, Outstanding, Attendance) with sparklines; (2) a "Needs attention" carousel (overdue fees, absent today, leads to call, submissions to review) as coloured action cards with one CTA each; (3) quick-action tiles (Add learner, Record payment, New batch, Send announcement) as icon tiles; (4) charts below the fold.
- **Learner home**: purple hero "Continue learning: <course>" with progress ring and ▶ Resume; row of **today's classes** (live pill, QR check-in); XP/level bar with animated 3D badge; streak chip; "Your badges" horizontal scroller (new ones shimmer); next level CTA.
- **Parent portal**: child switcher chips on top; "Today" card (class, attendance), fee due card with big amount and Pay button, latest report, message teacher.
- **Course catalog / landing**: Zepto-style category tile grid, course cards with rating pill, level chip, duration, and a sticky "Join for free" bar on mobile.
- **Course player**: dark distraction-free theme, collapsible outline drawer, big Next/Complete button, progress ring in the header, confetti on completion.
- **Fees**: dues as colour-coded cards (amount in heavy numerals, days-late pill), receipts as paper-style preview; discount sheet with live "learner pays" ticker.
- **Tables** (learners, payments, audit): keep the table on desktop; on mobile render as stacked cards with the primary field bold and two key facts; sticky filter chips.
- **Login**: split hero (brand gradient + illustration) and a calm form.
- **Certificates / badges / share cards**: keep the generated art; bring the UI frame in line (tiles, glow).

## Motion language (Zepto/Swiggy feel)
- Durations: 120 ms press, 220 ms hover/tab, 380 ms enter, 600 ms count-up/fill. Easing: `cubic-bezier(.22,1,.36,1)` (out) and a gentle spring `cubic-bezier(.34,1.56,.64,1)` for pops.
- Page enter: content rises 12 px + fades, stagger 40 ms for the first 8 children. Route change: cross-fade, no layout jump.
- Press: scale .97 with shadow collapse; hover: lift 3 px; active tab: sliding underline pill.
- Numerals count up once; progress rings sweep; promo art floats ±6 px over 4 s; badges shimmer once when new.
- Skeletons everywhere data loads; optimistic toasts that slide from the top right (bottom on mobile).
- Celebration moments only for real achievements (course complete, level up, payment received).
- Everything respects `prefers-reduced-motion`.

## Colour guidance
Default: hero `#4B1D8F → #7B2FF7`, accent `#FF3D7F`, gold `#FFC93C`, ink `#1B1530`, muted `#6E6A85`, surface `#FFFFFF`, canvas `#F6F4FB`, pastel tiles lavender `#EFE7FF`, peach `#FFE9DC`, mint `#DDF6EA`, butter `#FFF3CC`, sky `#E3F0FF`, rose `#FFE3EE`. Success `#12A06E`, warning `#E59A00`, danger `#E5484D`. Use gradients only on heroes, primary CTAs and rewards; keep data surfaces flat white for legibility. Never put body text on a saturated gradient below AA contrast.

## Delivery plan (small, reviewable steps)
1. Tokens + font + Icon/IconTile + theme presets (Branding page).
2. Shell: sidebar/top bar/bottom nav, login.
3. Dashboards (admin, learner, parent) with the new components.
4. LMS surfaces (catalog, landing, player, studio).
5. Fees, receipts UI, journey, learner 360.
6. Tables → mobile cards; empty-state illustrations; skeleton pass.
7. QA: Playwright screenshots at 390/768/1360 for 25 key screens; axe-core accessibility scan; reduced-motion run; Lighthouse performance ≥ 90 on dashboard.

## Acceptance criteria
- Zero functional diffs: all server tests green, all e2e flows green, no changed API calls.
- No emoji icons left in chrome; every nav item and stat has an `Icon`.
- Same app, 3 themes switchable in Branding, per-school colours still win.
- 390 px: no horizontal scroll; tap targets ≥ 44 px.
- Reduced-motion users see no animation.
- Before/after screenshot sheet attached to the PR.
