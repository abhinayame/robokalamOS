# Phase 20: restore Programs & Courses, close gaps, premium animated UI

## What went wrong, and the fix
In Phase 18 the new **LMS course catalog** page was saved as `web/src/pages/Catalog.tsx`, which is the file name of the existing **Programs & Courses** page (Settings → Programs & Courses). It overwrote that page, so the "New program" and "New course" buttons disappeared for admins and teachers.
- The original page is **restored** exactly as it was.
- The LMS catalog now lives in its own file, `CourseCatalog.tsx` (menu: **Course catalog**).
- **Teachers can add programs and courses** (the `catalog:manage` permission, migration `024`), as well as admins and branch admins.
- A new test (`server/tests/web-guard.test.ts`) fails the build if a menu entry has no page, if a page file is no longer used by anything, or if the Programs & Courses page or the LMS catalog is overwritten again.

## Full re-check against the earlier versions
Compared with the version before the LMS work: **no route, menu entry or API endpoint was removed**, and the only overwritten file was `Catalog.tsx`. A second sweep of every API endpoint looking for ones with no screen found two real gaps, now added:
- **School details** (Settings → Branding): change the school name and time zone.
- **Recent e-mails** (System status): the last e-mails sent, with delivery status and any error.

## Premium animated UI
Same screens, a more polished feel (light, GPU-friendly motion; switches off for people who prefer reduced motion):
- Page entrance (content rises in, cards stagger), smooth route changes.
- Numbers on dashboards **count up**; progress bars **fill in** with a soft sheen.
- Cards lift on hover, buttons press, primary buttons glow; sliding tab underline.
- Brand-gradient sidebar with an animated active pill and icon hover; translucent blurred top bar and mobile bottom bar.
- Modals spring in over a blurred backdrop; toasts slide in; shimmering loading skeletons; floating empty-state icons.
- A new animated sign-in page. All colours still follow each school's own branding.

## Verified
325 server tests. Browser run (`e2e20`): admin adds a program and sees New course, a **teacher** sees and can use both, school name saved, e-mail log shown, no overflow on a phone, no console errors; the Phase 18 and 19 runs still pass.
