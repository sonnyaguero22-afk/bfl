// Decides whether this hourly run should update the site.
// Update every 15 minutes from 4 hours before an NFL kickoff (inactives and lineup swaps) until a few
// hours after, twice a day otherwise (around 9am and 6pm Eastern), and always on manual runs.
// Writes run=true/false for GitHub Actions.
const fs = require("fs");

function decide(why, run) {
  console.log(`${run ? "Updating" : "Skipping"}: ${why}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

(async () => {
  if (process.env.GITHUB_EVENT_NAME && process.env.GITHUB_EVENT_NAME !== "schedule") return decide("started by hand or by a code change", true);
  const etHour = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date());
  const etMin = new Date().getUTCMinutes(); // Eastern time is a whole-hour offset from UTC
  if ((etHour === 9 || etHour === 18) && etMin < 30) return decide(`twice-daily update (${etHour === 9 ? "9am" : "6pm"} ET)`, true);
  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    const sb = await res.json();
    const now = Date.now();
    const games = sb.events || [];
    const live = games.filter((e) => e.status && e.status.type && e.status.type.state === "in");
    if (live.length) return decide(`${live.length} game(s) in progress`, true);
    // Kicked off within the last 5 hours: catches games that just went final and stat corrections
    const recent = games.filter((e) => { const k = Date.parse(e.date); return now >= k && now - k <= 5 * 3600e3; });
    if (recent.length) return decide(`${recent.length} game(s) finished recently`, true);
    // Kicking off within 4 hours: lineups and injury news change fastest right before games
    const soon = games.filter((e) => { const k = Date.parse(e.date); return k > now && k - now <= 4 * 3600e3; });
    if (soon.length) return decide(`${soon.length} game(s) kick off within 4 hours`, true);
    return decide("no NFL games right now", false);
  } catch (err) {
    return decide(`couldn't reach ESPN's scoreboard (${err.message}), updating to be safe`, true);
  }
})();
