/** Number of pages for `total` rows; an empty result still has one (empty) page. */
export const pageCount = (total: number, pageSize: number) => Math.max(1, Math.ceil(total / pageSize));

/** Page numbers for a compact pager: first, last and the current page's neighbours, `null` marking each gap. */
export function pageWindow(page: number, pages: number): Array<number | null> {
  const shown = [...new Set([1, page - 1, page, page + 1, pages])].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  let prev = 0;
  for (const p of shown) {
    // A gap of a single page shows that page rather than an ellipsis.
    if (p - prev === 2) out.push(p - 1);
    else if (p - prev > 2) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}
