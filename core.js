// Draft Helper core: shared by the Chrome extension (ESPN draft room panel) and the hosted live page.
// Input is a "feed" (the draft so far); output is the panel: best pick, team balance, live buckets, league table.
// Feed: { v:1, T, R, league, teams:[[id,name]], order:[teamId...]|null, picks:[[overall, teamId, playerIndex|-1, name]], at, built }
// playerIndex is a position in DH_DATA.players, and the relay sends picks that way. So data.js keeps every player at
// the position he had in earlier builds (new players are appended), and nothing here may assume the list is in rank
// order: RANKED is the rank order. That keeps an old live page and a new extension (or the reverse) naming the same
// player for every pick; only the values differ, and the panel says when the boards differ.
window.DraftCore = (() => {
  const D = DH_DATA, CATS = D.cats, NC = CATS.length, P = D.players;
  // shown in the panel so anyone can see which version they are running (bump with the manifest version)
  const PANEL_VERSION = "1.5.3";
  const RANKED = P.map((_, i) => i).sort((a, b) => P[a].r - P[b].r);
  const SLOT_MASK = { PG: 1, SG: 2, SF: 4, PF: 8, C: 16, G: 3, F: 12, UTIL: 31 };
  const POS_BIT = { PG: 1, SG: 2, SF: 4, PF: 8, C: 16 };
  const NEED_WEIGHT = 0.35;

  const normName = s => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[.'’`]/g, "").replace(/-/g, " ").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
  const byKey = new Map(), byEspn = new Map();
  P.forEach((p, i) => { p.i = i; p.mask = p.p.split("/").reduce((m, x) => m | (POS_BIT[x] || 0), 0) || 4;
    p.k.forEach(k => { if (!byKey.has(k)) byKey.set(k, i); }); if (p.id) byEspn.set(p.id, i); });
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- state from a feed ----------
  function compute(feed, prefs) {
    const T = feed.T || D.teams, R = feed.R || D.roster;
    const teams = (feed.teams || []).map(([id, name]) => ({ id: String(id), name }));
    const picks = (feed.picks || []).map(([overall, team, pi, name]) => {
      const i = pi >= 0 && P[pi] ? pi : (byKey.get(normName(name)) ?? -1);
      return { overall, round: Math.ceil(overall / T), rp: (overall - 1) % T + 1, team: String(team), pi: i, name: i >= 0 ? P[i].n : name };
    }).sort((a, b) => a.overall - b.overall);
    for (const p of picks) if (!teams.some(t => t.id === p.team)) teams.push({ id: p.team, name: "Team " + p.team.replace(/^n:/, "") });
    let my = prefs.myTeam || null;
    if (my && teams.length && !teams.some(t => t.id === my)) my = null;
    // draft slot: the league's pick order, else my round-1 pick (snake: round 1 position), else what was typed in
    let slot = null;
    if (feed.order && my) { const k = feed.order.map(String).indexOf(my); if (k >= 0) slot = k + 1; }
    if (!slot && my) { const r1 = picks.find(p => p.round === 1 && p.team === my); if (r1) slot = r1.rp; }
    if (!slot && prefs.slot) slot = prefs.slot;
    const taken = new Set(picks.filter(p => p.pi >= 0).map(p => p.pi));
    const rosters = new Map(teams.map(t => [t.id, []]));
    for (const p of picks) if (p.pi >= 0) rosters.get(p.team).push(p.pi);
    const made = picks.length ? Math.max(picks.length, picks[picks.length - 1].overall) : 0;
    const myPicks = slot ? Array.from({ length: R }, (_, r) => r * T + (r % 2 === 0 ? slot : T + 1 - slot)) : [];
    // teams watched as model users (drafting off a model like this one): what the panel was told, else the league's
    // known model seats (D.modelSlots, by draft slot) once the pick order is known
    const slotOf = id => { if (feed.order) { const k = feed.order.map(String).indexOf(id); if (k >= 0) return k + 1; }
      const r1 = picks.find(p => p.round === 1 && p.team === id); return r1 ? r1.rp : null; };
    const models = Array.isArray(prefs.models) ? prefs.models.filter(id => teams.some(t => t.id === id))
      : teams.filter(t => t.id !== my && (D.modelSlots || []).includes(slotOf(t.id))).map(t => t.id);
    return { T, R, teams, picks, taken, rosters, my, slot, made, myPicks, next: myPicks.filter(n => n > made),
             unknown: picks.filter(p => p.pi < 0).map(p => p.name), models, slotOf,
             staleBoard: feed.built && feed.built !== D.built ? feed.built : null };
  }
  // a team's next pick number, from its draft slot (snake)
  const nextPickOf = (S, slot) => { if (!slot) return null;
    for (let r = 0; r < S.R; r++) { const n = r * S.T + (r % 2 === 0 ? slot : S.T + 1 - slot); if (n > S.made) return n; } return null; };

  const parZ = (S, k) => { const z = new Float64Array(NC), n = Math.min(P.length, S.T * k);
    for (let j = 0; j < n; j++) { const i = RANKED[j]; for (let c = 0; c < NC; c++) z[c] += P[i].z[c]; }
    for (let c = 0; c < NC; c++) z[c] /= S.T; return z; };
  const teamZ = roster => { const z = new Float64Array(NC); for (const i of roster) for (let c = 0; c < NC; c++) z[c] += P[i].z[c]; return z; };
  function match(masks) {     // starters filled by a roster (bipartite matching over the starting slots)
    const sm = D.slots.map(s => SLOT_MASK[s]), owner = new Array(sm.length).fill(-1);
    const go = (pi, seen) => { for (let s = 0; s < sm.length; s++) if ((sm[s] & masks[pi]) && !seen[s]) { seen[s] = true;
      if (owner[s] < 0 || go(owner[s], seen)) { owner[s] = pi; return true; } } return false; };
    let n = 0; for (let i = 0; i < masks.length; i++) if (go(i, [])) n++;
    return { n, open: D.slots.filter((s, k) => owner[k] < 0) };
  }
  const openSlots = roster => match(roster.map(i => P[i].mask)).open;
  function lineup(roster) {   // who starts where: best players placed first, the rest on the bench
    const order = roster.slice().sort((a, b) => P[a].r - P[b].r), masks = order.map(i => P[i].mask);
    const sm = D.slots.map(s => SLOT_MASK[s]), owner = new Array(sm.length).fill(-1);
    const go = (pi, seen) => { for (let s = 0; s < sm.length; s++) if ((sm[s] & masks[pi]) && !seen[s]) { seen[s] = true;
      if (owner[s] < 0 || go(owner[s], seen)) { owner[s] = pi; return true; } } return false; };
    for (let k = 0; k < masks.length; k++) go(k, []);
    // tidy for display: a better player in UTIL swaps into a named slot he can play (worse player moves to UTIL)
    for (let changed = true; changed;) {
      changed = false;
      for (let a = 0; a < sm.length; a++) for (let u = 0; u < sm.length; u++) {
        if (sm[a] === 31 || sm[u] !== 31 || owner[a] < 0 || owner[u] < 0 || owner[u] > owner[a]) continue;
        if (masks[owner[u]] & sm[a]) { [owner[a], owner[u]] = [owner[u], owner[a]]; changed = true; }
      }
    }
    const used = new Set(owner.filter(o => o >= 0));
    return { slots: D.slots.map((s, k) => ({ slot: s, pi: owner[k] >= 0 ? order[owner[k]] : null })),
             bench: order.filter((_, k) => !used.has(k)) };
  }
  const lastName = n => { const w = n.replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/, "").split(" "); return w.length > 1 ? w.slice(1).join(" ") : n; };
  function lineupHtml(roster, benchSlots) {
    const L = lineup(roster);
    const chip = (lab, pi, cls) => `<div class="ls ${pi == null ? "open" : cls || "f"}"><b>${lab}</b><span>${pi == null ? "open" : esc(lastName(P[pi].n))}</span></div>`;
    const bench = Array.from({ length: Math.max(benchSlots, L.bench.length) }, (_, k) => chip("BE", L.bench[k] ?? null, "be"));
    return `<div class="lineup">${L.slots.map(s => chip(s.slot, s.pi)).join("")}${bench.join("")}</div>`;
  }

  // what a model user most likely takes at his next pick: the same Fit as "Best pick" for his roster, leaving out
  // anyone the league's ADP has gone before that pick
  function likelyFor(S, teamId) {
    const n = nextPickOf(S, S.slotOf(teamId)); if (!n) return null;
    const list = advice(S, teamId).all.filter(({ p }) => n <= S.made + 1 || p.adp == null || p.adp >= n - 2).slice(0, 3);
    return { n, list: list.map(x => x.p) };
  }

  /* The pre-draft plan (D.plan, exported from the Draft Room: 500 simulated drafts per option, 17 Oct 2026) for
     your first three picks when your slot has one (12, 16 or 17 in a 20-team, 10-round league). Fit below has no
     lookahead, and on these picks the plan disagreed with it (e.g. KAT over Duren at 16), so it is shown first.
     Pick 2 and 3 depend on who you took first; if that was off the plan, Fit takes over. */
  function planLine(S, a, nextPick) {
    const PL = D.plan && D.plan[S.slot]; if (!PL || S.T !== 20 || S.R !== 10) return "";
    const step = PL.picks.indexOf(nextPick); if (step < 0) return "";
    const byName = nm => P.find(p => p.n === nm), gone = nm => { const p = byName(nm); return !p || S.taken.has(p.i); };
    // buckets: players within 2 playoff points of the bucket's best are even; struck = taken
    const buckets = list => { const out = []; let cur = null;
      for (const [nm, e] of list) { if (!cur || cur.top - e > 2) { cur = { top: e, names: [] }; out.push(cur); } cur.names.push(nm); }
      return out.map((bk, k) => `<span class="pb${k ? "" : " pb1"}">${bk.names.map(nm => gone(nm) ? `<s>${esc(nm)}</s>` : esc(nm)).join(" · ")}</span>`).join(" <span class=\"sub\">then</span> "); };
    const route = (first, g, hl) => `<div class="pbr${hl ? " pbhl" : ""}"><b>#${PL.picks[0]} ${esc(first)}</b>${hl ? " <span class=\"sub\">(suggested route)</span>" : ""}
      <div>#${PL.picks[1]} ${buckets(g.p2)}</div><div>#${PL.picks[2]} ${buckets(g.p3)}</div></div>`;
    const firstLeft = list => (list.find(([nm]) => !gone(nm)) || [])[0];
    // collapsed by default to one line (the plan's pick and the next two if he's gone); tap to open the full plan.
    // Open/closed is remembered (prefs.planOpen) because the panel re-renders on every pick.
    const head = (pick, list) => { const alts = list.map(x => x[0]).filter(nm => !gone(nm) && nm !== pick).slice(0, 2);
      return `<details class="planbox"${prefs.planOpen ? " open" : ""}><summary><b>Plan #${nextPick}: ${esc(pick || "none left, use Fit")}</b>${alts.length ? ` <span class="sub">if gone: ${alts.map(esc).join(", ")}</span>` : ""}</summary>
        <div class="sub" style="margin-top:4px">500 simulated drafts per option before the draft; each box is a bucket of even picks, best first.</div>`; };
    if (step === 0) {
      const pick = firstLeft(PL.prio);
      const routes = PL.prio.filter(([nm]) => PL.groups[nm]).map(([nm]) => route(nm, PL.groups[nm], nm === pick)).join("");
      return head(pick, PL.prio) + `<div>#${PL.picks[0]} ${buckets(PL.prio)}</div>` +
        (PL.avoid.length ? `<div class="sub">Not at this pick: ${PL.avoid.filter(nm => !gone(nm)).map(esc).join(", ")}</div>` : "") + routes + `</details>`;
    }
    const first = a.roster.length ? P[a.roster[0]].n : null, g = first ? PL.groups[first] : null;
    if (!g) return `<p class="note">Plan: your first pick wasn't one the plan covered, so use Fit below from here.</p>`;
    const list = step === 1 ? g.p2 : g.p3, pick = firstLeft(list), avoid = (step === 1 ? g.avoid2 : g.avoid3).filter(nm => !gone(nm) && !list.some(x => x[0] === nm));
    return head(pick, list) + route(first, g, true) +
      (avoid.length ? `<div class="sub">Not at this pick: ${avoid.map(esc).join(", ")}</div>` : "") + `<div class="sub">Fit below takes over after your third pick.</div></details>`;
  }

  // colour group by position, the same rule as the Draft Room's buckets: any C eligibility = big, else the first
  // listed position (PG/SG = guard, SF/PF = wing)
  const grp = p => { const ps = String(p.p || "").split("/"); return ps.includes("C") ? "big" : (ps[0] === "PG" || ps[0] === "SG") ? "guard" : "wing"; };

  function advice(S, teamId) {
    const roster = S.rosters.get(teamId) || [], k = roster.length;
    const tz = teamZ(roster), pz = parZ(S, Math.max(1, k));
    const need = Array.from({ length: NC }, (_, c) => (k ? Math.max(0, pz[c] - tz[c]) : 0)), mx = Math.max(...need, 1e-9);
    const left = S.R - k - 1, cOnly = roster.filter(i => P[i].mask === 16).length, out = [];
    for (const p of P) {
      if (S.taken.has(p.i) || (p.mask === 16 && cOnly >= 4)) continue;
      if (D.slots.length - match([...roster, p.i].map(i => P[i].mask)).n > Math.max(0, left)) continue;
      let fit = p.v; for (let c = 0; c < NC; c++) fit += NEED_WEIGHT * p.z[c] * need[c] / mx;
      out.push({ p, fit });
    }
    out.sort((a, b) => b.fit - a.fit);
    return { roster, list: out.slice(0, 12), all: out };
  }
  const liveBuckets = S => D.buckets.map(b => ({ n: b.n, left: P.filter(p => p.b === b.n && !p.hl && !S.taken.has(p.i)).map(p => p.i) })).filter(b => b.left.length);

  // ---------- views ----------
  const CSS = `
    .wrap { display: flex; flex-direction: column; background: #fff; color: #1d2433; border: 1px solid #c9d2e0; border-radius: 10px;
      font: 12.5px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; text-align: left; }
    .wrap.fixed { position: fixed; top: 64px; right: 10px; width: 400px; max-height: calc(100vh - 84px); z-index: 2147483000; box-shadow: 0 8px 28px rgba(15,25,45,.22); }
    .wrap.page { max-width: 760px; margin: 0 auto; min-height: 100vh; border-radius: 0; border-width: 0 1px; font-size: 14px; }
    .wrap.min { width: auto; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #1f2a44; color: #fff; border-radius: 9px 9px 0 0; }
    .wrap.page .hd { border-radius: 0; position: sticky; top: 0; z-index: 2; flex-wrap: wrap; }
    .wrap.min .hd { border-radius: 9px; }
    .hd b { font-size: 13px; letter-spacing: .02em; }
    .hd .st { font-size: 11px; opacity: .85; margin-left: auto; }
    .hd button { background: transparent; border: 1px solid rgba(255,255,255,.4); color: #fff; border-radius: 6px; padding: 1px 8px; cursor: pointer; font: inherit; }
    .tabs { display: flex; border-bottom: 1px solid #e3e8f0; background: #fff; }
    .wrap.page .tabs { position: sticky; top: 38px; z-index: 2; }
    .tabs button { flex: 1; background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 4px; cursor: pointer; font: 600 12px system-ui, sans-serif; color: #5b6578; }
    .tabs button.on { color: #1f2a44; border-bottom-color: #2f6fed; }
    #main { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .body { overflow: auto; padding: 8px 10px 12px; flex: 1; min-height: 0; }
    .wrap.page .body { overflow: visible; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0 8px; }
    select, input { font: inherit; padding: 3px 5px; border: 1px solid #c9d2e0; border-radius: 5px; background: #fff; color: inherit; max-width: 100%; }
    .btn { font: 600 12px system-ui, sans-serif; padding: 4px 10px; border-radius: 6px; border: 1px solid #2f6fed; background: #2f6fed; color: #fff; cursor: pointer; }
    .btn.ghost { background: #fff; color: #2f6fed; }
    .note { color: #5b6578; font-size: 11.5px; }
    .big { font-size: 13.5px; font-weight: 700; margin: 2px 0 6px; }
    .warnbox { background: #fff4e5; border: 1px solid #f5c48a; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
    .cg { display: grid; grid-template-columns: repeat(11, minmax(0, 1fr)); gap: 2px; margin: 2px 0 4px; }
    .cg.ch span { font-size: 9.5px; font-weight: 700; color: #556; text-align: center; letter-spacing: -.2px; }
    .cc { font-size: 10px; text-align: center; padding: 2px 0; border-radius: 3px; font-variant-numeric: tabular-nums; border: 1.5px solid transparent; }
    .cc.c2 { background: #2f9e5b; color: #fff; } .cc.c1 { background: #cdeed8; color: #145c31; } .cc.c0 { background: #eef0f4; color: #556; }
    .cc.n1 { background: #fbd9d7; color: #8a1f17; } .cc.n2 { background: #d9534f; color: #fff; }
    .cc.fix { border-color: #145c31; font-weight: 700; } .cc.dent { border-color: #8a1f17; font-weight: 700; }
    .teamnow { margin: 8px 0; padding: 6px 8px; border: 1px solid #d5dbe6; border-radius: 6px; background: #fafbfd; }
    .cmp input { width: 100%; box-sizing: border-box; padding: 5px 8px; border: 1px solid #c3cad8; border-radius: 6px; font: inherit; margin: 2px 0 8px; }
    tr.cgrow td { padding-top: 0; }
    tr.cghead td { padding: 1px 6px 0; }
    button.x { border: 0; background: none; color: #8a1f17; font-weight: 700; cursor: pointer; padding: 0 4px; }
    tbody.bgm { --bgc: #6b4bd1; --bgh: #e6defb; --bgl: #f7f4fe; }
    tr.bkhead td { font-weight: 600; font-size: 11.5px; padding: 3px 6px; color: #223; }
    tbody.bg td:first-child { border-left: 5px solid var(--bgc); }
    tbody.bg tr.bkhead td { background: var(--bgh); }
    tbody.bg tr:not(.bkhead):not(.sugrow) td { background: var(--bgl); }
    tbody.bg0 { --bgc: #3b6fd8; --bgh: #dbe6fb; --bgl: #f4f7fe; } tbody.bg1 { --bgc: #c75b1e; --bgh: #f8e1d3; --bgl: #fdf6f1; }
    tbody.bg2 { --bgc: #2f8a4f; --bgh: #d7efdf; --bgl: #f3faf5; } tbody.bg3 { --bgc: #5b5f73; --bgh: #e3e4ea; --bgl: #f7f7f9; }
    tbody.bgr { --bgc: #b8941c; --bgh: #f6ecc8; --bgl: #fdf9ec; }
    tr.sugrow td { background: #fff3ea; }
    .tag.sug { background: #c75b1e; color: #fff; border-color: #c75b1e; }
    .fallbox { background: #fff0f0; border: 2px solid #d9534f; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
    .tag.fall { background: #d9534f; color: #fff; border-color: #d9534f; }
    details.planbox summary { cursor: pointer; }
    .planbox { background: #eef4ff; border: 1px solid #a9c2f2; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
    .planbox .pb { display: inline-block; padding: 0 5px; margin: 1px 0; border: 1px solid #c9d6ee; border-radius: 4px; background: #fff; }
    .planbox .pb1 { border-color: #6f95e0; font-weight: 600; }
    .planbox s { color: #889; font-weight: 400; }
    .planbox .pbr { margin-top: 5px; padding: 4px 6px; border: 1px solid #c9d6ee; border-radius: 5px; line-height: 1.7; }
    .planbox .pbr.pbhl { border-color: #6f95e0; background: #f6f9ff; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 10.5px; color: #5b6578; font-weight: 600; padding: 3px 4px; border-bottom: 1px solid #e3e8f0; }
    td { padding: 4px; border-bottom: 1px solid #f0f2f6; vertical-align: top; }
    td.n { font-weight: 600; }
    .sub { display: block; font-weight: 400; color: #5b6578; font-size: 11px; }
    .tag { display: inline-block; font-size: 10px; font-weight: 700; padding: 0 5px; border-radius: 4px; margin-left: 4px; border: 1px solid; }
    .warn { color: #b42318; border-color: #f2b8b5; } .ok { color: #0a7a3d; border-color: #a6dcbc; } .info { color: #2f6fed; border-color: #b9cff2; }
    .g { color: #0a7a3d; } .r { color: #b42318; }
    .bars .b { display: grid; grid-template-columns: 38px 1fr 42px; align-items: center; gap: 6px; margin: 3px 0; }
    .bar { position: relative; height: 10px; background: #f0f2f6; border-radius: 3px; }
    .bar i { position: absolute; top: 0; bottom: 0; border-radius: 3px; }
    .bar:after { content: ""; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: #9aa5b8; }
    .bk { border: 1px solid #e3e8f0; border-radius: 8px; margin: 6px 0; }
    .bk.live { border-color: #2f9e5b; box-shadow: 0 0 0 2px #c6efce; }
    .bk.done { opacity: .5; }
    .bk h4 { margin: 0; padding: 5px 8px; font-size: 12px; background: #f5f7fb; border-radius: 8px 8px 0 0; display: flex; gap: 6px; }
    .bk h4 span { margin-left: auto; font-weight: 500; color: #5b6578; }
    .bk ul { list-style: none; margin: 0; padding: 4px 8px 6px; columns: 2; column-gap: 10px; }
    .bk li { break-inside: avoid; padding: 1px 0; }
    .g-guard { color: #1f55c4; } .g-wing { color: #b4520f; } .g-big { color: #1d7a43; }
    .bk li.g-guard, .bk li.g-wing, .bk li.g-big { font-weight: 600; border-left: 3px solid currentColor; padding-left: 4px; }
    .bk li.gone { text-decoration: line-through; color: #9aa5b8; font-weight: 400; }
    .bk li.mine { color: #2f6fed; font-weight: 700; text-decoration: none; }
    .bk li.punt { color: #b42318; }
    .bk li.rook { background: #fff3c4; border-radius: 3px; padding-left: 3px; }
    .bk li.hurt { background: #fbd5d5; border-radius: 3px; padding-left: 3px; }
    .tag.hurt { color: #9b1c1c; border-color: #f3a5a5; background: #fbd5d5; }
    .bk.rookies { border-color: #e6c200; } .bk.rookies h4 { background: #fff3c4; }
    .tag.gold { color: #8a6d00; border-color: #e6c200; background: #fff3c4; }
    .grid td, .grid th { text-align: center; padding: 3px 2px; font-size: 11px; }
    .grid td.l, .grid th.l { text-align: left; }
    .grid tr.me td { font-weight: 700; }
    .hide { display: none !important; }
    .lineup { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 8px; }
    .ls { border: 1px solid #a6dcbc; background: #eaf7ef; border-radius: 6px; padding: 2px 6px; min-width: 52px; font-size: 11px; line-height: 1.25; }
    .ls b { display: block; font-size: 10px; color: #0a7a3d; }
    .ls.open { border: 1px dashed #f2b8b5; background: #fff5f5; color: #b42318; } .ls.open b { color: #b42318; }
    .ls.be { border-color: #c9d2e0; background: #f5f7fb; } .ls.be b { color: #5b6578; }
    .lgrid td { font-size: 10.5px; padding: 2px 3px; white-space: nowrap; text-align: center; }
    .lgrid td.o { background: #fff5f5; color: #b42318; }
    .lgrid td.l { text-align: left; }
    code { font-size: 11px; background: #f0f2f6; padding: 1px 4px; border-radius: 4px; word-break: break-all; }`;

  // mount a panel into `root` (a shadow root or an element). opts: { mode: "fixed"|"page", getFeed(), prefs, save(), status(), extraTabs:{key:{label,render(S),bind(body)}} }
  function mount(root, opts) {
    const prefs = opts.prefs;
    const extra = opts.extraTabs || {};
    const tabs = [["best", "Best pick"], ["team", "My team"], ["buckets", "Buckets"], ["league", "League"], ...Object.entries(extra).map(([k, v]) => [k, v.label])];
    root.innerHTML = `<style>${CSS}</style>
      <div class="wrap ${opts.mode}" id="dhwrap">
        <div class="hd"><b>${esc(opts.title || "Draft Helper")}</b><span class="st" id="dhst"></span>${opts.mode === "fixed" ? `<button id="dhtog" title="Collapse or expand">–</button>` : ""}</div>
        <div id="main"><div class="tabs">${tabs.map(([k, l]) => `<button data-t="${k}">${esc(l)}</button>`).join("")}</div><div class="body" id="dhbody"></div></div>
      </div>`;
    const $ = id => root.querySelector("#" + id);
    root.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { prefs.tab = b.dataset.t; opts.save(); render(true); });
    if ($("dhtog")) $("dhtog").onclick = () => { prefs.collapsed = !prefs.collapsed; opts.save(); render(true); };
    let S = null, lastSig = "", lastTab = "";
    const teamName = id => (S.teams.find(t => t.id === id) || {}).name || "?";
    const picker = (label, val, kind) => `<label>${label} <select data-pick="${kind}"><option value="">choose…</option>${S.teams.map(t =>
      `<option value="${esc(t.id)}"${t.id === val ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>`;

    function best() {
      if (!S.teams.length) return `<p class="note">Waiting for the draft to start…</p>`;
      if (!S.my) return `<div class="row">${picker("Which team is yours?", S.my, "my")}</div><p class="note">Pick your team once; this device remembers it.</p>`;
      if (!S.slot) return `<div class="row">${picker("Your team", S.my, "my")}</div>
        <div class="row"><label>Your draft slot <input type="number" min="1" max="${S.T}" id="slotIn" style="width:60px"></label></div>
        <p class="note">The pick order isn't known yet. Type your slot, or it fills in after your first pick.</p>`;
      if (!S.next.length) return `<div class="row">${picker("Team", S.my, "my")}</div><p class="big">Roster full. Good luck!</p>`;
      const a = advice(S, S.my), nextPick = S.next[0], after = S.next[1], away = nextPick - S.made - 1, open = openSlots(a.roster);
      const top = liveBuckets(S)[0];
      /* options grouped by bucket (the same tiers as the Buckets tab), best Fit first inside each: ESPN's own ranked
         list is on screen beside this panel, so this view is for choosing among options rather than a second list.
         The top Fit is marked suggested; the best rookie and injury gamble below the top 10 are offered as reaches. */
      const top10 = a.list.slice(0, 10), inTop = new Set(top10.map(x => x.p.i));
      /* fallers: still there although BOTH the board and the league's ADP had him gone well before this pick (board
         rank and ADP at least 6 before it). Always shown, plan folded or not, because a real drop is the moment to
         rethink the plan; the coach's plan already ranks the usual fallers first. */
      const fallers = P.filter(p => !S.taken.has(p.i) && p.r && p.adp != null && p.r <= nextPick - 6 && p.adp <= nextPick - 6).sort((x, y) => x.r - y.r).slice(0, 3);
      const fallSet = new Set(fallers.map(p => p.i));
      const fallBox = fallers.length ? `<div class="fallbox"><b>Fallen to you:</b> ${fallers.map(p => `<span class="g-${grp(p)}">${esc(p.n)}</span> <span class="sub">board #${p.r} · ADP ${Math.round(p.adp)}</span>`).join(" · ")}<div class="sub">Expected gone by now. Add him to your shortlist below to see what he does to your team.</div></div>` : "";
      const reach = [["rookie", x => x.p.rk], ["injury", x => x.p.hl]].map(([kind, f]) => { const x = a.all.find(y => f(y) && !inTop.has(y.p.i)); return x ? { ...x, kind } : null; }).filter(Boolean);
      /* the category grid, LIVE against the league: your rank (1 = best of the S.T teams) in every category, now and
         after each option, read from every team's actual picks. Each team is measured against an average team with
         the same number of picks (parZ), so a team holding one more pick mid-round is not counted as ahead. TO counts
         fewer as better. An outlined cell is a pick that lifts a weak category 4+ places (green) or drops one 4+ (red). */
      const k = a.roster.length, tz = teamZ(a.roster), pzNow = parZ(S, Math.max(1, k)), pzAfter = parZ(S, k + 1);
      const now = CATS.map((c, j) => (k ? tz[j] - pzNow[j] : 0));
      const others = S.teams.filter(tm => tm.id !== S.my).map(tm => { const ro = S.rosters.get(tm.id) || [], kt = ro.length;
        if (!kt) return new Float64Array(NC); const z = teamZ(ro), pz = parZ(S, kt); return z.map((v, j) => v - pz[j]); });
      const rankOf = vals => vals.map((v, j) => 1 + others.filter(g => g[j] > v + 1e-9).length);
      const nowRank = rankOf(now), nT = others.length + 1;
      const shade = r => r <= Math.ceil(nT * 0.2) ? "c2" : r <= Math.ceil(nT * 0.4) ? "c1" : r <= Math.ceil(nT * 0.6) ? "c0" : r <= Math.ceil(nT * 0.8) ? "n1" : "n2";
      const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(1);
      const grid = (vals, ref) => { const rk = rankOf(vals); return `<div class="cg">${rk.map((r, j) => { const d = ref ? r - ref[j] : 0;
        const mk = ref && ref[j] > nT / 2 && d <= -4 ? " fix" : ref && d >= 4 ? " dent" : "";
        return `<span class="cc ${shade(r)}${mk}" title="${esc(CATS[j])}: ${r} of ${nT}${ref ? ` (now ${ref[j]})` : ""} · ${fmt(vals[j])} vs an average team">${r}</span>`; }).join("")}</div>`; };
      const head = `<div class="cg ch">${CATS.map(c => `<span>${esc(c === "FG%" ? "FG" : c === "FT%" ? "FT" : c === "3P%" ? "3P%" : c)}</span>`).join("")}</div>`;
      const afterOf = p => CATS.map((c, j) => tz[j] + p.z[j] - pzAfter[j]);
      const row = ({ p, fit }, rank, kind) => {
        let risk = "";
        if (p.adp != null && p.adp < nextPick) risk = `<span class="tag warn" title="League ADP ${p.adp}">likely gone</span>`;
        else if (p.adp != null && after && p.adp < after) risk = `<span class="tag info">won't come back</span>`;
        const fills = open.filter(s => s !== "UTIL" && (SLOT_MASK[s] & p.mask));
        const rm = kind === "mine" ? ` <button class="x" data-uncmp="${p.i}" title="Remove from your shortlist">×</button>` : "";
        return `<tr${rank === 0 && !kind ? ` class="sugrow"` : ""}><td>${p.r}</td><td class="n">${rank === 0 && !kind ? `<span class="tag sug">suggested</span>` : ""}${kind === "rookie" || kind === "injury" ? `<span class="tag ${kind === "rookie" ? "gold" : "hurt"}">${kind} reach</span>` : ""}<span class="g-${grp(p)}">${esc(p.n)}</span>${p.rk ? `<span class="tag gold" title="Rookie: range ${esc(p.rr || "?")}">rookie</span>` : ""}${p.hl ? `<span class="tag hurt" title="${p.gp} projected games">${p.gp} games</span>` : ""}${fallSet.has(p.i) ? `<span class="tag fall">fallen</span>` : ""}${fills.length ? `<span class="tag ok">fills ${fills.join("/")}</span>` : ""}${risk}${rm}
          <span class="sub">${esc(p.p)} · ${esc(p.t || "")} · ADP ${p.adp ?? "–"}</span></td><td>${fit.toFixed(1)}</td></tr>
          <tr class="cgrow${rank === 0 && !kind ? " sugrow" : ""}"><td></td><td colspan="2">${grid(afterOf(p), nowRank)}</td></tr>`;
      };
      // your own shortlist: anyone you add, compared on the same grid (removed automatically once taken)
      prefs.compare = (prefs.compare || []).filter(i => P[i] && !S.taken.has(i));
      const fitOf = new Map(a.all.map(x => [x.p.i, x.fit]));
      const shortRows = prefs.compare.map(i => row({ p: P[i], fit: fitOf.get(i) ?? 0 }, 1, "mine")).join("");
      const avail = P.filter(p => !S.taken.has(p.i) && p.r).sort((x, y) => x.r - y.r).slice(0, 260);
      const compareBox = `<div class="cmp"><input id="cmpIn" list="cmpList" placeholder="Add any player to compare…" autocomplete="off"><datalist id="cmpList">${avail.map(p => `<option value="${esc(p.n)}">`).join("")}</datalist></div>`;
      const groups = new Map(); top10.forEach((x, n) => { const b = x.p.b ?? 99; if (!groups.has(b)) groups.set(b, []); groups.get(b).push(row(x, n)); });
      // colour bands: each bucket a colour (cycling), so the groups read at a glance beside ESPN's list
      const rows = (shortRows ? `<tbody class="bg bgm"><tr class="bkhead"><td colspan="3">Your shortlist</td></tr><tr class="cghead"><td></td><td colspan="2">${head}</td></tr>${shortRows}</tbody>` : "") +
        [...groups].sort((x, y) => x[0] - y[0]).map(([b, rs], n) => `<tbody class="bg bg${n % 4}"><tr class="bkhead"><td colspan="3">${b === 99 ? "Beyond the buckets" : `Bucket ${b}`}</td></tr><tr class="cghead"><td></td><td colspan="2">${head}</td></tr>${rs.join("")}</tbody>`).join("") +
        (reach.length ? `<tbody class="bg bgr"><tr class="bkhead"><td colspan="3">Reaches: upside, at a cost in Fit</td></tr><tr class="cghead"><td></td><td colspan="2">${head}</td></tr>${reach.map(x => row(x, 1, x.kind)).join("")}</tbody>` : "");
      // (the 'model users picking before you' warning was removed on request, 17 Oct; the League tab still lists them)
      return `<div class="row">${picker("Team", S.my, "my")}</div>
        <p class="big">Next pick: #${nextPick} <span class="note">(${away <= 0 ? "on the clock now" : away + " picks away"} · slot ${S.slot})</span><span class="note" style="float:right">v${PANEL_VERSION}</span></p>
        ${fallBox}${planLine(S, a, nextPick)}
        ${top ? `<p class="note">Highest bucket left: <b>Bucket ${top.n}</b>: ${top.left.slice(0, 4).map(i => esc(P[i].n)).join(", ")}${top.left.length > 4 ? "…" : ""}</p>` : ""}
        ${lineupHtml(a.roster, S.R - D.slots.length)}
        <div class="teamnow"><b>Your rank in each category</b> <span class="note">live, against the ${nT} teams' actual picks (1 = best; green top, red bottom)</span>${head}${grid(now, null)}</div>
        ${compareBox}
        <table class="opts"><thead><tr><th>Rk</th><th>Player · each grid = your category ranks after taking him</th><th title="Value plus a lean toward your weak categories">Fit</th></tr></thead>${rows}</table>
        <p class="note">Options by bucket, best Fit first; add anyone to your shortlist with the box above. Under each player: your rank in every category if you take him, against everyone's picks so far (outlined green = lifts a weak category 4+ places, red = drops one 4+). Fit = board value leaning to your weak categories; suggested = top Fit. "Likely gone" = league ADP is before your pick.</p>`;
    }

    function team() {
      const id = prefs.view || S.my;
      if (!id) return `<div class="row">${picker("Show team", id, "view")}</div>`;
      const roster = S.rosters.get(id) || [], k = roster.length, tz = teamZ(roster), pz = parZ(S, Math.max(1, k));
      const bars = CATS.map((c, j) => { const g = k ? tz[j] - pz[j] : 0, w = Math.min(50, Math.abs(g) * 8);
        return `<div class="b"><span>${c}</span><div class="bar"><i style="${g >= 0 ? `left:50%;width:${w}%;background:#2f9e5b` : `right:50%;width:${w}%;background:#d9534f`}"></i></div><span class="${g >= 0 ? "g" : "r"}">${g >= 0 ? "+" : ""}${g.toFixed(1)}</span></div>`; }).join("");
      const list = roster.map(i => { const p = P[i], helps = CATS.filter((c, j) => p.z[j] >= 0.8), hurts = CATS.filter((c, j) => p.z[j] <= -0.8);
        return `<tr><td class="n">${esc(p.n)}<span class="sub">${esc(p.p)} · ${esc(p.t || "")} · rank ${p.r}</span></td><td><span class="g">${helps.join(" ")}</span>${hurts.length ? `<br><span class="r">${hurts.join(" ")}</span>` : ""}</td></tr>`; }).join("");
      return `<div class="row">${picker("Team", id, "view")}</div>
        <p class="note">${k} of ${S.R} picked · open starting slots: ${openSlots(roster).join(", ") || "none"}</p>
        ${lineupHtml(roster, S.R - D.slots.length)}
        <p class="note">Bars compare with an average team after the same number of picks.</p>
        <div class="bars">${bars}</div>
        <table style="margin-top:8px"><thead><tr><th>Player</th><th>Helps / hurts</th></tr></thead><tbody>${list || `<tr><td colspan="2" class="note">No picks yet.</td></tr>`}</tbody></table>`;
    }

    function buckets() {
      const mine = new Set(S.my ? S.rosters.get(S.my) || [] : []);
      const owner = new Map(S.picks.filter(p => p.pi >= 0).map(p => [p.pi, p.team])), nxt = S.next[0];
      const block = (title, sub, members, cls) => {
        const left = members.filter(m => !S.taken.has(m.i)).length;
        const lis = members.map(m => { const p = P[m.i], gone = S.taken.has(p.i);
          const c = ["g-" + grp(p), gone ? "gone" : "", mine.has(p.i) ? "mine" : "", m.punt ? "punt" : "", p.hl ? "hurt" : p.rk ? "rook" : ""].join(" ");
          const tip = gone ? teamName(owner.get(p.i)) : p.hl ? `Injury risk: ${p.gp} projected games, board rank ${p.hp}` : p.rk ? `Rookie: could finish anywhere from #${p.rr || "?"}` : "";
          return `<li class="${c}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(p.n)}${m.punt ? ` (${esc(m.punt)})` : ""}${m.extra ? ` <span class="note">${esc(m.extra)}</span>` : ""}</li>`; }).join("");
        return `<div class="bk ${cls}${left ? "" : " done"}"><h4>${title}<span>${left ? `${sub} · ${left}/${members.length} left` : "all gone"}</span></h4>${left ? `<ul>${lis}</ul>` : ""}</div>`;
      };
      let html = `<p class="note"><b class="g-guard">Guards</b>, <b class="g-wing">wings</b> and <b class="g-big">bigs</b> are coloured. Struck through = taken. Blue = yours. Red = only worth that bucket if you punt the category shown. Pink = injury risk, placed where he'd be if healthy all year (number = where his expected games put him). Gold = rookie (could land well above or below). Green outline = league ADP has this bucket going at your next pick.</p>`;
      for (const b of D.buckets) {
        const members = P.filter(p => p.b === b.n).map(p => ({ i: p.i, extra: p.hl ? `${p.hp}+` : "" })).concat(P.filter(p => p.pt && p.pt[0] === b.n).map(p => ({ i: p.i, punt: p.pt[1] })));
        if (members.length) html += block(`Bucket ${b.n}`, `ADP ${b.adpLo}-${b.adpHi}`, members, nxt && nxt >= b.adpLo && nxt <= b.adpHi ? " live" : "");
      }
      const fl = P.filter(p => p.fl).map(p => ({ i: p.i }));
      if (fl.length) html += block("Fliers (rounds 8-10)", "upside", fl, "");
      const rk = P.filter(p => p.rk && p.r <= 320).map(p => ({ i: p.i, extra: `#${p.r}${p.b && p.b !== "H" ? " · B" + p.b : ""} · range ${p.rr || "?"}` }));
      if (rk.length) html += block("Rookies (all, by board rank)", "wide range", rk, "rookies");
      return html;
    }

    // teams drafting off a model like this one: their next pick and the three players a model most likely takes there
    function modelsBlock() {
      if (!S.teams.length) return "";
      const rows = S.models.map(id => { const l = likelyFor(S, id);
        return `<tr><td class="n">${esc(teamName(id))}<span class="sub">slot ${S.slotOf(id) ?? "?"}${l ? ` · next pick #${l.n}` : ""}</span></td><td>${!l ? `<span class="note">${S.slotOf(id) ? "no picks left" : "slot not known yet"}</span>` : l.list.map(p => esc(p.n)).join("<br>")}</td></tr>`; }).join("");
      const ticks = S.teams.filter(t => t.id !== S.my).map(t => `<label style="white-space:nowrap"><input type="checkbox" data-model="${esc(t.id)}"${S.models.includes(t.id) ? " checked" : ""}> ${esc(t.name)}${S.slotOf(t.id) ? ` (${S.slotOf(t.id)})` : ""}</label>`).join(" ");
      return `<p class="big">Model users</p>
        ${rows ? `<table><thead><tr><th>Team</th><th>If they follow the model</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="note">None watched yet.</p>`}
        <p class="note">Teams with this model's advice: these are its top three for their roster, by the same Fit as Best pick, leaving out players ADP has gone before their pick. They pick for themselves, so treat it as roughly a coin flip that they take one of these, not a certainty. Tick the teams to watch${(D.modelSlots || []).length ? ` (default: slots ${D.modelSlots.join(" and ")})` : ""}:</p>
        <div class="row">${ticks}</div>`;
    }

    function league() {
      const ids = S.teams.map(t => t.id).filter(id => (S.rosters.get(id) || []).length);
      if (!ids.length) return modelsBlock() + `<p class="note">No picks yet.</p>`;
      const Z = new Map(ids.map(id => [id, teamZ(S.rosters.get(id))])), n = ids.length;
      const rank = (id, j) => 1 + ids.filter(o => Z.get(o)[j] > Z.get(id)[j]).length;
      const tot = id => Z.get(id).reduce((a, b) => a + b, 0);
      const cell = r => { const t = (r - 1) / Math.max(1, n - 1); return `<td style="background:${t < 0.34 ? "#c6efce" : t > 0.66 ? "#f8cbad" : "#fff"}">${r}</td>`; };
      const rows = ids.slice().sort((a, b) => tot(b) - tot(a)).map((id, k) => `<tr class="${id === S.my ? "me" : ""}"><td class="l"><a href="#" data-view="${esc(id)}">${esc(teamName(id))}</a></td>${CATS.map((c, j) => cell(rank(id, j))).join("")}<td>${k + 1}</td></tr>`).join("");
      return modelsBlock() + `<p class="big" style="margin-top:12px">Category ranks</p><p class="note">Rank in each category from drafted players (1 = best; TO counts fewer as better). Tap a team for its page.</p>
        <div style="overflow:auto"><table class="grid"><thead><tr><th class="l">Team</th>${CATS.map(c => `<th>${c}</th>`).join("")}<th>All</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="big" style="margin-top:12px">Lineups</p>
        <p class="note">Who fills each starting slot (best players placed first). Red = still open. BE = bench.</p>
        <div style="overflow:auto"><table class="grid lgrid"><thead><tr><th class="l">Team</th>${D.slots.map(s => `<th>${s === "UTIL" ? "U" : s}</th>`).join("")}<th>BE</th></tr></thead><tbody>${
          S.teams.map(t => t.id).map(id => { const L = lineup(S.rosters.get(id) || []);
            return `<tr class="${id === S.my ? "me" : ""}"><td class="l"><a href="#" data-view="${esc(id)}">${esc(teamName(id))}</a></td>${L.slots.map(s => s.pi == null ? `<td class="o">–</td>` : `<td title="${esc(P[s.pi].n)}">${esc(lastName(P[s.pi].n))}</td>`).join("")}<td>${L.bench.map(i => esc(lastName(P[i].n))).join(", ")}</td></tr>`; }).join("")
        }</tbody></table></div>`;
    }

    const views = { best, team, buckets, league };
    function render(force) {
      const feed = opts.getFeed();
      S = compute(feed || {}, prefs);
      $("dhst").textContent = opts.status ? opts.status(S) : `${S.made}/${S.T * S.R} picks`;
      if (!views[prefs.tab] && !extra[prefs.tab]) prefs.tab = "best";
      const sig = [feed && feed.at, S.picks.length, S.made, S.my, S.slot, prefs.tab, prefs.view, prefs.collapsed, S.teams.length, opts.sig ? opts.sig() : ""].join("|");
      if (!force && sig === lastSig) return;
      lastSig = sig;
      $("dhwrap").classList.toggle("min", !!prefs.collapsed);
      $("main").classList.toggle("hide", !!prefs.collapsed);
      if ($("dhtog")) $("dhtog").textContent = prefs.collapsed ? "+" : "–";
      if (prefs.collapsed) return;
      root.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === prefs.tab));
      const body = $("dhbody"), y = body.scrollTop;
      body.innerHTML = (views[prefs.tab] ? views[prefs.tab]() : extra[prefs.tab].render(S))
        + (S.unknown.length ? `<p class="note">Not on our board: ${S.unknown.slice(-6).map(esc).join(", ")}</p>` : "")
        + (S.staleBoard ? `<p class="warnbox">The draft host's board was built ${esc(S.staleBoard)}; this one ${esc(D.built)}. Players match, values may differ: refresh this page${opts.mode === "fixed" ? " or update the extension" : ""} to get the latest board.</p>` : "")
        + `<p class="note" style="margin-top:10px">Panel v${PANEL_VERSION} · board built ${esc(D.built)} · ${D.teams}-team H2H ${NC}-cat (${CATS.join(", ")}).</p>`;
      if (prefs.tab !== lastTab && prefs.tab === "buckets") {
        const first = body.querySelector(".bk:not(.done)");
        if (opts.mode === "fixed") body.scrollTop = first ? first.offsetTop - body.offsetTop - 6 : 0;
        else if (first) first.scrollIntoView({ block: "start" });
      } else if (prefs.tab === lastTab) body.scrollTop = y; else body.scrollTop = 0;
      lastTab = prefs.tab;
      body.querySelectorAll("select[data-pick]").forEach(s => s.onchange = () => {
        if (s.dataset.pick === "my") { prefs.myTeam = s.value || null; prefs.slot = null; } else prefs.view = s.value || null;
        opts.save(); render(true); });
      const si = body.querySelector("#slotIn"); if (si) si.onchange = () => { const v = +si.value; if (v >= 1 && v <= S.T) { prefs.slot = v; opts.save(); render(true); } };
      body.querySelectorAll("a[data-view]").forEach(a => a.onclick = e => { e.preventDefault(); prefs.view = a.dataset.view; prefs.tab = "team"; opts.save(); render(true); });
      const pb = body.querySelector("details.planbox"); if (pb) pb.ontoggle = () => { if (!!prefs.planOpen !== pb.open) { prefs.planOpen = pb.open; opts.save(); } };
      const ci = body.querySelector("#cmpIn"); if (ci) ci.onchange = () => { const p = P.find(x => x.n === ci.value.trim()); if (!p) return;
        prefs.compare = [...new Set([...(prefs.compare || []), p.i])]; opts.save(); render(true); };
      body.querySelectorAll("button[data-uncmp]").forEach(b => b.onclick = () => { prefs.compare = (prefs.compare || []).filter(i => i !== +b.dataset.uncmp); opts.save(); render(true); });
      body.querySelectorAll("input[data-model]").forEach(c => c.onchange = () => {
        prefs.models = [...body.querySelectorAll("input[data-model]:checked")].map(x => x.dataset.model); opts.save(); render(true); });
      if (extra[prefs.tab] && extra[prefs.tab].bind) extra[prefs.tab].bind(body, S);
    }
    return { render };
  }

  // compact wire format for the relay (ntfy messages max 4 KB): picks as "overall:teamIndex:playerIndex;..."
  function pack(feed) {
    const ids = feed.teams.map(t => t[0]), u = {};
    const p = feed.picks.map(([o, t, pi, name]) => { let k = ids.indexOf(t); if (k < 0) { ids.push(t); feed.teams.push([t, t]); k = ids.length - 1; }
      if (pi < 0) u[o] = name; return `${o}:${k}:${pi}`; }).join(";");
    return { v: 2, T: feed.T, R: feed.R, league: feed.league, ids, names: feed.teams.map(t => t[1]), order: feed.order, p, u, built: feed.built, at: feed.at || Date.now() };
  }
  function unpack(m) {
    if (!m || m.v !== 2 || !Array.isArray(m.ids)) return null;
    const picks = (m.p ? m.p.split(";") : []).map(s => { const [o, k, pi] = s.split(":").map(Number); return [o, m.ids[k], pi, (m.u && m.u[o]) || ""]; });
    return { T: m.T, R: m.R, league: m.league, teams: m.ids.map((id, k) => [id, m.names[k]]), order: m.order, picks, built: m.built, at: m.at };
  }

  return { D, P, normName, byKey, byEspn, esc, compute, mount, pack, unpack };
})();
