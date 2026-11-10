// Decides whether this run should update the site, and (with "next") when the next run should start.
// Update every 15 minutes from 4 hours before an NFL kickoff (inactives and lineup swaps) until a few
// hours after, on any scheduled run between 7am and 11pm Eastern otherwise, and always on manual runs.
// GitHub's own schedule fires only every few hours on this repo, so on game days each run starts the
// next one itself: "next" writes wait=<seconds> (0 stops the chain and leaves it to the schedule).
const fs = require("fs");
const NEXT = process.argv.includes("next");

function out(key, val, why) {
  console.log(why);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${val}\n`);
}
const decide = (why, run) => out("run", run, `${run ? "Updating" : "Skipping"}: ${why}`);
// A run takes about 2 minutes, so these give updates about every 15 minutes and every hour
const next = (why, min) => out("wait", min * 60, min ? `Next run in about ${min + 2} minutes: ${why}` : `No next run: ${why}`);

(async () => {
  if (!NEXT && process.env.GITHUB_EVENT_NAME && process.env.GITHUB_EVENT_NAME !== "schedule") return decide("started by hand, by a code change or by the previous run", true);
  const etHour = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date());
  const etMin = new Date().getUTCMinutes(); // Eastern time is a whole-hour offset from UTC
  // GitHub fires the schedule only every few hours, at unpredictable minutes, so any daytime run updates
  // (a narrow 9am/6pm window was often missed, leaving the Tuesday recap waiting most of a day)
  if (!NEXT && etHour >= 7 && etHour < 23) return decide(`daytime update (${etHour}:${String(etMin).padStart(2, "0")} ET)`, true);
  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    const sb = await res.json();
    const now = Date.now();
    const games = sb.events || [];
    const live = games.filter((e) => e.status && e.status.type && e.status.type.state === "in");
    // Kicked off within the last 5 hours: catches games that just went final and stat corrections
    const recent = games.filter((e) => { const k = Date.parse(e.date); return now >= k && now - k <= 5 * 3600e3; });
    // Kicking off within 4 hours: lineups and injury news change fastest right before games
    const soon = games.filter((e) => { const k = Date.parse(e.date); return k > now && k - now <= 4 * 3600e3; });
    const later = games.filter((e) => { const k = Date.parse(e.date); return k > now && k - now <= 24 * 3600e3; });
    if (NEXT) {
      // Every ~5 minutes while games are being played (the wait plus a 1 to 2 minute update), so the live win
      // chance graph gets a point every few minutes; every ~15 around games
      if (live.length) return next(`${live.length} game(s) on`, 3);
      if (recent.length || soon.length) return next(`${recent.length} recent, ${soon.length} within 4 hours`, 13);
      if (later.length) return next(`${later.length} game(s) kick off within a day`, 58);
      return next("no NFL games within a day", 0);
    }
    if (live.length) return decide(`${live.length} game(s) in progress`, true);
    if (recent.length) return decide(`${recent.length} game(s) finished recently`, true);
    if (soon.length) return decide(`${soon.length} game(s) kick off within 4 hours`, true);
    return decide("no NFL games right now", false);
  } catch (err) {
    if (NEXT) return next(`couldn't reach ESPN's scoreboard (${err.message})`, 0);
    return decide(`couldn't reach ESPN's scoreboard (${err.message}), updating to be safe`, true);
  }
})();
