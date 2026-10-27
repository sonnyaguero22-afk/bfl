# Buckaroo Football League history

The league's history site: every season since 2023, Buckaroo Bowls, managers, players, transactions, records and more.

## How it stays up to date

GitHub runs `.github/workflows/update.yml` every hour. `check-games.js` decides whether to update:

- every 15 minutes while NFL games are live or just finished
- once a day around 9am Eastern otherwise
- immediately when the workflow is started by hand (Actions → Update league site → Run workflow)

Each update downloads the current season from ESPN (`fetch.js current`), rebuilds the site (`build.js`) and publishes `public/` to GitHub Pages. When a season finishes, it's saved to `archive/` so it never needs ESPN again.

## League news (AI)

`news.js` asks Claude to write a recap after every finished week (with made-up social posts and fresh team bios), a reaction to every trade, and a look back at each finished season. Each story is saved once in `news/` and never rewritten; at most 12 are written per run. It needs two repository secrets: `ANTHROPIC_API_KEY`, and `LEAGUE_LORE` with the league's nicknames and inside jokes (kept as a secret because it names real people; a local copy can live in `data/lore.md`, which is never committed). Later additions can go in an optional third secret, `LEAGUE_LORE_EXTRA` (or `LEAGUE_LORE_II`), which is added after the original lore. Without both, news is skipped and the rest of the site updates normally. `node news.js --dry-run` prints the facts it would send without calling the API.

## ESPN login

The league is private, so ESPN needs two login values, stored as repository secrets (Settings → Secrets and variables → Actions):

- `ESPN_S2`
- `ESPN_SWID`

If an update fails with "ESPN login missing or expired", copy fresh values from ESPN's cookies and update both secrets.

## Files

- `site/index.html`: the website (page, styles and code)
- `build.js`: turns ESPN data into `public/`
- `fetch.js`: downloads data from ESPN
- `check-games.js`: decides when to update
- `news.js`: writes league news with Claude
- `history/`: in-game win chances saved during each update
- `news/`: saved news stories
- `archive/`: finished seasons, stripped down to what the site shows
- `data/overrides.json`: corrections to ESPN's records (Ramon)
- `data/trades_2026.json`: hand-checked 2026 trades (later trades are detected automatically)
