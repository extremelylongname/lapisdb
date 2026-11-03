"""Mirror the site's annotations into a local folder, rsync-style: only changed files are rewritten
and uploaded SED/P(z) files are downloaded once."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

EXPORTS = ["comments.csv", "votes.csv", "otypes.csv", "uploads.csv", "lapisdb.json"]


def write_if_changed(path, data):
    if path.exists() and path.read_bytes() == data:
        return False
    path.write_bytes(data)
    return True


def sync(client, dest, uploads=True, delete=False, workers=8, log=print):
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    blobs = {f: client.download(f"/api/export/{f}") for f in EXPORTS}
    changed = [f for f, b in blobs.items() if write_if_changed(dest / f, b)]
    log(f"Annotations: {', '.join(changed) if changed else 'no changes'}")
    if not uploads:
        return
    updir = dest / "uploads"
    updir.mkdir(exist_ok=True)
    # one file per uploaded SED fit / P(z), named {uid}_{kind}_{id}.json; uploads.csv has the labels
    want = {f"{u['uid']}_{u['kind']}_{u['id']}.json": u["id"] for u in json.loads(blobs["lapisdb.json"])["uploads"]}
    have = {p.name for p in updir.glob("*.json")}
    new = sorted(set(want) - have)
    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(lambda n: (updir / n).write_bytes(client.download(f"/api/seds/{want[n]}")), new))
    gone = sorted(have - set(want))
    if delete:
        for n in gone:
            (updir / n).unlink()
    log(f"Uploads: {len(new)} new, {len(want) - len(new)} already present"
        + (f", {len(gone)} {'deleted' if delete else 'no longer on the site (kept; use --delete to remove)'}" if gone else ""))
