# Buckaroo Football League site

A fan site for an 8-team ESPN fantasy league of friends (founded 2023, 6 teams through 2025, 8 from 2026). Sonny, the owner, is the commissioner and the person you work with. The championship is the Buckaroo Bowl (Roman numerals, Bowl I = 2023); the consolation game that decides last place is the Bum Bowl. This repo is public: never commit secrets, the lore, or personal details beyond what the site already shows.

## How it runs

GitHub Actions (`.github/workflows/update.yml`) is scheduled every 15 minutes, but GitHub only fires it every few hours, so on game days each run starts the next itself (`check-games.js next`: about every 15 minutes from 4 hours before an NFL kickoff until 5 hours after, hourly when a game is within a day, otherwise the chain stops and the schedule takes over). `check-games.js` decides whether a scheduled run updates (around games, or any time between 7am and 11pm ET); manual, push and chained runs always update. Each run checks out the latest `main`. Each update:

1. `fetch.js current` downloads the season from ESPN (needs the `ESPN_S2` and `ESPN_SWID` secrets) into `data/` (raw files, never committed; they contain ESPN account IDs). Past seasons' NFL schedules are saved once to `archive/nfl_<year>.json`.
2. `build.js` builds `public/` (the site) and `site/data.js`: seasons, odds (`odds.js`), this week's player-level simulation (`players.js`), story and post times (`when.js`). Finished seasons are archived to `archive/<year>.json`.
3. `news.js` writes missing stories with Claude Opus (`claude-opus-5-5`), at most 16 per run; stories are saved once in `news/` and never rewritten unless deleted.
4. `live.js` writes live social posts with Claude Sonnet (`claude-sonnet-5-5`) when something happened in games or roster moves; at most 2 calls an hour and 20 a day.
5. A second build, then the workflow commits `archive/`, `history/` and `news/` and deploys to GitHub Pages.

Secrets: `ESPN_S2`, `ESPN_SWID`, `ANTHROPIC_API_KEY`, `LEAGUE_LORE` (original nicknames and inside jokes), and `LEAGUE_LORE_II` (later additions, read as LEAGUE_LORE_EXTRA; they override the original). Every run prints a notice with both lore lengths.

## Working from a cloud session

- The session can't reach ESPN or the live site, and can't read Actions logs or secrets. Check runs through annotations instead: `build.js`, `news.js` and `live.js` print `::notice::` and `::warning::` lines (lore lengths, trades found, byes and outs, the playoff picture, each week's win chances with ESPN's, Ones to Watch, same-game correlations). Read them with `gh api repos/sonnyaguero22-afk/bfl/check-runs/<job id>/annotations`.
- Start a run by hand with `gh api -X POST repos/sonnyaguero22-afk/bfl/actions/workflows/update.yml/dispatches -f ref=main`; a manual run may write the week's power rankings early, but never the preview or final word (they wait for lineups).
- Local builds only have the archived seasons (2023 to 2025), not the season in progress. Test site changes by building, copying `public/` to a scratch folder, faking data there (for example marking a 2025 week live), and rendering with Playwright at desktop and 360 to 400px widths; check for page errors and horizontal scroll.
- Work on `main` and push; every push runs the workflow and deploys. Rewriting a story means deleting its JSON in `news/` and pushing; each one costs API credits, so ask before rewriting many.

## News

Story types in `news.js`, each dated in-world by `when.js`:

| Type | When | Notes |
| --- | --- | --- |
| recap | after Monday night's game | awards, Trade Watch, playoff stakes, team bios, social |
| rankings | Tuesday 9am ET | NFL.com-style power rankings, own tab (News, Power Rankings) |
| preview | 2 hours before the week's first NFL kickoff | storylines plus a four-person pundit panel picking every game (graded); win chances assume holes get filled, which are mentioned in passing at most |
| final | Sunday, 75 minutes before the 1pm games | short Sonnet follow-up: lineup moves and win chance changes since the preview, Thursday's points, holes still unfilled |
| trade | as soon as a trade is seen | before/after odds from frozen week-end snapshots |
| draft | each season | draft-night coverage, no hindsight |
| bowl | when a season ends | wiki article for each Buckaroo Bowl and Bum Bowl (`bowl-<year>`, `bum-<year>`), shown on its game page, not in the feed |
| review, history, profile | when a season ends | season review, the league history (History tab), manager profiles |
| live | during games and on roster moves | `live.js`, shown only in the social feed; reacts to touchdowns, turnovers and big plays, and knows which starters' games are over |

Writing rules live in `news.js` (`SYSTEM`): use only the facts given; running jokes and labels are rare; first names and everyday nicknames mixed naturally; Zoe's nickname is always written Z² (also enforced in `build.js`). The panel (all fictional, never real people): Dana Whitfield (insider), Marcus Pell (columnist), Sal Benedetto (gambler), Dr. Nina Kessler (analytics). Social posts have kinds (fan, pundit, reporter, team, league), a heat score that drives likes and virality, and a time; a post appears only once its time has passed.

## Models

The decisions and backtests are logged in the "BFL Model Log" Google Doc in Sonny's Drive; add an entry whenever a model changes.

- Next week's win chance: ESPN's projection for the lineup as set (holes count as zero). Backtest on 2023 to 2025 (127 games): 68% of winners picked, Brier 0.206, against 55% and 0.254 for the original model.
- Season odds (`odds.js`): 5,000 simulated seasons; later weeks use a blend of lineup projection and points per game (recent weeks weighted 0.8 per week), minus NFL bye losses, with a wider spread; ties go to head-to-head then points for (the league's ESPN setting is `H2H_RECORD`).
- The model is nicknamed Luffy (after One Piece) in the stories.
- Player simulation (`players.js`): ESPN projection times a ratio drawn from each position's real distribution, player-specific spread, and same-game links (receivers with their QB, defenses against the offense they face). Produces this week's win chances, live win chances and Ones to Watch. A player ruled out (OUT or IR) during his game counts as having nothing left to play; a game is exactly 100% or 0% only once every starter on both sides is done.
- Laboon, the manager ratings (Elo, `site/index.html`, Managers > Laboon; named after the One Piece whale): all finished games since 2023, wins only, K 24 (1.5x in the winners' bracket), halfway back to 1500 each season. Backtest on 2023 to 2025 (136 games): 58% of winners, Brier 0.246; a résumé, not a forecast.
- Awards (own top tab, Players and Managers sub-tabs with a season picker; `seasonAwards` in `site/index.html`): One Piece-named player awards for every season (Pirate King MVP, The One Piece Bowl MVP, Nami QB, Sanji RB, Zoro WR, Franky TE, Usopp K, Jinbe D/ST, Robin pickup, Thousand Sunny trade, Chopper comeback, Brook bench, Buggy bust, Ace donut); the current season shows "so far". Bowl-winning rosters get rings on their player pages (not in lists, which would get crowded).
- Manager pages (`mgrWiki`) and player pages (`wikiHtml`, `seasonStory`) read like wiki articles: an infobox, a lead written from the numbers, then the story (the Opus career profile for managers, a templated paragraph per season for players). Manager squares use initials, except Z² (Zoe) and J$ (Jordan).
- Season Overview tab (`seasonOverview`, default for finished seasons), Bowl and Bum Bowl pages (`#bowl-<year>`, `#bum-<year>`, `gameView`: infobox, Opus article, win chance chart, box score, preceded/succeeded by) and Laboon's wiki intro and records (`laboonIntro`).
- The Bounty Board (Ones to Watch in the code; one per team, named for One Piece's wanted posters) sits at the top of a game's Lineups tab in its pre-redesign layout, with gold names in the lineups below, "presented by the Baratie" (a joke sponsor, never real). A pick at or over his top-20% line went Gear 5 🔥; under his bottom-20% line once his game is over he got Seastoned 🪨 (seastone cancels Devil Fruit powers; Buggy stays the season-long bust award). Wiki pages: `#ow-bounty`, `#ow-baratie`, `#ow-gear5`, `#ow-seastone` (`owView`), graded from the picks frozen in `history/`; player pages count each player's board appearances. The Bounty Board page has a Most Wanted leaderboard (most picks, with Gear 5s and Seastoneds) and a season picker (All-time or one season) shared with the Gear 5 and Seastoned pages, which show one season in full or the ten biggest all-time. Stories and live posts use the same names (`SYSTEM` in `news.js`; recaps get each game's graded picks; `live.js` posts a GEAR 5 when one clears his line and a SEASTONED when one's game ends under it).
- Berries (฿, One Piece's money; `berry`, `BOUNTY`, `STAKE`, `TREASURE` in `site/index.html`): every Bounty Board player has a bounty that only goes up (฿10M per pick, plus ฿50M and ฿5M a point past his line for a Gear 5, scaled by the game's swing), ranked in Most Wanted and shown on player pages; the panel bets on its picks, a background bit for all four (฿100M a season; lean ฿5M, confident ฿10M, lock ฿25M, paid at Luffy's pregame odds; shown in Panel Standings and given to the preview writer in `season_picks`, same rules in `news.js`); managers have a treasury since 2023 (฿10M a regular-season win, −฿2M a loss, ฿5M Manager of the Week, ฿50M a playoff win, ฿300M the Buckaroo Bowl, ฿25M a manager award, ฿10M a player award for one of his players, ฿5M a Gear 5 pick, a ฿25M Bum Bowl fine; awards pay when a season ends) on the Managers page and manager pages.
- Award pages (`#aw-<key>`, `awardView`): a wiki article per award (what it's for, why the One Piece name, every winner, see also). Player pages, award cards and manager pages link to them; wiki-style pages color their links.
- Manager awards (Awards > Managers, `seasonMgrAwards`): Vegapunk best draft, Wapol waiver king, Doflamingo trade shark, Blackbeard luckiest, Bon Clay unluckiest, Bellamy lineup blunders, Marco biggest Laboon climber; always one winner (count ties go to the bigger margin). Also listed on each manager's page.
- Down the Stretch (Odds page): remaining opponents' strength and next week's games to root for, from the season simulation.
- Clinching and elimination: exact, shown as soon as mathematically possible; full enumeration in the last three weeks.
- Saved for grading (`history/`): pregame win chances and Ones to Watch frozen at kickoff (the site keeps showing those Ones to Watch once a game starts, with how each is doing against his lines), with ESPN's own `winProbability`; odds frozen when each week ends; live win chance history (one point per update: time, home win chance, both scores, the plays `live.js` saw since the last update, such as touchdowns and injuries, which the chart marks and its hover readout lists, and ESPN's own live win chance, saved only for grading and not shown on the site).

## Conventions

- Plain JavaScript (Node 20 in Actions), no framework; the site is one file, `site/index.html`.
- Match the surrounding code: short comments that say why, early returns, compact helpers.
- Commit messages: a short summary line, then a few lines on what and why.
- The site defaults to dark mode with a light toggle; check both when changing colors. Gold marks the Buckaroo Bowl; winners in brackets are outlined in white.

## Next steps (as of early November 2026)

- **Apple Sports redesign (live on `main` since November 8, 2026):** near-black dark mode with frosted glass cards (Sonny picked black over navy), an Apple Sports light mode (pale sky gradient, white cards, gray capsule tracks), game sheets in the two teams' colors, one-card score lists on Home and the weekly page, and clean standings with one cut line. Following: a single Follow button on the scores card opens a strip of manager squares; the followed team's game goes first and the page glows in that team's color (saved per browser, `bfl-my`).
- Add the BFL Model Log entries for Laboon, the awards and Down the Stretch (needs the Google Docs connector, or Sonny pastes the drafted entry).
- Rivalry pages right after the season (score pairs on playoff meetings, close games, trades and streaks; Opus article, infobox, every meeting).
- Refresh `LEAGUE_LORE_II` after week 10 with this season's storylines.
- Build the Report Card page from `history/` and publish its data as a CSV that a Google Sheet pulls in with `IMPORTDATA`.
- Weekly self-tuning of the hand-set odds settings, adopting a change only if it wins on seasons it wasn't tuned on.
- Preseason predictions by the panel, graded during the season (next draft).
- The "bfl" cloud environment can read the live site (`sonnyaguero22-afk.github.io`), so a session can analyze live data such as rosters and projections (`data.js`).
