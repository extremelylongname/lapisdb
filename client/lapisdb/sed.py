import astropy.units as u
import numpy as np
from astropy.table import Table

WAVE_NAMES = ("wave", "wavelength", "lam", "lambda", "wl", "wav", "wave_um", "lambda_um")
FLUX_NAMES = ("flux", "fnu", "f_nu", "flam", "f_lambda", "f", "model", "sed", "fnu_njy", "flux_njy")
Z_NAMES = ("z", "redshift", "zgrid", "z_grid")
PZ_NAMES = ("pz", "p", "p(z)", "p_z", "prob", "pdf", "probability")
ERR_NAMES = ("err", "error", "unc", "sigma", "flux_err", "fnu_err", "e_flux", "fnu_err_njy")
UNIT_ALIASES = {"AA": u.AA, "um": u.um, "nm": u.nm, "nJy": u.nJy, "uJy": u.uJy, "mJy": u.mJy, "Jy": u.Jy,
                "erg/s/cm2/AA": u.erg / u.s / u.cm**2 / u.AA, "ABmag": u.ABmag}


def read_table(path):
    try:
        return Table.read(path)
    except Exception:
        return Table.read(path, format="ascii")


def pick(t, given, names, position):
    if given:
        return given
    low = {c.lower(): c for c in t.colnames}
    found = next((low[n] for n in names if n in low), None)
    return found or (t.colnames[position] if position < len(t.colnames) else None)


def to_unit(col, unit):
    """Column as a Quantity: explicit unit if given, else the column's own unit."""
    if unit:
        return np.asarray(col, float) * UNIT_ALIASES.get(unit, u.Unit(unit))
    if getattr(col, "unit", None) is None:
        raise SystemExit(f"Column '{col.name}' has no unit; pass it explicitly")
    return u.Quantity(col)


def read_pz(path, z_col=None, p_col=None):
    """Any astropy-readable table -> {z, pz} (P(z) need not be normalized)."""
    t = read_table(path)
    z, p = (np.asarray(t[pick(t, given, names, pos)], float) for given, names, pos in ((z_col, Z_NAMES, 0), (p_col, PZ_NAMES, 1)))
    good = np.isfinite(z) & np.isfinite(p)
    return {"z": [float(f"{x:.6g}") for x in z[good]], "pz": [float(f"{x:.6g}") for x in p[good]]}


def read_sed(path, wave_col=None, flux_col=None, err_col=None, wave_unit=None, flux_unit=None):
    """Any astropy-readable table -> {wave_um, fnu_njy[, fnu_err]} (defaults: um, nJy)."""
    t = read_table(path)
    wc, fc = pick(t, wave_col, WAVE_NAMES, 0), pick(t, flux_col, FLUX_NAMES, 1)
    ec = err_col or next((c for c in t.colnames if c.lower() in ERR_NAMES), None)
    has_units = getattr(t[wc], "unit", None) is not None
    wave = to_unit(t[wc], wave_unit or (None if has_units else "um"))
    flux_has_units = getattr(t[fc], "unit", None) is not None
    funit = flux_unit or (None if flux_has_units else "nJy")
    flux = to_unit(t[fc], funit)
    eq = u.spectral_density(wave)
    is_mag = flux.unit == u.ABmag
    fnu = flux.to(u.nJy).value if is_mag else flux.to(u.nJy, equivalencies=eq).value
    out = {"wave_um": wave.to(u.um, equivalencies=u.spectral()).value, "fnu_njy": fnu}
    if ec:
        out["fnu_err"] = (fnu * np.asarray(t[ec], float) / 1.0857 if is_mag
                          else to_unit(t[ec], funit).to(u.nJy, equivalencies=eq).value)
    good = np.isfinite(out["wave_um"]) & np.isfinite(out["fnu_njy"])
    return {k: [float(f"{x:.6g}") for x in np.asarray(v)[good]] for k, v in out.items()}
