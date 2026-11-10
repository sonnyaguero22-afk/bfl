// Loads the site's own code (public/index.html, after a build) in node with a do-nothing page, so the news writer can
// use the site's calculations (Laugh Tale, awards, treasuries) instead of a copy that could drift from them.
const fs = require("fs"), vm = require("vm"), path = require("path");
let ctx = null;
function site() {
  if (ctx) return ctx;
  const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  // Anything the page touches (elements, events, history) is a stand-in that accepts every call
  const nop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => "" : k === "length" ? 0 : nop), apply: () => nop, construct: () => nop, set: () => true });
  ctx = { console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Intl, setTimeout: () => 0, clearTimeout: () => 0, requestAnimationFrame: () => 0, document: nop, history: nop, navigator: {},
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { hash: "" }, addEventListener() {}, innerWidth: 1200, getComputedStyle: () => nop, L: nop };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "public", "data.js"), "utf8"), ctx);
  // The app runs inside one (() => { ... })(); unwrapped, its functions are reachable from here
  for (const s of scripts) vm.runInContext(s.replace(/\n\(\(\) => \{\nconst D = window\.LEAGUE;/, "\nconst D = window.LEAGUE;").replace(/\}\)\(\);\s*$/, ""), ctx);
  return ctx;
}
// Evaluate an expression in the site's scope, e.g. run("laughTale()")
const run = (expr) => vm.runInContext(expr, site());
module.exports = { run };
