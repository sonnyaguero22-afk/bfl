// The awards ceremony deck: once a season is over, a slide deck (.pptx, opens in Google Slides) for walking the league
// through its awards, built from the site's own award code (sitecode.js) so it matches the Awards page. Each award gets a
// nominees slide, then its winner with the trophy; the manager awards and the hall of shame come first, the Pirate King,
// the Bum Bowl and the champion's ring last, then any Laugh Tale class. Saved once to archive/decks/awards-<year>.pptx
// (kept with the repo, like the logos); build.js serves it from decks/ and the season page links it.
// Usage: node deck.js            (every finished season without a deck)
//        node deck.js 2025 --force (rebuild one)
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const PptxGenJS = require("pptxgenjs");
const { run } = require("./sitecode");

const DIR = path.join(__dirname, "archive", "decks");
const args = process.argv.slice(2), force = args.includes("--force"), only = args.filter((a) => /^\d{4}$/.test(a)).map(Number);

// What the deck needs from the site, for one season
const factsFor = (y) => JSON.parse(run(`JSON.stringify((() => {
  const s = S[${y}], a = seasonAwards(s), m = seasonMgrAwards(s), n = s.teams.length, rank = (f) => s.teams.find((t) => t.final === f);
  const tm = (t) => t ? { name: nameAt(t, s.regWeeks), mgr: mgrName(mgrAt(t, s.regWeeks)), rec: t.w + "-" + t.l } : null;
  const ply = AWARDS.filter(([k]) => a[k] && a[k].p).map(([k, e, nm, cat]) => ({ k, e, nm, cat, def: AW_DEF[k], named: AW_NAMED[k], winner: a[k].p.n, team: a[k].t ? nameAt(a[k].t, s.regWeeks) : "", stat: a[k].stat,
    nominees: (a[k].top5 || []).map((x) => ({ who: x.p.n, team: x.t ? nameAt(x.t, s.regWeeks) : "", stat: x.stat })), svg: trophy(k) }));
  const mgr = MGR_AWARDS.filter(([k]) => m[k] && m[k].ks).map(([k, e, nm, cat]) => ({ k, e, nm, cat, def: AW_DEF[k], named: AW_NAMED[k], winner: mgrName(m[k].ks[0]), team: "", stat: m[k].stat,
    nominees: (m[k].top5 || []).map((x) => ({ who: mgrName(x.k), team: "", stat: x.stat })), svg: trophy(k) }));
  const lt = ltClasses().filter((c) => (c === "founding" ? LT.founded : +c) === ${y}).map((c) => ltClassFacts(c));
  return { year: ${y}, bowl: roman(${y} - D.firstYear + 1), teams: n, champion: tm(rank(1)), runnerUp: tm(rank(2)), last: tm(rank(n)),
    bowlScore: (() => { const g = bowlGame(s); return g ? Math.max(g.hp, g.ap).toFixed(2) + " to " + Math.min(g.hp, g.ap).toFixed(2) : ""; })(),
    ply, mgr, lt, logo: leagueLogo(), ring: ringArt(${y}), bowlTrophy: trophy("bowl") };
})())`));

// A drawing as a PNG for the slide (sharp rasterizes the site's own SVG)
// (flattened onto the slide's background as a JPEG, which keeps a season's deck to a few MB)
const png = async (svg, width) => "image/jpeg;base64," + (await sharp(Buffer.from(svg.replace(/^<svg /, '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ')), { density: 220 }).resize({ width }).flatten({ background: "#0b0b0d" }).jpeg({ quality: 88 }).toBuffer()).toString("base64");

// Colors: the site's near-black with its gold
const C = { bg: "0B0B0D", card: "17171B", ink: "F4F4F6", muted: "9A9AA6", gold: "F2C94C", red: "FF6B5F" };
const SHAME = ["buggy", "ace", "foxy", "bellamy"];

async function build(y) {
  const f = factsFor(y);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = `${f.year} Buckaroo Awards`;
  const slide = (notes) => { const sl = pptx.addSlide(); sl.background = { color: C.bg }; if (notes) sl.addNotes(notes); return sl; };
  const text = (sl, t, o) => sl.addText(t, { fontFace: "Georgia", color: C.ink, margin: 0, ...o });
  const logo = await png(f.logo, 600);

  // Title
  let sl = slide(`Welcome to the ${f.year} Buckaroo Awards. Buckaroo Bowl ${f.bowl}.`);
  sl.addImage({ data: logo, x: 4.92, y: 0.7, w: 3.5, h: 2.45 });
  text(sl, `The ${f.year} Buckaroo Awards`, { x: 0.5, y: 3.45, w: 12.33, h: 1, fontSize: 48, bold: true, align: "center" });
  text(sl, `Buckaroo Football League · Buckaroo Bowl ${f.bowl}`, { x: 0.5, y: 4.5, w: 12.33, h: 0.5, fontSize: 20, color: C.gold, align: "center" });

  // A section divider
  const section = (title, sub) => { const s2 = slide(); text(s2, title, { x: 0.5, y: 2.7, w: 12.33, h: 1, fontSize: 44, bold: true, align: "center", color: C.gold }); if (sub) text(s2, sub, { x: 0.5, y: 3.7, w: 12.33, h: 0.6, fontSize: 20, align: "center", color: C.muted }); };

  // Each award: the nominees (alphabetical, so nothing gives the winner away), then the winner with the trophy
  const award = async (aw, shame) => {
    const head = `${aw.e}  ${aw.nm}`, sub = aw.cat;
    let s2 = slide(`${aw.nm}: ${aw.def}. ${aw.named || ""}`);
    text(s2, head, { x: 0.6, y: 0.45, w: 12, h: 0.8, fontSize: 36, bold: true, color: shame ? C.red : C.gold });
    text(s2, `${sub} · ${aw.def}`, { x: 0.6, y: 1.25, w: 12, h: 0.7, fontSize: 16, color: C.muted, fit: "shrink" });
    text(s2, "The nominees are…", { x: 0.6, y: 2.1, w: 12, h: 0.5, fontSize: 20, italic: true });
    const noms = [...aw.nominees].sort((p, q) => p.who.localeCompare(q.who));
    text(s2, noms.map((x) => ({ text: `${x.who}${x.team ? `  ·  ${x.team}` : ""}`, options: { bullet: { code: "25CF" }, breakLine: true } })), { x: 0.9, y: 2.75, w: 11.5, h: 4, fontSize: 26, valign: "top", paraSpaceAfter: 10 });
    s2 = slide(`And the ${aw.nm} goes to ${aw.winner}. ${aw.stat}.`);
    s2.addImage({ data: await png(aw.svg, 700), x: 0.6, y: 0.5, w: 4.5, h: 6.0 });
    text(s2, `${aw.e}  ${aw.nm}`, { x: 5.6, y: 0.9, w: 7.2, h: 0.7, fontSize: 28, bold: true, color: shame ? C.red : C.gold });
    text(s2, "And the winner is…", { x: 5.6, y: 1.8, w: 7.2, h: 0.5, fontSize: 20, italic: true, color: C.muted });
    text(s2, aw.winner, { x: 5.6, y: 2.5, w: 7.2, h: 1.2, fontSize: 48, bold: true, fit: "shrink" });
    if (aw.team) text(s2, aw.k === "foxy" ? `Dropped by ${aw.team}` : aw.team, { x: 5.6, y: 3.75, w: 7.2, h: 0.6, fontSize: 24, color: C.gold });
    text(s2, aw.stat, { x: 5.6, y: 4.5, w: 7.2, h: 0.9, fontSize: 22, color: C.ink, fit: "shrink" });
  };

  const byKey = (list, keys) => keys.map((k) => list.find((x) => x.k === k)).filter(Boolean);
  const mgrGood = f.mgr.filter((x) => !SHAME.includes(x.k)), shame = [...byKey(f.ply, SHAME), ...byKey(f.mgr, SHAME)];
  const plyOrder = ["karoo", "robin", "sunny", "merry", "chopper", "brook", "jinbe", "usopp", "franky", "zoro", "sanji", "nami"];

  section("The Manager Awards", "Drafting, dealing, the wire and the luck");
  for (const aw of mgrGood) await award(aw);
  if (shame.length) { section("The Hall of Shame", "Somebody has to win these"); for (const aw of shame) await award(aw, true); }
  section("The Player Awards", "The players who carried us");
  for (const aw of byKey(f.ply, plyOrder)) await award(aw);
  const king = f.ply.find((x) => x.k === "king");
  if (king) { section("The Pirate King", "The season's most valuable player"); await award(king); }

  // The Bum Bowl, then the champion
  if (f.last) { sl = slide(`The Bum Bowl: ${f.last.mgr} finished last and owes the Marines ฿25M.`);
    text(sl, "🪣  The Bum Bowl", { x: 0.5, y: 1.6, w: 12.33, h: 0.9, fontSize: 40, bold: true, align: "center", color: C.red });
    text(sl, `${f.last.name}`, { x: 0.5, y: 2.9, w: 12.33, h: 1, fontSize: 48, bold: true, align: "center" });
    text(sl, `${f.last.mgr} · last place · a ฿25M fine to the Marines`, { x: 0.5, y: 4.1, w: 12.33, h: 0.6, fontSize: 22, align: "center", color: C.muted }); }
  const op = f.ply.find((x) => x.k === "onepiece");
  if (op) await award(op);
  if (f.champion) { section(`Buckaroo Bowl ${f.bowl}`, "Your champion");
    sl = slide(`${f.champion.mgr} won Buckaroo Bowl ${f.bowl}${f.bowlScore ? `, ${f.bowlScore}` : ""}.`);
    sl.addImage({ data: await png(f.bowlTrophy, 800), x: 0.4, y: 0.4, w: 4.6, h: 6.1 });
    sl.addImage({ data: await png(f.ring, 800), x: 8.6, y: 1.2, w: 4.4, h: 4.7 });
    text(sl, "🏆 Champions", { x: 4.9, y: 1.4, w: 3.8, h: 0.6, fontSize: 24, align: "center", color: C.gold });
    text(sl, f.champion.name, { x: 4.9, y: 2.2, w: 3.8, h: 1.6, fontSize: 36, bold: true, align: "center", fit: "shrink" });
    text(sl, `${f.champion.mgr}\n${f.champion.rec} in the regular season${f.bowlScore ? `\nWon the Bowl ${f.bowlScore}` : ""}${f.runnerUp ? `\nover ${f.runnerUp.name}` : ""}`, { x: 4.9, y: 3.9, w: 3.8, h: 2, fontSize: 18, align: "center", color: C.muted }); }

  // Laugh Tale, the Hall of Fame
  for (const c of f.lt) { section(`Laugh Tale: ${c.class}`, "The Buckaroo Hall of Fame");
    for (const p of c.inductees) { sl = slide(`${p.name} enters Laugh Tale as a ${p.rank}.`);
      text(sl, p.name, { x: 0.6, y: 1.2, w: 12, h: 1, fontSize: 44, bold: true, color: C.gold });
      text(sl, `${p.type === "manager" ? "Manager" : `${p.position}${p.nfl_team ? ` · ${p.nfl_team}` : ""}`} · enters as a ${p.rank}`, { x: 0.6, y: 2.25, w: 12, h: 0.6, fontSize: 22, color: C.muted });
      text(sl, (p.ways_in || []).map((w) => ({ text: w, options: { bullet: { code: "25CF" }, breakLine: true } })), { x: 0.9, y: 3.1, w: 11.5, h: 2.2, fontSize: 24, valign: "top", paraSpaceAfter: 8 });
      const line = p.type === "manager" ? [p.regular_season_record && `${p.regular_season_record} in the regular season`, p.playoff_record && `${p.playoff_record} in the playoffs`, p.bounty && `bounty ${p.bounty}`].filter(Boolean).join(" · ")
        : [p.starts && `${p.starts} starts`, p.points_as_starter && `${p.points_as_starter} points as a starter`, (p.played_for || []).length && `played for ${p.played_for.join(", ")}`].filter(Boolean).join(" · ");
      if (line) text(sl, line, { x: 0.6, y: 5.6, w: 12, h: 0.8, fontSize: 18, color: C.muted, fit: "shrink" }); } }

  // Close
  sl = slide("Thanks for a great season. See you at the Reverie (the draft).");
  sl.addImage({ data: logo, x: 4.92, y: 1.0, w: 3.5, h: 2.45 });
  text(sl, `See you next season`, { x: 0.5, y: 3.8, w: 12.33, h: 0.9, fontSize: 40, bold: true, align: "center" });
  text(sl, `The Buckaroo Football League · ${f.year + 1}`, { x: 0.5, y: 4.7, w: 12.33, h: 0.5, fontSize: 20, align: "center", color: C.gold });

  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, `awards-${y}.pptx`);
  await pptx.writeFile({ fileName: out });
  return out;
}

(async () => {
  const done = JSON.parse(run("JSON.stringify(D.seasons.filter((s) => s.done).map((s) => s.year))"));
  for (const y of done.filter((x) => !only.length || only.includes(x))) {
    if (!force && fs.existsSync(path.join(DIR, `awards-${y}.pptx`))) continue;
    try { const f = await build(y); console.log(`::notice::${y} awards deck saved (${path.relative(__dirname, f)})`); }
    catch (e) { console.log(`::warning::${y} awards deck failed: ${e.message}`); }
  }
})();
