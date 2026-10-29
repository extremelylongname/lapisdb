import json
import os
import time
from pathlib import Path

import requests

CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "lapisdb" / "config.json"


def load_config():
    cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    url = os.environ.get("LAPIS_URL", cfg.get("url"))
    token = os.environ.get("LAPIS_TOKEN", cfg.get("token"))
    if not url or not token:
        raise SystemExit("Not configured: run `lapisdb login --url <site> --token <token>` (token from your account page)")
    return url.rstrip("/"), token


def save_config(url, token):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps({"url": url.rstrip("/"), "token": token}))
    CONFIG_PATH.chmod(0o600)


class Client:
    def __init__(self, url=None, token=None):
        self.url, self.token = (url.rstrip("/"), token) if url and token else load_config()
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {self.token}"

    def request(self, method, path, retries=5, **kw):
        # retry transient server/network errors with exponential backoff
        for attempt in range(retries + 1):
            try:
                r = self.session.request(method, f"{self.url}{path}", timeout=120, **kw)
                if r.status_code < 500 or attempt == retries:
                    break
            except (requests.ConnectionError, requests.Timeout):
                if attempt == retries:
                    raise
            time.sleep(2 ** attempt)
        try:
            data = r.json()
        except ValueError:
            data = {"error": r.text[:300]}
        if not r.ok:
            raise RuntimeError(f"{method} {path}: HTTP {r.status_code}: {data.get('error', data)}")
        return data

    def get(self, path, **params):
        return self.request("GET", path, params=params)

    def post(self, path, body):
        return self.request("POST", path, json=body)

    def put_bytes(self, path, data):
        return self.request("PUT", path, data=data, headers={"Content-Type": "application/octet-stream"})

    def me(self):
        return self.get("/api/me")

    def resolve(self, query, radius=1.0):
        return self.get("/api/resolve", q=query, radius=radius)

    def resolve_one(self, query):
        hits = self.resolve(query, radius=0.3)
        if len(hits) != 1:
            raise RuntimeError(f"'{query}' matched {len(hits)} sources; be more specific (e.g. field:id or full name)")
        return hits[0]["uid"]

    def source(self, uid):
        return self.get(f"/api/sources/{requests.utils.quote(uid, safe='')}")

    def search(self, **params):
        return self.get("/api/search", **{k: v for k, v in params.items() if v is not None})

    def bulk(self, ops):
        results = []
        for i in range(0, len(ops), 100):
            results += self.post("/api/bulk", {"ops": ops[i : i + 100]})
        return results

    def upload_sed(self, uid, data, label, code=None, redshift=None, notes=None, original_name=None, kind="sed"):
        body = dict(kind=kind, label=label, code=code, redshift=redshift, notes=notes, original_name=original_name, data=data)
        return self.post(f"/api/sources/{requests.utils.quote(uid, safe='')}/seds", body)

    def otypes(self):
        return self.get("/api/otypes")

    def recent(self, limit=40):
        return self.get("/api/recent", limit=limit)

    def fields(self):
        return self.get("/api/fields")
