// Writes league news with Claude: a recap after every finished week (with fan/pundit social
// posts and fresh team bios), a reaction to every trade, and a look back at each finished season.
// Each article is saved once in news/ and never rewritten.
// Runs in GitHub Actions after build.js; does nothing without ANTHROPIC_API_KEY.
// Usage: node news.js            (write what's missing)
//        node news.js --dry-run  (print the facts that would be sent; no API calls)
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5-5";
const MAX_PER_RUN = 12; // keeps any one run's cost predictable; the rest are written next run
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
  return Phi(((s.odds.t[m.h].str[i] - s.odds.t[m.a].str[i]) * len) / ((s.odds.sd || 20) * Math.sqrt(2 * len)));
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
    const row = { player: `${p.n} (${p.pos}, ${p.pro})`, team: who(s.byId[id], W), points: p.pts, projected: p.proj };
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
  return {
    season: s.year, buckaroo_bowl_number: s.year - D.firstYear + 1, week: W, regular_season_weeks: s.regWeeks, playoff_teams: s.playoffTeams,
    games, top_performances: starts.sort((a, b) => b.points - a.points).slice(0, 6),
    biggest_busts: starts.filter((x) => x.projected != null).sort((a, b) => (a.points - a.projected) - (b.points - b.projected)).slice(0, 3),
    bench_blunders: bench.sort((a, b) => b.points - a.points).slice(0, 3),
    standings_after_week: standings, roster_moves_this_week: moves, trades, next_week_matchups: next,
    records_before_this_week: Object.fromEntries(s.teams.map((t) => [who(t, W), `${recBefore[t.id].w}-${recBefore[t.id].l}`])),
  };
}
function tradeFacts(s, tr) {
  const pointsFor = (n) => { let pts = 0, gp = 0; for (const wk in s.lineups) for (const id in s.lineups[wk]) for (const p of s.lineups[wk][id]) if (p.n === n && +wk < tr.wk) { pts += p.pts; gp++; } return { season_points_before_trade: r1(pts), weeks_on_a_roster: gp }; };
  return {
    season: s.year, happened_before_week: tr.wk,
    sides: tr.teams.map((id) => ({
      team: who(s.byId[id], tr.wk),
      received: (tr.got[id] || []).map((x) => { const [n, pos] = x.split("|"); return { player: n, position: pos, ...pointsFor(n) }; }),
      title_odds_before: oddsAt(s, tr.wk - 1, id) == null ? null : `${Math.round(oddsAt(s, tr.wk - 1, id))}%`,
      title_odds_after: oddsAt(s, tr.wk, id) == null ? null : `${Math.round(oddsAt(s, tr.wk, id))}%`,
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

// ---------- League background (same for every request, so it caches) ----------
function leagueBackground() {
  const champs = D.seasons.filter((s) => s.done).map((s) => { const t = s.teams.find((x) => x.final === 1), l = s.teams.find((x) => x.final === s.teams.length); return `Buckaroo Bowl ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII"][s.year - D.firstYear] || s.year - D.firstYear + 1} (${s.year}): champion ${who(t, 99)}; last place ${who(l, 99)}.`; });
  const cur = D.seasons[D.seasons.length - 1];
  const teams = cur.teams.map((t) => `${t.name} = ${mgr(t.mgr)}`).join("; ");
  const notes = D.seasons.flatMap((s) => (s.notes || []).map((n) => `${s.year}: ${n}`));
  return [
    `The Buckaroo Football League is a fantasy football league among friends on ESPN, founded in ${D.firstYear}. It had 6 teams through 2025 and 8 teams from 2026. The championship is the Buckaroo Bowl, numbered with Roman numerals from Bowl I in ${D.firstYear}. Last place is decided by a consolation ladder.`,
    `Past results: ${champs.join(" ")}`,
    `Current teams (${cur.year}): ${teams}.`,
    notes.length ? `League notes: ${notes.join(" ")}` : "",
  ].filter(Boolean).join("\n");
}
const SYSTEM = `You are the newsroom of the Buckaroo Football League: its beat writer and its social media desk. Your stories appear on the league's website, which the league's managers and their friends read.

Voice: a sharp, funny sports columnist covering a league of friends. Lovingly roast the managers' decisions, celebrate big performances, build up rivalries and storylines, and treat the Buckaroo Bowl like the Super Bowl. Keep it PG-13 and good-natured; the jokes are about fantasy football, never about anyone's life outside it.

Rules:
- Use only the facts provided. Never invent scores, stats, injuries, trades, quotes from managers, or events. You may interpret and speculate about what the numbers mean.
- Refer to managers by first name and to teams by their exact names as given. A "(name)" after a team is its manager.
- Never mention where anyone lives, works, studies, or serves, even if you think you know.
- Social posts come from fictional accounts only: made-up fans, team fan clubs, pundits, and "insiders". Never write as, or tag, real NFL players, journalists, or celebrities.
- Plain text only, no markdown. Body paragraphs should be 2 to 5 sentences each.

League background:
${leagueBackground()}`;

// ---------- Output shapes ----------
const str = { type: "string" };
const SOCIAL = { type: "array", items: { type: "object", additionalProperties: false, required: ["author", "handle", "text"], properties: { author: str, handle: str, text: str } } };
const ARTICLE = { title: str, dek: str, body: { type: "array", items: str } };
const schemas = {
  recap: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social", "bios"], properties: { ...ARTICLE, social: SOCIAL,
    bios: { type: "array", items: { type: "object", additionalProperties: false, required: ["team", "bio"], properties: { team: str, bio: str } } } } },
  trade: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social"], properties: { ...ARTICLE, social: SOCIAL } },
  review: { type: "object", additionalProperties: false, required: ["title", "dek", "body"], properties: ARTICLE },
};
const asks = {
  recap: "Write the weekly recap for this week of the Buckaroo Football League: a headline, a one-sentence dek, and 5 to 8 body paragraphs covering the results (lead with the best storyline), standout and disappointing performances, the standings and title-odds picture, notable moves, and a look ahead to next week. Then write 6 to 10 social posts reacting to the week, and a fresh 2 to 3 sentence bio for every team in the standings that sums up where its season stands right now (use the exact team name in the team field).",
  trade: "Write a trade reaction story: a headline, a one-sentence dek, and 3 to 5 body paragraphs explaining the deal, what each side got, and who won it on paper (use the title odds change). Then write 3 to 5 social posts reacting to it.",
  review: "Write a season-in-review story for this finished season: a headline, a one-sentence dek, and 5 to 7 body paragraphs telling the story of the season from draft to Buckaroo Bowl, including the champion, the last-place finisher, the playoff games, and any notable notes.",
};

// ---------- What still needs writing ----------
function pending() {
  const have = new Set(fs.existsSync(NEWS) ? fs.readdirSync(NEWS).map((f) => f.replace(/\.json$/, "")) : []);
  const todo = [];
  for (const s of D.seasons.filter((x) => x.done)) if (!have.has(`review-${s.year}`)) todo.push({ id: `review-${s.year}`, type: "review", s, wk: 99, facts: () => reviewFacts(s) });
  const cur = D.seasons.filter((x) => !x.done).slice(-1)[0] || null;
  if (cur) {
    const weeks = [...new Set(cur.matchups.map((m) => m.wk))].sort((a, b) => a - b);
    for (const W of weeks) {
      const ms = cur.matchups.filter((m) => m.wk === W);
      if (!ms.length || !ms.every(done)) break;
      if (!have.has(`recap-${cur.year}-${W}`)) todo.push({ id: `recap-${cur.year}-${W}`, type: "recap", s: cur, wk: W, facts: () => recapFacts(cur, W) });
    }
    for (const tr of cur.trades) { const id = `trade-${cur.year}-${tr.wk}-${[...tr.teams].sort((a, b) => a - b).join("-")}`; if (!have.has(id)) todo.push({ id, type: "trade", s: cur, wk: tr.wk - 0.5, tr, facts: () => tradeFacts(cur, tr) }); }
  }
  // Oldest news first, so the archive reads in order
  return todo.sort((a, b) => a.s.year - b.s.year || a.wk - b.wk);
}

async function write(client, job) {
  const facts = job.facts();
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a safety check declines, Anthropic retries on its recommended fallback model
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: schemas[job.type] } },
    messages: [{ role: "user", content: `${asks[job.type]}\n\nFacts (JSON):\n${JSON.stringify(facts)}` }],
  });
  if (res.stop_reason === "refusal") { console.log(`${job.id}: declined (${res.stop_details && res.stop_details.category}), skipping`); return null; }
  if (res.stop_reason === "max_tokens") { console.log(`${job.id}: ran out of room, will retry next run`); return null; }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let out;
  try { out = JSON.parse(text); } catch { console.log(`${job.id}: response wasn't valid JSON, will retry next run`); return null; }
  // Bios name teams as written in the facts ("Name (Manager)"); match on the team-name part
  const teamFor = (label) => job.s.teams.find((t) => label === nameAt(t, job.wk) || label.startsWith(nameAt(t, job.wk) + " ("));
  return {
    id: job.id, type: job.type, year: job.s.year, wk: job.type === "review" ? null : Math.ceil(job.wk), created: new Date().toISOString(),
    title: out.title, dek: out.dek, body: out.body, social: out.social || [], teams: job.tr ? job.tr.teams : [],
    bios: out.bios ? Object.fromEntries(out.bios.map((b) => [(teamFor(b.team) || {}).id, b.bio]).filter(([id]) => id != null)) : undefined,
    model: res.model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  };
}

(async () => {
  const todo = pending();
  if (!todo.length) { console.log("News is up to date."); return; }
  console.log(`${todo.length} stories to write: ${todo.map((j) => j.id).join(", ")}`);
  if (DRY) { for (const j of [todo[0], todo[todo.length - 1]]) console.log(`\n--- ${j.id} ---\n${JSON.stringify(j.facts(), null, 1).slice(0, 3000)}`); console.log(`\nSystem prompt:\n${SYSTEM}`); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("No ANTHROPIC_API_KEY set, skipping news."); return; }
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
      if (err instanceof Anthropic.APIError) { console.log(`${job.id}: API error ${err.status}: ${err.message}`); continue; }
      throw err;
    }
  }
})();
