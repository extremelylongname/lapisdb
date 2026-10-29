"""MCP server exposing the LAPIS source DB to AI assistants (uses the `lapisdb login` credentials)."""
from mcp.server.mcpserver import MCPServer

from .client import Client
from .sed import read_pz, read_sed

server = MCPServer(
    "lapisdb",
    instructions=(
        "Query and annotate the JWST LAPIS survey source database. Sources are named LAPIS-JHHMMSS.ss+DDMMSS.s; "
        "they can also be referred to as field:catalog_id (e.g. 09947:1234) or by 'ra dec' in degrees. "
        "Object types are up/down-voted pills shown under the source name (net score); comments form the discussion thread."
    ),
)
_client = None


def client():
    global _client
    _client = _client or Client()
    return _client


@server.tool()
def find_sources(query: str, radius_arcsec: float = 1.0) -> list:
    """Resolve a name, field:catalog_id, bare catalog id, or 'ra dec' (deg or sexagesimal) to matching sources."""
    return client().resolve(query, radius_arcsec)


@server.tool()
def get_source(source: str) -> dict:
    """Full record for one source: coordinates, catalog detections with photometry and photo-z, object-type votes, comments, uploaded SED fits and P(z)."""
    return client().source(client().resolve_one(source))


@server.tool()
def list_sources(otype: str | None = None, field: str | None = None, discussed: bool = False,
                 ra: float | None = None, dec: float | None = None, radius_arcsec: float = 5.0, limit: int = 200) -> list:
    """List sources by object type, field, being discussed, or a cone search (ra, dec in degrees)."""
    cone = ra is not None and dec is not None
    return client().search(otype=otype, field=field, discussed=1 if discussed else None, limit=limit,
                           ra=ra if cone else None, dec=dec if cone else None, radius=radius_arcsec if cone else None)


@server.tool()
def list_object_types() -> list:
    """Object-type vocabulary with the number of sources carrying each type."""
    return client().otypes()


@server.tool()
def annotate(ops: list[dict]) -> list:
    """Bulk annotate sources. Each op: {"source": <name|field:id|"ra dec">, "add_otype"?: str (upvote),
    "downvote_otype"?: str, "remove_otype"?: str (clear own vote), "note"?: str, "comment"?: str}.
    Actions are recorded under the logged-in user."""
    return client().bulk(ops)


@server.tool()
def recent_activity(limit: int = 40) -> list:
    """Most recent comments, classifications and SED uploads across the database."""
    return client().recent(limit)


@server.tool()
def upload_sed_fit(source: str, path: str, label: str, code: str | None = None, redshift: float | None = None,
                   notes: str | None = None, wave_unit: str | None = None, flux_unit: str | None = None) -> dict:
    """Upload an SED fit from a local table file (FITS/ECSV/CSV/text). Units default to the file's own, else um and nJy;
    flux_unit may be nJy, uJy, mJy, Jy, erg/s/cm2/AA or ABmag."""
    uid = client().resolve_one(source)
    data = read_sed(path, wave_unit=wave_unit, flux_unit=flux_unit)
    return {"uid": uid, **client().upload_sed(uid, data, label, code, redshift, notes, path.rsplit("/", 1)[-1])}


@server.tool()
def upload_pz(source: str, path: str, label: str, code: str | None = None, notes: str | None = None) -> dict:
    """Upload a redshift probability distribution P(z) from a local table file (FITS/ECSV/CSV/text) with z and P columns."""
    uid = client().resolve_one(source)
    data = read_pz(path)
    return {"uid": uid, **client().upload_sed(uid, data, label, code, None, notes, path.rsplit("/", 1)[-1], kind="pz")}


def main():
    server.run("stdio")


if __name__ == "__main__":
    main()
