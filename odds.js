// Championship / playoff / last-place odds after every week of a season, by Monte Carlo.
// After week N, each team's strength is a blend of:
//   - its points per game so far, pulled toward the league average early on, and
//   - ESPN's projection for its starting lineup the next week (so pickups and trades show up right away).
// The rest of the regular season and the bracket are then played out SIMS times.
const SIMS = 5000;
const PRIOR_GAMES = 2;   // how many league-average games each team starts with
const PROJ_WEIGHT = 0.35; // share of the next-week lineup projection in a team's strength

// Small seeded random generator so the odds don't wobble from one rebuild to the next
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => { let x = 0, y = 0; while (x === 0) x = u(); y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
}
const r1 = (n) => Math.round(n * 10) / 10;

function seasonOdds(s) {
  const ids = s.teams.map((t) => t.id);
  const isStart = (p) => p.slot !== "BN" && p.slot !== "IR";
  const spans = (mp) => ((s.periods || {})[mp] || [mp]).map(Number).sort((a, b) => a - b);
  const reg = s.matchups.filter((m) => m.wk <= s.regWeeks);
  const done = (m) => m.win !== null && !m.live;
  // Last week whose games are all finished
  let lastDone = 0;
  for (let w = 1; w <= s.regWeeks + 8; w++) { const ms = s.matchups.filter((m) => m.wk === w); if (ms.length && ms.every(done)) lastDone = w; else if (ms.length || w <= s.regWeeks) break; }
  const scores = []; // finished regular-season team scores
  for (const m of reg.filter(done)) scores.push(m.hp, m.ap);
  if (!scores.length && !s.lineups[1]) return null;
  const leagueAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 100;
  // Spread of a team's weekly score around its own average
  const byTeam = {};
  for (const m of reg.filter(done)) { (byTeam[m.h] = byTeam[m.h] || []).push(m.hp); (byTeam[m.a] = byTeam[m.a] || []).push(m.ap); }
  let ss = 0, n = 0;
  for (const id in byTeam) { const a = byTeam[id]; const mu = a.reduce((x, y) => x + y, 0) / a.length; for (const v of a) { ss += (v - mu) ** 2; n++; } }
  const sd = n > 8 ? Math.sqrt(ss / (n - Object.keys(byTeam).length)) : 25;
  // ESPN projections run a bit high or low; scale them to what teams actually scored
  let act = 0, prj = 0;
  for (const wk in s.lineups) for (const id in s.lineups[wk]) for (const p of s.lineups[wk][id]) if (isStart(p) && p.proj != null && s.played.some((m) => m.wk === (s.sp2mp?.[wk] ?? +wk))) { act += p.pts; prj += p.proj; }
  const calib = prj > 0 ? act / prj : 1;
  // Next week's projected starting lineup. Starters projected at zero (byes, injuries) are treated
  // like an average starter, since a manager normally fills that spot.
  const projFor = (id, mp) => {
    const L = (s.lineups[spans(mp)[0]] || {})[id]; if (!L) return null;
    const st = L.filter(isStart), live = st.filter((p) => p.proj != null && p.proj > 0.5);
    if (live.length < 5) return null;
    return (live.reduce((a, p) => a + p.proj, 0) / live.length) * st.length * calib;
  };

  const lastCheck = s.done ? Math.max(...s.matchups.map((m) => m.wk)) : Math.min(lastDone, s.regWeeks);
  const weeks = [];
  const out = Object.fromEntries(ids.map((id) => [id, { c: [], p: [], l: [], str: [] }]));
  const po = s.playoffTeams;
  const seedActual = Object.fromEntries(s.teams.map((t) => [t.id, t.seed]));

  for (let N = 0; N <= lastCheck; N++) {
    weeks.push(N);
    // Records and points through week N
    const base = Object.fromEntries(ids.map((id) => [id, { w: 0, pf: 0, g: 0, pts: 0 }]));
    for (const m of reg.filter((m) => done(m) && m.wk <= N)) {
      base[m.h].pf += m.hp; base[m.a].pf += m.ap; base[m.h].g++; base[m.a].g++; base[m.h].pts += m.hp; base[m.a].pts += m.ap;
      if (m.win === m.h) base[m.h].w++; else if (m.win === m.a) base[m.a].w++; else { base[m.h].w += 0.5; base[m.a].w += 0.5; }
    }
    const mean = {};
    for (const id of ids) {
      const b = base[id];
      const avg = (b.pts + PRIOR_GAMES * leagueAvg) / (b.g + PRIOR_GAMES);
      const pj = projFor(id, N + 1);
      mean[id] = pj != null ? (1 - PROJ_WEIGHT) * avg + PROJ_WEIGHT * pj : avg;
      out[id].str.push(r1(mean[id]));
    }
    // Remaining regular-season games (anything after week N, finished or not)
    const rest = [...reg.filter((m) => m.wk > N).map((m) => [m.h, m.a]), ...(s.future || []).filter((m) => m.wk > N).map((m) => [m.h, m.a])];
    const regOver = N >= s.regWeeks;
    const gauss = rng(s.year * 1000 + N);
    const cnt = Object.fromEntries(ids.map((id) => [id, { c: 0, p: 0, l: 0 }]));
    const playRound = (mp, a, b) => {
      // A round that already happened keeps its real winner
      if (s.done && mp <= N) { const m = s.matchups.find((x) => x.wk === mp && [x.h, x.a].includes(a) && [x.h, x.a].includes(b)); if (m && m.win) return m.win; }
      const len = spans(mp).length;
      const sa = mean[a] * len + gauss() * sd * Math.sqrt(len), sb = mean[b] * len + gauss() * sd * Math.sqrt(len);
      return sa >= sb ? a : b;
    };
    for (let i = 0; i < SIMS; i++) {
      let seeds;
      if (regOver && s.done) seeds = [...ids].sort((a, b) => (seedActual[a] || 99) - (seedActual[b] || 99));
      else {
        const rec = Object.fromEntries(ids.map((id) => [id, { w: base[id].w, pf: base[id].pf }]));
        for (const [h, a] of rest) {
          const sh = mean[h] + gauss() * sd, sa = mean[a] + gauss() * sd;
          rec[h].pf += sh; rec[a].pf += sa;
          if (sh >= sa) rec[h].w++; else rec[a].w++;
        }
        seeds = [...ids].sort((a, b) => rec[b].w - rec[a].w || rec[b].pf - rec[a].pf);
      }
      const field = seeds.slice(0, po);
      field.forEach((id) => cnt[id].p++);
      // Bracket: 1v4 & 2v3, or the top seed gets a bye with 3 teams; winners meet in the final
      const r1mp = s.regWeeks + 1, r2mp = s.regWeeks + 2;
      // Last place is settled by the losers' ladder among the non-playoff teams, as ESPN does it:
      // 2 teams: the final-round game's loser. 3 teams: the loser of the top two (the worst seed
      // sits out). 4 teams: the two first-round losers meet and that loser is last.
      const bottom = seeds.slice(po), lastMp = po >= 3 ? r2mp : r1mp;
      const loser = (mp, a, b) => (playRound(mp, a, b) === a ? b : a);
      let lastTeam = seeds[seeds.length - 1];
      if (bottom.length === 2) lastTeam = loser(lastMp, bottom[0], bottom[1]);
      else if (bottom.length === 3) lastTeam = loser(r1mp, bottom[0], bottom[1]);
      else if (bottom.length === 4) lastTeam = loser(lastMp, loser(r1mp, bottom[0], bottom[3]), loser(r1mp, bottom[1], bottom[2]));
      cnt[lastTeam].l++;
      let champ;
      if (po >= 4) { const w1 = playRound(r1mp, field[0], field[3]), w2 = playRound(r1mp, field[1], field[2]); champ = playRound(r2mp, w1, w2); }
      else if (po === 3) { const w = playRound(r1mp, field[1], field[2]); champ = playRound(r2mp, field[0], w); }
      else if (po === 2) champ = playRound(r1mp, field[0], field[1]);
      else champ = field[0];
      cnt[champ].c++;
    }
    for (const id of ids) { out[id].c.push(r1((cnt[id].c / SIMS) * 100)); out[id].p.push(r1((cnt[id].p / SIMS) * 100)); out[id].l.push(r1((cnt[id].l / SIMS) * 100)); }
  }
  return { weeks, t: out, sims: SIMS, sd: r1(sd) };
}

module.exports = { seasonOdds };
