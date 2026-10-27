// Player-level game simulation, layered on ESPN's projections.
// ESPN's projection is each player's expected score (it already accounts for matchup, teammates,
// injuries). What this adds, fitted on every start in league history:
//   - how far actual scores land from the projection, by position (QBs steady, D/ST wild),
//     widened or narrowed for players with enough history of their own
//   - receivers moving with their own QB (measured: WR 0.37, TE 0.23; other teammates ~0)
// Used for this week's games: win chance, and the "Ones to Watch" whose games swing it most.
const SIMS = 10000;
const MIN_PROJ = 3;     // starts projected below this are too noisy to learn ratios from
const SHRINK = 10;      // weeks of position-average spread each player's own spread is blended with
const RHO = { WR: 0.37, TE: 0.23 };
const BOOM = 0.8, BUST = 0.2; // a boom is a top-20% game for that player, a bust a bottom-20% one

function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { u, z: () => { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); } };
}
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const sdOf = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

// Actual/projected ratios for every start, by position and by player
function fit(seasons, before = Infinity) {
  const pos = {}, player = {};
  for (const s of seasons) for (const w in s.lineups) {
    if (s.year * 100 + +w >= before) continue;
    for (const id in s.lineups[w]) for (const p of s.lineups[w][id]) {
      if (p.slot === "BN" || p.slot === "IR" || p.proj == null || p.proj < MIN_PROJ || p.st) continue;
      const r = p.pts / p.proj;
      (pos[p.pos] = pos[p.pos] || []).push(r);
      (player[p.n] = player[p.n] || []).push(r);
    }
  }
  const model = { pos: {}, spread: {} };
  for (const k in pos) model.pos[k] = { q: [...pos[k]].sort((a, b) => a - b), sd: sdOf(pos[k]) };
  for (const n in player) model.spread[n] = player[n];
  return model;
}
// How much wider or narrower than his position this player swings
function playerScale(model, n, pos) {
  const P = model.pos[pos], own = model.spread[n];
  if (!P || !own || own.length < 3) return 1;
  return Math.max(0.5, Math.min(1.8, (own.length * sdOf(own) + SHRINK * P.sd) / (own.length + SHRINK) / P.sd));
}
// Ratio for a position at quantile u (from that position's real distribution), scaled around its median
function ratioAt(model, pos, u, scale) {
  const q = (model.pos[pos] || model.pos.WR).q, x = u * (q.length - 1), i = Math.floor(x);
  const r = q[i] + (q[Math.min(i + 1, q.length - 1)] - q[i]) * (x - i), med = q[Math.floor(q.length / 2)];
  return med + (r - med) * scale;
}

// Simulate one game. Each side is a list of starters: { n, pos, pro, proj, pts, left }
// where left is the share of his NFL game still to play (1 before kickoff, 0 when done or on bye).
// Returns the home side's win chance and, per player still to play, his team's win chance
// when he booms and when he busts.
function simGame(model, home, away, seed = 1) {
  const R = rng(seed);
  const sides = [home, away].map((L) => L.map((p) => ({ ...p, scale: playerScale(model, p.n, p.pos), boomW: 0, boomN: 0, bustW: 0, bustN: 0 })));
  const pros = [...new Set(sides.flat().map((p) => p.pro))];
  let hw = 0;
  const us = sides.map((L) => new Float64Array(L.length));
  for (let i = 0; i < SIMS; i++) {
    const qb = Object.fromEntries(pros.map((t) => [t, R.z()])); // each NFL team's passing game
    const tot = [0, 0];
    sides.forEach((L, k) => L.forEach((p, j) => {
      let pts = p.pts || 0;
      if (p.left > 0 && p.proj > 0) {
        const rho = p.pos === "QB" ? 1 : RHO[p.pos] || 0;
        const z = rho * qb[p.pro] + Math.sqrt(1 - rho * rho) * R.z(), u = Phi(z);
        us[k][j] = u;
        pts += p.proj * p.left * ratioAt(model, p.pos, u, p.scale);
      } else us[k][j] = -1;
      tot[k] += pts;
    }));
    const win = tot[0] > tot[1] ? 0 : tot[1] > tot[0] ? 1 : R.u() < 0.5 ? 0 : 1;
    if (win === 0) hw++;
    sides.forEach((L, k) => L.forEach((p, j) => {
      const u = us[k][j]; if (u < 0) return;
      if (u >= BOOM) { p.boomN++; if (win === k) p.boomW++; } else if (u <= BUST) { p.bustN++; if (win === k) p.bustW++; }
    }));
  }
  const watch = sides.flatMap((L, k) => L.filter((p) => p.boomN && p.bustN).map((p) => ({
    side: k, n: p.n, pos: p.pos, pro: p.pro, proj: Math.round(p.proj * p.left * 10) / 10,
    boom: Math.round((p.boomW / p.boomN) * 100), bust: Math.round((p.bustW / p.bustN) * 100),
    // The point lines that make a boom or a bust for him, counting what he's already scored
    boomAt: Math.round((p.pts || 0) + p.proj * p.left * ratioAt(model, p.pos, BOOM, p.scale)),
    bustAt: Math.max(0, Math.round((p.pts || 0) + p.proj * p.left * ratioAt(model, p.pos, BUST, p.scale))),
  }))).map((x) => ({ ...x, swing: x.boom - x.bust })).sort((a, b) => b.swing - a.swing);
  return { home: hw / SIMS, watch };
}

module.exports = { fit, simGame };
