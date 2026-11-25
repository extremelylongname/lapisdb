"""Upload a folder of SED fits (or P(z)s) in parallel, one file per source. Files you already uploaded
(same source, label and file name) are skipped, so an interrupted run can simply be re-run."""
import csv
import io
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .sed import read_pz, read_sed


def source_from_name(path):
    """'09947_2497.csv' -> '09947:2497'; any other file name (e.g. 'LAPIS-J031402.08-180328.5.csv') is used as-is."""
    m = re.fullmatch(r"(\d+)_(\d+)", path.stem)
    return f"{m[1]}:{m[2]}" if m else path.stem


def plan(folder, manifest):
    """[(path, source, per-file overrides)] from a manifest CSV (columns: file, source[, label, code, redshift, notes]) or the file names."""
    folder = Path(folder)
    if manifest:
        with open(manifest, newline="") as f:
            return [(folder / r.pop("file"), r.pop("source"), {k: v for k, v in r.items() if v}) for r in csv.DictReader(f)]
    return [(p, source_from_name(p), {}) for p in sorted(folder.iterdir()) if p.is_file() and not p.name.startswith(".")]


def upload_folder(client, folder, label, kind="sed", manifest=None, code=None, redshift=None, notes=None,
                  read_opts=None, workers=8, log=print):
    jobs = plan(folder, manifest)
    me = client.me()["username"]
    done = {(r["uid"], r["label"], r["original_name"]) for r in csv.DictReader(io.StringIO(client.download("/api/export/uploads.csv").decode()))
            if r["username"] == me and r["kind"] == kind}
    reader = read_pz if kind == "pz" else read_sed

    def one(path, source, over):
        uid = client.resolve_one(source)
        lab = over.get("label", label)
        if (uid, lab, path.name) in done:
            return "skipped"
        z = over.get("redshift", redshift)
        client.upload_sed(uid, reader(path, **(read_opts or {})), lab, over.get("code", code),
                          None if kind == "pz" or z is None else float(z), over.get("notes", notes), path.name, kind=kind)
        return "uploaded"

    counts, failed = {"uploaded": 0, "skipped": 0}, []
    log(f"{len(jobs)} files, {workers} at a time")
    with ThreadPoolExecutor(workers) as pool:
        futures = {pool.submit(one, *j): j for j in jobs}
        for n, fut in enumerate(as_completed(futures), 1):
            try:
                counts[fut.result()] += 1
            except (Exception, SystemExit) as e:
                failed.append((futures[fut][0].name, str(e)))
            if n % 500 == 0:
                log(f"  {n}/{len(jobs)}")
    log(f"Uploaded {counts['uploaded']}, skipped {counts['skipped']} already uploaded, failed {len(failed)}")
    for name, err in failed:
        log(f"  FAILED {name}: {err}")
    return failed
