# Buckaroo Football League site

A fan site for an 8-team ESPN fantasy league of friends (founded 2023, 6 teams through 2025, 8 from 2026). Sonny, the owner, is the commissioner and the person you work with. The championship is the Buckaroo Bowl (Roman numerals, Bowl I = 2023); the consolation game that decides last place is the Bum Bowl. This repo is public: never commit secrets, the lore, or personal details beyond what the site already shows.

## How it runs

GitHub Actions (`.github/workflows/update.yml`) runs every 15 minutes; `check-games.js` decides whether to update: every 15 minutes from 4 hours before an NFL kickoff until a few hours after games, otherwise twice a day (about 9am and 6pm ET), and always on manual or push runs. Each update:

1. `fetch.js current` downloads the season from ESPN (needs the `ESPN_S2` and `ESPN_SWID` secrets) into `data/` (raw files, never committed; they contain ESPN account IDs). Past seasons' NFL schedules are saved once to `archive/nfl_<year>.json`.
2. `build.js` builds `public/` (the site) and `site/data.js`: seasons, odds (`odds.js`), this week's player-level simulation (`players.js`), story and post times (`when.js`). Finished seasons are archived to `archive/<year>.json`.
3. `news.js` writes missing stories with Claude Opus (`claude-opus-5-5`), at most 16 per run; stories are saved once in `news/` and never rewritten unless deleted.
4. `live.js` writes live social posts with Claude Sonnet (`claude-sonnet-5-5`) when something happened in games or roster moves; at most 2 calls an hour and 20 a day.
5. A second build, then the workflow commits `archive/`, `history/` and `news/` and deploys to GitHub Pages.

Secrets: `ESPN_S2`, `ESPN_SWID`, `ANTHROPIC_API_KEY`, `LEAGUE_LORE` (original nicknames and inside jokes), and `LEAGUE_LORE_II` (later additions, read as LEAGUE_LORE_EXTRA; they override the original). Every run prints a notice with both lore lengths.

## Working from a cloud session

- The session can't reach ESPN or the live site, and can't read Actions logs or secrets. Check runs through annotations instead: `build.js`, `news.js` and `live.js` print `::notice::` and `::warning::` lines (lore lengths, trades found, byes and outs, the playoff picture, each week's win chances with ESPN's, Ones to Watch, same-game correlations). Read them with `gh api repos/sonnyaguero22-afk/bfl/check-runs/<job id>/annotations`.
- Start a run by hand with `gh api -X POST repos/sonnyaguero22-afk/bfl/actions/workflows/update.yml/dispatches -f ref=main`; a manual run may also write the week's preview early.
- Local builds only have the archived seasons (2023 to 2025), not the season in progress. Test site changes by building, copying `public/` to a scratch folder, faking data there (for example marking a 2025 week live), and rendering with Playwright at desktop and 360 to 400px widths; check for page errors and horizontal scroll.
- Work on `main` and push; every push runs the workflow and deploys. Rewriting a story means deleting its JSON in `news/` and pushing; each one costs API credits, so ask before rewriting many.

## News

Story types in `news.js`, each dated in-world by `when.js`:

| Type | When | Notes |
| --- | --- | --- |
| recap | after Monday night's game | awards, Trade Watch, playoff stakes, team bios, social |
| rankings | Tuesday 9am ET | NFL.com-style power rankings, own tab (News, Power Rankings) |
| preview | Wednesday 6pm to Sunday 1pm ET | storylines plus a four-person pundit panel picking every game |
| trade | as soon as a trade is seen | before/after odds from frozen week-end snapshots |
| draft | each season | draft-night coverage, no hindsight |
| review, history, profile | when a season ends | season review, the league history (History tab), manager profiles |
| live | during games and on roster moves | `live.js`, shown only in the social feed |

Writing rules live in `news.js` (`SYSTEM`): use only the facts given; running jokes and labels are rare; first names and everyday nicknames mixed naturally; Zoe's nickname is always written Z² (also enforced in `build.js`). The panel (all fictional, never real people): Dana Whitfield (insider), Marcus Pell (columnist), Sal Benedetto (gambler), Dr. Nina Kessler (analytics). Social posts have kinds (fan, pundit, reporter, team, league), a heat score that drives likes and virality, and a time; a post appears only once its time has passed.

## Models

The decisions and backtests are logged in the "BFL Model Log" Google Doc in Sonny's Drive; add an entry whenever a model changes.

- Next week's win chance: ESPN's projection for the lineup as set (holes count as zero). Backtest on 2023 to 2025 (127 games): 68% of winners picked, Brier 0.206, against 55% and 0.254 for the original model.
- Season odds (`odds.js`): 5,000 simulated seasons; later weeks use a blend of lineup projection and points per game (recent weeks weighted 0.8 per week), minus NFL bye losses, with a wider spread; ties go to head-to-head then points for (the league's ESPN setting is `H2H_RECORD`).
- Player simulation (`players.js`): ESPN projection times a ratio drawn from each position's real distribution, player-specific spread, and same-game links (receivers with their QB, defenses against the offense they face). Produces this week's win chances, live win chances and Ones to Watch.
- Clinching and elimination: exact, shown as soon as mathematically possible; full enumeration in the last three weeks.
- Saved for grading (`history/`): pregame win chances frozen at kickoff, with ESPN's own `winProbability`; odds frozen when each week ends; live win chance history.

## Conventions

- Plain JavaScript (Node 20 in Actions), no framework; the site is one file, `site/index.html`.
- Match the surrounding code: short comments that say why, early returns, compact helpers.
- Commit messages: a short summary line, then a few lines on what and why.
- The site defaults to dark mode with a light toggle; check both when changing colors. Gold marks the Buckaroo Bowl; winners in brackets are outlined in white.

## Next steps (as of late October 2026)

- After week 8 (the first full trial): review live post quality and cost, and grade the pregame and live win chances against ESPN's.
- Build the Report Card page from `history/` and publish its data as a CSV that a Google Sheet pulls in with `IMPORTDATA`.
- Weekly self-tuning of the hand-set odds settings, adopting a change only if it wins on seasons it wasn't tuned on.
- Preseason predictions by the panel, graded during the season (next draft).
