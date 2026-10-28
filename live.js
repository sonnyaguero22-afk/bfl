// Live social posts during games. Each update compares this week's scores, win chances and
// players' points with the last update (history/livestate_<year>.json), and when something
// happened (a big play, a lead change, a big swing, a Ones to Watch player clearing his line, a
// final) asks Claude for a few posts reacting to it, saved to news/live-<year>-<week>.json.
// Runs in GitHub Actions after build.js; quiet updates make no API call.
// Usage: node live.js            (post if anything happened)
//        node live.js --dry-run  (print the events; no API calls, nothing saved)
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { S, SYSTEM, SOCIAL, LORE, NEWS, who, nameAt } = require("./news");

const MODEL = "claude-sonnet-5-5"; // short posts, many times a game day; the articles stay on Opus
const MAX_BATCHES_PER_DAY = 15;    // keeps a wild Sunday's cost predictable
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

// What the scoreboard looks like right now
const starters = (id) => ((cur.lineups[W] || {})[id] || []).filter((p) => p.slot !== "BN" && p.slot !== "IR");
const now = {
  wk: W,
  games: Object.fromEntries(games.map((m) => [`${m.h}-${m.a}`, { hp: m.hp, ap: m.ap, p: m.psim, win: m.win }])),
  players: Object.fromEntries(games.flatMap((m) => [m.h, m.a]).flatMap((id) => starters(id).map((p) => [`${id}|${p.n}`, p.pts]))),
};
const before = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null;
const save = () => { if (!DRY) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(now)); } };

// What changed since the last update
const events = [];
if (before && before.wk === W) {
  for (const m of games) {
    const k = `${m.h}-${m.a}`, a = before.games[k], b = now.games[k];
    if (!a || !b) continue;
    const label = `${team(m.h)} vs ${team(m.a)}`;
    if (b.win != null && a.win == null) events.push(`FINAL: ${team(b.win === 0 ? m.h : b.win)} ${b.win === 0 ? "tied" : "won"}, ${Math.max(b.hp, b.ap)} to ${Math.min(b.hp, b.ap)} (${label})`);
    else {
      const lead = (g) => Math.sign(g.hp - g.ap);
      if (a.hp + a.ap > 0 && lead(a) !== 0 && lead(b) !== 0 && lead(a) !== lead(b)) events.push(`LEAD CHANGE: ${team(b.hp > b.ap ? m.h : m.a)} now leads ${Math.max(b.hp, b.ap)} to ${Math.min(b.hp, b.ap)} (${label})`);
      if (a.p != null && b.p != null && Math.abs(b.p - a.p) >= BIG_SWING) events.push(`SWING: ${team(m.h)}'s win chance went ${pct(a.p)} to ${pct(b.p)} (${label}, now ${b.hp} to ${b.ap})`);
    }
    for (const id of [m.h, m.a]) for (const p of starters(id)) {
      const was = before.players[`${id}|${p.n}`] ?? 0, gain = p.pts - was;
      if (gain >= BIG_PLAY) events.push(`BIG PLAY: ${p.n} (${p.pos}, ${p.pro}) +${Math.round(gain * 10) / 10}, now ${p.pts}, for ${team(id)} (${label})`);
      const x = (m.watch || []).find((w) => w.n === p.n && w.id === id);
      if (x && was < x.boomAt && p.pts >= x.boomAt) events.push(`ONE TO WATCH HIT: ${p.n} cleared his ${x.boomAt}-point line for ${team(id)}; that line was worth a ${x.boom}% win chance (${label})`);
    }
  }
}
// Most important first, and at most 10 per update: finals, lead changes, swings, Ones to Watch, then the biggest plays
const ORDER = ["FINAL", "LEAD CHANGE", "SWING", "ONE TO WATCH", "BIG PLAY"];
const gain = (e) => +((e.match(/\+([\d.]+)/) || [])[1] || 0);
events.sort((a, b) => ORDER.findIndex((k) => a.startsWith(k)) - ORDER.findIndex((k) => b.startsWith(k)) || gain(b) - gain(a)).splice(10);
if (!events.length) { console.log(before && before.wk === W ? "Nothing new since the last update." : "First snapshot of the week saved."); save(); process.exit(0); }
console.log(`${events.length} live events:\n${events.join("\n")}`);
if (DRY) process.exit(0);

const feed = fs.existsSync(FEED) ? JSON.parse(fs.readFileSync(FEED, "utf8")) : { id: `live-${cur.year}-${W}`, type: "live", year: cur.year, wk: W, created: new Date().toISOString(), title: `Week ${W} Live`, dek: "", body: [], social: [], batches: [] };
const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
if (feed.batches.filter((b) => new Date(b).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === today).length >= MAX_BATCHES_PER_DAY) { console.log("Daily cap on live posts reached; skipping."); save(); process.exit(0); }
if (!process.env.ANTHROPIC_API_KEY || !LORE) { console.log("No API key or lore; skipping live posts."); save(); process.exit(0); }

const POSTS = { type: "object", additionalProperties: false, required: ["posts"], properties: { posts: { type: "array", items: { ...SOCIAL.items,
  required: SOCIAL.items.required.filter((k) => k !== "when").concat("minutes_ago"),
  properties: { ...Object.fromEntries(Object.entries(SOCIAL.items.properties).filter(([k]) => k !== "when")), minutes_ago: { type: "integer" } } } } } };
const scoreboard = games.map((m) => `${team(m.h)} ${m.hp} vs ${team(m.a)} ${m.ap}${m.win != null ? " (final)" : m.psim != null ? `, ${nameAt(cur.byId[m.h], W)} win chance ${pct(m.psim)}` : ""}`);
const ask = `It's game day in week ${W}. Write 2 to 4 live social posts reacting to what just happened, the way the timeline reacts during games: fans of the teams involved (celebrating, panicking, raging), a pundit or panelist with a quick take, maybe a team's official account after a big play or a final. Keep each post short, one or two sentences, and react to these events only; use the scores as context. minutes_ago is how long ago it was posted, from 0 to 14.

Events since the last update:
${events.join("\n")}

Scoreboard now:
${scoreboard.join("\n")}

Recent live posts, so you don't repeat them:
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
    feed.social.push(...out.posts.map(({ minutes_ago, ...p }) => ({ ...p, at: new Date(t - Math.min(14, Math.max(0, minutes_ago)) * 60e3).toISOString() })));
    feed.batches.push(new Date(t).toISOString());
    fs.mkdirSync(NEWS, { recursive: true });
    fs.writeFileSync(FEED, JSON.stringify(feed, null, 1));
    console.log(`${out.posts.length} live posts (${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.log(`::warning::Live posts: API error ${err.status}: ${err.message}`);
    else throw err;
  }
  save();
})();
