// LAPIS Source DB frontend: a small single-page app over the /api JSON endpoints.
const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");
const AB_ZP = 31.4; // AB zero point for fluxes in nJy
const UL_SNR = 2; // below this S/N, plot a 2-sigma upper limit
const PALETTE = ["#c2410c", "#1d4ed8", "#047857", "#7c3aed", "#b91c1c", "#0e7490", "#a16207", "#be185d"];
let ME = null;
let TEMPLATES = null;
const ICON_COPY = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`;
const ICON_BELL = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`;

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const fmt = (v, n = 3) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(n));
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const md = (s) => DOMPurify.sanitize(marked.parse(s ?? ""));
const h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (r.status === 401 && !path.startsWith("/api/login")) {
    go(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new Error("Not signed in");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function sexagesimal(ra, dec) {
  const split = (v, d) => {
    const a = Math.abs(v);
    let x = Math.floor(a), m = Math.floor((a - x) * 60), s = ((a - x) * 60 - m) * 60;
    if (s.toFixed(d) >= 60) { s = 0; m += 1; }
    if (m >= 60) { m = 0; x += 1; }
    return [x, m, s];
  };
  const [rh, rm, rs] = split(ra / 15, 2);
  const [dd, dm, ds] = split(dec, 1);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(rh, 2)} ${p(rm, 2)} ${rs.toFixed(2).padStart(5, "0")}  ${dec < 0 ? "−" : "+"}${p(dd, 2)} ${p(dm, 2)} ${ds.toFixed(1).padStart(4, "0")}`;
}

const otypeChips = (otypes) =>
  Object.entries(otypes || {})
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `<a class="chip" href="/search?otype=${encodeURIComponent(t)}">${esc(t)} <b>+${n}</b></a>`)
    .join("");

const idList = (ids) => (ids || []).map((d) => `${esc(d.field_id)}:${d.cat_id}`).filter((v, i, a) => a.indexOf(v) === i).join(", ");

function busy(el, msg = "Loading…") {
  el.innerHTML = `<p class="muted">${msg}</p>`;
}

// ---------------------------------------------------------------- routing
function go(path) {
  history.pushState({}, "", path);
  route();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='/']");
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute("href"));
});
window.addEventListener("popstate", route);
$("#topsearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) go(`/search?q=${encodeURIComponent(q)}`);
});

async function route() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  window.scrollTo(0, 0);
  if (path === "/login") return loginPage(params.get("next") || "/");
  if (!ME) {
    try {
      ME = await api("/api/me");
    } catch {
      return;
    }
  }
  renderNav();
  try {
    if (path.startsWith("/source/")) return await sourcePage(decodeURIComponent(path.slice(8)));
    if (path === "/search") return await searchPage(params);
    if (path === "/account") return await accountPage();
    if (path === "/help") return helpPage();
    return await homePage();
  } catch (err) {
    main.innerHTML = `<div class="card error">${esc(err.message)}</div>`;
  }
}

function renderNav() {
  $("#usernav").innerHTML = `<div class="inbox"><button class="iconbtn" id="inboxbtn" title="Inbox" aria-label="Inbox">${ICON_BELL}<span class="badge" hidden></span></button><div class="inboxpanel" id="inboxpanel" hidden></div></div>
    <a href="/help">Help</a><a href="/account">${esc(ME.username)}</a><a href="#" id="logout">Sign out</a>`;
  $("#inboxbtn").onclick = (e) => {
    e.stopPropagation();
    const panel = $("#inboxpanel");
    panel.hidden ? openInbox() : (panel.hidden = true);
  };
  refreshInboxBadge();
  $("#logout").onclick = async (e) => {
    e.preventDefault();
    await api("/api/logout", { method: "POST" });
    ME = null;
    go("/login");
  };
}

// ---------------------------------------------------------------- inbox (top-bar dropdown)
const INBOX_KINDS = { comment: "commented on", upvote: "upvoted", downvote: "downvoted", sed: "uploaded an SED fit to", pz: "uploaded a P(z) to" };

async function refreshInboxBadge() {
  if (!ME || document.hidden) return;
  const { unread } = await api("/api/inbox?limit=1").catch(() => ({ unread: 0 }));
  const badge = $("#inboxbtn .badge");
  if (!badge) return;
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? "99+" : unread;
}
setInterval(refreshInboxBadge, 120000);
document.addEventListener("visibilitychange", refreshInboxBadge);

async function openInbox() {
  const panel = $("#inboxpanel");
  panel.hidden = false;
  panel.innerHTML = `<p class="muted small">Loading…</p>`;
  const { items, seen_at } = await api("/api/inbox?limit=50");
  panel.innerHTML = `<div class="inboxhead">Activity on sources you've worked on</div>` + (items.length
    ? `<ul>${items.map((r) => `<li class="${!seen_at || r.created_at > seen_at ? "unread" : ""}"><a href="/source/${encodeURIComponent(r.uid)}">
        <div><b>${esc(r.username)}</b> ${INBOX_KINDS[r.kind]} <span class="mono">${esc(r.uid)}</span>${r.kind === "comment" ? "" : r.kind === "sed" || r.kind === "pz" ? `: <i>${esc(r.text)}</i>` : ` as <i>${esc(r.text)}</i>`}</div>
        ${r.kind === "comment" ? `<div class="snippet">${esc(r.text)}</div>` : ""}<div class="small muted">${when(r.created_at)}</div></a></li>`).join("")}</ul>`
    : `<p class="muted small">Nothing yet. When others comment, vote, or upload fits on sources you've contributed to, it shows up here.</p>`);
  await api("/api/inbox/seen", { method: "POST" });
  $("#inboxbtn .badge").hidden = true;
}

document.addEventListener("click", (e) => {
  const panel = $("#inboxpanel");
  if (panel && !panel.hidden && !e.target.closest(".inbox")) panel.hidden = true;
  if (panel && e.target.closest("#inboxpanel a")) panel.hidden = true;
});

// ---------------------------------------------------------------- login / sign-up
function loginPage(next) {
  $("#usernav").innerHTML = "";
  main.innerHTML = `
  <div class="auth">
    <div class="tabs"><button data-tab="in" class="on">Sign in</button><button data-tab="up">Create account</button></div>
    <form id="f-in">
      <label>Username<input name="username" required autocomplete="username"></label>
      <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="primary">Sign in</button>
    </form>
    <form id="f-up" hidden>
      <label>Username<input name="username" required autocomplete="username"></label>
      <label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Verify password<input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>LAPIS team password<input name="team_password" type="password" required></label>
      <button class="primary">Create account</button>
    </form>
    <p class="error" id="autherr"></p>
  </div>`;
  main.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      main.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      $("#f-in").hidden = b.dataset.tab !== "in";
      $("#f-up").hidden = b.dataset.tab !== "up";
    }),
  );
  const submit = (id, url) =>
    $(id).addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api(url, { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
        ME = null;
        go(next);
      } catch (err) {
        $("#autherr").textContent = err.message;
      }
    });
  submit("#f-in", "/api/login");
  submit("#f-up", "/api/signup");
}

// ---------------------------------------------------------------- home
async function homePage() {
  busy(main);
  const [otypes, recent, fields] = await Promise.all([api("/api/otypes"), api("/api/recent?limit=30"), api("/api/fields")]);
  const kinds = INBOX_KINDS;
  main.innerHTML = `
  <section class="hero">
    <h1>LAPIS source annotations</h1>
    <form id="bigsearch"><input name="q" placeholder="LAPIS-J031403.46-180310.9 · 09947:1234 · 48.5144 -18.0530 · 03:14:03.5 -18:03:10.9" autofocus><button class="primary">Search</button></form>
  </section>
  <div class="grid2">
    <section class="card"><h2>Recent Activity</h2>
      ${recent.length ? `<ul class="activity">${recent.map((r) => `<li><span class="muted">${when(r.created_at)}</span> <b>${esc(r.username)}</b> ${kinds[r.kind]} <a href="/source/${encodeURIComponent(r.uid)}">${esc(r.uid)}</a>${r.kind === "comment" ? `<div class="snippet">${esc(r.text)}</div>` : r.kind === "sed" || r.kind === "pz" ? `: <i>${esc(r.text)}</i>` : ` as <i>${esc(r.text)}</i>`}</li>`).join("")}</ul>` : `<p class="muted">Nothing yet.</p>`}
    </section>
    <div>
      <section class="card"><h2>Browse by Object Type</h2>
        <ul class="plain">${otypes.map((o) => `<li><a href="/search?otype=${encodeURIComponent(o.otype)}">${esc(o.otype)}</a> <span class="muted">${o.n_sources}</span></li>`).join("")}</ul>
        <p><a href="/search?discussed=1">All discussed sources →</a></p>
      </section>
      <section class="card"><h2>Fields</h2>
        ${fields.length ? fields.map((f) => `<div class="field"><a href="/search?field=${encodeURIComponent(f.field_id)}"><b>${esc(f.label || f.field_id)}</b></a>${f.map_url ? ` · <a href="${esc(f.map_url)}" target="_blank">FitsMap</a>` : ""}
          <ul class="plain small">${(f.releases || []).map((r) => `<li>${esc(r.version)} · ${r.n_sources} sources (${r.n_new} new) · ${(r.filters || []).map((x) => x.name).join(" ")}${r.status !== "complete" ? ` · <span class="error">${r.status}</span>` : ""}</li>`).join("")}</ul></div>`).join("") : `<p class="muted">No fields ingested yet.</p>`}
      </section>
    </div>
  </div>`;
  $("#bigsearch").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) go(`/search?q=${encodeURIComponent(q)}`);
  });
}

// ---------------------------------------------------------------- search
async function searchPage(params) {
  busy(main, "Searching…");
  const q = params.get("q");
  let rows, title;
  if (q) {
    rows = await api(`/api/resolve?q=${encodeURIComponent(q)}&radius=${params.get("radius") || 1}`);
    if (rows.length === 1) return go(`/source/${encodeURIComponent(rows[0].uid)}`);
    title = `Results for “${esc(q)}”`;
  } else {
    rows = await api(`/api/search?${params}`);
    title = params.get("otype") ? `Object type: ${esc(params.get("otype"))}` : params.get("field") ? `Field ${esc(params.get("field"))}` : "Sources";
  }
  const hasSep = rows.some((r) => r.sep_arcsec != null);
  main.innerHTML = `
  <section class="card"><h2>${title} <span class="muted">(${rows.length}${rows.length >= 200 ? "+" : ""})</span></h2>
  ${q && !rows.length ? `<p>No match. Try a larger radius: <a href="/search?q=${encodeURIComponent(q)}&radius=5">5″</a> · <a href="/search?q=${encodeURIComponent(q)}&radius=30">30″</a></p>` : ""}
  ${rows.length ? `<table class="results"><thead><tr><th>Name</th><th>RA, Dec</th><th>Catalog IDs</th><th>Object types</th><th>Comments</th>${hasSep ? "<th>Sep. (″)</th>" : ""}</tr></thead><tbody>
    ${rows.map((r) => `<tr><td><a href="/source/${encodeURIComponent(r.uid)}">${esc(r.uid)}</a></td><td class="mono">${fmt(r.ra, 6)} ${fmt(r.dec, 6)}</td><td>${idList(r.ids)}</td><td>${otypeChips(r.otypes)}</td><td>${r.n_comments || ""}</td>${hasSep ? `<td>${fmt(r.sep_arcsec, 2)}</td>` : ""}</tr>`).join("")}
  </tbody></table>` : ""}</section>`;
}

// ---------------------------------------------------------------- source page
async function sourcePage(uid) {
  busy(main);
  const s = await api(`/api/sources/${encodeURIComponent(uid)}`);
  document.title = `${s.uid} · LAPIS`;
  const latest = latestPerField(s.detections);
  main.innerHTML = `
  <div class="toprow">
    <section class="card ident">
      <div class="namerow"><h1>${esc(s.uid)}</h1><button class="iconbtn" id="copylink" title="Copy permanent link" aria-label="Copy permanent link">${ICON_COPY}</button></div>
      <div class="catid">${catIds(s.detections)}</div>
      <div class="otypes" id="otypepills"></div>
      <table class="kv">
        <tr><th>ICRS coord. (sexagesimal)</th><td class="mono">${sexagesimal(s.ra, s.dec)}</td></tr>
        <tr><th>ICRS coord. (deg)</th><td class="mono">${fmt(s.ra, 7)}  ${fmt(s.dec, 7)}</td></tr>
        ${latest.map(photozRow).join("")}
      </table>
    </section>
    <section class="card discussion"><h2>Discussion</h2><div id="comments"></div>
      <form id="newcomment"><textarea name="body" rows="3" placeholder="Discuss the nature/identity of this source (Markdown supported)"></textarea><button class="primary">Post</button></form></section>
  </div>
  <section class="card"><div class="cardhead"><h2>Cutouts</h2><div class="controls">
    <label>Size <select id="cutsize">${[2, 4, 8, 16].map((v) => `<option ${v === 4 ? "selected" : ""} value="${v}">${v}″</option>`).join("")}</select></label></div></div>
    <div id="cutouts"></div></section>
  <section class="card"><div class="cardhead"><h2>Spectral Energy Distribution and P(z)</h2><div class="controls">
      <label>Aperture <select id="aper"></select></label>
      <label>Units <select id="sedunits"><option value="njy">nJy</option><option value="ab">AB mag</option></select></label></div></div>
      <div class="sedrow"><div id="sedplot" class="plot"></div><div id="pzplot" class="plot"></div></div>
      <p class="small muted">Triangles: ${UL_SNR}σ upper limits (S/N &lt; ${UL_SNR}). Horizontal bars: filter bandwidths. Catalog P(z) is binned in Δz = 1 centred on integer z, with z_a dashed; every P(z) is scaled to a peak of 1. Click legend entries to toggle.</p>
      <h3>Uploaded SED Fits and P(z)</h3><div id="sedlist"></div>
      <details><summary>Upload an SED fit or P(z)</summary>${sedUploadForm()}</details></section>
  <section class="card"><div class="cardhead"><h2>Color–Color</h2><div class="controls" id="ccaxes"></div></div>
    <div class="ccrow"><div id="ccplot" class="plot"></div><div id="cctoggles" class="toggles"></div></div></section>
  <section class="card"><h2>Catalog Data</h2><div id="catdata">${s.detections.map((d) => `<details data-rel="${esc(d.release_id)}" data-cat="${d.cat_id}"><summary>${esc(d.release_id)} · ID ${d.cat_id}</summary><div class="catbody muted">Loading…</div></details>`).join("")}</div></section>`;

  $("#copylink").onclick = () => {
    navigator.clipboard.writeText(`${location.origin}/source/${encodeURIComponent(s.uid)}`);
    $("#copylink").innerHTML = ICON_CHECK;
    $("#copylink").title = "Copied";
    setTimeout(() => ($("#copylink").innerHTML = ICON_COPY), 1500);
  };
  const state = { s, aperture: latest[0]?.default_aperture, blobs: {}, seds: {}, eazy: {}, backgrounds: {} };
  // re-fetch the source and redraw only the affected parts
  const refresh = async (...parts) => {
    Object.assign(s, await api(`/api/sources/${encodeURIComponent(uid)}`));
    if (parts.includes("otypes")) renderOtypes(s, refresh);
    if (parts.includes("comments")) renderComments(s, refresh);
    if (parts.includes("seds")) {
      renderSedList(s, refresh);
      await drawSed(state);
      await drawPz(state);
    }
  };
  renderCutouts(s);
  $("#cutsize").onchange = () => renderCutouts(s);
  renderComments(s, refresh);
  renderOtypes(s, refresh);
  renderSedList(s, refresh);
  setupSedUpload(s, refresh);
  main.querySelectorAll("#catdata details").forEach((d) => d.addEventListener("toggle", () => d.open && loadCatalogRow(d), { once: true }));
  await setupSed(state);
  await drawPz(state);
  await setupColorColor(state);
}

// "Catalog ID 2625 · jw10790-09947 (v101, v100)", one entry per field/ID pair
function catIds(dets) {
  const groups = {};
  dets.forEach((d) => (groups[`${d.field_id}:${d.cat_id}`] ??= { ...d, versions: [] }).versions.push(d.version));
  return Object.values(groups)
    .map((g) => `<span class="catid-item">Catalog ID <b>${g.cat_id}</b> <span class="muted">${esc(g.field_id)} (${g.versions.map(esc).join(", ")})</span></span>`)
    .join("");
}

// Newest release per field is shown by default
function latestPerField(dets) {
  const seen = new Set();
  return dets.filter((d) => !seen.has(d.field_id) && seen.add(d.field_id));
}

function photozRow(d) {
  const pz = d.photoz || {};
  return Object.entries(pz)
    .map(([ext, p]) => {
      const probs = Object.keys(p).filter((k) => k.startsWith("Prob_gt_")).map((k) => `P(z>${k.slice(8)})=${fmt(p[k], 2)}`).join(", ");
      return `<tr><th>${esc(ext)} <span class="muted">(${esc(d.version)})</span></th><td>z<sub>a</sub> = <b>${fmt(p.z_a, 2)}</b> (68%: ${fmt(p.l68, 2)}–${fmt(p.u68, 2)}), χ² = ${fmt(p.chi_a, 1)}${p.z_spec > 0 ? `, z<sub>spec</sub> = ${fmt(p.z_spec, 3)}` : ""}${probs ? `<br><span class="small muted">${probs}</span>` : ""}</td></tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------- cutouts from the FitsMap tiles
function skyToPix(meta, ra, dec) {
  const { crpix, crval, cd, is_ra_dec } = meta.wcs;
  const dx = (ra - crval[0]) * Math.cos(((crval[1] / 180) * Math.PI) * is_ra_dec);
  return [crpix[0] - 1 + dx / cd[0][0], crpix[1] - 1 + (dec - crval[1]) / cd[1][1]];
}

function renderCutouts(s) {
  const box = $("#cutouts");
  box.innerHTML = "";
  const arcsec = parseFloat($("#cutsize").value);
  for (const d of latestPerField(s.detections)) {
    const meta = d.map_meta;
    if (!meta) {
      box.append(h(`<p class="muted">${esc(d.field_id)}: no FitsMap registered.</p>`));
      continue;
    }
    const [x, y] = d.x != null ? [d.x, d.y] : skyToPix(meta, d.ra, d.dec);
    const pixscale = Math.abs(meta.wcs.cd[1][1]) * 3600;
    const row = h(`<div class="cutrow"><div class="cuthead">${esc(d.field_label || d.field_id)} <a class="small" target="_blank" href="${esc(meta.base)}/?ra=${d.ra.toFixed(7)}&dec=${d.dec.toFixed(7)}&zoom=7">open in FitsMap ↗</a></div><div class="cuts"></div></div>`);
    box.append(row);
    for (const layer of meta.layers) {
      const fig = h(`<figure class="cut"><canvas width="180" height="180"></canvas><figcaption>${esc(layer.name)}</figcaption></figure>`);
      $(".cuts", row).append(fig);
      drawCutout($("canvas", fig), d.field_id, layer, meta.transformation, x, y, arcsec / pixscale);
    }
  }
}

function drawCutout(canvas, field, layer, tf, x, y, sizePx) {
  const [a, b, c, d] = tf;
  let z = layer.maxNativeZoom;
  while (z > 0 && sizePx * Math.abs(a) * 2 ** z > 512) z--;
  const s = 2 ** z;
  const X = (a * (x + 0.5) + b) * s; // source position in screen pixels at zoom z
  const Y = (c * (y + 0.5) + d) * s;
  const half = (sizePx / 2) * Math.abs(a) * s;
  const ctx = canvas.getContext("2d");
  const k = canvas.width / (2 * half);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tiles = [];
  for (let tx = Math.floor((X - half) / 256); tx <= Math.floor((X + half) / 256); tx++)
    for (let ty = Math.floor((Y - half) / 256); ty <= Math.floor((Y + half) / 256); ty++) tiles.push([tx, ty]);
  reticle(ctx, canvas.width);
  for (const [tx, ty] of tiles) {
    if (tx < 0 || ty < 0) continue;
    loadTile(`/api/tiles/${encodeURIComponent(field)}/${encodeURIComponent(layer.name)}/${z}/${ty}/${tx}.png`).then((bmp) => {
      if (!bmp || !canvas.isConnected) return;
      ctx.drawImage(bmp, (tx * 256 - (X - half)) * k, (ty * 256 - (Y - half)) * k, 256 * k, 256 * k);
      reticle(ctx, canvas.width);
    });
  }
}

// Fetch a tile, retrying slow/failed upstream fetches with backoff; 404 means outside the map
async function loadTile(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return createImageBitmap(await r.blob());
    if (r?.status === 404) return null;
    await new Promise((res) => setTimeout(res, 1000 * 1.5 ** i));
  }
  return null;
}

function reticle(ctx, w) {
  const c = w / 2, g = w * 0.07, l = w * 0.14;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => {
    ctx.moveTo(c + dx * g, c + dy * g);
    ctx.lineTo(c + dx * (g + l), c + dy * (g + l));
  });
  ctx.stroke();
}

// ---------------------------------------------------------------- photometry access
async function blob(state, d) {
  const key = `${d.release_id}/${d.cat_id}`;
  if (!(key in state.blobs)) state.blobs[key] = await api(`/api/catalog/${encodeURIComponent(d.release_id)}/${d.cat_id}`).catch(() => null);
  return state.blobs[key];
}

// {band: [flux, err]} for detection d in the chosen aperture
async function photFor(state, d) {
  if (state.aperture === d.default_aperture) return d.phot || {};
  return (await blob(state, d))?.phot?.[state.aperture] || {};
}

const toMag = (f) => -2.5 * Math.log10(f) + AB_ZP;

// ---------------------------------------------------------------- SED plot
const plotLayout = (xt, yt, extra = {}) => ({
  margin: { l: 60, r: 10, t: 10, b: 50 },
  font: { family: "Inter, system-ui, sans-serif", size: 12, color: getComputedStyle(document.body).getPropertyValue("--fg") },
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  xaxis: { title: xt, showline: true, mirror: true, ticks: "inside", zeroline: false, gridcolor: "rgba(128,128,128,0.15)" },
  yaxis: { title: yt, showline: true, mirror: true, ticks: "inside", zeroline: false, gridcolor: "rgba(128,128,128,0.15)" },
  legend: { font: { size: 10 }, bgcolor: "rgba(0,0,0,0)" },
  hovermode: "closest",
  ...extra,
});

async function setupSed(state) {
  const aps = [...new Set(state.s.detections.flatMap((d) => d.apertures || []))];
  $("#aper").innerHTML = aps.map((a) => `<option ${a === state.aperture ? "selected" : ""}>${esc(a)}</option>`).join("");
  $("#aper").onchange = async (e) => {
    state.aperture = e.target.value;
    await drawSed(state);
    await drawColorColor(state);
  };
  $("#sedunits").onchange = () => drawSed(state);
  await drawSed(state);
}

async function drawSed(state) {
  const ab = $("#sedunits").value === "ab";
  const traces = [];
  const dets = state.s.detections;
  for (const [i, d] of dets.entries()) {
    const phot = await photFor(state, d);
    const wave = Object.fromEntries((d.filters || []).map((f) => [f.name, f.wave_um]));
    const width = Object.fromEntries((d.filters || []).map((f) => [f.name, f.width_um ?? 0]));
    const xerr = (rows) => ({ type: "data", array: rows.map(([b]) => width[b] / 2), visible: true, color, thickness: 1, width: 0 });
    const pts = Object.entries(phot).filter(([b, [f, e]]) => wave[b] && f != null && e > 0);
    const det = pts.filter(([, [f, e]]) => f / e >= UL_SNR);
    const ul = pts.filter(([, [f, e]]) => f / e < UL_SNR);
    const name = `${d.field_id}:${d.cat_id} (${d.version})`;
    const color = PALETTE[i % PALETTE.length];
    traces.push({
      x: det.map(([b]) => wave[b]),
      y: det.map(([, [f]]) => (ab ? toMag(f) : f)),
      error_x: xerr(det),
      error_y: { type: "data", array: det.map(([, [f, e]]) => (ab ? 1.0857 * (e / f) : e)), visible: true, color },
      text: det.map(([b, [f, e]]) => `${b}: ${fmt(f, 1)} ± ${fmt(e, 1)} nJy (S/N ${fmt(f / e, 1)})`),
      hoverinfo: "text",
      mode: "markers",
      marker: { color, size: 8 },
      name,
      legendgroup: name,
    });
    if (ul.length)
      traces.push({
        x: ul.map(([b]) => wave[b]),
        y: ul.map(([, [f, e]]) => (ab ? toMag(Math.max(f, 0) + UL_SNR * e) : Math.max(f, 0) + UL_SNR * e)),
        error_x: xerr(ul),
        text: ul.map(([b, [f, e]]) => `${b}: ${fmt(f, 1)} ± ${fmt(e, 1)} nJy (${UL_SNR}σ limit)`),
        hoverinfo: "text",
        mode: "markers",
        marker: { color, size: 10, symbol: ab ? "triangle-up-open" : "triangle-down-open" },
        name: det.length ? `${name} limits` : name,
        legendgroup: name,
        showlegend: !det.length,
      });
  }
  // EAZY best fit stored with each release (404 -> none)
  for (const [i, d] of dets.entries()) {
    const key = `${d.release_id}/${d.cat_id}`;
    if (!(key in state.eazy)) state.eazy[key] = await api(`/api/eazy/${encodeURIComponent(d.release_id)}/${d.cat_id}`).catch(() => null);
    const fit = state.eazy[key];
    if (!fit) continue;
    const keep = fit.fnu_njy.map((f) => f > 0);
    traces.push({
      x: fit.wave_um.filter((_, j) => keep[j]),
      y: fit.fnu_njy.filter((_, j) => keep[j]).map((f) => (ab ? toMag(f) : f)),
      mode: "lines",
      line: { width: 1, color: PALETTE[i % PALETTE.length] },
      opacity: 0.6,
      name: `EAZY fit to ${fit.aperture} (z = ${fmt(fit.z, 2)})${dets.length > 1 ? ` · ${d.version}` : ""}`,
      hoverinfo: "x+y+name",
    });
  }
  for (const [i, m] of state.s.seds.filter((m) => m.kind !== "pz").entries()) {
    state.seds[m.id] ??= await api(`/api/seds/${m.id}`).catch(() => null);
    const data = state.seds[m.id];
    if (!data) continue;
    const keep = data.fnu_njy.map((f, j) => (ab ? f > 0 : true) && data.wave_um[j] > 0);
    traces.push({
      x: data.wave_um.filter((_, j) => keep[j]),
      y: data.fnu_njy.filter((_, j) => keep[j]).map((f) => (ab ? toMag(f) : f)),
      mode: "lines",
      line: { width: 1.3, color: PALETTE[(i + 3) % PALETTE.length] },
      name: `${m.label} (${m.username})`,
      hoverinfo: "x+y+name",
    });
  }
  const fluxes = traces.filter((t) => t.mode === "markers").flatMap((t) => t.y).filter((v) => v > 0);
  Plotly.react(
    "sedplot",
    traces,
    plotLayout("Wavelength [μm]", ab ? "AB magnitude" : "F<sub>ν</sub> [nJy]", {
      xaxis: { ...plotLayout().xaxis, title: "Wavelength [μm]", type: "log" },
      yaxis: ab
        ? { ...plotLayout().yaxis, title: "AB magnitude", ...(fluxes.length ? { range: [Math.max(...fluxes) + 0.8, Math.min(...fluxes) - 0.8] } : { autorange: "reversed" }) }
        : { ...plotLayout().yaxis, title: "F<sub>ν</sub> [nJy]", type: "log", ...(fluxes.length ? { range: [Math.log10(Math.min(...fluxes)) - 0.7, Math.log10(Math.max(...fluxes)) + 0.5] } : {}) },
      legend: { x: 0.01, y: 0.99, font: { size: 10 } },
    }),
    { responsive: true, displaylogo: false },
  );
}

// ---------------------------------------------------------------- P(z)
const PZ_EDGES = [0, ...Array.from({ length: 22 }, (_, k) => k + 0.5)]; // catalog bins: centred on z = 0..21

const peakNorm = (y) => {
  const top = Math.max(...y.filter((v) => v > 0));
  return top > 0 ? y.map((v) => v / top) : y;
};

async function drawPz(state) {
  const traces = [], marks = [];
  const dets = state.s.detections;
  for (const [i, d] of dets.entries()) {
    const cols = (await blob(state, d))?.columns || {};
    const tables = Object.keys(cols).filter((t) => Array.isArray(cols[t].Prob_z_bins));
    for (const [j, t] of tables.entries()) {
      const p = cols[t].Prob_z_bins.map((v) => v ?? 0);
      const dens = peakNorm(p.map((v, k) => v / (PZ_EDGES[k + 1] - PZ_EDGES[k])));
      const name = `Catalog ${t}${dets.length > 1 ? ` · ${d.version}` : ""}`;
      const za = d.photoz?.[t]?.z_a;
      if (za != null) marks.push({ za, name, color: PALETTE[(i + j) % PALETTE.length] });
      traces.push({
        x: PZ_EDGES.slice(0, p.length + 1),
        y: [...dens, dens.at(-1)],
        mode: "lines",
        line: { shape: "hv", width: 1.5, color: PALETTE[(i + j) % PALETTE.length], dash: j ? "dot" : "solid" },
        fill: j ? "none" : "tozeroy",
        name,
        legendgroup: name,
        hovertemplate: "z = %{x}<br>P = %{y:.3g}<extra>%{fullData.name}</extra>",
      });
    }
  }
  for (const [i, m] of state.s.seds.filter((m) => m.kind === "pz").entries()) {
    state.seds[m.id] ??= await api(`/api/seds/${m.id}`).catch(() => null);
    const data = state.seds[m.id];
    if (!data) continue;
    const order = data.z.map((_, j) => j).sort((a, b) => data.z[a] - data.z[b]);
    traces.push({
      x: order.map((j) => data.z[j]),
      y: peakNorm(order.map((j) => data.pz[j])),
      mode: "lines",
      line: { width: 1.3, color: PALETTE[(i + 3) % PALETTE.length] },
      name: `${m.label} (${m.username})`,
      hovertemplate: "z = %{x}<br>P = %{y:.3g}<extra>%{fullData.name}</extra>",
    });
  }
  // default view: where any curve is above 1% of its peak, plus the z_a marks
  const zs = marks.map((m) => m.za);
  for (const t of traces) t.y.forEach((v, k) => v >= 0.01 && zs.push(t.x[k], ...(t.line.shape === "hv" ? [t.x[k + 1]] : [])));
  const [lo, hi] = zs.length ? [Math.min(...zs), Math.max(...zs)] : [0, 15];
  const pad = Math.max(0.5, 0.1 * (hi - lo));
  // z_a of each catalog P(z), toggled together with its curve
  for (const m of marks)
    traces.push({
      x: [m.za, m.za],
      y: [0, 1.05],
      mode: "lines",
      line: { color: m.color, width: 1.5, dash: "dash" },
      legendgroup: m.name,
      showlegend: false,
      name: `z_a = ${fmt(m.za, 2)}`,
      hovertemplate: `${m.name}<br>z_a = ${fmt(m.za, 2)}<extra></extra>`,
    });
  Plotly.react(
    "pzplot",
    traces,
    plotLayout("Redshift", "P(z) / P<sub>max</sub>", {
      xaxis: { ...plotLayout().xaxis, title: "Redshift", range: [Math.max(0, lo - pad), hi + pad] },
      yaxis: { ...plotLayout().yaxis, title: "P(z) / P<sub>max</sub>", range: [0, 1.08] },
      legend: { x: 0.99, xanchor: "right", y: 0.99, font: { size: 10 } },
    }),
    { responsive: true, displaylogo: false },
  );
}

// ---------------------------------------------------------------- color-color diagram
const CC_DEFAULT_ON = new Set(["galaxy_ztrack", "bd_observed"]);
const FAM_STYLE = {
  galaxy_ztrack: { color: "#1d4ed8", width: 1, opacity: 0.5 },
  bd_observed: { color: "#b91c1c", symbol: "star" },
  lrd: { color: "#be185d", symbol: "diamond" },
};
const MODEL_COLORS = ["#ea580c", "#a16207", "#047857", "#7c3aed", "#0e7490"];
const famStyle = (key) =>
  FAM_STYLE[key] || {
    color: MODEL_COLORS[TEMPLATES.families.filter((f) => !FAM_STYLE[f.key]).findIndex((f) => f.key === key) % MODEL_COLORS.length],
    width: 1.5,
    symbol: "circle",
  };

async function setupColorColor(state) {
  TEMPLATES ??= await fetch("/data/templates.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const bands = [...new Set(state.s.detections.flatMap((d) => (d.filters || []).map((f) => f.name)))];
  const pick = (want, fallback) => (bands.includes(want) ? want : fallback);
  const def = [pick("F277W", bands[1]), pick("F444W", bands.at(-1)), pick("F150W2", bands[0]), pick("F277W", bands[1])];
  const sel = (id, v) => `<select id="${id}">${bands.map((b) => `<option ${b === v ? "selected" : ""}>${b}</option>`).join("")}</select>`;
  $("#ccaxes").innerHTML = `<label>x ${sel("cx1", def[0])}−${sel("cx2", def[1])}</label><label>y ${sel("cy1", def[2])}−${sel("cy2", def[3])}</label>`;
  // LAPIS background: all sources of the newest release of each field this source is in
  const fields = latestPerField(state.s.detections);
  await Promise.all(fields.map(async (d) => (state.backgrounds[d.release_id] ??= await api(`/api/background/${encodeURIComponent(d.release_id)}`).catch(() => null))));
  const groups = [["LAPIS", fields.filter((d) => state.backgrounds[d.release_id]).map((d) => [`lapis:${d.release_id}`, `${d.field_id} (${d.version}, ${d.default_aperture})`, true])]];
  for (const f of TEMPLATES?.families || []) {
    let g = groups.find((x) => x[0] === f.category);
    if (!g) groups.push((g = [f.category, []]));
    g[1].push([f.key, f.label, CC_DEFAULT_ON.has(f.key)]);
  }
  $("#cctoggles").innerHTML = groups
    .filter((g) => g[1].length)
    .map(([cat, items]) => `<fieldset class="tgroup"><legend><label><input type="checkbox" data-cat> ${esc(cat)}</label>${cat === "LAPIS" ? ` <select id="bgsnr">${[3, 5, 10].map((v) => `<option ${v === 5 ? "selected" : ""} value="${v}">S/N ≥ ${v}</option>`).join("")}</select>` : ""}</legend>
      ${items.map(([k, l, on]) => `<label><input type="checkbox" data-fam="${esc(k)}" ${on ? "checked" : ""}> ${esc(l)}</label>`).join("")}</fieldset>`)
    .join("");
  // a category box shows/sets the state of all its members
  const syncCats = () =>
    main.querySelectorAll("#cctoggles .tgroup").forEach((g) => {
      const subs = [...g.querySelectorAll("[data-fam]")];
      const n = subs.filter((x) => x.checked).length;
      const c = g.querySelector("[data-cat]");
      c.checked = n === subs.length;
      c.indeterminate = n > 0 && n < subs.length;
    });
  main.querySelectorAll("#cctoggles [data-cat]").forEach(
    (c) =>
      (c.onchange = () => {
        c.closest(".tgroup").querySelectorAll("[data-fam]").forEach((x) => (x.checked = c.checked));
        drawColorColor(state);
      }),
  );
  main.querySelectorAll("#ccaxes select, #cctoggles [data-fam], #bgsnr").forEach((el) =>
    el.addEventListener("change", () => {
      syncCats();
      drawColorColor(state);
    }),
  );
  syncCats();
  await drawColorColor(state);
  // clicking a background source opens its page
  $("#ccplot").on("plotly_click", (ev) => {
    const p = ev.points[0];
    if (p?.data.meta?.field) go(`/search?q=${encodeURIComponent(`${p.data.meta.field}:${p.customdata}`)}`);
  });
}

const color = (mag, b1, b2, i) => {
  const m1 = Array.isArray(mag[b1]) ? mag[b1][i] : mag[b1];
  const m2 = Array.isArray(mag[b2]) ? mag[b2][i] : mag[b2];
  return m1 == null || m2 == null ? null : m1 - m2;
};

function backgroundTrace(bg, d, x1, x2, y1, y2, snr) {
  const ok = (b, i) => bg.flux[b]?.[i] > 0 && bg.err[b]?.[i] > 0 && bg.flux[b][i] / bg.err[b][i] >= snr;
  const m = (b, i) => toMag(bg.flux[b][i]);
  const xs = [], ys = [], ids = [];
  bg.ids.forEach((id, i) => {
    if (![x1, x2, y1, y2].every((b) => ok(b, i))) return;
    xs.push(m(x1, i) - m(x2, i));
    ys.push(m(y1, i) - m(y2, i));
    ids.push(id);
  });
  return {
    type: "scattergl", x: xs, y: ys, customdata: ids, meta: { field: d.field_id },
    mode: "markers", marker: { size: 3, color: "rgba(90,90,90,0.35)" },
    name: `${d.field_id} (${d.version}, S/N ≥ ${snr})`, legendgroup: "LAPIS", legendgrouptitle: { text: "LAPIS" },
    hovertemplate: `ID %{customdata}<br>${x1}−${x2} = %{x:.2f}<br>${y1}−${y2} = %{y:.2f}<extra>click to open</extra>`,
  };
}

// One trace per template family; tracks are joined with null gaps
function familyTrace(fam, x1, x2, y1, y2) {
  const st = famStyle(fam.key);
  const xs = [], ys = [], txt = [];
  const gap = () => xs.length && xs.at(-1) != null && (xs.push(null), ys.push(null), txt.push(null));
  for (const m of fam.members) {
    if (fam.kind === "track") {
      m.param.forEach((p, i) => {
        const cx = color(m.mag, x1, x2, i), cy = color(m.mag, y1, y2, i);
        if (cx == null || cy == null) return gap();
        xs.push(cx);
        ys.push(cy);
        txt.push(`${m.name}<br>${m.param_name} = ${p}`);
      });
      gap();
    } else {
      const cx = color(m.mag, x1, x2), cy = color(m.mag, y1, y2);
      if (cx == null || cy == null) continue;
      xs.push(cx);
      ys.push(cy);
      txt.push([m.name, ...Object.entries(m.meta || {}).map(([k, v]) => `${k}: ${v}`)].join("<br>"));
    }
  }
  const track = fam.kind === "track";
  return {
    x: xs, y: ys, text: txt, hoverinfo: "text", connectgaps: false,
    mode: track ? (fam.key === "galaxy_ztrack" ? "lines" : "lines+markers") : "markers",
    line: { color: st.color, width: st.width },
    marker: track ? { size: 3, color: st.color } : { color: st.color, symbol: st.symbol, size: 7, opacity: 0.85 },
    opacity: st.opacity ?? 0.9,
    name: fam.label, legendgroup: fam.category, legendgrouptitle: { text: fam.category },
  };
}

async function drawColorColor(state) {
  const [x1, x2, y1, y2] = ["#cx1", "#cx2", "#cy1", "#cy2"].map((id) => $(id).value);
  const on = new Set([...main.querySelectorAll("#cctoggles [data-fam]:checked")].map((el) => el.dataset.fam));
  const snr = parseFloat($("#bgsnr")?.value ?? "5");
  const traces = [];
  for (const d of latestPerField(state.s.detections)) {
    const bg = state.backgrounds[d.release_id];
    if (bg && on.has(`lapis:${d.release_id}`)) traces.push(backgroundTrace(bg, d, x1, x2, y1, y2, snr));
  }
  for (const fam of TEMPLATES?.families || []) if (on.has(fam.key)) traces.push(familyTrace(fam, x1, x2, y1, y2));
  // the source itself, one point per detection; WebGL like the background so it draws on top
  const src = [];
  for (const [i, d] of state.s.detections.entries()) {
    const pt = sourceColor(await photFor(state, d), x1, x2, y1, y2);
    if (!pt) continue;
    src.push(pt);
    // WebGL draws outlined triangles with speckle artifacts, so the outline is a larger black marker underneath
    traces.push({
      type: "scattergl", x: [pt.x], y: [pt.y], mode: "markers", hoverinfo: "skip", showlegend: false,
      marker: { size: 17, color: "#111", symbol: pt.symbol }, legendgroup: "source",
    });
    traces.push({
      type: "scattergl",
      x: [pt.x],
      y: [pt.y],
      error_x: { type: "data", array: [pt.ex], visible: !pt.limx, color: "#111" },
      error_y: { type: "data", array: [pt.ey], visible: !pt.limy, color: "#111" },
      mode: "markers",
      marker: { size: 13, color: PALETTE[i % PALETTE.length], symbol: pt.symbol },
      name: `${d.field_id}:${d.cat_id} (${d.version})`,
      legendgroup: "source",
      legendgrouptitle: { text: "This source" },
      text: [`${x1}−${x2} = ${fmt(pt.x, 2)}${pt.limx ? " (limit)" : ""}<br>${y1}−${y2} = ${fmt(pt.y, 2)}${pt.limy ? " (limit)" : ""}`],
      hoverinfo: "text+name",
    });
  }
  // default view: template-rich region, widened to include the source
  const range = (vals) => [Math.min(-1.5, ...vals.map((v) => v - 1)), Math.max(4, ...vals.map((v) => v + 1))];
  Plotly.react(
    "ccplot",
    traces,
    plotLayout(`${x1} − ${x2}`, `${y1} − ${y2}`, {
      xaxis: { ...plotLayout().xaxis, title: `${x1} − ${x2} [AB]`, range: range(src.map((p) => p.x)) },
      yaxis: { ...plotLayout().yaxis, title: `${y1} − ${y2} [AB]`, range: range(src.map((p) => p.y)) },
      legend: { orientation: "h", y: -0.22, font: { size: 10 }, groupclick: "toggleitem" },
    }),
    { responsive: true, displaylogo: false },
  );
}

// Color of the source with errors; a band with S/N < UL_SNR becomes a limit
function sourceColor(phot, x1, x2, y1, y2) {
  const mag = (b) => {
    const [f, e] = phot[b] || [];
    if (f == null || !(e > 0)) return null;
    return f / e >= UL_SNR ? { m: toMag(f), e: 1.0857 * (e / f), lim: false } : { m: toMag(Math.max(f, 0) + UL_SNR * e), e: 0, lim: true };
  };
  const [a, b, c, d] = [x1, x2, y1, y2].map(mag);
  if (!a || !b || !c || !d || (a.lim && b.lim) || (c.lim && d.lim)) return null;
  const limx = a.lim || b.lim, limy = c.lim || d.lim;
  // faint first band -> color is a lower limit (redder); faint second band -> upper limit
  const dirx = a.lim ? "right" : b.lim ? "left" : null;
  const diry = c.lim ? "up" : d.lim ? "down" : null;
  const symbol = diry ? `triangle-${diry}` : dirx ? `triangle-${dirx}` : "circle";
  return { x: a.m - b.m, y: c.m - d.m, ex: Math.hypot(a.e, b.e), ey: Math.hypot(c.e, d.e), limx, limy, symbol };
}

// ---------------------------------------------------------------- discussion & object types
function renderComments(s, refresh) {
  const box = $("#comments");
  box.innerHTML = s.comments.length
    ? s.comments.map((c) => `<article class="comment" data-id="${c.id}"><header><b>${esc(c.username)}</b> <span class="muted">${when(c.created_at)}${c.edited_at ? " (edited)" : ""}</span>
        ${c.username === ME.username ? `<span class="acts"><a href="#" data-act="edit">edit</a> <a href="#" data-act="del">delete</a></span>` : ""}</header><div class="body">${md(c.body)}</div></article>`).join("")
    : `<p class="muted">No discussion yet.</p>`;
  box.querySelectorAll("[data-act]").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const art = a.closest(".comment");
      const c = s.comments.find((x) => x.id == art.dataset.id);
      if (a.dataset.act === "del") {
        await api(`/api/comments/${c.id}`, { method: "DELETE" });
        return refresh("comments");
      }
      const body = $(".body", art);
      body.innerHTML = `<textarea rows="4">${esc(c.body)}</textarea><button class="primary">Save</button>`;
      $("button", body).onclick = async () => {
        await api(`/api/comments/${c.id}`, { method: "PATCH", body: { body: $("textarea", body).value } });
        refresh("comments");
      };
    }),
  );
  $("#newcomment").onsubmit = async (e) => {
    e.preventDefault();
    if (!e.target.body.value.trim()) return;
    await api(`/api/sources/${encodeURIComponent(s.uid)}/comments`, { method: "POST", body: { body: e.target.body.value } });
    e.target.reset();
    refresh("comments");
  };
}

// Object-type pills: net score with up/down buttons; "+" pill adds a new type (as an upvote)
async function renderOtypes(s, refresh) {
  const agg = {};
  for (const o of s.otypes) {
    const a = (agg[o.otype] ??= { score: 0, up: [], down: [], mine: 0 });
    a.score += o.vote;
    (o.vote > 0 ? a.up : a.down).push(o.username);
    if (o.username === ME.username) a.mine = o.vote;
  }
  const box = $("#otypepills");
  box.innerHTML =
    Object.entries(agg)
      .sort((x, y) => y[1].score - x[1].score)
      .map(([t, a]) => `<span class="pill${a.score <= 0 ? " neg" : ""}" data-otype="${esc(t)}" title="${esc(`▲ ${a.up.join(", ") || "–"}   ▼ ${a.down.join(", ") || "–"}`)}">
        <button class="vote${a.mine > 0 ? " on" : ""}" data-v="1" aria-label="upvote">▲</button><a href="/search?otype=${encodeURIComponent(t)}">${esc(t)}</a><span class="score">${a.score > 0 ? "+" : ""}${a.score}</span><button class="vote${a.mine < 0 ? " on" : ""}" data-v="-1" aria-label="downvote">▼</button></span>`)
      .join("") + `<button class="pill add" id="addotype" title="Add an object type">+</button>`;
  const vote = async (otype, v) => {
    await api(`/api/sources/${encodeURIComponent(s.uid)}/otypes`, { method: "POST", body: { otype, vote: v } });
    refresh("otypes");
  };
  box.querySelectorAll(".pill[data-otype]").forEach((p) =>
    p.querySelectorAll(".vote").forEach((btn) =>
      btn.addEventListener("click", () => {
        const v = parseInt(btn.dataset.v);
        vote(p.dataset.otype, agg[p.dataset.otype].mine === v ? 0 : v);
      }),
    ),
  );
  $("#addotype").onclick = async () => {
    const vocab = await api("/api/otypes");
    const form = h(`<form class="pill adding"><input list="otypevocab" placeholder="Object type, Enter to add" required><datalist id="otypevocab">${vocab.map((v) => `<option value="${esc(v.otype)}">${esc(v.description || "")}</option>`).join("")}</datalist></form>`);
    $("#addotype").replaceWith(form);
    const input = $("input", form);
    input.focus();
    input.addEventListener("keydown", (e) => e.key === "Escape" && renderOtypes(s, refresh));
    form.onsubmit = (e) => {
      e.preventDefault();
      if (input.value.trim()) vote(input.value.trim(), 1);
    };
  };
}

// ---------------------------------------------------------------- SED fit upload (text/CSV/ECSV)
const WAVE_UNITS = { um: 1, AA: 1e-4, nm: 1e-3 };
const FLUX_UNITS = ["nJy", "uJy", "mJy", "Jy", "erg/s/cm2/AA", "ABmag"];

function sedUploadForm() {
  return `<form id="sedupload" class="stack">
    <label>Type <select name="kind"><option value="sed">SED fit (columns: wavelength, flux[, error])</option><option value="pz">P(z) (columns: z, P)</option></select></label>
    <label>File (text/CSV/ECSV) <input type="file" name="file" required></label>
    <div class="inline" data-sedonly><label>Wavelength unit <select name="wunit">${Object.keys(WAVE_UNITS).map((u) => `<option>${u}</option>`).join("")}</select></label>
    <label>Flux unit <select name="funit">${FLUX_UNITS.map((u) => `<option>${u}</option>`).join("")}</select></label></div>
    <div class="inline"><label>Label <input name="label" required placeholder="e.g. Bagpipes delayed-τ"></label>
    <label>Code <input name="code" placeholder="EAZY / Bagpipes / Prospector / Sonora…"></label>
    <label data-sedonly>Redshift <input name="redshift" type="number" step="any"></label></div>
    <label>Notes <input name="notes"></label>
    <p class="small muted">FITS files: use the command-line client (<code>lapisdb upload-sed</code> / <code>lapisdb upload-pz</code>), which reads any astropy-readable table.</p>
    <button class="primary">Upload</button><span class="error" id="sederr"></span></form>`;
}

function parseTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  const rows = lines.map((l) => l.trim().split(/[\s,]+/));
  const header = rows[0].some((v) => isNaN(parseFloat(v))) ? rows.shift().map((v) => v.toLowerCase()) : null;
  const find = (re, fallback) => {
    const i = header ? header.findIndex((n) => re.test(n)) : -1;
    return i >= 0 ? i : fallback;
  };
  const iw = find(/^(wave|wavelength|lam|lambda|wl|wav)/, 0);
  const iff = find(/^(flux|fnu|f_nu|flam|f_lambda|f|model|sed)/, 1);
  const ie = find(/^(err|error|unc|sigma|e_|flux_err|fnu_err)/, rows[0]?.length > 2 ? 2 : -1);
  const num = rows.map((r) => r.map(parseFloat)).filter((r) => !isNaN(r[iw]) && !isNaN(r[iff]));
  return { w: num.map((r) => r[iw]), f: num.map((r) => r[iff]), e: ie >= 0 ? num.map((r) => r[ie]) : null };
}

// Convert to μm and nJy
function convertSed(t, wunit, funit) {
  const w = t.w.map((v) => v * WAVE_UNITS[wunit]);
  const conv = (v, i) => {
    if (funit === "ABmag") return 10 ** (-0.4 * (v - AB_ZP));
    if (funit === "erg/s/cm2/AA") return 3.33564095e4 * v * (w[i] * 1e4) ** 2 * 1e9;
    return v * { nJy: 1, uJy: 1e3, mJy: 1e6, Jy: 1e9 }[funit];
  };
  const f = t.f.map(conv);
  const e = t.e && (funit === "ABmag" ? t.e.map((dm, i) => (f[i] * dm) / 1.0857) : t.e.map(conv));
  return { wave_um: w, fnu_njy: f, ...(e ? { fnu_err: e } : {}) };
}

// Two-column z, P table (header names optional)
function parsePz(text) {
  const t = parseTable(text);
  return { z: t.w, pz: t.f };
}

function setupSedUpload(s, refresh) {
  const form = $("#sedupload");
  form.kind.onchange = () => form.querySelectorAll("[data-sedonly]").forEach((el) => (el.hidden = form.kind.value === "pz"));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pz = fd.get("kind") === "pz";
    try {
      const file = fd.get("file");
      const text = await file.text();
      const data = pz ? parsePz(text) : convertSed(parseTable(text), fd.get("wunit"), fd.get("funit"));
      if ((pz ? data.z : data.wave_um).length < 2) throw new Error("Could not read at least two numeric rows");
      await api(`/api/sources/${encodeURIComponent(s.uid)}/seds`, {
        method: "POST",
        body: {
          kind: fd.get("kind"),
          label: fd.get("label"),
          code: fd.get("code") || null,
          redshift: !pz && fd.get("redshift") ? parseFloat(fd.get("redshift")) : null,
          notes: fd.get("notes") || null,
          original_name: file.name,
          data,
        },
      });
      e.target.reset();
      form.kind.onchange();
      e.target.closest("details").open = false;
      refresh("seds");
    } catch (err) {
      $("#sederr").textContent = err.message;
    }
  };
}

function renderSedList(s, refresh) {
  $("#sedlist").innerHTML = s.seds.length
    ? `<table class="votes">${s.seds.map((m) => `<tr><td><b>${esc(m.label)}</b> <span class="chip">${m.kind === "pz" ? "P(z)" : "SED"}</span>${m.code ? ` <span class="muted">${esc(m.code)}</span>` : ""}${m.redshift != null ? ` · z=${fmt(m.redshift, 3)}` : ""}${m.notes ? `<div class="small">${esc(m.notes)}</div>` : ""}</td><td>${esc(m.username)}</td><td class="small muted">${when(m.created_at)}</td><td><a href="/api/seds/${m.id}" target="_blank">json</a> ${m.username === ME.username ? `<a href="#" data-del="${m.id}">delete</a>` : ""}</td></tr>`).join("")}</table>`
    : `<p class="muted">Nothing uploaded yet.</p>`;
  $("#sedlist").querySelectorAll("[data-del]").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      await api(`/api/seds/${a.dataset.del}`, { method: "DELETE" });
      refresh("seds");
    }),
  );
}

async function loadCatalogRow(det) {
  const body = $(".catbody", det);
  try {
    const row = await api(`/api/catalog/${encodeURIComponent(det.dataset.rel)}/${det.dataset.cat}`);
    body.classList.remove("muted");
    body.innerHTML = Object.entries(row.columns)
      .map(([ext, cols]) => `<h4>${esc(ext)}</h4><div class="coltable">${Object.entries(cols).map(([k, v]) => `<div><span>${esc(k)}</span><b>${Array.isArray(v) ? `[${v.length} values]` : typeof v === "number" ? +v.toPrecision(6) : esc(v)}</b></div>`).join("")}</div>`)
      .join("");
  } catch (err) {
    body.textContent = err.message;
  }
}

// ---------------------------------------------------------------- account & help
async function accountPage() {
  const tokens = await api("/api/tokens");
  main.innerHTML = `
  <section class="card"><h2>Account: ${esc(ME.username)}${ME.admin ? ` <span class="chip">admin</span>` : ""}</h2>
    <h3>API Tokens</h3>
    <p>Tokens let the command-line client, scripts (<code>curl</code>), and the MCP server act as you.</p>
    ${tokens.length ? `<table class="votes">${tokens.map((t) => `<tr><td>${esc(t.label || "(no label)")}</td><td class="muted small">${when(t.created_at)}</td><td><a href="#" data-revoke="${t.id}">revoke</a></td></tr>`).join("")}</table>` : `<p class="muted">No tokens yet.</p>`}
    <form id="newtoken" class="inline"><input name="label" placeholder="Label, e.g. laptop"><button class="primary">Create token</button></form>
    <pre id="tokenout" hidden></pre>
  </section>`;
  main.querySelectorAll("[data-revoke]").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      await api(`/api/tokens/${a.dataset.revoke}`, { method: "DELETE" });
      accountPage();
    }),
  );
  $("#newtoken").onsubmit = async (e) => {
    e.preventDefault();
    const { token } = await api("/api/tokens", { method: "POST", body: { label: e.target.label.value } });
    const out = $("#tokenout");
    out.hidden = false;
    out.textContent = `Copy this now; it will not be shown again:\n\n${token}\n\nCommand-line setup:\n  lapisdb login --url ${location.origin} --token ${token}`;
  };
}

function helpPage() {
  const o = location.origin;
  main.innerHTML = `
  <section class="card prose"><h2>Using the LAPIS Source DB</h2>
  <h3>Finding a Source</h3>
  <ul><li><b>Name</b>: <code>LAPIS-J031403.46-180310.9</code>. Every source has one permanent page at <code>${o}/source/&lt;name&gt;</code>.</li>
  <li><b>Catalog ID</b>: <code>09947:1234</code> or <code>jw10790-09947 1234</code> (field, then ID). A bare <code>1234</code> lists matches in every field.</li>
  <li><b>Coordinates</b>: <code>48.5144 -18.0530</code> or <code>03:14:03.46 -18:03:10.9</code> (1″ radius; larger radii offered if empty).</li></ul>
  <h3>From the Terminal</h3>
  <p>Create a token on your <a href="/account">account page</a>, then either use <code>curl</code>:</p>
  <pre>export LAPIS_TOKEN=lapis_...
curl -s -H "Authorization: Bearer $LAPIS_TOKEN" "${o}/api/resolve?q=09947:1234"

# classify / comment on many sources at once (up to 100 per request)
curl -s -X POST -H "Authorization: Bearer $LAPIS_TOKEN" -H "Content-Type: application/json" ${o}/api/bulk -d '{"ops": [
  {"source": "09947:1234", "add_otype": "Brown dwarf", "note": "T-dwarf colors"},
  {"source": "09947:1234", "downvote_otype": "Galaxy"},
  {"source": "09947:5678", "comment": "Looks like a diffraction spike"},
  {"source": "48.5144 -18.0530", "remove_otype": "Galaxy"}]}'
# add_otype = upvote, downvote_otype = downvote, remove_otype = clear your vote</pre>
  <p>or the Python client:</p>
  <pre>pip install ${o}/dl/lapisdb-0.1.0-py3-none-any.whl
lapisdb login --url ${o} --token lapis_...
lapisdb get 09947:1234
lapisdb annotate updates.csv          # columns: source, add_otype, downvote_otype, remove_otype, note, comment
lapisdb classify "Brown dwarf" 09947:1234 09947:5678 --note "F277W-F444W > 1.5"   # upvote
lapisdb downvote "Galaxy" 09947:1234
lapisdb comment 09947:1234 "Spectroscopic follow-up?"
lapisdb upload-sed 09947:1234 fit.fits --label "Bagpipes" --wave-unit AA --flux-unit erg/s/cm2/AA
lapisdb upload-pz 09947:1234 pz.txt --label "EAZY rerun"   # columns z, P</pre>
  <h3>MCP Server (Claude and Other AI Assistants)</h3>
  <pre>claude mcp add lapisdb -- lapisdb-mcp</pre>
  <p>It uses the same login as the command-line client.</p>
  <h3>Data Model</h3>
  <p>Each JWST pointing is a <i>field</i> with its own filters and FitsMap. Each catalog version is a <i>release</i>; new releases are added alongside old ones (nothing is overwritten) and matched by position to existing sources, so comments and classifications stay attached to the same page.</p>
  </section>`;
}

route();
