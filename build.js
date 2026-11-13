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
          return { n: p.fullName, pos: POS[p.defaultPositionId] || "", pro: PRO[p.proTeamId] || "", slot: SLOT[e.lineupSlotId] || "BN", pts: r2(e.playerPoolEntry.appliedStatTotal || 0), proj: pj ? r2(pj.appliedTotal) : null, st, _pt: p.proTeamId, _x: act && act.stats, _inj: p.injuryStatus };
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
  let nflClock = null, gamesOn = false, kicks;
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
      kicks = [...new Set((sb.events || []).map((ev) => ev.date && new Date(ev.date).toISOString()).filter(Boolean))].sort(); // this NFL week's kickoff times, for when.js and news.js
    }
  }
  // Share of a player's game still to play for him: none once he's ruled out mid-game (hurt and not coming back),
  // so Luffy stops counting on points he won't score
  const leftFor = (p, w) => { const f = nflClock ? nflClock(p.proTeamId) : nflBye[p.proTeamId] === w ? 0 : 1; return f > 0 && f < 1 && ["OUT", "INJURY_RESERVE"].includes(p.injuryStatus) ? 0 : f; };
  // A player with no stats only counts as out once his NFL game is over (earlier weeks always are)
  for (const w in lineups) for (const id in lineups[w]) for (const p of lineups[w][id]) {
    if (p.st === "dnp") p.st = +w < L.status.latestScoringPeriod || (nflClock && nflClock(p._pt) === 0) ? "out" : undefined;
    if (!p.st) delete p.st;
    // This week's scoring plays (ESPN stat ids) and whether his game is still to come, under way or over,
    // so live posts and the win chance chart can tell a touchdown from yardage and a finished game from one to come
    if (!done && +w === L.status.latestScoringPeriod) {
      const x = p._x || {}, n = (...ids) => ids.reduce((t, k) => t + (x[k] || 0), 0);
      const plays = { ptd: n(4), rtd: n(25), ctd: n(43), dtd: n(93, 101, 102, 103, 104), fg: n(83), to: n(20, 72) };
      for (const k in plays) if (plays[k]) (p.x = p.x || {})[k] = plays[k];
      if (nflClock && p.st !== "bye") { const f = nflClock(p._pt); p.g = f === 1 ? "pre" : f === 0 ? "done" : "on"; }
      // ESPN's injury designation (questionable, out...), which it also changes when a player gets hurt during a game
      if (p._inj && !["ACTIVE", "NORMAL"].includes(p._inj)) p.inj = p._inj;
    }
    delete p._pt; delete p._x; delete p._inj;
  }
  // So the stat ids can be checked against the box scores from a cloud session
  if (!done && nflClock && lineups[L.status.latestScoringPeriod]) console.log(`::notice::${year} scoring plays so far: ${Object.values(lineups[L.status.latestScoringPeriod]).flat().filter((p) => p.x).map((p) => `${p.n} ${JSON.stringify(p.x)} (${p.pts})`).join("; ") || "none"}`);
  // Live scores for the week in progress
  if (exists(`wk_${year}_${L.status.currentMatchupPeriod}.json`)) {
    const W = load(`wk_${year}_${L.status.currentMatchupPeriod}.json`);
    for (const m of matchups) {
      if (m.win !== null || m.wk !== L.status.currentMatchupPeriod) continue;
      const s = W.schedule.find((x) => x.matchupPeriodId === m.wk && x.home.teamId === m.h);
      if (!s) continue;
      // ESPN only marks winners and updates records hours after Monday night's game. Once every starter's NFL game
      // in the matchup's last week is final, settle it ourselves (ESPN's result replaces it on the next run if a stat correction flips it)
      const sps = ss.matchupPeriods[m.wk] || [m.wk], starters = [s.home, s.away].flatMap((side) => (side.rosterForCurrentScoringPeriod || { entries: [] }).entries.filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21));
      if (nflClock && !gamesOn && L.status.latestScoringPeriod === Math.max(...sps) && starters.length && starters.every((e) => nflClock(e.playerPoolEntry.player.proTeamId) === 0)) {
        m.hp = r2(s.home.totalPointsLive ?? s.home.totalPoints); m.ap = r2(s.away.totalPointsLive ?? s.away.totalPoints);
        m.win = m.hp > m.ap ? m.h : m.ap > m.hp ? m.a : 0; m.early = true;
        if (m.wk <= ss.matchupPeriodCount) for (const [id, p, op] of [[m.h, m.hp, m.ap], [m.a, m.ap, m.hp]]) {
          const t = teams.find((x) => x.id === id), r = m.win === id ? "W" : m.win === 0 ? "T" : "L";
          t[r === "W" ? "w" : r === "L" ? "l" : "t"]++; t.pf = r2(t.pf + p); t.pa = r2(t.pa + op);
          t.streak = t.streak[0] === r ? `${r}${+t.streak.slice(1) + 1}` : `${r}1`;
        }
        console.log(`::notice::${year} week ${m.wk} settled before ESPN: ${teams.find((x) => x.id === m.h).name} ${m.hp}, ${teams.find((x) => x.id === m.a).name} ${m.ap}`);
        continue;
      }
      m.live = true;
      m.on = gamesOn; // an NFL game is being played right now
      if (s.home.winProbability != null) m.espn = Math.round(s.home.winProbability * 1000) / 1000; // ESPN's own win chance for the home team
      m.hp = r2(s.home.totalPointsLive || 0);
      m.ap = r2(s.away.totalPointsLive || 0);
      // Live projected finals: points so far plus what each starter is still expected to score.
      // (ESPN's totalProjectedPoints is only the pre-game total, so it can't be used here.)
      // Starters for the player-level sim (players.js), run once every season is loaded.
      // left: share of his NFL game still to play. Without a scoreboard, only a game that hasn't started can be simulated.
      if (nflClock || (m.hp === 0 && m.ap === 0)) m._sides = [s.home, s.away].map((side) => (side.rosterForCurrentScoringPeriod || { entries: [] }).entries
        .filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21).map((e) => {
          const p = e.playerPoolEntry.player, pj = (p.stats || []).find((x) => x.statSourceId === 1 && x.scoringPeriodId === m.wk);
          const left = leftFor(p, m.wk);
          return { n: p.fullName, pos: POS[p.defaultPositionId] || "", pro: PRO[p.proTeamId] || `FA-${p.id}`, proj: pj ? pj.appliedTotal : 0, pts: e.playerPoolEntry.appliedStatTotal || 0, left };
        }));
      // Starters on bye or ruled out whose spot can still be filled, and the lineup with each swapped for the best
      // bench player at his position whose game hasn't started, so stories can tell "as set" from "if he fixes it"
      if (m._sides && m.win === null) {
        const OUT = ["OUT", "INJURY_RESERVE", "SUSPENSION"];
        m.holes = []; m._fixed = [s.home, s.away].map((side, k) => {
          const es = (side.rosterForCurrentScoringPeriod || { entries: [] }).entries, used = new Set();
          const row = (e) => { const p = e.playerPoolEntry.player, pj = (p.stats || []).find((x) => x.statSourceId === 1 && x.scoringPeriodId === m.wk);
            const bye = nflBye[p.proTeamId] === m.wk, left = leftFor(p, m.wk);
            return { n: p.fullName, pos: POS[p.defaultPositionId] || "", pro: PRO[p.proTeamId] || `FA-${p.id}`, proj: pj ? pj.appliedTotal : 0, pts: e.playerPoolEntry.appliedStatTotal || 0, left,
              why: bye ? "on bye" : left === 1 && OUT.includes(p.injuryStatus) ? "ruled out" : null }; };
          const bench = es.filter((e) => e.lineupSlotId === 20).map(row).filter((p) => !p.why && p.left === 1);
          return es.filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21).map(row).map((p) => {
            if (!p.why) return p;
            m.holes.push({ id: k ? m.a : m.h, n: p.n, pos: p.pos, why: p.why });
            const sub = bench.filter((b) => b.pos === p.pos && !used.has(b)).sort((a, b) => b.proj - a.proj)[0];
            if (sub) used.add(sub);
            return sub || { ...p, proj: 0 };
          });
        });
        if (!m.holes.length) { delete m.holes; delete m._fixed; }
      }
      if (nflClock) {
        for (const [side, key] of [[s.home, "h"], [s.away, "a"]]) {
          // Each player's remaining points can miss by about 60% either way (booms and busts)
          let rem = 0, left = 0, play = 0, vr = 0;
          for (const e of (side.rosterForCurrentScoringPeriod || { entries: [] }).entries) {
            if (e.lineupSlotId === 20 || e.lineupSlotId === 21) continue; // bench / IR
            const p = e.playerPoolEntry.player;
            const pj = (p.stats || []).find((x) => x.statSourceId === 1 && x.scoringPeriodId === m.wk);
            const f = leftFor(p, m.wk), r = (pj ? pj.appliedTotal : 0) * f;
            if (f > 0) left++;
            if (f > 0 && f < 1) play++; // his game is on right now
            rem += r;
            vr += (0.6 * r) ** 2;
          }
          m[key + "proj"] = r2(m[key + "p"] + rem);
          m[key + "left"] = left;
          m[key + "play"] = play;
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
    // Weekly points (actual, every week, on a roster or not) for traded players, from fetch.js
    tradedPts: (() => { if (!exists(`traded_${year}.json`)) return undefined; const out = {};
      for (const e of load(`traded_${year}.json`).players || []) { const p = e.player || {}, wk = {};
        for (const st of p.stats || []) if (st.statSourceId === 0 && st.statSplitTypeId === 1 && st.scoringPeriodId > 0) wk[st.scoringPeriodId] = r2(st.appliedTotal || 0);
        if (p.fullName && Object.keys(wk).length) out[p.fullName] = wk; }
      console.log(`::notice::${year} weekly points for ${Object.keys(out).length} traded players`); return out; })(),
    on: matchups.some((m) => m.on), nflByes: done ? undefined : nflByes, kicks: done ? undefined : kicks, playoffTeams: ss.playoffTeamCount, periods: ss.matchupPeriods, teams, future, matchups, byes, lineups, draft, moves, trades: finalTrades, rosters, wp,
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

// (printed early: GitHub keeps only the first ten notices of a step)
// NFL status for everyone who has been on a league roster, from ESPN's newest player pool (it lists inactive
// players too): "t" on a team (with its abbreviation), "f" free agent, "r" retired (marked inactive); players it can't find get no status.
// Without a pool file (local builds) there's no status, and player pages fall back to the last team seen.
const nflStatus = (() => { try {
  const y = years[years.length - 1], f = y && path.join(DATA, `players_${y}.json`);
  if (!f || !fs.existsSync(f)) return null;
  // Matched without suffixes: older seasons say "James Cook", ESPN now says "James Cook III"
  const base = (n) => String(n || "").toLowerCase().replace(/[.']/g, "").replace(/\s+(jr|sr|ii|iii|iv|v)$/, "");
  const pool = new Map(JSON.parse(fs.readFileSync(f, "utf8")).map((p) => [base(p.fullName), p]));
  const names = new Set(seasons.flatMap((s) => [...Object.values(s.lineups).flatMap((L) => Object.values(L).flat().map((e) => e.n)), ...s.draft.map((d) => d.n)]));
  const out = {};
  for (const n of names) {
    if (/D\/ST$/.test(n)) continue;
    const p = pool.get(base(n));
    if (!p) continue; // not found is usually a name change ("Hollywood" Brown), not a retirement
    out[n] = p.active === false ? "r" : p.proTeamId ? `t:${PRO[p.proTeamId] || "?"}` : "f";
  }
  const c = { t: 0, f: 0, r: 0 }; for (const v of Object.values(out)) c[v[0]]++;
  console.log(`::notice::NFL status from players_${y}.json (${pool.size} in pool): ${c.t} on a team, ${c.f} free agents, ${c.r} retired; not found: ${[...names].filter((n) => !/D\/ST$/.test(n) && !pool.has(base(n))).slice(0, 8).join(", ") || "none"}; e.g. retired: ${Object.keys(out).filter((n) => out[n] === "r").slice(0, 12).join(", ") || "none"}`);
  return out;
  } catch (e) { console.log(`::warning::NFL status skipped: ${e.message}`); return null; } // never worth failing the build over
})();

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
  const P = s.odds && s.odds.picture;
  if (P) console.log(`::notice::${s.year} playoff picture after week ${P.week}: ${s.teams.map((t) => `${t.name} ${Math.round(P.teams[t.id].ifWin.p)}% win / ${Math.round(P.teams[t.id].ifLose.p)}% loss${P.status && P.status[t.id] ? ` (${P.status[t.id]})` : ""}${P.seed && P.seed[t.id] ? ` (${P.seed[t.id]})` : ""}${P.scenarios && P.scenarios[t.id] && P.scenarios[t.id].length ? ` [${P.scenarios[t.id].length} scenario(s)]` : ""}`).join("; ")}`);
  if (P && P.rootFor) console.log(`::notice::${s.year} root for in week ${P.week + 1}: ${s.teams.map((t) => `${t.name} (opponents ${Math.round(P.sos[t.id].avg)}): ${P.rootFor[t.id].slice(0, 2).map((r) => `${s.teams.find((x) => x.id === r.winner).name} over ${s.teams.find((x) => x.id === r.loser).name} +${r.gain}`).join(", ") || "none"}`).join("; ")}`);
  // Odds as they stood when each week ended, frozen (history/odds_<year>.json, saved by GitHub).
  // The newest week's odds keep changing with lineups and trades; this keeps a "before" to compare with.
  if (!s.done && s.odds) {
    const f = path.join(HISTORY, `odds_${s.year}.json`), snap = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    let changed = false;
    // Only the newest week, and only before any trade for the next week, so a "before" never includes the trade
    const newest = s.odds.weeks[s.odds.weeks.length - 1];
    // and only once ESPN has made the week official: a week the site settled early is still missing next week's lineups,
    // which left the week 9 snapshot of 2026 far off
    const official = !s.matchups.some((m) => m.wk === newest && m.early);
    s.odds.weeks.forEach((N, i) => { if (N > 0 && N === newest && official && !snap[N] && !s.trades.some((t) => t.wk === N + 1)) { snap[N] = Object.fromEntries(s.teams.map((t) => [t.id, { c: s.odds.t[t.id].c[i], p: s.odds.t[t.id].p[i] }])); changed = true; } });
    if (changed && process.env.GITHUB_ACTIONS === "true") { fs.mkdirSync(HISTORY, { recursive: true }); fs.writeFileSync(f, JSON.stringify(snap)); }
    s.oddsAtWeekEnd = snap;
  }
  // Odds day by day (history/odds_daily_<year>.json, saved by GitHub): each day's latest title, playoff and last-place odds
  // (Eastern time), and the day each trade first showed up, so the Odds page shows a trade's effect when it happens.
  // A new file starts from each finished week's odds on the Tuesday that week ended.
  if (!s.done && s.odds) {
    const f = path.join(HISTORY, `odds_daily_${s.year}.json`), now = new Date(), i = s.odds.weeks.length - 1;
    const etDay = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const vals = (k) => Object.fromEntries(s.teams.map((t) => [t.id, ["c", "p", "l"].map((m) => Math.round(s.odds.t[t.id][m][k] * 10) / 10)]));
    const tradeKey = (tr) => `${tr.wk}-${[...tr.teams].sort((a, b) => a - b).join("-")}`;
    let daily = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    if (!daily) {
      // Week N ends the Tuesday after its Monday night game: Labor Day plus 8 days for week 1, a week later for each after
      const labor = new Date(Date.UTC(s.year, 8, 1)); while (labor.getUTCDay() !== 1) labor.setUTCDate(labor.getUTCDate() + 1);
      const weekEnd = (N) => { const d = new Date(labor); d.setUTCDate(d.getUTCDate() + (N === 0 ? 1 : 8 + 7 * (N - 1))); return d.toISOString().slice(0, 10); };
      daily = { days: {}, trades: {} };
      s.odds.weeks.forEach((N, k) => { if (k < i) daily.days[weekEnd(N)] = { wk: N, weekly: true, teams: vals(k) }; });
      // Earlier trades are placed the day after the week before them ended; this week's go on today
      for (const tr of s.trades) daily.trades[tradeKey(tr)] = tr.wk - 1 < s.odds.weeks[i] ? new Date(Date.parse(weekEnd(tr.wk - 1)) + 864e5).toISOString().slice(0, 10) : etDay(now);
    }
    const before = JSON.stringify(daily);
    daily.days[etDay(now)] = { wk: s.odds.weeks[i], t: now.toISOString(), teams: vals(i) };
    for (const tr of s.trades) if (!daily.trades[tradeKey(tr)]) daily.trades[tradeKey(tr)] = etDay(now);
    if (JSON.stringify(daily) !== before && process.env.GITHUB_ACTIONS === "true") { fs.mkdirSync(HISTORY, { recursive: true }); fs.writeFileSync(f, JSON.stringify(daily)); }
    s.oddsDaily = daily;
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

// The team-level pregame win chance (odds.js strengths), the same one the site shows for past games
function winOdds(s, m) {
  if (!s.odds) return null;
  let i = -1; s.odds.weeks.forEach((N, j) => { if (N <= m.wk - 1) i = j; });
  if (i < 0 || s.odds.weeks[i] !== m.wk - 1) return null;
  return Math.round(Phi((s.odds.t[m.h].str[i] - s.odds.t[m.a].str[i]) / ((s.odds.sd || 20) * Math.SQRT2)) * 1000) / 1000;
}
// This week's games, simulated player by player (see players.js): win chance and the Ones to Watch
const { fit, simGame } = require("./players");
const playerModel = fit(seasons.map((s) => ({ ...s, lineups: Object.fromEntries(Object.entries(s.lineups).filter(([w]) => s.done || +w < s.curWeek)) })));
for (const s of seasons) for (const m of s.matchups) {
  if (!m._sides) continue;
  const g = simGame(playerModel, m._sides[0], m._sides[1], s.year * 1000 + m.wk * 10 + m.h, oppFor(s.year)[m.wk] || {});
  m.psim = Math.round(g.home * 1000) / 1000;
  // Over once every starter on both sides is done: exactly 100% or 0%, not a simulated 99.9%
  // (not sooner: the team ahead can still lose points, to interceptions or a defense's bad day)
  if (m.hleft === 0 && m.aleft === 0) m.psim = m.hp > m.ap ? 1 : m.hp < m.ap ? 0 : 0.5;
  // The biggest swing on each side, and QB + own receiver both still to play on one side (they boom and bust together)
  const watchOf = (g) => [0, 1].map((k) => g.watch.find((x) => x.side === k)).filter(Boolean).sort((a, b) => (b.boom - b.bust) - (a.boom - a.bust))
    .map(({ side, n, pos, pro, proj, boom, bust, boomAt, bustAt }) => ({ id: side ? m.a : m.h, n, pos, pro: pro.startsWith("FA-") ? "FA" : pro, proj, boom, bust, boomAt, bustAt }));
  const stacksOf = (sides) => [0, 1].flatMap((k) => { const L = sides[k].filter((p) => p.left > 0); return L.filter((p) => p.pos === "QB").flatMap((q) => L.filter((r) => (r.pos === "WR" || r.pos === "TE") && r.pro === q.pro).map((r) => ({ id: k ? m.a : m.h, qb: q.n, rec: r.n }))); });
  m.watch = watchOf(g); m.stacks = stacksOf(m._sides);
  // With holes filled too, so the preview's Ones to Watch match its win chances
  if (m._fixed) {
    const f = simGame(playerModel, m._fixed[0], m._fixed[1], s.year * 1000 + m.wk * 10 + m.h, oppFor(s.year)[m.wk] || {});
    m.psimFixed = Math.round(f.home * 1000) / 1000; m.watchFixed = watchOf(f); m.stacksFixed = stacksOf(m._fixed);
    delete m._fixed;
  }
  delete m._sides;
  const nm = (id) => s.teams.find((t) => t.id === id).name;
  console.log(`::notice::Week ${m.wk}: ${nm(m.h)} ${Math.round(m.psim * 100)}%${m.espn != null ? ` (ESPN ${Math.round(m.espn * 100)}%)` : ""} vs ${nm(m.a)} | watch ${m.watch.map((x) => `${x.n} for ${nm(x.id)} (${x.boomAt}+: ${x.boom}%, under ${x.bustAt}: ${x.bust}%)`).join("; ")}${m.stacks.length ? ` | stacks ${m.stacks.map((k) => `${k.qb}+${k.rec}`).join(", ")}` : ""}${m.holes ? ` | holes ${m.holes.map((x) => `${x.n} (${nm(x.id)}, ${x.why})`).join(", ")} -> ${nm(m.h)} ${Math.round(m.psimFixed * 100)}% if fixed` : ""}`);
}
// Pregame win chances and Ones to Watch, frozen at kickoff for the Report Card (history/pregame_<year>.json,
// saved by GitHub): each game's last ones before any points were scored, as the lineups were set then
for (const s of seasons) {
  if (s.done) continue;
  const f = path.join(HISTORY, `pregame_${s.year}.json`), pre = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  let changed = false;
  for (const m of s.matchups) if (m.live && m.psim != null && !m.hp && !m.ap && process.env.GITHUB_ACTIONS === "true") {
    const k = `${m.wk}-${m.h}-${m.a}`, watch = JSON.stringify(m.watch || []), stacks = JSON.stringify(m.stacks || []);
    if (!pre[k] || pre[k].p !== m.psim || pre[k].fixed !== m.psimFixed || pre[k].espn !== m.espn || JSON.stringify(pre[k].watch || []) !== watch || JSON.stringify(pre[k].stacks || []) !== stacks) {
      pre[k] = { p: m.psim, fixed: m.psimFixed, odds: winOdds(s, m), espn: m.espn, watch: m.watch, stacks: m.stacks, at: new Date().toISOString() }; changed = true; }
  }
  if (changed) { fs.mkdirSync(HISTORY, { recursive: true }); fs.writeFileSync(f, JSON.stringify(pre)); }
  // Once a game is under way its Ones to Watch stay the ones picked at kickoff, with their pregame lines:
  // recomputed live they drift to whoever is left to play, which makes no sense mid-game
  for (const m of s.matchups) {
    const k = `${m.wk}-${m.h}-${m.a}`;
    if (!m.live || !(m.hp || m.ap) || !pre[k] || !pre[k].watch) continue;
    const L = Object.assign({}, ...((s.periods || {})[m.wk] || [m.wk]).map((sp) => s.lineups[sp] || {}));
    m.watch = pre[k].watch.map((x) => ({ ...x, proj: x.proj ?? ((L[x.id] || []).find((p) => p.n === x.n) || {}).proj ?? null }));
    m.stacks = pre[k].stacks || []; m.watchLocked = true;
  }
}

// The site's look back at past Ones to Watch: the picks frozen at kickoff, for every season that has them
for (const s of seasons) {
  const f = path.join(HISTORY, `pregame_${s.year}.json`);
  if (!fs.existsSync(f)) continue;
  s.pregame = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(f, "utf8"))).filter(([, v]) => v.watch && v.watch.length).map(([k, v]) => [k, { p: v.p, watch: v.watch, stacks: v.stacks || [] }]));
}

// In-game win chance history: GitHub saves one point per update while a week is under way
// (history/live_<year>.json, kept in the repo). Local builds only read it.
if (process.env.GITHUB_ACTIONS === "true") for (const { matchups, wp, histFile } of pendingHistory) {
  let changed = false;
  const now = Date.now();
  for (const m of matchups) {
    const key = `${m.wk}-${m.h}-${m.a}`, pts = wp[key];
    if (m.live && m.psim != null && (m.on || m.hp || m.ap)) {
      const p = Math.round(m.psim * 1000) / 1000, last = pts && pts[pts.length - 1];
      // The second build of a run sees the same data: one point per update
      if (last && now - last[0] < 10 * 60e3 && last[1] === p && last[2] === m.hp && last[3] === m.ap) continue;
      // [time, Luffy, home points, away points, plays (filled in by live.js), ESPN's own live chance]
      (wp[key] = wp[key] || []).push([now, p, m.hp, m.ap, null, m.espn ?? null]);
      changed = true;
    } else if (pts && m.win !== null && !m.live) {
      const fin = m.win === m.h ? 1 : m.win === m.a ? 0 : 0.5;
      if (pts[pts.length - 1][1] !== fin || pts[pts.length - 1][2] !== m.hp) { pts.push([now, fin, m.hp, m.ap, null, fin]); changed = true; }
    }
  }
  if (changed) { fs.mkdirSync(HISTORY, { recursive: true }); fs.writeFileSync(histFile, JSON.stringify(wp)); }
}

// House style for the AI writer's text: Zoe's nickname is written Z², however it comes out, and the
// win-chance model is always Luffy (older stories called it "the model")
const polish = (text) => text.replace(/\bZ[ -]?squared\b|\bZ\^2/gi, "Z²").replace(/\bin the model\b(?!s)/g, "in Luffy's eyes").replace(/\b[Tt]he [Mm]odel\b(?!s)/g, "Luffy");
// AI-written news saved by news.js (news/*.json), newest first, plus each team's latest bio
const NEWSDIR = path.join(__dirname, "news");
const articles = fs.existsSync(NEWSDIR) ? fs.readdirSync(NEWSDIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(polish(fs.readFileSync(path.join(NEWSDIR, f), "utf8")))) : [];
articles.sort((a, b) => b.year - a.year || (b.wk ?? 99) - (a.wk ?? 99) || b.created.localeCompare(a.created));
const bios = {};
for (const a of [...articles].reverse()) if (a.bios) for (const id in a.bios) (bios[a.year] = bios[a.year] || {})[id] = { wk: a.wk, bio: a.bios[id] };
// Each story's in-world publish time and each post's time (see when.js); the page hides posts whose time hasn't come
const { published, postTime } = require("./when");
const periodsOf = Object.fromEntries(seasons.map((s) => [s.year, s.periods]));
const news = { articles: articles.map(({ usage, model, bios: _b, ...a }) => {
  const pub = published(a, periodsOf[a.year]);
  return pub ? { ...a, published: pub.toISOString(), social: (a.social || []).map((p, i) => ({ ...p, at: postTime(a, pub, p, i, periodsOf[a.year]).toISOString() })) } : a;
}), bios };

// Where everyone was each season (hand-maintained, data/locations.json)
const locations = exists("locations.json") ? load("locations.json") : null;
// Stable manager order (first season they appear, then team ID) so badge colors never shuffle
const order = [];
for (const s of seasons) for (const t of [...s.teams].sort((a, b) => a.id - b.id)) for (const k of [t.mgr, ...(t.eras || []).map((e) => e.mgr)]) if (!order.includes(k)) order.push(k);
const orderedManagers = Object.fromEntries(order.filter((k) => managers[k]).map((k) => [k, managers[k]]));
const dataJs = "window.LEAGUE = " + JSON.stringify({ league: "Buckaroo Football League", firstYear: 2023, built: new Date().toISOString(), managers: orderedManagers, seasons, locations, news, nflStatus }) + ";\n";
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
