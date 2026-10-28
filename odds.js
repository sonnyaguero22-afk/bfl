// Championship / playoff / last-place odds after every week of a season, by Monte Carlo.
// After week N, each team gets two strengths:
//   - next week: ESPN's projection for the lineup it has actually set, holes included. Tested on
//     2023-25 (127 games), this picked 68% of winners vs 55% for season averages blended in.
//   - later weeks: a blend of points per game (pulled toward the league average) and next week's
//     lineup projection with holes filled, played with a wider spread, since games 2+ weeks out
//     tested as close to coin flips.
//   - later weeks also lose what a team's starters on NFL byes are worth over their best bench fill-in
// The rest of the regular season and the bracket are then played out SIMS times, with ties in
// the standings broken by head-to-head record among the tied teams, then points for.
const SIMS = 5000;
const PRIOR_GAMES = 5;    // how many league-average games each team starts with
const PROJ_WEIGHT = 0.6;  // share of the lineup projection in a team's later-weeks strength
const FAR_SPREAD = 1.9;   // later weeks' spread, as a multiple of the weekly score spread
const DECAY = 0.8;        // each week further back counts this much less in points per game (backtested on 2023-25)

// Small seeded random generator so the odds don't wobble from one rebuild to the next
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => { let x = 0, y = 0; while (x === 0) x = u(); y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
}
const r1 = (n) => Math.round(n * 10) / 10;

// Standings order: wins, then head-to-head win share among the teams tied on wins, then points for
function rank(ids, rec, H) {
  const byWins = {};
  for (const id of ids) (byWins[rec[id].w] = byWins[rec[id].w] || []).push(id);
  return Object.keys(byWins).map(Number).sort((a, b) => b - a).flatMap((w) => {
    const g = byWins[w];
    if (g.length === 1) return g;
    const share = (id) => { let won = 0, n = 0; for (const o of g) if (o !== id) { const x = H[id][o] || 0, y = H[o][id] || 0; won += x; n += x + y; } return n ? won / n : 0.5; };
    return g.map((id) => ({ id, sh: share(id) })).sort((a, b) => b.sh - a.sh || rec[b.id].pf - rec[a.id].pf).map((x) => x.id);
  });
}

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

  // The lineup a team has actually set for a week, as ESPN projects it (byes and injuries count as zero)
  const setFor = (id, mp) => {
    const L = (s.lineups[spans(mp)[0]] || {})[id]; if (!L) return null;
    const st = L.filter(isStart);
    return st.length ? st.reduce((a, p) => a + (p.proj || 0), 0) * calib : null;
  };

  // Points a team loses in week wk to NFL byes: each starter on bye (in its lineup set for week from)
  // minus the best bench player at his position who isn't also off that week. Needs s.nflByes.
  // Backtested on 2023-25 games 2-5 weeks out: Brier 0.2497 to 0.2417 (0.2451 to 0.2322 where a bye applied).
  const byeLoss = (id, from, wk) => {
    const byes = s.nflByes; if (!byes) return 0;
    const L = (s.lineups[spans(from)[0]] || {})[id]; if (!L) return 0;
    const off = (p) => byes[p.pro] === wk, used = new Set();
    let loss = 0;
    for (const p of L.filter((p) => isStart(p) && off(p) && p.proj > 0)) {
      const sub = L.filter((b) => b.slot === "BN" && !used.has(b) && !off(b) && b.pos === p.pos && b.proj != null).sort((a, b) => b.proj - a.proj)[0];
      if (sub) used.add(sub);
      loss += Math.max(0, p.proj - (sub ? sub.proj : 0)) * calib;
    }
    return loss;
  };

  const lastCheck = s.done ? Math.max(...s.matchups.map((m) => m.wk)) : Math.min(lastDone, s.regWeeks);
  const weeks = [];
  const out = Object.fromEntries(ids.map((id) => [id, { c: [], p: [], l: [], str: [], far: [] }]));
  const po = s.playoffTeams;
  const seedActual = Object.fromEntries(s.teams.map((t) => [t.id, t.seed]));

  for (let N = 0; N <= lastCheck; N++) {
    weeks.push(N);
    // Records and points through week N
    const base = Object.fromEntries(ids.map((id) => [id, { w: 0, pf: 0, wsum: 0, wpts: 0 }]));
    const h2h = Object.fromEntries(ids.map((id) => [id, {}])); // h2h[a][b] = a's wins over b (ties count half)
    const beat = (H, a, b, x) => { H[a][b] = (H[a][b] || 0) + x; };
    for (const m of reg.filter((m) => done(m) && m.wk <= N)) {
      base[m.h].pf += m.hp; base[m.a].pf += m.ap;
      const wt = DECAY ** (N - m.wk); // recent weeks count more
      base[m.h].wsum += wt; base[m.a].wsum += wt; base[m.h].wpts += wt * m.hp; base[m.a].wpts += wt * m.ap;
      if (m.win === m.h) { base[m.h].w++; beat(h2h, m.h, m.a, 1); } else if (m.win === m.a) { base[m.a].w++; beat(h2h, m.a, m.h, 1); }
      else { base[m.h].w += 0.5; base[m.a].w += 0.5; beat(h2h, m.h, m.a, 0.5); beat(h2h, m.a, m.h, 0.5); }
    }
    const far = {}, next = {};
    for (const id of ids) {
      const b = base[id];
      const avg = (b.wpts + PRIOR_GAMES * leagueAvg) / (b.wsum + PRIOR_GAMES);
      const pj = projFor(id, N + 1);
      far[id] = pj != null ? (1 - PROJ_WEIGHT) * avg + PROJ_WEIGHT * pj : avg;
      next[id] = setFor(id, N + 1) ?? far[id];
      out[id].str.push(r1(next[id]));
      out[id].far.push(r1(far[id]));
    }
    // A game's scores: next week's from the set lineups, later weeks' from the wider blend minus bye losses
    const score = (id, mp, len = 1) => mp === N + 1 ? next[id] * len + gauss() * sd * Math.sqrt(len) : (far[id] - byeLoss(id, N + 1, mp)) * len + gauss() * sd * FAR_SPREAD * Math.sqrt(len);
    // Remaining regular-season games (anything after week N, finished or not)
    const rest = [...reg.filter((m) => m.wk > N).map((m) => [m.h, m.a, m.wk]), ...(s.future || []).filter((m) => m.wk > N).map((m) => [m.h, m.a, m.wk])];
    const regOver = N >= s.regWeeks;
    const gauss = rng(s.year * 1000 + N);
    const cnt = Object.fromEntries(ids.map((id) => [id, { c: 0, p: 0, l: 0 }]));
    const playRound = (mp, a, b) => {
      // A round that already happened keeps its real winner
      if (s.done && mp <= N) { const m = s.matchups.find((x) => x.wk === mp && [x.h, x.a].includes(a) && [x.h, x.a].includes(b)); if (m && m.win) return m.win; }
      const len = spans(mp).length;
      const sa = score(a, mp, len), sb = score(b, mp, len);
      return sa >= sb ? a : b;
    };
    for (let i = 0; i < SIMS; i++) {
      let seeds;
      if (regOver && s.done) seeds = [...ids].sort((a, b) => (seedActual[a] || 99) - (seedActual[b] || 99));
      else {
        const rec = Object.fromEntries(ids.map((id) => [id, { w: base[id].w, pf: base[id].pf }]));
        const H = Object.fromEntries(ids.map((id) => [id, { ...h2h[id] }]));
        for (const [h, a, wk] of rest) {
          const sh = score(h, wk), sa = score(a, wk);
          rec[h].pf += sh; rec[a].pf += sa;
          if (sh >= sa) { rec[h].w++; beat(H, h, a, 1); } else { rec[a].w++; beat(H, a, h, 1); }
        }
        seeds = rank(ids, rec, H);
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
  return { weeks, t: out, sims: SIMS, sd: r1(sd), farSd: r1(sd * FAR_SPREAD) };
}

module.exports = { seasonOdds };
