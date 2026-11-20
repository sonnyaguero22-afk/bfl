// Live social posts during games. Each update compares this week's scores, win chances and
// players' points with the last update (history/livestate_<year>.json), and when something
// happened (a touchdown, a big play, a turnover, an injury, a lead change, a big swing, a Bounty Board pick's Gear 5 or Seastoned game, a
// final), and when anyone picks up or drops a player (waivers or free agency, any day of the week),
// asks Claude for a few posts reacting to it, saved to news/live-<year>-<week>.json.
// At most 2 batches (calls) an hour and 20 a day.
// Runs in GitHub Actions after build.js; quiet updates make no API call.
// Usage: node live.js            (post if anything happened)
//        node live.js --dry-run  (print the events; no API calls, nothing saved)
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { S, SYSTEM, SOCIAL, LORE, NEWS, who, nameAt, QUOTES, quoteTeam, missingStars, NAMESAKES, NAMESAKE_AWARD, awardRaces } = require("./news");

const MODEL = "claude-sonnet-5-5"; // short posts, many times a game day; the articles stay on Opus
const MAX_BATCHES_PER_DAY = 20;    // keeps a wild Sunday's cost predictable
const MAX_BATCHES_PER_HOUR = 2;    // spreads them out, so night games get posts too
const BIG_PLAY = 8;                // points a starter gains between updates to count as a big play
const BIG_SWING = 0.2;             // change in win chance between updates worth reacting to
const DRY = process.argv.includes("--dry-run");

const cur = Object.values(S).filter((s) => !s.done).sort((a, b) => b.year - a.year)[0];
if (!cur) { console.log("No season in progress."); process.exit(0); }
const W = cur.curWeek, games = cur.matchups.filter((m) => m.wk === W && m.a);
const STATE = path.join(__dirname, "history", `livestate_${cur.year}.json`);
const FEED = path.join(NEWS, `live-${cur.year}-${W}.json`);
const pct = (p) => `${Math.round(p * 100)}%`;
const team = (id) => who(cur.byId[id], W);

const PLAYS = ["ptd", "rtd", "ctd", "dtd", "fg", "to"];
// "caught a touchdown", "threw 2 touchdown passes and an interception"...
const n2 = (k, one, many) => (k === 1 ? one : `${k} ${many}`);
function told(d, pos) {
  const out = [];
  if (d.ptd) out.push(`threw ${n2(d.ptd, "a touchdown pass", "touchdown passes")}`);
  if (d.rtd) out.push(`ran in ${n2(d.rtd, "a touchdown", "touchdowns")}`);
  if (d.ctd) out.push(`caught ${n2(d.ctd, "a touchdown", "touchdowns")}`);
  if (d.dtd) out.push(`scored ${n2(d.dtd, "a defensive or return touchdown", "defensive or return touchdowns")}`);
  if (d.fg) out.push(`kicked ${n2(d.fg, "a field goal", "field goals")}`);
  if (d.to && pos !== "D/ST") out.push(pos === "QB" ? `turned it over (${n2(d.to, "an interception or fumble", "interceptions or fumbles")})` : `lost ${n2(d.to, "a fumble", "fumbles")}`);
  return out.join(" and ");
}
// Short label for the chart: "TD", "2 TD", "FG", "TO"
const tag = (d) => { const td = d.ptd + d.rtd + d.ctd + d.dtd; return td ? (td > 1 ? `${td} TD` : "TD") : d.fg ? "FG" : d.to ? "TO" : ""; };
// Where a starter's NFL game stands, so the posts don't treat a finished game as one to come
const GAME = { pre: "yet to play", on: "playing now", done: "game over" };
// ESPN's injury designations, in words
const INJ = { QUESTIONABLE: "questionable", DOUBTFUL: "doubtful", OUT: "out", INJURY_RESERVE: "on injured reserve", SUSPENSION: "suspended", DAY_TO_DAY: "day to day" };
const injured = (s) => INJ[s] || (s ? s.toLowerCase().replace(/_/g, " ") : "");

// What the scoreboard looks like right now
const starters = (id) => ((cur.lineups[W] || {})[id] || []).filter((p) => p.slot !== "BN" && p.slot !== "IR");
const now = {
  wk: W,
  games: Object.fromEntries(games.map((m) => [`${m.h}-${m.a}`, { hp: m.hp, ap: m.ap, p: m.psim, win: m.win }])),
  // Each starter's points and scoring plays so far: [points, TD passes, rushing TDs, receiving TDs, D/ST TDs, field goals, turnovers]
  players: Object.fromEntries(games.flatMap((m) => [m.h, m.a]).flatMap((id) => starters(id).map((p) => [`${id}|${p.n}`, [p.pts, ...PLAYS.map((k) => (p.x || {})[k] || 0)]]))),
  moves: cur.moves.map((m) => `${m.date}|${m.tm}`),
  // Each starter's injury designation, to catch a player getting hurt mid-game or ruled out before his game
  inj: Object.fromEntries(games.flatMap((m) => [m.h, m.a]).flatMap((id) => starters(id).filter((p) => p.inj).map((p) => [`${id}|${p.n}`, p.inj]))),
  // Starters whose NFL game is over, so a Bounty Board pick's Seastoned is told once, when his game ends
  done: Object.fromEntries(games.flatMap((m) => [m.h, m.a]).flatMap((id) => starters(id).filter((p) => p.g === "done").map((p) => [`${id}|${p.n}`, 1]))),
  // Players a manager vowed to start in this week's final word (QUOTES) who are now on his bench
  benched: (QUOTES[`final-${cur.year}-${W}`] || []).filter((q) => { const t = quoteTeam(q, cur, W);
    return q.starting && t && ((cur.lineups[W] || {})[t.id] || []).some((p) => p.n === q.starting && (p.slot === "BN" || p.slot === "IR")); }).map((q) => q.starting),
  // Every rostered player's injury status, for injury news between games
  // status|expected return|out for the season, so a new designation, a moved return date and a comeback all count as news
  rinj: Object.fromEntries(Object.entries(cur.rosters || {}).flatMap(([id, ps]) => ps.filter((p) => p.inj).map((p) => [`${id}|${p.n}`, `${p.inj}|${p.injBack || ""}|${p.injSeason ? 1 : ""}`]))),
  at: Date.now(),
};
const before = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null;
const save = () => { if (!DRY) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(now)); } };

// What changed since the last update
const events = [], plays = {};
if (before && before.wk === W) {
  for (const m of games) {
    const k = `${m.h}-${m.a}`, a = before.games[k], b = now.games[k];
    if (!a || !b) continue;
    const label = `${team(m.h)} vs ${team(m.a)}`;
    if (b.win != null && a.win == null) events.push(`FINAL: ${team(b.win === 0 ? m.h : b.win)} ${b.win === 0 ? "tied" : "won"}, ${Math.max(b.hp, b.ap)} to ${Math.min(b.hp, b.ap)} (${label})`);
    else {
      const lead = (g) => Math.sign(g.hp - g.ap);
      if (a.hp + a.ap > 0 && lead(a) !== 0 && lead(b) !== 0 && lead(a) !== lead(b)) events.push(`LEAD CHANGE: ${team(b.hp > b.ap ? m.h : m.a)} now leads ${Math.max(b.hp, b.ap)} to ${Math.min(b.hp, b.ap)} (${label})`);
      // A swing with no points scored comes from lineup changes or injury news, not from the games
      const quiet = a.hp === b.hp && a.ap === b.ap;
      if (a.p != null && b.p != null && Math.abs(b.p - a.p) >= BIG_SWING) events.push(`SWING: ${team(m.h)}'s win chance went ${pct(a.p)} to ${pct(b.p)} (${label}, now ${b.hp} to ${b.ap}${quiet ? "; no points were scored since the last update, so this came from a lineup change or injury news, not a play" : ""})`);
    }
    const list = [];
    for (const id of [m.h, m.a]) for (const p of starters(id)) {
      const k = `${id}|${p.n}`, nowP = now.players[k];
      // Saves from before scoring plays were kept only have points: count his plays so far as already seen
      const old = before.players[k] == null ? [0, 0, 0, 0, 0, 0, 0] : Array.isArray(before.players[k]) ? before.players[k] : [before.players[k], ...nowP.slice(1)];
      const was = old[0], gain = Math.round((p.pts - was) * 10) / 10;
      const d = Object.fromEntries(PLAYS.map((q, i) => [q, Math.max(0, nowP[i + 1] - old[i + 1])]));
      const what = told(d, p.pos), status = p.g ? `, ${GAME[p.g]}` : "";
      if (d.ptd + d.rtd + d.ctd + d.dtd) events.push(`TOUCHDOWN: ${p.n} (${p.pos}, ${p.pro}) ${what}, +${gain} since the last update, ${p.pts} now${status}, for ${team(id)} (${label})`);
      else if (gain >= BIG_PLAY) events.push(`BIG PLAY: ${p.n} (${p.pos}, ${p.pro})${what ? ` ${what},` : ""} +${gain} since the last update, ${p.pts} now${status}, for ${team(id)} (${label})`);
      else if (d.to && p.pos !== "D/ST") events.push(`TURNOVER: ${p.n} (${p.pos}, ${p.pro}) ${what}, ${p.pts} now${status}, for ${team(id)} (${label})`);
      const x = (m.watch || []).find((w) => w.n === p.n && w.id === id);
      if (x && was < x.boomAt && p.pts >= x.boomAt) events.push(`GEAR 5: Bounty Board pick ${p.n} cleared his ${x.boomAt}-point line for ${team(id)}; that line was worth a ${x.boom}% win chance (${label})`);
      if (x && p.g === "done" && before.done && !before.done[k] && p.pts < x.bustAt) events.push(`SEASTONED: Bounty Board pick ${p.n}'s game is over and he finished with ${p.pts}, under his ${x.bustAt}-point line, for ${team(id)}; under that line his team's win chance was ${x.bust}% (${label})`);
      if (Math.abs(gain) >= 1 || tag(d)) list.push([id === m.h ? 0 : 1, p.n, gain, tag(d)]);
      // Injuries: hurt during his game (any new designation), or ruled out before it while still in the lineup.
      // Saves from before injuries were kept count every designation as already seen.
      const wasInj = before.inj ? before.inj[k] : p.inj;
      if (p.inj && p.inj !== wasInj) {
        if (p.g === "on" || (p.g === "done" && was !== p.pts)) { events.push(`INJURY: ${p.n} (${p.pos}, ${p.pro}) got hurt during his game and is now listed ${injured(p.inj)}, with ${p.pts} points so far, for ${team(id)} (${label})`); const mine = list.find((x) => x[1] === p.n && !x[3]); if (mine) mine[3] = "INJ"; else list.push([id === m.h ? 0 : 1, p.n, gain, "INJ"]); }
        else if (p.g === "pre" && ["OUT", "DOUBTFUL", "INJURY_RESERVE", "SUSPENSION"].includes(p.inj)) events.push(`INJURY NEWS: ${p.n} (${p.pos}, ${p.pro}) is now listed ${injured(p.inj)} before his game, and he's still in ${team(id)}'s starting lineup (${label})`);
      }
    }
    // The plays behind this update's point on the win chance chart
    if (list.length) plays[`${W}-${m.h}-${m.a}`] = list.sort((x, y) => !!y[3] - !!x[3] || Math.abs(y[2]) - Math.abs(x[2])).slice(0, 6);
  }
}
// Pinned to the point build.js just added to the win chance history (newer than the last update)
const HIST = path.join(__dirname, "history", `live_${cur.year}.json`);
if (!DRY && Object.keys(plays).length && fs.existsSync(HIST)) {
  const wp = JSON.parse(fs.readFileSync(HIST, "utf8"));
  let changed = false;
  for (const k in plays) { const pts = wp[k], last = pts && pts[pts.length - 1]; if (last && last[0] > (before.at || 0) && !last[4]) { last[4] = plays[k]; changed = true; } }
  if (changed) fs.writeFileSync(HIST, JSON.stringify(wp));
}
// A manager benching a player after promising GLSN he wouldn't
if (before && before.wk === W && fs.existsSync(path.join(NEWS, `final-${cur.year}-${W}.json`))) for (const q of QUOTES[`final-${cur.year}-${W}`] || [])
  if (now.benched.includes(q.starting) && !(before.benched || []).includes(q.starting))
    events.push(`BENCHED: ${q.manager} told GLSN "${q.quote}" when asked ${q.asked}, and has now benched ${q.starting} anyway`);
// Roster moves since the last update (the first run only takes note of them). Each one carries
// what the players have done this season, so the posts know a big pickup from a depth add.
const moveAt = {};
if (before && before.moves) {
  const seen = new Set(before.moves);
  const season = (n) => { let pts = 0, wks = 0; for (const w in cur.lineups) for (const id in cur.lineups[w]) for (const p of cur.lineups[w][id]) if (p.n === n) { pts += p.pts; wks++; } return wks ? `${Math.round(pts * 10) / 10} points in ${wks} weeks` : "no points yet this season"; };
  const fresh = cur.moves.filter((m) => !seen.has(`${m.date}|${m.tm}`)).sort((a, b) => (b.bid || 0) - (a.bid || 0));
  for (const m of fresh) {
    const list = (xs) => xs.map((x) => { const [n, pos] = x.split("|"); return `${n} (${pos}; ${season(n)})`; }).join(", ");
    const e = `MOVE: ${team(m.tm)} ${m.add.length ? `added ${list(m.add)}` : ""}${m.add.length && m.drop.length ? " and " : ""}${m.drop.length ? `dropped ${list(m.drop)}` : ""} (${m.kind.toLowerCase()}${m.bid ? `, $${m.bid} bid` : ""})`;
    events.push(e); moveAt[e] = m.date;
  }
}
// Injury news, games or not: a rostered player who matters to his team (a regular starter or one of its top three scorers)
// newly ruled out, doubtful, on IR or suspended, out for the season, his expected return moved, or back from an absence.
// Carries how much he matters and what's at stake, so the reaction fits:
// a star on IR in a playoff race sets off his team's fans, a role player out for a week barely registers.
const SEVERITY = { QUESTIONABLE: 1, DAY_TO_DAY: 1, DOUBTFUL: 2, OUT: 3, SUSPENSION: 3, INJURY_RESERVE: 4 };
if (before && before.rinj) {
  const odds = (id) => { const t = cur.odds && cur.odds.t && cur.odds.t[id]; return t ? t.p[t.p.length - 1] : null; };
  for (const [id, ps] of Object.entries(cur.rosters || {})) {
    const startedFor = (n) => { let pts = 0, starts = 0, wks = 0; for (const w in cur.lineups) { const e = ((cur.lineups[w] || {})[id] || []).find((q) => q.n === n); if (!e || +w >= W) continue; wks++; if (e.slot !== "BN" && e.slot !== "IR") { starts++; pts += e.pts; } } return { pts: Math.round(pts * 10) / 10, starts, wks }; };
    const ranked = ps.map((p) => ({ p, ...startedFor(p.n) })).sort((a, b) => b.pts - a.pts);
    ranked.forEach((r, i) => {
      const { p } = r, prev = before.rinj[`${id}|${p.n}`], [was, wasBack, wasSeason] = prev ? prev.split("|") : [];
      if (events.some((e) => e.includes(p.n)) || !(i < 3 || (r.wks && r.starts / r.wks >= 0.5))) return;
      const sev = SEVERITY[p.inj] || 0, wasSev = SEVERITY[was] || 0, t = cur.byId[id], left = cur.regWeeks - W, o = odds(id);
      const when = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
      // What changed: worse, a moved return date, ruled out for the season, or back from an absence
      let what = null;
      if (p.injSeason && !wasSeason) what = "has been ruled out for the season";
      else if (sev >= 2 && sev > wasSev) what = p.inj === "INJURY_RESERVE" ? `went on injured reserve, out at least four NFL weeks (${left > 0 ? `${left} regular-season week${left === 1 ? "" : "s"} left after this one` : "the playoffs are next"})` : `is now listed ${injured(p.inj)}`;
      else if (sev >= 2 && p.injBack && wasBack && p.injBack !== wasBack) what = p.injBack > wasBack ? `had a setback: his expected return moved from ${when(wasBack)} to ${when(p.injBack)}` : `is ahead of schedule: his expected return moved up from ${when(wasBack)} to ${when(p.injBack)}`;
      else if (sev >= 2 && p.injBack && !wasBack && wasSev >= 2) what = `now has an expected return date: ${when(p.injBack)}`;
      else if (wasSev >= 3 && sev <= 1) what = sev ? `is back from ${injured(was)} and now listed ${injured(p.inj)}, closer to a return` : `is healthy again after being ${injured(was)}, back in play`;
      if (!what) return;
      events.push(`INJURY NEWS: ${p.n} (${p.pos}, ${p.pro}) ${what}${p.injBack && !p.injSeason && !/expected return/.test(what) ? `, expected back around ${when(p.injBack)}` : ""}${p.injNote ? ` (ESPN: ${p.injNote})` : ""}. For ${team(+id)} he's ${i === 0 ? "the top scorer" : `${i + 1}${["", "st", "nd", "rd"][i + 1] || "th"} in scoring`} with ${r.pts} points in ${r.starts} starts; the team is ${t.w}-${t.l}${o != null ? ` with ${Math.round(o)}% playoff odds` : ""}`);
    });
  }
}
// Most important first, and at most 10 per update: finals, lead changes, touchdowns, injuries, swings, the Bounty Board's Gear 5s and Seastoneds, the biggest plays, turnovers, then moves
const ORDER = ["FINAL", "LEAD CHANGE", "TOUCHDOWN", "INJURY", "BENCHED", "SWING", "GEAR 5", "SEASTONED", "BIG PLAY", "TURNOVER", "MOVE"];
const gain = (e) => +((e.match(/\+([\d.]+)/) || [])[1] || 0);
events.sort((a, b) => ORDER.findIndex((k) => a.startsWith(k)) - ORDER.findIndex((k) => b.startsWith(k)) || gain(b) - gain(a)).splice(10);
if (!events.length) { console.log(before && before.wk === W ? "Nothing new since the last update." : "First snapshot saved."); save(); process.exit(0); }
// Award namesakes on the timeline: now and then (about one batch in three, at most two a day, checked below) the namesake
// of a position award reacts when a player in its race (top three so far) makes a play, the way legends chime in
const POS_AWARD = { QB: "nami", RB: "sanji", WR: "zoro", TE: "franky", K: "usopp", "D/ST": "jinbe" };
let cameo = null;
if (Math.random() < 1 / 3) { const races = awardRaces(cur.year), cands = [];
  events.forEach((e, i) => { const m = e.match(/^(TOUCHDOWN|BIG PLAY|TURNOVER): (.+?) \((QB|RB|WR|TE|K|D\/ST), /); if (!m) return;
    const k = POS_AWARD[m[3]], race = races[k] || [], rank = race.findIndex((r) => r.startsWith(`${m[2]} (`) || r.startsWith(`${m[2]}:`));
    if (rank >= 0) cands.push({ k, i, rank, player: m[2] }); });
  const c = cands.sort((a, b) => a.rank - b.rank)[0];
  if (c) cameo = { ...c, who: NAMESAKES[c.k], award: NAMESAKE_AWARD[c.k], race: races[c.k] }; }
console.log(`${events.length} live events:\n${events.join("\n")}`);
if (cameo) console.log(`Namesake cameo: ${cameo.who.name} on ${cameo.player} (event ${cameo.i + 1})`);
if (DRY) process.exit(0);

const feed = fs.existsSync(FEED) ? JSON.parse(fs.readFileSync(FEED, "utf8")) : { id: `live-${cur.year}-${W}`, type: "live", year: cur.year, wk: W, created: new Date().toISOString(), title: `Week ${W} Live`, dek: "", body: [], social: [], batches: [] };
const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
if (cameo) { const hs = new Set(Object.values(NAMESAKES).map((x) => x.handle));
  if (feed.social.filter((p) => hs.has(p.handle) && new Date(p.at).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === today).length >= 2) cameo = null; }
if (feed.batches.filter((b) => new Date(b).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === today).length >= MAX_BATCHES_PER_DAY) { console.log("Daily cap on live posts reached; skipping."); save(); process.exit(0); }
if (feed.batches.filter((b) => Date.now() - new Date(b).getTime() < 3600e3).length >= MAX_BATCHES_PER_HOUR) { console.log("Hourly cap on live posts reached; skipping."); save(); process.exit(0); }
if (!process.env.ANTHROPIC_API_KEY || !LORE) { console.log("No API key or lore; skipping live posts."); save(); process.exit(0); }

const POSTS = { type: "object", additionalProperties: false, required: ["posts"], properties: { posts: { type: "array", items: { ...SOCIAL.items,
  required: SOCIAL.items.required.filter((k) => k !== "when").concat("minutes_ago"),
  properties: { ...Object.fromEntries(Object.entries(SOCIAL.items.properties).filter(([k]) => k !== "when")), minutes_ago: { type: "integer" }, event: { type: "integer" } } } } } };
POSTS.properties.posts.items.required.push("event");
const scoreboard = games.map((m) => `${team(m.h)} ${m.hp} vs ${team(m.a)} ${m.ap}${m.win != null ? " (final)" : m.psim != null ? `, ${nameAt(cur.byId[m.h], W)} win chance ${pct(m.psim)}` : ""}`);
// Every starter's game status, so a post never waits on a player who already played (or cheers one who hasn't)
const where = (id) => { const by = { done: [], on: [], pre: [] }; for (const p of starters(id)) if (p.g) by[p.g].push(`${p.n}${p.g === "pre" ? "" : ` ${p.pts}`}${p.inj ? ` (${injured(p.inj)})` : ""}`);
  return `${team(id)}: ${Object.entries(by).filter(([, xs]) => xs.length).map(([g, xs]) => `${GAME[g]}: ${xs.join(", ")}`).join("; ")}`; };
const lineups = starters(games[0] ? games[0].h : 0).some((p) => p.g) ? games.flatMap((m) => [m.h, m.a]).map(where) : [];
const clock = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", hour: "numeric", minute: "2-digit" });
const ask = `It's week ${W}, ${clock} ET. Write 2 to 4 social posts reacting to what just happened around the league, the way the timeline does: fans of the teams involved (celebrating, panicking, raging), a GLSN staffer with a quick take (Haredas on how the win chances just swung, Shakky on a lock going up in smoke, Absalom on a roster move, Pandaman from the stands), GLSN's own account for a final or a 🚨 big moment, maybe a team's official account after a big play, a final or a pickup ("welcome to the squad"). React to the play itself, the way people do when it happens: name the touchdown, the interception or the final and what it does to their matchup, and say it the way a real person in a group chat or on the timeline would, in their own voice. Vary it: some fans are hyped, some deadpan, some bitter, some just relieved; avoid stock hype phrases, catchphrases and forced slang, and don't open several posts the same way. Talk about players and what they did, never in stat-line shorthand like "+8.4". INJURY NEWS between games is about how much he matters: a team's best player on IR or out for the season in a playoff race sets off that fanbase (melodramatic despair: the season's over, deleting the app, begging the manager for a trade, blaming the injury-prone pick; never self-harm jokes) while rivals smell blood, and those posts can run hot; a role player ruled out for a week gets a shrug or nothing. A setback on his return date is a fresh gut punch, while an earlier return or a star coming back off IR is a revival: hope, I-never-doubted-him posts, rivals nervous. A player getting hurt gets the real mix: worry, lineup panic, and gallows humor about the fantasy fallout (the manager's luck, a curse, the bench guy who now has to save the week), the way fans actually react; aim the jokes at the fantasy side, not at how badly he's hurt. Only a numbers person (Dr. Nina Kessler, or a stats account) cites win chances. A depth add or a drop of a nobody gets a post only if there's a joke in it; a big bid, a big name dropped, or a pickup that fills a hole is worth talking about. Keep each post short, one or two sentences, and react to these events only; use the scores and game statuses as context. Mind the clock and each player's status: a player whose game is over has played (don't say he's due, or still to come), and one yet to play hasn't. event is the number of the event a post reacts to; minutes_ago is how long ago it was posted, from 0 to 14.

Events since the last update:
${events.map((e, i) => `${i + 1}. ${e}`).join("\n")}

Scoreboard now:
${scoreboard.join("\n")}
${lineups.length ? `\nStarters by game status:\n${lineups.join("\n")}\n` : ""}${(() => { const x = missingStars(cur, W); return x.length ? `\nStars teams are playing without (background, not news: now and then, not every time, a fan can miss one, mostly when his team is struggling or the guy filling in flops; yearning, nostalgia, counting the days to his return, an old highlight):\n${x.join("\n")}\n` : ""; })()}
${cameo ? `\nOne of the posts comes from an award's namesake: ${cameo.who.name} (${cameo.who.handle}, kind pundit, heat 2 to 5), the namesake of the ${cameo.award} award, reacting to event ${cameo.i + 1} because ${cameo.player} is in the race for it (${cameo.race.join("; ")}). In character (${cameo.who.style}), a short reaction the way a legend chimes in on someone chasing his award; a parody that never quotes the series.\n` : ""}Recent live posts, so you don't repeat them:
${JSON.stringify(feed.social.slice(-10).map((p) => `${p.author}: ${p.text}`))}`;

(async () => {
  const client = new Anthropic();
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if a safety check declines, Anthropic retries on its recommended fallback model
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: POSTS } },
      messages: [{ role: "user", content: ask }],
    });
    if (res.stop_reason !== "end_turn") { console.log(`::warning::Live posts: stopped (${res.stop_reason}), skipping`); save(); return; }
    const out = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    const t = Date.now();
    // Posts about a roster move go up shortly after the move itself; the rest within the last 15 minutes
    const when = (p) => { const m = moveAt[events[p.event - 1]], ago = Math.min(14, Math.max(0, p.minutes_ago)); return m ? Math.min(t, m + (3 + (14 - ago) * 4) * 60e3) : t - ago * 60e3; };
    feed.social.push(...out.posts.map(({ minutes_ago, event, ...p }) => ({ ...p, about: (events[event - 1] || "").startsWith("MOVE") ? "move" : "game", at: new Date(when({ minutes_ago, event })).toISOString() })));
    feed.batches.push(new Date(t).toISOString());
    // Token use per call, cached input included, for working out what live posts cost
    (feed.usage = feed.usage || []).push({ at: new Date(t).toISOString(), model: res.model, ...{ input: res.usage.input_tokens, output: res.usage.output_tokens, cache_write: res.usage.cache_creation_input_tokens || 0, cache_read: res.usage.cache_read_input_tokens || 0 } });
    fs.mkdirSync(NEWS, { recursive: true });
    fs.writeFileSync(FEED, JSON.stringify(feed, null, 1));
    console.log(`${out.posts.length} live posts (${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.log(`::warning::Live posts: API error ${err.status}: ${err.message}`);
    else throw err;
  }
  save();
})();
