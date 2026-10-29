"""Additive ingestion of a field catalog: never overwrites earlier releases.

New detections are cross-matched by position onto existing sources, so a
re-reduced catalog (or an overlapping field) attaches to the same source pages.
"""
import gzip
import json
import re
from concurrent.futures import ThreadPoolExecutor

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits

BAND_COL = re.compile(r"^(F\d{3,4}[WMN]2?)_(.+)$")
PHOTOZ_SUMMARY = ["z_spec", "z_a", "z_ml", "chi_a", "l68", "u68", "z160", "z500", "z840", "nfilt",
                  "Prob_gt_5", "Prob_gt_6", "Prob_gt_7", "Prob_gt_8", "Prob_gt_9"]


def clean(v, sig=5):
    if isinstance(v, (np.ndarray, list)):
        return [clean(x, sig) for x in v]
    if isinstance(v, (bytes, np.bytes_)):
        v = v.decode()
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (np.integer, int)):
        return int(v)
    v = float(v)
    return float(f"{v:.{sig}g}") if np.isfinite(v) else None


def read_lapis_hlsp(path):
    """Read a LAPIS HLSP photometry catalog into the generic structure used for ingestion."""
    hdul = fits.open(path)
    flag = hdul["FLAG"].data
    size = hdul["SIZE"].data
    filt = hdul["FILTERS"].data
    pivots = {n.strip(): w for n, w in zip(filt["NAME"], filt["WAVE_PIVOT"])}
    widths = {n.strip(): w for n, w in zip(filt["NAME"], filt["BANDWIDTH"])} if "BANDWIDTH" in filt.names else {}
    apertures = {}
    for hdu in hdul[1:]:
        if not any(BAND_COL.match(c) for c in hdu.columns.names):
            continue
        ext_suffix = hdu.name.split("_", 1)[1] if "_" in hdu.name else ""
        names = set(hdu.columns.names)
        for col in hdu.columns.names:
            m = BAND_COL.match(col)
            if not m or m.group(2).endswith(("_e", "_ei", "_bkg")) or f"{col}_e" not in names:
                continue
            key = m.group(2) + (f"_{ext_suffix}" if ext_suffix else "")
            apertures.setdefault(key, {})[m.group(1)] = (hdu.data[col], hdu.data[f"{col}_e"])
    bands = sorted({b for ap in apertures.values() for b in ap}, key=lambda b: pivots.get(b, 99))
    photoz = {h.name: h.data for h in hdul if h.name.startswith("PHOTOZ")}
    return dict(
        ids=np.asarray(flag["ID"]).astype(int),
        ra=np.asarray(flag["RA"], float),
        dec=np.asarray(flag["DEC"], float),
        x=np.asarray(size["X"], float),
        y=np.asarray(size["Y"], float),
        filters=[{"name": b, "wave_um": float(pivots[b]), **({"width_um": float(widths[b])} if b in widths else {})} for b in bands],
        apertures=apertures,
        photoz=photoz,
        tables=[h for h in hdul[1:] if h.name != "FILTERS"],
    )


def iau_name(ra, dec):
    """LAPIS-JHHMMSS.ss+DDMMSS.s, truncated (IAU convention)."""
    c = SkyCoord(ra * u.deg, dec * u.deg)
    h, m, s = c.ra.hms
    sign = "-" if dec < 0 else "+"
    d, dm, ds = (abs(v) for v in c.dec.dms)
    s, ds = np.floor(s * 100) / 100, np.floor(ds * 10) / 10
    return f"LAPIS-J{int(h):02d}{int(m):02d}{s:05.2f}{sign}{int(d):02d}{int(dm):02d}{ds:04.1f}"


def crossmatch(cat, existing, radius_arcsec):
    """uid for every catalog row: an existing source within radius (closest wins) or a new name."""
    uids = np.array([None] * len(cat["ids"]), dtype=object)
    taken = {s["uid"] for s in existing}
    if existing:
        new_c = SkyCoord(cat["ra"] * u.deg, cat["dec"] * u.deg)
        old_c = SkyCoord([s["ra"] for s in existing] * u.deg, [s["dec"] for s in existing] * u.deg)
        idx, sep, _ = new_c.match_to_catalog_sky(old_c)
        used = set()
        for i in np.argsort(sep.arcsec):
            if sep.arcsec[i] <= radius_arcsec and existing[idx[i]]["uid"] not in used:
                uids[i] = existing[idx[i]]["uid"]
                used.add(uids[i])
    new = []
    for i in np.where(uids == None)[0]:  # noqa: E711
        name, k = iau_name(cat["ra"][i], cat["dec"][i]), 0
        while (name if k == 0 else f"{name}{chr(97 + k)}") in taken:
            k += 1
        uids[i] = name if k == 0 else f"{name}{chr(97 + k)}"
        taken.add(uids[i])
        new.append(i)
    return uids, new


def detection_row(cat, i, uid, default_aperture):
    phot = {b: [clean(f[i]), clean(e[i])] for b, (f, e) in cat["apertures"][default_aperture].items()}
    photoz = {ext: {c: clean(t[c][i]) for c in PHOTOZ_SUMMARY if c in t.columns.names} for ext, t in cat["photoz"].items()}
    return dict(cat_id=int(cat["ids"][i]), uid=uid, ra=round(float(cat["ra"][i]), 8), dec=round(float(cat["dec"][i]), 8),
                x=clean(cat["x"][i], 8), y=clean(cat["y"][i], 8), phot=phot, photoz=photoz)


def full_blob(cat, i):
    """Every aperture and every catalog column for one source, gzipped."""
    blob = {
        "phot": {ap: {b: [clean(f[i]), clean(e[i])] for b, (f, e) in bands.items()} for ap, bands in cat["apertures"].items()},
        "columns": {h.name: {c: clean(h.data[c][i]) for c in h.columns.names} for h in cat["tables"]},
    }
    return gzip.compress(json.dumps(blob, separators=(",", ":")).encode())


def background_blob(cat, aperture):
    """All sources in one aperture, column-oriented, for the color-color background."""
    bands = cat["apertures"][aperture]
    blob = {"aperture": aperture, "ids": [int(i) for i in cat["ids"]],
            "flux": {b: [clean(v, 4) for v in f] for b, (f, e) in bands.items()},
            "err": {b: [clean(v, 4) for v in e] for b, (f, e) in bands.items()}}
    return gzip.compress(json.dumps(blob, separators=(",", ":")).encode())


def upload_background(client, catalog, release_id, aperture="CIRC1"):
    client.put_bytes(f"/api/admin/releases/{release_id}/background", background_blob(read_lapis_hlsp(catalog), aperture))


def ingest(client, catalog, field_id, version, map_url=None, label=None, default_aperture="CIRC1",
           match_radius=0.15, notes=None, workers=8, log=print):
    cat = read_lapis_hlsp(catalog)
    if default_aperture not in cat["apertures"]:
        raise SystemExit(f"Aperture {default_aperture} not in catalog; options: {sorted(cat['apertures'])}")
    if field_id not in {f["field_id"] for f in client.fields()}:
        log(f"Creating field {field_id}")
        client.post("/api/admin/fields", dict(field_id=field_id, label=label or field_id, map_url=map_url))
    release_id = f"{field_id}_{version}"
    rel = client.post("/api/admin/releases", dict(
        release_id=release_id, field_id=field_id, version=version, filters=cat["filters"],
        apertures=sorted(cat["apertures"]), default_aperture=default_aperture,
        source_file=str(catalog).rsplit("/", 1)[-1], notes=notes))
    log(f"Release {release_id} ({'resuming' if rel['resumed'] else 'new'}): {len(cat['ids'])} catalog rows, "
        f"bands {[f['name'] for f in cat['filters']]}, {len(cat['apertures'])} apertures")

    pad = 2 * match_radius / 3600
    existing = client.get("/api/admin/box", ra_min=cat["ra"].min() - pad, ra_max=cat["ra"].max() + pad,
                          dec_min=cat["dec"].min() - pad, dec_max=cat["dec"].max() + pad)
    uids, new = crossmatch(cat, existing, match_radius)
    log(f"Cross-match within {match_radius}\": {len(cat['ids']) - len(new)} matched existing sources, {len(new)} new")

    new_set = set(new)
    order = np.arange(len(cat["ids"]))
    for k in range(0, len(order), 250):
        chunk = order[k : k + 250]
        client.post(f"/api/admin/releases/{release_id}/detections", dict(
            sources=[dict(uid=uids[i], ra=round(float(cat["ra"][i]), 8), dec=round(float(cat["dec"][i]), 8)) for i in chunk if i in new_set],
            detections=[detection_row(cat, i, uids[i], default_aperture) for i in chunk]))
        log(f"  detections {min(k + 250, len(order))}/{len(order)}", end="\r")
    log("")

    stored = stored_ids(client, release_id, "phot")
    todo = [i for i in order if int(cat["ids"][i]) not in stored]
    log(f"Full catalog rows: {len(stored)} already stored, {len(todo)} to upload")
    put_all(client, [(f"/api/admin/releases/{release_id}/blob/{int(cat['ids'][i])}", lambda i=i: full_blob(cat, i)) for i in todo],
            "full catalog rows", workers, log)
    client.put_bytes(f"/api/admin/releases/{release_id}/background", background_blob(cat, default_aperture))
    client.post(f"/api/admin/releases/{release_id}/complete", {})
    log(f"Done: {release_id}")
    return release_id


def stored_ids(client, release_id, kind):
    stored, cursor = set(), ""
    while cursor is not None:
        page = client.get(f"/api/admin/releases/{release_id}/blob-ids", cursor=cursor, kind=kind)
        stored.update(page["ids"])
        cursor = page["cursor"]
    return stored


def put_all(client, jobs, what, workers=8, log=print):
    """PUT (path, make_bytes) jobs in parallel, reporting progress."""
    with ThreadPoolExecutor(workers) as pool:
        for done, _ in enumerate(pool.map(lambda j: client.put_bytes(j[0], j[1]()), jobs), 1):
            if done % 500 == 0 or done == len(jobs):
                log(f"  {what} {done}/{len(jobs)}")


def read_eazy(path):
    """Open an EAZY lazy-results file: per-source SUMMARY (z_best, coeffs, ...) and the TEMPL grid over redshift."""
    h = fits.open(path, memmap=True)
    templ = h["TEMPL"].data
    names = [n for n in templ.columns.names if n != "z"]
    return h["SUMMARY"].data, names, [templ[n] for n in names], np.asarray(templ["z"])


def eazy_blob(eazy, i, aperture, wave_range=(0.2, 6.0)):
    """Best-fit SED of SUMMARY row i, rebuilt as coeffs . templates(nearest z to z_best), gzipped."""
    summ, names, cols, zgrid = eazy
    z = float(summ["z_best"][i])
    wave = np.asarray(cols[0][0], float) / 1e4 * (1 + z)  # template row 0 holds the rest wavelengths in Angstrom
    keep = (wave >= wave_range[0]) & (wave <= wave_range[1])
    iz = int(np.abs(zgrid - z).argmin())
    fnu = np.stack([c[iz] for c in cols]).T[keep] @ np.asarray(summ["coeffs"][i], float)
    blob = {"z": clean(z, 4), "z_l68": clean(summ["z_l68"][i], 4), "z_u68": clean(summ["z_u68"][i], 4),
            "chi2": clean(summ["chi2"][i], 4), "aperture": aperture, "templates": names,
            "wave_um": [clean(w, 5) for w in wave[keep]], "fnu_njy": [clean(f, 4) for f in fnu]}
    return gzip.compress(json.dumps(blob, separators=(",", ":")).encode())


def upload_eazy(client, path, release_id, aperture="CIRC1", workers=8, log=print):
    eazy = read_eazy(path)
    summ = eazy[0]
    stored = stored_ids(client, release_id, "eazy")
    todo = [i for i in range(len(summ)) if int(summ["ID"][i]) not in stored
            and np.isfinite(summ["z_best"][i]) and np.any(summ["coeffs"][i])]
    log(f"EAZY fits: {len(stored)} already stored, {len(todo)} to upload")
    put_all(client, [(f"/api/admin/releases/{release_id}/eazy/{int(summ['ID'][i])}", lambda i=i: eazy_blob(eazy, i, aperture)) for i in todo],
            "EAZY fits", workers, log)
    log(f"Done: EAZY fits for {release_id}")
