const enc = new TextEncoder();

export const now = () => new Date().toISOString();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const randomToken = (nbytes = 32) => hex(crypto.getRandomValues(new Uint8Array(nbytes)).buffer);

export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

// PBKDF2 kept modest so sign-in fits in the free-plan CPU budget
export async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 30000 },
    key,
    256,
  );
  return hex(bits);
}

export function angSepArcsec(ra1: number, dec1: number, ra2: number, dec2: number) {
  const r = Math.PI / 180;
  const s =
    Math.sin(((dec2 - dec1) * r) / 2) ** 2 +
    Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.sqrt(s)) * 180 * 3600) / Math.PI;
}

// "03:14:03.4 -18:03:10.9", "03 14 03.4 -18 03 10.9", "48.51 -18.05" -> [ra, dec] in degrees
export function parseCoords(q: string): [number, number] | null {
  const parts = q.replace(/,/g, " ").trim().split(/\s+/);
  const num = (s: string) => (/^[+-]?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN);
  if (parts.length === 2 && parts.every((p) => !p.includes(":"))) {
    const [ra, dec] = parts.map(num);
    return isNaN(ra) || isNaN(dec) || dec < -90 || dec > 90 ? null : [ra, dec];
  }
  const tokens = parts.length === 2 ? parts.flatMap((p) => p.split(":")) : parts;
  if (tokens.length !== 6) return null;
  const v = tokens.map((t) => num(t.replace(/^\+/, "")));
  if (v.some(isNaN)) return null;
  const sign = tokens[3].startsWith("-") ? -1 : 1;
  const ra = 15 * (v[0] + v[1] / 60 + v[2] / 3600);
  const dec = sign * (Math.abs(v[3]) + v[4] / 60 + v[5] / 3600);
  return [ra, dec];
}

// Parse what we need from a FitsMap site: image layers, tile transformation and WCS
export async function readFitsMap(mapUrl: string, auth: string) {
  const base = mapUrl.replace(/\/(index\.html)?(\?.*)?$/, "");
  const get = async (path: string) => {
    const r = await fetch(`${base}/${path}`, { headers: { Authorization: "Basic " + btoa(auth) } });
    if (!r.ok) throw new Error(`FitsMap ${path}: HTTP ${r.status}`);
    return r.text();
  };
  const [index, coords] = await Promise.all([get("js/index.js"), get("js/urlCoords.js")]);
  const layers = [...index.matchAll(/const\s+(\w+)\s*=\s*L\.tileLayer\("([^"]+)\/\{z\}\/\{y\}\/\{x\}\.png",\s*\{([^}]*)\}/g)].map(
    (m) => ({
      name: m[1],
      path: m[2],
      maxNativeZoom: parseInt(/maxNativeZoom:\s*(\d+)/.exec(m[3])?.[1] ?? "6"),
    }),
  );
  const tm = /L\.Transformation\(([^)]+)\)/.exec(index);
  const transformation = tm
    ? tm[1].split(",").map((s) => s.trim().split("/").map(Number).reduce((a, b) => a / b))
    : [1 / 64, 0, -1 / 64, 256];
  const arr = (name: string) => JSON.parse(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(coords)![1]);
  return {
    base,
    layers,
    transformation,
    wcs: { crpix: arr("crpix"), crval: arr("crval"), cd: arr("cdmatrix"), is_ra_dec: arr("is_ra_dec") },
  };
}
