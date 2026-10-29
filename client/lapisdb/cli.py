import argparse
import csv
import json
import sys
from pathlib import Path

from .client import Client, save_config
from .ingest import ingest, upload_background, upload_eazy
from .sed import read_pz, read_sed


def show_source(s):
    otypes = {}
    for o in s["otypes"]:
        otypes[o["otype"]] = otypes.get(o["otype"], 0) + o["vote"]
    print(s["uid"])
    print("  -- " + (", ".join(f"{t} ({n:+d})" for t, n in sorted(otypes.items(), key=lambda x: -x[1])) or "no object type yet"))
    print(f"  RA, Dec: {s['ra']:.7f} {s['dec']:.7f}")
    print("  IDs: " + ", ".join(f"{d['field_id']}:{d['cat_id']} ({d['version']})" for d in s["detections"]))
    for d in s["detections"]:
        for ext, p in (d["photoz"] or {}).items():
            print(f"  {ext} ({d['version']}): z_a={p.get('z_a')} [68%: {p.get('l68')}-{p.get('u68')}]")
    for c in s["comments"]:
        print(f"  [{c['created_at'][:16]}] {c['username']}: {c['body']}")
    for m in s["seds"]:
        print(f"  {'P(z)' if m.get('kind') == 'pz' else 'SED fit'} #{m['id']}: {m['label']} by {m['username']}")


def show_list(rows):
    for r in rows:
        ids = ", ".join(sorted({f"{d['field_id']}:{d['cat_id']}" for d in r["ids"] or []}))
        types = ", ".join(f"{t} ({n:+d})" for t, n in (r["otypes"] or {}).items())
        sep = f"  sep={r['sep_arcsec']:.2f}\"" if r.get("sep_arcsec") is not None else ""
        print(f"{r['uid']}  {r['ra']:.6f} {r['dec']:.6f}  [{ids}]  {types}{sep}")
    print(f"({len(rows)} sources)", file=sys.stderr)


def report(results):
    bad = [r for r in results if not r["ok"]]
    print(f"{len(results) - len(bad)} ok, {len(bad)} failed")
    for r in bad:
        print(f"  {r['source']}: {r['error']}")


def main():
    p = argparse.ArgumentParser(prog="lapisdb", description="LAPIS source annotation database client")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("login", help="save site URL and API token")
    a.add_argument("--url", required=True)
    a.add_argument("--token", required=True)
    a = sub.add_parser("get", help="show one source (name, field:id, or 'ra dec')")
    a.add_argument("query")
    a.add_argument("--json", action="store_true")
    a = sub.add_parser("search", help="list sources by cone, object type, field, or activity")
    a.add_argument("--ra", type=float)
    a.add_argument("--dec", type=float)
    a.add_argument("--radius", type=float, default=5.0, help="arcsec")
    a.add_argument("--otype")
    a.add_argument("--field")
    a.add_argument("--discussed", action="store_true")
    a.add_argument("--limit", type=int, default=200)
    a.add_argument("--json", action="store_true")
    a = sub.add_parser("classify", help="upvote an object type for one or more sources")
    a.add_argument("otype")
    a.add_argument("sources", nargs="+")
    a.add_argument("--note")
    a = sub.add_parser("downvote", help="downvote an object type for one or more sources")
    a.add_argument("otype")
    a.add_argument("sources", nargs="+")
    a.add_argument("--note")
    a = sub.add_parser("unclassify", help="clear your up/down vote on an object type")
    a.add_argument("otype")
    a.add_argument("sources", nargs="+")
    a = sub.add_parser("comment", help="post a comment")
    a.add_argument("source")
    a.add_argument("text")
    a = sub.add_parser("annotate", help="bulk update from CSV (columns: source, add_otype, downvote_otype, remove_otype, note, comment)")
    a.add_argument("csv")
    a = sub.add_parser("upload-sed", help="upload an SED fit (any astropy-readable table)")
    a.add_argument("source")
    a.add_argument("file")
    a.add_argument("--label", required=True)
    a.add_argument("--code")
    a.add_argument("--redshift", type=float)
    a.add_argument("--notes")
    a.add_argument("--wave-col")
    a.add_argument("--flux-col")
    a.add_argument("--err-col")
    a.add_argument("--wave-unit", help="um (default if no unit in file), AA, nm, or any astropy unit")
    a.add_argument("--flux-unit", help="nJy (default if no unit in file), uJy, mJy, Jy, erg/s/cm2/AA, ABmag")
    a = sub.add_parser("upload-pz", help="upload a P(z) (any astropy-readable table with z and P columns)")
    a.add_argument("source")
    a.add_argument("file")
    a.add_argument("--label", required=True)
    a.add_argument("--code")
    a.add_argument("--notes")
    a.add_argument("--z-col")
    a.add_argument("--p-col")
    a = sub.add_parser("admin-ingest", help="[admin] add a catalog release for a field (never overwrites)")
    a.add_argument("catalog")
    a.add_argument("--field-id", required=True, help="e.g. jw10790-09947")
    a.add_argument("--version", required=True, help="catalog version label, e.g. v100")
    a.add_argument("--map-url", help="FitsMap URL (needed only the first time a field is added)")
    a.add_argument("--label")
    a.add_argument("--aperture", default="CIRC1", help="default aperture shown on pages")
    a.add_argument("--match-radius", type=float, default=0.15, help="arcsec, cross-match to existing sources")
    a.add_argument("--notes")
    a = sub.add_parser("admin-upload-background", help="[admin] (re)build the color-color background for an ingested release")
    a.add_argument("catalog")
    a.add_argument("--release-id", required=True, help="e.g. jw10790-09947_v100")
    a.add_argument("--aperture", default="CIRC1")
    a = sub.add_parser("admin-upload-eazy", help="[admin] add EAZY best-fit SEDs (lazy-results FITS) to an ingested release")
    a.add_argument("file")
    a.add_argument("--release-id", required=True, help="e.g. jw10790-09947_v100")
    a.add_argument("--aperture", default="CIRC1", help="aperture the photometry was fit in (shown on the plot)")
    a = sub.add_parser("admin-update-field", help="[admin] point a field at a new FitsMap URL")
    a.add_argument("field_id")
    a.add_argument("--map-url")
    a.add_argument("--label")
    args = p.parse_args()

    if args.cmd == "login":
        c = Client(args.url, args.token)
        me = c.me()
        save_config(args.url, args.token)
        print(f"Logged in as {me['username']}{' (admin)' if me['admin'] else ''}")
        return
    c = Client()
    if args.cmd == "get":
        hits = c.resolve(args.query)
        if len(hits) != 1:
            return show_list(hits)
        s = c.source(hits[0]["uid"])
        print(json.dumps(s, indent=1)) if args.json else show_source(s)
    elif args.cmd == "search":
        rows = c.search(ra=args.ra, dec=args.dec, radius=args.radius if args.ra is not None else None, otype=args.otype,
                        field=args.field, discussed=1 if args.discussed else None, limit=args.limit)
        print(json.dumps(rows, indent=1)) if args.json else show_list(rows)
    elif args.cmd == "classify":
        report(c.bulk([{"source": s, "add_otype": args.otype, "note": args.note} for s in args.sources]))
    elif args.cmd == "downvote":
        report(c.bulk([{"source": s, "downvote_otype": args.otype, "note": args.note} for s in args.sources]))
    elif args.cmd == "unclassify":
        report(c.bulk([{"source": s, "remove_otype": args.otype} for s in args.sources]))
    elif args.cmd == "comment":
        report(c.bulk([{"source": args.source, "comment": args.text}]))
    elif args.cmd == "annotate":
        with open(args.csv, newline="") as f:
            ops = [{k: v for k, v in row.items() if v} for row in csv.DictReader(f)]
        report(c.bulk(ops))
    elif args.cmd == "upload-sed":
        uid = c.resolve_one(args.source)
        data = read_sed(args.file, args.wave_col, args.flux_col, args.err_col, args.wave_unit, args.flux_unit)
        r = c.upload_sed(uid, data, args.label, args.code, args.redshift, args.notes, Path(args.file).name)
        print(f"Uploaded SED fit #{r['id']} ({len(data['wave_um'])} points) to {uid}")
    elif args.cmd == "upload-pz":
        uid = c.resolve_one(args.source)
        data = read_pz(args.file, args.z_col, args.p_col)
        r = c.upload_sed(uid, data, args.label, args.code, None, args.notes, Path(args.file).name, kind="pz")
        print(f"Uploaded P(z) #{r['id']} ({len(data['z'])} points) to {uid}")
    elif args.cmd == "admin-ingest":
        ingest(c, args.catalog, args.field_id, args.version, map_url=args.map_url, label=args.label,
               default_aperture=args.aperture, match_radius=args.match_radius, notes=args.notes)
    elif args.cmd == "admin-upload-background":
        upload_background(c, args.catalog, args.release_id, args.aperture)
        print(f"Uploaded background for {args.release_id}")
    elif args.cmd == "admin-upload-eazy":
        upload_eazy(c, args.file, args.release_id, args.aperture)
    elif args.cmd == "admin-update-field":
        body = {k: v for k, v in dict(map_url=args.map_url, label=args.label).items() if v}
        r = c.request("PATCH", f"/api/admin/fields/{args.field_id}", json=body)
        print(f"Updated {args.field_id}: layers {[l['name'] for l in (r['map_meta'] or {}).get('layers', [])]}")


if __name__ == "__main__":
    main()
