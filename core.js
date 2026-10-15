// Draft Helper core: shared by the Chrome extension (ESPN draft room panel) and the hosted live page.
// Input is a "feed" (the draft so far); output is the panel: best pick, team balance, live buckets, league table.
// Feed: { v:1, T, R, league, teams:[[id,name]], order:[teamId...]|null, picks:[[overall, teamId, playerIndex|-1, name]], at, built }
window.DraftCore = (() => {
  const D = DH_DATA, CATS = D.cats, NC = CATS.length, P = D.players;
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
    return { T, R, teams, picks, taken, rosters, my, slot, made, myPicks, next: myPicks.filter(n => n > made),
             unknown: picks.filter(p => p.pi < 0).map(p => p.name) };
  }

  const parZ = (S, k) => { const z = new Float64Array(NC), n = Math.min(P.length, S.T * k);
    for (let i = 0; i < n; i++) for (let c = 0; c < NC; c++) z[c] += P[i].z[c];
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
    return { roster, list: out.slice(0, 12) };
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
    .bk li.gone { text-decoration: line-through; color: #9aa5b8; }
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
      const rows = a.list.slice(0, 10).map(({ p, fit }) => {
        const helps = CATS.filter((c, j) => p.z[j] >= 0.8), hurts = CATS.filter((c, j) => p.z[j] <= -0.8);
        let risk = "";
        if (p.adp != null && p.adp < nextPick) risk = `<span class="tag warn" title="League ADP ${p.adp}">likely gone</span>`;
        else if (p.adp != null && after && p.adp < after) risk = `<span class="tag info">won't come back</span>`;
        const fills = open.filter(s => s !== "UTIL" && (SLOT_MASK[s] & p.mask));
        return `<tr><td>${p.r}</td><td class="n">${esc(p.n)}${p.rk ? `<span class="tag gold" title="Rookie: range ${esc(p.rr || "?")}">rookie</span>` : ""}${p.hl ? `<span class="tag hurt" title="${p.gp} projected games">injury risk</span>` : ""}${fills.length ? `<span class="tag ok">fills ${fills.join("/")}</span>` : ""}${risk}
          <span class="sub">${esc(p.p)} · ${esc(p.t || "")} · bucket ${p.b ?? "–"} · ADP ${p.adp ?? "–"}</span>
          <span class="sub"><span class="g">${helps.join(" ")}</span>${hurts.length ? ` · <span class="r">${hurts.join(" ")}</span>` : ""}</span></td><td>${fit.toFixed(1)}</td></tr>`;
      }).join("");
      return `<div class="row">${picker("Team", S.my, "my")}</div>
        <p class="big">Next pick: #${nextPick} <span class="note">(${away <= 0 ? "on the clock now" : away + " picks away"} · slot ${S.slot})</span></p>
        ${top ? `<p class="note">Highest bucket left: <b>Bucket ${top.n}</b>: ${top.left.slice(0, 4).map(i => esc(P[i].n)).join(", ")}${top.left.length > 4 ? "…" : ""}</p>` : ""}
        <p class="note">Open starting slots: ${open.join(", ") || "none, bench now"}</p>
        <table><thead><tr><th>Rk</th><th>Player</th><th title="Value plus a lean toward your weak categories">Fit</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="note">Fit = board value, leaning toward categories you're behind in. "Likely gone" = league ADP is before your pick.</p>`;
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
        <p class="note">${k} of ${S.R} picked · open starting slots: ${openSlots(roster).join(", ") || "none"}. Bars compare with an average team after the same number of picks.</p>
        <div class="bars">${bars}</div>
        <table style="margin-top:8px"><thead><tr><th>Player</th><th>Helps / hurts</th></tr></thead><tbody>${list || `<tr><td colspan="2" class="note">No picks yet.</td></tr>`}</tbody></table>`;
    }

    function buckets() {
      const mine = new Set(S.my ? S.rosters.get(S.my) || [] : []);
      const owner = new Map(S.picks.filter(p => p.pi >= 0).map(p => [p.pi, p.team])), nxt = S.next[0];
      const block = (title, sub, members, cls) => {
        const left = members.filter(m => !S.taken.has(m.i)).length;
        const lis = members.map(m => { const p = P[m.i], gone = S.taken.has(p.i);
          const c = [gone ? "gone" : "", mine.has(p.i) ? "mine" : "", m.punt ? "punt" : "", p.hl ? "hurt" : p.rk ? "rook" : ""].join(" ");
          const tip = gone ? teamName(owner.get(p.i)) : p.hl ? `Injury risk: ${p.gp} projected games, board rank ${p.hp}` : p.rk ? `Rookie: could finish anywhere from #${p.rr || "?"}` : "";
          return `<li class="${c}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(p.n)}${m.punt ? ` (${esc(m.punt)})` : ""}${m.extra ? ` <span class="note">${esc(m.extra)}</span>` : ""}</li>`; }).join("");
        return `<div class="bk ${cls}${left ? "" : " done"}"><h4>${title}<span>${left ? `${sub} · ${left}/${members.length} left` : "all gone"}</span></h4>${left ? `<ul>${lis}</ul>` : ""}</div>`;
      };
      let html = `<p class="note">Struck through = taken. Blue = yours. Red = only worth that bucket if you punt the category shown. Pink = injury risk, placed where he'd be if healthy all year (number = where his expected games put him). Gold = rookie (could land well above or below). Green outline = league ADP has this bucket going at your next pick.</p>`;
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

    function league() {
      const ids = S.teams.map(t => t.id).filter(id => (S.rosters.get(id) || []).length);
      if (!ids.length) return `<p class="note">No picks yet.</p>`;
      const Z = new Map(ids.map(id => [id, teamZ(S.rosters.get(id))])), n = ids.length;
      const rank = (id, j) => 1 + ids.filter(o => Z.get(o)[j] > Z.get(id)[j]).length;
      const tot = id => Z.get(id).reduce((a, b) => a + b, 0);
      const cell = r => { const t = (r - 1) / Math.max(1, n - 1); return `<td style="background:${t < 0.34 ? "#c6efce" : t > 0.66 ? "#f8cbad" : "#fff"}">${r}</td>`; };
      const rows = ids.slice().sort((a, b) => tot(b) - tot(a)).map((id, k) => `<tr class="${id === S.my ? "me" : ""}"><td class="l"><a href="#" data-view="${esc(id)}">${esc(teamName(id))}</a></td>${CATS.map((c, j) => cell(rank(id, j))).join("")}<td>${k + 1}</td></tr>`).join("");
      return `<p class="note">Rank in each category from drafted players (1 = best; TO counts fewer as better). Tap a team for its page.</p>
        <div style="overflow:auto"><table class="grid"><thead><tr><th class="l">Team</th>${CATS.map(c => `<th>${c}</th>`).join("")}<th>All</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
        + `<p class="note" style="margin-top:10px">Board built ${esc(D.built)} · ${D.teams}-team H2H ${NC}-cat (${CATS.join(", ")}).</p>`;
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
