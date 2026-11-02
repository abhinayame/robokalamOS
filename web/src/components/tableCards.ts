import { useEffect } from 'react';

/**
 * Phones show `table.t` as stacked cards (see tables.css). Each cell needs its column name for that, so this copies
 * the header text into `data-label` on every cell, and keeps doing so as tables render or change. Presentation only.
 */
function label(table: HTMLTableElement) {
  const head = table.tHead?.rows[0];
  const on = !!head && !table.classList.contains('keep-table');
  if (table.classList.contains('tc') !== on) table.classList.toggle('tc', on);
  if (!head || !on) return;
  const names: string[] = [];
  for (const th of Array.from(head.cells)) { const t = (th.textContent ?? '').trim(); for (let i = 0; i < (th.colSpan || 1); i++) names.push(t); }
  for (const body of Array.from(table.tBodies)) for (const tr of Array.from(body.rows)) {
    let col = 0;
    for (const td of Array.from(tr.cells)) {
      const name = names[col] ?? '';
      if (td.getAttribute('data-label') !== name) td.setAttribute('data-label', name);
      col += td.colSpan || 1;
    }
  }
}

export function useTableCards(root: () => HTMLElement | null) {
  useEffect(() => {
    const el = root(); if (!el || typeof MutationObserver === 'undefined') return;
    let raf = 0;
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => {
      el.querySelectorAll<HTMLTableElement>('table.t').forEach(label);
      // a table that scrolls sideways must be reachable by keyboard
      el.querySelectorAll<HTMLElement>('.table-wrap').forEach((w) => { const s = w.scrollWidth > w.clientWidth + 1; if (s && !w.hasAttribute('tabindex')) w.setAttribute('tabindex', '0'); else if (!s && w.getAttribute('tabindex') === '0') w.removeAttribute('tabindex'); });
    }); };
    run();
    const mo = new MutationObserver(run); mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });   // React may reset className on re-render
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, [root]);
}
