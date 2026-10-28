// In-world timestamps for news stories and their social posts.
// Each kind of story has a natural time in the NFL week (recaps after Monday night's game, power
// rankings Tuesday morning, previews Wednesday evening...). A story written later than that, such
// as a backfill, is dated when it would have run; one written earlier keeps its real time.
// Social posts are timed in minutes before (negative) or after their story.

// Opening night: the Thursday after Labor Day (the first Monday in September)
const openerDay = (y) => ((1 - new Date(Date.UTC(y, 8, 1)).getUTCDay() + 7) % 7) + 1 + 3;
// A wall-clock time in US Eastern, as a Date (daylight time ends the first Sunday of November)
function eastern(y, sepDay, h, m) {
  const firstSunNov = ((7 - new Date(Date.UTC(y, 10, 1)).getUTCDay()) % 7) + 1;
  const edt = new Date(Date.UTC(y, 8, sepDay, h + 4, m));
  return edt >= new Date(Date.UTC(y, 10, firstSunNov, 6)) ? new Date(edt.getTime() + 3600e3) : edt;
}
// Small, stable variation per story so times don't all land on the same minute
const jitter = (key, n) => { let x = 2166136261; for (const c of key) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0; return (x ^ (x >>> 13)) % n; };

// The NFL week (Thursday) a scoring period falls in, as a day of September
const thursday = (y, sp) => openerDay(y) + 7 * (sp - 1);

// When a story would naturally run. periods maps a matchup week to its NFL weeks (scoring periods).
function natural(a, periods = {}) {
  const sps = (wk) => (periods[wk] || [wk]).map(Number);
  const last = (wk) => Math.max(...sps(wk)), first = (wk) => Math.min(...sps(wk));
  const y = a.year, j = (n) => jitter(a.id, n);
  switch (a.type) {
    case "recap": return eastern(y, thursday(y, last(a.wk)) + 5, 0, 25 + j(40));     // Tuesday, just after Monday night
    case "rankings": return eastern(y, thursday(y, last(a.wk)) + 5, 9, j(25));       // Tuesday morning
    case "preview": return eastern(y, thursday(y, first(a.wk)) - 1, 18, j(90));     // Wednesday evening
    case "trade": return eastern(y, thursday(y, first(a.wk)) - 1, 13, j(180));      // midweek before the trade's first game
    case "draft": return eastern(y, openerDay(y) - 4, 20, j(60));                    // the Sunday before opening night
    case "review": return null;
    default: return null;
  }
}
// When a story is dated: its real time if that's earlier than its natural time or up to 3 hours after
function published(a, periods) {
  const nat = natural(a, periods), real = a.created ? new Date(a.created) : null;
  if (!nat) return real;
  if (!real) return nat;
  return real.getTime() <= nat.getTime() + 3 * 3600e3 ? real : nat;
}
// A post's time: the writer's minutes offset when given, otherwise a stable spread around the story
// (recap reactions from Sunday evening through Tuesday morning, other stories' over the following hours)
function postTime(a, pub, p, i) {
  const off = Number.isFinite(p.when) ? p.when : a.type === "recap" ? -1800 + jitter(`${a.id}-${i}`, 2400) : 4 + jitter(`${a.id}-${i}`, 900);
  return new Date(pub.getTime() + off * 60e3);
}
// "Tue, Oct 27, 9:14 AM ET" for the writer
const etLabel = (d) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

module.exports = { natural, published, postTime, etLabel };
