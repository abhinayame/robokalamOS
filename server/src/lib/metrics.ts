/** In-process counters for /api/system/status. Cheap, resets on restart, no labels with unbounded cardinality. */
const started = Date.now();
const BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000];
const state = { total: 0, byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<string, number>, slow: 0, buckets: new Array(BUCKETS.length + 1).fill(0) as number[], routes: new Map<string, { n: number; ms: number; max: number; errors: number }>(), lastError: null as null | { at: string; route: string; status: number }, };

export function record(route: string, status: number, ms: number) {
  state.total++;
  state.byClass[`${Math.floor(status / 100)}xx`] = (state.byClass[`${Math.floor(status / 100)}xx`] ?? 0) + 1;
  if (ms > 2000) state.slow++;
  state.buckets[BUCKETS.findIndex((b) => ms <= b) === -1 ? BUCKETS.length : BUCKETS.findIndex((b) => ms <= b)]++;
  if (state.routes.size < 300 || state.routes.has(route)) {
    const r = state.routes.get(route) ?? { n: 0, ms: 0, max: 0, errors: 0 };
    r.n++; r.ms += ms; r.max = Math.max(r.max, ms); if (status >= 500) r.errors++;
    state.routes.set(route, r);
  }
  if (status >= 500) state.lastError = { at: new Date().toISOString(), route, status };
}

/** Approximate percentile from the histogram (upper bound of the bucket that contains it). */
function pct(p: number) {
  if (!state.total) return null;
  let acc = 0; const want = state.total * p;
  for (let i = 0; i < state.buckets.length; i++) { acc += state.buckets[i]; if (acc >= want) return i < BUCKETS.length ? BUCKETS[i] : null; }
  return null;
}

export function snapshot() {
  const routes = [...state.routes.entries()].map(([route, r]) => ({ route, requests: r.n, avg_ms: Math.round(r.ms / r.n), max_ms: Math.round(r.max), errors: r.errors }));
  return {
    uptime_seconds: Math.round((Date.now() - started) / 1000), started_at: new Date(started).toISOString(),
    requests: state.total, by_status: state.byClass, slow_over_2s: state.slow,
    latency_ms: { p50_le: pct(0.5), p95_le: pct(0.95), p99_le: pct(0.99), note: 'upper bound of the histogram bucket; null means above 5000' },
    slowest_routes: routes.sort((a, b) => b.max_ms - a.max_ms).slice(0, 8), busiest_routes: [...routes].sort((a, b) => b.requests - a.requests).slice(0, 8),
    last_server_error: state.lastError,
  };
}
