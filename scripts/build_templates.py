import glob
import json
import os
import re
import urllib.request

import numpy as np
import xarray as xr
from astropy.io import fits
from astropy.table import Table
from scipy.ndimage import median_filter
import eazy.igm

BANDS = ['F070W', 'F090W', 'F115W', 'F150W', 'F150W2', 'F162M', 'F182M', 'F200W', 'F210M', 'F250M',
         'F277W', 'F300M', 'F335M', 'F356W', 'F410M', 'F430M', 'F444W', 'F460M', 'F480M']
FILTER_DIR = '/data/astro/jwst_filters'
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'public', 'data')
BD_DIR = '/data/astro/bd_spectra'
SVO_URL = 'https://svo2.cab.inta-csic.es/theory/fps/getdata.php?format=ascii&id=JWST/NIRCam.{}'
C_AA = 2.99792458e18
RJUP_AT_10PC_SQ = (7.1492e7 / 3.0856776e17) ** 2
MAX_MISSING = 0.02
MIN_SNR_OBS = 3
DROPOUT_LIMIT = 10
ZGRID = np.round(np.arange(0, 15.0001, 0.1), 1)


def fetch_filters():
    raw = os.path.join(FILTER_DIR, 'svo_raw')
    os.makedirs(raw, exist_ok=True)
    for b in BANDS:
        csv = f'{FILTER_DIR}/NIRCam.{b}.csv'
        if os.path.exists(csv):
            continue
        dat = f'{raw}/NIRCam.{b}.dat'
        if not os.path.exists(dat):
            urllib.request.urlretrieve(SVO_URL.format(b), dat)
        np.savetxt(csv, np.loadtxt(dat), delimiter=',', header='Wavelength,Transmission', comments='', fmt='%.6g')


def load_filters():
    return {b: np.loadtxt(f'{FILTER_DIR}/NIRCam.{b}.csv', delimiter=',', skiprows=1).T for b in BANDS}


def coverage_mask(lam):
    # spectrum samples bracketing a jump >5x the local log-spacing are treated as a gap
    dl = np.diff(np.log(lam))
    gap = dl > 5 * median_filter(dl, size=11, mode='nearest')

    def covered(x):
        i = np.clip(np.searchsorted(lam, x, side='right') - 1, 0, len(dl) - 1)
        return (x >= lam[0]) & (x <= lam[-1]) & ~gap[i]
    return covered


def band_snr(lam, fnu, err, fl, ft):
    # pixel-sum S/N of the band-averaged flux (pixels treated as independent)
    a = np.interp(lam, fl, ft, left=0, right=0) / lam * np.gradient(lam)
    return np.sum(a * fnu) / np.sqrt(np.sum((a * err) ** 2))


def synth_mags(lam, fnu, filters, err=None):
    """AB mags from fnu [Jy] on lam [AA]: <fnu> = int fnu T dlam/lam / int T dlam/lam."""
    good = np.isfinite(fnu) & np.isfinite(lam) & (np.isfinite(err) if err is not None else True)
    lam, idx = np.unique(lam[good], return_index=True)
    fnu = fnu[good][idx]
    err = None if err is None else err[good][idx]
    covered = coverage_mask(lam)
    out = {}
    for b, (fl, ft) in filters.items():
        inside = (lam > fl[0]) & (lam < fl[-1])
        grid = np.union1d(fl, lam[inside])
        w = np.interp(grid, fl, ft) / grid
        cov = covered(grid)
        wc = w * cov
        if 1 - np.trapz(wc, grid) / np.trapz(w, grid) > MAX_MISSING:
            out[b] = None
            continue
        flux = np.trapz(np.interp(grid, lam, fnu) * wc, grid) / np.trapz(wc, grid)
        ok = flux > 0 and (err is None or band_snr(lam, fnu, err, fl, ft) >= MIN_SNR_OBS)
        out[b] = -2.5 * np.log10(flux / 3631) if ok else None
    return out


def flam_to_fnu_jy(lam_aa, flam_cgs_per_aa):
    return flam_cgs_per_aa * lam_aa ** 2 / C_AA * 1e23


def rnd(x, nd=3):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def track_member(name, param_name, params, mags_list, meta=None):
    m = {'name': name, 'param_name': param_name, 'param': list(params),
         'mag': {b: [rnd(mm[b]) for mm in mags_list] for b in BANDS}}
    if meta:
        m['meta'] = meta
    return m


def point_member(name, mags, meta=None):
    m = {'name': name, 'param_name': None, 'param': None, 'mag': {b: rnd(mags.get(b)) for b in BANDS}}
    if meta:
        m['meta'] = meta
    return m


def drop_absorbed(mags):
    # bands fully eaten by the IGM (> DROPOUT_LIMIT mag below the brightest band) -> null
    brightest = min(v for v in mags.values() if v is not None)
    return {b: (v if v is not None and v - brightest <= DROPOUT_LIMIT else None) for b, v in mags.items()}


def galaxy_family(filters):
    tdir = '/data/astro/eazy_templates/tweak_fsps_QSF_12_v3'
    par = Table.read(os.path.join(os.path.dirname(eazy.__file__),
                                  'data/eazy-photoz/templates/fsps_full/tweak_fsps_QSF_12_v3.param.fits'))
    igm = eazy.igm.Inoue14()
    members = []
    for i, f in enumerate(sorted(glob.glob(f'{tdir}/*.dat'))):
        lam, flam = np.loadtxt(f, unpack=True)
        mags = []
        for z in ZGRID:
            lobs = lam * (1 + z)
            atten = np.ones_like(lobs)
            uv = lam < igm.max_fuv_wave
            if z > 0:
                atten[uv] = igm.full_IGM(z, lobs[uv])
            mags.append(drop_absorbed(synth_mags(lobs, flam_to_fnu_jy(lobs, flam * atten / (1 + z)), filters)))
        members.append(track_member(os.path.basename(f)[:-4], 'z', ZGRID.tolist(), mags,
                                    {'Av': rnd(par['Av'][i], 2), 'EW_Ha': rnd(par['line_EW_Ha'][i], 1)}))
        print('galaxy', f)
    return {'key': 'galaxy_ztrack', 'label': 'EAZY tweak_fsps_QSF_12_v3 (z = 0-15, Inoue+14 IGM)', 'kind': 'track',
            'ref': 'Brammer+2008 (EAZY); Inoue+2014 (IGM)', 'members': members}


def bd_observed_family(filters):
    meta = {r['name']: r for r in Table.read(f'{BD_DIR}/observed_templates_nircam.csv')}
    spectra = []
    for f in sorted(glob.glob(f'{BD_DIR}/beiler2025/*.mrt')):
        t = Table.read(f, format='ascii.cds')
        spectra.append((os.path.basename(f).replace('JWSTspectrum.mrt', ''), 'Beiler+2024',
                        np.array(t['lambda']), np.array(t['S']), np.array(t['e_S'])))
    for f in sorted(glob.glob(f'{BD_DIR}/luhman2024/*.ecsv')):
        t = Table.read(f, format='ascii.ecsv')
        spectra.append(('WISE0855-07', 'Luhman+2024', np.array(t['Wave']), np.ma.filled(t['Flux'], np.nan),
                        np.ma.filled(t['e_Flux'], np.nan)))
    for f in sorted(glob.glob(f'{BD_DIR}/hainline2026/*spec_wave_mic_fnu_nJy.dat')):
        w, fl, fe = np.loadtxt(f, unpack=True)
        spectra.append((os.path.basename(f).replace('-spec_wave_mic_fnu_nJy.dat', ''), 'Hainline+2026', w, fl * 1e-9,
                        fe * 1e-9))
    members = []
    for name, src, wum, fjy, ejy in spectra:
        r = meta.get(name)
        m = {'source': src, 'spt': None if r is None else str(r['spt']),
             'Teff': None if r is None else int(r['teff'])}
        mags = synth_mags(wum * 1e4, fjy, filters, ejy)
        if all(v is None for v in mags.values()):
            print('skipping (no NIRCam coverage):', name)
            continue
        members.append(point_member(name, mags, m))
    return {'key': 'bd_observed', 'label': 'Observed brown dwarfs (JWST spectra)', 'kind': 'points',
            'ref': 'Beiler+2024; Luhman+2024; Hainline+2026', 'members': members}


def model_track(name, teffs, spectra_fn, filters, meta):
    mags = [synth_mags(*spectra_fn(t), filters) for t in teffs]
    print(name)
    return track_member(name, 'Teff', [int(t) for t in teffs], mags, meta)


def elfowl_family(filters):
    d = '/data/astro/sonora_elf_owl/full'

    def files(g, mh):
        fs = glob.glob(f'{d}/spectra_logzz_2.0_teff_*_grav_{g}_mh_{mh}_co_1.0.nc')
        return {float(re.search(r'teff_([0-9.]+)_', f).group(1)): f for f in fs}

    def load(f):
        with xr.open_dataset(f) as ds:
            lam = ds['wavelength'].values * 1e4
            return lam, flam_to_fnu_jy(lam, ds['flux'].values * 1e-8) * RJUP_AT_10PC_SQ
    members = []
    for g, logg in [('1000.0', 5.0), ('100.0', 4.0)]:
        for mh in ['-1.0', '0.0', '1.0']:
            fs = files(g, mh)
            teffs = sorted(fs)
            members.append(model_track(f'Elf Owl logg={logg} [M/H]={float(mh):+.1f}', teffs,
                                       lambda t: load(fs[t]), filters,
                                       {'logg': logg, 'MH': float(mh), 'CO_solar': 1.0, 'logKzz': 2.0}))
    return {'key': 'sonora_elfowl', 'label': 'Sonora Elf Owl', 'kind': 'track',
            'ref': 'Mukherjee+2024 (Sonora Elf Owl)', 'members': members}


def diamondback_family(filters):
    d = '/data/astro/sonora_diamondback/spectra/spectra'

    def load(f):
        w, flam = np.loadtxt(f, skiprows=3, unpack=True)
        lam = w * 1e4
        fnu = flam * (w * 1e-6) ** 2 / 2.99792458e8 * 1e26 * RJUP_AT_10PC_SQ
        return lam, fnu
    members = []
    for fs, label in [('nc', 'cloud-free'), ('f1', 'fsed=1'), ('f2', 'fsed=2'), ('f4', 'fsed=4')]:
        files = {int(re.search(r'/t(\d+)g', f).group(1)): f for f in glob.glob(f'{d}/t*g1000{fs}_m0.0_co1.0.spec')}
        members.append(model_track(f'Diamondback logg=5.0 [M/H]=+0.0 {label}', sorted(files),
                                   lambda t: load(files[t]), filters,
                                   {'logg': 5.0, 'MH': 0.0, 'fsed': None if fs == 'nc' else int(fs[1:])}))
    return {'key': 'sonora_diamondback', 'label': 'Sonora Diamondback', 'kind': 'track',
            'ref': 'Morley+2024 (Sonora Diamondback)', 'members': members}


def bobcat_family():
    members = []
    for mh in ['-0.5', '+0.0', '+0.5']:
        lines = open(f'/data/astro/sonora/photometry_tables/flux_table_JWST{mh}').read().splitlines()
        h = next(i for i, l in enumerate(lines) if l.startswith('Teff'))
        cols = [c for c in lines[h].split() if re.match(r'^F\d', c)]
        rows = np.array([l.replace('*', '').split() for l in lines[h + 1:] if l.strip()], dtype=float)
        rows = rows[np.isclose(rows[:, 1], 5.0)]
        rows = rows[np.argsort(rows[:, 0])]
        logf = {b: rows[:, 6 + cols.index(b)] for b in BANDS}
        mags = [{b: (-2.5 * (logf[b][i] - 3) + 2.5 * np.log10(3631) if logf[b][i] > -50 else None) for b in BANDS}
                for i in range(len(rows))]
        members.append(track_member(f'Bobcat logg=5.0 [M/H]={float(mh):+.1f}', 'Teff', rows[:, 0].astype(int).tolist(),
                                    mags, {'logg': 5.0, 'MH': float(mh), 'CO_solar': 1.0, 'source': 'flux_table_JWST, 10 pc'}))
    return {'key': 'sonora_bobcat', 'label': 'Sonora Bobcat', 'kind': 'track',
            'ref': 'Marley+2021 (Sonora Bobcat)', 'members': members}


def lrd_family():
    t = Table.read('/data/astro/lrd_catalogs/kokorev24_lrd_table_v1.1.fits')
    colmap = {b: b.lower() for b in BANDS}
    colmap['F162M'] = 'f150w2-f162m'
    members = []
    for r in t:
        mags = {}
        for b, c in colmap.items():
            if f'{c}_flux' not in t.colnames:
                continue
            f, e = r[f'{c}_flux'], r[f'{c}_fluxerr']
            mags[b] = 23.9 - 2.5 * np.log10(f) if (f > -99 and e > 0 and f / e >= 3) else None
        members.append(point_member(f'{r["field"]} {r["id"]}', mags,
                                    {'id': int(r['id']), 'field': str(r['field']), 'z_phot': rnd(r['z_phot'], 2)}))
    return {'key': 'lrd', 'label': 'Little red dots (Kokorev+24)', 'kind': 'points',
            'ref': 'Kokorev+2024', 'members': members}


CATEGORIES = {'galaxy_ztrack': 'Galaxies', 'bd_observed': 'Brown dwarfs', 'sonora_elfowl': 'Brown dwarfs',
              'sonora_diamondback': 'Brown dwarfs', 'sonora_bobcat': 'Brown dwarfs', 'lrd': 'Little red dots'}


def write_json(obj, name):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    with open(path, 'w') as f:
        json.dump(obj, f, separators=(',', ':'), allow_nan=False, ensure_ascii=False)
    print(path, os.path.getsize(path) / 1e6, 'MB')


def main():
    fetch_filters()
    filters = load_filters()
    families = [galaxy_family(filters), bd_observed_family(filters), elfowl_family(filters),
                diamondback_family(filters), bobcat_family(), lrd_family()]
    for f in families:
        f['category'] = CATEGORIES[f['key']]
    write_json({'bands': BANDS, 'families': families}, 'templates.json')


if __name__ == '__main__':
    main()
