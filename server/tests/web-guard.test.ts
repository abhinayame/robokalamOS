import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cheap guards for the web app, which has no tests of its own. They exist because a page was once overwritten by a new page with the same
 * file name and nobody noticed until a school asked where "add a program" had gone.
 */
const web = path.resolve(__dirname, '../../web/src');
const read = (f: string) => fs.readFileSync(path.join(web, f), 'utf8');

describe('web app guards', () => {
  it('keeps the Programs & Courses page and the LMS course catalog as two different pages', () => {
    const structure = read('pages/Catalog.tsx');
    expect(structure).toContain('Programs, courses & branches'); expect(structure).toContain("'catalog:manage'"); expect(structure).toMatch(/New|Add/);
    expect(read('pages/CourseCatalog.tsx')).toContain('Course catalog');
    expect(read('App.tsx')).toMatch(/path="settings\/catalog" element=\{<Guard perm="catalog:read"><Catalog \/>/);
  });
  it('keeps the main admin pages in place (each must still contain its own marker text)', () => {
    const markers: Record<string, string> = {
      'pages/Learners.tsx': 'learner', 'pages/Batches.tsx': 'batch', 'pages/Fees.tsx': 'fee', 'pages/Certificates.tsx': 'certificate', 'pages/Courses.tsx': 'New course', 'pages/CourseStudio.tsx': 'Publish',
      'pages/Teachers.tsx': 'eacher', 'pages/Communication.tsx': 'ampaign', 'pages/Leads.tsx': 'ead', 'pages/Gamification.tsx': 'adge', 'pages/Branding.tsx': 'Branding', 'pages/Reminders.tsx': 'eminder', 'pages/SystemStatus.tsx': 'System status',
    };
    for (const [f, m] of Object.entries(markers)) { expect(fs.existsSync(path.join(web, f)), f).toBe(true); expect(read(f), f).toContain(m); }
  });
  it('has a route for every menu entry, and no page file that nothing uses', () => {
    const app = read('App.tsx'); const layout = read('components/Layout.tsx');
    const routes = [...app.matchAll(/path="([^"]*)"/g)].map((m) => m[1]!).filter((p) => p !== '*');
    const matches = (to: string) => routes.some((r) => new RegExp(`^${r.replace(/\/:[^/?]+\?/g, '(?:/[^/]*)?').replace(/:[^/?]+/g, '[^/]*').replace(/\//g, '\\/')}$`).test(to.replace(/^\//, '')) || (to === '/' && true));
    const nav = [...layout.matchAll(/to: '(\/[^']*)'/g)].map((m) => m[1]!.split('?')[0]!);
    const dead = nav.filter((t) => t !== '/' && !matches(t)); expect(dead, `menu entries with no route: ${dead.join(', ')}`).toEqual([]);
    const sources = fs.readdirSync(path.join(web, 'pages')).filter((f) => f.endsWith('.tsx'));
    const all = [...sources.map((f) => read(`pages/${f}`)), ...fs.readdirSync(path.join(web, 'components')).filter((f) => f.endsWith('.tsx')).map((f) => read(`components/${f}`)), app].join('\n');
    const unused = sources.map((f) => f.replace('.tsx', '')).filter((n) => !new RegExp(`from '\\.{1,2}/(pages/)?${n}'`).test(all) && !new RegExp(`from '\\./${n}'`).test(all));
    expect(unused, `pages nothing imports: ${unused.join(', ')}`).toEqual([]);
  });
});
