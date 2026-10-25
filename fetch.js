// Downloads raw ESPN data for the given seasons into data/.
// Usage: node fetch.js 2023 2024 2025   or   node fetch.js current
// Login comes from the ESPN_S2 / ESPN_SWID environment variables (GitHub secrets),
// or from espn-login.txt on this computer. Never prints those values.
const fs = require("fs");
const path = require("path");
const LEAGUE = 198668966;
const DATA = path.join(__dirname, "data");
const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

function cookie() {
  if (process.env.ESPN_S2 && process.env.ESPN_SWID) return `espn_s2=${process.env.ESPN_S2.trim()}; SWID=${process.env.ESPN_SWID.trim()}`;
  const home = process.env.USERPROFILE || "";
  const spots = [
    path.join(home, "Desktop", "espn-login.txt"),
    path.join(home, "OneDrive", "Desktop", "espn-login.txt"),
    path.join(__dirname, "espn-login.txt"),
  ];
  const f = spots.find((p) => fs.existsSync(p) && /espn_s2\s*=\s*\S/i.test(fs.readFileSync(p, "utf8")));
  if (!f) return "";
  const txt = fs.readFileSync(f, "utf8");
  const get = (k) => ((txt.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, "mi")) || [])[1] || "").replace(/^"|"$/g, "");
  const s2 = get("espn_s2"), swid = get("SWID");
  return s2 && swid ? `espn_s2=${s2}; SWID=${swid}` : "";
}
const COOKIE = cookie();

async function get(url, file, headers = {}) {
  const res = await fetch(url, { headers: { ...(COOKIE ? { cookie: COOKIE } : {}), ...headers } });
  const body = await res.text();
  if (res.status === 200) fs.writeFileSync(path.join(DATA, file), body);
  return res.status;
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  console.log(COOKIE ? "Using ESPN login from espn-login.txt" : "No ESPN login found; public data only");
  // "current" = this NFL season (a new season's league exists from August on)
  const now = new Date();
  const current = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const seasons = process.argv.slice(2).map((a) => (a === "current" ? current : +a));
  for (const y of seasons) {
    const lg = `${BASE}/seasons/${y}/segments/0/leagues/${LEAGUE}`;
    const st = await get(`${lg}?view=mTeam&view=mRoster&view=mMatchupScore&view=mSettings&view=mStandings&view=mDraftDetail&view=mNav&view=mBoxscore`, `league_${y}.json`);
    if (st !== 200) {
      console.log(`${y}: ESPN said ${st}${st === 401 ? " (ESPN login missing or expired: update the ESPN_S2 and ESPN_SWID secrets)" : ""}`);
      process.exitCode = 1; // fail the run so GitHub emails the owner
      continue;
    }
    const L = JSON.parse(fs.readFileSync(path.join(DATA, `league_${y}.json`), "utf8"));
    const last = L.status.latestScoringPeriod || L.status.finalScoringPeriod;
    await get(`${BASE}/seasons/${y}/players?scoringPeriodId=0&view=players_wl`, `players_${y}.json`, { "x-fantasy-filter": '{"filterActive":null}' });
    for (let w = 1; w <= last; w++) {
      await get(`${lg}?view=mMatchupScore&view=mBoxscore&scoringPeriodId=${w}`, `wk_${y}_${w}.json`);
      await get(`${lg}?view=mTransactions2&scoringPeriodId=${w}`, `tx_${y}_${w}.json`);
    }
    // Activity feed (has full trade details when logged in)
    await get(`${lg}/communication/?view=kona_league_communication`, `comm_${y}.json`, {
      "x-fantasy-filter": JSON.stringify({ topics: { filterType: { value: ["ACTIVITY_TRANSACTIONS"] }, limit: 1000, limitPerMessageSet: { value: 25 }, offset: 0, sortMessageDate: { sortPriority: 1, sortAsc: false }, sortFor: { sortPriority: 2, sortAsc: false }, filterIncludeMessageTypeIds: { value: [178, 180, 179, 239, 181, 244] } } }),
    });
    console.log(`${y}: ${L.teams.length} teams, ${last} weeks downloaded`);
  }
  // NFL game states and clocks, so live win chances know who still has to play
  if (process.argv.slice(2).includes("current")) {
    try {
      const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
      if (res.ok) { fs.writeFileSync(path.join(DATA, "nfl_scoreboard.json"), await res.text()); console.log("NFL scoreboard saved"); }
    } catch (err) { console.log(`NFL scoreboard unavailable (${err.message})`); }
  }
})();
