// Turns the raw ESPN files in data/ (plus finished seasons saved in archive/) into the history site.
// Writes public/ (the deployable site) and site/data.js.
// Run: node build.js
const fs = require("fs");
const path = require("path");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const ARCHIVE = path.join(__dirname, "archive");
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const exists = (f) => fs.existsSync(path.join(DATA, f));

const SLOT = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "BN", 21: "IR", 23: "FLEX" };
const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const PRO = { 0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };
const r2 = (n) => Math.round(n * 100) / 100;
// Normal distribution helper for live win chances
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const HISTORY = path.join(__dirname, "history");

// Stable short key per manager (so we never publish ESPN account IDs)
const managerKeys = {};
function managerKey(guid, member) {
  if (!managerKeys[guid]) {
    const base = (member && member.firstName ? member.firstName : "mgr").toLowerCase().replace(/[^a-z]/g, "");
    let k = base, i = 2;
    while (Object.values(managerKeys).includes(k)) k = base + i++;
    managerKeys[guid] = k;
  }
  return managerKeys[guid];
}

const seasons = [];
const pendingHistory = []; // in-game win chances to save once the player sim has run
const managers = {};
const years = fs.readdirSync(DATA).map((f) => (f.match(/^league_(\d{4})\.json$/) || [])[1]).filter(Boolean).sort();

for (const year of years) {
  const L = load(`league_${year}.json`);
  if (!L.teams) { console.log(`skip ${year} (no data)`); continue; }
  const players = exists(`players_${year}.json`) ? new Map(load(`players_${year}.json`).map((p) => [p.id, p])) : new Map();
  const pname = (id) => (players.get(id) || {}).fullName || `Player ${id}`;
  const ppos = (id) => POS[(players.get(id) || {}).defaultPositionId] || "";
  const ppro = (id) => PRO[(players.get(id) || {}).proTeamId] || "";
  const membersById = new Map((L.members || []).map((m) => [m.id, m]));
  const ss = L.settings.scheduleSettings;
  const regWeeks = ss.matchupPeriodCount;
  const lastWeek = L.status.latestScoringPeriod;
  const done = !L.status.isActive || L.status.isExpired || L.teams.some((t) => t.rankCalculatedFinal > 0);

  const teamMgr = {};
  const teams = L.teams.map((t) => {
    // A team with no owner (someone left mid-way) gets its own "No manager" entry per season
    const guid = t.primaryOwner || t.owners[0] || `none-${year}-${t.id}`;
    const m = membersById.get(guid);
    const key = managerKey(guid, m || { firstName: "nomanager" });
    if (m || !managers[key]) managers[key] = m ? { key, name: `${m.firstName} ${(m.lastName || "")[0] || ""}.`.trim(), first: m.firstName } : { key, name: "No manager", first: "No mgr" };
    teamMgr[t.id] = key;
    const o = t.record.overall;
    return {
      id: t.id, mgr: key, name: (t.name || `${t.location} ${t.nickname}`).trim(), abbrev: t.abbrev, logo: t.logo || "",
      w: o.wins, l: o.losses, t: o.ties, pf: r2(o.pointsFor), pa: r2(o.pointsAgainst),
      streak: `${o.streakType === "WIN" ? "W" : o.streakType === "LOSS" ? "L" : "T"}${o.streakLength}`,
      seed: t.playoffSeed, final: t.rankCalculatedFinal || 0,
      adds: t.transactionCounter.acquisitions, trades: t.transactionCounter.trades,
    };
  });

  // Matchups (only weeks that have been played)
  const matchups = L.schedule
    .filter((s) => s.away && s.matchupPeriodId <= L.status.currentMatchupPeriod)
    .map((s) => ({
      wk: s.matchupPeriodId, h: s.home.teamId, a: s.away.teamId,
      hp: r2(s.home.totalPoints), ap: r2(s.away.totalPoints),
      win: s.winner === "HOME" ? s.home.teamId : s.winner === "AWAY" ? s.away.teamId : s.winner === "TIE" ? 0 : null,
      tier: s.playoffTierType, // NONE, WINNERS_BRACKET, LOSERS_CONSOLATION_LADDER, ...
    }))
    ;
  // Regular-season games not played yet (the odds simulator needs the rest of the schedule)
  const future = L.schedule
    .filter((s) => s.away && s.matchupPeriodId > L.status.currentMatchupPeriod && s.matchupPeriodId <= ss.matchupPeriodCount)
    .map((s) => ({ wk: s.matchupPeriodId, h: s.home.teamId, a: s.away.teamId }));
  // Byes in playoffs (no away team)
  const byes = L.schedule.filter((s) => !s.away).map((s) => ({ wk: s.matchupPeriodId, h: s.home.teamId, tier: s.playoffTierType }));

  // Weekly lineups
  // NFL bye weeks by pro team id (proTeamSchedules_wl)
  const nflBye = {}, nflByes = {}; // by pro team id, and by abbreviation for odds.js (and the same-game measurement)
  const proTeams = exists(`proteams_${year}.json`) ? ((load(`proteams_${year}.json`).settings || {}).proTeams || []) : [];
  for (const t of proTeams) { nflBye[t.id] = t.byeWeek; if (PRO[t.id]) nflByes[PRO[t.id]] = t.byeWeek; }
  const lineups = {};
  const owner = {}; // week -> playerId -> teamId (for trade detection)
  for (let w = 1; w <= lastWeek; w++) {
    if (!exists(`wk_${year}_${w}.json`)) continue;
    const W = load(`wk_${year}_${w}.json`);
    lineups[w] = {}; owner[w] = {};
    for (const s of W.schedule) {
      for (const side of [s.home, s.away]) {
        if (!side || !side.rosterForCurrentScoringPeriod) continue;
        lineups[w][side.teamId] = side.rosterForCurrentScoringPeriod.entries.map((e) => {
          const p = e.playerPoolEntry.player;
          owner[w][e.playerId] = side.teamId;
          // ESPN's projection for that week (statSourceId 1), used for over/underperformance
          const pj = (p.stats || []).find((x) => x.statSourceId === 1 && x.scoringPeriodId === w);
          // st: "bye", or "out" when he has no stats for the week (settled below, once his game is over)
          const act = (p.stats || []).find((x) => x.statSourceId === 0 && x.scoringPeriodId === w);
          const st = nflBye[p.proTeamId] === w ? "bye" : !(act && Object.keys(act.stats || {}).length) && !e.playerPoolEntry.appliedStatTotal ? "dnp" : undefined;
          return { n: p.fullName, pos: POS[p.defaultPositionId] || "", pro: PRO[p.proTeamId] || "", slot: SLOT[e.lineupSlotId] || "BN", pts: r2(e.playerPoolEntry.appliedStatTotal || 0), proj: pj ? r2(pj.appliedTotal) : null, st, _pt: p.proTeamId };
        });
      }
    }
  }

  // Draft
  const draft = (L.draftDetail && L.draftDetail.picks || []).map((p) => ({
    pk: p.overallPickNumber, rd: p.roundId, rp: p.roundPickNumber, tm: p.teamId, n: pname(p.playerId), pos: ppos(p.playerId), pro: ppro(p.playerId), keeper: p.keeper,
  }));

  // Adds/drops
  const moves = [];
  for (let w = 1; w <= lastWeek; w++) {
    if (!exists(`tx_${year}_${w}.json`)) continue;
    for (const x of load(`tx_${year}_${w}.json`).transactions || []) {
      if (x.status !== "EXECUTED" || !["WAIVER", "FREEAGENT", "ROSTER"].includes(x.type)) continue;
      const items = (x.items || []).filter((i) => i.type === "ADD" || i.type === "DROP");
      if (!items.length) continue;
      moves.push({
        wk: x.scoringPeriodId, date: x.processDate || x.proposedDate, tm: x.teamId, kind: x.type === "WAIVER" ? "Waiver" : "Free agent",
        bid: x.bidAmount || 0,
        add: items.filter((i) => i.type === "ADD").map((i) => `${pname(i.playerId)}|${ppos(i.playerId)}`),
        drop: items.filter((i) => i.type === "DROP").map((i) => `${pname(i.playerId)}|${ppos(i.playerId)}`),
      });
    }
  }
  moves.sort((a, b) => a.date - b.date);

  // Trades: players that jumped directly from one team to another between weeks
  // (ESPN keeps trade details behind a login, so we infer them from rosters)
  const trades = [];
  const weeks = Object.keys(owner).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < weeks.length; i++) {
    const prev = owner[weeks[i - 1]], cur = owner[weeks[i]];
    const groups = {};
    for (const pid in cur) {
      const from = prev[pid], to = cur[pid];
      if (from && to && from !== to) {
        const key = [from, to].sort().join("-");
        (groups[key] = groups[key] || { wk: weeks[i], teams: key.split("-").map(Number), got: {} });
        (groups[key].got[to] = groups[key].got[to] || []).push(`${pname(+pid)}|${ppos(+pid)}`);
      }
    }
    trades.push(...Object.values(groups));
  }
  // Players traded in the current week won't show up in a lineup yet; use current rosters as the final snapshot
  if (weeks.length) {
    const prev = owner[weeks[weeks.length - 1]], groups = {};
    for (const t of L.teams) for (const e of t.roster.entries) {
      const from = prev[e.playerId];
      if (from && from !== t.id && e.acquisitionType === "TRADE") {
        const key = [from, t.id].sort().join("-");
        (groups[key] = groups[key] || { wk: lastWeek + 1, teams: key.split("-").map(Number), got: {} });
        (groups[key].got[t.id] = groups[key].got[t.id] || []).push(`${pname(e.playerId)}|${ppos(e.playerId)}`);
      }
    }
    trades.push(...Object.values(groups));
  }
  // Drop players who actually arrived by waiver/free agency, then any empty groups
  for (const tr of trades) for (const to in tr.got)
    tr.got[to] = tr.got[to].filter((p) => !moves.some((m) => m.tm === +to && m.add.includes(p) && m.wk <= tr.wk && m.wk >= tr.wk - 2));
  const inferred = trades.filter((tr) => Object.values(tr.got).some((g) => g.length));
  // A hand-checked list wins when one exists (multi-team deals can't be inferred reliably)
  // Later trades are still inferred automatically.
  let finalTrades = inferred;
  if (exists(`trades_${year}.json`)) {
    const manual = load(`trades_${year}.json`);
    const upTo = Math.max(...manual.map((t) => t.wk));
    finalTrades = [...manual, ...inferred.filter((t) => t.wk > upTo)];
  }

  // Share of each NFL team's game still to play this week: 1 before kickoff, 0 when final
  // or on bye, in between by the game clock. Null when the saved scoreboard is for another week.
  let nflClock = null, gamesOn = false;
  if (exists("nfl_scoreboard.json")) {
    const sb = load("nfl_scoreboard.json");
    if (sb.season && sb.season.year === +year && sb.week && sb.week.number === L.status.latestScoringPeriod) {
      const games = {};
      for (const ev of sb.events || []) {
        const st = ev.status || {}, state = st.type && st.type.state;
        const played = Math.min(60, (Math.max(1, st.period || 1) - 1) * 15 + (15 - (st.clock || 0) / 60));
        const f = state === "pre" ? 1 : state === "post" ? 0 : Math.max(0, 1 - played / 60);
        for (const c of ev.competitions[0].competitors) games[+c.team.id] = f;
      }
      nflClock = (proTeamId) => games[proTeamId] ?? 0;
      gamesOn = (sb.events || []).some((ev) => ev.status && ev.status.type && ev.status.type.state === "in");
    }
  }
  // A player with no stats only counts as out once his NFL game is over (earlier weeks always are)
  for (const w in lineups) for (const id in lineups[w]) for (const p of lineups[w][id]) {
    if (p.st === "dnp") p.st = +w < L.status.latestScoringPeriod || (nflClock && nflClock(p._pt) === 0) ? "out" : undefined;
    if (!p.st) delete p.st;
    delete p._pt;
  }
  // Live scores for the week in progress
  if (exists(`wk_${year}_${L.status.currentMatchupPeriod}.json`)) {
    const W = load(`wk_${year}_${L.status.currentMatchupPeriod}.json`);
    for (const m of matchups) {
      if (m.win !== null || m.wk !== L.status.currentMatchupPeriod) continue;
      const s = W.schedule.find((x) => x.matchupPeriodId === m.wk && x.home.teamId === m.h);
      if (!s) continue;
      m.live = true;
      m.on = gamesOn; // an NFL game is being played right now
      m.hp = r2(s.home.totalPointsLive || 0);
      m.ap = r2(s.away.totalPointsLive || 0);
      // Live projected finals: points so far plus what each starter is still expected to score.
      // (ESPN's totalProjectedPoints is only the pre-game total, so it can't be used here.)
      // Starters for the player-level sim (players.js), run once every season is loaded.
      // left: share of his NFL game still to play. Without a scoreboard, only a game that hasn't started can be simulated.
      if (nflClock || (m.hp === 0 && m.ap === 0)) m._sides = [s.home, s.away].map((side) => (side.rosterForCurrentScoringPeriod || { entries: [] }).entries
        .filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21).map((e) => {
          const p = e.playerPoolEntry.player, pj = (p.stats || []).find((x) => x.statSourceId === 1 && x.scoringPeriodId === m.wk);
          const left = nflClock ? nflClock(p.proTeamId) : nflBye[p.proTeamId] === m.wk ? 0 : 1;
          return { n: p.fullName, pos: POS[p.defaultPositionId] || "", pro: PRO[p.proTeamId] || `FA-${p.id}`, proj: pj ? pj.appliedTotal : 0, pts: e.playerPoolEntry.appliedStatTotal || 0, left };
        }));
      if (nflClock) {
        for (const [side, key] of [[s.home, "h"], [s.away, "a"]]) {
          // Each player's remaining points can miss by about 60% either way (booms and busts)
          let rem = 0, left = 0, vr = 0;
          for (const e of (side.rosterForCurrentScoringPeriod || { entries: [] }).entries) {
            if (e.lineupSlotId === 20 || e.lineupSlotId === 21) continue; // bench / IR
            const p = e.playerPoolEntry.player;
            const pj = (p.stats || []).find((x) => x.statSourceId === 1 && x.scoringPeriodId === m.wk);
            const f = nflClock(p.proTeamId), r = (pj ? pj.appliedTotal : 0) * f;
            if (f > 0) left++;
            rem += r;
            vr += (0.6 * r) ** 2;
          }
          m[key + "proj"] = r2(m[key + "p"] + rem);
          m[key + "left"] = left;
          m[key + "var"] = r2(vr);
        }
      }
    }
  }

  const histFile = path.join(HISTORY, `live_${year}.json`);
  const wp = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, "utf8")) : {};
  pendingHistory.push({ matchups, wp, histFile });

  // Current rosters
  const rosters = {};
  for (const t of L.teams) {
    rosters[t.id] = t.roster.entries.map((e) => {
      const p = e.playerPoolEntry.player;
      return { n: p.fullName, pos: POS[p.defaultPositionId] || "", pro: PRO[p.proTeamId] || "", slot: SLOT[e.lineupSlotId] || "BN", how: e.acquisitionType, pts: r2(e.playerPoolEntry.appliedStatTotal || 0) };
    });
  }

  seasons.push({
    year: +year, name: L.settings.name, done, curWeek: L.status.currentMatchupPeriod, regWeeks,
    on: matchups.some((m) => m.on), nflByes: done ? undefined : nflByes, playoffTeams: ss.playoffTeamCount, periods: ss.matchupPeriods, teams, future, matchups, byes, lineups, draft, moves, trades: finalTrades, rosters, wp,
  });
  for (const w of [L.status.latestScoringPeriod - 1, L.status.latestScoringPeriod]) if (lineups[w]) { const all = Object.values(lineups[w]).flat(); console.log(`::notice::${year} week ${w}: on bye ${all.filter((p) => p.st === "bye").map((p) => p.n).join(", ") || "none"}; out ${all.filter((p) => p.st === "out").map((p) => p.n).join(", ") || "none"}; games on now: ${gamesOn}`); }
  if (!done) {
    const sch = L.settings.scheduleSettings || {};
    console.log(`::notice::${year} ESPN tiebreak settings: ${JSON.stringify(Object.fromEntries(Object.entries({ ...sch, ...(L.settings.scoringSettings || {}) }).filter(([k]) => /tie|seed|rule/i.test(k))))}`);
  }
  if (!done) console.log(`::notice::${year} trades found: ${finalTrades.map((t) => `before week ${t.wk}, teams ${t.teams.join(" & ")}`).join("; ") || "none"}`);
  console.log(`${year}: ${teams.length} teams, ${matchups.length} matchups, ${Object.keys(lineups).length} weeks of lineups, ${draft.length} picks, ${moves.length} moves, ${trades.length} trades`);
}

// Finished seasons are saved to archive/ (only what the site shows, no ESPN account IDs),
// so they don't need raw ESPN files again. Load any archived season we didn't build from raw data.
fs.mkdirSync(ARCHIVE, { recursive: true });
for (const s of seasons) if (s.done) {
  const mg = Object.fromEntries([...new Set(s.teams.map((t) => t.mgr))].map((k) => [k, managers[k]]));
  fs.writeFileSync(path.join(ARCHIVE, `${s.year}.json`), JSON.stringify({ season: s, managers: mg }));
}
for (const f of fs.readdirSync(ARCHIVE).filter((f) => /^\d{4}\.json$/.test(f))) {
  const y = +f.slice(0, 4);
  if (seasons.some((s) => s.year === y)) continue;
  const A = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), "utf8"));
  // NFL byes for the odds (saved schedule, by team abbreviation)
  const nf = path.join(ARCHIVE, `nfl_${y}.json`);
  if (fs.existsSync(nf)) A.season.nflByes = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(nf, "utf8")).byes).filter(([id]) => PRO[id]).map(([id, w]) => [PRO[id], w]));
  seasons.push(A.season);
  for (const k in A.managers) if (!managers[k]) managers[k] = A.managers[k];
  console.log(`${y}: loaded from archive`);
}
seasons.sort((a, b) => a.year - b.year);

// Hand corrections where ESPN's records are wrong (see data/overrides.json)
if (exists("overrides.json")) {
  const O = load("overrides.json");
  for (const [from, to] of Object.entries(O.managers || {})) {
    if (!managers[from]) continue;
    delete managers[from];
    managers[to.key] = to;
    for (const s of seasons) for (const t of s.teams) if (t.mgr === from) t.mgr = to.key;
  }
  for (const [year, teams] of Object.entries(O.teams || {})) {
    const s = seasons.find((x) => x.year === +year);
    if (!s) continue;
    for (const [id, o] of Object.entries(teams)) {
      const t = s.teams.find((x) => x.id === +id);
      if (!t) continue;
      if (o.mgr) t.mgr = o.mgr;
      // A team that changed hands mid-season: who ran it (and its name) from which week
      if (o.eras) t.eras = o.eras;
      if (o.note) (s.notes = s.notes || []).push(o.note);
    }
  }
  for (const [k, m] of Object.entries(O.extraManagers || {})) managers[k] = m;
  const used = new Set(seasons.flatMap((s) => s.teams.flatMap((t) => [t.mgr, ...(t.eras || []).map((e) => e.mgr)])));
  for (const k of Object.keys(managers)) if (!used.has(k)) delete managers[k];
}

// Title / playoff / last-place odds after every week (see odds.js)
const { seasonOdds } = require("./odds");
for (const s of seasons) {
  // seasonOdds needs the finished-game list and week mapping the page also uses
  s.played = s.matchups.filter((m) => m.win !== null && !m.live);
  s.sp2mp = {};
  for (const mp in s.periods || {}) for (const sp of s.periods[mp]) s.sp2mp[sp] = +mp;
  s.odds = seasonOdds(s);
  delete s.played; delete s.sp2mp;
  // Odds as they stood when each week ended, frozen (history/odds_<year>.json, saved by GitHub).
  // The newest week's odds keep changing with lineups and trades; this keeps a "before" to compare with.
  if (!s.done && s.odds) {
    const f = path.join(HISTORY, `odds_${s.year}.json`), snap = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    let changed = false;
    // Only the newest week, and only before any trade for the next week, so a "before" never includes the trade
    const newest = s.odds.weeks[s.odds.weeks.length - 1];
    s.odds.weeks.forEach((N, i) => { if (N > 0 && N === newest && !snap[N] && !s.trades.some((t) => t.wk === N + 1)) { snap[N] = Object.fromEntries(s.teams.map((t) => [t.id, { c: s.odds.t[t.id].c[i], p: s.odds.t[t.id].p[i] }])); changed = true; } });
    if (changed && process.env.GITHUB_ACTIONS === "true") { fs.mkdirSync(HISTORY, { recursive: true }); fs.writeFileSync(f, JSON.stringify(snap)); }
    s.oddsAtWeekEnd = snap;
  }
}

// Each NFL team's opponent by week (by abbreviation), from saved schedules or this season's download
const oppFor = (y) => {
  const opp = {}, add = (wk, h, a) => { (opp[wk] = opp[wk] || {})[PRO[h]] = PRO[a]; opp[wk][PRO[a]] = PRO[h]; };
  const arch = path.join(ARCHIVE, `nfl_${y}.json`);
  if (fs.existsSync(arch)) { for (const [wk, gs] of Object.entries(JSON.parse(fs.readFileSync(arch, "utf8")).games)) for (const [h, a] of gs) add(wk, h, a); return opp; }
  if (exists(`proteams_${y}.json`)) for (const t of ((load(`proteams_${y}.json`).settings || {}).proTeams || [])) for (const [wk, gs] of Object.entries(t.proGamesByScoringPeriod || {})) for (const g of gs) add(wk, g.homeProTeamId, g.awayProTeamId);
  return opp;
};

// Do players in the same NFL game move together? Actual/projected for every rostered player, paired
// with the players on the team they faced. Reported on each run to decide whether players.js should link them.
{
  const pairs = {}, years = [];
  for (const s of seasons) {
    const opp = oppFor(s.year);
    if (!Object.keys(opp).length) continue;
    years.push(s.year);
    for (const w in s.lineups) {
      if (!s.done && +w >= s.curWeek) continue;
      const ps = Object.values(s.lineups[w]).flat().filter((p) => p.proj >= 3 && !p.st), byPro = {};
      for (const p of ps) (byPro[p.pro] = byPro[p.pro] || []).push(p);
      for (const a of ps) for (const b of byPro[(opp[w] || {})[a.pro]] || []) { const k = `${a.pos} vs opposing ${b.pos}`; (pairs[k] = pairs[k] || []).push([a.pts / a.proj, b.pts / b.proj]); }
    }
  }
  const corr = (P) => { const n = P.length, mx = P.reduce((s, p) => s + p[0], 0) / n, my = P.reduce((s, p) => s + p[1], 0) / n; let c = 0, vx = 0, vy = 0; for (const [x, y] of P) { c += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; } return c / Math.sqrt(vx * vy); };
  console.log(`::notice::Same-game correlation (${years.join(", ") || "no schedules yet"}): ${Object.entries(pairs).filter(([, P]) => P.length >= 30).sort().map(([k, P]) => `${k} ${corr(P).toFixed(2)} (${P.length})`).join("; ") || "not enough pairs yet"}`);
}

// This week's games, simulated player by player (see players.js): win chance and the Ones to Watch
const { fit, simGame } = require("./players");
const playerModel = fit(seasons.map((s) => ({ ...s, lineups: Object.fromEntries(Object.entries(s.lineups).filter(([w]) => s.done || +w < s.curWeek)) })));
for (const s of seasons) for (const m of s.matchups) {
  if (!m._sides) continue;
  const g = simGame(playerModel, m._sides[0], m._sides[1], s.year * 1000 + m.wk * 10 + m.h, oppFor(s.year)[m.wk] || {});
  m.psim = Math.round(g.home * 1000) / 1000;
  // The biggest swing on each side
  const top = [0, 1].map((k) => g.watch.find((x) => x.side === k)).filter(Boolean);
  const pick = top.sort((a, b) => (b.boom - b.bust) - (a.boom - a.bust));
  m.watch = pick.map(({ side, n, pos, pro, proj, boom, bust, boomAt, bustAt }) => ({ id: side ? m.a : m.h, n, pos, pro: pro.startsWith("FA-") ? "FA" : pro, proj, boom, bust, boomAt, bustAt }));
  // QB + own receiver both still to play on one side: they boom and bust together
  m.stacks = [0, 1].flatMap((k) => { const L = m._sides[k].filter((p) => p.left > 0); return L.filter((p) => p.pos === "QB").flatMap((q) => L.filter((r) => (r.pos === "WR" || r.pos === "TE") && r.pro === q.pro).map((r) => ({ id: k ? m.a : m.h, qb: q.n, rec: r.n }))); });
  delete m._sides;
  const nm = (id) => s.teams.find((t) => t.id === id).name;
  console.log(`::notice::Week ${m.wk}: ${nm(m.h)} ${Math.round(m.psim * 100)}% vs ${nm(m.a)} | watch ${m.watch.map((x) => `${x.n} for ${nm(x.id)} (${x.boomAt}+: ${x.boom}%, under ${x.bustAt}: ${x.bust}%)`).join("; ")}${m.stacks.length ? ` | stacks ${m.stacks.map((k) => `${k.qb}+${k.rec}`).join(", ")}` : ""}`);
}
// In-game win chance history: GitHub saves one point per update while a week is under way
// (history/live_<year>.json, kept in the repo). Local builds only read it.
if (process.env.GITHUB_ACTIONS === "true") for (const { matchups, wp, histFile } of pendingHistory) {
  let changed = false;
  const now = Date.now();
  for (const m of matchups) {
    const key = `${m.wk}-${m.h}-${m.a}`, pts = wp[key];
    if (m.live && m.psim != null && (m.on || m.hp || m.ap)) {
      const p = m.psim;
      (wp[key] = wp[key] || []).push([now, Math.round(p * 1000) / 1000, m.hp, m.ap]);
      changed = true;
    } else if (pts && m.win !== null && !m.live) {
      const fin = m.win === m.h ? 1 : m.win === m.a ? 0 : 0.5;
      if (pts[pts.length - 1][1] !== fin || pts[pts.length - 1][2] !== m.hp) { pts.push([now, fin, m.hp, m.ap]); changed = true; }
    }
  }
  if (changed) { fs.mkdirSync(HISTORY, { recursive: true }); fs.writeFileSync(histFile, JSON.stringify(wp)); }
}

// House style for the AI writer's text: Zoe's nickname is written Z², however it comes out
const polish = (text) => text.replace(/\bZ[ -]?squared\b|\bZ\^2/gi, "Z²");
// AI-written news saved by news.js (news/*.json), newest first, plus each team's latest bio
const NEWSDIR = path.join(__dirname, "news");
const articles = fs.existsSync(NEWSDIR) ? fs.readdirSync(NEWSDIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(polish(fs.readFileSync(path.join(NEWSDIR, f), "utf8")))) : [];
articles.sort((a, b) => b.year - a.year || (b.wk ?? 99) - (a.wk ?? 99) || b.created.localeCompare(a.created));
const bios = {};
for (const a of [...articles].reverse()) if (a.bios) for (const id in a.bios) (bios[a.year] = bios[a.year] || {})[id] = { wk: a.wk, bio: a.bios[id] };
const news = { articles: articles.map(({ usage, model, bios: _b, ...a }) => a), bios };

// Where everyone was each season (hand-maintained, data/locations.json)
const locations = exists("locations.json") ? load("locations.json") : null;
// Stable manager order (first season they appear, then team ID) so badge colors never shuffle
const order = [];
for (const s of seasons) for (const t of [...s.teams].sort((a, b) => a.id - b.id)) for (const k of [t.mgr, ...(t.eras || []).map((e) => e.mgr)]) if (!order.includes(k)) order.push(k);
const orderedManagers = Object.fromEntries(order.filter((k) => managers[k]).map((k) => [k, managers[k]]));
const dataJs = "window.LEAGUE = " + JSON.stringify({ league: "Buckaroo Football League", firstYear: 2023, built: new Date().toISOString(), managers: orderedManagers, seasons, locations, news }) + ";\n";
fs.mkdirSync(path.join(__dirname, "site"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "site", "data.js"), dataJs);
// public/ is the standalone website: site/index.html is a page body, so give it a full document shell
const PUB = path.join(__dirname, "public");
fs.mkdirSync(PUB, { recursive: true });
// data.js gets a version stamp so a fresh page never pairs with a cached copy of old data
const page = fs.readFileSync(path.join(__dirname, "site", "index.html"), "utf8").replace('<script src="data.js">', `<script src="data.js?v=${Date.now()}">`);
fs.writeFileSync(path.join(PUB, "index.html"), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="robots" content="noindex">\n<meta http-equiv="Cache-Control" content="no-cache">\n<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n${page}\n</body>\n</html>\n`);
fs.writeFileSync(path.join(PUB, "data.js"), dataJs);
fs.writeFileSync(path.join(PUB, ".nojekyll"), "");
console.log("wrote public/ and site/data.js", (Buffer.byteLength(dataJs) / 1024).toFixed(0) + " KB");
