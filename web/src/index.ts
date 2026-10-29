import { Hono, Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { now, randomToken, sha256, hashPassword, angSepArcsec, parseCoords, readFitsMap } from "./util";

type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  TEAM_PASSWORD: string;
  MAP_AUTH: string;
  ADMIN_USERS: string;
};
type Env = { Bindings: Bindings; Variables: { user: string } };
type Ctx = Context<Env>;

const app = new Hono<Env>();
const SESSION_DAYS = 30;
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
const parse = (s: string | null) => (s ? JSON.parse(s) : null);
const isAdmin = (c: Ctx) => c.env.ADMIN_USERS.split(",").map((s) => s.trim()).includes(c.get("user"));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// ---------------------------------------------------------------- auth
async function startSession(c: Ctx, username: string) {
  const token = randomToken();
  await c.env.DB.prepare("INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)")
    .bind(token, username, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString())
    .run();
  setCookie(c, "lapis_session", token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

app.post("/api/signup", async (c) => {
  const { username, password, password2, team_password } = await c.req.json();
  if (team_password !== c.env.TEAM_PASSWORD) return c.json({ error: "Wrong LAPIS team password" }, 403);
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username ?? ""))
    return c.json({ error: "Username: 2-32 characters, letters/digits/._-" }, 400);
  if (!password || password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);
  if (password !== password2) return c.json({ error: "Passwords do not match" }, 400);
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first())
    return c.json({ error: "Username already taken" }, 409);
  const salt = randomToken(16);
  await c.env.DB.prepare("INSERT INTO users (username, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?)")
    .bind(username, await hashPassword(password, salt), salt, now())
    .run();
  await startSession(c, username);
  return c.json({ username });
});

app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json();
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<any>();
  if (!u || (await hashPassword(password ?? "", u.pw_salt)) !== u.pw_hash)
    return c.json({ error: "Wrong username or password" }, 401);
  await startSession(c, username);
  return c.json({ username });
});

app.post("/api/logout", async (c) => {
  const token = getCookie(c, "lapis_session");
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  deleteCookie(c, "lapis_session", { path: "/" });
  return c.json({ ok: true });
});

// Every other /api route needs a browser session or an API token
app.use("/api/*", async (c: Ctx, next: Next) => {
  const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(\S+)/)?.[1];
  let user: string | undefined;
  if (bearer) {
    user = (
      await c.env.DB.prepare("SELECT username FROM api_tokens WHERE token_hash = ?").bind(await sha256(bearer)).first<any>()
    )?.username;
  } else {
    const token = getCookie(c, "lapis_session");
    if (token)
      user = (
        await c.env.DB.prepare("SELECT username FROM sessions WHERE token = ? AND expires_at > ?").bind(token, now()).first<any>()
      )?.username;
  }
  if (!user) return c.json({ error: "Not signed in" }, 401);
  c.set("user", user);
  await next();
});

app.use("/api/admin/*", async (c: Ctx, next: Next) => {
  if (!isAdmin(c)) return c.json({ error: "Admin only" }, 403);
  await next();
});

app.get("/api/me", (c) => c.json({ username: c.get("user"), admin: isAdmin(c) }));

app.get("/api/tokens", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, label, created_at FROM api_tokens WHERE username = ? ORDER BY id")
    .bind(c.get("user"))
    .all();
  return c.json(results);
});

app.post("/api/tokens", async (c) => {
  const { label } = await c.req.json().catch(() => ({}));
  const token = "lapis_" + randomToken(24);
  await c.env.DB.prepare("INSERT INTO api_tokens (token_hash, username, label, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), c.get("user"), label ?? null, now())
    .run();
  return c.json({ token });
});

app.delete("/api/tokens/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND username = ?").bind(c.req.param("id"), c.get("user")).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- source lookup
const SUMMARY_SQL = `
  SELECT s.uid, s.ra, s.dec, s.last_activity,
    (SELECT json_group_array(json_object('field_id', d.field_id, 'release_id', d.release_id, 'cat_id', d.cat_id))
       FROM detections d WHERE d.uid = s.uid) AS ids,
    (SELECT json_group_object(otype, n) FROM (SELECT otype, SUM(vote) AS n FROM otypes o
       WHERE o.uid = s.uid AND o.retracted_at IS NULL GROUP BY otype ORDER BY n DESC)) AS otypes,
    (SELECT COUNT(*) FROM comments m WHERE m.uid = s.uid AND m.deleted = 0) AS n_comments
  FROM sources s`;

const summarize = (r: any) => ({ ...r, ids: parse(r.ids), otypes: parse(r.otypes) });

async function summaries(db: D1Database, uids: string[]) {
  if (!uids.length) return [];
  const { results } = await db
    .prepare(`${SUMMARY_SQL} WHERE s.uid IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(uids))
    .all();
  return results.map(summarize);
}

async function cone(db: D1Database, ra: number, dec: number, radius: number) {
  const r = radius / 3600;
  const dra = r / Math.max(Math.cos((dec * Math.PI) / 180), 1e-6);
  const { results } = await db
    .prepare("SELECT uid, ra, dec FROM sources WHERE dec BETWEEN ? AND ? AND ((ra BETWEEN ? AND ?) OR (ra BETWEEN ? AND ?) OR (ra BETWEEN ? AND ?))")
    .bind(dec - r, dec + r, ra - dra, ra + dra, ra - dra + 360, ra + dra + 360, ra - dra - 360, ra + dra - 360)
    .all<any>();
  return results
    .map((s) => ({ ...s, sep_arcsec: angSepArcsec(ra, dec, s.ra, s.dec) }))
    .filter((s) => s.sep_arcsec <= radius)
    .sort((a, b) => a.sep_arcsec - b.sep_arcsec);
}

// Turn any user query into matching source uids
async function resolve(db: D1Database, q: string, radius = 1.0): Promise<{ uid: string; sep_arcsec?: number }[]> {
  q = q.trim();
  const name = q.replace(/^LAPIS[\s_-]*J/i, "LAPIS-J");
  if (/^LAPIS-J/i.test(name)) {
    const r = await db.prepare("SELECT uid FROM sources WHERE uid = ? COLLATE NOCASE").bind(name).first<any>();
    return r ? [r] : [];
  }
  const fc = /^([A-Za-z0-9+_.-]*?[A-Za-z0-9+_.]+)[\s:#/]+(\d+)$/.exec(q);
  if (fc && !parseCoords(q)) {
    const { results } = await db
      .prepare(
        "SELECT DISTINCT uid FROM detections WHERE cat_id = ?1 AND (field_id = ?2 OR release_id = ?2 OR field_id LIKE '%' || ?2 OR release_id LIKE '%' || ?2)",
      )
      .bind(parseInt(fc[2]), fc[1])
      .all<any>();
    return results;
  }
  if (/^\d+$/.test(q)) {
    const { results } = await db.prepare("SELECT DISTINCT uid FROM detections WHERE cat_id = ?").bind(parseInt(q)).all<any>();
    return results;
  }
  const xy = parseCoords(q);
  if (xy) return cone(db, xy[0], xy[1], radius);
  return [];
}

app.get("/api/resolve", async (c) => {
  const matches = await resolve(c.env.DB, c.req.query("q") ?? "", parseFloat(c.req.query("radius") ?? "1"));
  const sums = await summaries(c.env.DB, matches.map((m) => m.uid));
  const sep = Object.fromEntries(matches.map((m) => [m.uid, m.sep_arcsec]));
  return c.json(sums.map((s) => ({ ...s, sep_arcsec: sep[s.uid] })).sort((a, b) => (a.sep_arcsec ?? 0) - (b.sep_arcsec ?? 0)));
});

// List sources by object type / field / activity, or a cone (ra, dec, radius in arcsec)
app.get("/api/search", async (c) => {
  const q = c.req.query();
  const limit = Math.min(parseInt(q.limit ?? "200"), 2000);
  const offset = parseInt(q.offset ?? "0");
  if (q.ra && q.dec) {
    const hits = await cone(c.env.DB, parseFloat(q.ra), parseFloat(q.dec), parseFloat(q.radius ?? "5"));
    const sums = await summaries(c.env.DB, hits.slice(offset, offset + limit).map((h) => h.uid));
    const sep = Object.fromEntries(hits.map((h) => [h.uid, h.sep_arcsec]));
    return c.json(sums.map((s) => ({ ...s, sep_arcsec: sep[s.uid] })).sort((a, b) => a.sep_arcsec - b.sep_arcsec));
  }
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.otype) {
    where.push("s.uid IN (SELECT uid FROM otypes WHERE otype = ? AND retracted_at IS NULL GROUP BY uid HAVING SUM(vote) > 0)");
    args.push(q.otype);
  }
  if (q.field) {
    where.push("s.uid IN (SELECT uid FROM detections WHERE field_id = ?)");
    args.push(q.field);
  }
  if (q.discussed) where.push("s.uid IN (SELECT uid FROM comments WHERE deleted = 0)");
  if (q.annotated) where.push("s.last_activity IS NOT NULL");
  const sql = `${SUMMARY_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY s.last_activity IS NULL, s.last_activity DESC, s.uid LIMIT ? OFFSET ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...args, limit, offset).all();
  return c.json(results.map(summarize));
});

app.get("/api/sources/:uid", async (c) => {
  const uid = c.req.param("uid");
  const db = c.env.DB;
  const src = await db.prepare("SELECT * FROM sources WHERE uid = ?").bind(uid).first();
  if (!src) return c.json({ error: "Source not found" }, 404);
  const [dets, ots, coms, seds] = await db.batch([
    db.prepare(`SELECT d.*, r.version, r.filters, r.apertures, r.default_aperture, r.ingested_at,
                       f.label AS field_label, f.map_url, f.map_meta
                FROM detections d JOIN releases r USING (release_id) JOIN fields f ON f.field_id = d.field_id
                WHERE d.uid = ? ORDER BY d.field_id, r.ingested_at DESC`).bind(uid),
    db.prepare("SELECT * FROM otypes WHERE uid = ? AND retracted_at IS NULL ORDER BY created_at").bind(uid),
    db.prepare("SELECT id, username, body, created_at, edited_at FROM comments WHERE uid = ? AND deleted = 0 ORDER BY created_at").bind(uid),
    db.prepare("SELECT id, username, kind, label, code, redshift, notes, original_name, n_points, created_at FROM seds WHERE uid = ? AND deleted = 0 ORDER BY created_at").bind(uid),
  ]);
  const detections = dets.results.map((d: any) => ({
    ...d,
    phot: parse(d.phot),
    photoz: parse(d.photoz),
    filters: parse(d.filters),
    apertures: parse(d.apertures),
    map_meta: parse(d.map_meta),
  }));
  return c.json({ ...src, detections, otypes: ots.results, comments: coms.results, seds: seds.results });
});

// Stored gzipped JSON from R2, passed through without decompressing
async function gzJson(c: any, key: string, missing: string) {
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.json({ error: missing }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "private, max-age=86400" },
    encodeBody: "manual",
  });
}

// Full catalog row (all apertures / columns) for one detection
app.get("/api/catalog/:release/:cat_id", (c) =>
  gzJson(c, `phot/${c.req.param("release")}/${parseInt(c.req.param("cat_id"))}.json.gz`, "No catalog row stored"));

// EAZY best-fit SED for one detection
app.get("/api/eazy/:release/:cat_id", (c) =>
  gzJson(c, `eazy/${c.req.param("release")}/${parseInt(c.req.param("cat_id"))}.json.gz`, "No EAZY fit stored"));

// All sources of a release in its default aperture (column-oriented), for the color-color background
app.get("/api/background/:release", (c) => gzJson(c, `bg/${c.req.param("release")}.json.gz`, "No background stored for this release"));

app.get("/api/fields", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.field_id, f.label, f.map_url, f.notes, f.created_at,
       (SELECT json_group_array(json_object('release_id', release_id, 'version', version, 'status', status,
          'n_sources', n_sources, 'n_new', n_new, 'filters', json(filters), 'ingested_at', ingested_at))
        FROM releases r WHERE r.field_id = f.field_id) AS releases
     FROM fields f ORDER BY f.field_id`,
  ).all<any>();
  return c.json(results.map((r) => ({ ...r, releases: parse(r.releases) })));
});

// ---------------------------------------------------------------- image tiles (proxied + cached in R2)
app.get("/api/tiles/:field/:layer/:z/:y/:x", async (c) => {
  const { field, layer, z, y, x } = c.req.param();
  if (![z, y, x.replace(/\.png$/, "")].every((v) => /^\d+$/.test(v))) return c.text("bad tile", 400);
  const f = await c.env.DB.prepare("SELECT map_meta, map_auth, tile_version FROM fields WHERE field_id = ?").bind(field).first<any>();
  const meta = parse(f?.map_meta);
  const lyr = meta?.layers.find((l: any) => l.name === layer);
  if (!lyr) return c.text("unknown field/layer", 404);
  const tail = `${z}/${y}/${x.replace(/\.png$/, "")}.png`;
  const key = `tiles/${field}/v${f.tile_version}/${layer}/${tail}`;
  const headers = { "Content-Type": "image/png", "Cache-Control": "private, max-age=604800" };
  const cached = await c.env.BUCKET.get(key);
  if (cached) return cached.customMetadata?.missing ? c.text("no tile", 404) : new Response(cached.body, { headers });
  // Cloudflare -> UCSC is sometimes very slow; give up fast and let the page retry
  const r = await fetch(`${meta.base}/${lyr.path}/${tail}`, {
    headers: { Authorization: "Basic " + btoa(f.map_auth || c.env.MAP_AUTH) },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r) return c.text("upstream timeout", 504);
  if (r.status === 404) {
    c.executionCtx.waitUntil(c.env.BUCKET.put(key, "", { customMetadata: { missing: "1" } }));
    return c.text("no tile", 404);
  }
  if (!r.ok) return c.text(`upstream ${r.status}`, 502);
  const buf = await r.arrayBuffer();
  c.executionCtx.waitUntil(c.env.BUCKET.put(key, buf));
  return new Response(buf, { headers });
});

// ---------------------------------------------------------------- annotations
const touch = (db: D1Database, uid: string) => db.prepare("UPDATE sources SET last_activity = ? WHERE uid = ?").bind(now(), uid);

async function requireSource(c: Ctx) {
  return c.env.DB.prepare("SELECT uid FROM sources WHERE uid = ?").bind(c.req.param("uid")).first<any>();
}

app.post("/api/sources/:uid/comments", async (c) => {
  if (!(await requireSource(c))) return c.json({ error: "Source not found" }, 404);
  const { body } = await c.req.json();
  if (!body?.trim()) return c.json({ error: "Empty comment" }, 400);
  const uid = c.req.param("uid");
  const [ins] = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO comments (uid, username, body, created_at) VALUES (?, ?, ?, ?) RETURNING id").bind(uid, c.get("user"), body, now()),
    touch(c.env.DB, uid),
  ]);
  return c.json(ins.results[0]);
});

app.patch("/api/comments/:id", async (c) => {
  const { body } = await c.req.json();
  const r = await c.env.DB.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ? AND username = ? AND deleted = 0")
    .bind(body, now(), c.req.param("id"), c.get("user"))
    .run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "Not your comment" }, 403);
});

app.delete("/api/comments/:id", async (c) => {
  const r = await c.env.DB.prepare("UPDATE comments SET deleted = 1 WHERE id = ? AND username = ?").bind(c.req.param("id"), c.get("user")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "Not your comment" }, 403);
});

app.get("/api/otypes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT v.otype, v.description, (SELECT COUNT(*) FROM (SELECT uid FROM otypes o WHERE o.otype = v.otype AND o.retracted_at IS NULL
       GROUP BY uid HAVING SUM(vote) > 0)) AS n_sources
     FROM otype_vocab v ORDER BY v.otype`,
  ).all();
  return c.json(results);
});

app.post("/api/otypes", async (c) => {
  const { otype, description } = await c.req.json();
  if (!otype?.trim()) return c.json({ error: "Empty object type" }, 400);
  await c.env.DB.prepare("INSERT OR IGNORE INTO otype_vocab (otype, description, created_by) VALUES (?, ?, ?)")
    .bind(otype.trim(), description ?? null, c.get("user"))
    .run();
  return c.json({ ok: true });
});

// Set this user's vote on an object type for a source: 1 (up), -1 (down) or 0 (clear)
const voteStatements = (db: D1Database, uid: string, user: string, otype: string, vote: number, note: string | null) => [
  db.prepare("INSERT OR IGNORE INTO otype_vocab (otype, created_by) VALUES (?, ?)").bind(otype, user),
  db.prepare("UPDATE otypes SET retracted_at = ? WHERE uid = ? AND otype = ? AND username = ? AND retracted_at IS NULL").bind(now(), uid, otype, user),
  ...(vote
    ? [db.prepare("INSERT INTO otypes (uid, otype, username, vote, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(uid, otype, user, vote, note, now())]
    : []),
  touch(db, uid),
];

app.post("/api/sources/:uid/otypes", async (c) => {
  if (!(await requireSource(c))) return c.json({ error: "Source not found" }, 404);
  const { otype, vote = 1, note } = await c.req.json();
  if (!otype?.trim()) return c.json({ error: "Empty object type" }, 400);
  if (![1, -1, 0].includes(vote)) return c.json({ error: "vote must be 1, -1 or 0" }, 400);
  await c.env.DB.batch(voteStatements(c.env.DB, c.req.param("uid"), c.get("user"), otype.trim(), vote, note ?? null));
  return c.json({ ok: true });
});

// Bulk annotation (max 100 per request):
// {ops: [{source, add_otype? (upvote), downvote_otype?, remove_otype? (clear your vote), note?, comment?}, ...]}
app.post("/api/bulk", async (c) => {
  const { ops } = await c.req.json();
  if (!Array.isArray(ops) || ops.length > 100) return c.json({ error: "Send 1-100 ops per request" }, 400);
  const db = c.env.DB;
  const user = c.get("user");
  const results: any[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const op of ops) {
    const hits = await resolve(db, String(op.source ?? ""), 0.3);
    if (hits.length !== 1) {
      results.push({ source: op.source, ok: false, error: hits.length ? `ambiguous (${hits.length} matches)` : "not found" });
      continue;
    }
    const uid = hits[0].uid;
    if (op.add_otype) stmts.push(...voteStatements(db, uid, user, String(op.add_otype).trim(), 1, op.note ?? null));
    if (op.downvote_otype) stmts.push(...voteStatements(db, uid, user, String(op.downvote_otype).trim(), -1, op.note ?? null));
    if (op.remove_otype) stmts.push(...voteStatements(db, uid, user, String(op.remove_otype).trim(), 0, null));
    if (op.comment) stmts.push(db.prepare("INSERT INTO comments (uid, username, body, created_at) VALUES (?, ?, ?, ?)").bind(uid, user, String(op.comment), now()), touch(db, uid));
    results.push({ source: op.source, uid, ok: true });
  }
  if (stmts.length) await db.batch(stmts);
  return c.json(results);
});

// ---------------------------------------------------------------- SED fits
app.post("/api/sources/:uid/seds", async (c) => {
  if (!(await requireSource(c))) return c.json({ error: "Source not found" }, 404);
  const { label, code, redshift, notes, original_name, data, kind = "sed" } = await c.req.json();
  if (!label?.trim()) return c.json({ error: "A label is required" }, 400);
  if (kind !== "sed" && kind !== "pz") return c.json({ error: "kind must be 'sed' or 'pz'" }, 400);
  // SED fit: {wave_um, fnu_njy[, fnu_err]}; P(z): {z, pz}
  const [xk, yk] = kind === "pz" ? ["z", "pz"] : ["wave_um", "fnu_njy"];
  const w = data?.[xk], f = data?.[yk];
  if (!Array.isArray(w) || !Array.isArray(f) || w.length !== f.length || w.length < 2 || w.length > 200000)
    return c.json({ error: `data.${xk} and data.${yk} must be equal-length arrays (2-200000 points)` }, 400);
  if (data.fnu_err && data.fnu_err.length !== w.length) return c.json({ error: "data.fnu_err length mismatch" }, 400);
  const uid = c.req.param("uid");
  const key = `seds/${uid}/${randomToken(8)}.json`;
  await c.env.BUCKET.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
  const [ins] = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO seds (uid, username, kind, label, code, redshift, notes, original_name, n_points, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    ).bind(uid, c.get("user"), kind, label.trim(), code ?? null, redshift ?? null, notes ?? null, original_name ?? null, w.length, key, now()),
    touch(c.env.DB, uid),
  ]);
  return c.json(ins.results[0]);
});

app.get("/api/seds/:id", async (c) => {
  const s = await c.env.DB.prepare("SELECT r2_key FROM seds WHERE id = ? AND deleted = 0").bind(c.req.param("id")).first<any>();
  const obj = s && (await c.env.BUCKET.get(s.r2_key));
  if (!obj) return c.json({ error: "Upload not found" }, 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=86400" } });
});

app.delete("/api/seds/:id", async (c) => {
  const r = await c.env.DB.prepare("UPDATE seds SET deleted = 1 WHERE id = ? AND username = ?").bind(c.req.param("id"), c.get("user")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "Not your SED" }, 403);
});

// Inbox: activity by others on sources this user has commented on, voted on, or uploaded a fit to
// (only after the user's first contribution to that source)
const INBOX_SQL = `
  WITH mine AS (
    SELECT uid, MIN(t) AS since FROM (
      SELECT uid, created_at AS t FROM comments WHERE username = ?1 AND deleted = 0
      UNION ALL SELECT uid, created_at FROM otypes WHERE username = ?1
      UNION ALL SELECT uid, created_at FROM seds WHERE username = ?1 AND deleted = 0)
    GROUP BY uid),
  ev AS (
    SELECT 'comment' AS kind, uid, username, substr(body, 1, 160) AS text, created_at FROM comments WHERE deleted = 0
    UNION ALL SELECT CASE WHEN vote > 0 THEN 'upvote' ELSE 'downvote' END, uid, username, otype, created_at FROM otypes
    UNION ALL SELECT kind, uid, username, label, created_at FROM seds WHERE deleted = 0)
  SELECT ev.* FROM ev JOIN mine USING (uid) WHERE ev.username != ?1 AND ev.created_at > mine.since`;

app.get("/api/inbox", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const seen = (await db.prepare("SELECT inbox_seen_at FROM users WHERE username = ?").bind(user).first<any>())?.inbox_seen_at ?? "";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const [items, unread] = await db.batch([
    db.prepare(`${INBOX_SQL} ORDER BY ev.created_at DESC LIMIT ?2`).bind(user, limit),
    db.prepare(`SELECT COUNT(*) AS n FROM (${INBOX_SQL} AND ev.created_at > ?2)`).bind(user, seen),
  ]);
  return c.json({ seen_at: seen || null, unread: (unread.results[0] as any).n, items: items.results });
});

app.post("/api/inbox/seen", async (c) => {
  await c.env.DB.prepare("UPDATE users SET inbox_seen_at = ? WHERE username = ?").bind(now(), c.get("user")).run();
  return c.json({ ok: true });
});

app.get("/api/recent", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT 'comment' AS kind, uid, username, substr(body, 1, 200) AS text, created_at FROM comments WHERE deleted = 0
       UNION ALL SELECT CASE WHEN vote > 0 THEN 'upvote' ELSE 'downvote' END, uid, username, otype, created_at FROM otypes WHERE retracted_at IS NULL
       UNION ALL SELECT kind, uid, username, label, created_at FROM seds WHERE deleted = 0)
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(Math.min(parseInt(c.req.query("limit") ?? "40"), 200))
    .all();
  return c.json(results);
});

// ---------------------------------------------------------------- admin: additive data ingestion
app.post("/api/admin/fields", async (c) => {
  const { field_id, label, map_url, map_auth, notes } = await c.req.json();
  if (!/^[A-Za-z0-9+_.-]+$/.test(field_id ?? "")) return c.json({ error: "Bad field_id" }, 400);
  if (await c.env.DB.prepare("SELECT 1 FROM fields WHERE field_id = ?").bind(field_id).first())
    return c.json({ error: `Field ${field_id} already exists (use PATCH to update its map)` }, 409);
  const meta = map_url ? await readFitsMap(map_url, map_auth || c.env.MAP_AUTH) : null;
  await c.env.DB.prepare("INSERT INTO fields (field_id, label, map_url, map_auth, map_meta, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(field_id, label ?? field_id, map_url ?? null, map_auth ?? null, json(meta), notes ?? null, c.get("user"), now())
    .run();
  return c.json({ field_id, map_meta: meta });
});

// Point a field at a new/updated FitsMap; bumps tile_version so cached tiles are refreshed
app.patch("/api/admin/fields/:id", async (c) => {
  const f = await c.env.DB.prepare("SELECT * FROM fields WHERE field_id = ?").bind(c.req.param("id")).first<any>();
  if (!f) return c.json({ error: "No such field" }, 404);
  const body = await c.req.json();
  const map_url = body.map_url ?? f.map_url;
  const map_auth = body.map_auth ?? f.map_auth;
  const meta = map_url ? await readFitsMap(map_url, map_auth || c.env.MAP_AUTH) : null;
  await c.env.DB.prepare("UPDATE fields SET label = ?, map_url = ?, map_auth = ?, map_meta = ?, notes = ?, tile_version = tile_version + 1 WHERE field_id = ?")
    .bind(body.label ?? f.label, map_url, map_auth, json(meta), body.notes ?? f.notes, f.field_id)
    .run();
  return c.json({ field_id: f.field_id, map_meta: meta });
});

app.post("/api/admin/releases", async (c) => {
  const r = await c.req.json();
  if (!(await c.env.DB.prepare("SELECT 1 FROM fields WHERE field_id = ?").bind(r.field_id).first()))
    return c.json({ error: "Unknown field" }, 404);
  const old = await c.env.DB.prepare("SELECT status FROM releases WHERE release_id = ?").bind(r.release_id).first<any>();
  if (old?.status === "complete") return c.json({ error: `Release ${r.release_id} already ingested; use a new version label` }, 409);
  if (!old)
    await c.env.DB.prepare(
      "INSERT INTO releases (release_id, field_id, version, filters, apertures, default_aperture, source_file, notes, ingested_by, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(r.release_id, r.field_id, r.version, json(r.filters), json(r.apertures), r.default_aperture, r.source_file ?? null, r.notes ?? null, c.get("user"), now())
      .run();
  return c.json({ release_id: r.release_id, resumed: !!old });
});

async function openRelease(c: Ctx) {
  return c.env.DB.prepare("SELECT * FROM releases WHERE release_id = ? AND status = 'ingesting'").bind(c.req.param("id")).first<any>();
}

// Existing sources in a box, for client-side cross-matching before ingest
app.get("/api/admin/box", async (c) => {
  const q = c.req.query();
  const { results } = await c.env.DB.prepare("SELECT uid, ra, dec FROM sources WHERE dec BETWEEN ? AND ? AND ra BETWEEN ? AND ?")
    .bind(+q.dec_min, +q.dec_max, +q.ra_min, +q.ra_max)
    .all();
  return c.json(results);
});

app.post("/api/admin/releases/:id/detections", async (c) => {
  const rel = await openRelease(c);
  if (!rel) return c.json({ error: "Release not open for ingestion" }, 409);
  const { sources, detections } = await c.req.json();
  const db = c.env.DB;
  const t = now();
  await db.batch([
    ...sources.map((s: any) =>
      db.prepare("INSERT OR IGNORE INTO sources (uid, ra, dec, first_release, created_at) VALUES (?, ?, ?, ?, ?)").bind(s.uid, s.ra, s.dec, rel.release_id, t),
    ),
    ...detections.map((d: any) =>
      db.prepare(
        "INSERT OR IGNORE INTO detections (release_id, cat_id, uid, field_id, ra, dec, x, y, phot, photoz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(rel.release_id, d.cat_id, d.uid, rel.field_id, d.ra, d.dec, d.x ?? null, d.y ?? null, json(d.phot), json(d.photoz)),
    ),
  ]);
  return c.json({ ok: true, n: detections.length });
});

// One page of already-stored catalog-row (or ?kind=eazy fit) ids, so a resumed upload can skip them
app.get("/api/admin/releases/:id/blob-ids", async (c) => {
  const prefix = `${c.req.query("kind") === "eazy" ? "eazy" : "phot"}/${c.req.param("id")}/`;
  const page = await c.env.BUCKET.list({ prefix, cursor: c.req.query("cursor") || undefined, limit: 1000 });
  return c.json({ ids: page.objects.map((o) => parseInt(o.key.slice(prefix.length))), cursor: page.truncated ? page.cursor : null });
});

// Raw gzipped bytes in, straight to R2: no parsing, so it stays within the free-plan CPU budget
app.put("/api/admin/releases/:id/blob/:cat_id", async (c) => {
  const rel = await openRelease(c);
  if (!rel) return c.json({ error: "Release not open for ingestion" }, 409);
  await c.env.BUCKET.put(`phot/${rel.release_id}/${parseInt(c.req.param("cat_id"))}.json.gz`, await c.req.arrayBuffer());
  return c.json({ ok: true });
});

// Derived from the release's own catalog, so (re)uploading it is allowed for any existing release
app.put("/api/admin/releases/:id/background", async (c) => {
  if (!(await c.env.DB.prepare("SELECT 1 FROM releases WHERE release_id = ?").bind(c.req.param("id")).first()))
    return c.json({ error: "Unknown release" }, 404);
  await c.env.BUCKET.put(`bg/${c.req.param("id")}.json.gz`, await c.req.arrayBuffer());
  return c.json({ ok: true });
});

// EAZY fits are derived products, so like the background they can be added to any existing release
app.put("/api/admin/releases/:id/eazy/:cat_id", async (c) => {
  if (!(await c.env.DB.prepare("SELECT 1 FROM releases WHERE release_id = ?").bind(c.req.param("id")).first()))
    return c.json({ error: "Unknown release" }, 404);
  await c.env.BUCKET.put(`eazy/${c.req.param("id")}/${parseInt(c.req.param("cat_id"))}.json.gz`, await c.req.arrayBuffer());
  return c.json({ ok: true });
});

app.post("/api/admin/releases/:id/complete", async (c) => {
  const rel = await openRelease(c);
  if (!rel) return c.json({ error: "Release not open for ingestion" }, 409);
  // counted server-side so a resumed ingest still reports the right number of new sources
  await c.env.DB.prepare(
    `UPDATE releases SET status = 'complete', n_new = (SELECT COUNT(*) FROM sources WHERE first_release = ?1),
       n_sources = (SELECT COUNT(*) FROM detections WHERE release_id = ?1) WHERE release_id = ?1`,
  )
    .bind(rel.release_id)
    .run();
  return c.json({ ok: true });
});

app.all("/api/*", (c) => c.json({ error: "Unknown endpoint" }, 404));

export default app;
