// Writes league news with Claude: draft-day coverage of each season's draft, a recap after every finished week (with fan/pundit social
// posts, fresh team bios and quick takes on how earlier trades are aging), a reaction to every trade, and a look back at each finished season.
// Each article is saved once in news/ and never rewritten.
// Stories that fail are logged as ::warning:: lines so they show on the run's summary page.
// Runs in GitHub Actions after build.js; does nothing without ANTHROPIC_API_KEY.
// Usage: node news.js            (write what's missing)
//        node news.js --dry-run  (print the facts that would be sent; no API calls)
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5-5";
const MAX_PER_RUN = 16; // keeps any one run's cost predictable; the rest are written next run
const NEWS = path.join(__dirname, "news");
const DRY = process.argv.includes("--dry-run");

// ---------- League data (the same data.js the site uses) ----------
global.window = {};
eval(fs.readFileSync(path.join(__dirname, "public", "data.js"), "utf8"));
const D = window.LEAGUE;
const S = Object.fromEntries(D.seasons.map((s) => [s.year, s]));
for (const s of D.seasons) s.byId = Object.fromEntries(s.teams.map((t) => [t.id, t]));
const mgr = (k) => D.managers[k].first;
// Teams can change hands mid-season (Ramon, 2025)
const eraAt = (t, wk) => { let e = (t.eras || [])[0] || null; for (const x of t.eras || []) if (wk >= x.from) e = x; return e; };
const mgrAt = (t, wk) => (eraAt(t, wk) || t).mgr;
const nameAt = (t, wk) => (eraAt(t, wk) || t).name;
const who = (t, wk) => `${nameAt(t, wk)} (${mgr(mgrAt(t, wk))})`;
const r1 = (n) => Math.round(n * 10) / 10;
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const done = (m) => m.win !== null && !m.live;
const STATUS = { bye: "on bye", out: "did not play (injured, inactive or out)" };
const spans = (s, wk) => ((s.periods || {})[wk] || [wk]).map(Number);

// ---------- Facts for each kind of story ----------
function recordsThrough(s, W) {
  const r = Object.fromEntries(s.teams.map((t) => [t.id, { w: 0, l: 0, t: 0, pf: 0, seq: [] }]));
  for (const m of s.matchups.filter((m) => m.wk <= Math.min(W, s.regWeeks) && done(m)).sort((a, b) => a.wk - b.wk)) {
    for (const [id, p] of [[m.h, m.hp], [m.a, m.ap]]) {
      const x = r[id]; x.pf += p;
      const res = m.win === id ? "W" : m.win === 0 ? "T" : "L";
      x[res === "W" ? "w" : res === "L" ? "l" : "t"]++; x.seq.push(res);
    }
  }
  for (const x of Object.values(r)) { let k = x.seq.length - 1, n = 0; while (k >= 0 && x.seq[k] === x.seq[x.seq.length - 1]) { n++; k--; } x.streak = x.seq.length ? x.seq[x.seq.length - 1] + n : ""; }
  return r;
}
function oddsAt(s, N, id, key = "c") { if (!s.odds) return null; const i = s.odds.weeks.indexOf(N); return i < 0 ? null : s.odds.t[id][key][i]; }
function pregameWin(s, m) {
  if (!s.odds) return null;
  let i = -1; s.odds.weeks.forEach((N, j) => { if (N <= m.wk - 1) i = j; });
  if (i < 0) return null;
  const len = spans(s, m.wk).length;
  const near = m.wk === s.odds.weeks[i] + 1 || !s.odds.t[m.h].far, k = near ? "str" : "far", spread = near ? s.odds.sd || 20 : s.odds.farSd || s.odds.sd || 20;
  return Phi(((s.odds.t[m.h][k][i] - s.odds.t[m.a][k][i]) * len) / (spread * Math.sqrt(2 * len)));
}
// The preview panel: fictional pundits (archetypes, never real people). Keep names and handles fixed.
const PANEL = [
  { name: "Dana Whitfield", handle: "@DanaWhitfieldBFL", role: "Insider", style: "measured news-breaker; leans on lineup moves, injuries, byes and what she's hearing; rarely raises her voice" },
  { name: "Marcus Pell", handle: "@MarcusPellWrites", role: "Columnist", style: "narratives, rivalries and history; loves a contrarian pick and a big sentence" },
  { name: "Sal Benedetto", handle: "@SalBetsBig", role: "The Gambler", style: "loud, emotional, all-in; every pick is a LOCK, holds grudges against teams that burned him, never admits a bad call" },
  { name: "Dr. Nina Kessler", handle: "@KesslerNumbers", role: "Analytics", style: "cites the win chances, Ones to Watch and point lines; usually sides with the model and explains exactly why when she doesn't" },
];
// Saved stories of a type for a season, oldest first
const saved = (type, year) => (fs.existsSync(NEWS) ? fs.readdirSync(NEWS).filter((f) => f.startsWith(`${type}-${year}-`)).map((f) => JSON.parse(fs.readFileSync(path.join(NEWS, f), "utf8"))).sort((a, b) => a.wk - b.wk) : []);
// Each panelist's season record on picks so far, and how last week's picks went
function panelRecords(s, before) {
  const rec = Object.fromEntries(PANEL.map((p) => [p.name, { w: 0, l: 0, locks_w: 0, locks_l: 0, last_week: [] }]));
  for (const pv of saved("preview", s.year).filter((a) => a.wk < before)) for (const g of pv.picks || []) {
    const m = s.matchups.find((x) => x.wk === pv.wk && [x.h, x.a].includes(g.h) && [x.h, x.a].includes(g.a));
    if (!m || m.win === null || m.live) continue;
    for (const p of g.panel) { const r = rec[p.panelist]; if (!r) continue; const ok = p.id === m.win;
      r[ok ? "w" : "l"]++; if (p.confidence === "lock") r[ok ? "locks_w" : "locks_l"]++;
      if (pv.wk === before - 1) r.last_week.push(`${ok ? "hit" : "missed"} on ${p.pick}${p.confidence === "lock" ? " (lock)" : ""}`); }
  }
  return Object.fromEntries(Object.entries(rec).map(([k, r]) => [k, { record: `${r.w}-${r.l}`, locks: `${r.locks_w}-${r.locks_l}`, last_week: r.last_week.length ? r.last_week : undefined }]));
}
// All-time head-to-head between two managers, before a given week of a season
function h2hBefore(a, b, year, wk) {
  let w = 0, l = 0, last = null;
  for (const s of D.seasons) for (const m of s.matchups) {
    if (m.win === null || m.live || s.year > year || (s.year === year && m.wk >= wk)) continue;
    const x = mgrAt(s.byId[m.h], m.wk), y = mgrAt(s.byId[m.a], m.wk);
    if (!((x === a && y === b) || (x === b && y === a))) continue;
    const aWon = (m.win === m.h && x === a) || (m.win === m.a && y === a);
    if (m.win !== 0) aWon ? w++ : l++;
    last = `${s.year} week ${m.wk}: ${mgr(aWon ? a : b)} won ${Math.max(m.hp, m.ap)} to ${Math.min(m.hp, m.ap)}`;
  }
  return { record: `${mgr(a)} ${w}-${l} ${mgr(b)}`, last_meeting: last };
}
// What the panel needs before a week: matchups with records, win chances, Ones to Watch, history, odds
function previewFacts(s, W) {
  const rec = recordsThrough(s, W - 1), N = s.odds ? s.odds.weeks[s.odds.weeks.length - 1] : null;
  const rk = (saved("rankings", s.year).filter((a) => a.wk === W - 1)[0] || {}).power_rankings;
  return {
    season: s.year, week: W, regular_season_weeks: s.regWeeks,
    games: s.matchups.filter((m) => m.wk === W && m.a).map((m) => {
      const t = (id) => ({ team: who(s.byId[id], W), record: `${rec[id].w}-${rec[id].l}`, streak: rec[id].streak, points_for: r1(rec[id].pf),
        title_odds: N == null ? null : `${Math.round(oddsAt(s, N, id))}%`, playoff_odds: N == null ? null : `${Math.round(oddsAt(s, N, id, "p"))}%` });
      return { game: `${who(s.byId[m.h], W)} vs ${who(s.byId[m.a], W)}`, home: t(m.h), away: t(m.a),
        home_win_chance: m.psim != null ? `${Math.round(m.psim * 100)}%` : null,
        lineup_holes: m.holes ? m.holes.map((x) => `${x.n} (${x.pos}) for ${who(s.byId[x.id], W)}: ${x.why}`) : undefined,
        home_win_chance_if_lineups_fixed: m.psimFixed != null ? `${Math.round(m.psimFixed * 100)}%` : undefined,
        head_to_head: h2hBefore(mgrAt(s.byId[m.h], W), mgrAt(s.byId[m.a], W), s.year, W),
        ones_to_watch: (m.watch || []).map((x) => ({ player: `${x.n} (${x.pos}, ${x.pro})`, for: who(s.byId[x.id], W), [`win_chance_if_he_scores_${x.boomAt}_or_more`]: `${x.boom}%`, [`if_under_${x.bustAt}`]: `${x.bust}%` })),
        stacks: (m.stacks || []).map((k) => `${k.qb} and ${k.rec} for ${who(s.byId[k.id], W)}`) };
    }),
    last_week_power_rankings: rk ? rk.map((x) => `${x.rank}. ${x.team}`) : undefined,
    recent_trades: s.trades.filter((t) => t.wk >= W - 1).map((t) => ({ teams: t.teams.map((id) => who(s.byId[id], W)), received: Object.fromEntries(Object.entries(t.got).map(([id, g]) => [who(s.byId[id], W), g.map((x) => x.split("|")[0])])) })),
    panel: PANEL.map((p) => ({ name: p.name, role: p.role, style: p.style, season_picks: panelRecords(s, W)[p.name] })),
  };
}
// Power rankings after week W: each team's record, last result, form, odds movement and what's next
function rankingsFacts(s, W) {
  const rec = recordsThrough(s, W), prev = (saved("rankings", s.year).filter((a) => a.wk === W - 1)[0] || {}).power_rankings || [];
  const byPf = [...s.teams].sort((a, b) => rec[b.id].pf - rec[a.id].pf).map((t) => t.id);
  return {
    season: s.year, week: W, regular_season_weeks: s.regWeeks,
    teams: s.teams.map((t) => {
      const m = s.matchups.find((x) => x.wk === W && (x.h === t.id || x.a === t.id));
      const nx = [...s.matchups, ...(s.future || [])].find((x) => x.wk === W + 1 && (x.h === t.id || x.a === t.id) && x.a);
      const mine = m && (m.h === t.id ? [m.hp, m.ap, m.a] : [m.ap, m.hp, m.h]);
      const starters = [];
      for (const sp of spans(s, W)) for (const p of ((s.lineups[sp] || {})[t.id] || [])) if (p.slot !== "BN" && p.slot !== "IR") starters.push(p);
      const top = starters.sort((a, b) => b.pts - a.pts)[0];
      const odds = (k, N) => (oddsAt(s, N, t.id, k) == null ? null : `${Math.round(oddsAt(s, N, t.id, k))}%`);
      return {
        team: who(t, W), record: `${rec[t.id].w}-${rec[t.id].l}${rec[t.id].t ? "-" + rec[t.id].t : ""}`, streak: rec[t.id].streak,
        points_for: r1(rec[t.id].pf), points_for_rank: byPf.indexOf(t.id) + 1,
        this_week: mine ? `${m.win === t.id ? "won" : m.win === 0 ? "tied" : "lost"} ${mine[0]} to ${mine[1]} vs ${who(s.byId[mine[2]], W)}` : "bye",
        top_scorer_this_week: top ? `${top.n} (${top.pos}) ${top.pts}` : undefined,
        title_odds: odds("c", W), title_odds_last_week: odds("c", W - 1), playoff_odds: odds("p", W), playoff_odds_last_week: odds("p", W - 1),
        last_week_rank: (prev.find((x) => x.id === t.id) || {}).rank,
        next: nx ? `vs ${who(s.byId[nx.h === t.id ? nx.a : nx.h], W + 1)}` : W >= s.regWeeks ? "playoffs" : "bye",
      };
    }),
    trades_this_week: s.trades.filter((t) => t.wk === W || t.wk === W + 1).map((t) => ({ teams: t.teams.map((id) => who(s.byId[id], W)), received: Object.fromEntries(Object.entries(t.got).map(([id, g]) => [who(s.byId[id], W), g.map((x) => x.split("|")[0])])) })),
  };
}
function recapFacts(s, W) {
  const rec = recordsThrough(s, W), recBefore = recordsThrough(s, W - 1);
  const games = s.matchups.filter((m) => m.wk === W).map((m) => {
    const p = pregameWin(s, m), th = s.byId[m.h], ta = s.byId[m.a];
    return {
      home: who(th, W), away: who(ta, W), home_score: m.hp, away_score: m.ap,
      winner: m.win === m.h ? who(th, W) : m.win === m.a ? who(ta, W) : "tie",
      home_pregame_win_chance: p == null ? null : `${Math.round(p * 100)}%`,
      bracket: m.tier && m.tier !== "NONE" ? m.tier.toLowerCase().replace(/_/g, " ") : "regular season",
    };
  });
  const starts = [], bench = [];
  for (const sp of spans(s, W)) for (const id in s.lineups[sp] || {}) for (const p of s.lineups[sp][id]) {
    const row = { player: `${p.n} (${p.pos}, ${p.pro})`, team: who(s.byId[id], W), points: p.pts, projected: p.proj, status: STATUS[p.st] };
    if (p.slot === "BN") bench.push(row); else if (p.slot !== "IR") starts.push(row);
  }
  const standings = [...s.teams].sort((a, b) => rec[b.id].w - rec[a.id].w || rec[b.id].pf - rec[a.id].pf).map((t, i) => ({
    rank: i + 1, team: who(t, W), record: `${rec[t.id].w}-${rec[t.id].l}${rec[t.id].t ? "-" + rec[t.id].t : ""}`, points_for: r1(rec[t.id].pf), streak: rec[t.id].streak,
    title_odds_now: oddsAt(s, W, t.id) == null ? null : `${Math.round(oddsAt(s, W, t.id))}%`,
    title_odds_last_week: oddsAt(s, W - 1, t.id) == null ? null : `${Math.round(oddsAt(s, W - 1, t.id))}%`,
    playoff_odds_now: oddsAt(s, W, t.id, "p") == null ? null : `${Math.round(oddsAt(s, W, t.id, "p"))}%`,
  }));
  const moves = s.moves.filter((m) => m.wk === W).map((m) => ({ team: who(s.byId[m.tm], W), added: m.add.map((x) => x.split("|")[0]), dropped: m.drop.map((x) => x.split("|")[0]) }));
  const trades = s.trades.filter((t) => t.wk === W || t.wk === W + 1).map((t) => ({ teams: t.teams.map((id) => who(s.byId[id], W)), received: Object.fromEntries(Object.entries(t.got).map(([id, g]) => [who(s.byId[id], W), g.map((x) => x.split("|")[0])])) }));
  const next = [...s.matchups, ...(s.future || [])].filter((m) => m.wk === W + 1 && m.a).map((m) => `${who(s.byId[m.h], W + 1)} vs ${who(s.byId[m.a], W + 1)}`);
  // From the player sim: who swings next week's games most (a boom/bust is a top/bottom-20% game for him)
  const watch = s.matchups.filter((m) => m.wk === W + 1 && m.watch).map((m) => ({ game: `${who(s.byId[m.h], W + 1)} vs ${who(s.byId[m.a], W + 1)}`,
    ones_to_watch: m.watch.map((x) => ({ player: `${x.n} (${x.pos}, ${x.pro})`, for: who(s.byId[x.id], W + 1), [`team_win_chance_if_he_scores_${x.boomAt}_or_more`]: `${x.boom}%`, [`if_he_scores_under_${x.bustAt}`]: `${x.bust}%` })),
    stacks: (m.stacks || []).map((k) => `${k.qb} and ${k.rec} for ${who(s.byId[k.id], W + 1)}`) }));
  return {
    season: s.year, buckaroo_bowl_number: s.year - D.firstYear + 1, week: W, regular_season_weeks: s.regWeeks, playoff_teams: s.playoffTeams,
    games, top_performances: starts.sort((a, b) => b.points - a.points).slice(0, 6),
    biggest_busts: starts.filter((x) => x.projected != null).sort((a, b) => (a.points - a.projected) - (b.points - b.projected)).slice(0, 3),
    bench_blunders: bench.sort((a, b) => b.points - a.points).slice(0, 3),
    starters_who_did_not_play: starts.filter((x) => x.status),
    standings_after_week: standings, roster_moves_this_week: moves, trades, next_week_matchups: next, next_week_ones_to_watch: watch, trade_watch: tradeWatchFacts(s, W),
    records_before_this_week: Object.fromEntries(s.teams.map((t) => [who(t, W), `${recBefore[t.id].w}-${recBefore[t.id].l}`])),
  };
}
// How each earlier trade is aging: what the players did this week and since the deal
const tradeId = (s, tr) => `trade-${s.year}-${tr.wk}-${[...tr.teams].sort((a, b) => a - b).join("-")}`;
function tradeWatchFacts(s, W) {
  const now = spans(s, W);
  return s.trades.filter((tr) => tr.wk <= W).map((tr) => ({
    id: tradeId(s, tr), happened_before_week: tr.wk, weeks_since: W - tr.wk + 1,
    sides: tr.teams.map((id) => ({
      team: who(s.byId[id], W),
      received: (tr.got[id] || []).map((x) => {
        const n = x.split("|")[0], o = { player: n, points_this_week: 0, started_this_week: false, points_since_trade: 0, points_in_this_teams_lineup_since_trade: 0 };
        for (const wk in s.lineups) if (+wk >= tr.wk && +wk <= Math.max(...now)) for (const tid in s.lineups[wk]) for (const p of s.lineups[wk][tid]) {
          if (p.n !== n) continue;
          const started = p.slot !== "BN" && p.slot !== "IR";
          o.points_since_trade += p.pts;
          if (started && +tid === id) o.points_in_this_teams_lineup_since_trade += p.pts;
          if (now.includes(+wk)) { o.points_this_week += p.pts; o.started_this_week = started; o.rostered_by = who(s.byId[tid], W); if (p.st) o.status_this_week = STATUS[p.st]; }
        }
        for (const k of ["points_this_week", "points_since_trade", "points_in_this_teams_lineup_since_trade"]) o[k] = r1(o[k]);
        if (!o.rostered_by) o.rostered_by = "not on a roster this week";
        return o;
      }),
    })),
  }));
}
// Title odds before a trade (frozen when the week before it ended) and after (with the new rosters)
function tradeOdds(s, tr, id) {
  const pct = (v) => (v == null ? null : `${Math.round(v)}%`);
  const frozen = ((s.oddsAtWeekEnd || {})[tr.wk - 1] || {})[id];
  const latest = s.odds ? s.odds.weeks[s.odds.weeks.length - 1] : null;
  // Finished-week odds already include a trade made before the next week; mid-week, the newest odds are "after"
  const after = oddsAt(s, tr.wk, id) ?? (latest === tr.wk - 1 ? oddsAt(s, latest, id) : null);
  return { title_odds_before: frozen ? pct(frozen.c) : null, title_odds_after: pct(after), playoff_odds_before: frozen ? pct(frozen.p) : null, playoff_odds_after: pct(oddsAt(s, tr.wk, id, "p") ?? (latest === tr.wk - 1 ? oddsAt(s, latest, id, "p") : null)) };
}
function tradeFacts(s, tr) {
  const pointsFor = (n) => { let pts = 0, gp = 0; for (const wk in s.lineups) for (const id in s.lineups[wk]) for (const p of s.lineups[wk][id]) if (p.n === n && +wk < tr.wk) { pts += p.pts; gp++; } return { season_points_before_trade: r1(pts), weeks_on_a_roster: gp }; };
  return {
    season: s.year, happened_before_week: tr.wk,
    sides: tr.teams.map((id) => ({
      team: who(s.byId[id], tr.wk),
      received: (tr.got[id] || []).map((x) => { const [n, pos] = x.split("|"); return { player: n, position: pos, ...pointsFor(n) }; }),
      ...tradeOdds(s, tr, id),
    })),
  };
}
function reviewFacts(s) {
  const last = Math.max(...s.matchups.map((m) => m.wk));
  const rec = recordsThrough(s, s.regWeeks);
  const byFinal = [...s.teams].sort((a, b) => a.final - b.final);
  const games = s.matchups.filter(done);
  // Single weeks only: 2023-24 playoff rounds were two-week totals
  const sides = games.filter((m) => spans(s, m.wk).length === 1).flatMap((m) => [{ t: s.byId[m.h], p: m.hp, wk: m.wk }, { t: s.byId[m.a], p: m.ap, wk: m.wk }]);
  const hi = [...sides].sort((a, b) => b.p - a.p)[0], lo = [...sides].sort((a, b) => a.p - b.p)[0];
  const playoffs = games.filter((m) => m.tier === "WINNERS_BRACKET").map((m) => `${who(s.byId[m.h], m.wk)} ${m.hp} - ${m.ap} ${who(s.byId[m.a], m.wk)}${spans(s, m.wk).length > 1 ? " (two-week total)" : ""}`);
  return {
    season: s.year, buckaroo_bowl_number: s.year - D.firstYear + 1, teams: s.teams.length,
    final_standings: byFinal.map((t) => ({ finish: t.final, team: who(t, last), managers: (t.eras || [{ mgr: t.mgr }]).map((e) => mgr(e.mgr)).join(" then "), regular_season_record: `${rec[t.id].w}-${rec[t.id].l}`, points_for: r1(rec[t.id].pf), playoff_seed: t.seed })),
    playoff_games: playoffs,
    highest_single_week: `${who(hi.t, hi.wk)} ${hi.p} in week ${hi.wk}`, lowest_single_week: `${who(lo.t, lo.wk)} ${lo.p} in week ${lo.wk}`,
    trades: s.trades.length, notes: s.notes || [],
  };
}

// The draft, as it looked on draft day: every pick, each team's haul, position runs, keepers
function draftFacts(s) {
  const prev = S[s.year - 1];
  const lastYear = (t) => { if (!prev) return null; const p = prev.teams.find((x) => (x.eras || [x]).some((e) => e.mgr === t.mgr)); return p ? `${p.final} of ${prev.teams.length} in ${prev.year}` : "new to the league"; };
  const picks = [...s.draft].sort((a, b) => a.pk - b.pk);
  const firstAt = {};
  for (const p of picks) if (!firstAt[p.pos]) firstAt[p.pos] = `${p.n} at pick ${p.pk} by ${who(s.byId[p.tm], 1)}`;
  return {
    season: s.year, buckaroo_bowl_number: s.year - D.firstYear + 1, teams: s.teams.length, rounds: Math.max(...picks.map((p) => p.rd)),
    draft_order: picks.filter((p) => p.rd === 1).map((p) => ({ pick: p.rp, team: who(s.byId[p.tm], 1), last_season: lastYear(s.byId[p.tm]) })),
    picks: picks.map((p) => ({ overall: p.pk, round: p.rd, team: who(s.byId[p.tm], 1), player: `${p.n} (${p.pos}, ${p.pro})`, keeper: p.keeper || undefined })),
    first_player_taken_at_each_position: firstAt,
    picks_by_position_per_round: Object.fromEntries([...new Set(picks.map((p) => p.rd))].map((rd) => [`round ${rd}`, picks.filter((p) => p.rd === rd).reduce((a, p) => ((a[p.pos] = (a[p.pos] || 0) + 1), a), {})])),
  };
}
// A manager's whole league history, for their career profile
function careerFacts(k, upto = Infinity) {
  const runs = (t) => (t.eras || [{ mgr: t.mgr, from: 1 }]).some((e) => e.mgr === k);
  const seasons = [], games = [];
  for (const s of D.seasons.filter((x) => x.year <= upto)) {
    const t = s.teams.find(runs);
    if (!t) continue;
    const rec = recordsThrough(s, s.regWeeks)[t.id];
    const kicked = (t.eras || []).find((e) => e.kicked && e.mgr === k);
    seasons.push({
      season: s.year, team: (t.eras || [t]).map((e) => e.name).filter((x, i, a) => a.indexOf(x) === i).join(" / "),
      regular_season_record: `${rec.w}-${rec.l}${rec.t ? "-" + rec.t : ""}`, points_for: r1(rec.pf), playoff_seed: s.done ? t.seed : null,
      final_finish: s.done ? `${t.final} of ${s.teams.length}` : "season in progress",
      title_odds_now: !s.done && oddsAt(s, s.odds ? s.odds.weeks[s.odds.weeks.length - 1] : -1, t.id) != null ? `${Math.round(oddsAt(s, s.odds.weeks[s.odds.weeks.length - 1], t.id))}%` : undefined,
      note: kicked ? `Kicked for inactivity after week ${kicked.from - 1}; the team played on without him and the games still count on his record` : undefined,
      trades: s.trades.filter((tr) => tr.teams.includes(t.id)).length,
      pickups: s.moves.filter((m) => m.tm === t.id).reduce((a, m) => a + m.add.length, 0),
    });
    for (const m of s.matchups.filter(done)) for (const [id, p, oid, op] of [[m.h, m.hp, m.a, m.ap], [m.a, m.ap, m.h, m.hp]]) {
      if (mgrAt(s.byId[id], m.wk) !== k) continue;
      games.push({ year: s.year, wk: m.wk, p, op, won: m.win === id, tie: m.win === 0, opp: mgrAt(s.byId[oid], m.wk), playoff: m.tier === "WINNERS_BRACKET", single: spans(s, m.wk).length === 1 });
    }
  }
  const h2h = {};
  for (const g of games) { const x = (h2h[mgr(g.opp)] = h2h[mgr(g.opp)] || { w: 0, l: 0 }); if (g.won) x.w++; else if (!g.tie) x.l++; }
  const po = games.filter((g) => g.playoff), single = games.filter((g) => g.single);
  const best = [...single].sort((a, b) => b.p - a.p)[0], worst = [...single].sort((a, b) => a.p - b.p)[0];
  return {
    manager: mgr(k), seasons,
    buckaroo_bowl_titles: D.seasons.filter((s) => s.done && s.teams.some((t) => t.final === 1 && runs(t))).map((s) => s.year),
    last_place_finishes: D.seasons.filter((s) => s.done && s.teams.some((t) => t.final === s.teams.length && runs(t))).map((s) => s.year),
    playoff_record: `${po.filter((g) => g.won).length}-${po.filter((g) => !g.won && !g.tie).length}`,
    best_week: best && `${r1(best.p)} in ${best.year} week ${best.wk} vs ${mgr(best.opp)}`,
    worst_week: worst && `${r1(worst.p)} in ${worst.year} week ${worst.wk} vs ${mgr(worst.opp)}`,
    head_to_head: Object.fromEntries(Object.entries(h2h).map(([o, x]) => [o, `${x.w}-${x.l}`])),
  };
}

// The whole league's story through its last finished season, for the history on the Buckaroo Bowls page
function historyFacts(upto) {
  const done = D.seasons.filter((s) => s.done && s.year <= upto);
  const played = (k) => done.some((s) => s.teams.some((t) => (t.eras || [t]).some((e) => e.mgr === k)));
  const cur = D.seasons[D.seasons.length - 1];
  return {
    founded: D.firstYear, seasons: done.map(reviewFacts),
    managers: Object.keys(D.managers).filter((k) => k !== "nomanager" && played(k)).map((k) => careerFacts(k, upto)),
    since_then: cur.year > upto ? `In ${cur.year} the league grew to ${cur.teams.length} teams${(() => { const nw = cur.teams.map((t) => t.mgr).filter((k) => !played(k)).map(mgr); return nw.length ? `, adding ${nw.join(" and ")}` : ""; })()}. That season is still being played.` : undefined,
  };
}

// ---------- League background (same for every request, so it caches) ----------
function leagueBackground() {
  const champs = D.seasons.filter((s) => s.done).map((s) => { const t = s.teams.find((x) => x.final === 1), l = s.teams.find((x) => x.final === s.teams.length); return `Buckaroo Bowl ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII"][s.year - D.firstYear] || s.year - D.firstYear + 1} (${s.year}): champion ${who(t, 99)}; last place ${who(l, 99)}.`; });
  const cur = D.seasons[D.seasons.length - 1];
  const teams = cur.teams.map((t) => `${t.name} = ${mgr(t.mgr)} (official account @${t.name.replace(/[^A-Za-z0-9]/g, "")})`).join("; ");
  const notes = D.seasons.flatMap((s) => (s.notes || []).map((n) => `${s.year}: ${n}`));
  return [
    `The Buckaroo Football League is a fantasy football league among friends on ESPN, founded in ${D.firstYear}. It had 6 teams through 2025 and 8 teams from 2026. The championship is the Buckaroo Bowl, numbered with Roman numerals from Bowl I in ${D.firstYear}. Last place is decided by a consolation ladder.`,
    `Past results: ${champs.join(" ")}`,
    `Current teams (${cur.year}): ${teams}.`,
    notes.length ? `League notes: ${notes.join(" ")}` : "",
  ].filter(Boolean).join("\n");
}
// Nicknames and running jokes. They name real people, so they never go in the public repo:
// GitHub reads them from the LEAGUE_LORE secret; on this computer, from data/lore.md (not committed).
const LORE_FILE = path.join(__dirname, "data", "lore.md");
// LEAGUE_LORE_EXTRA holds later additions, so they can be added without retyping the original.
// Where the two disagree, the additions win.
const LORE_EXTRA = (process.env.LEAGUE_LORE_EXTRA || "").trim();
const LORE = [(process.env.LEAGUE_LORE || (fs.existsSync(LORE_FILE) ? fs.readFileSync(LORE_FILE, "utf8") : "")).trim(),
  LORE_EXTRA && `Later additions from the league. These take priority over anything above they conflict with, including how often a joke or label comes up:\n${LORE_EXTRA}`].filter(Boolean).join("\n\n");
const SYSTEM = `You are the newsroom of the Buckaroo Football League: its beat writer and its social media desk. Your stories appear on the league's website, which the league's managers and their friends read.

Voice: a sharp, funny sports columnist covering a league of friends. Lovingly roast the managers' decisions, celebrate big performances, build up rivalries and storylines, and treat the Buckaroo Bowl like the Super Bowl. Keep it PG-13 and good-natured; the jokes are about fantasy football, never about anyone's life outside it.

Rules:
- Use only the facts provided. Never invent scores, stats, injuries, trades, quotes from managers, or events. You may interpret and speculate about what the numbers mean.
- Call teams by their exact names as given. For managers, mix their first names and everyday nicknames from the lore interchangeably, the way friends talk, without explaining or making a bit of the nickname. Titles and joke labels (a league role, "the villain") are different: those count as running jokes. A "(name)" after a team is its manager.
- Never mention where anyone lives, works, studies, or serves beyond what the lore says.
- Social posts come from fictional accounts only: made-up fans, team fan clubs, pundits, and "insiders". Never write as, or tag, real NFL players, journalists, or celebrities.
- Most social posts come from fans and pundits. Add 1 to 3 posts from the league's verified accounts, written the way real clubs and reporters post, like the news feed in Football Manager:
  - kind "league": Buckaroo Football League (@BuckarooFL), neutral and official: results, milestones, standings.
  - kind "team": a team's official account, named after the team, with its exact team name in the team field and the handle listed for it under Current teams. On-brand and upbeat, like a club: matchday results, player of the week, "welcome to the club" after a trade. Never written as the manager.
  - kind "reporter": the league's media panel, all fictional: ${PANEL.map((p) => `${p.name} (${p.handle}), ${p.role.toLowerCase()}: ${p.style}`).join("; ")}.
  - Keep the same name and handle for the same account every time. Set team to "" for every post that isn't kind "team".
- A player marked "on bye" or "did not play" scored nothing because he didn't play. Say so plainly; never treat it as a bad game or a bust. Starting one is the manager's lineup mistake, not the player's.
- Running jokes and nicknames are seasoning, not the meal. Use any one bit at most once in a story, leave most of them out of most stories, and never make the same joke the punchline two stories in a row. A manager is more than their running joke: describe what they actually did this week first. Labels count as running jokes too: don't cast anyone as the league's villain, punching bag, or hothead by default. Use a label like that at most once in a story, and leave it out of most stories.
- Plain text only, no markdown. Body paragraphs should be 2 to 5 sentences each.

League background:
${leagueBackground()}

The people and the inside jokes (from the league; follow its own rules too):
${LORE}`;

// ---------- Output shapes ----------
const str = { type: "string" };
const SOCIAL = { type: "array", items: { type: "object", additionalProperties: false, required: ["author", "handle", "text", "kind", "team"], properties: { author: str, handle: str, text: str,
  kind: { type: "string", enum: ["fan", "pundit", "reporter", "team", "league"] }, team: str } } };
const ARTICLE = { title: str, dek: str, body: { type: "array", items: str } };
const schemas = {
  recap: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social", "bios", "trade_watch"], properties: { ...ARTICLE, social: SOCIAL,
    trade_watch: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "take"], properties: { id: str, take: str } } },
    bios: { type: "array", items: { type: "object", additionalProperties: false, required: ["team", "bio"], properties: { team: str, bio: str } } } } },
  trade: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social"], properties: { ...ARTICLE, social: SOCIAL } },
  review: { type: "object", additionalProperties: false, required: ["title", "dek", "body"], properties: ARTICLE },
  draft: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social"], properties: { ...ARTICLE, social: SOCIAL } },
  preview: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "picks", "social"], properties: { ...ARTICLE, social: SOCIAL,
    picks: { type: "array", items: { type: "object", additionalProperties: false, required: ["game", "panel"], properties: { game: str,
      panel: { type: "array", items: { type: "object", additionalProperties: false, required: ["panelist", "pick", "confidence", "take"], properties: {
        panelist: { type: "string", enum: PANEL.map((p) => p.name) }, pick: str, confidence: { type: "string", enum: ["lean", "confident", "lock"] }, take: str } } } } } } } },
  rankings: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "power_rankings"], properties: { ...ARTICLE,
    power_rankings: { type: "array", items: { type: "object", additionalProperties: false, required: ["rank", "team", "blurb"], properties: { rank: { type: "integer" }, team: str, blurb: str } } } } },
  history: { type: "object", additionalProperties: false, required: ["title", "dek", "chapters"], properties: { title: str, dek: str,
    chapters: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: str, body: { type: "array", items: str } } } } } },
  profile: { type: "object", additionalProperties: false, required: ["headline", "body"], properties: { headline: str, body: { type: "array", items: str } } },
};
const asks = {
  recap: "Write the weekly recap for this week of the Buckaroo Football League: a headline, a one-sentence dek, and 5 to 8 body paragraphs covering the results (lead with the best storyline), standout and disappointing performances, the standings and title-odds picture, notable moves, and a look ahead to next week (if next_week_ones_to_watch is given, mention a player or two whose game swings a matchup most, or a QB-receiver stack). Then write 6 to 10 social posts reacting to the week, and a fresh 2 to 3 sentence bio for every team in the standings that sums up where its season stands right now (use the exact team name in the team field). Finally, the trade watch: quick 1 to 2 sentence takes on how earlier trades in trade_watch are aging, for the 2 to 5 deals with the most to say this week (a deal that looked lopsided flipping, a player who carried his new team or sat on its bench, a winner pulling further ahead). These are quick hot takes, not articles; say how it looks now compared with before. Use the trade's id from the facts. If there are no trades yet, leave it empty.",
  trade: "Write a trade reaction story: a headline, a one-sentence dek, and 3 to 5 body paragraphs explaining the deal, what each side got, and who won it on paper (use the title and playoff odds change; if the before odds are missing, use only the odds after and don't call them pre-trade). Then write 3 to 5 social posts reacting to it.",
  profile: "Write a career profile of this manager for their page on the league website, like a club history page in Football Manager: a short headline that captures who they are in this league, and 3 to 5 body paragraphs telling the story of their whole run: each season, the highs and lows, rivalries from the head-to-head records, their habits as a manager (trades, waiver moves), and where they stand right now. Use their nicknames and the lore, as seasoning on top of what actually happened.",
  draft: "Write the draft-day story for this season's Buckaroo Football League draft, as if written the night of the draft, before any games: a headline, a one-sentence dek, and 5 to 7 body paragraphs covering the first round and draft order, each manager's strategy and haul, position runs, keepers, and the picks that look like reaches or values. Judge picks only by where players went relative to each other, each team's roster build and the draft order; you know nothing about how the season has gone since, and don't cite stats or projections that aren't in the facts. Then write 4 to 8 social posts reacting to the draft, including official team accounts welcoming their first-round picks.",
  rankings: "Write this week's Buckaroo Football League power rankings, the way NFL.com publishes them every Tuesday: a headline, a one-sentence dek, a 1 to 2 paragraph intro on what moved the rankings this week, then every team ranked 1 to N (use the exact team name, without the manager). Each team gets a 2 to 4 sentence write-up in the NFL.com style: what happened this week, what's working or what's broken, and what's next, with a line on why it rose or fell from last_week_rank when there is one. They're the newsroom's opinion, not the standings: weigh record, points, form, the odds and how the team looks right now, and it's fine to rank a team above one with a better record if you can say why.",
  preview: "Write the weekly preview for this week of the Buckaroo Football League, like a network's pregame show: a headline, a one-sentence dek, and 3 to 5 body paragraphs on the week's biggest storylines and matchups (win chances, Ones to Watch, head-to-head history, stakes in the standings). Then the panel's picks: for every game in games (use its game text exactly), each of the four panelists picks a winner (the exact team name, without the manager), a confidence (lean, confident or lock; Sal calls plenty of locks, Nina rarely does) and a 1 to 3 sentence take in their own voice. Picks should disagree sometimes, and panelists can needle each other or bring up their season_picks record. When a game has lineup_holes, home_win_chance is the lineup as set right now (starters on bye or ruled out score zero) and home_win_chance_if_lineups_fixed is what it would be if the managers swap them out: make clear which number is which, and let the panel run with it in character (the insider on whether the manager will fix it, the gambler exaggerating the as-set number, the analyst on what the fixed number says). Then 5 to 8 social posts: panelists hyping their lock, and fans reacting to a specific panelist's take on their team, annoyed or gloating, the way fanbases do online. Fans may only quote or paraphrase what a panelist actually said in this preview.",
  history: "Write the official history of the Buckaroo Football League for the front of its trophy room, like a club history in Football Manager or a long-form feature: a headline, a one-sentence dek, and 4 to 6 chapters, each with a short heading and 2 to 4 paragraphs. Tell it as one story across the seasons: how it started, each Buckaroo Bowl and what decided it, dynasties and droughts, rises and collapses, the rivalries the head-to-head records reveal, and the moments people still bring up. End with a short chapter that sets up the present (from since_then, without any of its results). Every number must come from the facts.",
  review: "Write a season-in-review story for this finished season: a headline, a one-sentence dek, and 5 to 7 body paragraphs telling the story of the season from draft to Buckaroo Bowl, including the champion, the last-place finisher, the playoff games, and any notable notes.",
};

// ---------- What still needs writing ----------
function pending() {
  const have = new Set(fs.existsSync(NEWS) ? fs.readdirSync(NEWS).map((f) => f.replace(/\.json$/, "")) : []);
  const todo = [];
  for (const s of D.seasons.filter((x) => x.done)) if (!have.has(`review-${s.year}`)) todo.push({ id: `review-${s.year}`, type: "review", s, wk: 99, facts: () => reviewFacts(s) });
  const cur = D.seasons.filter((x) => !x.done).slice(-1)[0] || null;
  // The week's preview: before its games, from Wednesday 6pm ET until Sunday 1pm ET (or on a manual run before games)
  if (cur) {
    const W = cur.curWeek, ms = cur.matchups.filter((m) => m.wk === W && m.a);
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })), day = et.getDay(), hr = et.getHours();
    const inWindow = (day === 3 && hr >= 18) || day === 4 || day === 5 || day === 6 || (day === 0 && hr < 13) || process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
    const before = ms.length && ms.every((m) => m.live && m.psim != null && !m.hp && !m.ap);
    if (inWindow && before && !have.has(`preview-${cur.year}-${W}`)) todo.push({ id: `preview-${cur.year}-${W}`, type: "preview", s: cur, wk: W - 0.4, facts: () => previewFacts(cur, W) });
  }
  // Power rankings for every finished week; the newest is released Tuesday 9am ET (or on a manual run)
  if (cur) {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })), day = et.getDay(), hr = et.getHours();
    const finished = [...new Set(cur.matchups.map((m) => m.wk))].filter((w) => w <= cur.regWeeks && cur.matchups.filter((m) => m.wk === w).every(done)).sort((a, b) => a - b);
    const newest = finished[finished.length - 1];
    const released = !(day === 1 || (day === 2 && hr < 9)) || process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
    for (const W of finished) if (!have.has(`rankings-${cur.year}-${W}`) && (W < newest || released)) todo.push({ id: `rankings-${cur.year}-${W}`, type: "rankings", s: cur, wk: W + 0.5, facts: () => rankingsFacts(cur, W) });
  }
  if (cur && cur.draft && cur.draft.length && !have.has(`draft-${cur.year}`)) todo.push({ id: `draft-${cur.year}`, type: "draft", s: cur, wk: 0, facts: () => draftFacts(cur) });
  if (cur) {
    const weeks = [...new Set(cur.matchups.map((m) => m.wk))].sort((a, b) => a - b);
    for (const W of weeks) {
      const ms = cur.matchups.filter((m) => m.wk === W);
      if (!ms.length || !ms.every(done)) break;
      if (!have.has(`recap-${cur.year}-${W}`)) todo.push({ id: `recap-${cur.year}-${W}`, type: "recap", s: cur, wk: W, facts: () => recapFacts(cur, W) });
    }
    for (const tr of cur.trades) { const id = tradeId(cur, tr); if (!have.has(id)) todo.push({ id, type: "trade", s: cur, wk: tr.wk - 0.5, tr, facts: () => tradeFacts(cur, tr) }); }
  }
  // Career profiles and the league history, rewritten once each season finishes
  const lastDone = Math.max(...D.seasons.filter((x) => x.done).map((x) => x.year));
  if (!have.has(`history-${lastDone}`)) todo.push({ id: `history-${lastDone}`, type: "history", s: S[lastDone], wk: 101, facts: () => historyFacts(lastDone) });
  for (const k of Object.keys(D.managers).filter((k) => k !== "nomanager")) {
    const id = `profile-${k}-${lastDone}`;
    if (!have.has(id)) todo.push({ id, type: "profile", s: S[lastDone], wk: 100, mgr: k, facts: () => careerFacts(k) });
  }
  // Oldest news first, so the archive reads in order
  return todo.sort((a, b) => a.s.year - b.s.year || a.wk - b.wk);
}

// The last few stories, so a new one doesn't repeat their jokes and angles
function recentStories(n = 4) {
  if (!fs.existsSync(NEWS)) return [];
  return fs.readdirSync(NEWS).map((f) => JSON.parse(fs.readFileSync(path.join(NEWS, f), "utf8"))).filter((a) => a.type !== "profile" && a.type !== "history")
    .sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, n)
    .map((a) => ({ title: a.title, body: a.body, social: (a.social || []).map((p) => `${p.author} (${p.handle}): ${p.text}`), trade_watch: (a.trade_watch || []).map((t) => t.take) }));
}

async function write(client, job) {
  const facts = job.facts();
  // Profiles stand on their own, and draft-day coverage mustn't know how the season went
  // Rankings for past weeks mustn't see later stories, so they get none
  const recent = ["profile", "draft", "history", "rankings"].includes(job.type) ? [] : recentStories();
  const avoid = recent.length ? `\n\nThe league's most recent stories, for reference only. Readers just read these, so don't reuse their jokes, nicknames-as-punchlines, or angles; find fresh ones:\n${JSON.stringify(recent)}` : "";
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a safety check declines, Anthropic retries on its recommended fallback model
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: schemas[job.type] } },
    messages: [{ role: "user", content: `${asks[job.type]}\n\nFacts (JSON):\n${JSON.stringify(facts)}${avoid}` }],
  });
  if (res.stop_reason === "refusal") { console.log(`::warning::${job.id}: declined (${res.stop_details && res.stop_details.category}), skipping`); return null; }
  if (res.stop_reason === "max_tokens") { console.log(`::warning::${job.id}: ran out of room, will retry next run`); return null; }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let out;
  try { out = JSON.parse(text); } catch { console.log(`::warning::${job.id}: response wasn't valid JSON, will retry next run`); return null; }
  if (out.chapters) out.body = out.chapters.flatMap((c) => c.body);
  // Stories are permanent, so don't keep one that came back hollow
  const hollow = job.type === "rankings" ? !(out.body || []).length || (out.power_rankings || []).length !== job.s.teams.length
    : !out.body || out.body.length < 2 || (schemas[job.type].required.includes("social") && !(out.social || []).length);
  if (hollow) { console.log(`::warning::${job.id}: came back with an empty story, will retry next run`); return null; }
  // Bios name teams as written in the facts ("Name (Manager)"); match on the team-name part
  const teamFor = (label) => job.s.teams.find((t) => label === nameAt(t, job.wk) || label.startsWith(nameAt(t, job.wk) + " ("));
  return {
    id: job.id, type: job.type, year: job.s.year, wk: ["review", "profile", "history"].includes(job.type) ? null : job.type === "rankings" ? Math.floor(job.wk) : Math.ceil(job.wk), created: new Date().toISOString(),
    title: out.title || out.headline, dek: out.dek || "", body: out.body, chapters: out.chapters, social: out.social || [], teams: job.tr ? job.tr.teams : [], mgr: job.mgr,
    trade_watch: out.trade_watch ? out.trade_watch.filter((t) => (facts.trade_watch || []).some((x) => x.id === t.id)) : undefined,
    picks: out.picks ? out.picks.map((g) => { const m = job.s.matchups.find((x) => x.wk === Math.ceil(job.wk) && g.game === `${who(job.s.byId[x.h], x.wk)} vs ${who(job.s.byId[x.a], x.wk)}`);
      return m && { game: g.game, h: m.h, a: m.a, panel: g.panel.map((p) => ({ ...p, id: (teamFor(p.pick) || {}).id })) }; }).filter(Boolean) : undefined,
    power_rankings: out.power_rankings ? out.power_rankings.map((x) => ({ ...x, id: (teamFor(x.team) || {}).id })).sort((a, b) => a.rank - b.rank) : undefined,
    bios: out.bios ? Object.fromEntries(out.bios.map((b) => [(teamFor(b.team) || {}).id, b.bio]).filter(([id]) => id != null)) : undefined,
    model: res.model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  };
}

(async () => {
  // Says whether each lore secret arrived (lengths only, never the contents)
  console.log(`::notice::Lore: LEAGUE_LORE ${(process.env.LEAGUE_LORE || "").trim().length} characters, LEAGUE_LORE_EXTRA ${LORE_EXTRA.length} characters`);
  const todo = pending();
  if (!todo.length) { console.log("News is up to date."); return; }
  console.log(`${todo.length} stories to write: ${todo.map((j) => j.id).join(", ")}`);
  if (DRY) { for (const j of [todo[0], todo[todo.length - 1]]) console.log(`\n--- ${j.id} ---\n${JSON.stringify(j.facts(), null, 1).slice(0, 3000)}`); console.log(`\nSystem prompt:\n${SYSTEM}`); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("No ANTHROPIC_API_KEY set, skipping news."); return; }
  // Stories are permanent, so wait for the nicknames rather than write without them
  if (!LORE) { console.log("No LEAGUE_LORE secret set, skipping news until it is."); return; }
  const client = new Anthropic();
  fs.mkdirSync(NEWS, { recursive: true });
  for (const job of todo.slice(0, MAX_PER_RUN)) {
    try {
      const art = await write(client, job);
      if (!art) continue;
      fs.writeFileSync(path.join(NEWS, `${job.id}.json`), JSON.stringify(art, null, 1));
      console.log(`${job.id}: "${art.title}" (${art.usage.input} in / ${art.usage.output} out tokens)`);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) { console.log("The ANTHROPIC_API_KEY secret was rejected. Check it in GitHub settings."); process.exitCode = 1; return; }
      if (err instanceof Anthropic.RateLimitError) { console.log("Rate limited, will continue next run."); return; }
      if (err instanceof Anthropic.APIError) { console.log(`::warning::${job.id}: API error ${err.status}: ${err.message}`); continue; }
      throw err;
    }
  }
})();
