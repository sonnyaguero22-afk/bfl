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
  // Byes in playoffs (no away team)
  const byes = L.schedule.filter((s) => !s.away).map((s) => ({ wk: s.matchupPeriodId, h: s.home.teamId, tier: s.playoffTierType }));

  // Weekly lineups
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
          return { n: p.fullName, pos: POS[p.defaultPositionId] || "", pro: PRO[p.proTeamId] || "", slot: SLOT[e.lineupSlotId] || "BN", pts: r2(e.playerPoolEntry.appliedStatTotal || 0), proj: pj ? r2(pj.appliedTotal) : null };
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

  // Live scores for the week in progress
  if (exists(`wk_${year}_${L.status.currentMatchupPeriod}.json`)) {
    const W = load(`wk_${year}_${L.status.currentMatchupPeriod}.json`);
    for (const m of matchups) {
      if (m.win !== null || m.wk !== L.status.currentMatchupPeriod) continue;
      const s = W.schedule.find((x) => x.matchupPeriodId === m.wk && x.home.teamId === m.h);
      if (!s) continue;
      m.live = true;
      m.hp = r2(s.home.totalPointsLive || 0);
      m.ap = r2(s.away.totalPointsLive || 0);
    }
  }

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
    playoffTeams: ss.playoffTeamCount, periods: ss.matchupPeriods, teams, matchups, byes, lineups, draft, moves, trades: finalTrades, rosters,
  });
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
      if (o.note) (s.notes = s.notes || []).push(o.note);
    }
  }
  const used = new Set(seasons.flatMap((s) => s.teams.map((t) => t.mgr)));
  for (const k of Object.keys(managers)) if (!used.has(k)) delete managers[k];
}

// Stable manager order (first season they appear, then team ID) so badge colors never shuffle
const order = [];
for (const s of seasons) for (const t of [...s.teams].sort((a, b) => a.id - b.id)) if (!order.includes(t.mgr)) order.push(t.mgr);
const orderedManagers = Object.fromEntries(order.filter((k) => managers[k]).map((k) => [k, managers[k]]));
const dataJs = "window.LEAGUE = " + JSON.stringify({ league: "Buckaroo Football League", firstYear: 2023, built: new Date().toISOString(), managers: orderedManagers, seasons }) + ";\n";
fs.mkdirSync(path.join(__dirname, "site"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "site", "data.js"), dataJs);
// public/ is the standalone website: site/index.html is a page body, so give it a full document shell
const PUB = path.join(__dirname, "public");
fs.mkdirSync(PUB, { recursive: true });
const page = fs.readFileSync(path.join(__dirname, "site", "index.html"), "utf8");
fs.writeFileSync(path.join(PUB, "index.html"), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="robots" content="noindex">\n<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n${page}\n</body>\n</html>\n`);
fs.writeFileSync(path.join(PUB, "data.js"), dataJs);
fs.writeFileSync(path.join(PUB, ".nojekyll"), "");
console.log("wrote public/ and site/data.js", (Buffer.byteLength(dataJs) / 1024).toFixed(0) + " KB");
