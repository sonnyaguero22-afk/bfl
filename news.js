// Writes league news with Claude: draft-day coverage of each season's draft, a recap after every finished week (with fan/pundit social
// posts, fresh team bios and quick takes on how earlier trades are aging), a preview before each week's first game and a short
// Sunday-morning final word, a reaction to every trade, and a look back at each finished season.
// Each article is saved once in news/ and never rewritten.
// Stories that fail are logged as ::warning:: lines so they show on the run's summary page.
// Runs in GitHub Actions after build.js; does nothing without ANTHROPIC_API_KEY.
// Usage: node news.js            (write what's missing)
//        node news.js --dry-run  (print the facts that would be sent; no API calls)
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { published, natural, etLabel } = require("./when");

const MODEL = "claude-opus-5-5";
const MODELS = { final: "claude-sonnet-5-5" }; // short and fact-driven, so the cheaper model
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
// Guest stars: parody versions of One Piece characters who join the panel now and then, written in their style and never
// quoting the series. "crew" guests take regular-season slots; "legend" guests come only in the playoffs and the Bowl.
// Their picks are graded and shown, but they stay out of Panel Standings and the berry bets.
const GUESTS = [
  { name: "Roronoa Zoro", handle: "@ZoroGotLost", tier: "crew", role: "Guest", epithet: "the Straw Hats' swordsman", style: "deadpan, supremely confident and hopelessly lost: shows up to the wrong game, mixes up which team is which, insists he meant to, and still makes picks; respects whoever plays tough" },
  { name: "Nami", handle: "@NamiCharts", tier: "crew", role: "Guest", epithet: "the Straw Hats' navigator", style: "sharp and money-minded: reads the forecast and the berry odds, knows what every pick pays, loves an underdog at a good price and scolds the others' sloppy bets" },
  { name: "Usopp", handle: "@CaptainUsopp", tier: "crew", role: "Guest", epithet: "the Straw Hats' sniper", style: "a proud teller of tall tales: swears he predicted every upset, invents ridiculous backstories for his picks, panics when one goes wrong, but has a real eye for the long shot" },
  { name: "Sanji", handle: "@SanjiKicks", tier: "crew", role: "Guest", epithet: "the Straw Hats' cook", style: "a dramatic chef who judges lineups like dishes: talks recipes and what a roster is missing, trusts running backs and big legs" },
  { name: "Tony Tony Chopper", handle: "@DrChopper", tier: "crew", role: "Guest", epithet: "the Straw Hats' doctor", style: "sweet and earnest: reads every injury report, worries about every questionable tag, gets flustered when complimented on a good pick" },
  { name: "Brook", handle: "@SoulKingBrook", tier: "crew", role: "Guest", epithet: "the Straw Hats' musician", style: "a polite, ancient gentleman: picks by the rhythm of a team's season and makes bone and skeleton jokes about himself" },
  { name: "Franky", handle: "@FrankySuper", tier: "crew", role: "Guest", epithet: "the Straw Hats' shipwright", style: "a loud, flamboyant builder: judges rosters like ships, loves a well-built tight end, calls everything he likes super" },
  { name: "Bartolomeo", handle: "@BartoFanClub", tier: "crew", role: "Guest", epithet: "the most devoted superfan on the seas", style: "an overwhelming superfan who weeps with joy over teams he admires, picks with his whole heart and trash-talks anyone who doubts his favorites" },
  { name: "Koby", handle: "@KobyMarines", tier: "crew", role: "Guest", epithet: "the earnest young marine", style: "polite, hardworking and nervous: studies every matchup like an exam, believes in the underdog who keeps grinding" },
  { name: "Smoker", handle: "@WhiteHunter", tier: "crew", role: "Guest", epithet: "the grumpy marine captain", style: "gruff, terse and suspicious: distrusts flashy teams and lucky streaks, picks the side that does its job, few words" },
  { name: "Perona", handle: "@NegativePerona", tier: "crew", role: "Guest", epithet: "the ghost princess", style: "theatrically negative: tells every team why it's doomed, picks whoever she finds cutest, and is delighted when a favorite collapses" },
  { name: "Trafalgar Law", handle: "@SurgeonOfDeath", tier: "crew", role: "Guest", epithet: "the cold strategist", style: "cool, clipped and calculating: treats every game as an operation, picks the team with the better plan, never shows excitement" },
  { name: "Boa Hancock", handle: "@PirateEmpress", tier: "crew", role: "Guest", epithet: "the Pirate Empress", style: "haughty and dismissive of everyone, sure she's above the whole league, yet weirdly fixated on one team she's decided is worthy" },
  { name: "Buggy", handle: "@CaptainBuggy", tier: "crew", role: "Guest", epithet: "the flashy clown captain", style: "a loud, vain clown who takes credit for every right pick and blames everyone else for every wrong one; picks the flashy favorite, indignant if anyone mentions his nose" },
  { name: "Shanks", handle: "@RedHairShanks", tier: "legend", role: "Special Guest", epithet: "the red-haired emperor", style: "relaxed, warm and unshakably calm; sees the whole board, raises a drink to both teams, and his rare serious line lands hard" },
  { name: "Whitebeard", handle: "@Edward_Newgate", tier: "legend", role: "Special Guest", epithet: "the strongest man in the world", style: "booming and fatherly: calls every manager his son, respects loyalty above all, picks the team that protects its own" },
  { name: "Monkey D. Garp", handle: "@FistOfGarp", tier: "legend", role: "Special Guest", epithet: "the hero of the Marines", style: "a loud, laughing old hero who wanders off mid-take, eats snacks on air, and settles every pick with a fist of love" },
  { name: "Dracule Mihawk", handle: "@HawkEyes", tier: "legend", role: "Special Guest", epithet: "the world's greatest swordsman", style: "bored, aloof and precise: barely interested, cuts each game down to one cold sentence, has never been wrong and says so" },
  { name: "Kizaru", handle: "@Kizaru_Borsalino", tier: "legend", role: "Special Guest", epithet: "the lazy admiral", style: "slow, drawling and unbothered: marvels at how scary everything is while picking with unsettling speed" },
  { name: "Big Mom", handle: "@BigMomTea", tier: "legend", role: "Special Guest", epithet: "the emperor of sweets", style: "imperious and food-obsessed: demands tribute, rates teams like desserts, and threatens anyone whose pick disappoints her" },
];
// This week's guest: a crew guest every third regular-season week (2, 5, 8, 11, 14), a legend every playoff week.
// Each season shuffles both lists (seeded by the year), so the order changes and nobody repeats within a season.
const guestWeek = (W, reg) => W > reg || W % 3 === 2;
const guestOrder = (tier, year) => { let x = year * 7919 + (tier === "legend" ? 17 : 3); const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return GUESTS.filter((g) => g.tier === tier).map((g) => [rnd(), g]).sort((a, b) => a[0] - b[0]).map((p) => p[1]); };
const guestFor = (s, W) => { if (!guestWeek(W, s.regWeeks)) return null;
  if (W > s.regWeeks) { const L = guestOrder("legend", s.year); return L[(W - s.regWeeks - 1) % L.length]; }
  const C = guestOrder("crew", s.year); let n = 0; for (let w = 1; w < W; w++) if (guestWeek(w, s.regWeeks)) n++;
  return C[n % C.length]; };
// GLSN, the Grand Line Sports Network: the league's (made-up) sports network. Its staff are parody versions of minor
// One Piece characters, written in their style, never quoting the series. Keep names and handles fixed.
const STAFF = [
  { name: "Absalom", handle: "@AbsalomScoops", role: "Insider", beat: "trades, vetoes and scoops", voice: "smooth, slightly creepy insider who can turn invisible, so he's always in the room; terse 'sources' scoops with a hint of smugness about how he knows" },
  { name: "Morgans", handle: "@BigNewsMorgans", role: "Editor-in-chief", beat: "season reviews, report cards and league history", voice: "flamboyant newspaper-mogul albatross who lives for BIG NEWS; grand pronouncements, historical framing, a weakness for a dramatic headline" },
  { name: "Haredas", handle: "@HaredasForecast", role: "Forecaster", beat: "previews, forecasts and the Sunday final word", voice: "elderly weather scientist from Weatheria who forecasts games like weather (a 70% chance of Habibsters); patient, precise, explains the numbers" },
  { name: "Pandaman", handle: "@PandamanSeesAll", role: "Correspondent", beat: "weekly recaps", voice: "somehow in every crowd shot and at every game; earnest eyewitness color, the details only someone in the stands would notice" },
  { name: "Duval", handle: "@DuvalRanks", role: "Power rankings", beat: "the power rankings", voice: "vain, theatrical ex-bandit who treats the rankings like a beauty pageant; dramatic about every rise and fall" },
  { name: "Gaimon", handle: "@GaimonDigs", role: "Draft analyst", beat: "draft night", voice: "spent twenty years guarding treasure chests on a tiny island; the draft is a treasure hunt to him, and he's suspicious of empty chests" },
];
const GLSN = { name: "GLSN", handle: "@GLSN" };
// Whose byline each story type runs under
const BYLINE = { recap: "Pandaman", rankings: "Duval", preview: "Haredas", final: "Haredas", trade: "Absalom", veto: "Absalom", draft: "Gaimon",
  grades: "Morgans", card: "Morgans", review: "Morgans", regseason: "Morgans", team: "Morgans", playoffs: "Haredas", ladder: "Haredas", history: "Morgans", profile: "Morgans", bowl: "Morgans", class: "Morgans" };
// The preview panel: four GLSN pundits who pick games (the writers above don't sit on it). The seats were held by Dana Whitfield, Marcus Pell, Sal Benedetto and Dr. Nina
// Kessler before GLSN took over (2026, week 12); a seat's season record and berries carry over to whoever holds it now.
const PANEL = [
  { name: "Brannew", handle: "@BrannewBriefing", role: "Insider", style: "the intel officer who briefs everyone; leans on lineup moves, injuries, byes and what his sources are telling him; measured and procedural, rarely raises his voice. Locks a game now and then when his intel makes it look settled, even against the numbers" },
  { name: "Crocus", handle: "@CrocusLighthouse", role: "Columnist", style: "grumpy old lighthouse keeper who has watched every crew pass; narratives, rivalries and history, and he's seen it all before; loves a contrarian pick and a big sentence. Every so often slams a lock on a gut call or an old grudge, sometimes on the underdog, and makes a show of it" },
  { name: "Shakky", handle: "@ShakkysBar", role: "The Gambler", style: "sets the lines at her rip-off bar; cool and unbothered, all-in on her locks, locks more games than anyone, holds grudges against teams that burned her, never admits a bad call. Even Shakky drops to 'confident' on a game that scares her, and admits it in her own way" },
  { name: "Professor Clover", handle: "@ProfClover", role: "Analytics", style: "the Ohara scholar who trusts evidence; cites the win chances, the Bounty Board and point lines like sources; usually sides with Luffy and explains exactly why when he doesn't. Locks when the numbers are lopsided, and once in a while locks a hunch the model misses, which he owns" },
];
const SEAT = { "Dana Whitfield": "Brannew", "Marcus Pell": "Crocus", "Sal Benedetto": "Shakky", "Dr. Nina Kessler": "Professor Clover" };
// Saved stories of a type for a season, oldest first
const saved = (type, year) => (fs.existsSync(NEWS) ? fs.readdirSync(NEWS).filter((f) => f.startsWith(`${type}-${year}-`)).map((f) => JSON.parse(fs.readFileSync(path.join(NEWS, f), "utf8"))).sort((a, b) => a.wk - b.wk) : []);
// Each panelist's season record on picks so far, how last week's picks went, and their berry bankroll: ฿100M a
// season, lean ฿5M, confident ฿10M, lock ฿25M, paid at Luffy's pregame odds (the same rules as the site)
const STAKE = { lean: 5e6, confident: 10e6, lock: 25e6 }, BANKROLL = 100e6;
const berries = (v) => `${v < 0 ? "-" : ""}฿${Math.round(Math.abs(v) / 1e6)}M`;
function panelRecords(s, before) {
  const rec = Object.fromEntries(PANEL.map((p) => [p.name, { w: 0, l: 0, locks_w: 0, locks_l: 0, last_week: [], b: BANKROLL }]));
  for (const pv of saved("preview", s.year).filter((a) => a.wk < before)) for (const g of pv.picks || []) {
    const m = s.matchups.find((x) => x.wk === pv.wk && [x.h, x.a].includes(g.h) && [x.h, x.a].includes(g.a));
    if (!m || m.win === null || m.live) continue;
    for (const p of g.panel) { const r = rec[SEAT[p.panelist] || p.panelist]; if (!r) continue; const ok = p.id === m.win;
      r[ok ? "w" : "l"]++; if (p.confidence === "lock") r[ok ? "locks_w" : "locks_l"]++;
      const hp = pregameWin(s, m), pr = Math.min(0.95, Math.max(0.05, hp == null ? 0.5 : p.id === m.h ? hp : 1 - hp)), stake = STAKE[p.confidence] || STAKE.lean;
      r.b += ok ? (stake * (1 - pr)) / pr : -stake;
      if (pv.wk === before - 1) r.last_week.push(`${ok ? "hit" : "missed"} on ${p.pick}${p.confidence === "lock" ? " (lock)" : ""}`); }
  }
  return Object.fromEntries(Object.entries(rec).map(([k, r]) => [k, { record: `${r.w}-${r.l}`, locks: `${r.locks_w}-${r.locks_l}`, berries: `${berries(r.b)} (started the season with ${berries(BANKROLL)})`, last_week: r.last_week.length ? r.last_week : undefined }]));
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
const pct = (p) => (p == null ? null : `${Math.round(p * 100)}%`);
// Starters by team for a week's first scoring period, as names
const startersAt = (s, W) => Object.fromEntries(Object.entries(s.lineups[spans(s, W)[0]] || {}).map(([id, ps]) => [id, ps.filter((p) => p.slot !== "BN" && p.slot !== "IR").map((p) => p.n)]));
// Revenge games (a starter facing a manager he played for before) pile up as the league ages, so the preview gets
// at most the week's best one, and only a fresh one: he left that manager this season or last, after a real stint
// (3+ weeks; this season, any), or a long one (a full season's worth) that ended within three years
function revengeGames(s, W) {
  const out = [];
  for (const m of s.matchups.filter((x) => x.wk === W && x.a)) for (const [id, opp] of [[m.h, m.a], [m.a, m.h]]) { const ok = mgrAt(s.byId[opp], W);
    for (const p of ((s.lineups[spans(s, W)[0]] || {})[id] || []).filter((q) => q.slot !== "BN" && q.slot !== "IR" && q.pos !== "K" && q.pos !== "D/ST" && (q.proj || 0) >= 8)) {
      const had = stints(p.n).filter((x) => x.k === ok && x.y * 100 + x.wk < s.year * 100 + W), l = had[had.length - 1];
      if (!had.length) continue;
      const ago = s.year - l.y, fresh = ago === 0 || (ago === 1 && had.length >= 3) || (ago <= 3 && had.length >= 14);
      if (!fresh) continue;
      out.push({ score: p.proj + 1.5 * Math.min(had.length, 10) + [8, 3, 0, 0][ago], txt: `${p.n} (${who(s.byId[id], W)}) faces ${mgrFirst(ok)}, who had him in ${span(had)}` }); } }
  return out.length ? out.sort((a, b) => b.score - a.score).slice(0, 1).map((x) => x.txt) : undefined;
}
// What the panel needs before a week: matchups with records, win chances, Ones to Watch, history, odds
function previewFacts(s, W) {
  const rec = recordsThrough(s, W - 1), N = s.odds ? s.odds.weeks[s.odds.weeks.length - 1] : null;
  const rk = (saved("rankings", s.year).filter((a) => a.wk === W - 1)[0] || {}).power_rankings;
  return {
    season: s.year, week: W, regular_season_weeks: s.regWeeks,
    games: s.matchups.filter((m) => m.wk === W && m.a).map((m) => {
      const holes = new Set((m.holes || []).map((x) => x.n));
      const t = (id) => ({ team: who(s.byId[id], W), record: `${rec[id].w}-${rec[id].l}`, streak: rec[id].streak, last_three: rec[id].seq.slice(-3).join(""), points_for: r1(rec[id].pf),
        last_three_scores: s.matchups.filter((x) => x.wk < W && x.a && done(x) && (x.h === id || x.a === id)).sort((a, b) => a.wk - b.wk).slice(-3).map((x) => (x.h === id ? x.hp : x.ap)),
        starters: (((s.lineups[spans(s, W)[0]] || {})[id]) || []).filter((p) => p.slot !== "BN" && p.slot !== "IR" && !holes.has(p.n)).map((p) => `${p.n} (${p.pos}, ${p.pro}${p.proj ? `, projected ${r1(p.proj)}` : ""})`),
        title_odds: N == null ? null : `${Math.round(oddsAt(s, N, id))}%`, playoff_odds: N == null ? null : `${Math.round(oddsAt(s, N, id, "p"))}%` });
      return { game: `${who(s.byId[m.h], W)} vs ${who(s.byId[m.a], W)}`, home: t(m.h), away: t(m.a),
        // Managers fill most holes by Sunday, so the preview leads with the lineup as it should be set
        home_win_chance: pct(m.psimFixed ?? m.psim),
        spots_to_fill: m.holes ? m.holes.map((x) => `${x.n} (${x.pos}) for ${who(s.byId[x.id], W)}: ${x.why}`) : undefined,
        head_to_head: h2hBefore(mgrAt(s.byId[m.h], W), mgrAt(s.byId[m.a], W), s.year, W),
        ones_to_watch: (m.watchFixed || m.watch || []).map((x) => ({ player: `${x.n} (${x.pos}, ${x.pro})`, for: who(s.byId[x.id], W), [`win_chance_if_he_scores_${x.boomAt}_or_more`]: `${x.boom}%`, [`if_under_${x.bustAt}`]: `${x.bust}%` })),
        stacks: (m.stacksFixed || m.stacks || []).map((k) => `${k.qb} and ${k.rec} for ${who(s.byId[k.id], W)}`) };
    }),
    revenge_games: revengeGames(s, W),
    last_week_power_rankings: rk ? rk.map((x) => `${x.rank}. ${x.team}`) : undefined,
    playoff_picture: pictureFacts(s, W - 1),
    recent_trades: s.trades.filter((t) => t.wk >= W - 1).map((t) => ({ teams: t.teams.map((id) => who(s.byId[id], W)), received: Object.fromEntries(Object.entries(t.got).map(([id, g]) => [who(s.byId[id], W), g.map((x) => x.split("|")[0])])) })),
    panel: PANEL.map((p) => ({ name: p.name, role: p.role, style: p.style, season_picks: panelRecords(s, W)[p.name] })),
    // The first preview after GLSN took over the panel says so
    new_panel: saved("preview", s.year).some((pv) => (pv.picks || []).some((g) => g.panel.some((p) => PANEL.some((q) => q.name === p.panelist)))) ? undefined
      : `GLSN, the Grand Line Sports Network, takes over the broadcast this week: ${Object.entries(SEAT).map(([o, n]) => `${n} takes ${o}'s seat`).join(", ")}, inheriting each seat's season_picks record and berries. Open with a short, fun welcome to the new crew and a send-off for the old one.`,
    guest: (() => { const g = guestFor(s, W); if (!g) return undefined;
      const before = saved("preview", s.year).filter((a) => a.wk < W && (a.picks || []).some((x) => x.panel.some((p) => p.panelist === g.name))).length;
      return { name: g.name, handle: g.handle, billing: g.tier === "legend" ? "special guest for the playoffs" : "guest", epithet: g.epithet, style: g.style, first_appearance: !before }; })(),
  };
}
// Real quotes managers gave GLSN, keyed by story id. "starting" is the player the quote is about: if the
// manager benches him anyway, the facts say so, and live.js posts about it if he does it later
const QUOTES = {
  "final-2026-11": [{ manager: "Sonny", starting: "Jaxon Smith-Njigba", asked: "why Jaxon Smith-Njigba is still in his lineup Sunday morning", quote: "I'm not resting my sunshine" }],
};
const quoteTeam = (q, s, W) => s.teams.find((x) => mgr(mgrAt(x, W)) === q.manager);
function quotesFor(id, s, W) {
  const now = startersAt(s, W);
  return (QUOTES[id] || []).map((q) => { const t = quoteTeam(q, s, W), benched = q.starting && t && !(now[t.id] || []).includes(q.starting);
    return { manager: q.manager, asked: q.asked, said: q.quote, then: benched ? `since saying it, ${q.manager} has taken ${q.starting} out of his starting lineup anyway` : undefined }; });
}
// The Sunday final word: what changed since the preview (lineups, injuries, Thursday's points) and holes still open
function finalFacts(s, W) {
  const pv = saved("preview", s.year).find((a) => a.wk === W) || {}, was = pv.starters || {}, now = startersAt(s, W);
  return {
    season: s.year, week: W, preview_title: pv.title,
    games: s.matchups.filter((m) => m.wk === W && m.a).map((m) => {
      const then = (pv.chances || []).find((x) => x.h === m.h && x.a === m.a);
      const side = (id) => { const before = was[id] || [], after = now[id] || [];
        return { team: who(s.byId[id], W), points_so_far: id === m.h ? m.hp : m.ap,
          moved_into_lineup: was[id] ? after.filter((n) => !before.includes(n)) : undefined, moved_out: was[id] ? before.filter((n) => !after.includes(n)) : undefined,
          already_played: (s.lineups[spans(s, W)[0]] || {})[id]?.filter((p) => p.slot !== "BN" && p.slot !== "IR" && p.pts).map((p) => `${p.n} ${p.pts}`) }; };
      return { game: `${who(s.byId[m.h], W)} vs ${who(s.byId[m.a], W)}`, home: side(m.h), away: side(m.a),
        home_win_chance_at_preview: then ? pct(then.p) : undefined,
        home_win_chance_now: pct(m.psim),
        unfilled_spots: m.holes ? m.holes.map((x) => `${x.n} (${x.pos}) for ${who(s.byId[x.id], W)}: ${x.why}`) : undefined,
        home_win_chance_if_filled: m.holes && m.psimFixed != null ? pct(m.psimFixed) : undefined,
        panel_picks: ((pv.picks || []).find((g) => g.h === m.h && g.a === m.a) || { panel: [] }).panel.map((p) => `${p.panelist}: ${p.pick} (${p.confidence})`),
        ones_to_watch: (m.watch || []).map((x) => ({ player: `${x.n} (${x.pos}, ${x.pro})`, for: who(s.byId[x.id], W), [`win_chance_if_he_scores_${x.boomAt}_or_more`]: `${x.boom}%`, [`if_under_${x.bustAt}`]: `${x.bust}%` })) };
    }),
    moves_since_preview: pv.created ? s.moves.filter((x) => x.date >= Date.parse(pv.created) && s.byId[x.tm]).map((x) => ({ team: who(s.byId[x.tm], W), added: x.add.map((n) => n.split("|")[0]), dropped: x.drop.map((n) => n.split("|")[0]) })) : undefined,
    panel: PANEL.map((p) => ({ name: p.name, role: p.role, style: p.style })),
    manager_quotes: quotesFor(`final-${s.year}-${W}`, s, W),
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
    playoff_picture: pictureFacts(s, W),
    trades_this_week: s.trades.filter((t) => t.wk === W || t.wk === W + 1).map((t) => ({ teams: t.teams.map((id) => who(s.byId[id], W)), received: Object.fromEntries(Object.entries(t.got).map(([id, g]) => [who(s.byId[id], W), g.map((x) => x.split("|")[0])])) })),
  };
}
// The week's awards, picked from the numbers (the writer only writes them up)
function awardFacts(s, W) {
  const ms = s.matchups.filter((m) => m.wk === W && m.a && m.win !== null && m.win !== 0);
  const sides = ms.flatMap((m) => [{ id: m.h, p: m.hp, o: m.ap, m }, { id: m.a, p: m.ap, o: m.hp, m }]);
  const rows = [];
  for (const sp of spans(s, W)) for (const id in s.lineups[sp] || {}) for (const p of s.lineups[sp][id]) rows.push({ ...p, id: +id });
  const st = rows.filter((p) => p.slot !== "BN" && p.slot !== "IR"), bn = rows.filter((p) => p.slot === "BN" && !p.st);
  const fmt = (p) => `${p.n} (${p.pos}, ${p.pro}) for ${who(s.byId[p.id], W)}`;
  const out = {};
  const mow = [...sides].sort((a, b) => b.p - a.p)[0];
  if (mow) out.manager_of_the_week = `${who(s.byId[mow.id], W)}, ${mow.p} points`;
  const pow = [...st].sort((a, b) => b.pts - a.pts)[0];
  if (pow) out.karoos_player_of_the_week = `${fmt(pow)}: ${pow.pts} points`;
  const bust = st.filter((p) => !p.st && p.proj >= 8).sort((a, b) => (a.pts - a.proj) - (b.pts - b.proj))[0];
  if (bust) out.bust_of_the_week = `${fmt(bust)}: ${bust.pts} points on a ${bust.proj} projection`;
  // A bench player who outscored a starter at his position on the same team
  const FLEX = ["RB", "WR", "TE"];
  let shd = null;
  for (const b of bn) for (const p of st.filter((p) => p.id === b.id && (p.pos === b.pos || (p.slot === "RB/WR/TE" || p.slot === "FLEX") && FLEX.includes(b.pos)))) {
    const d = b.pts - p.pts; if (d > 0 && (!shd || d > shd.d)) shd = { b, p, d };
  }
  if (shd) out.shouldve_started_him = `${shd.b.n} scored ${shd.b.pts} on ${who(s.byId[shd.b.id], W)}'s bench while ${shd.p.n} started and scored ${shd.p.pts}`;
  // Picked up in the last three weeks
  const recent = new Set(s.moves.filter((m) => m.wk > W - 3 && m.wk <= W).flatMap((m) => m.add.map((x) => `${m.tm}|${x.split("|")[0]}`)));
  const steal = st.filter((p) => recent.has(`${p.id}|${p.n}`)).sort((a, b) => b.pts - a.pts)[0];
  if (steal) out.waiver_steal = `${fmt(steal)}: ${steal.pts} points, picked up within the last three weeks`;
  const close = [...ms].sort((a, b) => Math.abs(a.hp - a.ap) - Math.abs(b.hp - b.ap))[0], blow = [...ms].sort((a, b) => Math.abs(b.hp - b.ap) - Math.abs(a.hp - a.ap))[0];
  const game = (m) => `${who(s.byId[m.win], W)} beat ${who(s.byId[m.win === m.h ? m.a : m.h], W)} ${Math.max(m.hp, m.ap)} to ${Math.min(m.hp, m.ap)}`;
  if (close && Math.abs(close.hp - close.ap) < 10) out.nail_biter = game(close); // only a genuinely close one
  if (blow && blow !== close) out.blowout = game(blow);
  return out;
}
// The playoff picture after week W (stakes for the next game, clinches and eliminations), when it's current
function pictureFacts(s, W) {
  const P = s.odds && s.odds.picture;
  if (!P || P.week !== W) return undefined;
  const nm = (id) => who(s.byId[id], W + 1);
  return Object.fromEntries(s.teams.map((t) => { const x = P.teams[t.id] || {}, st = (P.status || {})[t.id], sd = (P.seed || {})[t.id];
    return [nm(t.id), st ? (sd ? `${st}, and ${sd}` : st) : { playoff_odds_with_a_win_next_week: x.ifWin && x.ifWin.p != null ? `${Math.round(x.ifWin.p)}%` : null, with_a_loss: x.ifLose && x.ifLose.p != null ? `${Math.round(x.ifLose.p)}%` : null,
      scenarios: ((P.scenarios || {})[t.id] || []).map((sc) => `${sc.clinches ? "clinches" : "is eliminated"} with ${sc.with.map((w) => w.winner === t.id ? "a win" : w.loser === t.id ? "a loss" : `${nm(w.winner)} beating ${nm(w.loser)}`).join(" and ")}`) }]; }));
}
// How each frozen Ones to Watch pick did: Gear 5 at or over his top line, Seastoned under his bottom line
function watchResults(s, m, W) {
  const pre = (s.pregame || {})[`${m.wk}-${m.h}-${m.a}`];
  if (!pre) return undefined;
  return pre.watch.map((x) => { const ps = spans(s, m.wk).map((sp) => ((s.lineups[sp] || {})[x.id] || []).find((q) => q.n === x.n)).filter(Boolean);
    const pts = r1(ps.reduce((a, q) => a + (q.pts || 0), 0)), started = ps.some((q) => q.slot !== "BN" && q.slot !== "IR");
    return { player: `${x.n} (${x.pos}, ${x.pro})`, for: who(s.byId[x.id], W), points: pts, top_line: x.boomAt, bottom_line: x.bustAt,
      result: !started ? "benched" : pts >= x.boomAt ? "Gear 5" : pts < x.bustAt ? "Seastoned" : "in between" }; });
}
// Stars a team is playing without: a top-three scorer or regular starter who's out, suspended or on IR right now (the
// season in progress only; rosters are current), with how long he's been gone, when he's due back and ESPN's line on it,
// so fans can miss him now and then
function missingStars(s, W) {
  if (s.done || !s.rosters) return [];
  const out = [];
  for (const [id, ps] of Object.entries(s.rosters)) {
    const st = (n) => { let pts = 0, starts = 0, wks = 0, last = 0; for (const w in s.lineups) { const e = ((s.lineups[w] || {})[id] || []).find((q) => q.n === n); if (!e || +w > W) continue; wks++; if (e.slot !== "BN" && e.slot !== "IR") { starts++; pts += e.pts; if (e.pts) last = Math.max(last, +w); } } return { pts: r1(pts), starts, wks, last }; };
    const ranked = ps.map((p) => ({ p, ...st(p.n) })).sort((a, b) => b.pts - a.pts);
    ranked.forEach((r, i) => { const { p } = r; if (!["OUT", "INJURY_RESERVE", "SUSPENSION"].includes(p.inj) || !(i < 3 || (r.wks && r.starts / r.wks >= 0.5))) return;
      const gone = r.last ? W - r.last : null;
      out.push(`${p.n} (${p.pos}) for ${who(s.byId[id], W)}: ${i === 0 ? "the team's top scorer" : `its ${["", "", "second", "third"][i + 1] || `No. ${i + 1}`} scorer`} (${r.pts} points in ${r.starts} starts), ${p.injSeason ? "out for the season" : p.inj === "INJURY_RESERVE" ? "on IR" : p.inj === "SUSPENSION" ? "suspended" : "out"}${gone ? `, last played week ${r.last}` : ""}${p.injBack && !p.injSeason ? `, expected back around ${p.injBack}` : ""}${p.injNote ? `; ESPN: ${p.injNote}` : ""}`); });
  }
  return out;
}
// A team's season arc in playoff odds: its high and low points (with the record at each) and where it ended, for the
// end-of-season stories to use when that's the team's story (a 3-0 start at 88% that fell apart, a climb from nowhere)
function seasonArc(s, id, upTo) {
  const O = s.odds, p = O && O.t && (O.t[id] || {}).p; if (!p) return undefined;
  const ks = O.weeks.map((wk, k) => [wk, k]).filter(([wk]) => wk >= 1 && wk <= upTo); if (ks.length < 3) return undefined;
  const hi = ks.reduce((a, b) => (p[b[1]] > p[a[1]] ? b : a)), lo = ks.reduce((a, b) => (p[b[1]] < p[a[1]] ? b : a)), end = ks[ks.length - 1];
  const at = ([wk, k]) => { const r = recordsThrough(s, wk)[id]; return `${Math.round(p[k])}% at ${r.w}-${r.l} after week ${wk}`; };
  const pts = [[hi, "high"], [lo, "low"]].filter(([x], i, arr) => i === 0 || x !== arr[0][0]).sort((x, y) => x[0][0] - y[0][0]);
  return `playoff odds ${pts.map(([x, l]) => `${l} ${at(x)}`).join(", ")}${end !== hi && end !== lo ? `, ended ${at(end)}` : ""}`;
}
// The awards' namesakes (parody One Piece characters, never quoting the series) pop up on the feed now and then, the way
// real legends weigh in on the award named for them: the Straw Hats reuse their guest-star accounts, the rest have their own
// (same list as NAMESAKE_BIO in site/index.html). The Pirate King, The One Piece and Thousand Sunny have no one to speak for them.
const guest = (n) => { const g = GUESTS.find((x) => x.name === n); return { name: g.name, handle: g.handle, style: g.style }; };
const NAMESAKES = {
  nami: guest("Nami"), sanji: guest("Sanji"), zoro: guest("Roronoa Zoro"), franky: guest("Franky"), usopp: guest("Usopp"), chopper: guest("Tony Tony Chopper"), brook: guest("Brook"), buggy: guest("Buggy"),
  jinbe: { name: "Jinbe", handle: "@JinbeTheWall", style: "calm, honorable fishman karate master; talks about defense like a sacred duty, with quiet gravity" },
  robin: { name: "Nico Robin", handle: "@RobinArchives", style: "dry, darkly funny scholar; treats a waiver-wire find like an ancient text she dug up" },
  ace: { name: "Portgas D. Ace", handle: "@FireFistAce", style: "warm, fiery big brother; polite, takes a starter's zero personally" },
  foxy: { name: "Foxy", handle: "@SilverFoxFoxy", style: "sore-loser captain of rigged games; gloats over a team that dropped the wrong guy, sulks fast" },
  karoo: { name: "Karoo", handle: "@KarooQuacks", style: "Princess Vivi's racing duck: posts mostly in quacks and running emojis, with a few urgent words" },
  vegapunk: { name: "Vegapunk", handle: "@DrVegapunk", style: "excitable genius scientist; treats a draft as research and loves a good data point" },
  wapol: { name: "Wapol", handle: "@WapolMunch", style: "greedy deposed king who'd eat anything; treats the waiver wire as an all-you-can-eat buffet" },
  doflamingo: { name: "Doflamingo", handle: "@DoflamingoDeals", style: "smug puppet-master dealmaker; savors a lopsided trade and laughs at whoever got fleeced" },
  blackbeard: { name: "Blackbeard", handle: "@MarshallDTeach", style: "loud, greedy believer in fate and luck; cheers a win that came out of nowhere" },
  bonclay: { name: "Bon Clay", handle: "@MrTwoBonClay", style: "flamboyant, loyal ballet-dancing okama; weeps theatrically for an unlucky friend" },
  bellamy: { name: "Bellamy", handle: "@BellamyHyena", style: "brash hyena who laughs at other people's mistakes and learned humility the hard way" },
  marco: { name: "Marco", handle: "@MarcoPhoenix", style: "laid-back phoenix and doctor; calmly admires a rise from the ashes" },
};
const NAMESAKE_AWARD = { nami: "Nami (best QB)", sanji: "Sanji (best RB)", zoro: "Zoro (best WR)", franky: "Franky (best TE)", usopp: "Usopp (best K)", jinbe: "Jinbe (best D/ST)", robin: "Robin (best pickup)",
  chopper: "Chopper (comeback player)", brook: "Brook (most bench points)", buggy: "Buggy (biggest bust)", ace: "Ace (most costly donut)", foxy: "Foxy (worst drop)", karoo: "Karoo (most weeks as player of the week)",
  vegapunk: "Vegapunk (best draft)", wapol: "Wapol (waiver king)", doflamingo: "Doflamingo (trade shark)", blackbeard: "Blackbeard (luckiest manager)", bonclay: "Bon Clay (unluckiest manager)", bellamy: "Bellamy (lineup blunders)", marco: "Marco (biggest Laboon climber)" };
// Each award's race so far, from the site's own award code (players by name and team, managers by first name)
function awardRaces(y) {
  try { const { run } = require("./sitecode");
    return JSON.parse(run(`JSON.stringify((() => { const s = S[${y}], a = seasonAwards(s), m = seasonMgrAwards(s), out = {};
      for (const k in a) if (a[k]) out[k] = (a[k].top5 || [{ p: a[k].p, t: a[k].t, stat: a[k].stat }]).slice(0, 3).map((x) => x.p.n + (x.t ? " (" + x.t.name + ")" : "") + ": " + x.stat);
      for (const k in m) if (m[k]) out[k] = (m[k].top5 || [{ k: m[k].ks[0], stat: m[k].stat }]).slice(0, 3).map((x) => mgrName(x.k) + ": " + x.stat);
      return out; })())`)); } catch (e) { return {}; }
}
// About one week in three, one namesake weighs in on his award's race in the recap's posts (which one, by week)
const hashOf = (k) => { let x = 2166136261; for (const c of k) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return x; };
function namesakeCameo(s, W) {
  if (hashOf(`cameo-${s.year}-${W}`) % 3 !== 0) return undefined;
  const races = awardRaces(s.year), keys = Object.keys(NAMESAKES).filter((k) => (races[k] || []).length);
  if (!keys.length) return undefined;
  const k = keys[hashOf(`pick-${s.year}-${W}`) % keys.length], c = NAMESAKES[k];
  return { character: c.name, handle: c.handle, style: c.style, award: NAMESAKE_AWARD[k], race_so_far: races[k] };
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
      ones_to_watch: watchResults(s, m, W),
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
  const moves = s.moves.filter((m) => m.wk === W).map((m) => { const k = mgrAt(s.byId[m.tm], W), back = m.add.filter((x) => !/\|(K|D\/ST)$/.test(x)).map((x) => [x.split("|")[0], reunion(x.split("|")[0], k, s.year, W + 1)]).filter(([, r]) => r);
    return { team: who(s.byId[m.tm], W), added: m.add.map((x) => x.split("|")[0]), dropped: m.drop.map((x) => x.split("|")[0]), reunions: back.length ? back.map(([n, r]) => `${n}: ${r}`) : undefined }; });
  const trades = s.trades.filter((t) => t.wk === W || t.wk === W + 1).map((t) => ({ teams: t.teams.map((id) => who(s.byId[id], W)), received: Object.fromEntries(Object.entries(t.got).map(([id, g]) => [who(s.byId[id], W), g.map((x) => x.split("|")[0])])) }));
  const next = [...s.matchups, ...(s.future || [])].filter((m) => m.wk === W + 1 && m.a).map((m) => `${who(s.byId[m.h], W + 1)} vs ${who(s.byId[m.a], W + 1)}`);
  // From the player sim: who swings next week's games most (a boom/bust is a top/bottom-20% game for him)
  const watch = s.matchups.filter((m) => m.wk === W + 1 && m.watch).map((m) => ({ game: `${who(s.byId[m.h], W + 1)} vs ${who(s.byId[m.a], W + 1)}`,
    ones_to_watch: m.watch.map((x) => ({ player: `${x.n} (${x.pos}, ${x.pro})`, for: who(s.byId[x.id], W + 1), [`team_win_chance_if_he_scores_${x.boomAt}_or_more`]: `${x.boom}%`, [`if_he_scores_under_${x.bustAt}`]: `${x.bust}%` })),
    stacks: (m.stacks || []).map((k) => `${k.qb} and ${k.rec} for ${who(s.byId[k.id], W + 1)}`) }));
  return {
    season: s.year, buckaroo_bowl_number: s.year - D.firstYear + 1, week: W, regular_season_weeks: s.regWeeks, playoff_teams: s.playoffTeams,
    games, top_performances: starts.sort((a, b) => b.points - a.points).slice(0, 6),
    awards: awardFacts(s, W), playoff_picture: pictureFacts(s, W),
    missing_stars: (() => { const x = missingStars(s, W + 1); return x.length ? x : undefined; })(),
    namesake_cameo: namesakeCameo(s, W),
    // From week 8 until the regular season's last week: the bracket as the seeds stand (ESPN's current seeds), so the league's
    // account can post "if the playoffs started today" from real standings, never made-up matchups
    if_the_playoffs_started_today: (() => { if (W < 8 || W >= s.regWeeks) return undefined; const n = s.playoffTeams || 4;
      const seeded = s.teams.filter((t) => t.seed).sort((a, b) => a.seed - b.seed); if (seeded.length < n) return undefined;
      const field = seeded.slice(0, n), lab = (t) => `(${t.seed}) ${who(t, W)}`, out = [];
      if (n === 4) out.push(`${lab(field[0])} vs ${lab(field[3])}`, `${lab(field[1])} vs ${lab(field[2])}`);
      else if (n === 3) out.push(`${lab(field[0])} gets a first-round bye`, `${lab(field[1])} vs ${lab(field[2])}`);
      else out.push(...field.map(lab));
      return { matchups: out, first_out: seeded[n] ? lab(seeded[n]) : undefined }; })(),
    biggest_busts: starts.filter((x) => x.projected != null).sort((a, b) => (a.points - a.projected) - (b.points - b.projected)).slice(0, 3),
    bench_blunders: bench.sort((a, b) => b.points - a.points).slice(0, 3),
    starters_who_did_not_play: starts.filter((x) => x.status),
    standings_after_week: standings, roster_moves_this_week: moves, trades, next_week_matchups: next, next_week_ones_to_watch: watch, trade_watch: tradeWatchFacts(s, W),
    waiver_king_race: (() => { try { const { run } = require("./sitecode");
      const a = JSON.parse(run(`JSON.stringify(((seasonMgrAwards(S[${s.year}]) || {}).wapol || {}).top5 || [])`));
      return a.length ? a.slice(0, 3).map((x) => `${(D.managers[x.k] || {}).name || x.k}: ${x.stat}`) : undefined; } catch { return undefined; } })(),
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
// Every stint a player has had with a manager, from every week's rosters since the league began (any slot), so stories
// can tell a reunion (back with a manager who had him before, after time elsewhere) or a revenge game (facing one who let him go)
let PH = null;
const stints = (n) => {
  if (!PH) { PH = {}; for (const z of D.seasons) for (const wk in z.lineups) for (const id in z.lineups[wk]) { const k = mgrAt(z.byId[id], +wk);
    for (const p of z.lineups[wk][id]) ((PH[p.n] = PH[p.n] || []).push({ k, y: z.year, wk: +wk })); } }
  return PH[n] || [];
};
const mgrFirst = (k) => (D.managers[k] || {}).first || k;
const span = (list) => { const ys = [...new Set(list.map((x) => x.y))].sort(); return `${ys.join(" and ")} (${list.length} week${list.length === 1 ? "" : "s"})`; };
// "back with Sonny, who had him in 2024 (6 weeks)": only when he spent time with someone else in between
function reunion(n, k, y, wk) {
  const before = stints(n).filter((x) => x.y * 100 + x.wk < y * 100 + wk).sort((a, b) => a.y * 100 + a.wk - (b.y * 100 + b.wk));
  const mine = before.filter((x) => x.k === k); if (!mine.length) return undefined;
  const last = mine[mine.length - 1], since = before.filter((x) => x.y * 100 + x.wk > last.y * 100 + last.wk);
  if (!since.length || since.every((x) => x.k === k)) return undefined;
  return `back with ${mgrFirst(k)}, who had him in ${span(mine)}; since then he played for ${[...new Set(since.map((x) => mgrFirst(x.k)))].join(", ")}`;
}
// Managers he played for before, newest first, leaving out the current one
const formerManagers = (n, k, y, wk) => { const by = {}; for (const x of stints(n)) if (x.k !== k && x.y * 100 + x.wk < y * 100 + wk) (by[x.k] = by[x.k] || []).push(x);
  return Object.entries(by).sort((a, b) => b[1][b[1].length - 1].y - a[1][a[1].length - 1].y).map(([m, l]) => `${mgrFirst(m)}: ${span(l)}`); };
function howGot(s, n, tid, beforeWk) {
  const nm = (x) => x.split("|")[0], c = [];
  const add = [...(s.moves || [])].reverse().find((m) => m.tm === tid && m.wk < beforeWk && m.add.some((x) => nm(x) === n));
  if (add) c.push({ wk: add.wk, txt: `${add.kind === "Waiver" ? "a waiver claim" : "a free-agent pickup"} in week ${add.wk}` });
  const t = [...s.trades].reverse().find((x) => x.wk < beforeWk && (x.got[tid] || []).some((y) => nm(y) === n));
  if (t) c.push({ wk: t.wk - 0.5, txt: `a trade before week ${t.wk} with ${who(s.byId[t.teams.find((id) => id !== tid)], t.wk)}` });
  const d = (s.draft || []).find((x) => x.tm === tid && x.n === n);
  if (d) c.push({ wk: 0, txt: `drafted in round ${d.rd}` });
  return (c.sort((a, b) => b.wk - a.wk)[0] || {}).txt;
}
function tradeFacts(s, tr) {
  const pointsFor = (n) => { let pts = 0, gp = 0; const on = new Set();
    for (const wk in s.lineups) for (const id in s.lineups[wk]) for (const p of s.lineups[wk][id]) if (p.n === n && +wk < tr.wk) { pts += p.pts; gp++; on.add(+wk); }
    const out = { points_on_a_roster_before_trade: r1(pts), weeks_on_a_roster: gp };
    // Every week he played, on a roster or not (fetch.js), so a pickup who produced as a free agent gets his due
    const wk = (s.tradedPts || {})[n];
    if (wk) { const before = Object.entries(wk).filter(([w]) => +w < tr.wk), fa = before.filter(([w]) => !on.has(+w));
      out.season_points_before_trade = r1(before.reduce((t, [, v]) => t + v, 0));
      if (fa.length) { out.points_as_free_agent_before_trade = r1(fa.reduce((t, [, v]) => t + v, 0)); out.weeks_as_free_agent = fa.length; }
      const last3 = before.sort((a, b) => b[0] - a[0]).slice(0, 3);
      if (last3.length) out.last_three_weeks = last3.map(([w, v]) => `week ${w}: ${v}`); }
    return out; };
  return {
    season: s.year, happened_before_week: tr.wk,
    sides: tr.teams.map((id) => ({
      team: who(s.byId[id], tr.wk),
      received: (tr.got[id] || []).map((x) => { const [n, pos] = x.split("|"), from = tr.teams.find((o) => o !== id);
        const k = mgrAt(s.byId[id], tr.wk), past = formerManagers(n, k, s.year, tr.wk);
        return { player: n, position: pos, ...pointsFor(n), how_the_other_side_got_him: howGot(s, n, from, tr.wk), reunion: reunion(n, k, s.year, tr.wk), former_managers: past.length ? past : undefined }; }),
      ...tradeOdds(s, tr, id),
    })),
  };
}
// A trade both sides agreed to that got vetoed: the same player facts as a real trade, but no before/after odds
// (nothing changed hands), just where each team stands now
const vetoId = (s, v) => `veto-${s.year}-${v.wk}-${v.teams.join("-")}`;
function vetoFacts(s, v) {
  const f = tradeFacts(s, { ...v, wk: v.wk + 1 }), rec = recordsThrough(s, s.curWeek - 1), N = s.odds ? s.odds.weeks[s.odds.weeks.length - 1] : null;
  for (const side of f.sides) { for (const k of Object.keys(side)) if (/_odds_/.test(k)) delete side[k];
    const id = v.teams.find((t) => who(s.byId[t], v.wk + 1) === side.team), r = rec[id] || { w: 0, l: 0 };
    side.record = `${r.w}-${r.l}`; if (N != null) { side.title_odds_now = `${Math.round(oddsAt(s, N, id) ?? 0)}%`; side.playoff_odds_now = `${Math.round(oddsAt(s, N, id, "p") ?? 0)}%`; } }
  return { ...f, status: "agreed by both teams, then vetoed; it did not go through and both rosters stay as they were (the player facts describe the deal as agreed: a reunion means he would have been back with that manager)", vetoed_at: etLabel(new Date(v.at)), happened_before_week: undefined, week: s.curWeek,
    voted_to_veto: v.voters ? v.voters.map((t) => who(s.byId[t], v.wk)) : undefined,
    did_not_vote_to_veto: v.voters ? s.teams.filter((t) => !v.voters.includes(t.id) && !v.teams.includes(t.id)).map((t) => who(t, v.wk)) : undefined,
    earlier_vetoes_this_season: (s.vetoed || []).filter((x) => x.at < v.at).length };
}
// Report cards: grades for every team when the regular season ends (stage "reg") and again when the playoffs and the
// consolation ladder are done (stage "final"), from the season's numbers
function gradesFacts(s, stage) {
  const rec = recordsThrough(s, s.regWeeks), reg = s.matchups.filter((m) => m.wk <= s.regWeeks && done(m) && m.a);
  const n = s.teams.length, place = [...s.teams].sort((a, b) => rec[b.id].w - rec[a.id].w || rec[b.id].pf - rec[a.id].pf).map((t) => t.id);
  const pfRank = [...s.teams].sort((a, b) => rec[b.id].pf - rec[a.id].pf).map((t) => t.id);
  // All-play: how often a team's score would have beaten each other team's that week, so luck is wins minus expected wins
  const wks = [...new Set(reg.map((m) => m.wk))], allPlay = {};
  for (const w of wks) { const sc = reg.filter((m) => m.wk === w).flatMap((m) => [[m.h, m.hp], [m.a, m.ap]]);
    for (const [id, p] of sc) allPlay[id] = (allPlay[id] || 0) + sc.filter(([o, q]) => o !== id && q < p).length / (sc.length - 1); }
  const N = s.odds ? s.odds.weeks.filter((w) => w <= s.regWeeks).slice(-1)[0] : null;
  const team = (t) => { const id = t.id, r = rec[id], weeks = reg.filter((m) => m.h === id || m.a === id).map((m) => ({ wk: m.wk, p: m.h === id ? m.hp : m.ap }));
    const hi = [...weeks].sort((a, b) => b.p - a.p)[0], lo = [...weeks].sort((a, b) => a.p - b.p)[0], exp = allPlay[id] || 0;
    const out = { team: who(t, s.regWeeks), regular_season_record: `${r.w}-${r.l}${r.t ? `-${r.t}` : ""}`, standing: place.indexOf(id) + 1, points_for: r1(r.pf), points_for_rank: pfRank.indexOf(id) + 1,
      expected_wins_from_scoring: r1(exp), luck: r1(r.w - exp), best_week: hi && `${hi.p} in week ${hi.wk}`, worst_week: lo && `${lo.p} in week ${lo.wk}`, last_five: r.seq.slice(-5).join(""),
      title_odds_on_draft_day: s.odds ? `${Math.round(oddsAt(s, 0, id) ?? 0)}%` : undefined, playoff_odds_on_draft_day: s.odds ? `${Math.round(oddsAt(s, 0, id, "p") ?? 0)}%` : undefined,
      title_odds_after_regular_season: N != null ? `${Math.round(oddsAt(s, N, id) ?? 0)}%` : undefined,
      season_arc: seasonArc(s, id, s.regWeeks),
      trades_made: s.trades.filter((x) => x.teams.includes(id)).length, waiver_and_free_agent_adds: s.moves.filter((m) => m.tm === id).reduce((k, m) => k + m.add.length, 0) };
    if (stage === "final") {
      const games = s.matchups.filter((m) => m.wk > s.regWeeks && done(m) && (m.h === id || m.a === id)).sort((a, b) => a.wk - b.wk);
      out.final_place = t.final || undefined; out.playoff_seed = t.seed || undefined;
      out.postseason = games.map((m) => { const me = m.h === id, o = s.byId[me ? m.a : m.h];
        return `${m.tier === "WINNERS_BRACKET" ? "playoffs" : "consolation ladder"}: ${m.win === id ? "beat" : m.win === 0 ? "tied" : "lost to"} ${who(o, m.wk)} ${me ? m.hp : m.ap}-${me ? m.ap : m.hp}${spans(s, m.wk).length > 1 ? " (two-week total)" : ""}`; });
      if (!games.length) out.postseason = ["bye or no postseason games"];
    }
    return out; };
  const champ = s.teams.find((t) => t.final === 1), last = s.teams.find((t) => t.final === n);
  return { season: s.year, stage: stage === "reg" ? "end of the regular season" : "end of the season, playoffs and consolation ladder included", teams: n, playoff_teams: s.playoffTeams,
    champion: stage === "final" && champ ? who(champ, s.regWeeks) : undefined, last_place: stage === "final" && last ? who(last, s.regWeeks) : undefined,
    regular_season_grades: stage === "final" ? ([...saved("regseason", s.year), ...saved("grades", s.year)].find((a) => a.type === "regseason" || a.stage === "reg") || {}).grades?.map((g) => `${g.team}: ${g.grade}`) : undefined,
    report_card: s.teams.map(team).sort((a, b) => (a.final_place || a.standing) - (b.final_place || b.standing)) };
}
// The postseason report card: a deep look at every team's season, a week after the Buckaroo Bowl. Built on the
// regular-season report card's numbers plus how each manager drafted, worked the wire, traded and set lineups.
const FLEXPOS = ["RB", "WR", "TE"];
// The best lineup a team could have started from its roster that week (same slots it used), and its points
function optimal(entries) {
  const st = entries.filter((e) => e.slot !== "BN" && e.slot !== "IR"), pool = entries.filter((e) => e.slot !== "IR").map((e) => ({ ...e })), used = new Set();
  const take = (ok) => { const c = pool.filter((e) => !used.has(e) && ok(e)).sort((a, b) => b.pts - a.pts)[0]; if (c) used.add(c); return c ? c.pts : 0; };
  let pts = 0;
  for (const sl of st.filter((e) => e.slot !== "FLEX")) pts += take((e) => e.pos === sl.slot);
  for (const sl of st.filter((e) => e.slot === "FLEX")) pts += take((e) => FLEXPOS.includes(e.pos));
  return pts;
}
function cardFacts(s) {
  const base = gradesFacts(s, "final"), last = Math.max(...s.matchups.map((m) => m.wk)), n = s.teams.length;
  const games = s.matchups.filter((m) => m.a && done(m));
  const draftedBy = {}; for (const d of s.draft || []) draftedBy[d.n] = d.tm;
  // Awards from the site's own code, so the card matches the Awards page
  let aw = { ply: [], mgr: [] };
  try { const { run } = require("./sitecode"); aw = JSON.parse(run(`JSON.stringify((() => { const s = S[${s.year}], a = seasonAwards(s), m = seasonMgrAwards(s);
    return { ply: AWARDS.filter(([k]) => a[k] && a[k].t).map(([k, e, nm, cat]) => ({ id: a[k].t.id, txt: nm + " (" + cat + "): " + a[k].p.n + ", " + a[k].stat })),
      mgr: MGR_AWARDS.filter(([k]) => m[k]).map(([k, e, nm, cat]) => ({ ks: m[k].ks, txt: nm + " (" + cat + "): " + m[k].stat })) }; })())`)); } catch {}
  const per = {};
  for (const t of s.teams) per[t.id] = { start: {}, posPts: {}, bench: 0, actual: 0, best: 0, weeks: 0, draft: 0, pickup: 0, traded_in: 0, traded_away: 0, blunders: [], adds: 0, drops: 0, starters: {} };
  for (const m of games) for (const [id, o] of [[m.h, m.a], [m.a, m.h]]) {
    const P = per[id], myPts = id === m.h ? m.hp : m.ap, oppPts = id === m.h ? m.ap : m.hp;
    let act = 0, best = 0;
    for (const sp of spans(s, m.wk)) { const L = (s.lineups[sp] || {})[id] || []; best += optimal(L);
      for (const e of L) { if (e.slot === "IR") continue;
        if (e.slot === "BN") { P.bench += e.pts; continue; }
        act += e.pts; P.posPts[e.pos] = (P.posPts[e.pos] || 0) + e.pts; P.starters[e.n] = P.starters[e.n] || { n: e.n, pos: e.pos, pts: 0, starts: 0 }; P.starters[e.n].pts += e.pts; P.starters[e.n].starts++;
        const tr = s.trades.find((x) => x.wk <= sp && (x.got[id] || []).some((g) => g.split("|")[0] === e.n));
        if (draftedBy[e.n] === id) P.draft += e.pts; else if (tr) P.traded_in += e.pts; else P.pickup += e.pts; } }
    P.actual += act; P.best += best; P.weeks++;
    if (myPts < oppPts && best - act > oppPts - myPts) P.blunders.push(`week ${m.wk}: lost by ${r1(oppPts - myPts)}, best possible lineup was ${r1(best - act)} better`);
  }
  // What players a team traded away went on to score as starters for the team that got them
  for (const tr of s.trades) for (const id of tr.teams) { const other = tr.teams.find((x) => x !== id);
    for (const g of tr.got[other] || []) { const nm = g.split("|")[0];
      for (const sp in s.lineups) if (+sp >= tr.wk) for (const e of (s.lineups[sp][other] || [])) if (e.n === nm && e.slot !== "BN" && e.slot !== "IR") per[id].traded_away += e.pts; } }
  for (const mv of s.moves) if (per[mv.tm]) { per[mv.tm].adds += mv.add.length; per[mv.tm].drops += mv.drop.length; }
  const avgAdds = s.moves.reduce((k, m) => k + m.add.length, 0) / n, avgTrades = s.trades.length * 2 / n;
  // Each position group's points per week as starters, ranked across the league (1 = best)
  const POS = ["QB", "RB", "WR", "TE", "K", "D/ST"], pos = {};
  for (const p of POS) { const order = s.teams.map((t) => [t.id, (per[t.id].posPts[p] || 0) / Math.max(1, per[t.id].weeks)]).sort((a, b) => b[1] - a[1]);
    order.forEach(([id, v], i) => ((pos[id] = pos[id] || {})[p] = `${r1(v)} a week, ${i + 1} of ${n}`)); }
  const cards = base.report_card.map((rc) => { const t = s.teams.find((x) => rc.team === who(x, s.regWeeks)), P = per[t.id], k = mgrAt(t, last);
    const picks = (s.draft || []).filter((d) => d.tm === t.id).sort((a, b) => a.pk - b.pk), stPts = (nm) => (P.starters[nm] || { pts: 0 }).pts;
    return { ...rc,
      position_groups: pos[t.id],
      top_starters: Object.values(P.starters).sort((a, b) => b.pts - a.pts).slice(0, 4).map((x) => `${x.n} (${x.pos}) ${r1(x.pts)} in ${x.starts} starts`),
      draft: { points_as_starters_from_own_picks: r1(P.draft),
        first_three_picks: picks.slice(0, 3).map((d) => `${d.n} (${d.pos}, pick ${d.pk}): ${r1(stPts(d.n))} as his starter`),
        best_value_pick: (() => { const v = picks.filter((d) => d.rd > 3).sort((a, b) => stPts(b.n) - stPts(a.n))[0]; return v && `${v.n} (round ${v.rd}): ${r1(stPts(v.n))}`; })() },
      waivers: { adds: P.adds, league_average_adds: r1(avgAdds), drops: P.drops, points_as_starters_from_pickups: r1(P.pickup) },
      trades: { trades_made: rc.trades_made, league_average: r1(avgTrades), points_from_players_acquired: r1(P.traded_in), points_players_traded_away_scored_for_new_team: r1(P.traded_away) },
      lineups: { points_left_on_bench: r1(P.bench), lineup_efficiency: `${Math.round((100 * P.actual) / Math.max(1, P.best))}% of the best possible lineup's points`,
        points_left_vs_best_lineup: r1(P.best - P.actual), losses_the_bench_would_have_flipped: P.blunders },
      awards: [...aw.ply.filter((a) => a.id === t.id).map((a) => a.txt), ...aw.mgr.filter((a) => a.ks.includes(k)).map((a) => a.txt)] };
  });
  return { season: s.year, teams: n, playoff_teams: s.playoffTeams, champion: base.champion, last_place: base.last_place, next_season: s.year + 1,
    league_format: "redraft: every roster is drafted fresh next season, nothing carries over (no keepers, not a dynasty league)",
    regular_season_grades: base.regular_season_grades, report_card: cards };
}
// The end-of-season run (2026 on): a regular season review with every team's grade once week 14 is final, a playoff
// preview and a Bum Bowl preview as the brackets are set, then a season review per team as the season ends (worst to best,
// one a day from the Tuesday after the Bowl, the report card inside), and the league's season review
function regseasonFacts(s) {
  const base = gradesFacts(s, "reg");
  return { ...base, playoff_field: s.teams.filter((t) => t.seed && t.seed <= s.playoffTeams).sort((a, b) => a.seed - b.seed).map((t) => `${t.seed}. ${who(t, s.regWeeks)}`),
    consolation_ladder: s.teams.filter((t) => !(t.seed && t.seed <= s.playoffTeams)).map((t) => who(t, s.regWeeks)) };
}
function bracketTeam(s, t) {
  const rec = recordsThrough(s, s.regWeeks)[t.id], O = s.odds, i = O ? (O.weeks.includes(s.regWeeks) ? O.weeks.indexOf(s.regWeeks) : O.weeks.length - 1) : -1; // as the regular season ended
  const last3 = s.matchups.filter((m) => m.wk <= s.regWeeks && m.a && (m.h === t.id || m.a === t.id)).sort((a, b) => a.wk - b.wk).slice(-3).map((m) => (m.h === t.id ? m.hp : m.ap));
  const top = []; for (const w in s.lineups) if (+w <= s.regWeeks) for (const p of (s.lineups[w][t.id] || [])) if (p.slot !== "BN" && p.slot !== "IR") { const x = top.find((q) => q.n === p.n) || (top.push({ n: p.n, pos: p.pos, pts: 0 }), top[top.length - 1]); x.pts += p.pts; }
  const onRoster = new Set(((s.rosters || {})[t.id] || []).map((p) => p.n));
  return { team: who(t, s.regWeeks), seed: t.seed, record: `${rec.w}-${rec.l}`, points_for: r1(rec.pf), last_three_scores: last3,
    title_odds: i >= 0 ? `${Math.round(O.t[t.id].c[i])}%` : undefined, last_place_odds: i >= 0 ? `${Math.round(O.t[t.id].l[i])}%` : undefined,
    best_players: top.filter((x) => !onRoster.size || onRoster.has(x.n)).sort((a, b) => b.pts - a.pts).slice(0, 4).map((x) => `${x.n} (${x.pos}) ${r1(x.pts)}`) };
}
const pairs = (ts) => ts.flatMap((a, i) => ts.slice(i + 1).map((b) => [a, b]));
function playoffsFacts(s) {
  const field = s.teams.filter((t) => t.seed && t.seed <= s.playoffTeams).sort((a, b) => a.seed - b.seed), W = s.regWeeks + 1;
  return { season: s.year, playoff_teams: s.playoffTeams, rounds: Object.keys(s.periods || {}).map(Number).filter((wk) => wk > s.regWeeks && wk <= s.regWeeks + 3).map((wk) => `round ${wk - s.regWeeks}: NFL week${(s.periods[wk] || [wk]).length > 1 ? "s" : ""} ${(s.periods[wk] || [wk]).join(" and ")}`),
    first_round: s.matchups.filter((m) => m.wk === W && m.tier === "WINNERS_BRACKET" && m.a).map((m) => `${who(s.byId[m.h], W)} vs ${who(s.byId[m.a], W)}`),
    byes: (s.byes || []).filter((b) => b.wk === W && b.tier === "WINNERS_BRACKET").map((b) => who(s.byId[b.h], W)),
    teams: field.map((t) => bracketTeam(s, t)),
    head_to_head: pairs(field).map(([a, b]) => ({ teams: `${nameAt(a, W)} vs ${nameAt(b, W)}`, ...h2hBefore(mgrAt(a, W), mgrAt(b, W), s.year, W) })),
    panel: PANEL.map((p) => ({ name: p.name, role: p.role, style: p.style })) };
}
function ladderFacts(s) {
  const field = s.teams.filter((t) => !(t.seed && t.seed <= s.playoffTeams)).sort((a, b) => (a.seed || 99) - (b.seed || 99)), W = s.regWeeks + 1;
  return { season: s.year, how_it_works: "the teams that missed the playoffs play a consolation ladder; the loser of its final, the Bum Bowl, finishes last and pays the Marines a ฿25M fine",
    first_round: s.matchups.filter((m) => m.wk === W && m.tier === "LOSERS_CONSOLATION_LADDER" && m.a).map((m) => `${who(s.byId[m.h], W)} vs ${who(s.byId[m.a], W)}`),
    teams: field.map((t) => bracketTeam(s, t)), head_to_head: pairs(field).map(([a, b]) => ({ teams: `${nameAt(a, W)} vs ${nameAt(b, W)}`, ...h2hBefore(mgrAt(a, W), mgrAt(b, W), s.year, W) })),
    panel: PANEL.map((p) => ({ name: p.name, role: p.role, style: p.style })) };
}
let CARD_FACTS = null;
function teamFacts(s, id) {
  if (!CARD_FACTS || CARD_FACTS.year !== s.year) CARD_FACTS = { year: s.year, f: cardFacts(s) };
  const f = CARD_FACTS.f, t = s.byId[id], me = f.report_card.find((rc) => rc.team === who(t, s.regWeeks));
  return { season: s.year, teams: f.teams, champion: f.champion, last_place: f.last_place, next_season: f.next_season, league_format: f.league_format,
    final_standings: s.teams.slice().sort((a, b) => a.final - b.final).map((x) => `${x.final}. ${who(x, s.regWeeks)}`),
    // The namesakes of the awards this team won, any of whom may post about it
    award_namesakes: (() => { try { const { run } = require("./sitecode"); const won = JSON.parse(run(`JSON.stringify((() => { const s = S[${s.year}], a = seasonAwards(s), m = seasonMgrAwards(s), k = mgrAt(s.byId[${id}], 99);
        return [...Object.keys(a).filter((x) => a[x] && a[x].t && a[x].t.id === ${id}).map((x) => [x, a[x].p.n]), ...Object.keys(m).filter((x) => m[x] && m[x].ks.includes(k)).map((x) => [x, mgrName(k)])]; })())`));
      const x = won.filter(([k]) => NAMESAKES[k]).map(([k, who_]) => ({ character: NAMESAKES[k].name, handle: NAMESAKES[k].handle, style: NAMESAKES[k].style, award: NAMESAKE_AWARD[k], winner: who_ }));
      return x.length ? x : undefined; } catch { return undefined; } })(),
    team: me, other_report_cards_so_far: saved("team", s.year).filter((a) => a.card).map((a) => `${a.card.team}: ${a.card.grade}`) };
}
// Games a lineup call decided: a winner who benched a player who scored below zero (with the spot empty, or ESPN projecting
// him at least as high as the starter), so starting him would have tied or lost
// it (Sonny's empty D/ST spot in 2026 week 3, with the Eagles' -1 on his bench, beat Kai by 1), or a loser who left a spot
// empty with a bench player who'd have won it. Single-week games only.
const ELIG = { QB: ["QB"], RB: ["RB", "FLEX"], WR: ["WR", "FLEX"], TE: ["TE", "FLEX"], K: ["K"], "D/ST": ["D/ST"] };
function lineupTwists(s) {
  const need = {}; // a full lineup's spots: the most of each any team filled
  for (const wk in s.lineups) for (const id in s.lineups[wk]) { const c = {};
    for (const p of s.lineups[wk][id]) if (p.slot !== "BN" && p.slot !== "IR") c[p.slot] = (c[p.slot] || 0) + 1;
    for (const k in c) need[k] = Math.max(need[k] || 0, c[k]); }
  const out = [];
  for (const m of s.matchups.filter((x) => done(x) && x.a && x.win && spans(s, x.wk).length === 1)) {
    const margin = r1(Math.abs(m.hp - m.ap)), W = m.win, L = W === m.h ? m.a : m.h;
    for (const [id, won] of [[W, true], [L, false]]) {
      const ps = (s.lineups[m.wk] || {})[id] || [], st = ps.filter((p) => p.slot !== "BN" && p.slot !== "IR");
      const isEmpty = (k) => st.filter((p) => p.slot === k).length < (need[k] || 0);
      let best = null;
      for (const b of ps.filter((p) => p.slot === "BN")) for (const slot of ELIG[b.pos] || []) {
        const inSlot = st.filter((p) => p.slot === slot), empty = isEmpty(slot); if (!empty && !inSlot.length) continue;
        const out_ = empty ? null : inSlot.reduce((a, c) => (c.pts < a.pts ? c : a)), swing = r1(b.pts - (out_ ? out_.pts : 0));
        // A real call: the spot was empty, or ESPN projected the benched player at least as high as the starter
        const hit = (empty || (b.proj || 0) >= (out_.proj || 0)) && (won ? b.pts < 0 && -swing >= margin : empty && swing >= margin);
        if (hit && (!best || Math.abs(swing) > Math.abs(best.swing))) best = { b, out_, slot, empty, swing };
      }
      if (!best) continue;
      const { b, out_, slot, empty, swing } = best, opp = id === W ? L : W, verdict = Math.abs(swing) === margin ? "a tie" : won ? "a loss" : "a win";
      out.push({ wk: m.wk, teams: [id, opp], text: won
        ? `${who(s.byId[id], m.wk)} beat ${who(s.byId[opp], m.wk)} by ${margin} in week ${m.wk}${empty ? ` with nobody in the ${slot} spot` : ""}; ${b.n} (${b.pos}) scored ${b.pts} on his bench, and starting him${empty ? "" : ` over ${out_.n} (${out_.pts})`} would have made it ${verdict}`
        : `${who(s.byId[id], m.wk)} lost to ${who(s.byId[opp], m.wk)} by ${margin} in week ${m.wk} with nobody in the ${slot} spot, while ${b.n} (${b.pos}) scored ${b.pts} on his bench; starting him would have made it ${verdict}` });
    }
  }
  return out;
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
    final_standings: byFinal.map((t) => ({ finish: t.final, team: who(t, last), managers: (t.eras || [{ mgr: t.mgr }]).map((e) => mgr(e.mgr)).join(" then "), regular_season_record: `${rec[t.id].w}-${rec[t.id].l}`, points_for: r1(rec[t.id].pf), playoff_seed: t.seed, season_arc: seasonArc(s, t.id, s.regWeeks) })),
    playoff_games: playoffs,
    highest_single_week: `${who(hi.t, hi.wk)} ${hi.p} in week ${hi.wk}`, lowest_single_week: `${who(lo.t, lo.wk)} ${lo.p} in week ${lo.wk}`,
    trades: s.trades.length, notes: s.notes || [],
    // Flagged when the two teams finished within a game of each other on opposite sides of the playoff line or of last place
    lineup_twists: (() => { const x = lineupTwists(s).map((tw) => { const [a, b] = tw.teams.map((id) => s.byId[id]), gap = Math.abs(rec[a.id].w - rec[b.id].w);
      const line = !!a.seed !== !!b.seed || [a.final, b.final].includes(s.teams.length);
      return { game: tw.text, decided_the_race: gap <= 1 && line ? `${who(a, last)} and ${who(b, last)} finished within a game of each other${!!a.seed !== !!b.seed ? " with only one making the playoffs" : " with last place between them"}` : undefined }; });
      return x.length ? x : undefined; })(),
  };
}

// The NFL scoring plays of a fantasy game's weeks that involved its starters, in the order they happened
// (archive/plays_<year>.json, saved once by fetch.js). Extra points are left out as noise.
const playsFile = (y) => path.join(__dirname, "archive", `plays_${y}.json`);
function scoringSequence(s, m, sps) {
  const f = playsFile(s.year); if (!fs.existsSync(f)) return null;
  const P = JSON.parse(fs.readFileSync(f, "utf8")), out = [];
  const starters = [m.h, m.a].flatMap((id) => sps.flatMap((sp) => ((s.lineups[sp] || {})[id] || []).filter((e) => e.slot !== "BN" && e.slot !== "IR").map((e) => ({ ...e, sp, team: who(s.byId[id], m.wk) }))));
  const secs = (c) => { const [mm, ss] = String(c || "0:00").split(":").map(Number); return (mm || 0) * 60 + (ss || 0); };
  for (const sp of sps) for (const g of [...(P[sp] || [])].sort((a, b) => (a.start < b.start ? -1 : 1))) for (const pl of [...g.plays].sort((a, b) => a.q - b.q || secs(b.clock) - secs(a.clock))) {
    const text = String(pl.text || ""), main = text.replace(/\([^)]*\)/g, "");
    const who_ = starters.filter((e) => e.sp === sp && (e.pos === "D/ST" ? e.pro === pl.team && /Interception|Fumble Return|Punt Return|Kickoff Return|Safety|Blocked/i.test(text)
      : e.pos === "K" ? pl.type === "FG" && text.includes(e.n) : main.includes(e.n) || (/pass from/i.test(text) && text.includes(e.n))));
    if (!who_.length) continue;
    out.push({ nfl_week: sp, nfl_game: g.game, quarter: pl.q, play: text, fantasy_players: who_.map((e) => `${e.n} (${e.team})`) });
  }
  return out;
}
// A Buckaroo Bowl or Bum Bowl, for its wiki page: both teams' seasons and roads there, the game week by week
// and player by player, and (from 2026 on) the in-game timeline. Past seasons have no play-by-play, only each
// player's points per NFL week, so the order of events inside a week is unknown before then.
function gameFacts(s, kind) {
  const n = s.teams.length, bw = s.regWeeks + (s.playoffTeams >= 3 ? 2 : 1), lo = (m) => (m.win === m.h ? m.a : m.h);
  const m = kind === "bowl" ? s.matchups.find((x) => x.wk === bw && x.tier === "WINNERS_BRACKET" && done(x))
    : s.matchups.filter((x) => (x.wk === bw || x.wk === bw - 1) && x.tier === "LOSERS_CONSOLATION_LADDER" && done(x)).find((x) => s.byId[lo(x)].final === n);
  if (!m) return null;
  const rec = recordsThrough(s, s.regWeeks), sps = spans(s, m.wk).sort((a, b) => a - b), two = sps.length > 1;
  const at = (id, sp) => ((s.lineups[sp] || {})[id] || []);
  const isStart = (e) => e.slot !== "BN" && e.slot !== "IR";
  // A player's season so far for this team, as a starter (before this game)
  const seasonFor = (id, name) => { let pts = 0, n = 0; for (const sp in s.lineups) if (+sp < sps[0]) for (const e of at(id, sp)) if (e.n === name && isStart(e)) { pts += e.pts || 0; n++; } return n ? `${r1(pts)} points in ${n} starts (${r1(pts / n)} a start)` : "no earlier starts for this team"; };
  const topOf = (x, id) => { const per = {}; for (const sp of spans(s, x.wk)) for (const e of at(id, sp)) if (isStart(e)) per[e.n] = (per[e.n] || 0) + (e.pts || 0); const b = Object.entries(per).sort((a, c) => c[1] - a[1])[0]; return b ? `${b[0]} ${r1(b[1])}` : undefined; };
  const side = (id) => {
    const t = s.byId[id], per = {};
    for (const sp of sps) for (const e of at(id, sp)) { const x = (per[e.n] = per[e.n] || { player: `${e.n} (${e.pos}, ${e.pro})`, n: e.n, points: 0, projected: 0, by_week: {}, started: false }); x.points += e.pts || 0; x.projected += e.proj || 0; if (two) x.by_week[`week ${sp}`] = r1(e.pts || 0); if (isStart(e)) x.started = true; }
    const all = Object.values(per).map((x) => ({ player: x.player, points: r1(x.points), projected: r1(x.projected), by_week: two ? x.by_week : undefined, started: x.started, season_before: x.started ? seasonFor(id, x.n) : undefined }));
    const path = s.matchups.filter((x) => done(x) && x.wk > s.regWeeks && x.wk < m.wk && (x.h === id || x.a === id)).map((x) => ({ round: `${spans(s, x.wk).length > 1 ? "weeks" : "week"} ${spans(s, x.wk).sort((a, c) => a - c).join("-")}`, result: `${x.win === id ? "beat" : "lost to"} ${who(s.byId[x.h === id ? x.a : x.h], x.wk)} ${x.h === id ? x.hp : x.ap}-${x.h === id ? x.ap : x.hp}`, top_scorer: topOf(x, id) }));
    const series = s.matchups.filter((x) => done(x) && x.wk <= s.regWeeks && [x.h, x.a].includes(m.h) && [x.h, x.a].includes(m.a)).map((x) => `week ${x.wk}: ${x.win === id ? "won" : "lost"} ${x.h === id ? x.hp : x.ap}-${x.h === id ? x.ap : x.hp}`);
    const k = mgrAt(t, m.wk), titles = D.seasons.filter((z) => z.done && z.year < s.year && z.teams.some((u) => u.final === 1 && mgrAt(u, 99) === k)).map((z) => z.year);
    const odds = oddsAt(s, m.wk - 1, id);
    return { team: who(t, m.wk), manager: mgr(k), seed: t.seed, regular_season_record: `${rec[id].w}-${rec[id].l}`, regular_season_points: r1(rec[id].pf), final_finish: `${t.final} of ${n}`,
      title_chance_before_the_game: kind === "bowl" && odds != null ? `${Math.round(odds)}%` : undefined,
      road_here: path.length ? path : undefined, regular_season_meetings_this_year: series.length ? series : undefined, earlier_titles: titles.length ? titles : "none",
      score: id === m.h ? m.hp : m.ap, score_by_week: two ? Object.fromEntries(sps.map((sp) => [`week ${sp}`, r1(at(id, sp).filter(isStart).reduce((a, e) => a + (e.pts || 0), 0))])) : undefined,
      starters: all.filter((x) => x.started).sort((a, b) => b.points - a.points).map(({ started, ...x }) => x),
      bench: all.filter((x) => !x.started && x.points > 0).sort((a, b) => b.points - a.points).map(({ started, season_before, ...x }) => x) };
  };
  const W = side(m.win), L = side(lo(m));
  // After the first of two weeks, who led and by how much
  const halftime = two ? (() => { const a = W.score_by_week[`week ${sps[0]}`], b = L.score_by_week[`week ${sps[0]}`]; return `${a >= b ? W.team : L.team} led ${r1(Math.max(a, b))}-${r1(Math.min(a, b))} after week ${sps[0]}`; })() : undefined;
  // Earlier playoff meetings between the two managers
  const km = [mgrAt(s.byId[m.win], m.wk), mgrAt(s.byId[lo(m)], m.wk)], past = [];
  for (const z of D.seasons.filter((z) => z.year <= s.year)) for (const x of z.matchups.filter((x) => done(x) && x.tier && x.tier !== "NONE" && !(z === s && x === m))) {
    const a = mgrAt(z.byId[x.h], x.wk), b = mgrAt(z.byId[x.a], x.wk); if (km.includes(a) && km.includes(b) && a !== b) past.push(`${z.year}: ${mgr(mgrAt(z.byId[x.win], x.wk))} won ${Math.max(x.hp, x.ap)}-${Math.min(x.hp, x.ap)}`); }
  // In-game timeline (kept since week 7 of 2026): scoring plays and win chance as the game went
  const wp = (s.wp || {})[`${m.wk}-${m.h}-${m.a}`] || [];
  const nameOf = (side) => (side ? who(s.byId[m.h], m.wk) : who(s.byId[m.a], m.wk));
  const timeline = wp.filter((q) => q[4] && q[4].length).map((q) => ({ when_et: new Date(q[0]).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }),
    score: `${who(s.byId[m.h], m.wk)} ${r1(q[2])} - ${r1(q[3])} ${who(s.byId[m.a], m.wk)}`, home_win_chance: `${Math.round(100 * q[1])}%`,
    plays: q[4].map((pl) => `${pl[1]} (${nameOf(pl[0])}) ${pl[2] > 0 ? "+" : ""}${pl[2]}${pl[3] ? `, ${pl[3]}` : ""}`) }));
  const lowWin = wp.length ? `${Math.round(100 * Math.min(...wp.map((q) => (m.win === m.h ? q[1] : 1 - q[1]))))}%` : undefined;
  return {
    game: kind === "bowl" ? `Buckaroo Bowl ${["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][s.year - D.firstYear + 1] || s.year - D.firstYear + 1}` : `${s.year} Bum Bowl`,
    what_it_decided: kind === "bowl" ? "the league championship" : `last place: the loser finished ${n} of ${n}`,
    season: s.year, nfl_weeks: sps, two_week_total: two || undefined, score_after_first_week: halftime,
    winner: W.team, final_score: `${W.team} ${W.score} - ${L.score} ${L.team}`, margin: r1(Math.abs(m.hp - m.ap)),
    earlier_playoff_meetings_between_these_managers: past.length ? past : undefined,
    scoring_sequence: scoringSequence(s, m, sps) || undefined,
    play_by_play: timeline.length ? timeline : undefined,
    order_of_events: scoringSequence(s, m, sps) || timeline.length ? undefined : "unknown: don't invent the order of scoring within a week",
    lowest_win_chance_for_the_winner_during_the_game: lowWin,
    teams: [W, L],
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
- Use only the facts provided. Never invent scores, stats, injuries, trades, quotes from managers, or events. When manager_quotes are given, they are real: quote them word for word, as said to GLSN when asked the question in asked, and the posts can react to them. You may interpret and speculate about what the numbers mean.
- Call teams by their exact names as given. For managers, mix their first names and everyday nicknames from the lore interchangeably, the way friends talk, without explaining or making a bit of the nickname. Titles and joke labels (a league role, "the villain") are different: those count as running jokes. A "(name)" after a team is its manager.
- Never mention where anyone lives, works, studies, or serves beyond what the lore says.
- The league's win-chance model (the win chances, the Bounty Board and odds in the facts) is nicknamed Luffy, after the One Piece captain. Always call it Luffy, never "the model", as a name everyone already knows, not a bit to explain. Panelists and fans can have feelings about Luffy (Professor Clover trusts him, Shakky holds grudges when Luffy burns her), but don't give Luffy quotes or One Piece jokes in every story.
- The facts' ones_to_watch are the Bounty Board: the player on each team whose game swings the matchup most, named for One Piece's wanted posters. Call it the Bounty Board (a player is "on the board"), never Ones to Watch. On the site it is "presented by the Baratie" (Sanji's floating restaurant, a joke sponsor; mention it rarely, never as a real sponsorship). A pick who reaches his top line went Gear 5; one who finishes under his bottom line got Seastoned. Always use Gear 5 and Seastoned for these, never boom, bust, big game or dud.
- Money in the league's world is berries (฿), One Piece's currency. The panel bets berries on its picks (berries in season_picks; a lock risks the most, and backing an underdog pays more). Any of the four can mention who's up or down, but it's background: a passing line in some previews, never a storyline, and no one panelist's bit.
- The league's institutions have One Piece names, used now and then like the Baratie, never in every story: a vetoed trade is a Buster Call (the trade got Buster Called); the waiver wire and free agency are Impel Down (a dropped player is sent to Impel Down, a pickup breaks him out); draft night is the Reverie; the league office and commissioner rulings are the World Government; the Marines enforce the rules (they collect the Bum Bowl fine). They're nicknames everyone already knows, not bits to explain.
- Spread fan attention around the league: across a story's posts, react to several teams, not the same one or two, and don't pile on the same team week after week unless it really is the story (a long losing streak earns some trolling, not all of it). Every fan base gets its moments, good and bad.
- The league's coverage comes from GLSN, the Grand Line Sports Network, a made-up sports network. Its staff are parody versions of One Piece characters, written in their style but never quoting lines from the series: ${STAFF.map((p) => `${p.name} (${p.handle}), ${p.role.toLowerCase()}, covers ${p.beat}: ${p.voice}`).join("; ")}.
- Social posts come from fictional accounts only: made-up fans, team fan clubs, pundits, GLSN and its staff. Never write as, or tag, real NFL players, journalists, or celebrities.
- Most social posts come from fans and pundits. Add 1 to 3 posts from the league's verified accounts, written the way real clubs and reporters post, like the news feed in Football Manager:
  - kind "league": Buckaroo Football League (@BuckarooFL), neutral and official: results, milestones, standings.
  - kind "team": a team's official account, named after the team, with its exact team name in the team field and the handle listed for it under Current teams. On-brand and upbeat, like a club: matchday results, player of the week, "welcome to the club" after a trade. Never written as the manager.
  - kind "network": GLSN (${GLSN.handle}), the network's official account, posting like a real sports network: 🚨 BREAKING alerts, finals, a stat of the week written out as a graphic would read, and story links that credit the writer's handle ("📰 New from @...").
  - kind "reporter": a GLSN writer or panelist, by name and handle. The writers are listed above; the preview panel (pundits who pick games, not writers) is ${PANEL.map((p) => `${p.name} (${p.handle}), ${p.role.toLowerCase()}: ${p.style}`).join("; ")}. They tweet like real reporters and TV analysts: the story's own writer usually shares it with a take, and the others chime in with opinions, hot takes, disagreements with each other and the odd reply to a fan. In a preview with a guest, the guest may post too, as kind "pundit" with their handle (${GUESTS.map((g) => `${g.name} ${g.handle}`).join(", ")}); guests never post in other weeks.
  - Keep the same name and handle for the same account every time. Set team to "" for every post that isn't kind "team".
- Each social post has a "heat" from 1 to 10: how likely it is to blow up online, which is about how inflammatory or funny it is, not how important the news is. Official accounts (league, team, network) are 1 to 3 however big the news: they report it, they don't go viral. GLSN staff (reporter) are 1 to 6: they have opinions. Fans and pundits run the range: most are 2 to 5, a sharp dunk or hot take 6 or 7, and rage bait, trolling, unhinged takes, brutal one-liners and the dumbest possible jokes 8 to 10. Give at most one post 8 or more per story or live update; when something embarrassing or dramatic just happened (a dud, a fumble, a benched star going off, a blown lead), a troll is usually worth it.
- Each social post has a "when": the minutes before (negative) or after the story goes up that it was posted, from -2880 to 2880. Spread them out like a real timeline: live reactions during the games come before a recap, takes and replies after, official accounts at sensible hours, and fans whenever they feel it, including the middle of the night (a 3 AM rant after a bad beat is on brand).
- A player marked "on bye" or "did not play" scored nothing because he didn't play. Say so plainly; never treat it as a bad game or a bust. Starting one is the manager's lineup mistake, not the player's.
- Running jokes and nicknames are seasoning, not the meal. Use any one bit at most once in a story, leave most of them out of most stories, and never make the same joke the punchline two stories in a row. A manager is more than their running joke: describe what they actually did this week first. Labels count as running jokes too: don't cast anyone as the league's villain, punching bag, or hothead by default. Use a label like that at most once in a story, and leave it out of most stories.
- Plain text only, no markdown. Body paragraphs should be 2 to 5 sentences each.

League background:
${leagueBackground()}

The people and the inside jokes (from the league; follow its own rules too):
${LORE}`;

// ---------- Output shapes ----------
const str = { type: "string" };
const SOCIAL = { type: "array", items: { type: "object", additionalProperties: false, required: ["author", "handle", "text", "kind", "team", "when", "heat"], properties: { author: str, handle: str, text: str, when: { type: "integer" }, heat: { type: "integer" },
  kind: { type: "string", enum: ["fan", "pundit", "reporter", "network", "team", "league"] }, team: str } } };
const ARTICLE = { title: str, dek: str, body: { type: "array", items: str } };
const schemas = {
  recap: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social", "bios", "trade_watch", "awards"], properties: { ...ARTICLE, social: SOCIAL,
    trade_watch: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "take"], properties: { id: str, take: str } } },
    awards: { type: "array", items: { type: "object", additionalProperties: false, required: ["award", "winner", "blurb"], properties: { award: str, winner: str, blurb: str } } },
    bios: { type: "array", items: { type: "object", additionalProperties: false, required: ["team", "bio"], properties: { team: str, bio: str } } } } },
  trade: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social"], properties: { ...ARTICLE, social: SOCIAL } },
  veto: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social"], properties: { ...ARTICLE, social: SOCIAL } },
  review: { type: "object", additionalProperties: false, required: ["title", "dek", "body"], properties: ARTICLE },
  card: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "cards", "social"], properties: { ...ARTICLE, social: SOCIAL,
    cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["team", "grade", "headline", "summary", "strengths", "weaknesses", "verdict", "management", "subgrades", "fix"], properties: {
      team: str, grade: str, headline: str, summary: str, strengths: { type: "array", items: str }, weaknesses: { type: "array", items: str },
      verdict: { type: "string", enum: ["Well managed", "Over-managed", "Under-managed", "Mismanaged"] }, management: str,
      subgrades: { type: "array", items: { type: "object", additionalProperties: false, required: ["area", "grade", "note"], properties: { area: { type: "string", enum: ["Draft", "Waivers", "Trades", "Lineups"] }, grade: str, note: str } } },
      fix: { type: "array", items: str } } } } } },
  playoffs: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "panel", "social"], properties: { ...ARTICLE, social: SOCIAL,
    panel: { type: "array", items: { type: "object", additionalProperties: false, required: ["panelist", "champion", "runner_up", "take"], properties: { panelist: str, champion: str, runner_up: str, take: str } } } } },
  ladder: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "panel", "social"], properties: { ...ARTICLE, social: SOCIAL,
    panel: { type: "array", items: { type: "object", additionalProperties: false, required: ["panelist", "last_place", "take"], properties: { panelist: str, last_place: str, take: str } } } } },
  grades: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "grades", "social"], properties: { ...ARTICLE, social: SOCIAL,
    grades: { type: "array", items: { type: "object", additionalProperties: false, required: ["team", "grade", "headline", "blurb"], properties: { team: str, grade: str, headline: str, blurb: str } } } } },
  class: { type: "object", additionalProperties: false, required: ["title", "dek", "chapters"], properties: { title: str, dek: str,
    chapters: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: str, body: { type: "array", items: str } } } } } },
  bowl: { type: "object", additionalProperties: false, required: ["title", "dek", "chapters"], properties: { title: str, dek: str,
    chapters: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: str, body: { type: "array", items: str } } } } } },
  draft: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social"], properties: { ...ARTICLE, social: SOCIAL } },
  preview: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "picks", "social"], properties: { ...ARTICLE, social: SOCIAL,
    picks: { type: "array", items: { type: "object", additionalProperties: false, required: ["game", "panel"], properties: { game: str,
      panel: { type: "array", items: { type: "object", additionalProperties: false, required: ["panelist", "pick", "confidence", "take"], properties: {
        panelist: { type: "string", enum: [...PANEL, ...GUESTS].map((p) => p.name) }, pick: str, confidence: { type: "string", enum: ["lean", "confident", "lock"] }, take: str } } } } } } } },
  final: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "social"], properties: { ...ARTICLE, social: SOCIAL } },
  rankings: { type: "object", additionalProperties: false, required: ["title", "dek", "body", "power_rankings"], properties: { ...ARTICLE,
    power_rankings: { type: "array", items: { type: "object", additionalProperties: false, required: ["rank", "team", "blurb"], properties: { rank: { type: "integer" }, team: str, blurb: str } } } } },
  history: { type: "object", additionalProperties: false, required: ["title", "dek", "chapters"], properties: { title: str, dek: str,
    chapters: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: str, body: { type: "array", items: str } } } } } },
  profile: { type: "object", additionalProperties: false, required: ["headline", "body"], properties: { headline: str, body: { type: "array", items: str } } },
};
schemas.regseason = schemas.grades;
schemas.team = { type: "object", additionalProperties: false, required: ["title", "dek", "chapters", "card", "social"], properties: { title: str, dek: str, social: SOCIAL,
  chapters: schemas.bowl.properties.chapters, card: schemas.card.properties.cards.items } };
const asks = {
  recap: "Write the weekly recap for this week of the Buckaroo Football League: a headline, a one-sentence dek, and 5 to 8 body paragraphs covering the results (lead with the best storyline), standout and disappointing performances (a game's ones_to_watch show who had a Gear 5 or got Seastoned), the standings and title-odds picture, notable moves (a waiver pickup who's producing, or one flipped into a trade, and the waiver_king_race for the Wapol award are fair game when they make a story, without overdoing it; a pickup's reunions, a player back with a manager who had him before, can be a line too), and a look ahead to next week (if next_week_ones_to_watch is given, name a player or two whose game swings a matchup most, or a QB-receiver stack, without their percentages). Then write 6 to 10 social posts reacting to the week, and a fresh 2 to 3 sentence bio for every team in the standings that sums up where its season stands right now (use the exact team name in the team field). Finally, the trade watch: quick 1 to 2 sentence takes on how earlier trades in trade_watch are aging, for the 2 to 5 deals with the most to say this week (a deal that looked lopsided flipping, a player who carried his new team or sat on its bench, a winner pulling further ahead). These are quick hot takes, not articles; say how it looks now compared with before. Use the trade's id from the facts. If there are no trades yet, leave it empty. Then the week's awards: one entry for each award in the facts' awards (award is its name in title case, like 'Manager of the Week'; the player of the week is the Karoo's Player of the Week, named for Princess Vivi's racing duck; winner is who won it, short), with a one or two sentence blurb. The winners are already decided; don't change them. When playoff_picture is given, work any clinch, elimination or big stakes into the recap. If if_the_playoffs_started_today is given, one post is the league's account (kind league) laying out those matchups and the first team out, exactly as given, in the plain style of an official account. one of the social posts comes from that award's namesake (the character, using the handle given, kind pundit, heat 2 to 5), in character (style), weighing in on the race for the award named after them the way a legend does about his own award: a nod to the leader, a dig at a challenger, a reaction to this week; short, a parody that never quotes the series. missing_stars are players a team is without right now: worth a line when his absence showed this week (his replacement flopped, the team lost without him) and a fan post or two can miss him, without making every team's injuries a theme.",
  trade: "Write a trade reaction story: a headline, a one-sentence dek, and 3 to 5 body paragraphs explaining the deal, what each side got, and who won it on paper (use the title and playoff odds change; if the before odds are missing, use only the odds after and don't call them pre-trade). reunion says when a player is back with a manager who had him before (and former_managers lists his past stops): a homecoming is a storyline worth a line. how_the_other_side_got_him says where each player came from: a waiver claim or free-agent pickup flipped into a trade, a late draft pick turned trade chip, or a player traded twice is a storyline worth a line (who found him, what he turned into), without overselling it. Judge each player on season_points_before_trade, every week he played: a player who scored as a free agent (points_as_free_agent_before_trade) was producing even off a roster, so don't treat his roster points or weeks on a roster as his whole season, and say so when it changes the read; last_three_weeks shows his recent form. Then write 3 to 5 social posts reacting to it.",
  veto: "Breaking news: a trade both teams agreed to was vetoed, so it never happened: a Buster Call, and the headline should say so (BUSTER CALL). Write it like an NFL insider's bombshell: a punchy headline, a one-sentence dek, and 2 to 4 short body paragraphs: the deal that almost was (who would have gone where, using each player's season and recent form), who would have won it on paper, and what the veto leaves each team with (record, odds now). When voted_to_veto is given, name who voted it down and who didn't (did_not_vote_to_veto); that's the scoop. Otherwise don't say who vetoed it. Don't say why unless the facts say so; the league's reaction can speculate, the story can't. Then 4 to 6 social posts: the first is Absalom breaking it (reporter, the insider; a terse 'sources' style scoop with a siren or two, when about -3), then GLSN's 🚨 BUSTER CALL alert, then the two teams' official accounts (on-brand, putting a brave face on it or saying nothing of substance), the league account (dry and official, 1 or 2 heat), and fans arguing about whether the veto was fair; a veto is the kind of thing fans get loud about.",
  profile: "Write a career profile of this manager for their page on the league website, like a club history page in Football Manager: a short headline that captures who they are in this league, and 3 to 5 body paragraphs telling the story of their whole run: each season, the highs and lows, rivalries from the head-to-head records, their habits as a manager (trades, waiver moves), and where they stand right now. Use their nicknames and the lore, as seasoning on top of what actually happened.",
  draft: "Write the draft-day story for this season's Buckaroo Football League draft (the Reverie, as the league calls draft night), as if written the night of the draft, before any games: a headline, a one-sentence dek, and 5 to 7 body paragraphs covering the first round and draft order, each manager's strategy and haul, position runs, keepers, and the picks that look like reaches or values. Judge picks only by where players went relative to each other, each team's roster build and the draft order; you know nothing about how the season has gone since, and don't cite stats or projections that aren't in the facts. Then write 4 to 8 social posts reacting to the draft, including official team accounts welcoming their first-round picks.",
  rankings: "Write this week's Buckaroo Football League power rankings, the way NFL.com publishes them every Tuesday: a headline, a one-sentence dek, a 1 to 2 paragraph intro on what moved the rankings this week, then every team ranked 1 to N (use the exact team name, without the manager). Each team gets a 2 to 4 sentence write-up in the NFL.com style: what happened this week, what's working or what's broken, and what's next, with a line on why it rose or fell from last_week_rank when there is one. They're the newsroom's opinion, not the standings: weigh record, points, form, the odds and how the team looks right now, and it's fine to rank a team above one with a better record if you can say why.",
  preview: "Write the weekly preview for this week of the Buckaroo Football League, like a network's pregame show, going up two hours before the week's first NFL game: a headline, a one-sentence dek, and 3 to 5 body paragraphs on the week's best storylines. Lead with stories, not numbers: rivalries and head-to-head history, momentum (streaks, last_three, last_three_scores: who's surging, who's sliding), new faces from recent trades, notable position-versus-position matchups between the two starting lineups (a QB duel, a team's receivers against the other's backfield), the stakes in the standings, a sleeper or underrated player who could swing a game, and now and then a revenge game. revenge_games has the week's best one, if any (a starter facing a manager who used to have him); they pile up in a league of friends, so give it a line at most, or skip it, never as the headline or a game's main storyline, and leave out other reunions and former-team trivia. A homecoming from recent_trades can get a line, not a paragraph. Numbers are seasoning: at most one win chance per game, stated once, and say playoff stakes in words (a loss drops him out of the playoff spots, a win nearly locks it up) rather than listing odds. Name the Bounty Board picks as the players who decide a game, without their percentages or point thresholds. The win chances assume each manager fills the spots in spots_to_fill (starters on bye or ruled out) with his best bench player, as nearly everyone does by Sunday; treat them as the real numbers, and don't build the headline, a storyline, a pick or a post around an unfilled spot (a passing clause at most). Then the panel's picks: for every game in games (use its game text exactly), each of the four panelists picks a winner (the exact team name, without the manager), a confidence (lean, confident or lock). Any panelist can lock: Shakky locks the most but not every game, and the other three lock now and then, each for their own reasons, not only when the numbers say so; a gut call, something Brannew heard, a grudge or an upset lock can all happen (a revenge game only rarely). Most weeks someone besides Shakky locks at least one game, but not every panelist every week. Each pick comes with a 1 to 3 sentence take in the panelist's own voice. Professor Clover is the stats voice: he is the one who cites the win chances, Bounty Board lines and odds. The other three argue from momentum, matchups, history, grudges and gut, with few or no percentages. If guest is given, that guest joins the panel this week and also picks every game in character (panelist is the guest's exact name; any confidence, a lock included), and the body introduces them in a sentence by their epithet as this week's guest (a special guest for a playoff legend, which should feel like an event; a proper welcome on first_appearance, a welcome back otherwise). Guests are parody versions of One Piece characters: write them in their style from guest.style, short and funny, without quoting lines from the series; the regular four can react to them. Across the panel, somebody should flag an underrated pick or sleeper. Picks should disagree sometimes, and panelists can needle each other or bring up their season_picks record. Then 5 to 8 social posts, all posted after the story goes up and before the week's first kickoff two hours later (when 0 to 100): panelists hyping their lock, and fans reacting to a specific panelist's take on their team, annoyed or gloating, the way fanbases do online. Fans may only quote or paraphrase what a panelist actually said in this preview.",
  final: "Write the Sunday final word for this week of the Buckaroo Football League: a short pregame update going up after the NFL inactives, just before the 1pm games, following up on Thursday's preview (preview_title). A headline, a one-sentence dek, and 2 to 3 short body paragraphs on what changed since the preview: lineup moves (moved_into_lineup, moved_out, moves_since_preview), how the win chances moved from home_win_chance_at_preview to home_win_chance_now (only where it moved enough to matter, and keep the numbers few), and what the players who already_played did for their teams. unfilled_spots are starters on bye or ruled out still in a lineup an hour before kickoff, and those are real news now: say who hasn't fixed it, and what it costs (home_win_chance_now as set against home_win_chance_if_filled). If nothing much changed, keep it short and say so; don't invent drama. A panelist can stand by a pick or flip it in a line, in their own voice. If manager_quotes are given, work each one into the body as the manager's answer to GLSN; if a quote has then, he went back on it, and the body and posts should have fun with that. Then 3 to 5 social posts, all posted after the story goes up and before kickoff (when 0 to 75): fans and panelists reacting to the late news.",
  history: "Write the official history of the Buckaroo Football League for the front of its trophy room, like a club history in Football Manager or a long-form feature: a headline, a one-sentence dek, and 4 to 6 chapters, each with a short heading and 2 to 4 paragraphs. Tell it as one story across the seasons: how it started, each Buckaroo Bowl and what decided it, dynasties and droughts, rises and collapses, the rivalries the head-to-head records reveal, and the moments people still bring up. End with a short chapter that sets up the present (from since_then, without any of its results). Every number must come from the facts.",
  class: "Write the induction story for this class of Laugh Tale, the league's Hall of Fame, the way a Hall of Fame covers its enshrinement class, in the voice of the league's wiki: the title is just the class name (the class field), a one-sentence dek, then sections with short headings. Open with the class as a whole (who's in, what ties them together, the seasons it covers, the ranks they enter at). Then one section per inductee in the order given, the heading just his name, 1 to 3 paragraphs on why he belongs: the moments behind each of his ways_in, his numbers, who he won with or for, and what he meant to the league's story. Close with a short section that puts the class in the league's history. Use only the facts; never invent games, quotes or moments. Players' points cover their whole BFL career so far.",
  bowl: "Write a thorough encyclopedia article about this game for the league's wiki, the way Wikipedia covers a Super Bowl: the title is just the game's name (the game field), a one-sentence dek, and 5 or 6 sections, each with a short heading and 2 to 4 paragraphs: Background (both teams' seasons: records, seeds, points, title chances going in, regular-season meetings, earlier titles and playoff history between these managers); Road to the game (each team's earlier playoff games and who carried them); Game summary (for a two-week total, a part for each NFL week: the score after the first week, who drove it, how the second week changed or settled it; scoring_sequence lists the NFL scoring plays involving these starters in the order they happened: tell the game through its key moments (who opened the scoring, the swings, the plays that put it away), not every play, and never give clock times; play_by_play, when present, adds the live win chance; with neither, never invent the order of scoring within a week); Key performers (stars against their projection and their season averages, flops, bench points that would have changed the result); and Aftermath (what it meant: a first or repeat title and where it puts the manager in league history, or last place and the Bum Bowl's shame). Encyclopedic: third person, past tense, specific numbers, no social posts, the league's personality in a light touch. Never mention what isn't recorded or how the site keeps its data; just tell what is known. Use only the facts given.",
  card: "Write the league's postseason report card for this season, published a week after the Buckaroo Bowl: a headline, a one-sentence dek and 3 to 4 body paragraphs on how the season played out across the league and what it says about how this league is won. Then a detailed card for every team in report_card (use the exact team name), in finishing order: a season letter grade (A+ to F with plus and minus, the full range: the champion and a dominant team near the top, a team that collapsed or never showed up can get a D or F), a punchy headline, and a 4 to 6 sentence summary of the whole season, playoffs or consolation ladder included. Then strengths and weaknesses: 2 to 4 short, specific points each, built on the numbers (position_groups ranks, top_starters, luck, points for rank, how it finished). Then the management review: a verdict (over-managed for a manager whose churn and trades cost him, under-managed for one who sat still while holes stayed open or left points on the bench, well managed, or mismanaged for one who got the big calls wrong) with a 3 to 5 sentence take on how he ran the team, and a sub-grade with a one-sentence note for each of draft (points_as_starters_from_own_picks, his first picks and best value pick), waivers (adds against the league average and what the pickups scored), trades (what came in against what went out) and lineups (efficiency, points left against the best lineup, losses the bench would have flipped). Compare each manager with the rest of the league, not in a vacuum. Then fix: 2 to 4 concrete things to change heading into next season (next_season). This is a redraft league, so no player carries over: the fixes are about approach (draft strategy and which positions to prioritize, how actively to work the wire, trading habits, lineup decisions), never about keeping or building around specific players. Mention awards in awards where they help tell the story. When regular_season_grades is given, say when a team's grade moved since then and why. Be honest and specific; praise and criticism both land harder with a number behind them. Then 4 to 6 social posts reacting to the grades. season_arc is each team's playoff odds at its high and low points: use it only where it's really part of a team's story (a hot start that fell apart, a climb from nowhere), naturally and not for every team; a play on a team's name only if it lands on its own.",
  regseason: "Write the regular season review, going up the Wednesday after the last regular-season week: a headline, a one-sentence dek and 5 to 7 body paragraphs on how the regular season played out: the race for the playoff spots and the No. 1 seed, the teams that surprised and disappointed, the standout players and managers, the trades that shaped it, and who goes into the playoffs (playoff_field) and the consolation ladder (consolation_ladder). Keep it balanced: every team gets its due somewhere, nothing is the whole story, and no single fact or player is hammered. Then a regular-season grade for every team in report_card (use the exact team name): a letter grade (A+ to F with plus and minus, the full range), a punchy headline and a 2 to 3 sentence blurb built on the numbers (record, points and their rank, luck from expected_wins_from_scoring, last_five, draft-day odds against now, trades and pickups). Then 4 to 6 social posts reacting to the review and its grades. season_arc is each team's playoff odds at its high and low points: use it only where it's really part of a team's story (a hot start that fell apart, a climb from nowhere), naturally and not for every team; a play on a team's name only if it lands on its own.",
  playoffs: "Write the playoff preview as the bracket is set, like a network's postseason preview: a headline, a one-sentence dek and 4 to 6 body paragraphs: the field and how each team got here, the first-round matchups (first_round, and any byes), the paths to the Buckaroo Bowl, the players who decide it, head-to-head history worth knowing, and Luffy's title odds (title_odds) said once, in passing. Then each of the four panelists predicts the champion and the runner-up (exact team names, without the manager) with a 2 to 3 sentence take in their own voice; they should disagree some, and Professor Clover is the one who leans on the numbers. Then 4 to 6 social posts: fans of the playoff teams talking themselves into a title, and panelists hyping their pick.",
  ladder: "Write the Bum Bowl preview as the consolation ladder is set, in a lighter, mock-serious tone: a headline, a one-sentence dek and 3 to 5 body paragraphs on the teams that missed the playoffs, how the ladder works (how_it_works), the first-round matchups, who's most at risk of finishing last (last_place_odds, said once, in passing) and what's at stake: pride, the ฿25M fine to the Marines, and a season remembered for the wrong reason. Keep it good-natured, roasting the managers' seasons rather than piling on any one thing. Then each of the four panelists predicts who finishes last (exact team name, without the manager) with a 1 to 2 sentence take in their own voice. Then 3 to 5 social posts, the trash talk of teams trying not to be last.",
  team: "Write this team's season in review, the way a network publishes one for each team as its season ends (worst first, the champion last): a headline, a one-sentence dek, then 4 to 6 chapters with short headings, each 1 to 3 paragraphs, covering how the season unfolded from the draft to its last game (the turning points, playoffs or consolation ladder included), what went right and what went wrong, its most valuable player and its biggest move, and a look ahead to next season. Every number comes from team (its report card facts) and the league context; no one fact should dominate. Then its report card (card): a season letter grade (A+ to F with plus and minus, the full range, compared with the rest of the league; other_report_cards_so_far are the grades already given), a punchy headline, a 4 to 6 sentence summary, 2 to 4 strengths and weaknesses built on the numbers (position_groups, top_starters, luck, points for rank, how it finished), the management verdict (over-managed, under-managed, well managed or mismanaged) with a 3 to 5 sentence take, a sub-grade with a one-sentence note for each of draft, waivers, trades and lineups, and 2 to 4 fixes for next season (this is a redraft league, so they're about approach, never about keeping players). Then 3 to 5 social posts: the team's fans and rivals reacting to the review; if award_namesakes is given, one of those namesakes may post too (the character, the handle given, kind pundit), in character, congratulating the winner the way a legend welcomes someone into his company, or for Buggy, Ace and Foxy gleefully welcoming them to the hall of shame; a parody that never quotes the series. season_arc is each team's playoff odds at its high and low points: use it only where it's really part of a team's story (a hot start that fell apart, a climb from nowhere), naturally and not for every team; a play on a team's name only if it lands on its own.",
  grades: "Write the league's report card at the stage given (stage): a headline, a one-sentence dek, 2 to 3 body paragraphs on the big picture, then a letter grade for every team in report_card (use the exact team name; A+ to F with plus and minus), each with a short punchy headline and a 2 to 4 sentence blurb that explains the grade. Grade each team against what it was expected to do (title and playoff odds on draft day) and how it actually played, not on the record alone: weigh points scored and their rank, luck (wins minus expected wins from scoring; a lucky record earns less credit, an unlucky one some sympathy), how the season finished (last_five), and the manager's moves (trades and pickups) where they mattered. Use the full range: a clear best gets an A, a team that collapsed or never showed up can get a D or F, and most land in between. At the end of the season (stage mentions playoffs), grade the whole season with the postseason weighed heavily: the champion is graded on winning it all, a playoff team that flopped drops, the consolation ladder counts too, and last place (the Bum Bowl loser) takes a hit; regular_season_grades are the grades from the end of the regular season, so say when a grade moved and why. Then 4 to 6 social posts reacting to the grades. season_arc is each team's playoff odds at its high and low points: use it only where it's really part of a team's story (a hot start that fell apart, a climb from nowhere), naturally and not for every team; a play on a team's name only if it lands on its own.",
  review: "Write a season-in-review story for this finished season: a headline, a one-sentence dek, and 5 to 7 body paragraphs telling the story of the season from draft to Buckaroo Bowl, including the champion, the last-place finisher, the playoff games, and any notable notes. lineup_twists are games a lineup call decided (a winner whose benched player would have cost him the game, or a loser who left a spot empty); when one has decided_the_race, that game is part of how the race was settled and deserves a line, told with a straight face; skip the others unless they make a great story. season_arc is each team's playoff odds at its high and low points: use it only where it's really part of a team's story (a hot start that fell apart, a climb from nowhere), naturally and not for every team; a play on a team's name only if it lands on its own.",
};

// ---------- What still needs writing ----------
function pending() {
  const have = new Set(fs.existsSync(NEWS) ? fs.readdirSync(NEWS).map((f) => f.replace(/\.json$/, "")) : []);
  const todo = [];
  // Each Buckaroo Bowl and Bum Bowl gets a wiki article once its season is done
  for (const s of D.seasons.filter((x) => x.done)) for (const kind of ["bowl", "bum"]) if (!have.has(`${kind}-${s.year}`) && gameFacts(s, kind) && (kind === "bum" || fs.existsSync(playsFile(s.year)))) todo.push({ id: `${kind}-${s.year}`, type: "bowl", s, wk: 98, facts: () => gameFacts(s, kind) });
  // Each Laugh Tale class gets an induction story, from the site's own Hall of Fame code (sitecode.js)
  try { const { run } = require("./sitecode");
    for (const c of JSON.parse(run("JSON.stringify(ltClasses())"))) if (!have.has(`class-${c}`)) { const y = c === "founding" ? JSON.parse(run("LT.founded")) : +c;
      if (S[y]) todo.push({ id: `class-${c}`, type: "class", s: S[y], wk: 102, facts: () => JSON.parse(run(`JSON.stringify(ltClassFacts(${JSON.stringify(c)}))`)) }); } }
  catch (e) { console.log(`::warning::Laugh Tale classes skipped: ${e.message}`); }
  for (const s of D.seasons.filter((x) => x.done)) if (!have.has(`review-${s.year}`)) todo.push({ id: `review-${s.year}`, type: "review", s, wk: 99, facts: () => reviewFacts(s) });
  const cur = D.seasons.filter((x) => !x.done).slice(-1)[0] || null;
  // The week's preview two hours before the week's first NFL kickoff (Thursday 6pm ET when the kickoff
  // times aren't known), and the Sunday final word from 75 minutes before the first game at noon ET or later
  if (cur) {
    const W = cur.curWeek, ms = cur.matchups.filter((m) => m.wk === W && m.a), now = Date.now(), kicks = (cur.kicks || []).map(Date.parse);
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })), day = et.getDay(), hr = et.getHours();
    const first = kicks[0], sunday = kicks.find((k) => { const d = new Date(new Date(k).toLocaleString("en-US", { timeZone: "America/New_York" })); return d.getDay() === 0 && d.getHours() >= 12; });
    const previewDue = first ? now >= first - 2 * 3600e3 : (day === 4 && hr >= 18) || day === 5 || day === 6 || day === 0;
    const before = ms.length && ms.every((m) => m.live && m.psim != null && !m.hp && !m.ap);
    if (previewDue && before && !have.has(`preview-${cur.year}-${W}`)) todo.push({ id: `preview-${cur.year}-${W}`, type: "preview", s: cur, wk: W - 0.4, facts: () => previewFacts(cur, W) });
    const finalDue = sunday && now >= sunday - 75 * 60e3 && now < sunday;
    if (finalDue && ms.length && ms.every((m) => m.live) && have.has(`preview-${cur.year}-${W}`) && !have.has(`final-${cur.year}-${W}`)) todo.push({ id: `final-${cur.year}-${W}`, type: "final", s: cur, wk: W - 0.2, facts: () => finalFacts(cur, W) });
  }
  // Power rankings for every finished week; the newest is released Tuesday 9am ET (or on a manual run)
  if (cur) {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })), day = et.getDay(), hr = et.getHours();
    const finished = [...new Set(cur.matchups.map((m) => m.wk))].filter((w) => w <= cur.regWeeks && cur.matchups.filter((m) => m.wk === w).every(done)).sort((a, b) => a - b);
    const newest = finished[finished.length - 1];
    const released = !(day === 1 || (day === 2 && hr < 9)) || (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.CHAINED !== "true");
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
    // Vetoed trades: only fresh ones (within two days), so a veto found late doesn't read as breaking news
    for (const v of cur.vetoed || []) { const id = vetoId(cur, v); if (!have.has(id) && Date.now() - new Date(v.at) < 2 * 864e5) todo.push({ id, type: "veto", s: cur, wk: v.wk, tr: v, at: v.at, facts: () => vetoFacts(cur, v) }); }
  }
  // Report cards: when the regular season's games are final, and again once the season is done (2026 on)
  for (const z of D.seasons.filter((x) => x.year >= 2026)) {
    const regDone = z.matchups.filter((m) => m.wk <= z.regWeeks && m.a).every(done) && z.matchups.some((m) => m.wk === z.regWeeks);
    // The regular season review (with every team's grade), then the playoff and Bum Bowl previews once the first round is set
    if (regDone && !have.has(`regseason-${z.year}-reg`)) todo.push({ id: `regseason-${z.year}-reg`, type: "regseason", stage: "reg", s: z, wk: z.regWeeks + 0.7, facts: () => regseasonFacts(z) });
    const set = (tier) => z.matchups.some((m) => m.wk === z.regWeeks + 1 && m.tier === tier && m.a);
    if (regDone && set("WINNERS_BRACKET") && !have.has(`playoffs-${z.year}-bracket`)) todo.push({ id: `playoffs-${z.year}-bracket`, type: "playoffs", s: z, wk: z.regWeeks + 0.8, facts: () => playoffsFacts(z) });
    if (regDone && set("LOSERS_CONSOLATION_LADDER") && !have.has(`ladder-${z.year}-bracket`)) todo.push({ id: `ladder-${z.year}-bracket`, type: "ladder", s: z, wk: z.regWeeks + 0.85, facts: () => ladderFacts(z) });
    // Each team's season in review once the season is done, worst to best, one a day from the Tuesday after the Bowl
    if (z.done) for (const t of [...z.teams].sort((a, b) => b.final - a.final)) { const id = `team-${z.year}-${t.id}`, lastWk = Math.max(...z.matchups.map((m) => m.wk));
      const due = natural({ id, type: "team", year: z.year, wk: lastWk, place: t.final, n: z.teams.length }, z.periods);
      if (!have.has(id) && due && due <= new Date()) todo.push({ id, type: "team", s: z, wk: lastWk, tid: t.id, place: t.final, facts: () => teamFacts(z, t.id) }); }
  }
  // The postseason report card (2023-2025): every finished season, going up a week after its Buckaroo Bowl. From 2026 the
  // Report Cards page is put together from the team reviews instead (cardIndex), without another story
  for (const z of D.seasons.filter((x) => x.done && x.year < 2026)) { const lastWk = Math.max(...z.matchups.map((m) => m.wk)), due = natural({ id: `card-${z.year}`, type: "card", year: z.year, wk: lastWk }, z.periods);
    if (!have.has(`card-${z.year}`) && due && due <= new Date()) todo.push({ id: `card-${z.year}`, type: "card", s: z, wk: lastWk, facts: () => cardFacts(z) }); }
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
  return fs.readdirSync(NEWS).map((f) => JSON.parse(fs.readFileSync(path.join(NEWS, f), "utf8"))).filter((a) => !["profile", "history", "live", "bowl", "class"].includes(a.type))
    .sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, n)
    .map((a) => ({ title: a.title, body: a.body, social: (a.social || []).map((p) => `${p.author} (${p.handle}): ${p.text}`), trade_watch: (a.trade_watch || []).map((t) => t.take) }));
}

async function write(client, job) {
  const facts = job.facts();
  // Profiles stand on their own, and draft-day coverage mustn't know how the season went
  // Rankings for past weeks mustn't see later stories, so they get none
  const recent = ["profile", "draft", "history", "rankings", "bowl", "class", "card", "team"].includes(job.type) ? [] : recentStories();
  const wk = ["review", "profile", "history", "bowl", "class"].includes(job.type) ? null : ["rankings", "grades", "regseason", "playoffs", "ladder"].includes(job.type) ? Math.floor(job.wk) : Math.ceil(job.wk);
  const pub = published({ id: job.id, type: job.type, year: job.s.year, wk, at: job.at, place: job.place, n: job.s.teams.length, created: new Date().toISOString() }, job.s.periods);
  const dated = pub ? `\n\nThis story goes up ${etLabel(pub)}; time the social posts' "when" from that.` : "";
  // The byline: written in that staffer's voice, lightly (the facts and the story come first)
  const by = STAFF.find((p) => p.name === BYLINE[job.type]);
  const byline = by ? `\n\nThis story runs on GLSN under ${by.name}'s byline (${by.handle}). Write it in his or her voice (${by.voice}), as seasoning: the facts and the story come first, no sign-off, and at most a line in the first person.` : "";
  const avoid = recent.length ? `\n\nThe league's most recent stories, for reference only. Readers just read these, so don't reuse their jokes, nicknames-as-punchlines, or angles; find fresh ones:\n${JSON.stringify(recent)}` : "";
  // Long outputs (the report cards) must stream: the SDK refuses a non-streaming call that could run past 10 minutes
  const params = {
    model: MODELS[job.type] || MODEL,
    max_tokens: job.type === "card" ? 32000 : 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a safety check declines, Anthropic retries on its recommended fallback model
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: schemas[job.type] } },
    messages: [{ role: "user", content: `${asks[job.type]}${byline}\n\nFacts (JSON):\n${JSON.stringify(facts)}${dated}${avoid}` }],
  };
  const res = params.max_tokens > 16000 ? await client.beta.messages.stream(params).finalMessage() : await client.beta.messages.create(params);
  if (res.stop_reason === "refusal") { console.log(`::warning::${job.id}: declined (${res.stop_details && res.stop_details.category}), skipping`); return null; }
  if (res.stop_reason === "max_tokens") { console.log(`::warning::${job.id}: ran out of room, will retry next run`); return null; }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let out;
  try { out = JSON.parse(text); } catch { console.log(`::warning::${job.id}: response wasn't valid JSON, will retry next run`); return null; }
  if (out.chapters) out.body = out.chapters.flatMap((c) => c.body);
  // Stories are permanent, so don't keep one that came back hollow
  const hollow = job.type === "rankings" ? !(out.body || []).length || (out.power_rankings || []).length !== job.s.teams.length
    : job.type === "grades" || job.type === "regseason" ? !out.body || out.body.length < 2 || (out.grades || []).length !== job.s.teams.length
    : job.type === "team" ? !out.body || out.body.length < 4 || !out.card || !out.card.grade
    : job.type === "playoffs" || job.type === "ladder" ? !out.body || out.body.length < 2 || (out.panel || []).length < 4
    : job.type === "card" ? !out.body || out.body.length < 2 || (out.cards || []).length !== job.s.teams.length
    : !out.body || out.body.length < 2 || (schemas[job.type].required.includes("social") && !(out.social || []).length);
  if (hollow) { console.log(`::warning::${job.id}: came back with an empty story (${(out.body || []).length} paragraphs, ${(out.social || []).length} posts, title ${JSON.stringify(out.title || out.headline || "")}, stop ${res.stop_reason}), will retry next run`); return null; }
  // Bios name teams as written in the facts ("Name (Manager)"); match on the team-name part
  const teamFor = (label) => job.s.teams.find((t) => label === nameAt(t, job.wk) || label.startsWith(nameAt(t, job.wk) + " ("));
  return {
    id: job.id, type: job.type, year: job.s.year, wk, at: job.at, by: BYLINE[job.type], created: new Date().toISOString(),
    title: out.title || out.headline, dek: out.dek || "", body: out.body, chapters: out.chapters, social: out.social || [], teams: job.tr ? job.tr.teams : [], mgr: job.mgr,
    trade_watch: out.trade_watch ? out.trade_watch.filter((t) => (facts.trade_watch || []).some((x) => x.id === t.id)) : undefined,
    picks: out.picks ? out.picks.map((g) => { const m = job.s.matchups.find((x) => x.wk === Math.ceil(job.wk) && g.game === `${who(job.s.byId[x.h], x.wk)} vs ${who(job.s.byId[x.a], x.wk)}`);
      return m && { game: g.game, h: m.h, a: m.a, panel: g.panel.map((p) => ({ ...p, id: (teamFor(p.pick) || {}).id })) }; }).filter(Boolean) : undefined,
    // What the preview saw, so Sunday's final word can say what changed
    chances: job.type === "preview" ? job.s.matchups.filter((m) => m.wk === Math.ceil(job.wk) && m.a).map((m) => ({ h: m.h, a: m.a, p: m.psimFixed ?? m.psim })) : undefined,
    starters: job.type === "preview" ? startersAt(job.s, Math.ceil(job.wk)) : undefined,
    tid: job.tid, place: job.place, n: job.type === "team" ? job.s.teams.length : undefined,
    card: out.card ? { ...out.card, team: who(job.s.byId[job.tid], job.wk), id: job.tid } : undefined,
    panel: out.panel ? out.panel.map((p) => ({ ...p, id: (teamFor(p.champion || p.last_place || "") || {}).id, ru: p.runner_up ? (teamFor(p.runner_up) || {}).id : undefined })) : undefined,
    stage: job.stage, grades: out.grades ? out.grades.map((x) => ({ ...x, id: (teamFor(x.team) || {}).id })) : undefined,
    cards: out.cards ? out.cards.map((x) => ({ ...x, id: (teamFor(x.team) || {}).id })) : undefined,
    power_rankings: out.power_rankings ? out.power_rankings.map((x) => ({ ...x, id: (teamFor(x.team) || {}).id })).sort((a, b) => a.rank - b.rank) : undefined,
    bios: out.bios ? Object.fromEntries(out.bios.map((b) => [(teamFor(b.team) || {}).id, b.bio]).filter(([id]) => id != null)) : undefined,
    // Cached input is billed separately (writes 1.25x, reads 0.1x), so keep those counts too
    model: res.model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cache_write: res.usage.cache_creation_input_tokens || 0, cache_read: res.usage.cache_read_input_tokens || 0 },
  };
}

// The Report Cards page (2026 on): once every team's season review is out, their cards gathered into card-<year>, the
// page the season overview and News link to (each card links back to its review). Built here, no API call.
function cardIndex() {
  for (const z of D.seasons.filter((x) => x.done && x.year >= 2026)) {
    const f = path.join(NEWS, `card-${z.year}.json`); if (fs.existsSync(f)) continue;
    const reviews = saved("team", z.year).filter((a) => a.card); if (reviews.length < z.teams.length) continue;
    const last = reviews.reduce((a, b) => (b.created > a.created ? b : a)), byPlace = (a) => (z.byId[a.tid] || {}).final || 99;
    fs.mkdirSync(NEWS, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ id: `card-${z.year}`, type: "card", year: z.year, wk: last.wk, by: "Morgans", created: last.created, place: 1, n: z.teams.length,
      title: `${z.year} Report Cards`, dek: "Every team's season grade, management verdict and sub-grades, from GLSN's team-by-team season reviews.", body: [], social: [],
      cards: reviews.sort((a, b) => byPlace(a) - byPlace(b)).map((a) => ({ ...a.card, review: a.id })) }, null, 1));
    console.log(`::notice::${z.year} Report Cards page put together from the team reviews`);
  }
}

// Run when called directly; live.js loads this file for the shared newsroom setup
if (require.main === module) (async () => {
  // Says whether each lore secret arrived (lengths only, never the contents)
  console.log(`::notice::Lore: LEAGUE_LORE ${(process.env.LEAGUE_LORE || "").trim().length} characters, LEAGUE_LORE_EXTRA ${LORE_EXTRA.length} characters`);
  if (!DRY) cardIndex();
  const todo = pending();
  if (!todo.length) { console.log("News is up to date."); return; }
  console.log(`${todo.length} stories to write: ${todo.map((j) => j.id).join(", ")}`);
  if (DRY) { for (const j of [todo[0], todo[todo.length - 1]]) console.log(`\n--- ${j.id} ---\n${JSON.stringify(j.facts(), null, 1).slice(0, 3000)}`); console.log(`\nSystem prompt:\n${SYSTEM}`); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("No ANTHROPIC_API_KEY set, skipping news."); return; }
  // Stories are permanent, so wait for the nicknames rather than write without them
  if (!LORE) { console.log("No LEAGUE_LORE secret set, skipping news until it is."); return; }
  const client = new Anthropic();
  fs.mkdirSync(NEWS, { recursive: true });
  // Failed tries per story (history/news_tries.json, saved by GitHub): after three, skip it until the file entry is removed
  const triesFile = path.join(__dirname, "history", "news_tries.json"), tries = fs.existsSync(triesFile) ? JSON.parse(fs.readFileSync(triesFile, "utf8")) : {};
  const saveTries = () => { if (process.env.GITHUB_ACTIONS === "true") { fs.mkdirSync(path.dirname(triesFile), { recursive: true }); fs.writeFileSync(triesFile, JSON.stringify(tries, null, 1)); } };
  for (const job of todo.filter((j) => (tries[j.id] || 0) >= 3)) console.log(`::warning::${job.id}: skipped after ${tries[job.id]} failed tries; delete it from history/news_tries.json to try again`);
  for (const job of todo.filter((j) => (tries[j.id] || 0) < 3).slice(0, MAX_PER_RUN)) {
    try {
      const art = await write(client, job);
      if (!art) { tries[job.id] = (tries[job.id] || 0) + 1; saveTries(); continue; }
      if (tries[job.id]) { delete tries[job.id]; saveTries(); }
      fs.writeFileSync(path.join(NEWS, `${job.id}.json`), JSON.stringify(art, null, 1));
      console.log(`${job.id}: "${art.title}" (${art.usage.input} in / ${art.usage.output} out tokens)`);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) { console.log("The ANTHROPIC_API_KEY secret was rejected. Check it in GitHub settings."); process.exitCode = 1; return; }
      if (err instanceof Anthropic.RateLimitError) { console.log("Rate limited, will continue next run."); return; }
      if (err instanceof Anthropic.APIError) { console.log(`::warning::${job.id}: API error ${err.status}: ${err.message}`); continue; }
      // Anything else (a bug in one story's facts, a client error) skips that story, counted as a try, so the rest still get written
      console.log(`::warning::${job.id}: ${err.message}`); tries[job.id] = (tries[job.id] || 0) + 1; saveTries();
    }
  }
  cardIndex(); // the last team review may have just been written
})();

module.exports = { QUOTES, quoteTeam, missingStars, NAMESAKES, NAMESAKE_AWARD, awardRaces, D, S, SYSTEM, SOCIAL, PANEL, STAFF, GLSN, GUESTS, guestFor, LORE, NEWS, who, mgrAt, nameAt };
