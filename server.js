'use strict';
/*
 * Sea Tracker — relais de position temps réel, fichier unique (zéro dépendance).
 * Les 3 pages (accueil, skipper, suiveurs) sont intégrées dans ce fichier.
 * Stockage : Upstash Redis (REST) si UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN,
 * sinon fichiers JSON dans DATA_DIR (ou ./data). Lancement : node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const USE_REDIS = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const clients = new Map();

const id16 = () => crypto.randomBytes(8).toString('hex');
const key24 = () => crypto.randomBytes(12).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
/* dedoublonne une liste en conservant l'ordre d'origine */
const dedup = (a) => { const vu = Object.create(null), out = []; for (const x of (a || [])) { if (vu[x]) continue; vu[x] = 1; out.push(x); } return out; };
/* reduit une trace a `max` points en gardant le premier et le dernier */
function decime(pts, max) {
  if (!max || !pts || pts.length <= max || max < 2) return pts || [];
  const out = [], pas = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max - 1; i++) out.push(pts[Math.round(i * pas)]);
  out.push(pts[pts.length - 1]);
  return out;
}

/* ---- import de listes de MMSI (txt / csv / xlsx) ---- */
function xmlDec(t) {
  return String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10))).replace(/&amp;/g, '&');
}
function zipRead(buf) {
  let eo = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; } }
  if (eo < 0) return null;
  const n = buf.readUInt16LE(eo + 10); let p = buf.readUInt32LE(eo + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnl + lel;
    out[name] = { method, data: buf.slice(start, start + csize) };
    p += 46 + nl + el + cl;
  }
  return out;
}
function zipGet(z, name) {
  const e = z && z[name]; if (!e) return null;
  if (e.method === 0) return e.data;
  try { return zlib.inflateRawSync(e.data); } catch { return null; }
}
function xlsxLines(buf) {
  const z = zipRead(buf); if (!z) return [];
  const shared = [];
  const ss = zipGet(z, 'xl/sharedStrings.xml');
  if (ss) {
    const t = ss.toString('utf8');
    for (const si of t.split(/<si[ >]/).slice(1)) {
      let txt = ''; for (const m of si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) txt += m[1];
      shared.push(xmlDec(txt));
    }
  }
  const feuilles = Object.keys(z).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  const lignes = [];
  for (const f of feuilles) {
    const sh = zipGet(z, f); if (!sh) continue;
    const xml = sh.toString('utf8');
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
        const attrs = c[1] || c[3] || '', inner = c[2] || '';
        const ty = (attrs.match(/\st="([^"]+)"/) || [])[1];
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/), tm = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        let v = '';
        if (ty === 's' && vm) v = shared[parseInt(vm[1], 10)] || '';
        else if (tm) v = xmlDec(tm[1]);
        else if (vm) v = vm[1];
        cells.push(v);
      }
      if (cells.length) lignes.push(cells.join(' | '));
    }
  }
  return lignes;
}
/* prefixes reserves : 970 SART, 972 homme a la mer, 974 balise de detresse, 99x aides a la navigation */
const mmsiEcarte = (v) => /^(97[0245]|99)/.test(v);
function champsLigne(ligne) {
  return String(ligne).replace(/\u00a0/g, ' ').split(/\s*[|;,\t]\s*/).map((x) => x.trim()).filter(Boolean);
}
function parseMmsiLignes(lignes, colonne) {
  const items = [];
  for (const brut of lignes) {
    const ligne = String(brut).replace(/\u00a0/g, ' ').trim();
    if (!ligne) continue;
    const nums = (ligne.match(/\b\d{9}\b/g) || []);
    if (!nums.length) continue;
    const mmsi = nums.find((v) => !mmsiEcarte(v)) || nums[0];
    let nom = '';
    const champs = champsLigne(ligne);
    if (colonne !== null && colonne !== undefined && champs[colonne]) {
      nom = champs[colonne];
    } else if (champs.length > 1) {
      for (const c of champs) {
        if (/^\d+$/.test(c)) continue;                              // nombres seuls
        if ((c.match(/[A-Za-z\u00c0-\u00ff]/g) || []).length < 2) continue; // trop peu de lettres
        if (/^[A-Z]{2,4}\d{2,6}$/.test(c)) continue;                 // indicatif VHF (FAL5850)
        nom = c; break;
      }
    }
    if (!nom) { nom = ligne; for (const n of nums) nom = nom.split(n).join(' '); }
    nom = nom.replace(/[;,\t|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (/^(mmsi|n°|no|numero|nom)$/i.test(nom)) continue;
    items.push({ name: nom, mmsi });
  }
  return items;
}
function lignesDepuisFichier(nom, buf) {
  if (/\.xlsx$/i.test(nom || '')) return xlsxLines(buf);
  return buf.toString('utf8').split(/\r?\n/);
}

// --- Export traces (GPX / CSV) ---
function isoT(ms){ try { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); } catch { return ''; } }
function xmlEsc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function tracksToGPX(tracks){
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Sea Tracker" xmlns="http://www.topografix.com/GPX/1/1">\n';
  for (const t of tracks){
    out += '<trk><name>' + xmlEsc(t.name) + '</name><trkseg>\n';
    for (const p of t.points){
      out += '<trkpt lat="' + p[0] + '" lon="' + p[1] + '"><time>' + isoT(p[2]) + '</time>';
      if (p[4] != null) out += '<course>' + p[4] + '</course>';
      if (p[3] != null) out += '<speed>' + (Math.round(p[3] * 0.514444 * 1000) / 1000) + '</speed>';
      out += '</trkpt>\n';
    }
    out += '</trkseg></trk>\n';
  }
  return out + '</gpx>\n';
}
function tracksToCSV(tracks, withBoat){
  let out = (withBoat ? 'boat,' : '') + 'time,lat,lon,sog_kt,cog_deg\n';
  for (const t of tracks){
    const nm = '"' + String(t.name || '').replace(/"/g, '""') + '"';
    for (const p of t.points){
      out += (withBoat ? nm + ',' : '') + isoT(p[2]) + ',' + p[0] + ',' + p[1] + ',' + (p[3] == null ? '' : p[3]) + ',' + (p[4] == null ? '' : p[4]) + '\n';
    }
  }
  return out;
}
function fnameSafe(s){ return (String(s || 'trace').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)) || 'trace'; }
function sendFile(res, body, type, filename){
  res.writeHead(200, Object.assign({ 'Content-Type': type + '; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + filename + '"' }, CORS));
  res.end(body);
}

// --- Vent animé : grille Open-Meteo -> format velocity (leaflet-velocity) ---
function windToVelocity(la1, lo1, la2, lo2, nx, ny, step, uArr, vArr) {
  const now = new Date().toISOString();
  const base = { parameterCategory: 2, dx: step, dy: step, nx: nx, ny: ny, lo1: lo1, la1: la1, lo2: lo2, la2: la2, refTime: now, forecastTime: 0 };
  return [
    { header: Object.assign({}, base, { parameterNumber: 2, parameterNumberName: 'U-component_of_wind', parameterUnit: 'm.s-1' }), data: uArr },
    { header: Object.assign({}, base, { parameterNumber: 3, parameterNumberName: 'V-component_of_wind', parameterUnit: 'm.s-1' }), data: vArr }
  ];
}
async function omGet(url) { try { const r = await fetch(url); return await r.json(); } catch { return null; } }
async function omGrid(qlat, qlon, model, hour) {
  const common = 'latitude=' + qlat.join(',') + '&longitude=' + qlon.join(',') + '&wind_speed_unit=ms&timezone=GMT';
  const mp = (model && model !== 'best_match') ? '&models=' + encodeURIComponent(model) : '';
  if (!hour) {
    let j = await omGet('https://api.open-meteo.com/v1/forecast?' + common + '&current=wind_speed_10m,wind_direction_10m' + mp);
    if (!j || j.error) j = await omGet('https://api.open-meteo.com/v1/forecast?' + common + '&current=wind_speed_10m,wind_direction_10m');
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    if (!arr.length || !arr[0].current) return null;
    return arr.map((p) => { const c = (p && p.current) || {}; return { sp: num(c.wind_speed_10m) || 0, dr: num(c.wind_direction_10m) || 0 }; });
  }
  const days = Math.min(3, Math.max(1, Math.ceil((hour + 6) / 24)));
  let j = await omGet('https://api.open-meteo.com/v1/forecast?' + common + '&hourly=wind_speed_10m,wind_direction_10m&forecast_days=' + days + mp);
  if (!j || j.error) j = await omGet('https://api.open-meteo.com/v1/forecast?' + common + '&hourly=wind_speed_10m,wind_direction_10m&forecast_days=' + days);
  const arr = Array.isArray(j) ? j : (j ? [j] : []);
  if (!arr.length || !arr[0].hourly) return null;
  const t = new Date(); t.setUTCMinutes(0, 0, 0); t.setUTCHours(t.getUTCHours() + hour);
  const target = t.toISOString().slice(0, 13) + ':00';
  const times = arr[0].hourly.time || [];
  let idx = times.indexOf(target); if (idx < 0) idx = 0;
  return arr.map((p) => { const h = (p && p.hourly) || {}; return { sp: num(h.wind_speed_10m && h.wind_speed_10m[idx]) || 0, dr: num(h.wind_direction_10m && h.wind_direction_10m[idx]) || 0 }; });
}
async function fetchWind(clat, clon, model, hour) {
  const STEP = 1, HALF_LAT = 6, HALF_LON = 8;
  const la1 = Math.round(clat) + HALF_LAT, la2 = Math.round(clat) - HALF_LAT;
  const lo1 = Math.round(clon) - HALF_LON, lo2 = Math.round(clon) + HALF_LON;
  const nx = Math.round((lo2 - lo1) / STEP) + 1, ny = Math.round((la1 - la2) / STEP) + 1;
  const qlat = [], qlon = [];
  for (let la = la1; la >= la2; la -= STEP) for (let lo = lo1; lo <= lo2; lo += STEP) { qlat.push(la); qlon.push(lo); }
  hour = hour || 0;
  let e = await omGrid(qlat, qlon, model, hour);
  if (!e || !e.length) e = await omGrid(qlat, qlon, model, 0);
  e = e || [];
  const N = nx * ny, uArr = [], vArr = [];
  for (let i = 0; i < N; i++) { const p = e[i] || { sp: 0, dr: 0 }; const rad = p.dr * Math.PI / 180; uArr.push(-p.sp * Math.sin(rad)); vArr.push(-p.sp * Math.cos(rad)); }
  return windToVelocity(la1, lo1, la2, lo2, nx, ny, STEP, uArr, vArr);
}
async function omForecast(clat, clon, model, vars) {
  let url = 'https://api.open-meteo.com/v1/forecast?latitude=' + clat + '&longitude=' + clon
    + '&hourly=' + vars + '&wind_speed_unit=kn&timezone=auto&forecast_days=4';
  if (model && model !== 'best_match') url += '&models=' + encodeURIComponent(model);
  const r = await fetch(url); return await r.json();
}
async function fetchForecast(clat, clon, model) {
  let d = await omForecast(clat, clon, model, 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,pressure_msl,cloud_cover');
  if (d && d.error) d = await omForecast(clat, clon, model, 'wind_speed_10m,wind_direction_10m,pressure_msl,cloud_cover');
  return d;
}
async function fetchPoint(lat, lon) {
  const wUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=wind_speed_10m,wind_direction_10m,pressure_msl&wind_speed_unit=kn&timezone=auto';
  const mUrl = 'https://marine-api.open-meteo.com/v1/marine?latitude=' + lat + '&longitude=' + lon + '&current=ocean_current_velocity,ocean_current_direction&timezone=auto';
  const [w, m] = await Promise.all([
    fetch(wUrl).then(r => r.json()).catch(() => ({})),
    fetch(mUrl).then(r => r.json()).catch(() => ({}))
  ]);
  const wc = (w && w.current) || {}, mc = (m && m.current) || {};
  const cv = num(mc.ocean_current_velocity);
  const cu = m && m.current_units ? m.current_units.ocean_current_velocity : 'km/h';
  const curKt = cv === null ? null : (cu === 'm/s' ? cv * 1.94384 : (cu === 'kn' || cu === 'kt' ? cv : cv / 1.852));
  return {
    wind: num(wc.wind_speed_10m), windDir: num(wc.wind_direction_10m), pressure: num(wc.pressure_msl),
    curSpeed: curKt === null ? null : Math.round(curKt * 10) / 10, curDir: num(mc.ocean_current_direction)
  };
}

/* ---- back-end fichiers ---- */
const fileCache = new Map();
const fleetCache = new Map();
const fpath = (id) => path.join(DATA, id + '.json');
const fltPath = (id) => path.join(DATA, 'flt_' + id + '.json');
function fileLoad(id) {
  if (fileCache.has(id)) return fileCache.get(id);
  try { const t = JSON.parse(fs.readFileSync(fpath(id), 'utf8')); fileCache.set(id, t); return t; } catch { return null; }
}
function fleetLoad(id) {
  if (fleetCache.has(id)) return fleetCache.get(id);
  try { const t = JSON.parse(fs.readFileSync(fltPath(id), 'utf8')); fleetCache.set(id, t); return t; } catch { return null; }
}
const fileStore = {
  getMeta: async (id) => { const t = fileLoad(id); if (!t) return null; const m = Object.assign({}, t); delete m.points; m.fleets = t.fleets || []; return m; },
  create: async (m) => { const t = Object.assign({ points: [] }, m); fileCache.set(m.id, t); fs.writeFileSync(fpath(m.id), JSON.stringify(t)); },
  setMeta: async (m) => { const t = fileLoad(m.id); if (!t) return; const pts = t.points; Object.assign(t, m); t.points = pts; t.fleets = m.fleets || []; fs.writeFileSync(fpath(m.id), JSON.stringify(t)); },
  append: async (id, pts) => { const t = fileLoad(id); if (!t) return 0; for (const p of pts) t.points.push(p); fs.writeFileSync(fpath(id), JSON.stringify(t)); return t.points.length; },
  points: async (id) => { const t = fileLoad(id); return t ? t.points : []; },
  pointsRemplacer: async (id, pts) => { const t = fileLoad(id); if (!t) return 0; t.points = pts; fs.writeFileSync(fpath(id), JSON.stringify(t)); return pts.length; },
  lastPoint: async (id) => { const t = fileLoad(id); return t && t.points.length ? t.points[t.points.length - 1] : null; },
  fleetCreate: async (m) => { const f = Object.assign({ members: [] }, m); fleetCache.set(m.id, f); fs.writeFileSync(fltPath(m.id), JSON.stringify(f)); },
  fleetGet: async (fid) => { const f = fleetLoad(fid); return f ? { id: f.id, name: f.name, createdAt: f.createdAt, aisIntervalMin: f.aisIntervalMin } : null; },
  fleetAdd: async (fid, tid) => { const f = fleetLoad(fid); if (!f) return; if (f.members.indexOf(tid) < 0) { f.members.push(tid); fs.writeFileSync(fltPath(fid), JSON.stringify(f)); } },
  fleetMembers: async (fid) => { const f = fleetLoad(fid); return f ? dedup(f.members) : []; },
  boatDelete: async (id) => { fileCache.delete(id); try { fs.unlinkSync(fpath(id)); } catch {} },
  fleetRemove: async (fid, tid) => { const f = fleetLoad(fid); if (!f) return; f.members = f.members.filter((x) => x !== tid); fs.writeFileSync(fltPath(fid), JSON.stringify(f)); },
  devSet: async (kh, tid) => { let d = {}; try { d = JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8')); } catch {} d[kh] = tid; fs.writeFileSync(path.join(DATA, 'devices.json'), JSON.stringify(d)); },
  devGet: async (kh) => { try { const d = JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8')); return d[kh] || null; } catch { return null; } },
  mmsiAll: async () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'mmsi.json'), 'utf8')); } catch { return {}; } },
  mmsiSet: async (mmsi, tid) => { let d = {}; try { d = JSON.parse(fs.readFileSync(path.join(DATA, 'mmsi.json'), 'utf8')); } catch {} d[mmsi] = tid; fs.writeFileSync(path.join(DATA, 'mmsi.json'), JSON.stringify(d)); },
  mmsiDel: async (mmsi) => { let d = {}; try { d = JSON.parse(fs.readFileSync(path.join(DATA, 'mmsi.json'), 'utf8')); } catch {} delete d[mmsi]; fs.writeFileSync(path.join(DATA, 'mmsi.json'), JSON.stringify(d)); },
  fleetUpdate: async (fid, patch) => { const f = fleetLoad(fid); if (!f) return null; Object.assign(f, patch); fs.writeFileSync(fltPath(fid), JSON.stringify(f)); return f; },
  fleetIndex: async () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'fleets.json'), 'utf8')); } catch { return []; } },
  fleetIndexAdd: async (fid) => { let a = []; try { a = JSON.parse(fs.readFileSync(path.join(DATA, 'fleets.json'), 'utf8')); } catch {} if (a.indexOf(fid) < 0) { a.push(fid); fs.writeFileSync(path.join(DATA, 'fleets.json'), JSON.stringify(a)); } },
  fleetDelete: async (fid) => { let a = []; try { a = JSON.parse(fs.readFileSync(path.join(DATA, 'fleets.json'), 'utf8')); } catch {} fs.writeFileSync(path.join(DATA, 'fleets.json'), JSON.stringify(a.filter((x) => x !== fid))); fleetCache.delete(fid); try { fs.unlinkSync(fltPath(fid)); } catch {} }
};

/* ---- back-end Upstash Redis (REST) ---- */
const rMeta = (id) => 'st:' + id + ':meta';
const rPts = (id) => 'st:' + id + ':pts';
const rFlt = (id) => 'flt:' + id + ':meta';
const rFltM = (id) => 'flt:' + id + ':members';
let stockErreurs = 0, stockDerniereErreur = '';
let apiErreurs = 0, apiDerniereErreur = '', apiDerniereErreurAt = 0;
async function redisCmd(cmd) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await res.json();
  if (j.error) { stockErreurs++; stockDerniereErreur = String(j.error).slice(0, 160); throw new Error('upstash: ' + j.error); }
  return j.result;
}
const redisStore = {
  getMeta: async (id) => { const s = await redisCmd(['GET', rMeta(id)]); return s ? JSON.parse(s) : null; },
  create: async (m) => { await redisCmd(['SET', rMeta(m.id), JSON.stringify(m)]); },
  setMeta: async (m) => { await redisCmd(['SET', rMeta(m.id), JSON.stringify(m)]); },
  append: async (id, pts) => { const a = ['RPUSH', rPts(id)]; for (const p of pts) a.push(JSON.stringify(p)); return await redisCmd(a); },
  points: async (id) => { const arr = await redisCmd(['LRANGE', rPts(id), '0', '-1']); return (arr || []).map((x) => JSON.parse(x)); },
  pointsRemplacer: async (id, pts) => { await redisCmd(['DEL', rPts(id)]); if (!pts.length) return 0; const a = ['RPUSH', rPts(id)]; for (const p of pts) a.push(JSON.stringify(p)); await redisCmd(a); return pts.length; },
  lastPoint: async (id) => { const v = await redisCmd(['LINDEX', rPts(id), '-1']); return v ? JSON.parse(v) : null; },
  fleetCreate: async (m) => { await redisCmd(['SET', rFlt(m.id), JSON.stringify(m)]); },
  fleetGet: async (fid) => { const s = await redisCmd(['GET', rFlt(fid)]); return s ? JSON.parse(s) : null; },
  fleetAdd: async (fid, tid) => { const a = await redisCmd(['LRANGE', rFltM(fid), '0', '-1']); if ((a || []).indexOf(tid) >= 0) return; await redisCmd(['RPUSH', rFltM(fid), tid]); },
  fleetMembers: async (fid) => { const a = await redisCmd(['LRANGE', rFltM(fid), '0', '-1']); return dedup(a || []); },
  boatDelete: async (id) => { await redisCmd(['DEL', rMeta(id)]); await redisCmd(['DEL', rPts(id)]); },
  fleetRemove: async (fid, tid) => { await redisCmd(['LREM', rFltM(fid), '0', tid]); },
  devSet: async (kh, tid) => { await redisCmd(['SET', 'dev:' + kh, tid]); },
  devGet: async (kh) => { return await redisCmd(['GET', 'dev:' + kh]); },
  mmsiAll: async () => { const a = await redisCmd(['HGETALL', 'mmsi']); const o = {}; if (Array.isArray(a)) { for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; } else if (a && typeof a === 'object') { Object.assign(o, a); } return o; },
  mmsiSet: async (mmsi, tid) => { await redisCmd(['HSET', 'mmsi', mmsi, tid]); },
  mmsiDel: async (mmsi) => { await redisCmd(['HDEL', 'mmsi', mmsi]); },
  fleetUpdate: async (fid, patch) => { const v = await redisCmd(['GET', rFlt(fid)]); if (!v) return null; let f = {}; try { f = JSON.parse(v); } catch {} Object.assign(f, patch); await redisCmd(['SET', rFlt(fid), JSON.stringify(f)]); return f; },
  fleetIndex: async () => { const a = await redisCmd(['SMEMBERS', 'flts']); return Array.isArray(a) ? a : []; },
  fleetIndexAdd: async (fid) => { await redisCmd(['SADD', 'flts', fid]); },
  fleetDelete: async (fid) => { await redisCmd(['SREM', 'flts', fid]); await redisCmd(['DEL', rFlt(fid)]); await redisCmd(['DEL', rFltM(fid)]); }
};
/* Pyramides raster Litto3D confirmees au catalogue Shom (Licence Ouverte).
   Normandie et Gascogne : pas de pyramide WMS publiee a ce jour. */
/* Ecart approximatif entre le zero hydrographique (sondes des cartes) et le
   zero NGF-IGN69 (reference Litto3D), par grande zone cotiere. Valeurs
   arrondies, precision ±0,5 m : suffisant pour lire un relief, pas pour un
   calcul de pied de pilote (les valeurs exactes par port sont dans les RAM du
   Shom). Le ZH est SOUS le zero NGF de cette valeur. */
function ecartZHapprox(lat, lon) {
  if (lon > 2.8) return 0.3;                      /* Mediterranee et Corse */
  if (lat > 50.3) return 3.6;                     /* Dunkerque - Calais */
  if (lat > 49.3 && lon > -0.3) return 4.5;       /* Baie de Seine */
  if (lat > 49.3) return 3.8;                     /* Cotentin */
  if (lat > 48.5 && lon > -2.2) return 6.5;       /* Saint-Malo - Granville */
  if (lat > 48.5) return 5.2;                     /* Bretagne Nord */
  if (lat > 47.8 && lon < -4.3) return 4.0;       /* Iroise - Brest */
  if (lat > 46.8) return 2.9;                     /* Bretagne Sud - Morbihan */
  if (lat > 45.8) return 3.3;                     /* Vendee - Charente */
  return 2.4;                                     /* Gironde - Cote basque */
}
const LITTO3D_COUCHES = [
  'LITTO3D_BZH_2018_2021_PYR_3857_WMSR',   /* Cotes-d'Armor, Ille-et-Vilaine, Morbihan */
  'LITTO3D_FINISTR_2014_PYR_3857_WMSR',    /* Finistere (Glenan inclus) */
  'L3D_MAR_LR_2011_PYR_3857_WMSR',         /* Languedoc-Roussillon */
  'LITTO3D_PACA_2015_PYR_3857_WMSR',       /* PACA */
  'L3D_LIDAR_CORSE_2017_2018_PYR_3857_WMSR' /* Corse */
];
/* ---- Courants de marée 2D (Shom, Licence Ouverte) ----
   Le paquet courants2d.json.gz (produit par conversion des atlas numeriques)
   est charge au demarrage s'il est present a cote de server.js. Sans lui,
   l'API de courants repond 503 et tout le reste fonctionne normalement. */
let C2D = null, c2dInfo = 'fichier absent';
/* Les navigateurs mobiles decompressent parfois les .gz au telechargement et
   retirent l'extension : on accepte donc les deux noms, et pour chacun on
   tente gunzip puis lecture directe — le contenu prime sur le nom. */
for (const nomC2D of ['courants2d.json.gz', 'courants2d.json']) {
  try {
    const brutC2D = fs.readFileSync(__dirname + '/' + nomC2D);
    let texteC2D;
    try { texteC2D = zlib.gunzipSync(brutC2D).toString('utf8'); }
    catch { texteC2D = brutC2D.toString('utf8'); }
    C2D = JSON.parse(texteC2D);
    let nPts = 0; for (const z of C2D.zones) nPts += z.pts.length / 2;
    c2dInfo = C2D.zones.length + ' zones, ' + nPts + ' points (' + nomC2D + ')';
    console.log('[courants2d] ' + c2dInfo);
    break;
  } catch { C2D = null; }
}

/* Courant u/v (noeuds) au point demande.
   h : heures par rapport a la PM (ou BM selon la zone) du port de reference,
   de -6 a +6. coef : coefficient de maree (interpolation lineaire entre la
   morte-eau 45 et la vive-eau 95, prolongee au-dela).
   Zone retenue : la plus fine (pas de grille minimal) ayant des points a
   moins de 2,5 pas ; ponderation inverse au carre de la distance sur les
   4 points les plus proches. */
function courantAu(lat, lon, h, coef) {
  if (!C2D) return null;
  const hh = Math.max(-6, Math.min(6, h));
  const fc = (coef - 45) / 50;
  const i0 = Math.floor(hh + 6), i1 = Math.min(12, i0 + 1), ft = (hh + 6) - i0;
  const coslat = Math.cos(lat * Math.PI / 180);
  let choix = null;
  for (const z of C2D.zones) {
    const m = 3 * z.pas;
    if (lat < z.bbox[0] - m || lat > z.bbox[1] + m || lon < z.bbox[2] - m || lon > z.bbox[3] + m) continue;
    const rayon2 = Math.pow(2.5 * z.pas, 2);
    const prox = [];
    for (let k = 0; k < z.pts.length; k += 2) {
      const dla = z.pts[k] - lat, dlo = (z.pts[k + 1] - lon) * coslat;
      const d2 = dla * dla + dlo * dlo;
      if (d2 <= rayon2) prox.push([d2, k / 2]);
    }
    if (!prox.length) continue;
    if (!choix || z.pas < choix.z.pas) { prox.sort((a, b) => a[0] - b[0]); choix = { z: z, prox: prox.slice(0, 4) }; }
  }
  if (!choix) return null;
  const z = choix.z;
  let su = 0, sv = 0, sp = 0;
  for (const [d2, idx] of choix.prox) {
    const b = idx * 26;
    const lit = (tab, j) => tab[b + j];
    /* interpolation temporelle puis en coefficient, en dixiemes de noeud */
    const u45 = lit(z.me, i0) + (lit(z.me, i1) - lit(z.me, i0)) * ft;
    const u95 = lit(z.ve, i0) + (lit(z.ve, i1) - lit(z.ve, i0)) * ft;
    const v45 = lit(z.me, 13 + i0) + (lit(z.me, 13 + i1) - lit(z.me, 13 + i0)) * ft;
    const v95 = lit(z.ve, 13 + i0) + (lit(z.ve, 13 + i1) - lit(z.ve, 13 + i0)) * ft;
    const uu = u45 + (u95 - u45) * fc, vv = v45 + (v95 - v45) * fc;
    const p = 1 / (d2 + 1e-10);
    su += uu * p; sv += vv * p; sp += p;
  }
  const u = su / sp / 10, v = sv / sp / 10; /* noeuds */
  const vit = Math.sqrt(u * u + v * v);
  let dir = Math.atan2(u, v) * 180 / Math.PI; if (dir < 0) dir += 360; /* direction vers laquelle porte */
  return { u: Math.round(u * 100) / 100, v: Math.round(v * 100) / 100,
           vitesse: Math.round(vit * 100) / 100, dir: Math.round(dir),
           zone: z.n, port: z.port, base: z.base };
}
/* ---- Phase de maree automatique ----
   Pour dater la PM/BM d'un port de reference et connaitre le coefficient a un
   instant donne, on lit le niveau de la mer d'Open-Meteo Marine au droit du
   port (heure par heure, ±2 jours), on detecte les extremums et on les affine
   par interpolation parabolique. Le coefficient est calcule a Brest, selon sa
   definition : demi-marnage / unite de hauteur (3,05 m) x 100.
   Precision attendue : quelques minutes sur l'heure de PM, ±5 sur le
   coefficient — suffisant pour un courant d'atlas, pas pour un annuaire. */
const PORTS_MAREE = {
  'Concarneau':          [47.85, -3.95],
  'Port-Tudy':           [47.64, -3.44],
  'PORT-NAVALO':         [47.53, -2.92],
  'Port-Navalo':         [47.53, -2.92],
  'Brest':               [48.33, -4.55],
  'Cherbourg':           [49.66, -1.62],
  'Saint-Malo':          [48.66, -2.03],
  'Calais':              [50.97, 1.83],
  'Roscoff':             [48.73, -3.97],
  'Paimpol':             [48.80, -3.02],
  'Boulogne-sur-Mer':    [50.75, 1.55],
  'Dunkerque':           [51.06, 2.35],
  'Le Havre':            [49.48, 0.05],
  'La Rochelle':         [46.15, -1.22],
  'Saint-Nazaire':       [47.25, -2.30],
  "Les Sables d'Olonne": [46.48, -1.82],
  'Pointe de Grave':     [45.57, -1.10]
};
/* Correction de phase par port, en minutes, a AJOUTER a l'heure d'evenement
   issue du modele Open-Meteo. Mesuree par comparaison avec l'annuaire
   (maree.info / SHOM). Une seule mesure par port a ce stade : valeurs
   provisoires, a confirmer sur plusieurs jours avant d'etre considerees
   acquises. Les ports absents de la table ne sont pas corriges. */
const CORRECTION_MAREE_MIN = {
  'Port-Tudy': 24   /* mesure du 26/07/2026 : modele en avance de 24 min */
};
const mareeCache = new Map(); /* port -> { t, evts: [{t, type, h}] } */
let mareeDerniereErreur = '';
async function mareeEvenements(port, tCible) {
  const pos = PORTS_MAREE[port];
  if (!pos) return null;
  /* Deux regimes : le present (previsions glissantes, cache 6 h) et le passe
     (archive de niveau de mer autour d'une date, cache permanent par jour).
     Sans ce second regime, aucune correction de courant n'est possible sur
     l'historique — donc pas de polaire observee corrigee. */
  const ancien = tCible !== undefined && Math.abs(Date.now() - tCible) > 20 * 3600e3;
  const cle = ancien ? (port + '|' + new Date(tCible).toISOString().slice(0, 10)) : port;
  const e = mareeCache.get(cle);
  if (e && (ancien || Date.now() - e.t < 6 * 3600e3)) return e.evts;
  try {
    let url;
    if (ancien) {
      const j0 = new Date(tCible - 36 * 3600e3).toISOString().slice(0, 10);
      const j1 = new Date(tCible + 36 * 3600e3).toISOString().slice(0, 10);
      url = 'https://marine-api.open-meteo.com/v1/marine?latitude=' + pos[0] + '&longitude=' + pos[1]
        + '&hourly=sea_level_height_msl&start_date=' + j0 + '&end_date=' + j1 + '&timezone=UTC';
    } else url = 'https://marine-api.open-meteo.com/v1/marine?latitude=' + pos[0] + '&longitude=' + pos[1]
      + '&hourly=sea_level_height_msl&past_days=1&forecast_days=7&timezone=UTC';
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 7000);
    const rep = await fetch(url, { signal: ac.signal });
    clearTimeout(tm);
    const d = await rep.json();
    const times = d.hourly.time, hs = d.hourly.sea_level_height_msl;
    const evts = [];
    for (let i = 1; i < hs.length - 1; i++) {
      if (hs[i] === null || hs[i - 1] === null || hs[i + 1] === null) continue;
      const max = hs[i] >= hs[i - 1] && hs[i] >= hs[i + 1];
      const min = hs[i] <= hs[i - 1] && hs[i] <= hs[i + 1];
      if (!max && !min) continue;
      /* affinage parabolique du sommet entre les trois points horaires */
      const den = hs[i - 1] - 2 * hs[i] + hs[i + 1];
      const frac = Math.abs(den) > 1e-9 ? (hs[i - 1] - hs[i + 1]) / (2 * den) : 0;
      const t0 = Date.parse(times[i] + ':00Z');
      const hSommet = hs[i] - (hs[i - 1] - hs[i + 1]) * frac / 4;
      evts.push({ t: t0 + frac * 3600e3, type: max ? 'PM' : 'BM', h: Math.round(hSommet * 100) / 100 });
    }
    mareeCache.set(cle, { t: Date.now(), evts });
    if (mareeCache.size > 800) { const it = mareeCache.keys(); for (let i = 0; i < 100; i++) mareeCache.delete(it.next().value); }
    return evts;
  } catch (err) {
    mareeDerniereErreur = (port + ' : ' + String(err && err.message || err)).slice(0, 120);
    return null;
  }
}
async function coefficientA(t) {
  const evts = await mareeEvenements('Brest', t);
  if (!evts) return null;
  const pms = evts.filter((e2) => e2.type === 'PM');
  if (!pms.length) return null;
  let pm = pms[0];
  for (const e2 of pms) if (Math.abs(e2.t - t) < Math.abs(pm.t - t)) pm = e2;
  const bms = evts.filter((e2) => e2.type === 'BM');
  let marnages = [];
  for (const b of bms) if (Math.abs(b.t - pm.t) < 8 * 3600e3) marnages.push(pm.h - b.h);
  if (!marnages.length) return null;
  const marnage = marnages.reduce((a2, b2) => a2 + b2, 0) / marnages.length;
  return Math.max(20, Math.min(120, Math.round(marnage / 2 / 3.05 * 100)));
}
/* evenement de reference (PM ou BM selon la zone) le plus proche de t */
async function phasePour(port, base, t) {
  const evts = await mareeEvenements(port, t);
  if (!evts) return null;
  const bons = evts.filter((e2) => e2.type === base);
  if (!bons.length) return null;
  const corr = (CORRECTION_MAREE_MIN[port] || 0) * 60e3;
  let ref = bons[0];
  for (const e2 of bons) if (Math.abs(e2.t + corr - t) < Math.abs(ref.t + corr - t)) ref = e2;
  return { t: ref.t + corr, type: ref.type, h: ref.h, correctionMin: CORRECTION_MAREE_MIN[port] || 0 };
}
/* ---- Trait de cote cote serveur ----
   Charge une fois au demarrage depuis terre.json.gz (le meme paquet que le
   routeur) et indexe par bandes de latitude : sert a ne pas dessiner de
   fleches de courant au-dessus des terres. Absent, le filtre est simplement
   inactif — aucune autre fonction n'en depend. */
let TERRE_IDX = null, terreInfo = 'fichier absent';
try {
  const brutT = zlib.gunzipSync(fs.readFileSync(__dirname + '/terre.json.gz'));
  const jT = JSON.parse(brutT.toString('utf8'));
  const PAS = 0.25;
  TERRE_IDX = { pas: PAS, bandes: Object.create(null) };
  let nAr = 0;
  for (const a of jT.anneaux) {
    const p = a.pts; nAr++;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const y1 = p[j][0], x1 = p[j][1], y2 = p[i][0], x2 = p[i][1];
      if (y1 === y2) continue;
      const r0 = Math.floor(Math.min(y1, y2) / PAS), r1 = Math.floor(Math.max(y1, y2) / PAS);
      for (let rr = r0; rr <= r1; rr++) (TERRE_IDX.bandes[rr] || (TERRE_IDX.bandes[rr] = [])).push(y1, x1, y2, x2);
    }
  }
  terreInfo = nAr + ' anneaux';
  console.log('[terre] ' + terreInfo);
} catch { TERRE_IDX = null; }

function surTerreServeur(lat, lon) {
  if (!TERRE_IDX) return false;
  const b = TERRE_IDX.bandes[Math.floor(lat / TERRE_IDX.pas)];
  if (!b) return false;
  let c = false;
  for (let i = 0; i < b.length; i += 4) {
    const y1 = b[i], x1 = b[i + 1], y2 = b[i + 2], x2 = b[i + 3];
    if ((y1 > lat) !== (y2 > lat) && lon < x1 + (x2 - x1) * (lat - y1) / (y2 - y1)) c = !c;
  }
  return c;
}
/* ==================== ARCHIVE LONGUE DUREE ====================
   Principe : les positions ne sont JAMAIS supprimees. Deux etages :
     - chaud  : les dernieres 48 h dans le stockage courant (Redis/fichiers),
                pour l'affichage temps reel ;
     - froid  : tout le reste ecrit dans un stockage objet S3-compatible
                (Cloudflare R2, Scaleway, Backblaze...), un fichier gzip par
                bateau et par mois, immuable une fois clos.
   Le format d'archive est volontairement simple et auto-descriptif : il doit
   rester lisible dans dix ans sans ce serveur.
   Sans variables d'environnement S3, l'archivage est simplement inactif et
   rien d'autre ne change. */

const S3 = {
  endpoint: process.env.S3_ENDPOINT || '',       /* https://xxx.r2.cloudflarestorage.com */
  bucket: process.env.S3_BUCKET || '',
  cle: process.env.S3_ACCESS_KEY_ID || '',
  secret: process.env.S3_SECRET_ACCESS_KEY || '',
  region: process.env.S3_REGION || 'auto'
};
const ARCHIVE_ACTIVE = !!(S3.endpoint && S3.bucket && S3.cle && S3.secret);
let archiveInfo = ARCHIVE_ACTIVE ? 'configuree (' + S3.bucket + ')' : 'inactive (variables S3 absentes)';
let archiveDernier = '';

/* --- signature AWS Signature V4, sans dependance --- */
function s3Hash(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function s3Hmac(cle, x) { return crypto.createHmac('sha256', cle).update(x).digest(); }
async function s3Requete(methode, chemin, corps, typeContenu) {
  const url = new URL(S3.endpoint.replace(/\/$/, '') + '/' + S3.bucket + chemin);
  const maintenant = new Date();
  const amzDate = maintenant.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateJour = amzDate.slice(0, 8);
  const charge = corps || Buffer.alloc(0);
  const hashCharge = s3Hash(charge);
  const enTetes = {
    'host': url.host,
    'x-amz-content-sha256': hashCharge,
    'x-amz-date': amzDate
  };
  if (typeContenu) enTetes['content-type'] = typeContenu;
  const clesTriees = Object.keys(enTetes).sort();
  const enTetesCanon = clesTriees.map((k) => k + ':' + enTetes[k] + '\n').join('');
  const listeEnTetes = clesTriees.join(';');
  const requeteCanon = [methode, url.pathname, url.searchParams.toString(), enTetesCanon, listeEnTetes, hashCharge].join('\n');
  const portee = dateJour + '/' + S3.region + '/s3/aws4_request';
  const aSigner = ['AWS4-HMAC-SHA256', amzDate, portee, s3Hash(requeteCanon)].join('\n');
  let k = s3Hmac('AWS4' + S3.secret, dateJour);
  k = s3Hmac(k, S3.region); k = s3Hmac(k, 's3'); k = s3Hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(aSigner).digest('hex');
  enTetes['authorization'] = 'AWS4-HMAC-SHA256 Credential=' + S3.cle + '/' + portee
    + ', SignedHeaders=' + listeEnTetes + ', Signature=' + signature;
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 20000);
  try {
    const rep = await fetch(url.toString(), {
      method: methode, headers: enTetes,
      body: methode === 'GET' || methode === 'HEAD' ? undefined : charge,
      signal: ac.signal
    });
    clearTimeout(tm);
    return rep;
  } catch (e) { clearTimeout(tm); throw e; }
}

/* --- chemin d'archive : un objet par bateau et par mois --- */
function archiveChemin(bid, annee, mois) {
  return '/positions/' + bid + '/' + annee + '-' + String(mois).padStart(2, '0') + '.json.gz';
}

async function archiveLire(bid, annee, mois) {
  if (!ARCHIVE_ACTIVE) return null;
  const rep = await s3Requete('GET', archiveChemin(bid, annee, mois));
  if (rep.status === 404) return null;
  if (!rep.ok) throw new Error('archive lecture ' + rep.status);
  const buf = Buffer.from(await rep.arrayBuffer());
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

async function archiveEcrire(bid, annee, mois, paquet) {
  const corps = zlib.gzipSync(Buffer.from(JSON.stringify(paquet), 'utf8'), { level: 9 });
  const rep = await s3Requete('PUT', archiveChemin(bid, annee, mois), corps, 'application/gzip');
  if (!rep.ok) throw new Error('archive ecriture ' + rep.status + ' ' + (await rep.text()).slice(0, 120));
  return corps.length;
}
/* --- bascule : deplace vers l'archive tout point anterieur a 48 h ---
   Cette operation est la seule autorisee a retirer des points du stockage
   chaud, et uniquement APRES confirmation d'ecriture de l'archive. En cas
   d'echec, rien n'est retire : mieux vaut un Redis qui grossit qu'une donnee
   perdue (principe du brut immuable). */
const ARCHIVE_SEUIL_MS = 48 * 3600e3;
let archiveEnCours = false;
let archiveStats = { dernierPassage: null, bateaux: 0, pointsArchives: 0, erreurs: 0 };

async function archiveBasculer(force) {
  if (!ARCHIVE_ACTIVE || archiveEnCours) return archiveStats;
  archiveEnCours = true;
  const limite = Date.now() - ARCHIVE_SEUIL_MS;
  let nBateaux = 0, nPoints = 0, nErreurs = 0;
  try {
    const fids = await store.fleetIndex().catch(() => []);
    const vus = new Set();
    for (const fid of fids) {
      const membres = await store.fleetMembers(fid).catch(() => []);
      for (const bid of membres) {
        if (vus.has(bid)) continue;
        vus.add(bid);
        try {
          const pts = await store.points(bid);
          if (!pts.length) continue;
          const anciens = pts.filter((p) => p[2] < limite);
          if (anciens.length < 1) continue;
          /* regrouper par mois UTC */
          const parMois = new Map();
          for (const p of anciens) {
            const d = new Date(p[2]);
            const cle = d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1);
            if (!parMois.has(cle)) parMois.set(cle, []);
            parMois.get(cle).push(p);
          }
          let toutOk = true;
          for (const [cle, lot] of parMois) {
            const [annee, mois] = cle.split('-').map(Number);
            try {
              const existant = await archiveLire(bid, annee, mois);
              const fusion = existant && existant.points ? existant.points.concat(lot) : lot;
              /* dedoublonnage par horodatage, ordre chronologique */
              const parT = new Map();
              for (const p of fusion) parT.set(p[2], p);
              const finaux = Array.from(parT.values()).sort((a, b) => a[2] - b[2]);
              const meta = await store.getMeta(bid).catch(() => null);
              await archiveEcrire(bid, annee, mois, {
                v: 1,
                bateau: bid,
                nom: meta ? meta.name : null,
                mmsi: meta ? (meta.mmsi || null) : null,
                mois: annee + '-' + String(mois).padStart(2, '0'),
                champs: ['lat', 'lon', 't', 'sog', 'cog'],
                ecrit: new Date().toISOString(),
                points: finaux
              });
              nPoints += lot.length;
            } catch (e) {
              toutOk = false; nErreurs++;
              archiveDernier = 'echec ' + bid + ' ' + cle + ' : ' + String(e && e.message || e).slice(0, 90);
            }
          }
          /* on ne retire du chaud QUE si toutes les archives du bateau sont ecrites */
          if (toutOk) {
            const restants = pts.filter((p) => p[2] >= limite);
            if (restants.length !== pts.length && typeof store.pointsRemplacer === 'function') {
              await store.pointsRemplacer(bid, restants);
              nBateaux++;
            }
          }
        } catch (e) { nErreurs++; }
      }
    }
  } catch (e) { nErreurs++; }
  archiveEnCours = false;
  archiveStats = { dernierPassage: new Date().toISOString(), bateaux: nBateaux, pointsArchives: nPoints, erreurs: nErreurs };
  return archiveStats;
}
/* ==================== VENT ARCHIVE ====================
   Pour reconstruire la polaire observee d'un bateau, il faut le vent qu'il
   faisait a l'endroit et a l'heure de chaque segment de trace. Open-Meteo
   fournit un service d'archive gratuit. On l'interroge par maille de 0,25 deg
   et par tranche de 24 h, et on garde le resultat en cache : sans cela, une
   seule polaire declencherait des milliers d'appels.
   Le cache est en memoire (perdu au redemarrage) : c'est acceptable, le
   recalcul est simplement plus lent la premiere fois. */
const ventArchiveCache = new Map();     /* cle maille|jour -> {temps:[], s:[], d:[]} */
let ventArchiveAppels = 0, ventArchiveErreurs = 0;

function ventCleMaille(lat, lon, jourISO) {
  return (Math.round(lat * 4) / 4).toFixed(2) + '|' + (Math.round(lon * 4) / 4).toFixed(2) + '|' + jourISO;
}

async function ventArchive(lat, lon, tMs) {
  const jour = new Date(tMs).toISOString().slice(0, 10);
  const cle = ventCleMaille(lat, lon, jour);
  let bloc = ventArchiveCache.get(cle);
  if (bloc === undefined) {
    const la = Math.round(lat * 4) / 4, lo = Math.round(lon * 4) / 4;
    try {
      ventArchiveAppels++;
      const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + la + '&longitude=' + lo
        + '&start_date=' + jour + '&end_date=' + jour
        + '&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=UTC';
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 15000);
      const rep = await fetch(url, { signal: ac.signal });
      clearTimeout(tm);
      const d = await rep.json();
      if (d && d.hourly && d.hourly.time) {
        bloc = { temps: d.hourly.time, s: d.hourly.wind_speed_10m, d: d.hourly.wind_direction_10m };
      } else bloc = null;
    } catch { ventArchiveErreurs++; bloc = null; }
    ventArchiveCache.set(cle, bloc);
    if (ventArchiveCache.size > 4000) {          /* garde-fou memoire */
      const it = ventArchiveCache.keys();
      for (let i = 0; i < 500; i++) ventArchiveCache.delete(it.next().value);
    }
  }
  if (!bloc) return null;
  /* interpolation lineaire entre les deux heures encadrantes */
  const h = new Date(tMs).getUTCHours();
  const frac = (tMs - Date.parse(jour + 'T' + String(h).padStart(2, '0') + ':00:00Z')) / 3600e3;
  const i0 = h, i1 = Math.min(bloc.temps.length - 1, h + 1);
  const s0 = bloc.s[i0], s1 = bloc.s[i1], d0 = bloc.d[i0], d1 = bloc.d[i1];
  if (s0 === null || s0 === undefined || d0 === null || d0 === undefined) return null;
  const tws = (s1 === null || s1 === undefined) ? s0 : s0 + (s1 - s0) * frac;
  let twd;
  if (d1 === null || d1 === undefined) twd = d0;
  else {
    const a0 = d0 * Math.PI / 180, a1 = d1 * Math.PI / 180;
    twd = (Math.atan2(Math.sin(a0) * (1 - frac) + Math.sin(a1) * frac,
                      Math.cos(a0) * (1 - frac) + Math.cos(a1) * frac) * 180 / Math.PI + 360) % 360;
  }
  return { tws: tws, twd: twd };
}
const store = USE_REDIS ? redisStore : fileStore;

/* ---- appartenance a une flotte : source unique ----
   L'appartenance est ecrite des deux cotes (liste des membres de la flotte ET
   meta.fleets du bateau). meta.fleets pilote la diffusion SSE et l'intervalle
   AIS : les deux doivent rester synchronises, sinon le bateau s'affiche dans la
   flotte mais n'y emet jamais. */
async function fleetAttach(fid, tid) {
  await store.fleetAdd(fid, tid);
  try {
    const m = await store.getMeta(tid);
    if (!m) return false;
    const f = m.fleets || [];
    if (f.indexOf(fid) < 0) { f.push(fid); m.fleets = f; await store.setMeta(m); }
    return true;
  } catch { return false; }
}
async function fleetDetach(fid, tid) {
  await store.fleetRemove(fid, tid);
  try {
    const m = await store.getMeta(tid);
    if (m && Array.isArray(m.fleets) && m.fleets.indexOf(fid) >= 0) {
      m.fleets = m.fleets.filter((x) => x !== fid);
      await store.setMeta(m);
    }
  } catch {}
}
/* retire la flotte de tous ses membres avant sa suppression */
async function fleetDetachAll(fid) {
  let ids = [];
  try { ids = await store.fleetMembers(fid); } catch {}
  for (const tid of ids) {
    try {
      const m = await store.getMeta(tid);
      if (m && Array.isArray(m.fleets) && m.fleets.indexOf(fid) >= 0) {
        m.fleets = m.fleets.filter((x) => x !== fid);
        await store.setMeta(m);
      }
    } catch {}
  }
  return ids.length;
}
/* Cache des traces de flotte. Sans lui, chaque ouverture de /vf declenche une
   lecture complete par bateau : sur une flotte de 100+ bateaux, la note Upstash
   suit le nombre de visiteurs. Les positions fraiches arrivent par le flux SSE,
   ce cache ne retarde donc que l'historique deja acquis. */
const TRACES_TTL = 60000;
const tracesCache = new Map();
function tracesLire(cle) {
  const e = tracesCache.get(cle);
  if (!e) return null;
  if (Date.now() - e.t > TRACES_TTL) { tracesCache.delete(cle); return null; }
  return e.v;
}
function tracesEcrire(cle, v) {
  tracesCache.set(cle, { t: Date.now(), v: v });
  if (tracesCache.size > 40) {
    for (const [k, e] of tracesCache) if (Date.now() - e.t > TRACES_TTL) tracesCache.delete(k);
  }
}
function tracesVider(fid) {
  for (const k of Array.from(tracesCache.keys())) if (k.indexOf(fid + '|') === 0) tracesCache.delete(k);
}
const fleetClients = new Map();
function broadcastFleet(fid, obj) {
  const set = fleetClients.get(fid); if (!set) return;
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of set) { try { res.write(msg); } catch {} }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-publish-key,x-admin-key'
};
function json(res, code, obj, req) {
  const head = Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' }, CORS);
  const body = JSON.stringify(obj);
  /* les traces de flotte sont de longues listes de nombres : elles se compriment
     d'un facteur 5 a 8, ce qui compte sur une liaison 4G/5G en mer. */
  if (req && body.length > 4096 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    try {
      const gz = zlib.gzipSync(Buffer.from(body));
      head['Content-Encoding'] = 'gzip';
      head['Vary'] = 'Accept-Encoding';
      res.writeHead(code, head);
      return res.end(gz);
    } catch {}
  }
  res.writeHead(code, head);
  res.end(body);
}
/* clé de gestion : toute écriture qui consomme du quota AIS ou modifie la
   composition d'une flotte doit la présenter (en-tête x-admin-key ou ?k=). */
const ERR_GESTION = { error: 'Réservé à la console : clé de gestion requise.' };
function adminOk(req, u) {
  if (!ADMIN_KEY) return false;
  const k = req.headers['x-admin-key'] || u.searchParams.get('k') || '';
  return k === ADMIN_KEY;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1e6) { reject(new Error('too big')); req.destroy(); } else b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function broadcast(id, point) {
  const set = clients.get(id); if (!set) return;
  const msg = 'data: ' + JSON.stringify(point) + '\n\n';
  for (const res of set) { try { res.write(msg); } catch {} }
}
function serveHTML(res, html, reqUrl) {
  const start = reqUrl || '/';
  const href = '/manifest.webmanifest?s=' + encodeURIComponent(start);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
  res.end(html.replace('__MANIFEST__', href));
}

const PAGE_INDEX = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sea Tracker</title>
<style>
  :root{--navy:#0a1a26;--navy2:#0e2636;--line:#1d3a4d;--amber:#f5a623;--amber2:#ffc25a;
    --cyan:#39c0d3;--ink:#e8f1f6;--dim:#8fb0c2}
  *{box-sizing:border-box}
  body{margin:0;background:var(--navy);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:520px;margin:0 auto;padding:40px 16px}
  h1{font-size:22px;margin:0 0 4px}h1 b{color:var(--amber)}
  .sub{color:var(--dim);font-size:13px;margin-bottom:22px;line-height:1.5}
  .card{background:var(--navy2);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
  label{display:block;font-size:12px;color:var(--dim);margin-bottom:6px}
  input{width:100%;background:var(--navy);border:1px solid var(--line);color:var(--ink);
    border-radius:9px;padding:12px;font-size:15px}
  .btn{width:100%;margin-top:14px;border:0;border-radius:11px;padding:14px;font-size:15px;font-weight:700;
    background:var(--amber);color:#08151d;cursor:pointer}
  .btn:active{transform:scale(.98)}
  .out{display:none;margin-top:6px}
  .lk{font-size:12px;color:var(--cyan);word-break:break-all;background:var(--navy);
    border:1px solid var(--line);border-radius:8px;padding:10px;margin:6px 0}
  .k{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--amber2);margin-top:10px}
  .mini{background:var(--navy);border:1px solid var(--line);color:var(--ink);border-radius:8px;
    padding:8px 11px;font-size:12px;font-weight:600;cursor:pointer;margin-right:6px}
  .warn{font-size:11.5px;color:var(--dim);line-height:1.5;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Sea <b>Tracker</b></h1>
  <p class="sub">Diffuse ta position en direct depuis le bord. Crée une navigation, garde le lien skipper pour toi, partage le lien suiveurs.</p>
  <div class="card">
    <label>Nom de la navigation</label>
    <input id="name" type="text" placeholder="Route du Rhum 2026" value="Navigation">
    <button class="btn" id="create">Créer la navigation</button>
    <div class="out" id="out">
      <div class="k">Lien skipper (émission — garde-le privé)</div>
      <div class="lk" id="pLink"></div>
      <button class="mini" id="cpP">Copier</button><button class="mini" id="opP">Ouvrir</button>
      <div class="k">Lien suiveurs (à partager)</div>
      <div class="lk" id="vLink"></div>
      <button class="mini" id="cpV">Copier</button><button class="mini" id="opV">Ouvrir</button>
      <p class="warn">Note bien le lien skipper : il porte ta clé de publication et ne peut pas être régénéré.</p>
    </div>
  </div>
  <div class="card">
    <label>Ou crée une flotte (course / groupe)</label>
    <input id="fname" type="text" placeholder="Entraînement Class40" value="Flotte">
    <button class="btn" id="createFleet">Créer la flotte</button>
    <div class="out" id="fout">
      <div class="k">Lien suiveurs de la flotte (à partager)</div>
      <div class="lk" id="fLink"></div>
      <button class="mini" id="cpF">Copier</button><button class="mini" id="opF">Ouvrir</button>
      <div class="k">Lien d'invitation skipper (chaque bateau l'ouvre pour rejoindre)</div>
      <div class="lk" id="jLink"></div>
      <button class="mini" id="cpJ">Copier</button>
      <p class="warn">Chaque skipper ouvre le lien d'invitation, entre son nom de bateau, et reçoit son propre lien d'émission privé.</p>
    </div>
  </div>
</div>
<script>
"use strict";
function cp(t){if(navigator.clipboard)navigator.clipboard.writeText(t);}
document.getElementById('create').onclick=function(){
  var name=document.getElementById('name').value||'Navigation';
  fetch('/api/tracks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
  .then(function(r){return r.json();}).then(function(d){
    var p=location.origin+'/p?id='+d.id+'&key='+d.publishKey;
    var v=location.origin+'/v?id='+d.id;
    document.getElementById('pLink').textContent=p;
    document.getElementById('vLink').textContent=v;
    document.getElementById('out').style.display='block';
    document.getElementById('cpP').onclick=function(){cp(p);};
    document.getElementById('opP').onclick=function(){location.href=p;};
    document.getElementById('cpV').onclick=function(){cp(v);};
    document.getElementById('opV').onclick=function(){window.open(v,'_blank');};
  }).catch(function(){alert('Erreur de création');});
};
document.getElementById('createFleet').onclick=function(){
  var name=document.getElementById('fname').value||'Flotte';
  fetch('/api/fleets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
  .then(function(r){return r.json();}).then(function(d){
    var vf=location.origin+'/vf?id='+d.id;
    var jn=location.origin+'/join?fleet='+d.id;
    document.getElementById('fLink').textContent=vf;
    document.getElementById('jLink').textContent=jn;
    document.getElementById('fout').style.display='block';
    document.getElementById('cpF').onclick=function(){cp(vf);};
    document.getElementById('opF').onclick=function(){window.open(vf,'_blank');};
    document.getElementById('cpJ').onclick=function(){cp(jn);};
  }).catch(function(){alert('Erreur de création flotte');});
};
</script>
<div style="max-width:560px;margin:6px auto 30px;text-align:center">
  <a href="/admin" style="display:inline-block;color:#39c0d3;text-decoration:none;font-size:14px;font-weight:600;
     border:1px solid #1d3a4d;border-radius:10px;padding:11px 18px">⚓️ Console des flottes</a>
  <div style="color:#8fb0c2;font-size:12px;margin-top:8px">Retrouver, suivre et gérer toutes tes flottes existantes.</div>
</div>
</body>
</html>
`;
const PAGE_VIEWER = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Suivi en direct</title>
<link rel="stylesheet" href="/vendor/leaflet.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.css">
<style>
  :root{--navy:#0a1a26;--navy2:#0e2636;--panel:rgba(10,26,38,.92);--line:#1d3a4d;
    --amber:#f5a623;--amber2:#ffc25a;--cyan:#39c0d3;--ink:#e8f1f6;--dim:#8fb0c2;--green:#37c871;--red:#e6584c}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;margin:0;overscroll-behavior:none;background:var(--navy);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  #map{position:fixed;inset:0;background:#0a1a26}
  .mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
  .top{position:fixed;top:0;left:0;right:0;z-index:1000;display:flex;align-items:center;gap:10px;
    padding:calc(env(safe-area-inset-top) + 8px) 12px 8px;background:linear-gradient(180deg,var(--navy) 35%,transparent)}
  .name{font-weight:700;font-size:15px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--dim);flex:0 0 auto}
  .dot.live{background:var(--green);box-shadow:0 0 0 0 rgba(55,200,113,.6);animation:pulse 1.8s infinite}
  .dot.stale{background:var(--amber)}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(55,200,113,.55)}70%{box-shadow:0 0 0 9px rgba(55,200,113,0)}100%{box-shadow:0 0 0 0 rgba(55,200,113,0)}}
  .age{font-size:11px;color:var(--dim);margin-left:auto}
  .sheet{position:fixed;left:0;right:0;bottom:0;z-index:1000;background:var(--panel);backdrop-filter:blur(10px);
    border-top:1px solid var(--line);border-radius:16px 16px 0 0;padding:12px 14px calc(env(safe-area-inset-bottom) + 14px);
    box-shadow:0 -8px 30px rgba(0,0,0,.5)}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .r .k{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}
  .r .v{font-size:17px;font-weight:700}
  .r .v.big{color:var(--amber2)}
  .foot{display:flex;gap:10px;align-items:center;margin-top:10px}
  .chip{background:var(--navy2);color:var(--ink);border:1px solid var(--line);border-radius:8px;
    padding:8px 11px;font-size:12.5px;font-weight:600;cursor:pointer;touch-action:manipulation}
  .chip.on{border-color:var(--amber);color:var(--amber2)}
  .chip:active{transform:scale(.96)}
  .msg{margin-left:auto;font-size:11.5px;color:var(--dim)}
  .boat-rot{transition:transform .4s linear;transform-origin:50% 50%}
  .leaflet-container{background:#0a1a26}
  .leaflet-top.leaflet-left{margin-top:calc(env(safe-area-inset-top) + 58px)}
  .lyrbtn{position:fixed;top:calc(env(safe-area-inset-top) + 8px);right:8px;z-index:1500;
    width:46px;height:46px;border-radius:12px;background:rgba(14,38,54,.94);backdrop-filter:blur(8px);
    border:1px solid var(--line);color:var(--ink);font-size:19px;line-height:1;cursor:pointer;
    display:flex;align-items:center;justify-content:center;padding:0}
  .lyrbtn:active{transform:scale(.95)}
  .lyrpanel{position:fixed;top:calc(env(safe-area-inset-top) + 60px);right:8px;z-index:1500;
    background:rgba(14,38,54,.96);backdrop-filter:blur(10px);border:1px solid var(--line);
    border-radius:12px;padding:10px 13px;max-height:68vh;overflow:auto;min-width:212px;max-width:78vw;display:none}
  .lyrpanel.open{display:block}
  .lyrpanel .grp{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:8px 0 3px}
  .lyrpanel .grp:first-child{margin-top:0}
  .lyrpanel label{display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13.5px;cursor:pointer}
  .lyrpanel input{width:17px;height:17px;accent-color:#f5a623;flex:0 0 auto}
  .leaflet-bottom.leaflet-right{margin-bottom:env(safe-area-inset-bottom)}
  .leaflet-control-attribution{font-size:9px;line-height:1.5;background:rgba(10,26,38,.62);color:#8fb0c2;
    padding:1px 7px;margin:0!important;border-radius:8px 0 0 0;max-width:58vw;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;cursor:pointer}
  .leaflet-control-attribution.exp{white-space:normal;max-width:94vw}
  .leaflet-control-attribution a{color:#39c0d3}
  .center{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:1500;
    color:var(--dim);font-size:14px;text-align:center;padding:24px;pointer-events:none}
</style>
</head>
<body>
<div id="map"></div>
<div class="top">
  <span class="dot" id="dot"></span>
  <span class="name" id="name">Suivi en direct</span>
  <span class="age mono" id="age"></span>
</div>
<div class="center" id="waitMsg">Connexion au suivi…</div>
<div class="sheet">
  <div class="grid mono">
    <div class="r"><div class="k">Vitesse</div><div class="v big" id="vSog">— kt</div></div>
    <div class="r"><div class="k">Cap</div><div class="v" id="vCog">—°</div></div>
    <div class="r"><div class="k">Distance</div><div class="v" id="vDist">— NM</div></div>
    <div class="r"><div class="k">Points</div><div class="v" id="vPts">0</div></div>
  </div>
  <div class="foot">
    <button class="chip on" id="follow">⌖ Suivre</button>
    <button class="chip" id="fit">Voir la trace</button>
    <button class="chip" id="meteo">🌬 Météo</button>
    <button class="chip" id="fcBtn">📈 Prévisions</button>
    <a class="chip" id="expGpx" href="#" download>⤓ GPX</a>
    <a class="chip" id="expCsv" href="#" download>CSV</a>
    <span class="msg mono" id="pos">—</span>
  </div>
</div>

<div id="windyOverlay" style="position:fixed;inset:0;z-index:2000;background:var(--navy);display:none;flex-direction:column">
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:calc(env(safe-area-inset-top) + 8px) 12px 8px">
    <span style="font-weight:700">Météo (ECMWF, nœuds)</span>
    <select id="wLayer" class="chip"></select>
    <a id="windyFull" class="chip" style="margin-left:auto;text-decoration:none" href="#">⤢</a>
    <button id="windyClose" class="chip">✕</button>
  </div>
  <iframe id="windyFrame" title="Windy" style="flex:1;border:0;width:100%"></iframe>
</div>

<div id="windCtl" style="position:fixed;left:10px;z-index:1200;display:none;background:var(--panel);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:10px;padding:8px 10px;bottom:calc(env(safe-area-inset-bottom) + 200px)">
  <div style="font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:5px">Vent — modèle (précision) & échéance</div>
  <select id="windModel" class="chip" style="margin-right:6px"></select>
  <select id="windHour" class="chip"></select>
</div>

<div id="fcSheet" class="sheet" style="display:none;z-index:1400;max-height:72vh;overflow:auto">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
    <span style="font-weight:700">Prévisions au bateau</span>
    <select id="fcModel" class="chip" style="margin-left:auto;max-width:52vw"></select>
    <button id="fcClose" class="chip">✕</button>
  </div>
  <div id="fcBody" style="font-size:12px;color:var(--dim)">Chargement…</div>
</div>

<script src="/config.js"></script>
<script src="/windy.js"></script>
<script src="/vendor/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.js"></script>
<script src="/carte.js"></script>
<script>
"use strict";
var id = new URL(location.href).searchParams.get('id');
(function(){var g=document.getElementById('expGpx'),c=document.getElementById('expCsv');if(g)g.href='/api/tracks/'+id+'/export?format=gpx';if(c)c.href='/api/tracks/'+id+'/export?format=csv';})();
var API = ''; // même origine
var D2R=Math.PI/180,R2D=180/Math.PI,R=6371000;
function angDist(a,b){var p1=a.lat*D2R,p2=b.lat*D2R,dp=(b.lat-a.lat)*D2R,dl=(b.lon-a.lon)*D2R;
  var s=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return 2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));}
function distM(a,b){return angDist(a,b)*R;}
function bearing(a,b){var p1=a.lat*D2R,p2=b.lat*D2R,dl=(b.lon-a.lon)*D2R;
  var y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (Math.atan2(y,x)*R2D+360)%360;}
function gcInterp(a,b,f){var d=angDist(a,b);if(d<1e-9)return{lat:a.lat,lon:a.lon};
  var A=Math.sin((1-f)*d)/Math.sin(d),B=Math.sin(f*d)/Math.sin(d);
  var p1=a.lat*D2R,l1=a.lon*D2R,p2=b.lat*D2R,l2=b.lon*D2R;
  var x=A*Math.cos(p1)*Math.cos(l1)+B*Math.cos(p2)*Math.cos(l2);
  var y=A*Math.cos(p1)*Math.sin(l1)+B*Math.cos(p2)*Math.sin(l2);
  var z=A*Math.sin(p1)+B*Math.sin(p2);
  return{lat:Math.atan2(z,Math.sqrt(x*x+y*y))*R2D,lon:Math.atan2(y,x)*R2D};}

var map=L.map('map',{zoomControl:true,worldCopyJump:true,maxZoom:18}).setView([46,-20],4);
map.createPane('windPane');map.getPane('windPane').style.zIndex=550;map.getPane('windPane').style.pointerEvents='none';
/* Plan dedie aux calques meteo : le fond « carte marine » est rendu par
   MapLibre en WebGL, qui se dessine PAR-DESSUS le plan de tuiles standard.
   Les calques OpenWeather y etaient donc invisibles malgre des tuiles
   correctement recues (bug corrige le 31/07/2026). */
map.createPane('meteoPane');map.getPane('meteoPane').style.zIndex=450;map.getPane('meteoPane').style.pointerEvents='none';

installAttrib(map);

// Fonds de carte
var esriOcean=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:13,maxZoom:18,attribution:'Fond océan &copy; Esri'});
var esriOceanRef=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:13,maxZoom:18});
var esriSat=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:18,maxZoom:18,attribution:'Imagerie &copy; Esri'});
var osm=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap'});
var shomBalise=L.tileLayer('https://services.data.shom.fr/INSPIRE/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=BALISAGE_PYR_PNG_3857_WMTS&STYLE=normal&TILEMATRIXSET=3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',{maxNativeZoom:17,maxZoom:18,attribution:'Balisage &copy; SHOM'});
esriOcean.addTo(map); esriOceanRef.addTo(map);
// libellés océan seulement sur le fond Océan
map.on('baselayerchange',function(e){
  if(e.layer===esriOcean){ if(!map.hasLayer(esriOceanRef)) esriOceanRef.addTo(map); }
  else if(map.hasLayer(esriOceanRef)){ map.removeLayer(esriOceanRef); }
});
// Bathymétrie EMODnet (profondeurs) + balises
var emodnet=L.tileLayer('https://tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator/{z}/{x}/{y}.png',
  {maxNativeZoom:11,maxZoom:18,attribution:'Bathymétrie &copy; EMODnet'});
var seamark=L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',{maxZoom:18,opacity:.9,attribution:'Balisage &copy; OpenSeaMap'}).addTo(map);

// --- calques météo superposés (sous le bateau et la trace) ---
// OpenWeather ne produit des tuiles que jusqu'au zoom 12. Avec maxZoom:12,
// Leaflet MASQUAIT le calque au-dela — invisible des qu'on zoomait en cotier,
// sans aucun message. maxNativeZoom conserve la derniere tuile et l'agrandit.
/* Calques meteo OpenWeather.
   ATTENTION (correctif du 31/07/2026) : ces calques etaient crees uniquement
   si window.OWM_KEY etait deja definie. Or /config.js, qui porte la cle, est
   un script EXTERNE : selon l'ordre d'execution du navigateur, la cle pouvait
   ne pas encore exister — les calques n'etaient alors jamais construits, et
   les cases du menu ne commandaient rien. Desormais les couches sont toujours
   creees et la cle est lue au moment de composer chaque tuile. */
var weather={};
(function(){
  /* La cle est passee en OPTION : Leaflet substitue lui-meme {cle} depuis
     l'objet d'options. Le 31/07/2026, une substitution maison apres coup
     echouait — Leaflet valide le modele d'URL avant, et refusait la variable
     inconnue ({cle} : « No value provided for variable »), d'ou zero tuile.
     L'option est relue a chaque rafraichissement : si /config.js arrive en
     retard, un simple recochage suffit. */
  /* opacite par calque : « Vent » (wind_new) est une nappe tres pale, presque
     invisible par petit temps ; les quatre autres restent a 0,55. */
  var owm=function(couche,opac){
    return L.tileLayer('https://tile.openweathermap.org/map/'+couche+'/{z}/{x}/{y}.png?appid={cle}',
      {cle:(window.OWM_KEY||''),opacity:(opac||0.55),maxNativeZoom:12,maxZoom:18,pane:'meteoPane',
       attribution:'Météo &copy; OpenWeather'});
  };
  weather['Vent']=L.layerGroup([owm('wind_new',0.55),creerVentFleches(map)]); weather['Pression']=owm('pressure_new');
  weather['Nuages']=owm('clouds_new'); weather['Pluie']=owm('precipitation_new');
  weather['Température']=owm('temp_new');
})();
var bases={};
try{ if(L.maplibreGL && window.maplibregl) bases['Carte marine (isobathes/sondes)']=L.maplibreGL({style:'https://tiles.openwaters.io/seascape/style.json',attribution:'Fonds &copy; openwaters.io (CC BY 4.0)'}); }catch(e){}
bases['Océan (Esri)']=esriOcean;
bases['Bathymétrie (EMODnet)']=emodnet;
bases['Satellite']=esriSat;
bases['OpenStreetMap']=osm;
var windGroup=L.layerGroup();
var overlays=Object.assign({'Balises (OpenSeaMap)':seamark,'Balises SHOM':shomBalise,'Relief fonds Litto3D (Shom)':creerLitto3D(),'Flèches de courant (Shom)':creerCourantsLayer(map),'Vent animé (Open‑Meteo)':windGroup},weather);
/* ---- menu des calques (maison : ouverture au tap, indépendant de Leaflet) ---- */
var layerCtl = installLayerMenu(map, bases, overlays);
assurerCarteMarine(map, layerCtl, bases);
// Vent animé (particules) via leaflet-velocity + Open-Meteo
fillSel(document.getElementById('windModel'),MODELS,'best_match');
fillSel(document.getElementById('windHour'),HOURS,0);
fillSel(document.getElementById('fcModel'),MODELS,'best_match');

initVent(map, windGroup);

function loadForecast(){
  var body=document.getElementById('fcBody');
  var last=pts.length?pts[pts.length-1]:null,lat,lon;
  if(last){lat=last[0];lon=last[1];}else{var c=map.getCenter();lat=c.lat;lon=c.lng;}
  var model=document.getElementById('fcModel').value;
  body.textContent='Chargement…';
  fetch('/api/forecast?lat='+lat.toFixed(3)+'&lon='+lon.toFixed(3)+'&model='+encodeURIComponent(model))
   .then(function(r){return r.json();}).then(function(d){
     var h=d.hourly; if(!h||!h.time){body.textContent='Prévision indisponible pour ce modèle sur cette zone.';return;}
     var html='<table style="width:100%;border-collapse:collapse" class="mono">';
     html+='<tr style="color:#8fb0c2;font-size:10px;text-align:left"><th>Heure</th><th>Vent</th><th>Raf.</th><th>Dir</th><th>Press.</th><th>Nua.</th></tr>';
     var curDay='';
     for(var i=0;i<h.time.length;i+=3){
       var dt=new Date(h.time[i]);
       var day=dt.toLocaleDateString('fr-FR',{weekday:'short',day:'2-digit',month:'2-digit'});
       if(day!==curDay){curDay=day;html+='<tr><td colspan="6" style="padding-top:8px;color:#ffc25a;font-weight:700;font-size:11px">'+day+'</td></tr>';}
       var w=h.wind_speed_10m&&h.wind_speed_10m[i]!=null?Math.round(h.wind_speed_10m[i]):'—';
       var g=h.wind_gusts_10m&&h.wind_gusts_10m[i]!=null?Math.round(h.wind_gusts_10m[i]):'—';
       var dr=h.wind_direction_10m?h.wind_direction_10m[i]:null;
       var pr=h.pressure_msl&&h.pressure_msl[i]!=null?Math.round(h.pressure_msl[i]):'—';
       var cl=h.cloud_cover&&h.cloud_cover[i]!=null?h.cloud_cover[i]:'—';
       var hh=dt.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
       html+='<tr style="border-top:1px solid #12303f"><td style="padding:3px 0;color:#e8f1f6">'+hh+'</td><td style="color:#ffc25a;font-weight:700">'+w+' kt</td><td style="color:#e8f1f6">'+g+'</td><td style="color:#e8f1f6">'+dirArrow(dr)+' '+(dr!=null?Math.round(dr):'—')+'°</td><td style="color:#e8f1f6">'+pr+'</td><td style="color:#e8f1f6">'+cl+'%</td></tr>';
     }
     html+='</table>';
     body.innerHTML=html;
   }).catch(function(){body.textContent='Erreur de chargement.';});
}
document.getElementById('fcBtn').onclick=function(){document.getElementById('fcSheet').style.display='block';loadForecast();};
document.getElementById('fcClose').onclick=function(){document.getElementById('fcSheet').style.display='none';};
document.getElementById('fcModel').onchange=loadForecast;

// Pointeur : clic sur la carte -> bulle vent / pression / courant
map.on('click', function(e){
  var ll=e.latlng;
  var pop=L.popup({maxWidth:230}).setLatLng(ll).setContent('Chargement…').openOn(map);
  function dtxt(deg){return deg==null?'—':(dirArrow(deg)+' '+Math.round(deg)+'°');}
  /* deux requetes paralleles (meteo + fond Litto3D) alimentent un rendu
     unique : quel que soit l'ordre d'arrivee, rien ne s'ecrase. */
  var meteoHtml=null, fondHtml='', mareeHtml='';
  function rendre(){
    if(meteoHtml===null)return;
    pop.setContent('<div style="font-size:12px;line-height:1.6">'+meteoHtml+mareeHtml+fondHtml+'</div>');
  }
  fetch('/api/fond?lat='+ll.lat.toFixed(5)+'&lon='+ll.lng.toFixed(5)).then(function(r){return r.json();}).then(function(f){
    if(f&&f.fond!=null){
      fondHtml='<br>\u26F0 Fond '+(f.source||'')+' : '+f.fond.toFixed(1).replace('.',',')+' m <span style="opacity:.65">('+(f.ref||'')+')</span>';
      if(f.sondeApprox!=null)fondHtml+='<br><span style="opacity:.8">\u2248 sonde carte '+f.sondeApprox.toFixed(1).replace('.',',')+' m (\u00b10,5 m)</span>';
      rendre();
    }
  }).catch(function(){});
  fetch('/api/courant?lat='+ll.lat.toFixed(5)+'&lon='+ll.lng.toFixed(5)).then(function(r){return r.json();}).then(function(c){
    if(c&&c.courant&&c.maree){
      var m2=c.maree, cr=c.courant;
      var signe=m2.h>=0?'+':'\u2212';
      mareeHtml='<br>\ud83c\udf00 Mar\u00e9e : '+cr.vitesse.toFixed(1).replace('.',',')+' kt '+dirArrow(cr.dir)+' '+cr.dir+'\u00b0'
        +'<br><span style="opacity:.8">'+m2.evenement+' '+esc(m2.port)+' '+signe+Math.abs(m2.h).toFixed(1).replace('.',',')+' h \u00b7 coef '+m2.coef+' \u00b7 atlas Shom</span>';
      rendre();
    }
  }).catch(function(){});
  fetch('/api/point?lat='+ll.lat.toFixed(3)+'&lon='+ll.lng.toFixed(3)).then(function(r){return r.json();}).then(function(d){
    meteoHtml='<b>'+fmtCoord(ll.lat,ll.lng)+'</b><br>'
      +'💨 Vent : '+(d.wind!=null?Math.round(d.wind)+' kt '+dtxt(d.windDir):'—')+'<br>'
      +'🔽 Pression : '+(d.pressure!=null?Math.round(d.pressure)+' hPa':'—')+'<br>'
      +'🌊 Courant : '+(d.curSpeed!=null?d.curSpeed.toFixed(1)+' kt '+dtxt(d.curDir):'—');
    rendre();
  }).catch(function(){pop.setContent('Erreur de chargement');});
});
// Radar pluie RainViewer (sans clé)
installRadar(layerCtl);

var trace=L.polyline([],{color:'#f5a623',weight:3.5,opacity:.95}).addTo(map);
var startMk=null;
var boatIcon=L.divIcon({className:'',iconSize:[34,34],iconAnchor:[17,17],
  html:'<div class="boat-rot"><svg width="34" height="34" viewBox="0 0 34 34">'
    +'<path d="M17 2 L24 26 L17 22 L10 26 Z" fill="#f5a623" stroke="#08151d" stroke-width="1.5" stroke-linejoin="round"/>'
    +'<circle cx="17" cy="18" r="2" fill="#08151d"/></svg></div>'});
var boat=null;
function setBoat(lat,lon,hdg){
  if(!boat){boat=L.marker([lat,lon],{icon:boatIcon,interactive:false,zIndexOffset:1000}).addTo(map);}
  boat.setLatLng([lat,lon]);
  var el=boat.getElement();if(el){var r=el.querySelector('.boat-rot');if(r)r.style.transform='rotate('+hdg+'deg)';}
}

var pts=[];            // [lat,lon,t,sog,cog]
var lastT=0, follow=true, drawn=null;
function llOf(p){return{lat:p[0],lon:p[1]};}
function totalNM(){var d=0;for(var i=1;i<pts.length;i++)d+=distM(llOf(pts[i-1]),llOf(pts[i]));return d/1852;}

/* animation douce entre deux positions reçues */
var anim=null;
function moveTo(target,hdg){
  if(!drawn){drawn=target;setBoat(target.lat,target.lon,hdg);return;}
  var from={lat:drawn.lat,lon:drawn.lon},t0=performance.now(),dur=1200;
  if(anim)cancelAnimationFrame(anim);
  (function step(now){
    var f=Math.min(1,(now-t0)/dur);
    var pp=gcInterp(from,target,f);setBoat(pp.lat,pp.lon,hdg);
    if(follow&&f>.05)map.panTo([pp.lat,pp.lon],{animate:true,duration:.3});
    drawn=pp;
    if(f<1)anim=requestAnimationFrame(step);else drawn=target;
  })(t0);
}

function fmtCoord(lat,lon){function c(v,pos,neg){var h=v>=0?pos:neg;v=Math.abs(v);var d=Math.floor(v);
  return d+'°'+((v-d)*60).toFixed(1)+"'"+h;}return c(lat,'N','S')+' '+c(lon,'E','O');}
function updateReadouts(){
  var last=pts[pts.length-1];if(!last)return;
  document.getElementById('vSog').textContent=(last[3]!=null?last[3].toFixed(1):'—')+' kt';
  document.getElementById('vCog').textContent=(last[4]!=null?last[4]:'—')+'°';
  document.getElementById('vDist').textContent=totalNM().toFixed(1)+' NM';
  document.getElementById('vPts').textContent=pts.length;
  document.getElementById('pos').textContent=fmtCoord(last[0],last[1]);
}
function refreshAge(){
  var last=pts[pts.length-1];var dot=document.getElementById('dot');
  if(!last){dot.className='dot';document.getElementById('age').textContent='';return;}
  var s=Math.round((Date.now()-last[2])/1000);
  var txt=s<60?('il y a '+s+' s'):s<3600?('il y a '+Math.round(s/60)+' min'):('il y a '+Math.floor(s/3600)+' h '+Math.round(s%3600/60)+' min');
  document.getElementById('age').textContent=txt;
  dot.className='dot '+(s<180?'live':s<3600?'stale':'');
}
setInterval(refreshAge,1000);

function addPoint(p,animate){
  pts.push(p);lastT=Math.max(lastT,p[2]);
  trace.setLatLngs(pts.map(function(x){return[x[0],x[1]];}));
  if(pts.length===1&&!startMk){startMk=L.circleMarker([p[0],p[1]],{radius:7,color:'#08151d',weight:2,fillColor:'#37c871',fillOpacity:1})
    .bindTooltip('Départ',{permanent:true,direction:'top',className:''}).addTo(map);}
  var hdg=p[4]!=null?p[4]:(pts.length>1?bearing(llOf(pts[pts.length-2]),llOf(p)):0);
  if(animate)moveTo({lat:p[0],lon:p[1]},hdg);else{setBoat(p[0],p[1],hdg);drawn={lat:p[0],lon:p[1]};}
  updateReadouts();refreshAge();
}

document.getElementById('follow').onclick=function(){follow=!follow;this.classList.toggle('on',follow);};
document.getElementById('fit').onclick=function(){
  if(pts.length){map.fitBounds(L.latLngBounds(pts.map(function(x){return[x[0],x[1]];})).pad(0.15));follow=false;document.getElementById('follow').classList.remove('on');}
};

var wLayer=document.getElementById('wLayer');
windyFillLayers(wLayer,'wind');
var wCenter=null;
function renderWindy(){ if(!wCenter)return;
  document.getElementById('windyFrame').src=windyUrl(wCenter.lat,wCenter.lon,wLayer.value,true); }
wLayer.onchange=renderWindy;
document.getElementById('meteo').onclick=function(){
  var last=pts.length?pts[pts.length-1]:null,lat,lon;
  if(last){lat=last[0];lon=last[1];}else{var c=map.getCenter();lat=c.lat;lon=c.lng;}
  wCenter={lat:(+lat).toFixed(3),lon:(+lon).toFixed(3)};
  renderWindy();
  document.getElementById('windyFull').href='/meteo?id='+encodeURIComponent(id);
  document.getElementById('windyOverlay').style.display='flex';
};
document.getElementById('windyClose').onclick=function(){
  document.getElementById('windyOverlay').style.display='none';
  document.getElementById('windyFrame').src='about:blank';
};

function fail(m){document.getElementById('waitMsg').textContent=m;}
if(!id){fail('Lien invalide : identifiant de suivi manquant.');}
else{
  fetch(API+'/api/tracks/'+id).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(d){
    document.getElementById('name').textContent=d.name||'Suivi en direct';document.title=d.name||'Suivi en direct';
    if(d.points&&d.points.length){
      d.points.forEach(function(p){addPoint(p,false);});
      map.setView([d.last[0],d.last[1]],7);
      document.getElementById('waitMsg').style.display='none';
    }else{document.getElementById('waitMsg').textContent='En attente de la première position…';}
    subscribe();
  }).catch(function(){fail('Suivi introuvable.');});
}
function subscribe(){
  var es=new EventSource(API+'/api/tracks/'+id+'/stream');
  es.onmessage=function(ev){try{var p=JSON.parse(ev.data);if(p[2]>lastT){document.getElementById('waitMsg').style.display='none';addPoint(p,true);}}catch(e){}};
  es.onerror=function(){/* EventSource se reconnecte tout seul */};
}
</script>
</body>
</html>
`;
const PAGE_PUBLISHER = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Émettre ma position</title>
<style>
  :root{--navy:#0a1a26;--navy2:#0e2636;--line:#1d3a4d;--amber:#f5a623;--amber2:#ffc25a;
    --cyan:#39c0d3;--ink:#e8f1f6;--dim:#8fb0c2;--green:#37c871;--red:#e6584c}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;min-height:100%;background:var(--navy);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
  .wrap{max-width:520px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 18px) 16px 40px}
  h1{font-size:17px;margin:0 0 2px}h1 b{color:var(--amber)}
  .sub{font-size:12px;color:var(--dim);margin-bottom:16px}
  .card{background:var(--navy2);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
  .big{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .state{width:14px;height:14px;border-radius:50%;background:var(--dim)}
  .state.on{background:var(--green);box-shadow:0 0 0 0 rgba(55,200,113,.6);animation:pulse 1.8s infinite}
  .state.err{background:var(--red)}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(55,200,113,.55)}70%{box-shadow:0 0 0 10px rgba(55,200,113,0)}100%{box-shadow:0 0 0 0 rgba(55,200,113,0)}}
  .stateT{font-weight:700;font-size:15px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}
  .k{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}
  .v{font-size:16px;font-weight:700}
  .v.amber{color:var(--amber2)}
  .field{display:flex;align-items:center;gap:10px;margin:10px 0}
  .field label{font-size:12.5px;color:var(--dim);flex:1}
  select{background:var(--navy);color:var(--ink);border:1px solid var(--line);border-radius:8px;
    padding:9px;font-size:14px;font-weight:600}
  .btn{width:100%;border:0;border-radius:11px;padding:15px;font-size:15px;font-weight:700;cursor:pointer;touch-action:manipulation}
  .btn.go{background:var(--amber);color:#08151d}
  .btn.stop{background:transparent;border:1px solid var(--red);color:var(--red)}
  .btn:active{transform:scale(.98)}
  .link{font-size:11px;color:var(--cyan);word-break:break-all;background:var(--navy);
    border:1px solid var(--line);border-radius:8px;padding:9px;margin-top:8px}
  .row{display:flex;gap:8px;margin-top:8px}
  .mini{flex:1;background:var(--navy);border:1px solid var(--line);color:var(--ink);
    border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer}
  .warn{font-size:11.5px;color:var(--dim);line-height:1.5;margin-top:8px}
  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--amber);
    color:#08151d;font-weight:700;font-size:13px;padding:9px 15px;border-radius:20px;opacity:0;transition:.2s;pointer-events:none}
  .toast.show{opacity:1}
</style>
</head>
<body>
<div class="wrap">
  <h1>Émission <b>skipper</b></h1>
  <div class="sub" id="trackName">—</div>

  <div class="card">
    <div class="big"><span class="state" id="state"></span><span class="stateT" id="stateT">Arrêté</span></div>
    <div class="grid mono">
      <div><div class="k">Vitesse</div><div class="v amber" id="sog">— kt</div></div>
      <div><div class="k">Cap</div><div class="v" id="cog">—°</div></div>
      <div><div class="k">Envoyés</div><div class="v" id="sent">0</div></div>
      <div><div class="k">En file</div><div class="v" id="queued">0</div></div>
    </div>
    <div class="mono" style="font-size:12px;color:var(--dim);margin-top:6px" id="pos">—</div>
    <div class="mono" style="font-size:11px;color:var(--dim);margin-top:2px" id="lastSent"></div>
  </div>

  <div class="card">
    <div class="field"><label>Intervalle d’envoi (économie de bande passante)</label>
      <select id="interval">
        <option value="15">15 s</option>
        <option value="30">30 s</option>
        <option value="60" selected>1 min</option>
        <option value="120">2 min</option>
        <option value="300">5 min</option>
        <option value="600">10 min</option>
      </select>
    </div>
    <button class="btn go" id="startBtn">Démarrer l’émission</button>
    <button class="btn stop" id="stopBtn" style="display:none">Arrêter</button>
    <p class="warn">Garde cette page ouverte à l’écran (le verrouillage d’écran est maintenu automatiquement). Hors couverture, les positions sont mises en file et renvoyées dès le retour du réseau.</p>
  </div>

  <div class="card">
    <div class="k">Lien à partager aux suiveurs</div>
    <div class="link" id="viewerLink">—</div>
    <div class="row">
      <button class="mini" id="copyView">Copier le lien suiveurs</button>
      <button class="mini" id="openView">Ouvrir la vue</button>
    </div>
    <p class="warn">Ce lien ne contient <b>pas</b> ta clé de publication : les suiveurs voient la trace, ils ne peuvent pas émettre.</p>
  </div>

  <div class="card">
    <div class="k">Émettre sans garder la page ouverte (app Traccar Client)</div>
    <p class="warn" style="margin-top:2px">Installe <b>Traccar Client</b> (gratuit, App Store). Elle émet en arrière‑plan, écran éteint. Renseigne :</p>
    <div class="k" style="margin-top:6px">URL du serveur</div>
    <div class="link" id="traccarUrl">—</div>
    <div class="k" style="margin-top:6px">Identifiant de l’appareil</div>
    <div class="link" id="traccarId">—</div>
    <div class="row">
      <button class="mini" id="copyTUrl">Copier l’URL</button>
      <button class="mini" id="copyTId">Copier l’identifiant</button>
    </div>
    <p class="warn">Dans Traccar Client : active le service, choisis un intervalle. Hors couverture réseau (grand large), aucune app cellulaire n’émet — il faut un traceur satellite.</p>
  </div>

  <div class="card" id="fleetCard" style="display:none">
    <div class="k">Flotte</div>
    <p class="warn" style="margin-top:2px">Ton bateau fait partie d’une flotte : il apparaît sur la carte commune.</p>
    <button class="mini" id="leave" style="border-color:#46242a;color:#e6584c">Me retirer de la flotte</button>
    <p class="warn" id="leaveMsg"></p>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
"use strict";
var q=new URL(location.href).searchParams;
var id=q.get('id'), key=q.get('key');
var viewerUrl=location.origin+'/v?id='+id;
document.getElementById('viewerLink').textContent=viewerUrl;
var traccarUrl=location.origin+'/api/osmand';
document.getElementById('traccarUrl').textContent=traccarUrl;
document.getElementById('traccarId').textContent=key||'—';

var D2R=Math.PI/180,R2D=180/Math.PI,R=6371000;
function bearing(a,b){var p1=a.lat*D2R,p2=b.lat*D2R,dl=(b.lon-a.lon)*D2R;
  var y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (Math.atan2(y,x)*R2D+360)%360;}
function distM(a,b){var p1=a.lat*D2R,p2=b.lat*D2R,dp=(b.lat-a.lat)*D2R,dl=(b.lon-a.lon)*D2R;
  var s=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return 2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s))*R;}

var QKEY='seatrk_queue_'+id;
function loadQueue(){try{return JSON.parse(localStorage.getItem(QKEY)||'[]');}catch(e){return[];}}
function saveQueue(a){try{localStorage.setItem(QKEY,JSON.stringify(a));}catch(e){}}
var queue=loadQueue();
var sentCount=0, latest=null, prev=null, watchId=null, timer=null, wakeLock=null, running=false;

function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');
  clearTimeout(toast._t);toast._t=setTimeout(function(){t.classList.remove('show');},1800);}
function setState(cls,txt){document.getElementById('state').className='state '+cls;document.getElementById('stateT').textContent=txt;}
function refresh(){
  document.getElementById('sent').textContent=sentCount;
  document.getElementById('queued').textContent=queue.length;
  if(latest){
    document.getElementById('sog').textContent=(latest.sog!=null?latest.sog.toFixed(1):'—')+' kt';
    document.getElementById('cog').textContent=(latest.cog!=null?Math.round(latest.cog):'—')+'°';
    document.getElementById('pos').textContent=latest.lat.toFixed(5)+', '+latest.lon.toFixed(5);
  }
}

if(!id||!key){setState('err','Lien de publication incomplet');document.getElementById('startBtn').disabled=true;}
fetch('/api/tracks/'+id).then(function(r){return r.json();}).then(function(d){
  document.getElementById('trackName').textContent=d.name||'Navigation';
  sentCount=d.count||0;refresh();
}).catch(function(){});

function onFix(p){
  var c=p.coords, now=Date.now();
  var pt={lat:c.latitude,lon:c.longitude,t:now,
    sog:(c.speed!=null&&isFinite(c.speed))?c.speed/0.514444:null,
    cog:(c.heading!=null&&isFinite(c.heading))?c.heading:(prev?bearing(prev,{lat:c.latitude,lon:c.longitude}):null)};
  prev={lat:pt.lat,lon:pt.lon};latest=pt;refresh();
}
function enqueueLatest(){
  if(!latest)return;
  queue.push(latest);saveQueue(queue);latest=null;refresh();flush();
}
function flush(){
  if(!queue.length||flush._busy)return;flush._busy=true;
  var batch=queue.slice(0,50);
  fetch('/api/tracks/'+id+'/positions',{method:'POST',
    headers:{'Content-Type':'application/json','x-publish-key':key},
    body:JSON.stringify({points:batch})})
  .then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json();})
  .then(function(res){
    queue.splice(0,batch.length);saveQueue(queue);
    sentCount=res.count;document.getElementById('lastSent').textContent='Dernier envoi : '+new Date().toLocaleTimeString('fr-FR');
    setState('on','En émission');refresh();flush._busy=false;
    if(queue.length)flush();
  })
  .catch(function(){setState(running?'':'err','Hors couverture — en file');flush._busy=false;});
}
window.addEventListener('online',flush);

async function requestWake(){try{if('wakeLock'in navigator){wakeLock=await navigator.wakeLock.request('screen');}}catch(e){}}
document.addEventListener('visibilitychange',function(){if(running&&document.visibilityState==='visible')requestWake();});

document.getElementById('startBtn').onclick=function(){
  if(!navigator.geolocation){toast('Géolocalisation indisponible');return;}
  running=true;setState('on','Acquisition…');
  document.getElementById('startBtn').style.display='none';
  document.getElementById('stopBtn').style.display='block';
  requestWake();
  watchId=navigator.geolocation.watchPosition(onFix,function(e){
    setState('err',e.code===1?'Autorisation refusée':'Signal GPS faible');},
    {enableHighAccuracy:true,maximumAge:2000,timeout:20000});
  var iv=parseInt(document.getElementById('interval').value,10)*1000;
  timer=setInterval(enqueueLatest,iv);
  enqueueLatest();
};
document.getElementById('stopBtn').onclick=function(){
  running=false;
  if(watchId!=null)navigator.geolocation.clearWatch(watchId);watchId=null;
  if(timer)clearInterval(timer);timer=null;
  if(wakeLock){wakeLock.release();wakeLock=null;}
  setState('','Arrêté');
  document.getElementById('startBtn').style.display='block';
  document.getElementById('stopBtn').style.display='none';
};
document.getElementById('interval').onchange=function(){
  if(running){clearInterval(timer);timer=setInterval(enqueueLatest,parseInt(this.value,10)*1000);}
};
document.getElementById('copyView').onclick=function(){
  if(navigator.clipboard)navigator.clipboard.writeText(viewerUrl).then(function(){toast('Lien copié');});
  else toast('Copie manuelle');
};
document.getElementById('openView').onclick=function(){window.open(viewerUrl,'_blank');};
document.getElementById('copyTUrl').onclick=function(){
  if(navigator.clipboard)navigator.clipboard.writeText(traccarUrl).then(function(){toast('URL copiée');});
  else toast('Copie manuelle');
};
fetch('/api/tracks/'+id).then(function(r){return r.json();}).then(function(d){
  if(d&&d.fleets>0)document.getElementById('fleetCard').style.display='block';
}).catch(function(){});
document.getElementById('leave').onclick=function(){
  if(!confirm('Te retirer de la flotte ?\\n\\nTon bateau n\\'apparaîtra plus sur la carte commune.'))return;
  var b=this;b.disabled=true;
  fetch('/api/tracks/'+id+'/leave',{method:'POST',headers:{'x-publish-key':key}})
   .then(function(r){return r.json();}).then(function(x){
     b.disabled=false;
     if(x.error){document.getElementById('leaveMsg').textContent=x.error;return;}
     document.getElementById('leaveMsg').textContent='Tu es retiré de la flotte.';
     b.style.display='none';
   }).catch(function(){b.disabled=false;document.getElementById('leaveMsg').textContent='Erreur réseau.';});
};
document.getElementById('copyTId').onclick=function(){
  if(navigator.clipboard)navigator.clipboard.writeText(key||'').then(function(){toast('Identifiant copié');});
  else toast('Copie manuelle');
};

refresh();
if(queue.length)flush();
</script>
</body>
</html>
`;
const PAGE_METEO = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Météo</title>
<style>
  :root{--navy:#0a1a26;--navy2:#0e2636;--line:#1d3a4d;--amber:#f5a623;--amber2:#ffc25a;--cyan:#39c0d3;--ink:#e8f1f6;--dim:#8fb0c2}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;margin:0;background:var(--navy);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column}
  .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:calc(env(safe-area-inset-top) + 8px) 12px 8px}
  .back{color:var(--cyan);text-decoration:none;font-weight:600;font-size:13px;white-space:nowrap}
  .name{font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}
  .age{font-size:11px;color:var(--dim);white-space:nowrap}
  .chip{background:var(--navy2);color:var(--ink);border:1px solid var(--line);border-radius:8px;
    padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer}
  .grow{margin-left:auto}
  iframe{flex:1;border:0;width:100%}
  .msg{position:absolute;top:52%;left:0;right:0;text-align:center;color:var(--dim);font-size:13px;padding:0 24px}
</style>
</head>
<body>
<div class="bar">
  <a class="back" id="back" href="#">← Suivi</a>
  <span class="name" id="name">Météo</span>
  <span class="age" id="age"></span>
  <select id="layer" class="chip grow"></select>
  <button class="chip" id="recenter">⌖ Bateau</button>
</div>
<iframe id="frame" title="Windy"></iframe>
<div class="msg" id="msg">Chargement…</div>

<script src="/windy.js"></script>
<script>
"use strict";
var id=new URL(location.href).searchParams.get('id');
document.getElementById('back').href='/v?id='+encodeURIComponent(id||'');
var layer=document.getElementById('layer');
windyFillLayers(layer,'wind');
var center=null, hasPos=false;
function ageTxt(t){var s=Math.round((Date.now()-t)/1000);
  return s<60?('il y a '+s+' s'):s<3600?('il y a '+Math.round(s/60)+' min'):('il y a '+Math.floor(s/3600)+' h');}
function render(){ if(!center)return;
  document.getElementById('frame').src=windyUrl(center.lat,center.lon,layer.value,hasPos); }
layer.onchange=render;
function load(){
  var msg=document.getElementById('msg');
  if(!id){msg.textContent='Lien invalide.';return;}
  fetch('/api/tracks/'+id).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(d){
    document.getElementById('name').textContent=d.name||'Météo';
    document.title='Météo — '+(d.name||'');
    if(d.last){
      msg.style.display='none';hasPos=true;
      document.getElementById('age').textContent='position '+ageTxt(d.last[2]);
      center={lat:d.last[0].toFixed(3),lon:d.last[1].toFixed(3)};
    }else{
      msg.textContent='En attente de la première position — météo centrée sur le golfe de Gascogne.';
      hasPos=false;center={lat:'47.5',lon:'-5.0'};
    }
    render();
  }).catch(function(){msg.textContent='Suivi introuvable.';});
}
document.getElementById('recenter').onclick=load;
load();
</script>
</body>
</html>
`;
const PAGE_WINDYJS = `"use strict";
/* Source unique pour l'intégration Windy (embed gratuit).
 * Le modèle reste ECMWF (l'embed ignore le paramètre de modèle) ;
 * seul le calque (overlay) est réellement sélectionnable. */
var WINDY_LAYERS = [
  { v: 'wind', t: 'Vent' },
  { v: 'gust', t: 'Rafales' },
  { v: 'waves', t: 'Vagues' },
  { v: 'swell1', t: 'Houle' },
  { v: 'pressure', t: 'Pression' },
  { v: 'clouds', t: 'Nuages' },
  { v: 'rain', t: 'Pluie' },
  { v: 'temp', t: 'Température' },
  { v: 'currents', t: 'Courants' },
  { v: 'satellite', t: 'Satellite' },
  { v: 'radar', t: 'Radar' }
];
function windyProduct(overlay) {
  return (overlay === 'waves' || overlay === 'swell1') ? 'ecmwfWaves' : 'ecmwf';
}
function windyUrl(lat, lon, overlay, marker) {
  overlay = overlay || 'wind';
  var p = new URLSearchParams({
    lat: lat, lon: lon, detailLat: lat, detailLon: lon, zoom: '7', level: 'surface',
    overlay: overlay, product: windyProduct(overlay), menu: '', message: 'true',
    marker: marker ? 'true' : '', calendar: 'now', pressure: '', type: 'map',
    location: 'coordinates', detail: 'true', metricWind: 'kt', metricTemp: '°C', radarRange: '-1'
  });
  return 'https://embed.windy.com/embed2.html?' + p.toString();
}
function windyFillLayers(sel, def) {
  WINDY_LAYERS.forEach(function (o) {
    var e = document.createElement('option');
    e.value = o.v; e.textContent = o.t;
    if (o.v === (def || 'wind')) e.selected = true;
    sel.appendChild(e);
  });
}
`;
const PAGE_CARTEJS = `/* Sea Tracker — briques de carte communes au suivi solo (/v) et a la flotte (/vf).
   Source unique : toute correction ici vaut pour les deux pages.
   Les fonds de carte restent definis dans chaque page, leurs reglages de zoom
   differant volontairement. */
"use strict";

/* attributions compactes, sans doublon, depliables au tap */
function tidyAttrib(){
  var el=document.querySelector('.leaflet-control-attribution');
  if(!el)return;
  var seen={},out=[];
  el.innerHTML.split(/\\s*(?:\\||,)\\s*/).forEach(function(p){
    var k=p.replace(/<[^>]*>/g,'').replace(/\\s+/g,' ').trim();
    if(k&&!seen[k]){seen[k]=1;out.push(p.trim());}
  });
  el.innerHTML=out.join(' · ');
  if(!el.dataset.tap){el.dataset.tap='1';el.onclick=function(){this.classList.toggle('exp');};}
}
function installAttrib(map){
  if(map.attributionControl)map.attributionControl.setPrefix('');
  map.on('layeradd layerremove baselayerchange overlayadd overlayremove',function(){setTimeout(tidyAttrib,60);});
  setTimeout(tidyAttrib,600);
}

/* menu de calques */
function buildLayerMenu(map, bases, overlays){
  var btn=document.createElement('button');
  btn.type='button'; btn.className='lyrbtn'; btn.setAttribute('aria-label','Calques'); btn.textContent='\\u2261';
  var panel=document.createElement('div'); panel.className='lyrpanel';
  var hB=document.createElement('div'); hB.className='grp'; hB.textContent='Fond de carte';
  var boxB=document.createElement('div');
  var hO=document.createElement('div'); hO.className='grp'; hO.textContent='Calques';
  var boxO=document.createElement('div');
  panel.appendChild(hB); panel.appendChild(boxB); panel.appendChild(hO); panel.appendChild(boxO);
  document.body.appendChild(btn); document.body.appendChild(panel);
  var current=null;
  function addBase(name, layer){
    var lab=document.createElement('label');
    var inp=document.createElement('input'); inp.type='radio'; inp.name='lyrbase';
    if(map.hasLayer(layer)){ inp.checked=true; current=layer; }
    var sp=document.createElement('span'); sp.textContent=name;
    lab.appendChild(inp); lab.appendChild(sp); boxB.appendChild(lab);
    function choisir(){
      inp.checked=true;
      if(current&&current!==layer&&map.hasLayer(current))map.removeLayer(current);
      current=layer;
      if(!map.hasLayer(layer))map.addLayer(layer);
      if(layer.bringToBack){try{layer.bringToBack();}catch(e){}}
      map.fire('baselayerchange',{layer:layer,name:name});
    }
    inp.onchange=function(){ if(this.checked) choisir(); };
    lab.addEventListener('click',function(ev){
      if(ev.target!==inp) ev.preventDefault();
      choisir();
    });
  }
  function addOverlay(layer, name){
    var lab=document.createElement('label');
    var inp=document.createElement('input'); inp.type='checkbox'; inp.checked=map.hasLayer(layer);
    var sp=document.createElement('span'); sp.textContent=name;
    lab.appendChild(inp); lab.appendChild(sp); boxO.appendChild(lab);
    /* Bascule d'un calque.
       Le 31/07/2026, le diagnostic embarque a montre que les cases meteo se
       cochaient visuellement sans que le calque soit ajoute (surCarte=false,
       pane vide). L'evenement « change » ne parvenait pas jusqu'ici sur iOS.
       On applique donc l'etat depuis un gestionnaire de CLIC sur le label
       entier, en pilotant nous-memes la case : ce chemin ne depend plus de la
       remontee de l'evenement natif. */
    function appliquer(actif){
      inp.checked=actif;
      if(actif){
        /* rattrapage : si la cle meteo est arrivee apres la creation du calque,
           on la reinjecte avant l'ajout */
        /* le calque « Vent » est un groupe (nappe + fleches) : on descend
           d'un niveau pour retrouver la tuile qui porte la cle */
        try{ (function rattraper(l){
          if(!l) return;
          if(l.options&&'cle' in l.options&&!l.options.cle&&window.OWM_KEY){ l.options.cle=window.OWM_KEY; if(l.redraw)l.redraw(); }
          if(l.eachLayer) l.eachLayer(rattraper);
        })(layer); }catch(e){}
        if(!map.hasLayer(layer))map.addLayer(layer); map.fire('overlayadd',{layer:layer,name:name});
      }
      else { if(map.hasLayer(layer))map.removeLayer(layer); map.fire('overlayremove',{layer:layer,name:name}); }
    }
    inp.onchange=function(){ appliquer(this.checked); };
    lab.addEventListener('click',function(ev){
      /* le clic sur la case elle-meme a deja bascule l'etat : on l'applique ;
         le clic sur le libelle ne bascule rien : on inverse nous-memes */
      if(ev.target===inp){ appliquer(inp.checked); return; }
      ev.preventDefault();
      appliquer(!inp.checked);
    });
  }
  for(var b in bases) addBase(b, bases[b]);
  for(var o in overlays) addOverlay(overlays[o], o);
  btn.onclick=function(e){ e.stopPropagation(); panel.classList.toggle('open'); };
  panel.addEventListener('click',function(e){ e.stopPropagation(); });
  document.addEventListener('click',function(){ panel.classList.remove('open'); });
  return { addOverlay:addOverlay, addBase:addBase, panel:panel, button:btn };
}
function installLayerMenu(map, bases, overlays){
  var layerCtl;
try { layerCtl = buildLayerMenu(map, bases, overlays); }
catch(e){
  try{
    var secours=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap'});
    secours.addTo(map);
    layerCtl={addOverlay:function(){},panel:null,button:null};
  }catch(e2){}
}
if(!map._loaded || !Object.keys(bases).length){ try{ L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18}).addTo(map); }catch(e){} }
  return layerCtl;
}

/* modeles et echeances meteo */
var MODELS=[{v:'best_match',t:'Auto (best match)'},{v:'meteofrance_arome_france_hd',t:'AROME France HD 1.5 km'},{v:'meteofrance_arpege_europe',t:'ARPEGE Europe 11 km'},{v:'icon_eu',t:'ICON-EU 7 km'},{v:'ecmwf_ifs025',t:'ECMWF 25 km'},{v:'gfs_seamless',t:'GFS 25 km'}];
var HOURS=[{v:0,t:'Maintenant'},{v:6,t:'+6 h'},{v:12,t:'+12 h'},{v:24,t:'+24 h'},{v:48,t:'+48 h'}];
function fillSel(sel,list,def){list.forEach(function(o){var e=document.createElement('option');e.value=o.v;e.textContent=o.t;if(String(o.v)===String(def))e.selected=true;sel.appendChild(e);});}

/* vent anime (particules) via leaflet-velocity + Open-Meteo */
function initVent(map, windGroup){
var windLayer=null, windBusy=false;
function windOpts(d){return {displayValues:true,
  displayOptions:{velocityType:'Vent',position:'bottomleft',emptyString:'—',angleConvention:'bearingCW',speedUnit:'kt'},
  data:d, minVelocity:0, maxVelocity:18, velocityScale:0.014, opacity:1,
  lineWidth:2.4, particleAge:110, particleMultiplier:1/170, paneName:'windPane',
  colorScale:['#3a4cff','#0091ff','#00c2ff','#00e0a0','#61ff3d','#d4ff00','#ffd000','#ff8a00','#ff3b2f','#ff0a78']};}
function loadWind(){
  if(!L.velocityLayer)return; windBusy=true;
  var c=map.getCenter();
  var model=document.getElementById('windModel').value, hour=document.getElementById('windHour').value;
  fetch('/api/wind?lat='+c.lat.toFixed(2)+'&lon='+c.lng.toFixed(2)+'&model='+encodeURIComponent(model)+'&hour='+hour)
   .then(function(r){return r.json();}).then(function(d){
     windBusy=false;
     if(windLayer){windGroup.removeLayer(windLayer);windLayer=null;}
     windLayer=L.velocityLayer(windOpts(d)); windGroup.addLayer(windLayer);
   }).catch(function(){windBusy=false;});
}
map.on('overlayadd', function(e){ if(e.layer!==windGroup)return; document.getElementById('windCtl').style.display='block'; if(!windLayer&&!windBusy)loadWind(); });
map.on('overlayremove', function(e){ if(e.layer!==windGroup)return; document.getElementById('windCtl').style.display='none'; if(windLayer){windGroup.removeLayer(windLayer);windLayer=null;} });
document.getElementById('windModel').onchange=function(){ if(map.hasLayer(windGroup))loadWind(); };
document.getElementById('windHour').onchange=function(){ if(map.hasLayer(windGroup))loadWind(); };
  return loadWind;
}

/* radar de pluie RainViewer */
function installRadar(layerCtl){
fetch('https://api.rainviewer.com/public/weather-maps.json').then(function(r){return r.json();}).then(function(d){
  if(d&&d.radar&&d.radar.past&&d.radar.past.length){
    var f=d.radar.past[d.radar.past.length-1];
    var radar=L.tileLayer((d.host||'https://tilecache.rainviewer.com')+f.path+'/256/{z}/{x}/{y}/2/1_1.png',
      {opacity:0.6,maxZoom:12,attribution:'Radar &copy; RainViewer'});
    layerCtl.addOverlay(radar,'Radar pluie');
  }
}).catch(function(){});
}

/* Carte marine vectorielle (openwaters.io) via MapLibre.
   MapLibre vient d'un CDN : si les balises <script> de la page ont echoue
   (reseau mobile), on retente ici en injectant les scripts, puis on ajoute le
   fond au menu une fois pret. Sans MapLibre, l'app reste pleinement
   fonctionnelle sur les fonds tuiles classiques. */
var CARTE_MARINE_NOM='Carte marine (isobathes/sondes)';
function creerCarteMarine(){
  return L.maplibreGL({style:'https://tiles.openwaters.io/seascape/style.json',attribution:'Fonds &copy; openwaters.io (CC BY 4.0)'});
}
/* ---- Calque « Flèches de courant » (atlas Shom) ----
   Un calque partagé par les deux cartes : il interroge /api/courant/champ sur
   la fenêtre visible, dessine une flèche par point, et se rafraîchit au
   déplacement (avec retenue) puis toutes les dix minutes. Au-dessous du zoom 8
   la maille de l'atlas n'a plus de sens : le calque se met en veille. */
/* ---- Calque « Vent » : fleches orientees + valeur en noeuds ----
   La nappe OpenWeather ne porte ni direction ni chiffre : par petit temps elle
   est illisible, meme a forte opacite (constate le 01/08/2026). On superpose
   une grille de fleches issues d'Open-Meteo — la meme source que le routeur,
   donc coherente avec les routes calculees. Mecanique reprise des fleches de
   courant : rafraichissement a la fenetre avec retenue, puis toutes les dix
   minutes ; mise en veille sous le zoom 4. */
function creerVentFleches(map){
  var groupe = L.layerGroup();
  var timer = null, dernier = 0, enCours = false, actif = false;
  var ZOOM_MIN = 4;

  function couleurVent(kt){
    return kt < 5  ? '#94a3b8'
         : kt < 10 ? '#38bdf8'
         : kt < 15 ? '#0284c7'
         : kt < 20 ? '#16a34a'
         : kt < 25 ? '#eab308'
         : kt < 30 ? '#ea580c'
         :           '#dc2626';
  }

  function flecheVent(lat, lon, kt, dirDe){
    /* dirDe : direction d'ou vient le vent. La fleche pointe dans le sens du
       flux (dirDe + 180), comme sur les cartes de vent classiques. */
    var cap = (dirDe + 180) % 360;
    var c = couleurVent(kt), lg = 24, h = lg + 12;
    var html = '<div style="width:' + lg + 'px;height:' + h + 'px;position:relative">'
      + '<div style="position:absolute;left:0;top:0;width:' + lg + 'px;height:' + lg + 'px;transform:rotate(' + cap + 'deg)">'
      + '<svg width="' + lg + '" height="' + lg + '" viewBox="0 0 24 24">'
      + '<path d="M12 22 L12 4" stroke="rgba(255,255,255,.8)" stroke-width="4.2" stroke-linecap="round" fill="none"/>'
      + '<path d="M6 10 L12 3 L18 10" stroke="rgba(255,255,255,.8)" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + '<path d="M12 22 L12 4" stroke="' + c + '" stroke-width="2.6" stroke-linecap="round" fill="none"/>'
      + '<path d="M6 10 L12 3 L18 10" stroke="' + c + '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + '</svg></div>'
      + '<div style="position:absolute;left:0;bottom:0;width:' + lg + 'px;text-align:center;'
      + 'font:700 10.5px/1.1 -apple-system,system-ui,sans-serif;color:#0b1a24;'
      + 'text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff">' + Math.round(kt) + '</div>'
      + '</div>';
    return L.marker([lat, lon], {
      icon: L.divIcon({ className: 'vent-fleche', html: html, iconSize: [lg, h], iconAnchor: [lg / 2, h / 2] }),
      interactive: false, keyboard: false
    });
  }

  function rafraichir(force){
    if(!actif || !map) return;
    if(map.getZoom() < ZOOM_MIN){ groupe.clearLayers(); return; }
    if(enCours) return;
    if(!force && Date.now() - dernier < 4000) return;
    var b = map.getBounds();
    var la0 = b.getSouth(), la1 = b.getNorth(), lo0 = b.getWest(), lo1 = b.getEast();
    /* l'endpoint borne la fenetre : on recentre plutot que d'echouer */
    if(la1 - la0 > 20){ var cm = (la0 + la1) / 2; la0 = cm - 10; la1 = cm + 10; }
    if(lo1 - lo0 > 30){ var co = (lo0 + lo1) / 2; lo0 = co - 15; lo1 = co + 15; }
    /* maille visee : une fleche tous les ~40 px, dans les deux sens, d'ou une
       grille rectangulaire qui suit la forme de l'ecran */
    var taille = map.getSize(), PAS_PX = 40;
    var nx = Math.max(6, Math.min(16, Math.round(taille.x / PAS_PX)));
    var ny = Math.max(6, Math.min(26, Math.round(taille.y / PAS_PX)));
    enCours = true;
    fetch('/api/vent/champ?lat0=' + la0.toFixed(3) + '&lat1=' + la1.toFixed(3)
        + '&lon0=' + lo0.toFixed(3) + '&lon1=' + lo1.toFixed(3)
        + '&nx=' + nx + '&ny=' + ny)
      .then(function(r){ return r.json(); })
      .then(function(d){
        enCours = false; dernier = Date.now();
        if(!actif) return;
        groupe.clearLayers();
        if(!d || !d.points) return;
        for(var i = 0; i < d.points.length; i++){
          var p = d.points[i];
          flecheVent(p[0], p[1], p[2], p[3]).addTo(groupe);
        }
      })
      .catch(function(){ enCours = false; });
  }

  var legendeV = null;
  function montrerLegendeV(){
    if(legendeV) return;
    legendeV = L.control({position:'bottomleft'});
    legendeV.onAdd = function(){
      var d = L.DomUtil.create('div');
      d.style.cssText = 'background:#0d1f2dee;color:#dfeaf2;border:1px solid #1d3a52;border-radius:10px;padding:7px 9px;font-size:11px;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.35)';
      var n = [['#94a3b8','< 5'],['#38bdf8','5\u201310'],['#0284c7','10\u201315'],['#16a34a','15\u201320'],['#eab308','20\u201325'],['#ea580c','25\u201330'],['#dc2626','> 30']];
      var h = '<div style="font-weight:700;margin-bottom:3px">Vent (kt)</div>';
      for(var i=0;i<n.length;i++)
        h += '<div><span style="display:inline-block;width:16px;height:3px;background:'+n[i][0]+';vertical-align:middle;margin-right:5px;border-radius:2px"></span>'+n[i][1]+'</div>';
      h += '<div style="margin-top:3px;color:#8fb0c4">fleche = sens du flux</div>';
      d.innerHTML = h;
      return d;
    };
    legendeV.addTo(map);
  }
  function cacherLegendeV(){ if(legendeV){ try{ map.removeControl(legendeV); }catch(e){} legendeV = null; } }

  groupe.on('add', function(){
    actif = true; montrerLegendeV(); rafraichir(true);
    map.on('moveend', onMoveV);
    timer = setInterval(function(){ rafraichir(true); }, 600000);
  });
  groupe.on('remove', function(){
    actif = false; cacherLegendeV(); groupe.clearLayers();
    map.off('moveend', onMoveV);
    if(timer){ clearInterval(timer); timer = null; }
  });
  function onMoveV(){ rafraichir(false); }
  return groupe;
}

function creerCourantsLayer(map){
  var groupe = L.layerGroup();
  var timer = null, dernier = 0, enCours = false, actif = false;
  var ZOOM_MIN = 8;

  function fleche(lat, lon, vitesse, dir){
    /* longueur et epaisseur proportionnees a la vitesse, plafonnees */
    var v = Math.min(vitesse, 6);
    /* fleches fines : lisibles sans masquer la carte. Longueur en racine
       carree pour etaler les faibles vitesses sans saturer les fortes. */
    var lg = 15 + Math.sqrt(v) * 9;            /* pixels */
    var ep = 1.5 + v * 0.28;
    /* echelle de couleurs a six niveaux, du calme au raz */
    var couleur = v < 0.3 ? '#94a3b8'          /* < 0,3 kt : gris-bleu, negligeable */
                : v < 0.8 ? '#38bdf8'          /* 0,3-0,8 : bleu clair */
                : v < 1.5 ? '#0284c7'          /* 0,8-1,5 : bleu */
                : v < 2.5 ? '#16a34a'          /* 1,5-2,5 : vert */
                : v < 3.5 ? '#ea580c'          /* 2,5-3,5 : orange */
                :           '#dc2626';         /* > 3,5   : rouge */
    var html = '<div style="transform:rotate(' + dir + 'deg);transform-origin:50% 100%;width:' + lg + 'px;height:' + lg + 'px;position:relative">'
      + '<svg width="' + lg + '" height="' + lg + '" viewBox="0 0 24 24" style="position:absolute;left:0;top:0">'
      /* liseré sombre dessous : lisible sur fond clair comme sur satellite */
      + '<path d="M12 23 L12 4" stroke="rgba(255,255,255,.75)" stroke-width="' + (ep + 1.1) + '" stroke-linecap="round" fill="none"/>'
      + '<path d="M6 10 L12 3 L18 10" stroke="rgba(255,255,255,.75)" stroke-width="' + (ep + 1.1) + '" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + '<path d="M12 23 L12 4" stroke="' + couleur + '" stroke-width="' + ep + '" stroke-linecap="round" fill="none"/>'
      + '<path d="M6 10 L12 3 L18 10" stroke="' + couleur + '" stroke-width="' + ep + '" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + '</svg></div>';
    return L.marker([lat, lon], {
      icon: L.divIcon({ className: 'courant-fleche', html: html, iconSize: [lg, lg], iconAnchor: [lg / 2, lg] }),
      interactive: false, keyboard: false
    });
  }

  function rafraichir(force){
    if(!actif || !map) return;
    if(map.getZoom() < ZOOM_MIN){ groupe.clearLayers(); return; }
    if(enCours) return;
    if(!force && Date.now() - dernier < 4000) return;
    var b = map.getBounds();
    var la0 = b.getSouth(), la1 = b.getNorth(), lo0 = b.getWest(), lo1 = b.getEast();
    /* l'endpoint borne la fenetre : on recentre plutot que d'echouer */
    if(la1 - la0 > 4){ var cm = (la0 + la1) / 2; la0 = cm - 2; la1 = cm + 2; }
    if(lo1 - lo0 > 6){ var co = (lo0 + lo1) / 2; lo0 = co - 3; lo1 = co + 3; }
    enCours = true;
    fetch('/api/courant/champ?lat0=' + la0.toFixed(3) + '&lat1=' + la1.toFixed(3)
        + '&lon0=' + lo0.toFixed(3) + '&lon1=' + lo1.toFixed(3))
      .then(function(r){ return r.json(); })
      .then(function(d){
        enCours = false; dernier = Date.now();
        if(!actif) return;
        groupe.clearLayers();
        if(!d || !d.points) return;
        for(var i = 0; i < d.points.length; i++){
          var p = d.points[i];
          fleche(p[0], p[1], p[2], p[3]).addTo(groupe);
        }
      })
      .catch(function(){ enCours = false; });
  }

  var legende = null;
  function montrerLegende(){
    if(legende) return;
    legende = L.control({position:'bottomleft'});
    legende.onAdd = function(){
      var d = L.DomUtil.create('div');
      d.style.cssText = 'background:#0d1f2dee;color:#dfeaf2;border:1px solid #1d3a52;border-radius:10px;padding:7px 9px;font-size:11px;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.35)';
      var n = [['#94a3b8','< 0,3'],['#38bdf8','0,3–0,8'],['#0284c7','0,8–1,5'],['#16a34a','1,5–2,5'],['#ea580c','2,5–3,5'],['#dc2626','> 3,5']];
      var h = '<div style="font-weight:700;margin-bottom:3px">Courant (kt)</div>';
      for(var i=0;i<n.length;i++)
        h += '<div><span style="display:inline-block;width:16px;height:3px;background:'+n[i][0]+';vertical-align:middle;margin-right:5px;border-radius:2px"></span>'+n[i][1]+'</div>';
      d.innerHTML = h;
      return d;
    };
    legende.addTo(map);
  }
  function cacherLegende(){ if(legende){ try{ map.removeControl(legende); }catch(e){} legende = null; } }

  groupe.on('add', function(){
    actif = true; montrerLegende(); rafraichir(true);
    map.on('moveend', onMove);
    timer = setInterval(function(){ rafraichir(true); }, 600000);
  });
  groupe.on('remove', function(){
    actif = false; cacherLegende(); groupe.clearLayers();
    map.off('moveend', onMove);
    if(timer){ clearInterval(timer); timer = null; }
  });
  function onMove(){ rafraichir(false); }
  return groupe;
}

function assurerCarteMarine(map, layerCtl, bases){
  if(bases[CARTE_MARINE_NOM]) return; /* deja au menu, rien a faire */
  function ajouter(){
    if(bases[CARTE_MARINE_NOM]) return;
    try{
      var l=creerCarteMarine();
      bases[CARTE_MARINE_NOM]=l;
      layerCtl.addBase(CARTE_MARINE_NOM,l);
    }catch(e){}
  }
  if(window.maplibregl && L.maplibreGL){ ajouter(); return; }
  var VER='5.24.0', PONT='0.1.3';
  function script(src,fin){var t=document.createElement('script');t.src=src;t.onload=fin;t.onerror=function(){};document.head.appendChild(t);}
  function css(href){var l=document.createElement('link');l.rel='stylesheet';l.href=href;document.head.appendChild(l);}
  var etape2=function(){
    if(L.maplibreGL){ajouter();return;}
    script('https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@'+PONT+'/leaflet-maplibre-gl.js',ajouter);
  };
  if(window.maplibregl){ etape2(); return; }
  css('https://cdn.jsdelivr.net/npm/maplibre-gl@'+VER+'/dist/maplibre-gl.css');
  script('https://cdn.jsdelivr.net/npm/maplibre-gl@'+VER+'/dist/maplibre-gl.js',etape2);
}

/* Relief detaille des fonds : Litto3D Bretagne 2018-2021 (Shom-IGN, lidar
   bathymetrique, resolution 1 m, Licence Ouverte). Couverture limitee a la
   frange littorale levee au lidar : transparent ailleurs, donc concu pour se
   superposer a la carte marine. Donnee d'etude : ne remplace pas les cartes de
   navigation. */
var LITTO3D_COUCHES=['LITTO3D_BZH_2018_2021_PYR_3857_WMSR','LITTO3D_FINISTR_2014_PYR_3857_WMSR','L3D_MAR_LR_2011_PYR_3857_WMSR','LITTO3D_PACA_2015_PYR_3857_WMSR','L3D_LIDAR_CORSE_2017_2018_PYR_3857_WMSR'];
function creerLitto3D(){
  /* une requete WMS par region : une couche indisponible ne prive pas les
     autres ; hors emprise, chaque couche est simplement transparente */
  var g=L.layerGroup();
  LITTO3D_COUCHES.forEach(function(c){
    g.addLayer(L.tileLayer.wms('https://services.data.shom.fr/INSPIRE/wms/r',{
      layers:c,format:'image/png',transparent:true,version:'1.3.0',
      opacity:.8,maxZoom:18,
      attribution:'Litto3D\u00ae \u00a9 Shom-IGN'
    }));
  });
  return g;
}

/* fleche compacte indiquant la direction vers laquelle porte un vecteur */
function dirArrow(deg){if(deg==null)return '';var a=['\u2193','\u2199','\u2190','\u2196','\u2191','\u2197','\u2192','\u2198'];return a[Math.round((((deg%360)+360)%360)/45)%8];}
`;
const PAGE_ROUTEURJS = "/* Sea Tracker \u2014 routeur isochrones. Charge par la page flotte.\n   Moteur execute dans un Web Worker : le telephone calcule, le serveur ne\n   fournit que les grilles (vent Open-Meteo, courant atlas Shom) et la terre.\n   polarSpeed et parsePol sont repris a l'identique de l'app EKINOX. */\n\"use strict\";\n\n/* ---------- polaires (portees d'EKINOX, structure {tws,twa,grid}) ---------- */\n/* injecte par /routeur-polaires.js, charge AVANT ce fichier : on ne le\n   reinitialise pas, sous peine d'effacer les polaires (bug corrige le 30/07). */\nif (typeof POLAIRES_PRESETS === 'undefined') var POLAIRES_PRESETS = null;\n\nfunction rtParsePol(txt){\n  var lines=txt.split(/\\r?\\n/).filter(function(l){return l.trim();});\n  var hdr=lines[0].trim().split(/[\\t;,\\s]+/);\n  var tws=hdr.slice(1).map(Number), twa=[], grid=[];\n  for(var i=1;i<lines.length;i++){var c=lines[i].trim().split(/[\\t;,\\s]+/).map(Number);twa.push(c[0]);grid.push(c.slice(1));}\n  if(!tws.length||!twa.length||!grid.length||grid[0].length!==tws.length) return null;\n  return {tws:tws,twa:twa,grid:grid};\n}\n\n/* ---------- source du worker ---------- */\nvar RT_WORKER_SRC = `\n\"use strict\";\nfunction polarSpeed(P,tws,twa){\n  if(!P||!P.grid)return 0; twa=Math.abs(((twa+180)%360+360)%360-180);\n  var TW=P.tws, TA=P.twa, G=P.grid;\n  function idx(grid,x){var n=grid.length;if(x<=grid[0])return[0,0,0];if(x>=grid[n-1])return[n-1,n-1,0];\n    var lo=0,hi=n-1;while(hi-lo>1){var mid=(lo+hi)>>1;if(grid[mid]<=x)lo=mid;else hi=mid;}\n    return[lo,hi,(x-grid[lo])/(grid[hi]-grid[lo])];}\n  var a=idx(TA,twa), w=idx(TW,tws), gg=function(i,j){return G[i][j];};\n  return (gg(a[0],w[0])*(1-w[2])+gg(a[0],w[1])*w[2])*(1-a[2])+(gg(a[1],w[0])*(1-w[2])+gg(a[1],w[1])*w[2])*a[2];\n}\nvar R_T=Math.PI/180, RTERRE=3440.065; /* milles nautiques */\nfunction avance(lat,lon,cap,nm){\n  var d=nm/RTERRE, p1=lat*R_T, l1=lon*R_T, tc=cap*R_T;\n  var p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(tc));\n  var l2=l1+Math.atan2(Math.sin(tc)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));\n  return [p2/R_T,l2/R_T];\n}\nfunction distNm(a,b){\n  var dp=(b[0]-a[0])*R_T, dl=(b[1]-a[1])*R_T, p1=a[0]*R_T, p2=b[0]*R_T;\n  var h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);\n  return 2*RTERRE*Math.asin(Math.sqrt(h));\n}\nfunction capVers(a,b){\n  var p1=a[0]*R_T,p2=b[0]*R_T,dl=(b[1]-a[1])*R_T;\n  var y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);\n  var c=Math.atan2(y,x)/R_T; return (c+360)%360;\n}\nvar TERRE=null, RIDX=null, RPAS=0.25;\n/* index des aretes par bandes de latitude (0,25 degre) : le test point-dans-terre\n   devient un lancer de rayon classique qui ne parcourt que les aretes de sa\n   bande \u2014 quelques dizaines au lieu des dizaines de milliers de sommets de\n   l'anneau continental. Exactitude inchangee (pair-impair global). */\nfunction terreIndex(){\n  RIDX={};\n  for(var z=0;z<TERRE.length;z++){\n    var p=TERRE[z].pts;\n    for(var i=0,j=p.length-1;i<p.length;j=i++){\n      var y1=p[j][0],x1=p[j][1],y2=p[i][0],x2=p[i][1];\n      if(y1===y2)continue;\n      var r0=Math.floor(Math.min(y1,y2)/RPAS), r1=Math.floor(Math.max(y1,y2)/RPAS);\n      for(var rr=r0;rr<=r1;rr++)(RIDX[rr]||(RIDX[rr]=[])).push(y1,x1,y2,x2);\n    }\n  }\n}\nfunction surTerre(lat,lon){\n  if(!RIDX)return false;\n  var b=RIDX[Math.floor(lat/RPAS)];\n  if(!b)return false;\n  var c=false;\n  for(var i=0;i<b.length;i+=4){\n    var y1=b[i],x1=b[i+1],y2=b[i+2],x2=b[i+3];\n    if((y1>lat)!==(y2>lat)&&lon<x1+(x2-x1)*(lat-y1)/(y2-y1))c=!c;\n  }\n  return c;\n}\nfunction dansExclusion(lat,lon,zones){\n  for(var z=0;z<zones.length;z++){\n    var p=zones[z],c=false;\n    for(var i=0,j=p.length-1;i<p.length;j=i++){\n      var y1=p[j][0],x1=p[j][1],y2=p[i][0],x2=p[i][1];\n      if((y1>lat)!==(y2>lat)&&lon<x1+(x2-x1)*(lat-y1)/(y2-y1))c=!c;\n    }\n    if(c)return true;\n  }\n  return false;\n}\nvar G=null; /* grilles {lats,lons,temps,vent,courant,t0} */\nfunction champ(lat,lon,tMs,quoi){\n  /* interpolation bilineaire espace + lineaire temps sur la grille */\n  var la=G.lats, lo=G.lons;\n  if(lat<la[0]||lat>la[la.length-1]||lon<lo[0]||lon>lo[lo.length-1])return null;\n  var ih=(tMs-G.t0)/3600e3/(G.pasH||1); if(ih<0)ih=0; var i0=Math.floor(ih), i1=Math.min(G.temps.length-1,i0+1), ft=ih-i0;\n  if(i0>=G.temps.length)return null;\n  function ix(grid,x){var n=grid.length,loI=0,hiI=n-1;if(x<=grid[0])return[0,0,0];if(x>=grid[n-1])return[n-1,n-1,0];\n    while(hiI-loI>1){var m=(loI+hiI)>>1;if(grid[m]<=x)loI=m;else hiI=m;}return[loI,hiI,(x-grid[loI])/(grid[hiI]-grid[loI])];}\n  var A=ix(la,lat), O=ix(lo,lon);\n  function noeud(ia,io){return (quoi==='vent'?G.vent:G.courant)[ia*lo.length+io];}\n  function valT(n2,cle){\n    if(!n2)return null;\n    var v0=n2[cle][i0], v1=n2[cle][i1];\n    if(v0===null||v1===null)return null;\n    if(cle==='d'){ /* interpolation circulaire des directions */\n      var d0=v0*Math.PI/180,d1=v1*Math.PI/180;\n      var x2=Math.cos(d0)*(1-ft)+Math.cos(d1)*ft, y2=Math.sin(d0)*(1-ft)+Math.sin(d1)*ft;\n      return (Math.atan2(y2,x2)*180/Math.PI+360)%360;\n    }\n    return v0*(1-ft)+v1*ft;\n  }\n  var cles=quoi==='vent'?['s','d']:['u','v'];\n  var out={};\n  for(var kc=0;kc<cles.length;kc++){\n    var cle=cles[kc], acc=0, poids=0, circ=cle==='d';\n    var cx=0, cy=0;\n    var coins=[[A[0],O[0],(1-A[2])*(1-O[2])],[A[0],O[1],(1-A[2])*O[2]],[A[1],O[0],A[2]*(1-O[2])],[A[1],O[1],A[2]*O[2]]];\n    for(var q=0;q<4;q++){\n      var v=valT(noeud(coins[q][0],coins[q][1]),cle);\n      if(v===null)continue;\n      if(circ){cx+=Math.cos(v*Math.PI/180)*coins[q][2];cy+=Math.sin(v*Math.PI/180)*coins[q][2];}\n      else acc+=v*coins[q][2];\n      poids+=coins[q][2];\n    }\n    if(poids<0.4)return quoi==='courant'?{u:0,v:0}:null; /* courant hors atlas = nul, vent manquant = bloquant */\n    out[cle]=circ?(Math.atan2(cy,cx)*180/Math.PI+360)%360:acc/poids;\n  }\n  return out;\n}\nonmessage=function(ev){\n  var m=ev.data;\n  G=m.grilles; TERRE=m.terre; terreIndex();\n  var P=m.polaire, pct=m.pctPolaire/100, excl=m.exclusions||[];\n  var dep=[m.depart.lat,m.depart.lon], arr=[m.arrivee.lat,m.arrivee.lon];\n  var t0=m.t0, dtMin=m.pasMinutes, dt=dtMin/60;\n  var CAPS=[]; for(var c=0;c<360;c+=m.pasCap)CAPS.push(c);\n  var motifArret=null;\n  var SECT=2.5; /* elagage : meilleur point par secteur de 2,5 degres vus du depart */\n  var racine={p:dep,parent:-1,t:t0,idx:0};\n  var front=[racine], noeuds=[racine];\n  var isochrones=[], arrivee=null, distTot=distNm(dep,arr);\n  for(var etape=1;etape<=m.maxHeures/dt;etape++){\n    var t=t0+etape*dt*3600e3;\n    var meilleurs={};\n    for(var f=0;f<front.length;f++){\n      var n2=front[f];\n      var vent=champ(n2.p[0],n2.p[1],n2.t,'vent');\n      if(!vent)continue;\n      var cour=champ(n2.p[0],n2.p[1],n2.t,'courant')||{u:0,v:0};\n      for(var ci=0;ci<CAPS.length;ci++){\n        var cap=CAPS[ci];\n        var twa=((cap-vent.d+540)%360)-180;\n        /* angle mort au pres : les grilles .pol contiennent souvent des valeurs\n           de remplissage jusqu'a TWA 0 ; EKINOX lui-meme ne balaie jamais sous\n           40 degres (bestVMG). Sous 35 degres du vent, on ne navigue pas. */\n        if(Math.abs(twa)<35)continue;\n        var bs=polarSpeed(P,vent.s,twa)*pct;\n        if(bs<0.3)continue;\n        /* vecteur surface + vecteur courant */\n        var dx=bs*Math.sin(cap*Math.PI/180)+cour.u;\n        var dy=bs*Math.cos(cap*Math.PI/180)+cour.v;\n        var sog=Math.sqrt(dx*dx+dy*dy);\n        if(sog<0.2)continue;\n        var cog=(Math.atan2(dx,dy)*180/Math.PI+360)%360;\n        var np=avance(n2.p[0],n2.p[1],cog,sog*dt);\n        if(surTerre(np[0],np[1]))continue;\n        var mi=avance(n2.p[0],n2.p[1],cog,sog*dt/2);\n        if(surTerre(mi[0],mi[1]))continue;\n        if(excl.length&&(dansExclusion(np[0],np[1],excl)||dansExclusion(mi[0],mi[1],excl)))continue;\n        var rel=capVers(dep,np), dRest=distNm(np,arr), dDep=distNm(dep,np);\n        var secteur=Math.round(rel/SECT);\n        var score=dDep-dRest*0.0; /* expansion par distance au depart ; tri final par dRest */\n        var cleS=secteur;\n        if(!meilleurs[cleS]||dRest<meilleurs[cleS].dRest){\n          meilleurs[cleS]={p:np,parent:n2.idx,dRest:dRest,t:t,cap:Math.round(cog)};\n        }\n      }\n    }\n    var nf=[];\n    for(var kS in meilleurs){\n      var b2=meilleurs[kS];\n      var idxN=noeuds.length;\n      noeuds.push({p:b2.p,parent:b2.parent,t:b2.t,cap:b2.cap,idx:idxN});\n      nf.push(noeuds[idxN]);\n      if(b2.dRest<Math.max(0.8,(m.pasMinutes/60)*3)){arrivee=noeuds[idxN];}\n    }\n    if(!nf.length){\n      /* le front s'eteint : soit blocage reel (terre/calmes) en tout debut de\n         route, soit \u2014 cas transat \u2014 la fin des donnees meteo. Dans ce second\n         cas, quinze jours de route calculee valent d'etre rendus : on livre la\n         meilleure approche avec le motif, au lieu de tout jeter. */\n      var horizonH=(G.temps.length-1)*(G.pasH||1);\n      motifArret=(etape*dt>=horizonH-0.01)?('horizon m\u00e9t\u00e9o atteint ('+(horizonH/24).toFixed(0)+' j)')\n                                          :('terre ou calmes \u00e0 T+'+(etape*dt).toFixed(1)+' h');\n      if(isochrones.length<3){postMessage({erreur:'front vide \u2014 '+motifArret});return;}\n      break;\n    }\n    front=nf;\n    isochrones.push(nf.map(function(q){return [Math.round(q.p[0]*1e4)/1e4,Math.round(q.p[1]*1e4)/1e4];}));\n    postMessage({progression:etape*dt,fronts:isochrones.length});\n    if(arrivee)break;\n  }\n  if(!arrivee){\n    /* pas atteint : renvoyer la meilleure approche */\n    var best=front[0];\n    for(var f2=1;f2<front.length;f2++)if(distNm(front[f2].p,arr)<distNm(best.p,arr))best=front[f2];\n    arrivee=best;\n  }\n  var route=[], n3=arrivee;\n  while(n3){route.unshift({p:n3.p,t:n3.t,cap:n3.cap||null});n3=n3.parent>=0?noeuds[n3.parent]:null;}\n  postMessage({fini:true,route:route,isochrones:isochrones,arriveeAtteinte:distNm(arrivee.p,arr)<Math.max(0.8,(m.pasMinutes/60)*3),eta:arrivee.t,distRestante:Math.round(distNm(arrivee.p,arr)*10)/10,motif:motifArret});\n};\n`;\n\n/* ---------- interface (etat + rendu Leaflet, branchee par la page flotte) ---------- */\nvar RT = {\n  actif:false, depart:null, arrivee:null, calques:null, worker:null,\n  terre:null, exclusions:[], polaire:null, polaireNom:'\u2014'\n};\n\nfunction rtChargerTerre(){\n  /* .gz d'abord ; sur le moindre echec (fichier absent, DecompressionStream\n     capricieux), bascule sur la version non compressee servie par le serveur.\n     La promesse est memorisee : rtLancer peut retenter au clic. */\n  if(RT.terrePromesse) return RT.terrePromesse;\n  RT.terrePromesse = fetch('/terre.json.gz')\n    .then(function(r){ if(!r.ok) throw new Error('gz '+r.status); return r.arrayBuffer(); })\n    .then(function(buf){\n      var ds=new DecompressionStream('gzip');\n      return new Response(new Response(buf).body.pipeThrough(ds)).json();\n    })\n    .catch(function(){ return fetch('/terre.json').then(function(r2){ if(!r2.ok) throw new Error('terre.json '+r2.status); return r2.json(); }); })\n    .then(function(j){ RT.terre=j.anneaux; RT.terreErreur=null; return true; })\n    .catch(function(e){ RT.terreErreur='trait de c\u00f4te introuvable ('+(e&&e.message||e)+') \u2014 terre.json.gz est-il \u00e0 la racine du d\u00e9p\u00f4t ?'; RT.terrePromesse=null; return false; });\n  return RT.terrePromesse;\n}\nfunction rtInit(map, layerCtl){\n  RT.map = map;\n  RT.calques = L.layerGroup().addTo(map);\n  rtChargerTerre();\n}\n\nfunction rtChoisirPolaire(nom, texte){\n  if(texte){var P=rtParsePol(texte); if(!P){alert('Fichier .pol illisible');return false;} RT.polaire=P; RT.polaireNom=nom||'.pol coll\u00e9e'; return true;}\n  if(POLAIRES_PRESETS&&POLAIRES_PRESETS[nom]){RT.polaire=POLAIRES_PRESETS[nom].d; RT.polaireNom=POLAIRES_PRESETS[nom].n; return true;}\n  return false;\n}\n\nfunction rtLancer(opts, surProgres, surFini, surErreur){\n  var dep=RT.depart, arr=RT.arrivee;\n  if(!dep||!arr){surErreur('Choisir un d\u00e9part et une arriv\u00e9e');return;}\n  if(!RT.polaire){surErreur('Choisir une polaire');return;}\n  if(!RT.terre){\n    surProgres('Chargement du trait de c\u00f4te\u2026');\n    rtChargerTerre().then(function(ok){\n      if(ok) rtLancer(opts,surProgres,surFini,surErreur);\n      else surErreur(RT.terreErreur||'Trait de c\u00f4te indisponible');\n    });\n    return;\n  }\n  /* parametres proportionnes a la distance : cotier fin, transat au pas d'une\n     heure sur 16 jours (l'horizon des previsions \u2014 au-dela, plus de meteo) */\n  var R_T2=Math.PI/180;\n  var dOrtho=(function(a,b){var dp=(b.lat-a.lat)*R_T2,dl=(b.lon-a.lon)*R_T2;\n    var h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(a.lat*R_T2)*Math.cos(b.lat*R_T2)*Math.sin(dl/2)*Math.sin(dl/2);\n    return 2*3440.065*Math.asin(Math.sqrt(h));})(dep,arr);\n  var marge, pasMin, maxH;\n  if(dOrtho<150){marge=0.6;pasMin=12;maxH=48;}\n  else if(dOrtho<600){marge=1.5;pasMin=30;maxH=120;}\n  else{marge=4;pasMin=60;maxH=384;}\n  opts=Object.assign({},opts,{pasMinutes:opts.pasMinutes||pasMin,maxHeures:opts.maxHeures||maxH});\n  var la0=Math.min(dep.lat,arr.lat)-marge, la1=Math.max(dep.lat,arr.lat)+marge;\n  var lo0=Math.min(dep.lon,arr.lon)-marge/Math.cos((la0+la1)/2*Math.PI/180), lo1=Math.max(dep.lon,arr.lon)+marge/Math.cos((la0+la1)/2*Math.PI/180);\n  surProgres('Route de '+Math.round(dOrtho)+' MN \u2014 grilles vent + courant\\u2026');\n  var url='/api/routeur/grilles?lat0='+la0.toFixed(2)+'&lat1='+la1.toFixed(2)+'&lon0='+lo0.toFixed(2)+'&lon1='+lo1.toFixed(2)\n    +'&modele='+(opts.modele||'best_match')+'&heures='+opts.maxHeures;\n  surProgres('Grilles vent + courant\u2026');\n  fetch(url).then(function(r){return r.json();}).then(function(g){\n    if(g.error){surErreur(g.error);return;}\n    if(RT.worker){RT.worker.terminate();}\n    RT.worker=new Worker(URL.createObjectURL(new Blob([RT_WORKER_SRC],{type:'text/javascript'})));\n    RT.worker.onmessage=function(ev){\n      var m=ev.data;\n      if(m.erreur){surErreur(m.erreur);return;}\n      if(m.progression!==undefined){surProgres('Calcul\u2026 T+'+m.progression.toFixed(1)+' h');return;}\n      if(m.fini){surFini(m);}\n    };\n    var t0=Math.max(Date.now(),g.t0);\n    RT.worker.postMessage({\n      grilles:g, terre:RT.terre, polaire:RT.polaire, exclusions:RT.exclusions,\n      depart:dep, arrivee:arr, t0:t0,\n      pasMinutes:opts.pasMinutes, pasCap:opts.pasCap||6,\n      maxHeures:opts.maxHeures, pctPolaire:opts.pctPolaire||100\n    });\n  }).catch(function(e){surErreur('Grilles injoignables : '+e.message);});\n}\n\nfunction rtDessiner(m){\n  RT.calques.clearLayers();\n  for(var i=0;i<m.isochrones.length;i++){\n    L.polyline(m.isochrones[i],{color:'#f59e0b',weight:1,opacity:0.25+0.4*(i/m.isochrones.length),interactive:false}).addTo(RT.calques);\n  }\n  var trace=m.route.map(function(q){return q.p;});\n  L.polyline(trace,{color:'#f59e0b',weight:4,opacity:0.95}).addTo(RT.calques);\n  if(RT.depart)L.circleMarker([RT.depart.lat,RT.depart.lon],{radius:6,color:'#fff',fillColor:'#16a34a',fillOpacity:1,weight:2,bubblingMouseEvents:false}).addTo(RT.calques);\n  if(RT.arrivee)L.circleMarker([RT.arrivee.lat,RT.arrivee.lon],{radius:7,color:'#fff',fillColor:'#f59e0b',fillOpacity:1,weight:2,bubblingMouseEvents:false}).addTo(RT.calques);\n}\n\n/* GPX : polygones d'exclusion (trk ou rte fermes) */\nfunction rtChargerGPX(texte){\n  try{\n    var doc=new DOMParser().parseFromString(texte,'text/xml');\n    var pts=[].slice.call(doc.querySelectorAll('trkpt,rtept')).map(function(n){\n      return [parseFloat(n.getAttribute('lat')),parseFloat(n.getAttribute('lon'))];});\n    if(pts.length>=3){RT.exclusions.push(pts);return pts.length;}\n  }catch(e){}\n  return 0;\n}\n";
const PAGE_ROUTEUR_POLAIRES = "/* Polaires du routeur : presets EKINOX extraits de index.html (grilles identiques) + generique. */\nPOLAIRES_PRESETS={\"generique\":{\"n\":\"Croiseur g\\u00e9n\\u00e9rique 9-10 m\",\"d\":{\"tws\":[4,6,8,10,12,14,16,20,25,30],\"twa\":[40,45,52,60,70,80,90,100,110,120,135,150,165,180],\"grid\":[[2.6,3.4,4.1,4.6,4.9,5.1,5.2,5.3,5.2,5.0],[3.0,3.9,4.6,5.1,5.4,5.6,5.7,5.8,5.7,5.5],[3.4,4.3,5.0,5.5,5.8,6.0,6.1,6.2,6.1,5.9],[3.7,4.6,5.3,5.8,6.1,6.3,6.4,6.5,6.4,6.2],[3.9,4.8,5.5,6.0,6.3,6.5,6.6,6.7,6.7,6.5],[4.0,4.9,5.6,6.1,6.4,6.6,6.7,6.8,6.8,6.6],[4.0,5.0,5.7,6.2,6.5,6.7,6.8,6.9,6.9,6.8],[3.9,4.9,5.6,6.2,6.5,6.7,6.9,7.0,7.0,6.9],[3.8,4.8,5.5,6.1,6.5,6.7,6.9,7.1,7.1,7.0],[3.6,4.6,5.4,6.0,6.4,6.7,6.9,7.1,7.2,7.1],[3.2,4.2,5.0,5.7,6.2,6.5,6.8,7.1,7.3,7.3],[2.8,3.7,4.5,5.2,5.8,6.2,6.5,7.0,7.3,7.4],[2.4,3.2,4.0,4.7,5.3,5.8,6.2,6.8,7.2,7.4],[2.2,3.0,3.7,4.4,5.0,5.5,5.9,6.6,7.1,7.3]]}},\"musa\":{\"n\":\"MusaV1 (EKINOX)\",\"d\":{\"tws\":[4.0,6.0,8.0,10.0,12.0,14.0,16.0,18.0,20.0,22.0,24.0,26.0,28.0,30.0,32.0,34.0,36.0,40.0],\"twa\":[40.0,44.0,45.0,46.0,48.0,50.0,52.0,54.0,56.0,58.0,60.0,65.0,70.0,73.0,76.0,80.0,85.0,90.0,95.0,100.0,103.0,106.0,110.0,113.0,116.0,120.0,125.0,130.0,132.0,134.0,135.0,136.0,138.0,140.0,142.0,144.0,146.0,150.0,160.0,170.0,180.0],\"grid\":[[0.98,2.13,3.81,5.03,5.73,5.8,6.89,6.69,7.24,7.61,7.67,7.62,7.62,7.62,6.92,6.34,5.58,4.22],[1.13,2.45,4.19,5.55,6.39,6.81,7.54,7.61,7.78,8.45,8.69,8.46,8.46,8.46,7.71,7.09,6.25,4.76],[1.21,2.53,4.29,5.7,6.57,7.09,7.73,7.95,8.18,8.66,8.91,8.71,8.68,8.63,7.91,7.29,6.44,4.95],[1.27,2.61,4.4,5.85,6.71,7.4,7.89,8.32,8.64,8.82,9.06,9.0,8.94,8.85,8.31,7.74,6.64,5.15],[1.33,2.75,4.6,6.18,7.09,7.88,8.3,8.63,8.95,9.21,9.38,9.55,9.59,9.53,9.41,9.07,7.23,5.57],[1.32,2.9,4.87,6.63,7.42,8.23,8.7,9.03,9.37,9.57,9.88,10.02,10.18,10.2,10.07,9.88,8.35,6.0],[1.43,3.05,5.29,7.13,7.71,8.58,9.08,9.38,9.75,10.02,10.25,10.37,10.54,10.56,10.49,10.23,9.17,6.44],[1.56,3.25,5.7,7.43,7.9,8.78,9.35,9.76,10.11,10.46,10.68,10.75,10.88,10.91,10.85,10.66,9.82,6.93],[1.71,3.48,6.01,7.59,8.11,8.98,9.62,10.07,10.51,10.91,11.06,11.18,11.27,11.3,11.25,11.1,10.22,7.54],[1.9,3.75,6.26,7.74,8.3,9.17,9.88,10.39,10.87,11.32,11.51,11.64,11.69,11.72,11.64,11.51,10.6,8.33],[2.09,4.08,6.45,7.87,8.5,9.37,10.14,10.75,11.23,11.7,11.94,12.03,12.1,12.13,12.09,11.96,11.03,8.83],[2.58,4.97,6.69,8.13,8.9,9.9,10.7,11.5,12.08,12.65,12.94,13.03,13.03,13.13,13.09,12.87,11.94,9.73],[3.24,5.26,6.84,8.32,9.31,10.3,11.12,12.17,12.95,13.56,13.88,13.95,13.99,14.07,14.02,13.77,12.87,10.78],[3.45,5.38,6.95,8.42,9.52,10.48,11.38,12.48,13.42,14.04,14.42,14.46,14.51,14.57,14.51,14.26,13.35,11.27],[3.65,5.53,7.15,8.5,9.71,10.66,11.6,12.79,13.88,14.48,14.89,14.97,15.03,15.11,14.99,14.62,13.71,11.77],[3.82,5.7,7.31,8.63,9.92,10.89,12.0,13.15,14.42,15.04,15.4,15.7,15.75,15.78,15.73,15.11,13.97,12.38],[3.97,5.88,7.45,8.83,10.19,11.22,12.37,13.65,14.94,15.59,16.11,16.57,16.73,16.57,16.5,15.62,14.42,13.01],[4.02,5.97,7.61,9.0,10.33,11.53,12.8,14.09,15.49,16.12,16.75,17.46,17.63,17.46,17.28,16.13,15.14,13.62],[4.01,5.91,7.55,9.07,10.41,11.71,13.11,14.62,15.79,16.57,17.32,18.01,18.19,18.01,17.76,16.66,15.66,14.13],[3.96,5.85,7.42,9.04,10.45,11.77,13.28,14.94,16.13,17.06,17.78,18.5,18.68,18.5,18.2,17.18,16.16,14.63],[3.93,5.82,7.35,8.97,10.4,11.73,13.27,15.02,16.3,17.33,18.01,18.67,18.86,18.61,18.34,17.34,16.35,14.87],[3.93,5.81,7.31,8.92,10.27,11.61,13.2,15.05,16.48,17.52,18.2,18.86,19.12,18.72,18.44,17.51,16.54,15.13],[3.91,5.8,7.26,8.88,10.11,11.45,13.09,15.07,16.51,17.7,18.51,19.11,19.36,18.86,18.67,17.72,16.79,15.44],[3.91,5.8,7.23,8.87,9.98,11.3,12.99,15.0,16.48,17.88,18.7,19.22,19.52,18.94,18.77,17.85,16.95,15.64],[3.9,5.8,7.18,8.87,9.88,11.2,12.88,14.89,16.3,17.94,18.88,19.4,19.73,19.02,18.88,17.99,17.1,15.84],[3.84,5.73,7.13,8.8,9.76,11.14,12.72,14.59,15.98,17.85,18.95,19.66,20.01,19.11,18.99,18.12,17.27,16.09],[3.7,5.52,7.09,8.57,9.7,11.09,12.71,14.44,15.79,17.5,18.63,19.51,19.93,19.01,18.77,18.11,17.31,16.25],[3.47,5.33,6.84,8.34,9.56,11.04,12.7,14.46,15.67,17.27,18.42,19.02,19.31,18.9,18.7,18.11,17.36,16.38],[3.33,5.23,6.76,8.21,9.52,11.02,12.7,14.42,15.67,17.21,18.33,18.92,19.13,18.83,18.48,18.08,17.33,16.36],[3.18,5.08,6.64,8.08,9.46,10.98,12.66,14.35,15.67,17.21,18.32,18.8,18.93,18.74,18.28,17.93,17.28,16.34],[2.84,5.02,6.59,8.02,9.39,10.91,12.64,14.3,15.67,17.22,18.25,18.76,18.88,18.71,18.19,17.97,17.26,16.34],[2.5,4.95,6.51,7.95,9.32,10.82,12.6,14.26,15.66,17.2,18.24,18.68,18.82,18.7,18.11,17.95,17.23,16.33],[2.35,4.65,6.32,7.77,9.14,10.64,12.49,14.11,15.59,17.17,18.25,18.6,18.73,18.61,17.98,17.83,17.14,16.3],[2.22,4.28,6.02,7.58,8.93,10.44,12.35,13.96,15.52,17.1,18.19,18.57,18.68,18.51,17.84,17.71,17.05,16.26],[2.09,3.94,5.25,7.31,8.7,10.25,12.16,13.72,15.42,16.96,18.12,18.46,18.51,18.44,17.62,17.52,16.91,16.18],[1.96,3.34,5.25,7.08,8.45,9.98,11.77,13.35,15.2,16.68,17.96,18.15,18.29,18.29,17.37,17.3,16.73,16.08],[1.84,3.08,4.78,6.51,8.13,9.66,11.43,12.96,14.82,16.2,17.51,17.69,17.95,18.07,17.06,17.05,16.52,15.97],[1.7,2.87,4.41,5.96,7.14,9.09,10.82,12.14,14.06,15.49,16.61,16.82,16.75,17.32,16.36,16.45,16.08,15.79],[1.54,2.5,3.39,5.0,6.1,6.96,7.43,8.93,10.36,13.03,14.28,12.12,12.12,14.36,12.47,13.09,13.31,14.18],[1.24,2.0,2.66,4.25,5.04,5.68,6.15,6.9,8.12,10.28,10.74,6.96,6.96,7.08,7.66,8.52,9.15,10.67],[1.17,1.86,2.47,3.65,4.3,4.87,5.26,5.67,6.67,8.45,8.44,4.8,4.8,4.8,5.78,6.88,7.8,9.85]]}},\"tang\":{\"n\":\"Tanguy (EKINOX)\",\"d\":{\"tws\":[4.0,6.0,8.0,10.0,12.0,14.0,16.0,18.0,20.0,22.0,24.0,26.0,28.0,30.0,32.0,34.0,36.0,40.0],\"twa\":[40.0,44.0,45.0,46.0,48.0,50.0,52.0,54.0,56.0,58.0,60.0,65.0,70.0,73.0,76.0,80.0,85.0,90.0,95.0,100.0,103.0,106.0,110.0,113.0,116.0,120.0,125.0,130.0,132.0,134.0,135.0,136.0,138.0,140.0,142.0,144.0,146.0,150.0,160.0,170.0,180.0],\"grid\":[[0.98,2.13,3.81,5.03,5.73,5.8,6.89,6.69,7.24,7.61,7.67,7.62,7.62,7.62,6.92,6.34,5.58,4.22],[1.13,2.45,4.19,5.55,6.39,6.81,7.54,7.61,7.78,8.45,8.69,8.46,8.46,8.46,7.71,7.09,6.25,4.76],[1.21,2.53,4.29,5.64,6.5,7.09,7.73,7.95,8.18,8.66,8.82,8.62,8.68,8.63,7.91,7.29,6.44,4.95],[1.27,2.61,4.4,5.79,6.64,7.4,7.89,8.32,8.64,8.82,8.97,8.91,8.94,8.85,8.31,7.74,6.64,5.15],[1.33,2.75,4.6,6.12,7.02,7.88,8.3,8.63,8.95,9.21,9.29,9.46,9.59,9.53,9.41,9.07,7.23,5.57],[1.32,2.9,4.87,6.56,7.35,8.23,8.7,9.03,9.37,9.57,9.78,9.92,10.18,10.2,10.07,9.88,8.35,6.0],[1.43,3.05,5.29,7.06,7.71,8.58,9.08,9.38,9.75,10.02,10.25,10.37,10.54,10.56,10.49,10.23,9.35,6.44],[1.56,3.25,5.7,7.43,7.9,8.78,9.35,9.76,10.11,10.46,10.68,10.75,10.88,10.91,10.85,10.66,9.82,6.93],[1.71,3.48,6.01,7.59,8.11,8.98,9.62,10.07,10.51,10.91,11.06,11.18,11.27,11.3,11.25,11.1,10.22,7.54],[1.9,3.75,6.26,7.74,8.3,9.17,9.88,10.39,10.87,11.32,11.51,11.64,11.69,11.72,11.64,11.51,10.6,8.33],[2.09,4.08,6.45,7.87,8.5,9.37,10.14,10.75,11.23,11.7,11.94,12.03,12.1,12.13,12.09,11.96,11.03,8.83],[2.58,4.97,6.69,8.13,8.9,9.9,10.7,11.5,12.08,12.65,12.94,13.03,13.03,13.13,13.09,12.87,11.94,9.73],[3.24,5.26,6.84,8.32,9.31,10.3,11.12,12.17,12.95,13.56,13.88,13.95,13.99,14.07,14.02,13.77,12.87,10.78],[3.45,5.38,6.95,8.42,9.52,10.48,11.38,12.48,13.42,14.04,14.42,14.46,14.51,14.57,14.51,14.26,13.35,11.27],[3.65,5.53,7.01,8.5,9.71,10.66,11.6,12.79,13.88,14.48,14.89,14.97,15.03,15.11,14.99,14.62,13.71,11.77],[3.82,5.7,7.17,8.63,9.92,10.89,12.0,13.15,14.42,15.04,15.4,15.7,15.75,15.78,15.73,15.11,13.97,12.38],[3.97,5.88,7.3,8.83,10.19,11.22,12.37,13.65,14.94,15.59,16.11,16.57,16.73,16.57,16.5,15.62,14.42,13.01],[4.02,5.97,7.46,9.0,10.33,11.53,12.8,14.09,15.49,16.12,16.75,17.46,17.63,17.46,17.28,16.13,15.14,13.62],[4.01,5.91,7.4,9.07,10.41,11.71,13.11,14.62,15.79,16.57,17.32,18.01,18.19,18.01,17.76,16.66,15.66,14.13],[3.96,5.85,7.27,9.04,10.45,11.77,13.28,14.94,16.13,17.06,17.78,18.5,18.68,18.5,18.2,17.18,16.16,14.63],[3.93,5.82,7.21,8.97,10.4,11.73,13.27,15.02,16.3,17.33,18.01,18.67,18.86,18.61,18.34,17.34,16.35,14.87],[3.93,5.81,7.17,8.92,10.27,11.61,13.2,15.05,16.48,17.52,18.2,18.86,19.12,18.72,18.44,17.51,16.54,15.13],[3.91,5.8,7.12,8.88,10.11,11.45,13.09,15.07,16.51,17.7,18.51,19.11,19.36,18.86,18.67,17.72,16.79,15.44],[3.91,5.8,7.09,8.87,9.98,11.3,12.99,15.0,16.48,17.88,18.7,19.22,19.52,18.94,18.77,17.85,16.95,15.64],[3.9,5.8,7.04,8.87,9.88,11.2,12.88,14.89,16.3,17.94,18.88,19.4,19.73,19.02,18.88,17.99,16.76,15.53],[3.8,5.73,6.99,8.8,9.76,11.14,12.72,14.59,15.98,17.85,18.95,19.66,20.01,19.11,18.99,18.12,16.93,15.77],[3.25,5.02,6.95,8.49,9.6,11.09,12.71,14.44,15.79,17.5,18.63,19.51,19.93,19.01,18.77,18.11,16.97,15.93],[2.83,4.43,6.71,8.26,9.47,11.04,12.7,14.46,15.67,17.27,18.42,19.02,19.31,18.9,18.7,18.11,17.02,16.06],[2.71,3.95,5.21,8.13,9.33,11.02,12.7,14.42,15.67,17.21,18.33,18.92,19.13,18.83,18.48,18.08,16.99,16.04],[2.59,3.14,4.12,7.92,9.33,10.98,12.66,14.35,15.67,17.21,18.32,18.8,18.74,18.74,18.28,17.93,16.94,16.02],[2.31,3.07,4.09,7.26,9.17,10.91,12.64,14.3,15.67,17.22,18.25,18.57,18.69,18.71,18.19,17.97,16.92,16.02],[2.04,2.97,4.45,7.2,8.99,10.82,12.6,14.26,15.66,17.2,18.24,18.5,18.63,18.7,18.11,17.95,16.89,16.01],[2.01,2.79,4.32,7.03,8.65,10.64,12.49,14.11,15.59,17.17,18.25,18.42,18.54,18.61,17.98,17.83,16.8,15.98],[2.09,2.57,4.11,6.86,7.65,10.54,12.35,13.96,15.21,17.1,18.19,18.39,18.5,18.22,16.22,16.1,16.78,15.54],[1.97,2.36,4.34,6.75,7.45,10.25,12.16,13.72,14.38,16.96,18.12,18.28,18.33,16.76,16.02,15.93,13.98,12.16],[1.85,2.07,4.77,6.67,7.16,9.98,11.89,13.35,14.04,16.51,17.96,17.97,18.11,16.63,15.79,15.73,13.83,12.08],[1.84,2.09,4.35,6.13,6.89,9.66,11.43,12.96,13.82,15.72,17.51,17.87,17.77,16.43,15.51,15.5,13.65,12.0],[1.7,2.16,4.01,5.96,6.05,9.09,10.82,12.14,13.11,15.18,16.61,16.99,17.09,15.75,14.87,14.95,13.29,11.86],[1.54,2.5,3.08,5.0,6.1,6.96,7.43,8.93,10.36,13.03,14.28,12.12,12.12,14.36,12.47,13.09,13.31,11.72],[1.24,2.0,2.66,4.25,5.04,5.68,6.15,6.9,8.12,10.28,10.74,6.96,6.96,7.08,7.66,8.52,9.15,10.67],[1.17,1.86,2.47,3.65,4.3,4.87,5.26,5.67,6.67,8.45,8.44,4.8,4.8,4.8,5.78,6.88,7.8,9.85]]}},\"avg\":{\"n\":\"Moyenne (EKINOX)\",\"d\":{\"tws\":[4.0,6.0,8.0,10.0,12.0,14.0,16.0,18.0,20.0,22.0,24.0,26.0,28.0,30.0,32.0,34.0,36.0,40.0],\"twa\":[40.0,44.0,45.0,46.0,48.0,50.0,52.0,54.0,56.0,58.0,60.0,65.0,70.0,73.0,76.0,80.0,85.0,90.0,95.0,100.0,103.0,106.0,110.0,113.0,116.0,120.0,125.0,130.0,132.0,134.0,135.0,136.0,138.0,140.0,142.0,144.0,146.0,150.0,160.0,170.0,180.0],\"grid\":[[0.98,2.13,3.81,5.03,5.73,5.8,6.89,6.69,7.24,7.61,7.67,7.62,7.62,7.62,6.92,6.34,5.58,4.22],[1.13,2.45,4.19,5.55,6.39,6.81,7.54,7.61,7.78,8.45,8.69,8.46,8.46,8.46,7.71,7.09,6.25,4.76],[1.21,2.53,4.29,5.67,6.54,7.09,7.73,7.95,8.18,8.66,8.87,8.66,8.68,8.63,7.91,7.29,6.44,4.95],[1.27,2.61,4.4,5.82,6.67,7.4,7.89,8.32,8.64,8.82,9.02,8.96,8.94,8.85,8.31,7.74,6.64,5.15],[1.33,2.75,4.6,6.15,7.05,7.88,8.3,8.63,8.95,9.21,9.34,9.51,9.59,9.53,9.41,9.07,7.23,5.57],[1.32,2.9,4.87,6.59,7.38,8.23,8.7,9.03,9.37,9.57,9.83,9.97,10.18,10.2,10.07,9.88,8.35,6.0],[1.43,3.05,5.29,7.09,7.71,8.58,9.08,9.38,9.75,10.02,10.25,10.37,10.54,10.56,10.49,10.23,9.26,6.44],[1.56,3.25,5.7,7.43,7.9,8.78,9.35,9.76,10.11,10.46,10.68,10.75,10.88,10.91,10.85,10.66,9.82,6.93],[1.71,3.48,6.01,7.59,8.11,8.98,9.62,10.07,10.51,10.91,11.06,11.18,11.27,11.3,11.25,11.1,10.22,7.54],[1.9,3.75,6.26,7.74,8.3,9.17,9.88,10.39,10.87,11.32,11.51,11.64,11.69,11.72,11.64,11.51,10.6,8.33],[2.09,4.08,6.45,7.87,8.5,9.37,10.14,10.75,11.23,11.7,11.94,12.03,12.1,12.13,12.09,11.96,11.03,8.83],[2.58,4.97,6.69,8.13,8.9,9.9,10.7,11.5,12.08,12.65,12.94,13.03,13.03,13.13,13.09,12.87,11.94,9.73],[3.24,5.26,6.84,8.32,9.31,10.3,11.12,12.17,12.95,13.56,13.88,13.95,13.99,14.07,14.02,13.77,12.87,10.78],[3.45,5.38,6.95,8.42,9.52,10.48,11.38,12.48,13.42,14.04,14.42,14.46,14.51,14.57,14.51,14.26,13.35,11.27],[3.65,5.53,7.08,8.5,9.71,10.66,11.6,12.79,13.88,14.48,14.89,14.97,15.03,15.11,14.99,14.62,13.71,11.77],[3.82,5.7,7.24,8.63,9.92,10.89,12.0,13.15,14.42,15.04,15.4,15.7,15.75,15.78,15.73,15.11,13.97,12.38],[3.97,5.88,7.38,8.83,10.19,11.22,12.37,13.65,14.94,15.59,16.11,16.57,16.73,16.57,16.5,15.62,14.42,13.01],[4.02,5.97,7.54,9.0,10.33,11.53,12.8,14.09,15.49,16.12,16.75,17.46,17.63,17.46,17.28,16.13,15.14,13.62],[4.01,5.91,7.47,9.07,10.41,11.71,13.11,14.62,15.79,16.57,17.32,18.01,18.19,18.01,17.76,16.66,15.66,14.13],[3.96,5.85,7.34,9.04,10.45,11.77,13.28,14.94,16.13,17.06,17.78,18.5,18.68,18.5,18.2,17.18,16.16,14.63],[3.93,5.82,7.28,8.97,10.4,11.73,13.27,15.02,16.3,17.33,18.01,18.67,18.86,18.61,18.34,17.34,16.35,14.87],[3.93,5.81,7.24,8.92,10.27,11.61,13.2,15.05,16.48,17.52,18.2,18.86,19.12,18.72,18.44,17.51,16.54,15.13],[3.91,5.8,7.19,8.88,10.11,11.45,13.09,15.07,16.51,17.7,18.51,19.11,19.36,18.86,18.67,17.72,16.79,15.44],[3.91,5.8,7.16,8.87,9.98,11.3,12.99,15.0,16.48,17.88,18.7,19.22,19.52,18.94,18.77,17.85,16.95,15.64],[3.9,5.8,7.11,8.87,9.88,11.2,12.88,14.89,16.3,17.94,18.88,19.4,19.73,19.02,18.88,17.99,16.93,15.68],[3.82,5.73,7.06,8.8,9.76,11.14,12.72,14.59,15.98,17.85,18.95,19.66,20.01,19.11,18.99,18.12,17.1,15.93],[3.48,5.27,7.02,8.53,9.65,11.09,12.71,14.44,15.79,17.5,18.63,19.51,19.93,19.01,18.77,18.11,17.14,16.09],[3.15,4.88,6.78,8.3,9.52,11.04,12.7,14.46,15.67,17.27,18.42,19.02,19.31,18.9,18.7,18.11,17.19,16.22],[3.02,4.59,5.98,8.17,9.43,11.02,12.7,14.42,15.67,17.21,18.33,18.92,19.13,18.83,18.48,18.08,17.16,16.2],[2.88,4.11,5.38,8.0,9.39,10.98,12.66,14.35,15.67,17.21,18.32,18.8,18.84,18.74,18.28,17.93,17.11,16.18],[2.58,4.04,5.34,7.64,9.28,10.91,12.64,14.3,15.67,17.22,18.25,18.66,18.79,18.71,18.19,17.97,17.09,16.18],[2.27,3.96,5.48,7.58,9.16,10.82,12.6,14.26,15.66,17.2,18.24,18.59,18.73,18.7,18.11,17.95,17.06,16.17],[2.18,3.72,5.32,7.4,8.89,10.64,12.49,14.11,15.59,17.17,18.25,18.51,18.63,18.61,17.98,17.83,16.97,16.14],[2.16,3.42,5.06,7.22,8.29,10.49,12.35,13.96,15.37,17.1,18.19,18.48,18.59,18.37,17.03,16.91,16.91,15.9],[2.03,3.15,4.79,7.03,8.07,10.25,12.16,13.72,14.9,16.96,18.12,18.37,18.42,17.6,16.82,16.73,15.45,14.17],[1.91,2.71,5.01,6.88,7.8,9.98,11.83,13.35,14.62,16.59,17.96,18.06,18.2,17.46,16.58,16.52,15.28,14.08],[1.84,2.58,4.56,6.32,7.51,9.66,11.43,12.96,14.32,15.96,17.51,17.78,17.86,17.25,16.29,16.27,15.09,13.98],[1.7,2.52,4.21,5.96,6.59,9.09,10.82,12.14,13.59,15.34,16.61,16.91,16.92,16.54,15.61,15.7,14.68,13.82],[1.54,2.5,3.24,5.0,6.1,6.96,7.43,8.93,10.36,13.03,14.28,12.12,12.12,14.36,12.47,13.09,13.31,12.95],[1.24,2.0,2.66,4.25,5.04,5.68,6.15,6.9,8.12,10.28,10.74,6.96,6.96,7.08,7.66,8.52,9.15,10.67],[1.17,1.86,2.47,3.65,4.3,4.87,5.26,5.67,6.67,8.45,8.44,4.8,4.8,4.8,5.78,6.88,7.8,9.85]]}},\"v3\":{\"n\":\"v3 (EKINOX)\",\"d\":{\"tws\":[4.0,6.0,8.0,10.0,12.0,14.0,16.0,18.0,20.0,22.0,24.0,26.0,28.0,30.0,32.0,34.0,36.0,40.0],\"twa\":[40.0,44.0,45.0,46.0,48.0,50.0,52.0,54.0,56.0,58.0,60.0,65.0,70.0,73.0,76.0,80.0,85.0,90.0,95.0,100.0,103.0,106.0,110.0,113.0,116.0,120.0,125.0,130.0,132.0,134.0,135.0,136.0,138.0,140.0,142.0,144.0,146.0,150.0,160.0,170.0,180.0],\"grid\":[[0.98,2.13,3.81,5.03,5.73,5.8,6.89,6.69,7.24,7.61,7.67,7.62,7.62,7.62,6.92,6.34,5.58,4.22],[1.13,2.45,4.19,5.55,6.39,6.81,7.54,7.61,7.78,8.45,8.69,8.46,8.46,8.46,7.71,7.09,6.25,4.76],[1.21,2.53,4.29,5.7,6.57,7.09,7.73,7.95,8.18,8.66,8.91,8.71,8.68,8.63,7.91,7.29,6.44,4.95],[1.27,2.61,4.4,5.85,6.71,7.4,7.89,8.32,8.64,8.82,9.06,9.0,8.94,8.85,8.31,7.74,6.64,5.15],[1.33,2.75,4.6,6.18,7.09,7.88,8.3,8.63,8.95,9.21,9.38,9.55,9.59,9.53,9.41,9.07,7.23,5.57],[1.32,2.9,4.87,6.63,7.42,8.23,8.7,9.03,9.37,9.57,9.88,10.02,10.18,10.2,10.07,9.88,8.35,6.0],[1.43,3.05,5.29,7.13,7.71,8.58,9.08,9.38,9.75,10.02,10.25,10.37,10.54,10.56,10.49,10.23,9.17,6.44],[1.56,3.25,5.7,7.43,7.9,8.78,9.35,9.76,10.11,10.46,10.68,10.75,10.88,10.91,10.85,10.66,9.82,6.93],[1.71,3.48,6.01,7.59,8.11,8.98,9.62,10.07,10.51,10.91,11.06,11.18,11.27,11.3,11.25,11.1,10.22,7.54],[1.9,3.75,6.26,7.74,8.3,9.17,9.88,10.39,10.87,11.32,11.51,11.64,11.69,11.72,11.64,11.51,10.6,8.33],[2.09,4.08,6.45,7.87,8.5,9.37,10.14,10.75,11.23,11.7,11.94,12.03,12.1,12.13,12.09,11.96,11.03,8.83],[2.58,4.97,6.69,8.13,8.9,9.9,10.7,11.5,12.08,12.65,12.94,13.03,13.03,13.13,13.09,12.87,11.94,9.73],[3.24,5.26,6.84,8.32,9.31,10.3,11.12,12.17,12.95,13.56,13.88,13.95,13.99,14.07,14.02,13.77,12.87,10.78],[3.45,5.38,6.95,8.42,9.52,10.48,11.38,12.48,13.42,14.04,14.42,14.46,14.51,14.57,14.51,14.26,13.35,11.27],[3.65,5.53,7.15,8.5,9.71,10.66,11.6,12.79,13.88,14.48,14.89,14.97,15.03,15.11,14.99,14.62,13.71,11.77],[3.82,5.7,7.31,8.63,9.92,10.89,12.0,13.15,14.42,15.04,15.4,15.7,15.75,15.78,15.73,15.11,13.97,12.38],[3.97,5.88,7.45,8.83,10.19,11.22,12.37,13.65,14.94,15.59,16.11,16.57,16.73,16.57,16.5,15.62,14.42,13.01],[4.02,5.97,7.61,9.0,10.33,11.53,12.8,14.09,15.49,16.12,16.75,17.46,17.63,17.46,17.28,16.13,15.14,13.62],[4.01,5.91,7.55,9.07,10.41,11.71,13.11,14.62,15.79,16.57,17.32,18.01,18.19,18.01,17.76,16.66,15.66,14.13],[3.96,5.85,7.42,9.04,10.45,11.77,13.28,14.94,16.13,17.06,17.78,18.5,18.68,18.5,18.2,17.18,16.16,14.63],[3.93,5.82,7.35,8.97,10.4,11.73,13.27,15.02,16.3,17.33,18.01,18.67,18.86,18.61,18.34,17.34,16.35,14.87],[3.93,5.81,7.31,8.92,10.27,11.61,13.2,15.05,16.48,17.52,18.2,18.86,19.12,18.72,18.44,17.51,16.54,15.13],[3.91,5.8,7.26,8.88,10.11,11.45,13.09,15.07,16.51,17.7,18.51,19.11,19.36,18.86,18.67,17.72,16.79,15.44],[3.91,5.8,7.23,8.87,9.98,11.3,12.99,15.0,16.48,17.88,18.7,19.22,19.52,18.94,18.77,17.85,16.95,15.64],[3.9,5.8,7.18,8.87,9.88,11.2,12.88,14.89,16.3,17.94,18.88,19.4,19.73,19.02,18.88,17.99,17.1,15.84],[3.84,5.73,7.13,8.8,9.76,11.14,12.72,14.59,15.98,17.85,18.95,19.66,20.01,19.11,18.99,18.12,17.27,16.09],[3.7,5.52,7.09,8.57,9.7,11.09,12.71,14.44,15.79,17.5,18.63,19.51,19.93,19.01,18.77,18.11,17.31,16.25],[3.47,5.33,6.84,8.34,9.56,11.04,12.7,14.46,15.67,17.27,18.42,19.02,19.31,18.9,18.7,18.11,17.36,16.38],[3.33,5.23,6.76,8.21,9.52,11.02,12.7,14.42,15.67,17.21,18.33,18.92,19.13,18.83,18.48,18.08,17.33,16.36],[3.18,5.08,6.64,8.08,9.46,10.98,12.66,14.35,15.67,17.21,18.32,18.8,18.93,18.74,18.28,17.93,17.28,16.34],[2.84,5.02,6.59,8.02,9.39,10.91,12.64,14.3,15.67,17.22,18.25,18.76,18.88,18.71,18.19,17.97,17.26,16.34],[2.5,4.95,6.51,7.95,9.32,10.82,12.6,14.26,15.66,17.2,18.24,18.68,18.82,18.7,18.11,17.95,17.23,16.33],[2.35,4.65,6.32,7.77,9.14,10.64,12.49,14.11,15.59,17.17,18.25,18.6,18.73,18.61,17.98,17.83,17.14,16.3],[2.22,4.28,6.02,7.58,8.93,10.44,12.35,13.96,15.52,17.1,18.19,18.57,18.68,18.51,17.84,17.71,17.05,16.26],[2.09,3.94,5.25,7.31,8.7,10.25,12.16,13.72,15.42,16.96,18.12,18.46,18.51,18.44,17.62,17.52,16.91,16.18],[1.96,3.34,5.25,7.08,8.45,9.98,11.77,13.35,15.2,16.68,17.96,18.15,18.29,18.29,17.37,17.3,16.73,16.08],[1.84,3.08,4.78,6.51,8.13,9.66,11.43,12.96,14.82,16.2,17.51,17.69,17.95,18.07,17.06,17.05,16.52,15.97],[1.7,2.87,4.41,5.96,7.14,9.09,10.82,12.14,14.06,15.49,16.61,16.82,16.75,17.32,16.36,16.45,16.08,15.79],[1.54,2.5,3.39,5.0,6.1,6.96,7.43,8.93,10.36,13.03,14.28,12.12,12.12,14.36,12.47,13.09,13.31,14.18],[1.24,2.0,2.66,4.25,5.04,5.68,6.15,6.9,8.12,10.28,10.74,6.96,6.96,7.08,7.66,8.52,9.15,10.67],[1.17,1.86,2.47,3.65,4.3,4.87,5.26,5.67,6.67,8.45,8.44,4.8,4.8,4.8,5.78,6.88,7.8,9.85]]}}};\n";
/* Polaires disponibles cote serveur pour le calcul de % de polaire : on
   reutilise le fichier deja embarque pour le routeur (source unique). */
let POLAIRES_SERVEUR = {};
try {
  const mPol = /POLAIRES_PRESETS=([\s\S]*);\s*$/.exec(PAGE_ROUTEUR_POLAIRES);
  const brut = JSON.parse(mPol[1]);
  for (const k in brut) POLAIRES_SERVEUR[k] = brut[k].d;
} catch { POLAIRES_SERVEUR = {}; }
/* interpolation bilineaire, identique a celle du routeur et d'EKINOX */
function polarSpeedServeur(P, tws, twa) {
  if (!P || !P.grid) return 0;
  twa = Math.abs(((twa + 180) % 360 + 360) % 360 - 180);
  const idx = (g, x) => {
    const n = g.length;
    if (x <= g[0]) return [0, 0, 0];
    if (x >= g[n - 1]) return [n - 1, n - 1, 0];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g[m] <= x) lo = m; else hi = m; }
    return [lo, hi, (x - g[lo]) / (g[hi] - g[lo])];
  };
  const a = idx(P.twa, twa), w = idx(P.tws, tws), G = P.grid;
  return (G[a[0]][w[0]] * (1 - w[2]) + G[a[0]][w[1]] * w[2]) * (1 - a[2])
       + (G[a[1]][w[0]] * (1 - w[2]) + G[a[1]][w[1]] * w[2]) * a[2];
}
const PAGE_FLEET = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Suivi de flotte</title>
<link rel="stylesheet" href="/vendor/leaflet.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.css">
<style>
  #veille{position:fixed;top:calc(env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);z-index:1600;display:none;max-width:92vw;background:#3a2703;border:2px solid #f59e0b;color:#fde68a;border-radius:12px;padding:9px 14px;font-size:13px;font-weight:600;line-height:1.5;box-shadow:0 4px 18px rgba(0,0,0,.45)}
  #veille .off{color:#fbbf24;margin-right:6px}
  #veille .sub{display:block;font-weight:400;font-size:11.5px;color:#d9b96a}
  #windCtl{position:fixed;left:8px;z-index:1200;display:none;background:var(--panel);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:10px;padding:8px 10px;bottom:calc(env(safe-area-inset-bottom) + 60px)}
  #windCtl select{background:#0a1e2c;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:5px 7px;font-size:12px;margin-right:6px}
  #windCtl .t{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:5px}
  :root{--navy:#0a1a26;--panel:rgba(10,26,38,.92);--line:#1d3a4d;--amber2:#ffc25a;--ink:#e8f1f6;--dim:#8fb0c2}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--navy);color:var(--ink)}
  #map{position:absolute;inset:0}
  .bar{position:fixed;top:calc(env(safe-area-inset-top) + 8px);left:8px;z-index:1200;background:var(--panel);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:12px;padding:8px 12px;max-width:70vw}
  .bar b{font-size:14px}
  .bar .sub{font-size:11px;color:var(--dim)}
  #legend .lgi span:nth-child(2){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #legend .lgi{display:flex;align-items:center;gap:7px}
  #legend .lgh{position:sticky;top:-8px;background:var(--panel);padding:2px 0 5px;z-index:2}
  #legend .sp{flex:0 0 auto;white-space:nowrap;font-size:11px}
  #legend{position:fixed;right:8px;bottom:calc(env(safe-area-inset-bottom) + 8px);z-index:1200;background:var(--panel);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:12px;padding:8px 10px;max-height:46vh;overflow:auto;min-width:190px;max-width:68vw}
  .lgh{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:6px}
  .lgi{display:flex;align-items:center;gap:7px;padding:3px 0;font-size:13px;cursor:pointer}
  .dot{width:11px;height:11px;border-radius:50%;border:1px solid #fff;flex:0 0 auto}
  .sp{margin-left:auto;color:var(--amber2);font-variant-numeric:tabular-nums;font-size:12px}
  .fitbtn{position:fixed;left:8px;bottom:calc(env(safe-area-inset-bottom) + 8px);z-index:1200;background:var(--panel);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:10px;color:var(--ink);padding:9px 12px;font-size:13px;cursor:pointer}
  .leaflet-container{background:#0a1a26}
  .leaflet-top.leaflet-left{margin-top:calc(env(safe-area-inset-top) + 58px)}
  .lyrbtn{position:fixed;top:calc(env(safe-area-inset-top) + 8px);right:8px;z-index:1500;
    width:46px;height:46px;border-radius:12px;background:rgba(14,38,54,.94);backdrop-filter:blur(8px);
    border:1px solid var(--line);color:var(--ink);font-size:19px;line-height:1;cursor:pointer;
    display:flex;align-items:center;justify-content:center;padding:0}
  .lyrbtn:active{transform:scale(.95)}
  .lyrpanel{position:fixed;top:calc(env(safe-area-inset-top) + 60px);right:8px;z-index:1500;
    background:rgba(14,38,54,.96);backdrop-filter:blur(10px);border:1px solid var(--line);
    border-radius:12px;padding:10px 13px;max-height:68vh;overflow:auto;min-width:212px;max-width:78vw;display:none}
  .lyrpanel.open{display:block}
  .lyrpanel .grp{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:8px 0 3px}
  .lyrpanel .grp:first-child{margin-top:0}
  .lyrpanel label{display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13.5px;cursor:pointer}
  .lyrpanel input{width:17px;height:17px;accent-color:#f5a623;flex:0 0 auto}
  .leaflet-bottom.leaflet-right{margin-bottom:env(safe-area-inset-bottom)}
  .leaflet-control-attribution{font-size:9px;line-height:1.5;background:rgba(10,26,38,.62);color:#8fb0c2;
    padding:1px 7px;margin:0!important;border-radius:8px 0 0 0;max-width:58vw;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;cursor:pointer}
  .leaflet-control-attribution.exp{white-space:normal;max-width:94vw}
  .leaflet-control-attribution a{color:#39c0d3}

  .leaflet-tooltip.boat-name{background:rgba(10,26,38,.78);border:0;color:#fff;font-weight:600;font-size:9.5px;padding:0 5px;border-radius:5px;box-shadow:none;white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis}
  .leaflet-tooltip.boat-name:before{display:none}
  .leaflet-tooltip.boat-name .nav{display:block;font-weight:400;font-size:8.5px;color:#bcd3e0;letter-spacing:.2px}
  .lgh label{text-transform:none;letter-spacing:0;cursor:pointer}
  .lgh input{vertical-align:-1px}
  .lgi.off{opacity:.55}
  .sp.offsp{color:#8fb0c2;font-size:11px;font-variant-numeric:normal}
  .lgexp{margin-top:8px;padding-top:7px;border-top:1px solid var(--line);font-size:11px;color:var(--dim)}
  .lgexp a{color:#39c0d3;text-decoration:none;font-weight:600}
  .del,.fic{margin-left:8px;color:#5f7482;cursor:pointer}
  .del:hover,.del:active{color:#e6584c}
</style>
</head>
<body>
<div id="map"></div>
<div id="veille" role="alert"></div>
<button id="anBtn" title="Analyse de flotte" style="position:fixed;right:14px;top:calc(env(safe-area-inset-top) + 128px);z-index:1500;width:44px;height:44px;border-radius:12px;border:none;background:#0f2233;color:#39c0d3;font-size:19px;box-shadow:0 2px 10px rgba(0,0,0,.4)">\u2263</button>
<div id="anPanneau" style="display:none;position:fixed;left:8px;right:8px;bottom:8px;max-height:62vh;z-index:1600;background:#0d1f2df2;border:1px solid #1d3a52;border-radius:14px;padding:10px;color:#dfeaf2;font-size:12.5px;overflow:auto;-webkit-overflow-scrolling:touch">
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
    <b style="flex:1 1 auto">Analyse de flotte</b>
    <label>lissage <select id="anFen" style="background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:7px;padding:3px"><option value="5">5 min</option><option value="10" selected>10 min</option><option value="30">30 min</option><option value="60">1 h</option></select></label>
    <label>vus depuis <select id="anVus" style="background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:7px;padding:3px"><option value="15">15 min</option><option value="60">1 h</option><option value="180">3 h</option><option value="720">12 h</option><option value="1440">24 h</option><option value="0" selected>tous</option></select></label>
    <label>polaire <select id="anPol" style="background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:7px;padding:3px"><option value="">aucune</option></select></label>
    <button id="anMarque" style="background:#0f2233;color:#39c0d3;border:1px solid #1d3a52;border-radius:8px;padding:5px 8px">Poser la marque</button>
    <button id="anFermer" style="background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:8px;padding:5px 8px">Fermer</button>
  </div>
  <div id="anMsg" style="color:#8fb0c4;margin-bottom:6px">—</div>
  <div id="anTable" style="overflow-x:auto"></div>
</div>
<button id="rtBtn" title="Routage" style="position:fixed;right:14px;top:calc(env(safe-area-inset-top) + 76px);z-index:1500;width:44px;height:44px;border-radius:12px;border:none;background:#0f2233;color:#f59e0b;font-size:20px;box-shadow:0 2px 10px rgba(0,0,0,.4)">\u2388</button>
<div id="rtPanneau" style="display:none;position:fixed;right:14px;top:calc(env(safe-area-inset-top) + 128px);z-index:1500;background:#0d1f2dee;border:1px solid #1d3a52;border-radius:14px;padding:12px;width:250px;color:#dfeaf2;font-size:12.5px;line-height:1.6">
  <div style="font-weight:700;margin-bottom:6px">Routage <span style="opacity:.6;font-weight:400">isochrones</span></div>
  <div>Départ : <span id="rtDep" style="color:#8fb0c4">tap long carte / bateau</span></div>
  <div>Arrivée : <span id="rtArr" style="color:#8fb0c4">tap carte</span></div>
  <select id="rtBateau" style="width:100%;margin:6px 0;background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:8px;padding:5px"><option value="">Départ = un bateau…</option></select>
  <select id="rtPol" style="width:100%;margin:0 0 6px;background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:8px;padding:5px"></select>
  <label style="display:block;margin:0 0 6px;font-size:11px;color:#8fb0c4">Charger une polaire (.pol)<input id="rtPolFichier" type="file" style="display:block;margin-top:3px;width:100%"></label>
  <div style="display:flex;gap:6px;align-items:center;margin:0 0 6px"><span>% polaire</span><input id="rtPct" type="range" min="60" max="110" value="100" style="flex:1"><span id="rtPctV">100</span></div>
  <div style="display:flex;gap:6px">
    <button id="rtGo" style="flex:1;background:#f59e0b;border:none;border-radius:8px;padding:8px;font-weight:700">Calculer</button>
    <button id="rtRaz" style="background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:8px;padding:8px">Effacer</button>
  </div>
  <label style="display:block;margin-top:6px;font-size:11px;color:#8fb0c4">Zones interdites (GPX)<input id="rtGpx" type="file" style="display:block;margin-top:3px;width:100%"></label>
  <div id="rtMsg" style="margin-top:6px;min-height:16px;color:#fbbf24"></div>
  <button id="dgCalques" style="margin-top:8px;width:100%;background:#0f2233;color:#39c0d3;border:1px solid #1d3a52;border-radius:8px;padding:7px;font-size:12px">Diagnostic des calques</button>
  <pre id="dgOut" style="display:none;margin-top:6px;font-size:10.5px;line-height:1.45;color:#dfeaf2;background:#08151d;border:1px solid #1d3a52;border-radius:8px;padding:8px;max-height:38vh;overflow:auto;white-space:pre-wrap;word-break:break-all"></pre>
</div>
<div class="bar"><a href="/admin" id="back" style="display:none;color:#39c0d3;text-decoration:none;font-size:12px;font-weight:600">‹ Console</a><b id="flname">Flotte</b><div class="sub" id="flcount">Connexion…</div>
  <select id="flswitch" style="display:none;margin-top:7px;width:100%;background:#0a1e2c;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 7px;font-size:12px"></select>
</div>
<button class="fitbtn" id="fit">⤢ Tout voir</button>
<div id="legend"><div class="lgh">Flotte</div></div>
<div id="windCtl"><div class="t">Vent — modèle (précision) &amp; échéance</div><select id="windModel"></select><select id="windHour"></select></div>

<script src="/vendor/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.js"></script>
<script src="/carte.js"></script>
<script src="/routeur-polaires.js"></script>
<script src="/routeur.js"></script>
<script src="/config.js"></script>
<script>
"use strict";
window.addEventListener('error',function(ev){
  try{ var el=document.getElementById('flcount');
    if(el&&el.textContent.indexOf('Connexion')===0) el.textContent='Chargement incomplet — recharge la page';
  }catch(e){}
});
var fid=new URLSearchParams(location.search).get('id');
var ADMK=new URLSearchParams(location.search).get('k')||'';
try{ if(!ADMK) ADMK=localStorage.getItem('st_key')||''; }catch(e){}
var $=function(i){return document.getElementById(i);};

/* ---- veille d'un bateau (?moi=<trackId 16 hex ou MMSI 9 chiffres>) ----
   Affiche une banniere ambre quand ce bateau precis est muet au-dela du seuil
   hors-ligne de la flotte. Pense pour verifier d'un coup d'oeil que son propre
   traceur emet toujours (Traccar iOS ne redemarre pas seul apres extinction). */
var MOI=(new URLSearchParams(location.search).get('moi')||'').trim();
var moiId=null;
function resoudreMoi(liste){
  if(!MOI) return;
  if(/^[a-f0-9]{16}$/.test(MOI)){ moiId=MOI; return; }
  if(/^[0-9]{9}$/.test(MOI)){ for(var i=0;i<liste.length;i++){ if(String(liste[i].mmsi||'')===MOI){ moiId=liste[i].id; return; } } }
}
function fmtDuree(ms){
  var mn=Math.floor(ms/60000);
  if(mn<60) return mn+' min';
  var h=Math.floor(mn/60); mn=mn%60;
  return h+' h'+(mn?(' '+(mn<10?'0':'')+mn):'');
}
function majVeille(){
  var el=$('veille'); if(!el) return;
  if(!MOI){ el.style.display='none'; return; }
  if(!moiId){
    el.innerHTML='<span class="off">⚠︎</span>Veille : bateau introuvable dans cette flotte<span class="sub">Paramètre moi='+MOI.replace(/[^a-zA-Z0-9]/g,'')+'</span>';
    el.style.display='block'; return;
  }
  var b=boats[moiId];
  var t=(b&&b.last)?b.last[2]:null;
  if(t===null){
    el.innerHTML='<span class="off">⚠︎</span>'+esc(b?b.name:'Bateau')+' : aucune position reçue<span class="sub">En attente du premier point…</span>';
    el.style.display='block'; return;
  }
  var silence=Date.now()-t;
  if(silence>OFFLINE_MS){
    var quand=new Date(t);
    var hh=(quand.getHours()<10?'0':'')+quand.getHours()+':'+(quand.getMinutes()<10?'0':'')+quand.getMinutes();
    el.innerHTML='<span class="off">⚠︎</span>'+esc(b.name)+' muet depuis '+fmtDuree(silence)
      +'<span class="sub">Dernier point à '+hh+' — vérifier que Traccar émet (rouvrir l\u2019app après toute extinction)</span>';
    el.style.display='block';
  } else {
    el.style.display='none';
  }
}
setInterval(majVeille,30000);

/* ---- bascule entre flottes (console) ---- */
/* retour vers l'espace skipper, si ce bateau est inscrit sur cet appareil */
(function(){
  if(ADMK)return;
  var saved=null; try{ saved=JSON.parse(localStorage.getItem('st_boat_'+fid)||'null'); }catch(e){}
  if(!saved||!saved.id)return;
  var bk=$('back'); if(!bk)return;
  bk.textContent='‹ Mon bateau';
  bk.href='/join?fleet='+fid;
  bk.style.display='block';
})();

if(ADMK){
  var bk=$('back'); if(bk)bk.style.display='block';
  fetch('/api/admin/fleets',{headers:{'x-admin-key':ADMK}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(!d||!d.fleets||d.fleets.length<1)return;
    var sel=$('flswitch');
    sel.innerHTML='<option value="">↔ Changer de flotte…</option>'
      +d.fleets.map(function(f){return '<option value="'+f.id+'"'+(f.id===fid?' selected':'')+'>'+
        String(f.name).replace(/[&<>"]/g,'')+' ('+f.boats+')</option>';}).join('')
      +'<option value="__admin">⚓️ Console des flottes</option>';
    sel.style.display='block';
    sel.onchange=function(){
      if(this.value==='__admin'){location.href='/admin';return;}
      if(this.value&&this.value!==fid)location.href='/vf?id='+this.value;
    };
  }).catch(function(){});
}

var map=L.map('map',{zoomControl:true,worldCopyJump:true,maxZoom:18}).setView([47,-5],6);
map.createPane('windPane');map.getPane('windPane').style.zIndex=550;map.getPane('windPane').style.pointerEvents='none';
/* Plan dedie aux calques meteo : le fond « carte marine » est rendu par
   MapLibre en WebGL, qui se dessine PAR-DESSUS le plan de tuiles standard.
   Les calques OpenWeather y etaient donc invisibles malgre des tuiles
   correctement recues (bug corrige le 31/07/2026). */
map.createPane('meteoPane');map.getPane('meteoPane').style.zIndex=450;map.getPane('meteoPane').style.pointerEvents='none';

installAttrib(map);


/* ---- fonds de carte (identiques au suivi solo) ---- */
/* Esri ne publie l'Ocean Base que jusqu'au zoom 13 : sans maxNativeZoom, Leaflet
   reclame des tuiles inexistantes au-dela et le fond se disloque. Reglages
   identiques a la page de suivi solo. */
var esriOcean=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:13,maxZoom:18,attribution:'Fond océan &copy; Esri'});
var esriOceanRef=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:13,maxZoom:18});
var esriSat=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:18,maxZoom:18,attribution:'Imagerie &copy; Esri'});
var osm=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap'});
var emodnet=L.tileLayer('https://tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator/{z}/{x}/{y}.png',{maxNativeZoom:11,maxZoom:18,attribution:'Bathymétrie &copy; EMODnet'});
var seamark=L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',{maxZoom:18,opacity:.9,attribution:'&copy; OpenSeaMap'});
var shomBalise=L.tileLayer('https://services.data.shom.fr/INSPIRE/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=BALISAGE_PYR_PNG_3857_WMTS&STYLE=normal&TILEMATRIXSET=3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',{maxNativeZoom:17,maxZoom:18,attribution:'Balisage &copy; SHOM'});

var bases={};
try{ if(L.maplibreGL && window.maplibregl) bases['Carte marine (isobathes/sondes)']=L.maplibreGL({style:'https://tiles.openwaters.io/seascape/style.json',attribution:'Fonds &copy; openwaters.io (CC BY 4.0)'}); }catch(e){}
bases['Océan (Esri)']=esriOcean;
bases['Bathymétrie (EMODnet)']=emodnet;
bases['Satellite']=esriSat;
bases['OpenStreetMap']=osm;
var fondDepart=bases['Carte marine (isobathes/sondes)']||esriOcean;
fondDepart.addTo(map);
if(fondDepart===esriOcean) esriOceanRef.addTo(map);
/* libellés océan seulement sur le fond Océan */
map.on('baselayerchange',function(e){
  if(e.layer===esriOcean){ if(!map.hasLayer(esriOceanRef)) esriOceanRef.addTo(map); }
  else if(map.hasLayer(esriOceanRef)){ map.removeLayer(esriOceanRef); }
});
seamark.addTo(map);
/* Calques meteo OpenWeather.
   ATTENTION (correctif du 31/07/2026) : ces calques etaient crees uniquement
   si window.OWM_KEY etait deja definie. Or /config.js, qui porte la cle, est
   un script EXTERNE : selon l'ordre d'execution du navigateur, la cle pouvait
   ne pas encore exister — les calques n'etaient alors jamais construits, et
   les cases du menu ne commandaient rien. Desormais les couches sont toujours
   creees et la cle est lue au moment de composer chaque tuile. */
var weather={};
(function(){
  /* La cle est passee en OPTION : Leaflet substitue lui-meme {cle} depuis
     l'objet d'options. Le 31/07/2026, une substitution maison apres coup
     echouait — Leaflet valide le modele d'URL avant, et refusait la variable
     inconnue ({cle} : « No value provided for variable »), d'ou zero tuile.
     L'option est relue a chaque rafraichissement : si /config.js arrive en
     retard, un simple recochage suffit. */
  /* opacite par calque : « Vent » (wind_new) est une nappe tres pale, presque
     invisible par petit temps ; les quatre autres restent a 0,55. */
  var owm=function(couche,opac){
    return L.tileLayer('https://tile.openweathermap.org/map/'+couche+'/{z}/{x}/{y}.png?appid={cle}',
      {cle:(window.OWM_KEY||''),opacity:(opac||0.55),maxNativeZoom:12,maxZoom:18,pane:'meteoPane',
       attribution:'Météo &copy; OpenWeather'});
  };
  weather['Vent']=L.layerGroup([owm('wind_new',0.55),creerVentFleches(map)]); weather['Pression']=owm('pressure_new');
  weather['Nuages']=owm('clouds_new'); weather['Pluie']=owm('precipitation_new');
  weather['Température']=owm('temp_new');
})();
var windGroup=L.layerGroup();
var overlays=Object.assign({'Balises (OpenSeaMap)':seamark,'Balises SHOM':shomBalise,'Relief fonds Litto3D (Shom)':creerLitto3D(),'Flèches de courant (Shom)':creerCourantsLayer(map),'Vent animé (Open‑Meteo)':windGroup},weather);
/* ---- menu des calques (maison : ouverture au tap, indépendant de Leaflet) ---- */
var layerCtl = installLayerMenu(map, bases, overlays);
assurerCarteMarine(map, layerCtl, bases);
rtInit(map, layerCtl);
(function(){
  var $a=function(i){return document.getElementById(i);};
  if(!$a('anBtn')) return;              /* isolation : pas de panneau, pas de code actif */
  var marque=null, marqueMk=null, tri='vmc', sens=-1, poserMarque=false, timer=null;
  function fmt(v,n){ return (v===null||v===undefined)?'—':Number(v).toFixed(n===undefined?1:n).replace('.',','); }
  var dernier=null;
  function charger(){
    var q='/api/fleets/'+fid+'/analyse?fenetre='+$a('anFen').value;
    if(marque) q+='&mlat='+marque.lat.toFixed(5)+'&mlon='+marque.lng.toFixed(5);
    if($a('anPol').value) q+='&polaire='+encodeURIComponent($a('anPol').value);
    fetch(q).then(function(r){return r.json();}).then(function(d){
      if(d.error){$a('anMsg').textContent=d.error;return;}
      dernier=d; rendre(d);
    }).catch(function(){$a('anMsg').textContent='Analyse indisponible';});
  }
  function rendre(d){
    var bs=d.bateaux.filter(function(b){return !b.vide;});
    var seuil=parseInt($a('anVus').value,10)||0;   /* 0 = pas de filtre */
    var total=bs.length;
    if(seuil>0) bs=bs.filter(function(b){return b.ageMin!==null&&b.ageMin!==undefined&&b.ageMin<=seuil;});
    var masques=total-bs.length;
    $a('anMsg').textContent=bs.length+' bateau(x)'+(masques?(' · '+masques+' masqué'+(masques>1?'s':'')+' (trop ancien'+(masques>1?'s':'')+')'):'')+' · lissage '+d.fenetreMin+' min'
      +(marque?' · marque posée':' · pose une marque pour le VMC')
      +(d.vent?(' · vent '+Math.round(d.vent.tws)+' kt '+Math.round(d.vent.twd)+'° (barycentre)'):'')
      +(d.polaire?(' · polaire '+d.polaire):'')
      +((function(){var e=bs.filter(function(x){return x.elargie;}).length, br=bs.filter(function(x){return x.brut;}).length;
          var t=[]; if(e)t.push(e+' élargi'+(e>1?'s':'')+' (~)'); if(br)t.push(br+' brut'+(br>1?'s':'')+' (*)');
          return t.length?(' · '+t.join(', ')):''; })());
    if(!bs.length){$a('anTable').innerHTML='<div style="color:#8fb0c4">'+(masques?'Aucun bateau vu depuis moins de '+(seuil<60?seuil+' min':(seuil/60)+' h')+' — élargis « vus depuis ».':'Aucune position reçue.')+'</div>';return;}
    bs.sort(function(x,y){
      var a=x[tri], b=y[tri];
      if(a===undefined||a===null)return 1; if(b===undefined||b===null)return -1;
      return (a<b?-1:a>b?1:0)*sens;
    });
    var cols=[['rang','#',0],['nom','Bateau',null],['sogLisse','Fond',1],['sogSurface','Surf.',1],['pctPolaire','%pol',0],['cmg','CMG',0],['vmc','VMC',1],['distMarque','Dist.',1],['ecartMeneurNm','Écart',1],['ageMin','Vu',0]];
    var h='<table style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums"><thead><tr>';
    cols.forEach(function(c){
      h+='<th data-col="'+c[0]+'" style="text-align:'+(c[0]==='nom'?'left':'right')+';padding:4px 5px;border-bottom:1px solid #1d3a52;color:#39c0d3;cursor:pointer;white-space:nowrap">'+c[1]+(tri===c[0]?(sens>0?' ▲':' ▼'):'')+'</th>';
    });
    h+='</tr></thead><tbody>';
    bs.forEach(function(b){
      h+='<tr>';
      cols.forEach(function(c){
        var v=b[c[0]], txt;
        if(c[0]==='nom') txt='<span style="display:inline-block;max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom">'+esc(b.nom)+'</span>';
        else if(c[0]==='ageMin') txt=(v===null||v===undefined)?'—':(v<60?v+'′':Math.round(v/60)+' h');
        else if(c[0]==='pctPolaire'&&(v===null||v===undefined)&&b.motifPol) txt='<span title="'+esc(b.motifPol)+'" style="color:#8fb0c4">·</span>';
        else txt=(v===null||v===undefined)?'—':fmt(v,c[2]);
        var col='';
        if(c[0]==='vmc'&&v!==undefined&&v!==null) col=';color:'+(v>0?'#4ade80':'#f87171');
        if(c[0]==='pctPolaire'&&v!==undefined&&v!==null) col=';color:'+(v>=95?'#4ade80':v>=85?'#fbbf24':'#f87171')+';font-weight:700';
        if(c[0]==='sogSurface'&&v!==undefined&&v!==null&&b.courant) col=';color:#7dd3fc';
        /* une valeur brute (transpondeur, non lissee) ou obtenue par
           elargissement de la fenetre est signalee : le marin doit savoir
           quelle confiance accorder au chiffre */
        if((c[0]==='sogLisse'||c[0]==='cmg')&&b.brut) txt='<span title="valeur brute du transpondeur, non lissée">'+txt+'&#8239;*</span>';
        else if((c[0]==='sogLisse'||c[0]==='cmg')&&b.elargie) txt='<span title="lissage élargi à '+b.fenetreReelleMin+' min faute de positions rapprochées">'+txt+'&#8239;~</span>';
        h+='<td style="text-align:'+(c[0]==='nom'?'left':'right')+';padding:4px 5px;border-bottom:1px solid #14293c'+col+'">'+txt+'</td>';
      });
      h+='</tr>';
    });
    $a('anTable').innerHTML=h+'</tbody></table>';
    [].slice.call($a('anTable').querySelectorAll('th')).forEach(function(th){
      th.onclick=function(){
        var c=th.getAttribute('data-col');
        if(tri===c) sens=-sens; else { tri=c; sens=(c==='nom'||c==='rang'||c==='distMarque'||c==='ageMin')?1:-1; }
        charger();
      };
    });
  }
  function remplirPolaires(){
    var sp=$a('anPol');
    if(!sp || sp.options.length>1) return true;
    var P=window.POLAIRES_PRESETS;
    if(!P) return false;
    for(var k in P){ var o=document.createElement('option'); o.value=k; o.textContent=P[k].n; sp.appendChild(o); }
    return true;
  }
  if(!remplirPolaires()){                       /* le fichier peut arriver apres */
    var essais=0, ticker=setInterval(function(){ if(remplirPolaires()||++essais>20) clearInterval(ticker); }, 500);
  }
  $a('anBtn').onclick=function(){
    var p=$a('anPanneau');
    var ouvert=p.style.display!=='none';
    p.style.display=ouvert?'none':'block';
    if(ouvert){ if(timer){clearInterval(timer);timer=null;} }
    else { charger(); timer=setInterval(charger,60000); }
  };
  $a('anFermer').onclick=function(){ $a('anBtn').onclick(); };
  $a('anFen').onchange=charger;
  $a('anVus').onchange=function(){ if(dernier) rendre(dernier); };
  $a('anMarque').onclick=function(){
    poserMarque=true;
    $a('anMsg').textContent='Tape sur la carte pour poser la marque de parcours…';
  };
  map.on('click',function(e){
    if(!poserMarque)return;
    poserMarque=false; marque=e.latlng;
    if(marqueMk) map.removeLayer(marqueMk);
    marqueMk=L.marker(marque,{icon:L.divIcon({className:'',html:'<div style="font-size:22px;line-height:1">\u25B2</div>',iconSize:[22,22],iconAnchor:[11,20]}),interactive:false}).addTo(map);
    charger();
  });
})();
(function(){
  var $r=function(i){return document.getElementById(i);};
  var mode=null; /* 'dep' | 'arr' */
  $r('rtBtn').onclick=function(){var p2=$r('rtPanneau');p2.style.display=p2.style.display==='none'?'block':'none';
    if(p2.style.display==='block'){
      var sel=$r('rtBateau');sel.innerHTML='<option value="">Départ = un bateau…</option>';
      for(var k in boats){var o=document.createElement('option');o.value=k;o.textContent=boats[k].name;sel.appendChild(o);}
      var sp=$r('rtPol');
      if(!sp.options.length){for(var pk in POLAIRES_PRESETS){var o2=document.createElement('option');o2.value=pk;o2.textContent=POLAIRES_PRESETS[pk].n;sp.appendChild(o2);}
        var o3=document.createElement('option');o3.value='__coller';o3.textContent='Coller un .pol…';sp.appendChild(o3);}
    }};
  $r('rtBateau').onchange=function(){var b=boats[this.value];if(b&&b.last){RT.depart={lat:b.last[0],lon:b.last[1]};$r('rtDep').textContent=b.name;}};
  $r('rtPol').onchange=function(){
    if(this.value==='__coller'){var t=prompt('Coller le contenu du fichier .pol (TWS en tête, TWA en 1re colonne)');if(t&&rtChoisirPolaire('collée',t)){$r('rtMsg').textContent='Polaire collée chargée.';}else{this.value='generique';rtChoisirPolaire('generique');}}
    else rtChoisirPolaire(this.value);
  };
  rtChoisirPolaire('generique'); $r('rtPol').value='generique';
  $r('rtPolFichier').onchange=function(){
    var f2=this.files[0];if(!f2)return;
    var rd=new FileReader();
    rd.onload=function(){
      if(rtChoisirPolaire(f2.name,rd.result)){
        var sp2=$r('rtPol'), o4=sp2.querySelector('option[value="__fichier"]');
        if(!o4){o4=document.createElement('option');o4.value='__fichier';sp2.insertBefore(o4,sp2.firstChild);}
        o4.textContent='Chargée : '+f2.name;
        sp2.value='__fichier';
        $r('rtMsg').textContent='Polaire « '+f2.name+' » chargée ('+RT.polaire.twa.length+' TWA × '+RT.polaire.tws.length+' TWS).';
      } else {
        $r('rtMsg').textContent='\u26a0\ufe0e Fichier .pol illisible (attendu : TWS en tête, TWA en 1re colonne).';
      }
    };
    rd.readAsText(f2);
  };
  $r('rtPol').addEventListener('change',function(){if(this.value==='__fichier'&&RT.polaireNom.indexOf('.')<0){}});
  $r('rtPct').oninput=function(){$r('rtPctV').textContent=this.value;};
  map.on('click',function(e){
    if($r('rtPanneau').style.display!=='block')return;
    if(!RT.depart&&!$r('rtBateau').value){RT.depart={lat:e.latlng.lat,lon:e.latlng.lng};$r('rtDep').textContent=e.latlng.lat.toFixed(3)+', '+e.latlng.lng.toFixed(3);return;}
    RT.arrivee={lat:e.latlng.lat,lon:e.latlng.lng};$r('rtArr').textContent=e.latlng.lat.toFixed(3)+', '+e.latlng.lng.toFixed(3);
  });
  $r('rtGpx').onchange=function(){var f2=this.files[0];if(!f2)return;var rd=new FileReader();
    rd.onload=function(){var n2=rtChargerGPX(rd.result);$r('rtMsg').textContent=n2?('Zone interdite chargée ('+n2+' pts).'):'GPX illisible.';};rd.readAsText(f2);};
  $r('rtRaz').onclick=function(){RT.depart=null;RT.arrivee=null;RT.exclusions=[];RT.calques.clearLayers();$r('rtDep').textContent='tap carte / bateau';$r('rtArr').textContent='tap carte';$r('rtMsg').textContent='';$r('rtBateau').value='';};
  /* Diagnostic des calques : lit l'etat REEL de la carte — existence des
     couches meteo, ajout effectif, URL de tuile composee, plan d'affichage.
     Permet de situer une panne d'affichage sans navigateur de developpement
     (regle R8, ajoutee le 31/07/2026). */
  if($r('dgCalques')) $r('dgCalques').onclick=function(){
    var out=[];
    function l(t){out.push(t);}
    try{
      l('OWM_KEY : '+(window.OWM_KEY?('presente ('+String(window.OWM_KEY).length+' car.)'):'ABSENTE'));
      l('weather defini : '+(typeof weather!=='undefined'));
      if(typeof weather!=='undefined'){
        var noms=Object.keys(weather);
        l('calques crees : '+noms.length+' ['+noms.join(', ')+']');
        noms.forEach(function(n){
          var c=weather[n], sur=false, url='?', pane='(defaut)';
          try{ sur=map.hasLayer(c); }catch(e){}
          try{ pane=(c.options&&c.options.pane)||'(defaut)'; }catch(e){}
          /* un calque peut etre un groupe (« Vent » = nappe + fleches) :
             on cherche la premiere tuile a l'interieur */
          var tuile=c; try{ if(typeof c.getTileUrl!=='function'&&c.eachLayer){ c.eachLayer(function(sc){ if(typeof sc.getTileUrl==='function'&&tuile===c) tuile=sc; }); } }catch(e){}
          try{ pane=(tuile.options&&tuile.options.pane)||pane; }catch(e){}
          try{ url=(typeof tuile.getTileUrl==='function')?tuile.getTileUrl({x:126,y:88,z:8}):'(groupe sans tuile)'; }catch(e){ url='ERREUR '+e.message; }
          l(' - '+n+' : surCarte='+sur+' pane='+pane);
          if(sur){
            l('    url = '+String(url).slice(0,120));
            var el=null; try{ el=tuile._container||c._container; }catch(e){}
            l('    conteneur = '+(el?('present, '+(el.querySelectorAll?el.querySelectorAll('img').length:'?')+' tuile(s)'):'ABSENT'));
          }
        });
      }
      var pm=null; try{ pm=map.getPane('meteoPane'); }catch(e){}
      l('pane meteo : '+(pm?('present, z='+pm.style.zIndex+', '+pm.childNodes.length+' enfant(s)'):'ABSENT'));
      l('zoom : '+map.getZoom());
    }catch(e){ l('ERREUR : '+e.message); }
    var z=$r('dgOut'); z.style.display='block'; z.textContent=out.join(String.fromCharCode(10));
  };
  $r('rtGo').onclick=function(){
    $r('rtMsg').textContent='';
    rtLancer({pctPolaire:parseInt($r('rtPct').value,10)},
      function(p2){$r('rtMsg').textContent=p2;},
      function(m2){rtDessiner(m2);
        var eta=new Date(m2.eta);
        var hh=('0'+eta.getHours()).slice(-2)+':'+('0'+eta.getMinutes()).slice(-2);
        var duree=((m2.eta-Date.now())/3600e3);
        $r('rtMsg').textContent=(m2.arriveeAtteinte?'Arrivée ':'Au plus près (reste '+m2.distRestante+' MN) ')
          +hh+' ('+(duree>=48?(duree/24).toFixed(1)+' j':duree.toFixed(1)+' h')+') · '+RT.polaireNom
          +(m2.motif?' — '+m2.motif:'');},
      function(er){$r('rtMsg').textContent='\u26a0\ufe0e '+er;});
  };
})();
fillSel($('windModel'),MODELS,'best_match');fillSel($('windHour'),HOURS,0);
initVent(map, windGroup);
installRadar(layerCtl);

/* ---- gestion des bateaux ---- */
function boatColor(id){var h=0;for(var i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return 'hsl('+(h%360)+',85%,55%)';}
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
var boats={};
var showNames=true;
var legOpen=true;
function courtNom(n){n=String(n||'');return n.length>15?n.slice(0,14)+'…':n;}
/* contenu de l'etiquette flottante : nom, puis vitesse et cap du dernier point */
function etiquette(b){
  var t=esc(courtNom(b.name));
  var p=b.last;
  if(p){
    var l2=[];
    if(p[3]!=null) l2.push((Math.round(p[3]*10)/10)+' kt');
    if(p[4]!=null) l2.push(dirArrow(p[4])+' '+Math.round(p[4])+'°');
    l2.push(fmtAgeCourt(p[2]));            /* age de la position : toujours affiche */
    t+='<span class="nav">'+l2.join(' · ')+'</span>';
  }
  return t;
}
/* Un bateau suivi par AIS n'emet qu'un point par intervalle reglé sur la flotte :
   le seuil hors-ligne doit lui laisser le temps de deux points, sinon toute la
   flotte s'affiche eteinte entre deux relevés. Recalculé au chargement. */
var OFFLINE_MS=15*60*1000;
function majSeuilHorsLigne(intervalleMin){
  var v=parseInt(intervalleMin,10);
  if(!v||v<1)return;
  OFFLINE_MS=Math.max(15*60*1000, Math.round(v*60*1000*2.5));
}
function isOnline(b){return !!(b.last && (Date.now()-b.last[2])<=OFFLINE_MS);}
/* format court, pour l'etiquette de carte et la liste : « 3′ », « 2 h 10 »,
   « 4 j ». L'age de la derniere position est l'information la plus decisive
   quand la flotte est suivie par AIS differe. */
function fmtAgeCourt(ms){
  var s=Math.max(0,Math.floor((Date.now()-ms)/1000));
  if(s<60) return s+'s';
  if(s<3600) return Math.floor(s/60)+'\u2032';
  if(s<86400){ var h=Math.floor(s/3600), m=Math.floor(s%3600/60); return m?(h+' h '+m):(h+' h'); }
  return Math.floor(s/86400)+' j';
}
function fmtAge(ms){var s=Math.max(0,Math.floor((Date.now()-ms)/1000));if(s<60)return 'à l\\u2019instant';if(s<3600)return 'il y a '+Math.floor(s/60)+' min';return 'il y a '+Math.floor(s/3600)+' h';}
function updateBoatStyle(b){
  if(!b.marker)return;var on=isOnline(b);
  b.marker.setStyle({fillOpacity:on?1:0.3,color:on?'#fff':'#9fb0bd',weight:on?1.6:1});
  if(b.trace)b.trace.setStyle({opacity:on?0.85:0.25});
  if(b.vec)b.vec.setStyle({color:on?b.color:'#6b7f8c',opacity:on?0.95:0.3});
  var tt=b.marker.getTooltip&&b.marker.getTooltip();if(tt&&tt.setOpacity)tt.setOpacity(on?1:0.5);
}
var onlineOnly=false;
function applyVisibility(){
  for(var k in boats){var b=boats[k];var vis=!onlineOnly||isOnline(b);
    if(b.marker){if(vis){if(!map.hasLayer(b.marker))b.marker.addTo(map);}else if(map.hasLayer(b.marker))map.removeLayer(b.marker);}
    if(b.trace){if(vis){if(!map.hasLayer(b.trace))b.trace.addTo(map);}else if(map.hasLayer(b.trace))map.removeLayer(b.trace);}
    if(b.vec){if(vis){if(!map.hasLayer(b.vec))b.vec.addTo(map);}else if(map.hasLayer(b.vec))map.removeLayer(b.vec);}
  }
}
function ensureBoat(id,name){
  if(boats[id]){if(name)boats[id].name=name;return boats[id];}
  var c=boatColor(id);
  boats[id]={name:name||'Bateau',color:c,last:null,marker:null,trace:L.polyline([],{color:c,weight:3,opacity:.85}).addTo(map)};
  return boats[id];
}
/* vecteur de cap : longueur a l'ecran, proportionnelle a la vitesse */
function vecEnd(ll,cog,sog){
  var px=14+Math.min(38,(sog||0)*2.6);
  var pt=map.latLngToLayerPoint(ll);
  var rad=cog*Math.PI/180;
  return map.layerPointToLatLng(L.point(pt.x+Math.sin(rad)*px, pt.y-Math.cos(rad)*px));
}
function drawVector(b){
  var p=b.last;
  if(!p||p[4]==null){ if(b.vec){map.removeLayer(b.vec);b.vec=null;} return; }
  var ll=[p[0],p[1]], end=vecEnd(ll,p[4],p[3]||0), on=isOnline(b);
  if(!b.vec){ b.vec=L.polyline([ll,end],{color:b.color,weight:2.4,opacity:on?0.95:0.3,interactive:false}).addTo(map); }
  else { b.vec.setLatLngs([ll,end]); b.vec.setStyle({color:on?b.color:'#6b7f8c',opacity:on?0.95:0.3}); }
}
function redrawVectors(){for(var k in boats){var b=boats[k];if(b.vec||((b.last)&&b.last[4]!=null))drawVector(b);}applyVisibility();}
map.on('zoomend',redrawVectors);

function ficheBateau(id){
  var b=boats[id]; if(!b||!b.last)return;
  var p=b.last, ll=[p[0],p[1]];
  var ent='<div style="font-weight:700;font-size:13px;margin-bottom:5px;max-width:230px">'+esc(b.name)+'</div>';
  var url=new URL(location.href);
  var estMoi=(id===moiId);
  if(estMoi){ url.searchParams.delete('moi'); } else { url.searchParams.set('moi',id); }
  ent+='<div style="font-size:12px;margin-bottom:5px"><a href="'+url.pathname+url.search+'" style="color:#fbbf24;text-decoration:none">'+(estMoi?'🔕 Ne plus veiller ce bateau':'🔔 Veiller ce bateau')+'</a></div>';
  var nav='<div style="font-size:12.5px;line-height:1.7">'
    +'🚤 '+(p[3]!=null?(Math.round(p[3]*10)/10)+' kt':'— kt')+(p[4]!=null?' · cap '+Math.round(p[4])+'°':'')+'<br>'
    +'<span style="color:#8fb0c2">'+fmtAge(p[2])+'</span></div>';
  var pop=L.popup({maxWidth:260,autoPan:true}).setLatLng(ll)
    .setContent(ent+nav+'<div style="font-size:12.5px;color:#8fb0c2;margin-top:4px">Vent…</div>').openOn(map);
  fetch('/api/point?lat='+p[0].toFixed(3)+'&lon='+p[1].toFixed(3)).then(function(r){return r.json();}).then(function(d){
    var vent = (d.wind!=null) ? ('💨 '+Math.round(d.wind)+' kt'+(d.windDir!=null?' · '+dirArrow(d.windDir)+' '+Math.round(d.windDir)+'°':'')) : '💨 vent indisponible';
    var cour = (d.curSpeed!=null&&d.curSpeed>0) ? ('<br>🌊 courant '+d.curSpeed.toFixed(1)+' kt'+(d.curDir!=null?' · '+dirArrow(d.curDir)+' '+Math.round(d.curDir)+'°':'')) : '';
    var pres = (d.pressure!=null) ? ('<br>🔽 '+Math.round(d.pressure)+' hPa') : '';
    pop.setContent(ent+nav+'<div style="font-size:12.5px;line-height:1.7;margin-top:4px">'+vent+cour+pres+'</div>');
  }).catch(function(){
    pop.setContent(ent+nav+'<div style="font-size:12.5px;color:#8fb0c2;margin-top:4px">Vent indisponible</div>');
  });
}

function boatAdd(id,name,p,dejaTrace){
  var b=ensureBoat(id,name);
  var ll=[p[0],p[1]];
  b.last=p;
  if(id===moiId) majVeille();
  if(!dejaTrace) b.trace.addLatLng(ll);
  if(!b.marker){
    /* bubblingMouseEvents:false : sans lui, le tap sur le bateau remonte a la
       carte, qui ouvre la bulle meteo par-dessus la fiche — la cloche de
       veille devenait introuvable. */
    b.marker=L.circleMarker(ll,{radius:6,color:'#fff',weight:1.6,fillColor:b.color,fillOpacity:1,bubblingMouseEvents:false}).addTo(map)
      .bindTooltip(etiquette(b),{permanent:true,direction:'right',offset:[9,0],className:'boat-name',interactive:true});
    /* l'etiquette est bien plus grande que le rond du marqueur : sur mobile,
       c'est elle qu'on tape naturellement — elle doit ouvrir la meme fiche. */
    b.marker.on('click',function(){ ficheBateau(id); });
    if(!showNames) b.marker.closeTooltip();
  } else { b.marker.setLatLng(ll); b.marker.setTooltipContent(etiquette(b)); }
  drawVector(b);
  updateBoatStyle(b);
  applyVisibility();
  renderLegend();
}
function applyNames(){for(var k in boats){var b=boats[k];if(b.marker){if(showNames)b.marker.openTooltip();else b.marker.closeTooltip();}}}
function lgLibelle(ks){
  /* l'en-tete annonce les bateaux reellement suivis (case Emet cochee) plutot
     que le total inscrit : c'est le chiffre qui a un sens operationnel.
     Repli sur l'ancien libelle si le serveur ne fournit pas l'etat de suivi. */
  var suivis=0, connus=0, tot=Object.keys(boats).length;
  for(var kk in boats){ if(boats[kk].suivi!==undefined){ connus++; if(boats[kk].suivi!==false)suivis++; } }
  if(!connus) return ks.length+' bateau'+(ks.length>1?'x':'');
  return suivis+' suivi'+(suivis>1?'s':'')+' / '+tot;
}
function renderLegend(){
  var el=$('legend');
  var ks=Object.keys(boats).filter(function(k){return !onlineOnly||isOnline(boats[k]);});
  var total=Object.keys(boats).length,hidden=total-ks.length;
  var head='<span id="lgtog" style="cursor:pointer;color:#39c0d3;font-weight:700">'+(legOpen?'▾ masquer':'▸ afficher')+'</span> · '+lgLibelle(ks);
  if(onlineOnly&&hidden>0)head+=' · '+hidden+' masqué'+(hidden>1?'s':'');
  var html='<div class="lgh">'+head+' · <label><input type="checkbox" id="nameToggle"'+(showNames?' checked':'')+'> Noms</label> · <label><input type="checkbox" id="onlineToggle"'+(onlineOnly?' checked':'')+'> Émet</label></div>';
  ks.sort(function(a,bk){return (boats[a].name||'').localeCompare(boats[bk].name||'');});
  if(!legOpen)ks=[];
  ks.forEach(function(k){var b=boats[k];var on=isOnline(b);
    var right;
    if(on){
      var sp=(b.last&&b.last[3]!=null)?(Math.round(b.last[3]*10)/10)+' kt':'—';
      var cp=(b.last&&b.last[4]!=null)?(Math.round(b.last[4])+'°'):'';
      right=(cp?(sp+' · '+cp):sp)+(b.last?' · '+fmtAgeCourt(b.last[2]):'');
    } else right=(b.last?'vu '+fmtAge(b.last[2]):'—');
    html+='<div class="lgi'+(on?'':' off')+'" data-id="'+k+'"><span class="dot" style="background:'+(on?b.color:'#6b7f8c')+'"></span><span>'+esc(b.name)+'</span><span class="sp'+(on?'':' offsp')+'">'+right+'</span>'
      +'<a class="fic" href="/b?id='+k+'" title="Fiche du bateau" style="text-decoration:none">\u2139\ufe0e</a>'
      +(ADMK?'<span class="del" data-del="'+k+'" title="Retirer de la flotte">✕</span>':'')+'</div>';});
  html+='<div class="lgexp">⤓ Traces flotte : <a href="/api/fleets/'+fid+'/export?format=gpx">GPX</a> · <a href="/api/fleets/'+fid+'/export?format=csv">CSV</a></div>';
  el.innerHTML=html;
  var tg=$('lgtog');
  if(tg)tg.onclick=function(e){e.stopPropagation();legOpen=!legOpen;renderLegend();};
  var ntg=$('nameToggle');if(ntg)ntg.onchange=function(){showNames=this.checked;applyNames();};
  var otg=$('onlineToggle');if(otg)otg.onchange=function(){onlineOnly=this.checked;applyVisibility();renderLegend();};
  var rows=el.querySelectorAll('.lgi');
  for(var i=0;i<rows.length;i++){rows[i].onclick=function(){var b=boats[this.getAttribute('data-id')];if(b&&b.last)map.setView([b.last[0],b.last[1]],Math.max(map.getZoom(),12));};}
  /* le lien vers la fiche ne doit declencher NI la suppression (classe distincte)
     NI le clic de la ligne qui recentre la carte : on stoppe la propagation. */
  var fics=el.querySelectorAll('.fic');
  for(var f2=0;f2<fics.length;f2++){fics[f2].onclick=function(ev){ev.stopPropagation();};}
  var dels=el.querySelectorAll('.del');
  for(var d=0;d<dels.length;d++){dels[d].onclick=function(ev){ev.stopPropagation();var did=this.getAttribute('data-del');var b=boats[did];if(!confirm('Retirer '+((b&&b.name)||'ce bateau')+' de la flotte ?'))return;fetch('/api/fleets/'+fid+'/remove',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':ADMK},body:JSON.stringify({trackId:did})}).then(function(){if(b){if(b.marker)map.removeLayer(b.marker);if(b.trace)map.removeLayer(b.trace);if(b.vec)map.removeLayer(b.vec);}delete boats[did];renderLegend();}).catch(function(){});};}
}
function refreshStatus(){for(var k in boats)updateBoatStyle(boats[k]);applyVisibility();renderLegend();}
setInterval(refreshStatus,30000);
function fitAll(){var g=[];for(var k in boats)if(boats[k].last)g.push([boats[k].last[0],boats[k].last[1]]);if(g.length===1)map.setView(g[0],11);else if(g.length)map.fitBounds(g,{padding:[50,50],maxZoom:12});}
$('fit').onclick=fitAll;

/* ---- chargement + temps réel ---- */
if(!fid){$('flname').textContent='Lien de flotte invalide';}
else{
  /* tracks=1 rapporte l'historique deja enregistré : sans lui, les traces
     repartent de zero a chaque rechargement de la page. */
  fetch('/api/fleets/'+fid+'?tracks=1').then(function(r){return r.json();}).then(function(d){
    if(d.error){$('flname').textContent='Flotte introuvable';$('flcount').textContent='';return;}
    $('flname').textContent=d.name||'Flotte';
    majSeuilHorsLigne(d.aisIntervalMin);
    (d.boats||[]).forEach(function(bo){
      var b=ensureBoat(bo.id,bo.name);
      if(bo.suivi!==undefined)b.suivi=bo.suivi;
      var pts=bo.points||[];
      if(pts.length){
        b.trace.setLatLngs(pts.map(function(p){return [p[0],p[1]];}));
        boatAdd(bo.id,bo.name,pts[pts.length-1],true);
      } else if(bo.last){ boatAdd(bo.id,bo.name,bo.last); }
    });
    resoudreMoi(d.boats||[]);
    redrawVectors();
    renderLegend(); fitAll(); subscribe();
    majVeille();
  }).catch(function(){$('flcount').textContent='Erreur de chargement';});
}
function subscribe(){
  var es=new EventSource('/api/fleets/'+fid+'/stream');
  es.onopen=function(){$('flcount').textContent='En direct';};
  es.onerror=function(){$('flcount').textContent='Reconnexion…';};
  es.onmessage=function(ev){ try{var m=JSON.parse(ev.data);
    if(m&&m.rm){ var b=boats[m.rm]; if(b){ if(b.marker)map.removeLayer(b.marker); if(b.trace)map.removeLayer(b.trace); if(b.vec)map.removeLayer(b.vec); delete boats[m.rm]; renderLegend(); } return; }
    if(m&&m.p) boatAdd(m.b,m.n,m.p);
  }catch(e){} };
}

/* ---- pointeur météo / courant ---- */
map.on('click',function(e){
  var ll=e.latlng;
  var pop=L.popup({maxWidth:230}).setLatLng(ll).setContent('Chargement…').openOn(map);
  function dt(d){return d==null?'—':(dirArrow(d)+' '+Math.round(d)+'°');}
  var meteoHtml=null, fondHtml='', mareeHtml='';
  function rendre(){
    if(meteoHtml===null)return;
    pop.setContent('<div style="font-size:12px;line-height:1.6">'+meteoHtml+mareeHtml+fondHtml+'</div>');
  }
  fetch('/api/fond?lat='+ll.lat.toFixed(5)+'&lon='+ll.lng.toFixed(5)).then(function(r){return r.json();}).then(function(f){
    if(f&&f.fond!=null){
      fondHtml='<br>\u26F0 Fond '+(f.source||'')+' : '+f.fond.toFixed(1).replace('.',',')+' m <span style="opacity:.65">('+(f.ref||'')+')</span>';
      if(f.sondeApprox!=null)fondHtml+='<br><span style="opacity:.8">\u2248 sonde carte '+f.sondeApprox.toFixed(1).replace('.',',')+' m (\u00b10,5 m)</span>';
      rendre();
    }
  }).catch(function(){});
  fetch('/api/courant?lat='+ll.lat.toFixed(5)+'&lon='+ll.lng.toFixed(5)).then(function(r){return r.json();}).then(function(c){
    if(c&&c.courant&&c.maree){
      var m2=c.maree, cr=c.courant;
      var signe=m2.h>=0?'+':'\u2212';
      mareeHtml='<br>\ud83c\udf00 Mar\u00e9e : '+cr.vitesse.toFixed(1).replace('.',',')+' kt '+dirArrow(cr.dir)+' '+cr.dir+'\u00b0'
        +'<br><span style="opacity:.8">'+m2.evenement+' '+esc(m2.port)+' '+signe+Math.abs(m2.h).toFixed(1).replace('.',',')+' h \u00b7 coef '+m2.coef+' \u00b7 atlas Shom</span>';
      rendre();
    }
  }).catch(function(){});
  fetch('/api/point?lat='+ll.lat.toFixed(3)+'&lon='+ll.lng.toFixed(3)).then(function(r){return r.json();}).then(function(d){
    meteoHtml='💨 Vent : '+(d.wind!=null?Math.round(d.wind)+' kt '+dt(d.windDir):'—')+'<br>'
      +'🔽 Pression : '+(d.pressure!=null?Math.round(d.pressure)+' hPa':'—')+'<br>'
      +'🌊 Courant : '+(d.curSpeed!=null?d.curSpeed.toFixed(1)+' kt '+dt(d.curDir):'—');
    rendre();
  }).catch(function(){pop.setContent('Erreur');});
});
</script>
</body>
</html>
`;
const PAGE_FICHE = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Fiche bateau — Sea Tracker</title>
<link rel="stylesheet" href="/vendor/leaflet.css">
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0b1a26;color:#dfeaf2;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      padding:max(12px,env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom))}
 h1{font-size:20px;margin:6px 0 2px}
 .sub{color:#8fb0c4;font-size:13px;margin-bottom:14px}
 .card{background:#0d1f2d;border:1px solid #1d3a52;border-radius:14px;padding:12px;margin-bottom:12px}
 .lbl{color:#39c0d3;font-size:11px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
 .grille{display:grid;grid-template-columns:1fr 1fr;gap:10px}
 .stat{background:#0f2233;border-radius:10px;padding:10px}
 .stat b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
 .stat span{color:#8fb0c4;font-size:11px}
 select,button{background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:9px;padding:7px 10px;font-size:14px}
 #carte{height:46vh;border-radius:12px;border:1px solid #1d3a52}
 table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
 td,th{padding:4px 6px;border-bottom:1px solid #14293c;text-align:right;font-size:13px}
 th{color:#39c0d3;font-weight:600}
 td:first-child,th:first-child{text-align:left}
 .barre{height:9px;background:#0f2233;border-radius:5px;overflow:hidden}
 .barre i{display:block;height:100%;background:#39c0d3}
 a{color:#39c0d3}
</style></head><body>
<div><a href="javascript:history.back()">‹ Retour</a></div>
<h1 id="nom">…</h1>
<div class="sub" id="sub"></div>
<div class="card">
  <label class="lbl">Période</label>
  <select id="jours">
    <option value="7">7 derniers jours</option>
    <option value="30">30 derniers jours</option>
    <option value="90" selected>90 derniers jours</option>
    <option value="365">1 an</option>
    <option value="400">tout (400 j max)</option>
    <option value="perso">dates précises…</option>
  </select>
  <div id="zoneDates" style="display:none;margin-top:8px;display:none">
    <label style="font-size:12px;color:#8fb0c4">du <input type="date" id="dDe" style="background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:8px;padding:6px"></label>
    <label style="font-size:12px;color:#8fb0c4;margin-left:8px">au <input type="date" id="dA" style="background:#0f2233;color:#dfeaf2;border:1px solid #1d3a52;border-radius:8px;padding:6px"></label>
    <button id="dGo" style="margin-left:8px">Appliquer</button>
  </div>
</div>
<div id="corps"></div>
<script src="/vendor/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js"></script>
<script src="/carte.js"></script>
<script>
(function(){
  var bid=new URLSearchParams(location.search).get('id')||'';
  var carte=null, traceL=null;
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function nb(v,u){return (v===null||v===undefined)?'—':(String(v).replace('.',',')+(u||''));}
  function periodeQS(){
    var j=document.getElementById('jours').value;
    if(j==='perso'){
      var de=document.getElementById('dDe').value, a=document.getElementById('dA').value;
      if(de&&a) return 'depuis='+de+'&jusqua='+a;
      if(de) return 'depuis='+de;
      if(a) return 'jusqua='+a;
      return 'jours=90';
    }
    return 'jours='+j;
  }
  function charger(){
    fetch('/api/boats/'+bid+'/fiche?'+periodeQS()).then(function(r){return r.json();})
      .then(function(d){ try{ rendre(d); }catch(e){ document.getElementById('corps').innerHTML='<div class="card">Affichage partiel : '+esc(e.message||'erreur')+'</div>'; } })
      .catch(function(){document.getElementById('corps').innerHTML='<div class="card">Fiche indisponible (serveur injoignable).</div>';});
  }
  function rendre(d){
    if(d.error){document.getElementById('corps').innerHTML='<div class="card">'+esc(d.error)+'</div>';return;}
    document.getElementById('nom').textContent=d.nom||'Bateau';
    document.getElementById('sub').textContent=(d.mmsi?('MMSI '+d.mmsi+' · '):'')+d.n+' position'+(d.n>1?'s':'')+' enregistrée'+(d.n>1?'s':'');
    if(d.vide){document.getElementById('corps').innerHTML='<div class="card">Pas encore assez de positions sur cette période.</div>';return;}
    var h='';
    h+='<div class="card"><div class="lbl">Bilan</div><div class="grille">'
      +'<div class="stat"><b>'+nb(d.distanceNm)+'</b><span>milles parcourus</span></div>'
      +'<div class="stat"><b>'+nb(d.heuresNav)+' h</b><span>en navigation</span></div>'
      +'<div class="stat"><b>'+nb(d.vitesseMoyenne)+' kt</b><span>vitesse moyenne</span></div>'
      +'<div class="stat"><b>'+nb(d.vitesseMax)+' kt</b><span>vitesse maximale</span></div>'
      +'<div class="stat"><b>'+nb(d.sorties)+'</b><span>sortie'+(d.sorties>1?'s':'')+' détectée'+(d.sorties>1?'s':'')+'</span></div>'
      +'<div class="stat"><b>'+(d.plusLongue?nb(d.plusLongue.distance):'—')+'</b><span>plus longue (MN)</span></div>'
      +'</div></div>';
    h+='<div class="card"><div class="lbl">Trace</div><div id="carte"></div></div>';
    var hist=d.histogrammeVitesse||[], tot=hist.reduce(function(a,b){return a+b;},0);
    if(tot>0){
      h+='<div class="card"><div class="lbl">Temps passé par vitesse</div><table>';
      for(var i=0;i<hist.length;i++){
        if(hist[i]<=0) continue;
        var pc=Math.round(hist[i]/tot*100);
        h+='<tr><td>'+i+'–'+(i+1)+(i===15?'+':'')+' kt</td><td style="width:52%"><div class="barre"><i style="width:'+pc+'%"></i></div></td><td>'+nb(hist[i],' h')+'</td><td>'+pc+' %</td></tr>';
      }
      h+='</table></div>';
    }
    h+='<div class="card"><div class="lbl">Polaire observée</div>'
      +'<div style="color:#8fb0c4;font-size:12px;margin-bottom:8px">Reconstruite depuis les traces : vitesse mesurée, corrigée du courant de marée, croisée avec le vent archivé. Se remplit à mesure des navigations.</div>'
      +'<button id="polGo">Calculer la polaire</button><div id="polOut" style="margin-top:10px"></div></div>';
    if(d.parMois&&d.parMois.length){
      h+='<div class="card"><div class="lbl">Par mois</div><table><tr><th>Mois</th><th>Milles</th><th>Heures</th></tr>';
      d.parMois.forEach(function(m){h+='<tr><td>'+esc(m.mois)+'</td><td>'+nb(m.distance)+'</td><td>'+nb(m.heures)+'</td></tr>';});
      h+='</table></div>';
    }
    h+='<div class="card"><div class="lbl">Période couverte</div>'+esc((d.premier||'').slice(0,16).replace('T',' '))+' → '+esc((d.dernier||'').slice(0,16).replace('T',' '))+' UTC</div>';
    document.getElementById('corps').innerHTML=h;
    /* carte : trace allegee. Isolee : si Leaflet manque ou echoue, les
       statistiques restent affichees (regle R3). */
    try{
      if(window.L&&d.trace&&d.trace.length>1){
        carte=L.map('carte',{zoomControl:false});
        /* Fond marin identique aux cartes de suivi : carte vectorielle
           openwaters.io si maplibre est disponible, sinon OpenStreetMap.
           Balises OpenSeaMap par-dessus dans les deux cas. */
        var fondPose=false;
        try{
          if(window.maplibregl && L.maplibreGL && typeof creerCarteMarine==='function'){
            creerCarteMarine().addTo(carte); fondPose=true;
          }
        }catch(e){}
        if(!fondPose) L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap'}).addTo(carte);
        try{ L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',{maxZoom:18,opacity:0.9,attribution:'© OpenSeaMap'}).addTo(carte); }catch(e){}
        traceL=L.polyline(d.trace,{color:'#39c0d3',weight:3,opacity:.9}).addTo(carte);
        carte.fitBounds(traceL.getBounds(),{padding:[18,18]});
        L.circleMarker(d.trace[d.trace.length-1],{radius:6,color:'#fff',fillColor:'#f59e0b',fillOpacity:1,weight:2}).addTo(carte);
      } else {
        var z=document.getElementById('carte');
        if(z) z.innerHTML='<div style="padding:14px;color:#8fb0c4;font-size:13px">Carte indisponible.</div>';
      }
    }catch(e){
      var z2=document.getElementById('carte');
      if(z2) z2.innerHTML='<div style="padding:14px;color:#8fb0c4;font-size:13px">Carte indisponible.</div>';
    }
  }
  function couleurV(v,vmax){
    var r=vmax>0?v/vmax:0;
    return r<0.35?'#1e3a5f':r<0.55?'#0369a1':r<0.75?'#0891b2':r<0.9?'#16a34a':'#f59e0b';
  }
  var polData=null, polMode='table';
  /* Diagramme polaire (« patatoide ») : une courbe par force de vent, angle au
     vent en abscisse angulaire (0 en haut = vent debout), vitesse en rayon.
     Seules les cases a 3 mesures ou plus sont tracees : une courbe batie sur
     des cases isolees serait un mensonge graphique. */
  function svgPolaire(d){
    var R=140, cx=160, cy=160, pad=20;
    /* Toutes les cases sont tracees des la premiere mesure : le marin doit voir
       la forme se dessiner au fil des navigations. La solidite se lit au trait —
       plein et gros points a partir de 3 mesures, pointille et petits points en
       dessous — plutot que par un seuil qui masquerait tout au debut. */
    var vmax=0; d.grille.forEach(function(c){ if(c.mediane>vmax) vmax=c.mediane; });
    if(vmax<=0) return '<div style="color:#8fb0c4">Pas encore de mesure exploitable.</div>';
    vmax=Math.ceil(vmax/2)*2;
    var s='<svg viewBox="0 0 '+(cx*2)+' '+(cy+pad+30)+'" style="width:100%;max-width:420px;display:block;margin:0 auto">';
    /* cercles de vitesse */
    for(var v=2;v<=vmax;v+=Math.max(2,Math.round(vmax/5/2)*2)){
      var r=R*v/vmax;
      s+='<circle cx="'+cx+'" cy="'+cy+'" r="'+r.toFixed(1)+'" fill="none" stroke="#1d3a52" stroke-width="1"/>';
      s+='<text x="'+(cx+4)+'" y="'+(cy-r+11)+'" fill="#5b7f99" font-size="9">'+v+' kt</text>';
    }
    /* rayons tous les 30 deg */
    for(var a=0;a<=180;a+=30){
      var rad=a*Math.PI/180;
      s+='<line x1="'+cx+'" y1="'+cy+'" x2="'+(cx+R*Math.sin(rad)).toFixed(1)+'" y2="'+(cy-R*Math.cos(rad)).toFixed(1)+'" stroke="#1d3a52" stroke-width="1"/>';
      var lx=cx+(R+13)*Math.sin(rad), ly=cy-(R+13)*Math.cos(rad);
      s+='<text x="'+lx.toFixed(1)+'" y="'+(ly+3).toFixed(1)+'" fill="#5b7f99" font-size="9" text-anchor="middle">'+a+'°</text>';
    }
    /* une courbe par TWS */
    var parTws={};
    d.grille.forEach(function(c){ (parTws[c.tws]=parTws[c.tws]||[]).push(c); });
    var tws=Object.keys(parTws).map(Number).sort(function(a,b){return a-b;});
    var couleurs=['#38bdf8','#0284c7','#16a34a','#eab308','#ea580c','#dc2626','#a855f7'];
    var leg='';
    var nSolides=0, nFaibles=0;
    tws.forEach(function(t,i){
      var pts=parTws[t].sort(function(a,b){return a.twa-b.twa;});
      var col=couleurs[i%couleurs.length];
      /* le trait relie les points consecutifs ; il est pointille des qu'une des
         deux extremites repose sur moins de 3 mesures */
      for(var k=1;k<pts.length;k++){
        var a1=pts[k-1], b1=pts[k];
        var r1=R*Math.min(a1.mediane,vmax)/vmax, r2=R*Math.min(b1.mediane,vmax)/vmax;
        var x1=cx+r1*Math.sin(a1.twa*Math.PI/180), y1=cy-r1*Math.cos(a1.twa*Math.PI/180);
        var x2=cx+r2*Math.sin(b1.twa*Math.PI/180), y2=cy-r2*Math.cos(b1.twa*Math.PI/180);
        var sur=(a1.n>=3&&b1.n>=3);
        s+='<line x1="'+x1.toFixed(1)+'" y1="'+y1.toFixed(1)+'" x2="'+x2.toFixed(1)+'" y2="'+y2.toFixed(1)+'" stroke="'+col+'" stroke-width="'+(sur?2:1.3)+'"'+(sur?'':' stroke-dasharray="4 3" opacity="0.75"')+'/>';
      }
      pts.forEach(function(c){
        var rad=c.twa*Math.PI/180, r=R*Math.min(c.mediane,vmax)/vmax;
        var solide=c.n>=3; if(solide)nSolides++; else nFaibles++;
        s+='<circle cx="'+(cx+r*Math.sin(rad)).toFixed(1)+'" cy="'+(cy-r*Math.cos(rad)).toFixed(1)+'" r="'+(solide?3.2:2)+'" fill="'+col+'"'+(solide?'':' opacity="0.7"')+'><title>'+c.tws+' kt / '+c.twa+'° : '+c.mediane+' kt ('+c.n+' mesure'+(c.n>1?'s':'')+')</title></circle>';
      });
      leg+='<span style="display:inline-block;margin-right:10px;white-space:nowrap"><span style="display:inline-block;width:14px;height:3px;background:'+col+';vertical-align:middle;margin-right:4px"></span>'+t+' kt</span>';
    });
    s+='</svg>';
    return s+'<div style="font-size:11px;color:#8fb0c4;margin-top:6px;text-align:center">'+leg+'</div>'
      +'<div style="font-size:11px;color:#8fb0c4;margin-top:4px;text-align:center">Trait plein = 3 mesures ou plus · pointillé = 1 à 2 mesures ('
      +nSolides+' solide'+(nSolides>1?'s':'')+', '+nFaibles+' fragile'+(nFaibles>1?'s':'')+')</div>';
  }
  function rendrePolaire(d){
    var z=document.getElementById('polOut');
    if(!z) return;
    if(d.error){z.innerHTML='<div style="color:#8fb0c4">'+esc(d.error)+'</div>';return;}
    if(d.vide||!d.grille||!d.grille.length){
      z.innerHTML='<div style="color:#8fb0c4">Pas encore assez de navigations exploitables sur cette période.</div>';return;
    }
    var vmax=0; d.grille.forEach(function(c){if(c.mediane>vmax)vmax=c.mediane;});
    var twsL=[],twaL=[];
    d.grille.forEach(function(c){if(twsL.indexOf(c.tws)<0)twsL.push(c.tws);if(twaL.indexOf(c.twa)<0)twaL.push(c.twa);});
    twsL.sort(function(a,b){return a-b;}); twaL.sort(function(a,b){return a-b;});
    var m={}; d.grille.forEach(function(c){m[c.tws+':'+c.twa]=c;});
    polData=d;
    var h='<div style="color:#8fb0c4;font-size:12px;margin-bottom:6px">'
      +d.retenus+' segment(s) retenu(s) · '+d.cases+' case(s) · '+d.avecCourant+' corrigé(s) du courant'
      +(d.sansVent?(' · '+d.sansVent+' sans vent archivé'):'')+'</div>'
      +'<div style="margin-bottom:8px"><button id="polVue">'+(polMode==='table'?'Voir en diagramme':'Voir en tableau')+'</button></div>';
    if(polMode==='graph'){ z.innerHTML=h+svgPolaire(d); return; }
    h+='<div style="overflow-x:auto"><table><tr><th>TWA \\ TWS</th>';
    twsL.forEach(function(t){h+='<th>'+t+'</th>';});
    h+='</tr>';
    twaL.forEach(function(a){
      h+='<tr><td>'+a+'°</td>';
      twsL.forEach(function(t){
        var c=m[t+':'+a];
        if(!c){h+='<td style="color:#33556e">·</td>';return;}
        var fiable=c.n>=8;
        h+='<td title="'+c.n+' mesure(s), dispersion '+c.dispersion+' kt" style="background:'+couleurV(c.mediane,vmax)+';color:#fff;border-radius:4px;'+(fiable?'':'opacity:.45')+'">'
          +c.mediane.toFixed(1).replace('.',',')+'</td>';
      });
      h+='</tr>';
    });
    h+='</table></div><div style="color:#8fb0c4;font-size:11px;margin-top:6px">Valeurs en nœuds (médiane). Les cases pâles reposent sur moins de 8 mesures.</div>';
    z.innerHTML=h;
  }
  document.addEventListener('click',function(e){
    if(e.target&&e.target.id==='polVue'){
      polMode=(polMode==='table')?'graph':'table';
      if(polData) rendrePolaire(polData);
      return;
    }
    if(e.target&&e.target.id==='polGo'){
      var b=e.target; b.disabled=true; b.textContent='Calcul…';
      fetch('/api/boats/'+bid+'/polaire?'+periodeQS())
        .then(function(r){return r.json();})
        .then(function(d){b.disabled=false;b.textContent='Recalculer';rendrePolaire(d);})
        .catch(function(){b.disabled=false;b.textContent='Calculer la polaire';
          var z=document.getElementById('polOut'); if(z) z.innerHTML='<div style="color:#8fb0c4">Calcul indisponible.</div>';});
    }
  });
  document.getElementById('jours').onchange=function(){
    var perso=this.value==='perso';
    document.getElementById('zoneDates').style.display=perso?'block':'none';
    if(!perso) charger();
  };
  document.getElementById('dGo').onclick=charger;
  charger();
})();
</script></body></html>`;
const PAGE_JOIN = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Rejoindre la flotte</title>
<style>
  :root{--navy:#0a1a26;--navy2:#0e2636;--panel:#0e2636;--line:#1d3a4d;--amber:#f5a623;--amber2:#ffc25a;--cyan:#39c0d3;--ink:#e8f1f6;--dim:#8fb0c2}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(120% 90% at 50% 0%,#12314a 0%,var(--navy) 60%);color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px}
  .wrap{width:100%;max-width:460px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px}
  h1{margin:0 0 6px;font-size:20px}
  p{color:var(--dim);font-size:14px;line-height:1.5}
  input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#0a1e2c;color:var(--ink);font-size:16px;margin:8px 0}
  button{width:100%;padding:12px;border:0;border-radius:10px;background:linear-gradient(180deg,var(--amber2),var(--amber));color:#241400;font-weight:700;font-size:15px;cursor:pointer}
  .link{display:block;word-break:break-all;background:#0a1e2c;border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--cyan);font-family:ui-monospace,monospace;font-size:12px;margin:8px 0;text-decoration:none}
  .hint{font-size:12px}
  .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-top:12px}
  .btnlink{display:block;text-align:center;background:var(--amber);color:#0a1a26;text-decoration:none;
    font-weight:700;font-size:15px;border-radius:10px;padding:13px;margin-top:12px}
  .step{display:flex;gap:11px;margin-top:16px;align-items:flex-start}
  .step .num{flex:0 0 26px;height:26px;border-radius:50%;background:var(--amber);color:#0a1a26;
    font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;margin-top:1px}
  .step b{font-size:14.5px}
  .cfg{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:13px}
  .cfg td{padding:5px 0;border-top:1px solid #12303f;color:var(--dim)}
  .cfg td:last-child{text-align:right;color:var(--ink);font-weight:600}
  .warn2{margin-top:18px;padding:11px 13px;background:rgba(245,166,35,.08);
    border:1px solid rgba(245,166,35,.3);border-radius:10px;font-size:12.5px;line-height:1.7;color:var(--dim)}
  .warn2 b{color:var(--amber2)}
  .err{color:#e6584c;font-size:13px;min-height:16px}
  button.copy{background:#123147;color:var(--ink);border:1px solid var(--line);margin-top:6px}
</style>
</head>
<body>
<div class="wrap">
  <h1>⛵ Rejoindre la flotte</h1>
  <p id="sub">Entre le nom de ton bateau pour rejoindre la flotte et apparaître sur la carte commune.</p>
  <div id="form">
    <input id="boat" placeholder="Nom du bateau (ex. EKINOX)" maxlength="40" autocomplete="off">
    <button id="go">Rejoindre la flotte</button>
  </div>
  <div id="result" style="display:none">
    <p style="color:var(--green);font-weight:600;margin-top:0">✓ <span id="okName">Ton bateau</span> est enregistré dans la flotte.</p>
    <a id="follow" class="btnlink" href="#">🗺 Suivre la flotte sur la carte</a>
    <p class="hint" style="margin-top:6px">Garde cette page en favori : c’est ton espace: réglages d’émission, suivi de la flotte, et retrait quand tu le souhaites.</p>
    <p>Pour apparaître sur la carte, ton téléphone doit envoyer sa position. On utilise <b>Traccar Client</b>, une application gratuite qui émet en arrière-plan, écran éteint. Compte trois minutes de réglage, une fois pour toutes.</p>

    <div class="step"><span class="num">1</span><div>
      <b>Installe Traccar Client</b><br>
      <span class="hint">Cherche « Traccar Client » sur l'App&nbsp;Store (iPhone) ou Google&nbsp;Play (Android). L'icône est un losange vert. C'est gratuit et sans compte à créer.</span>
    </div></div>

    <div class="step"><span class="num">2</span><div>
      <b>Ouvre les réglages de l'application</b><br>
      <span class="hint">Sur l'écran d'accueil de Traccar, bouton <i>Modifier les paramètres</i> (ou l'engrenage).</span>
    </div></div>

    <div class="step"><span class="num">3</span><div>
      <b>Renseigne ces deux valeurs</b> (les plus importantes)
      <div class="lbl" style="margin-top:9px">URL du serveur</div>
      <div id="turl" class="link"></div>
      <button id="copyUrl" class="copy">Copier l'URL</button>
      <div class="lbl" style="margin-top:9px">Identifiant de l'appareil</div>
      <div id="tkey" class="link"></div>
      <button id="copyKey" class="copy">Copier l'identifiant</button>
      <p class="hint" style="margin-top:8px">Cet identifiant est <b>personnel</b> : il relie les positions à ton bateau. Ne le partage pas, garde cette page en favori.</p>
    </div></div>

    <div class="step"><span class="num">4</span><div>
      <b>Complète les autres réglages</b>
      <table class="cfg">
        <tr><td>Précision de la localisation</td><td>La plus élevée</td></tr>
        <tr><td>Intervalle</td><td>60 s</td></tr>
        <tr><td>Distance</td><td>0 (ou 75 m)</td></tr>
        <tr><td>Angle</td><td>0</td></tr>
        <tr><td>Heartbeat à l'arrêt</td><td>60 s</td></tr>
      </table>
      <span class="hint">Le « heartbeat » fait émettre même bateau immobile : sans lui, tu disparais de la carte au mouillage.</span>
    </div></div>

    <div class="step"><span class="num">5</span><div>
      <b>Autorise la localisation en permanence</b><br>
      <span class="hint"><b>iPhone</b> : Réglages → Traccar → Position → <b>Toujours</b>, et <b>Position précise</b> activée.<br>
      <b>Android</b> : Autorisation <b>Toujours autoriser</b>, puis Applications → Traccar → Batterie → <b>Sans restriction</b> (sinon le système coupe l'application). Active aussi <i>Wake lock</i> dans les paramètres avancés.</span>
    </div></div>

    <div class="step"><span class="num">6</span><div>
      <b>Active le service</b><br>
      <span class="hint">Reviens à l'écran principal et bascule <b>Suivi continu</b>. C'est tout : tu peux verrouiller le téléphone.</span>
    </div></div>

    <div class="step"><span class="num">7</span><div>
      <b>Vérifie que ça marche</b><br>
      <span class="hint">Appuie sur <i>Envoyer la position</i>, puis sur <i>Afficher l'état</i>. Tu dois lire <b>Upload response 200</b>. Si tu vois 404, l'identifiant est mal recopié ; 400, l'URL est incorrecte.</span>
    </div></div>

    <div class="warn2">
      <b>À savoir</b><br>
      • Prévois une <b>alimentation</b> : l'émission en continu consomme la batterie.<br>
      • Hors couverture réseau (au large), rien ne peut être transmis — les positions manquantes ne seront pas rattrapées si le téléphone s'éteint.<br>
      • Ta position n'est visible que par les personnes disposant du lien de suivi de la flotte.
    </div>

    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
      <button id="leave" style="background:transparent;color:#e6584c;border:1px solid #46242a;font-weight:600">Me retirer de cette flotte</button>
      <p id="leaveMsg" class="hint"></p>
      <p class="hint">Tu peux te retirer à tout moment : ton bateau disparaît de la carte commune. Ta trace reste conservée et ce lien continue de fonctionner.</p>
    </div>

    <details style="margin-top:14px">
      <summary class="hint" style="cursor:pointer;color:var(--cyan)">Autre méthode : émettre depuis le navigateur</summary>
      <p class="hint" style="margin-top:8px">Sans installer d'application, mais la page doit rester <b>ouverte au premier plan</b>, écran allumé. Utile pour un essai rapide, pas pour naviguer.</p>
      <a id="emit" class="link" target="_blank"></a>
      <button id="copy" class="copy">Copier le lien</button>
    </details>
  </div>
  <p id="err" class="err"></p>

  <div id="aisBox" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
    <div class="lbl">Ou suivre un bateau par son AIS</div>
    <p class="hint" style="margin-top:4px">Rien à installer à bord : si le bateau a un transpondeur AIS allumé, entre son <b>MMSI</b> (9 chiffres).</p>
    <input id="aisName" placeholder="Nom du bateau" maxlength="40" autocomplete="off">
    <input id="aisMmsi" placeholder="MMSI (9 chiffres)" maxlength="9" inputmode="numeric" autocomplete="off">
    <button id="aisGo">Ajouter par MMSI</button>
    <p id="aisMsg" class="hint"></p>
    <div class="lbl" style="margin-top:10px">Enregistrement d'un point tous les</div>
    <select id="aisInt" style="width:100%;background:#0a1e2c;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:15px;margin-top:6px">
      <option value="10">10 minutes</option>
      <option value="15">15 minutes</option>
      <option value="30">30 minutes</option>
      <option value="60">1 heure</option>
      <option value="90">1 h 30</option>
      <option value="120">2 heures</option>
    </select>
    <p id="aisIntMsg" class="hint">Vaut pour les bateaux AIS de cette flotte. Plus l'intervalle est court, plus la trace est fine — et plus le quota de stockage est consommé.</p>
    <p class="hint">Portée : réseau de stations côtières. Un AIS classe B (2 W) porte 8–10 milles — parfait près des côtes, inopérant au large.</p>
  </div>
</div>
<script>
"use strict";
var fid=new URLSearchParams(location.search).get('fleet');
var ADMK=new URLSearchParams(location.search).get('k')||'';
var $=function(i){return document.getElementById(i);};
/* Ajouter un MMSI ou changer l'intervalle consomme le quota AIS de la flotte :
   ces commandes ne sont offertes qu'avec la clé de gestion (/join?fleet=…&k=…).
   L'inscription d'un bateau par lien d'invitation, elle, reste ouverte. */
if(!ADMK){ var bx=document.getElementById('aisBox'); if(bx) bx.style.display='none'; }
if(!fid){$('sub').textContent='Lien de flotte invalide ou manquant.';$('form').style.display='none';$('aisBox').style.display='none';}
$('aisGo').onclick=function(){
  var nm=$('aisName').value.trim(), mm=$('aisMmsi').value.replace(/[^0-9]/g,'');
  if(mm.length!==9){$('aisMsg').style.color='#e6584c';$('aisMsg').textContent='Le MMSI doit comporter 9 chiffres.';return;}
  $('aisMsg').style.color='';$('aisMsg').textContent='…';$('aisGo').disabled=true;
  fetch('/api/fleets/'+fid+'/mmsi',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':ADMK},body:JSON.stringify({name:nm,mmsi:mm})})
   .then(function(r){return r.json();}).then(function(d){
     $('aisGo').disabled=false;
     if(d.error){$('aisMsg').style.color='#e6584c';$('aisMsg').textContent=d.error;return;}
     $('aisMsg').style.color='#37c871';
     $('aisMsg').textContent=(d.already?'Déjà suivi — ajouté à la flotte.':'Ajouté. Il apparaîtra dès qu\\u2019une station AIS captera son signal.');
     $('aisName').value='';$('aisMmsi').value='';
   }).catch(function(){$('aisGo').disabled=false;$('aisMsg').style.color='#e6584c';$('aisMsg').textContent='Erreur réseau, réessaie.';});
};
fetch('/api/fleets/'+fid+'/settings').then(function(r){return r.json();}).then(function(d){
  if(d&&d.aisIntervalMin)$('aisInt').value=String(d.aisIntervalMin);
  if(d&&d.aisEnabled===false){
    $('aisGo').disabled=true;
    $('aisInt').disabled=true;
    $('aisMsg').textContent='Suivi AIS inactif : une clé aisstream.io (gratuite) doit être ajoutée dans AIS_API_KEY sur le serveur.';
  }
}).catch(function(){});
$('aisInt').onchange=function(){
  var v=this.value;
  $('aisIntMsg').style.color='';$('aisIntMsg').textContent='Enregistrement…';
  fetch('/api/fleets/'+fid+'/settings',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':ADMK},body:JSON.stringify({aisIntervalMin:parseInt(v,10)})})
   .then(function(r){return r.json();}).then(function(d){
     if(d.error){$('aisIntMsg').style.color='#e6584c';$('aisIntMsg').textContent=d.error;return;}
     $('aisIntMsg').style.color='#37c871';$('aisIntMsg').textContent='Réglé sur 1 point toutes les '+d.aisIntervalMin+' min.';
   }).catch(function(){$('aisIntMsg').style.color='#e6584c';$('aisIntMsg').textContent='Erreur réseau.';});
};
function showSpace(d){
  var url=location.origin+'/p?id='+d.id+'&key='+d.publishKey;
  var osmand=location.origin+'/api/osmand';
  $('okName').textContent=d.name||'Ton bateau';
  $('turl').textContent=osmand;
  $('tkey').textContent=d.publishKey;
  $('follow').href='/vf?id='+fid;
  var a=$('emit');a.textContent=url;a.href=url;
  $('form').style.display='none';$('aisBox').style.display='none';$('result').style.display='block';
  function cp(btn,txt){if(!btn)return;btn.onclick=function(){try{navigator.clipboard.writeText(txt);this.textContent='Copié ✓';}catch(e){}};}
  cp($('copyUrl'),osmand);cp($('copyKey'),d.publishKey);cp($('copy'),url);
  $('leave').onclick=function(){
    if(!confirm('Te retirer de cette flotte ?\\n\\nTon bateau n\\'apparaîtra plus sur la carte commune.'))return;
    var b=this;b.disabled=true;
    fetch('/api/tracks/'+d.id+'/leave',{method:'POST',headers:{'x-publish-key':d.publishKey}})
     .then(function(r){return r.json();}).then(function(x){
       b.disabled=false;
       if(x.error){$('leaveMsg').style.color='#e6584c';$('leaveMsg').textContent=x.error;return;}
       try{localStorage.removeItem('st_boat_'+fid);}catch(e){}
       $('leaveMsg').style.color='#37c871';
       $('leaveMsg').textContent='Tu es retiré de la flotte. Recharge la page pour t\\'inscrire à nouveau.';
       b.style.display='none';$('follow').style.display='none';
     }).catch(function(){b.disabled=false;$('leaveMsg').style.color='#e6584c';$('leaveMsg').textContent='Erreur réseau.';});
  };
}

/* si ce bateau est déjà inscrit sur cet appareil, on retrouve son espace */
(function(){
  if(!fid)return;
  var saved=null; try{ saved=JSON.parse(localStorage.getItem('st_boat_'+fid)||'null'); }catch(e){}
  if(!saved||!saved.id)return;
  fetch('/api/tracks/'+saved.id).then(function(r){return r.ok?r.json():null;}).then(function(t){
    if(!t||!t.id){ try{localStorage.removeItem('st_boat_'+fid);}catch(e){} return; }
    if(!t.fleets){ try{localStorage.removeItem('st_boat_'+fid);}catch(e){} return; }
    saved.name=t.name; showSpace(saved);
  }).catch(function(){});
})();

$('go').onclick=function(){
  var name=$('boat').value.trim();
  if(!name){$('err').textContent='Indique un nom de bateau.';return;}
  $('err').textContent='';$('go').disabled=true;$('go').textContent='…';
  fetch('/api/fleets/'+fid+'/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
   .then(function(r){return r.json();}).then(function(d){
     if(d.error){$('err').textContent=d.error;$('go').disabled=false;$('go').textContent='Rejoindre la flotte';return;}
     try{localStorage.setItem('st_boat_'+fid,JSON.stringify({id:d.id,publishKey:d.publishKey,name:d.name}));}catch(e){}
     showSpace(d);
   }).catch(function(){$('err').textContent='Erreur réseau';$('go').disabled=false;$('go').textContent='Rejoindre la flotte';});
};
</script>
</body>
</html>
`;
const PAGE_ADMIN = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Console — Sea Tracker</title>
<style>
  :root{--navy:#0a1a26;--navy2:#0e2636;--line:#1d3a4d;
    --amber:#f5a623;--amber2:#ffc25a;--cyan:#39c0d3;--ink:#e8f1f6;--dim:#8fb0c2;--green:#37c871;--red:#e6584c}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:var(--navy);color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    padding:env(safe-area-inset-top) 14px calc(env(safe-area-inset-bottom) + 30px)}
  h1{font-size:20px;margin:18px 0 4px}
  .sub{color:var(--dim);font-size:13px;margin:0 0 16px}
  .card{background:var(--navy2);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px}
  .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:5px}
  input,select,textarea{width:100%;background:#0a1e2c;color:var(--ink);border:1px solid var(--line);
    border-radius:10px;padding:11px;font-size:15px;font-family:inherit}
  textarea{min-height:74px;resize:vertical}
  button{background:var(--amber);color:#0a1a26;border:0;border-radius:10px;padding:11px 14px;
    font-size:15px;font-weight:700;cursor:pointer;margin-top:9px;width:100%}
  button.sec{background:transparent;color:var(--ink);border:1px solid var(--line);font-weight:600}
  button.danger{background:transparent;color:var(--red);border:1px solid #46242a;font-weight:600}
  .row{display:flex;gap:8px}
  .row button{flex:1}
  .fname{font-weight:700;font-size:16px}
  .meta{color:var(--dim);font-size:12px;margin-top:2px}
  .link{display:block;background:#0a1e2c;border:1px solid var(--line);border-radius:9px;
    padding:9px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--cyan);
    word-break:break-all;margin-top:6px;text-decoration:none}
  details{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}
  summary{cursor:pointer;color:var(--cyan);font-size:13px;font-weight:600}
  .boat{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid #12303f;font-size:14px}
  .boat:first-of-type{border-top:0}
  .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
  .bn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bs{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
  .x{color:#5f7482;cursor:pointer;padding:0 4px}
  .msg{font-size:13px;margin-top:8px;min-height:18px}
  .err{color:var(--red)}
  .ok{color:var(--green)}
  .empty{color:var(--dim);font-size:14px;text-align:center;padding:18px 0}
</style>
</head>
<body>

<h1>⚓️ Console des flottes</h1>
<p class="sub" id="sub">Créer, suivre et gérer toutes tes flottes.</p>

<div class="card" id="authCard" style="display:none">
  <div class="lbl">Clé de la console</div>
  <input id="key" type="password" placeholder="ADMIN_KEY" autocomplete="off">
  <button id="auth">Ouvrir la console</button>
  <p class="msg err" id="authMsg"></p>
</div>

<div id="app" style="display:none">
  <div class="card">
    <div class="lbl">Créer une ou plusieurs flottes</div>
    <textarea id="names" placeholder="Un nom par ligne (ou séparés par des virgules)&#10;Entraînement mardi&#10;Régate du Golfe&#10;Sélective Class40"></textarea>
    <button id="create">Créer</button>
    <p class="msg" id="createMsg"></p>
  </div>

  <div id="list"></div>

  <div class="card">
    <div class="lbl">Tri des bateaux désactivés (Émet)</div>
    <button id="triBtn">Charger la liste des désactivés</button>
    <div id="triZone" style="display:none">
      <div style="margin:10px 0 6px">
        <div id="triCompte" style="font-size:12px;color:#8fb0c4;margin-bottom:6px"></div>
        <label style="font-size:12px;display:inline-flex;gap:8px;align-items:center"><input type="checkbox" id="triTous" style="width:20px;height:20px"> tout cocher</label>
      </div>
      <div id="triListe" style="max-height:340px;overflow-y:auto;overflow-x:hidden;font-size:13px;line-height:1.5;-webkit-overflow-scrolling:touch"></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="triReactiver">Réactiver la sélection</button>
        <button id="triSupprimer" style="background:#7f1d1d">Supprimer la sélection</button>
      </div>
      <div style="font-size:11px;color:#8fb0c4;margin-top:6px">Rappel : le temps réel aisstream est plafonné à 50 bateaux actifs — au-delà, les moins prioritaires passent en interrogation lente.</div>
      <p class="msg" id="triMsg"></p>
    </div>
  </div>

  <div class="card">
    <div class="lbl">Test des calques météo</div>
    <button id="mtBtn">Tester les tuiles OpenWeather</button>
    <div id="mtOut" style="margin-top:8px;font-size:13px;line-height:1.6"></div>
  </div>

  <div class="card">
    <div class="lbl">Diagnostic du serveur</div>
    <button id="diagBtn">Lancer le diagnostic</button>
    <div id="diagOut" style="display:none;margin-top:10px;font-size:12.5px;line-height:1.55"></div>
    <p class="msg" id="diagMsg"></p>
  </div>

  <div class="card">
    <details>
      <summary>Récupérer une flotte existante</summary>
      <p class="sub" style="margin:8px 0">Une flotte créée avant la console n'apparaît pas dans la liste. Colle son identifiant (les 16 caractères après <code>id=</code> dans son lien) pour la rattacher.</p>
      <input id="adoptId" placeholder="ex. 9c8634ab2c78a9fa" autocomplete="off">
      <button class="sec" id="adopt">Rattacher</button>
      <p class="msg" id="adoptMsg"></p>
    </details>
  </div>
  <div style="text-align:center;margin:4px 0 26px">
    <a href="#" id="logout" style="color:#8fb0c2;font-size:13px;text-decoration:none">Oublier la clé sur cet appareil</a>
    <div id="ver" style="color:#5f7482;font-size:11px;margin-top:10px">version —</div>
  </div>
</div>

<script>
"use strict";
var $=function(i){return document.getElementById(i);};
var K=new URLSearchParams(location.search).get('k')||'';
try{ if(!K) K=localStorage.getItem('st_key')||''; }catch(e){}
function saveKey(k){ try{ localStorage.setItem('st_key',k); }catch(e){} }
function forgetKey(){ try{ localStorage.removeItem('st_key'); }catch(e){} }
var ORIGIN=location.origin;
var AIS=false;
var INTERVALLES={}; /* intervalle AIS par flotte, pour le seuil hors-ligne */

function api(path,opts){
  opts=opts||{};
  opts.headers=Object.assign({'Content-Type':'application/json','x-admin-key':K},opts.headers||{});
  return fetch(path,opts).then(function(r){return r.json().then(function(j){return {code:r.status,body:j};});});
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function say(el,txt,cls){el.className='msg '+(cls||'');el.textContent=txt;}
function cp(txt,btn){try{navigator.clipboard.writeText(txt);var o=btn.textContent;btn.textContent='Copié ✓';setTimeout(function(){btn.textContent=o;},1400);}catch(e){}}
function age(ms){var s=Math.floor((Date.now()-ms)/1000);if(s<60)return "à l'instant";if(s<3600)return 'il y a '+Math.floor(s/60)+' min';if(s<86400)return 'il y a '+Math.floor(s/3600)+' h';return 'il y a '+Math.floor(s/86400)+' j';}

$('auth').onclick=function(){
  var v=$('key').value.trim();
  if(!v){say($('authMsg'),'Saisis la clé.','err');return;}
  K=v; saveKey(v); $('authCard').style.display='none'; boot();
};
$('key').addEventListener('keydown',function(e){if(e.key==='Enter')$('auth').click();});

function boot(){
  if(!K){$('authCard').style.display='block';return;}
  api('/api/admin/fleets').then(function(r){
    if(r.code!==200){
      forgetKey();
      $('authCard').style.display='block';
      say($('authMsg'),(r.body&&r.body.error)||'Accès refusé','err');
      return;
    }
    AIS=!!r.body.aisEnabled;
    saveKey(K);
    try{ if(location.search.indexOf('k=')>=0) history.replaceState(null,'','/admin'); }catch(e){}
    $('app').style.display='block';
    render(r.body.fleets);
  }).catch(function(){$('authCard').style.display='block';say($('authMsg'),'Erreur réseau','err');});
}

function reload(){
  api('/api/admin/fleets').then(function(r){if(r.code===200){AIS=!!r.body.aisEnabled;render(r.body.fleets);}});
}

function render(fleets){
  var el=$('list');
  if(!fleets.length){el.innerHTML='<div class="card"><div class="empty">Aucune flotte pour l\\u2019instant.<br>Crée la première ci-dessus.</div></div>';return;}
  var h='';
  fleets.forEach(function(f){
    INTERVALLES[f.id]=f.aisIntervalMin;
    var vf=ORIGIN+'/vf?id='+f.id;
    var jn=ORIGIN+'/join?fleet='+f.id;
    h+='<div class="card" data-f="'+f.id+'">'
      +'<div class="fname">'+esc(f.name)+'</div>'
      +'<div class="meta">'+f.boats+' bateau'+(f.boats>1?'x':'')+' · créée '+age(f.createdAt||Date.now())+'</div>'
      +'<div class="row"><button data-go="'+f.id+'">Suivre</button>'
      +'<button class="sec" data-inv="'+f.id+'">Copier l\\u2019invitation</button></div>'
      +'<details data-det="'+f.id+'">'
      +'<summary>Gérer cette flotte</summary>'
      +'<div class="lbl" style="margin-top:10px">Lien de suivi (public)</div>'
      +'<a class="link" href="'+ORIGIN+'/vf?id='+f.id+'" target="_blank">'+ORIGIN+'/vf?id='+f.id+'</a>'
      +'<button class="sec" data-cpv="'+ORIGIN+'/vf?id='+f.id+'">Copier le lien de suivi</button>'
      +'<div class="lbl" style="margin-top:12px">Lien d\\u2019invitation skipper</div>'
      +'<a class="link" href="'+jn+'" target="_blank">'+jn+'</a>'
      +'<div class="lbl" style="margin-top:12px">Renommer</div>'
      +'<input data-nm="'+f.id+'" value="'+esc(f.name)+'" maxlength="80">'
      +'<button class="sec" data-ren="'+f.id+'">Enregistrer le nom</button>'
      +(AIS?('<div class="lbl" style="margin-top:12px">AIS — un point tous les</div>'
      +'<select data-int="'+f.id+'">'+[10,15,30,60,90,120].map(function(v){return '<option value="'+v+'"'+(v===f.aisIntervalMin?' selected':'')+'>'+v+' min</option>';}).join('')+'</select>'):'')
      +'<div class="lbl" style="margin-top:12px">Traces</div>'
      +'<div class="row"><button class="sec" data-exp="'+ORIGIN+'/api/fleets/'+f.id+'/export?format=gpx">GPX</button>'
      +'<button class="sec" data-exp="'+ORIGIN+'/api/fleets/'+f.id+'/export?format=csv">CSV</button></div>'
      +'<div class="lbl" style="margin-top:12px">Bateaux</div>'
      +'<div data-boats="'+f.id+'"><div class="empty">Chargement…</div></div>'
      +'<button class="danger" data-del="'+f.id+'" style="margin-top:14px">Supprimer la flotte</button>'
      +'<p class="msg" data-msg="'+f.id+'"></p>'
      +'</details></div>';
  });
  el.innerHTML=h;
  wire(fleets);
}

function wire(fleets){
  document.querySelectorAll('[data-go]').forEach(function(b){b.onclick=function(){location.href=ORIGIN+'/vf?id='+this.getAttribute('data-go');};});
  document.querySelectorAll('[data-inv]').forEach(function(b){b.onclick=function(){cp(ORIGIN+'/join?fleet='+this.getAttribute('data-inv'),this);};});
  document.querySelectorAll('[data-cpv]').forEach(function(b){b.onclick=function(){cp(this.getAttribute('data-cpv'),this);};});
  document.querySelectorAll('[data-exp]').forEach(function(b){b.onclick=function(){window.open(this.getAttribute('data-exp'),'_blank');};});
  document.querySelectorAll('[data-det]').forEach(function(d){d.addEventListener('toggle',function(){if(this.open)loadBoats(this.getAttribute('data-det'));});});
  document.querySelectorAll('[data-ren]').forEach(function(b){b.onclick=function(){
    var fid=this.getAttribute('data-ren'), nm=document.querySelector('[data-nm="'+fid+'"]').value.trim();
    var m=document.querySelector('[data-msg="'+fid+'"]');
    api('/api/admin/fleets/'+fid,{method:'POST',body:JSON.stringify({name:nm})}).then(function(r){
      if(r.code!==200){say(m,r.body.error||'Erreur','err');return;}
      say(m,'Nom enregistré.','ok');reload();
    });
  };});
  document.querySelectorAll('[data-int]').forEach(function(sel){sel.onchange=function(){
    var fid=this.getAttribute('data-int'), v=parseInt(this.value,10);
    var m=document.querySelector('[data-msg="'+fid+'"]');
    api('/api/fleets/'+fid+'/settings',{method:'POST',body:JSON.stringify({aisIntervalMin:v})}).then(function(r){
        if(r.code!==200){say(m,(r.body&&r.body.error)||('Erreur '+r.code),'err');return;}
        INTERVALLES[fid]=r.body.aisIntervalMin;
        say(m,'AIS : un point toutes les '+r.body.aisIntervalMin+' min.','ok');
        loadBoats(fid);
      });
  };});
  document.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
    var fid=this.getAttribute('data-del');
    var f=fleets.filter(function(x){return x.id===fid;})[0];
    if(!confirm('Supprimer la flotte « '+((f&&f.name)||fid)+' » ?\\n\\nLes traces des bateaux sont conservées, mais la flotte et ses liens ne fonctionneront plus.'))return;
    api('/api/admin/fleets/'+fid,{method:'DELETE'}).then(function(){reload();});
  };});
}

/* meme regle que la carte de flotte : 2,5 intervalles AIS, plancher 15 min */
function seuilHorsLigne(fid){
  var v=parseInt(INTERVALLES[fid],10);
  return (v&&v>0)?Math.max(900000,Math.round(v*60000*2.5)):900000;
}
function loadBoats(fid){
  var box=document.querySelector('[data-boats="'+fid+'"]');
  fetch('/api/fleets/'+fid).then(function(r){return r.json();}).then(function(d){
    var b=(d&&d.boats)||[];
    if(!b.length){box.innerHTML='<div class="empty">Aucun bateau. Partage le lien d\\u2019invitation'+(AIS?' ou ajoute un MMSI ci-dessous':'')+'.</div>';}
    else{
      var nsuiv=b.filter(function(x){return x.suivi!==false;}).length;
      box.innerHTML='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:9px">'
        +'<span style="font-size:12px;color:#8fb0c2;flex:1;min-width:120px">Suivis par l\\'AIS : <b style="color:#e8f1f6">'+nsuiv+'</b> / '+b.length+'</span>'
        +'<button class="sec" data-selall="1" style="width:auto;padding:6px 12px;margin:0">Tout</button>'
        +'<button class="sec" data-selnone="1" style="width:auto;padding:6px 12px;margin:0">Aucun</button></div>'
        +'<div data-selmsg="1" style="font-size:12px;margin:0 0 8px;min-height:15px"></div>'
        + b.map(function(x){
        var on=x.last&&(Date.now()-x.last[2])<seuilHorsLigne(fid);
        var st=x.last?(on?((x.last[3]!=null?(Math.round(x.last[3]*10)/10)+' kt':'en ligne')):('vu '+age(x.last[2]))):'jamais vu';
        var suiv=x.suivi!==false;
        return '<div class="boat"'+(suiv?'':' style="opacity:.5"')+'>'
          +'<input type="checkbox" data-su="'+x.id+'"'+(suiv?' checked':'')+' style="width:17px;height:17px;accent-color:#f5a623;flex:0 0 auto">'
          +'<span class="dot" style="background:'+(on?'#37c871':'#6b7f8c')+'"></span>'
          +'<span class="bn">'+esc(x.name)+'</span><span class="bs">'+st+'</span>'
          +'<span class="x" data-ren="'+x.id+'|'+esc(x.name)+'">✎</span>'
          +'<span class="x" data-rm="'+fid+'|'+x.id+'|'+esc(x.name)+'" title="Retirer de la flotte">✕</span>'
          +'<span class="x" data-purge="'+x.id+'|'+esc(x.name)+'" title="Supprimer définitivement">🗑</span></div>';
      }).join('');
    }
    box.innerHTML+='<div class="lbl" style="margin-top:12px">Ajouter un bateau par AIS (MMSI)</div>';
    if(AIS){
      box.innerHTML+='<div class="lbl" style="margin-top:4px">Importer un fichier (txt, csv, xlsx)</div>'
        +'<input type="file" data-bfile="'+fid+'" accept=".txt,.csv,.tsv,.xlsx" style="padding:8px">'
        +'<div class="lbl" style="margin-top:10px">Ou coller une liste</div>'
        +'<textarea data-blk="'+fid+'" placeholder="Une ligne par bateau&#10;Magenta ; 205560470" style="min-height:70px;margin-bottom:6px"></textarea>'
        +'<button class="sec" data-bgo="'+fid+'">Analyser la liste collée</button>'
        +'<div data-prev="'+fid+'"></div>'
        +'<div class="lbl" style="margin-top:12px">Ou un bateau à la fois</div>'
        +'<input data-mn="'+fid+'" placeholder="Nom du bateau" maxlength="40">'
        +'<input data-mm="'+fid+'" placeholder="MMSI (9 chiffres)" inputmode="numeric" maxlength="9" style="margin-top:6px">'
        +'<button class="sec" data-madd="'+fid+'">Ajouter par MMSI</button>';
    } else {
      box.innerHTML+='<p class="sub" style="margin:4px 0 0">Suivi AIS inactif : il faut une clé <b>aisstream.io</b> (gratuite) '
        +'ajoutée dans la variable <code>AIS_API_KEY</code> sur le serveur. Tant qu\\'elle manque, les bateaux ne peuvent être suivis '
        +'que par l\\'application Traccar (lien d\\'invitation).</p>';
    }
    function majSuivi(ids,actif){
      var m=box.querySelector('[data-selmsg]')||document.querySelector('[data-msg="'+fid+'"]');
      say(m,'Mise à jour…','');
      api('/api/admin/suivi',{method:'POST',body:JSON.stringify({ids:ids,suivi:actif})}).then(function(r){
        if(r.code!==200){say(m,(r.body&&r.body.error)||('Erreur '+r.code),'err');return;}
        if(r.body.echecs){say(m,r.body.echecs+' bateau(x) non enregistré(s) sur '+r.body.total+' — stockage saturé, réessaie','err');}
        else{say(m,'✓ '+r.body.suivis+' bateau(x) suivi(s) par l\\'AIS.','ok');}
        setTimeout(function(){loadBoats(fid);},700);
      }).catch(function(){say(m,'Erreur réseau.','err');loadBoats(fid);});
    }
    var etats={}; b.forEach(function(x){etats[x.id]=x.suivi!==false;});
    box.querySelectorAll('[data-su]').forEach(function(c){
      c.checked=etats[c.getAttribute('data-su')]===true;
      c.onchange=function(){ majSuivi([this.getAttribute('data-su')],this.checked); };
    });
    function tous(actif){
      var ids=b.map(function(x){return x.id;});
      if(!ids.length)return;
      if(!actif&&!confirm('Ne plus suivre aucun des '+ids.length+' bateaux ?\\n\\nLeurs traces sont conservées.'))return;
      majSuivi(ids,actif);
    }
    var bt=box.querySelector('[data-selall]'); if(bt)bt.onclick=function(){tous(true);};
    var bn=box.querySelector('[data-selnone]'); if(bn)bn.onclick=function(){tous(false);};
    box.querySelectorAll('[data-ren]').forEach(function(s){s.onclick=function(){
      var pr=this.getAttribute('data-ren').split('|');
      var nv=prompt('Nom du bateau :',pr[1]); if(!nv||!nv.trim())return;
      api('/api/admin/boats/'+pr[0],{method:'POST',body:JSON.stringify({name:nv.trim()})}).then(function(){loadBoats(fid);});
    };});
    box.querySelectorAll('[data-purge]').forEach(function(s){s.onclick=function(){
      var pr=this.getAttribute('data-purge').split('|');
      if(!confirm('Supprimer définitivement '+pr[1]+' ?\\n\\nSa trace, son MMSI et ses appartenances seront effacés. Action irréversible.'))return;
      api('/api/admin/boats/'+pr[0],{method:'DELETE'}).then(function(r){
        var m=document.querySelector('[data-msg="'+fid+'"]');
        if(r.code!==200){say(m,(r.body&&r.body.error)||('Erreur '+r.code),'err');return;}
        say(m,'Bateau supprimé.','ok'); loadBoats(fid); reload();
      });
    };});
    box.querySelectorAll('[data-rm]').forEach(function(s){s.onclick=function(){
      var parts=this.getAttribute('data-rm').split('|');
      if(!confirm('Retirer '+parts[2]+' de la flotte ?'))return;
      api('/api/fleets/'+parts[0]+'/remove',{method:'POST',body:JSON.stringify({trackId:parts[1]})})
        .then(function(){loadBoats(parts[0]);reload();});
    };});
    var derniereCharge=null;
    function afficheApercu(fid,d){
      var z=box.querySelector('[data-prev="'+fid+'"]');
      if(!d.apercu||!d.apercu.length){z.innerHTML='<p class="sub">Aucun MMSI trouvé dans ce contenu.</p>';return;}
      var ex=d.apercu[0];
      var h='<p class="sub" style="margin:10px 0 4px">'+d.lignes+' ligne(s) lues. Choisis la colonne contenant le nom du bateau :</p>';
      ex.champs.forEach(function(c,i){
        h+='<div style="display:flex;gap:8px;align-items:center;margin:3px 0">'
         +'<button class="sec" data-col="'+(i+1)+'" style="width:auto;padding:6px 10px;margin:0">'+(i+1)+'</button>'
         +'<span style="font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(c)+'</span></div>';
      });
      h+='<div style="margin-top:6px"><button class="sec" data-col="auto" style="width:auto;padding:6px 10px">Automatique</button></div>'
       +'<p class="sub" style="margin-top:6px">MMSI détecté sur cette ligne : '+esc(ex.mmsi)+'</p>';
      z.innerHTML=h;
      z.querySelectorAll('[data-col]').forEach(function(b){b.onclick=function(){
        var c=this.getAttribute('data-col');
        lanceImport(fid,Object.assign({},derniereCharge,{colonne:c==='auto'?'':c}));
      };});
    }
    function lanceImport(fid,charge){
      var m=document.querySelector('[data-msg="'+fid+'"]');
      say(m,'Import en cours…','');
      fetch('/api/fleets/'+fid+'/mmsi/import',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':K},body:JSON.stringify(charge)})
       .then(function(r){return r.json();}).then(function(d){
         if(d.error){say(m,d.error,'err');return;}
         var txt=d.ajoutes+' ajouté(s), '+d.deja+' déjà présent(s)'+(d.renommes?' dont '+d.renommes+' renommé(s)':'')+' — '+d.trouves+' MMSI sur '+d.lignes+' ligne(s).';
         if(d.noms&&d.noms.length)txt+=' Ex. : '+d.noms.join(', ');
         say(m,txt,'ok');
         var z=box.querySelector('[data-prev="'+fid+'"]'); if(z)z.innerHTML='';
         var ta=box.querySelector('[data-blk="'+fid+'"]'); if(ta)ta.value='';
         loadBoats(fid);reload();
       }).catch(function(){say(m,'Erreur réseau.','err');});
    }
    function demandeApercu(fid,charge){
      derniereCharge=charge;
      var m=document.querySelector('[data-msg="'+fid+'"]');
      say(m,'Analyse…','');
      fetch('/api/fleets/'+fid+'/mmsi/import',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':K},body:JSON.stringify(Object.assign({apercu:true},charge))})
       .then(function(r){return r.json();}).then(function(d){
         if(d.error){say(m,d.error,'err');return;}
         say(m,'','');afficheApercu(fid,d);
       }).catch(function(){say(m,'Erreur réseau.','err');});
    }
    var bgo=box.querySelector('[data-bgo]');
    if(bgo)bgo.onclick=function(){
      var txt=box.querySelector('[data-blk="'+fid+'"]').value;
      if(!txt.trim()){say(document.querySelector('[data-msg="'+fid+'"]'),'Colle une liste d\\'abord.','err');return;}
      demandeApercu(fid,{text:txt});
    };
    var bfile=box.querySelector('[data-bfile]');
    if(bfile)bfile.onchange=function(){
      var f=this.files&&this.files[0]; if(!f)return;
      var m=document.querySelector('[data-msg="'+fid+'"]');
      if(f.size>4000000){say(m,'Fichier trop volumineux (4 Mo maximum).','err');return;}
      say(m,'Lecture de '+f.name+'…','');
      var fr=new FileReader();
      fr.onload=function(){ demandeApercu(fid,{name:f.name,b64:String(fr.result).split(',')[1]||''}); };
      fr.onerror=function(){say(m,'Lecture du fichier impossible.','err');};
      fr.readAsDataURL(f);
    };
    var add=box.querySelector('[data-madd]');
    if(add)add.onclick=function(){
      var nm=box.querySelector('[data-mn="'+fid+'"]').value.trim();
      var mm=box.querySelector('[data-mm="'+fid+'"]').value.replace(/[^0-9]/g,'');
      var m=document.querySelector('[data-msg="'+fid+'"]');
      if(mm.length!==9){say(m,'Le MMSI doit comporter 9 chiffres.','err');return;}
      fetch('/api/fleets/'+fid+'/mmsi',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':K},body:JSON.stringify({name:nm,mmsi:mm})})
        .then(function(r){return r.json();}).then(function(d){
          if(d.error){say(m,d.error,'err');return;}
          if(d.already){
            var det=[];
            if(d.renomme)det.push('renommé');
            if(d.reactive)det.push('suivi réactivé');
            say(m,'✓ MMSI déjà connu : bateau rattaché à la flotte'+(det.length?' ('+det.join(', ')+')':'')+'.','ok');
            loadBoats(fid);reload();return;
          }
          say(m,d.already?'Déjà suivi — rattaché à cette flotte.':'Ajouté. Il apparaîtra dès qu\\u2019une station AIS le captera.','ok');
          loadBoats(fid);reload();
        });
    };
  }).catch(function(){box.innerHTML='<div class="empty">Erreur de chargement.</div>';});
}

var triCache=[];
  if($('triBtn')){
  $('triBtn').onclick=function(){
    var b=$('triBtn'); b.disabled=true; b.textContent='Chargement…';
    api('/api/admin/diag').then(function(r){
      b.disabled=false; b.textContent='Recharger la liste';
      if(r.code!==200){say($('triMsg'),(r.body&&r.body.error)||('Erreur '+r.code),'err');return;}
      var d=r.body||{};
      triCache=(d.aisDetail||[]).filter(function(x){return x.desactive;});
      $('triZone').style.display='block';
      var hh=new Date(); $('triCompte').textContent=triCache.length+' bateau(x) désactivé(s) — liste chargée à '+('0'+hh.getHours()).slice(-2)+':'+('0'+hh.getMinutes()).slice(-2);
      if(!triCache.length){$('triListe').innerHTML='<div style="color:#8fb0c4">Aucun — tout le monde émet.</div>';return;}
      var h='';
      triCache.forEach(function(x){
        h+='<label style="display:flex;gap:10px;align-items:center;padding:5px 2px;border-bottom:1px solid #14293c">'
          +'<input type="checkbox" class="triCase" value="'+esc(x.tid||'')+'" style="flex:0 0 auto;width:20px;height:20px">'
          +'<span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(x.nom)+'</span>'
          +'<span style="flex:0 0 auto;color:#8fb0c4;font-variant-numeric:tabular-nums;font-size:12px">'+esc(x.mmsi)+'</span></label>';
      });
      $('triListe').innerHTML=h;
      $('triTous').checked=false;
    }).catch(function(){b.disabled=false;b.textContent='Charger la liste des désactivés';say($('triMsg'),'Diagnostic injoignable','err');});
  };
  $('triTous').onchange=function(){var v=this.checked;document.querySelectorAll('.triCase').forEach(function(c){c.checked=v;});};
  function triSelection(){return [].slice.call(document.querySelectorAll('.triCase:checked')).map(function(c){return c.value;}).filter(Boolean);}
  $('triReactiver').onclick=function(){
    var ids=triSelection(); if(!ids.length){say($('triMsg'),'Rien de coché.','err');return;}
    api('/api/admin/suivi',{method:'POST',body:JSON.stringify({ids:ids,suivi:true})}).then(function(r){
      if(r.code!==200){say($('triMsg'),(r.body&&r.body.error)||('Erreur '+r.code),'err');return;}
      say($('triMsg'),'✓ '+ids.length+' bateau(x) réactivé(s).','ok');$('triBtn').onclick();
    }).catch(function(){say($('triMsg'),'Échec de la réactivation.','err');});
  };
  $('triSupprimer').onclick=function(){
    var ids=triSelection(); if(!ids.length){say($('triMsg'),'Rien de coché.','err');return;}
    if(!confirm('Supprimer définitivement '+ids.length+' bateau(x) — fiches, traces et MMSI ?'))return;
    var fait=0, echecs=0;
    (function suivant(){
      if(!ids.length){say($('triMsg'),(echecs?'⚠︎ ':'✓ ')+fait+' supprimé(s)'+(echecs?', '+echecs+' échec(s)':'')+'.',echecs?'err':'ok');$('triBtn').onclick();return;}
      api('/api/admin/boats/'+ids.shift(),{method:'DELETE'}).then(function(r){if(r&&r.code===200)fait++;else echecs++;suivant();}).catch(function(){echecs++;suivant();});
    })();
  };
  } /* fin garde triBtn */
  if($('mtBtn')) $('mtBtn').onclick=function(){
    var b=this; b.disabled=true; b.textContent='Test en cours…';
    api('/api/admin/meteotest').then(function(r){
      b.disabled=false; b.textContent='Retester';
      if(r.code!==200){ $('mtOut').innerHTML='<span style="color:#f87171">Erreur '+r.code+'</span>'; return; }
      var d=r.body||{};
      if(d.ok===false&&d.raison){ $('mtOut').innerHTML='<span style="color:#f87171">'+esc(d.raison)+'</span>'; return; }
      var h='<div style="color:#8fb0c4">Clé de '+(d.cleLongueur||0)+' caractères</div>';
      (d.essais||[]).forEach(function(e){
        var ok=(e.code===200)&&!e.erreur;
        h+='<div style="color:'+(ok?'#4ade80':'#f87171')+'">'+(ok?'✓':'✗')+' '+esc(e.cible||e.nom||'')+' : '
          +esc(String(e.code||e.erreur||''))+(e.type?(' · '+esc(e.type)):'')
          +(e.detail?(' '+esc(String(e.detail).slice(0,90))):'')+'</div>';
      });
      $('mtOut').innerHTML=h;
    }).catch(function(){ b.disabled=false; b.textContent='Tester les tuiles OpenWeather'; $('mtOut').textContent='Test injoignable.'; });
  };
  document.getElementById('diagBtn').onclick=function(){
  var out=document.getElementById('diagOut'), msg=document.getElementById('diagMsg');
  say(msg,'Diagnostic en cours…','');
  api('/api/admin/diag').then(function(r){
    if(r.code!==200){say(msg,(r.body&&r.body.error)||('Erreur '+r.code),'err');return;}
    say(msg,'','');
    var d=r.body, h='';
    h+='<div style="font-weight:700;margin-bottom:6px">Résumé</div>';
    (d.resume||[]).forEach(function(l){h+='<div>• '+esc(l)+'</div>';});
    var det=d.aisDetail||[];
    if(det.length){
      var actifs=det.filter(function(x){return !x.desactive;});
      var coupes=det.filter(function(x){return x.desactive;});
      var muets=actifs.filter(function(x){return x.dernierRecuIlYaMin===null;});
      h+='<div style="font-weight:700;margin:10px 0 6px">Bateaux AIS actifs ('+actifs.length+', dont '+muets.length+' jamais reçus depuis le démarrage)</div>';
      actifs.slice(0,25).forEach(function(x){
        var quand=(x.dernierRecuIlYaMin===null)?'jamais reçu':('reçu il y a '+(x.dernierRecuIlYaMin<60?x.dernierRecuIlYaMin+' min':Math.round(x.dernierRecuIlYaMin/60)+' h'));
        var src=x.tempsReel?'temps réel':'VesselAPI seul';
        var sansFlotte=x.flottes?'':' — ⚠︎ sans flotte';
        h+='<div>'+esc(x.nom)+' <span style="color:#8fb0c4">('+esc(x.mmsi)+' · '+src+' · '+x.intervalleMin+' min)</span> — '+quand+sansFlotte+'</div>';
      });
      if(actifs.length>25) h+='<div style="color:#8fb0c4">… et '+(actifs.length-25)+' autres actifs (JSON complet : /api/admin/diag)</div>';
      if(coupes.length){
        h+='<div style="font-weight:700;margin:10px 0 6px">Suivi désactivé — case Émet décochée ('+coupes.length+')</div>';
        h+='<div style="color:#8fb0c4;margin-bottom:4px">Ces bateaux ne sont interrogés par aucune source AIS. Réactivez-les via la case Émet de la liste des bateaux.</div>';
        coupes.slice(0,15).forEach(function(x){h+='<div>'+esc(x.nom)+' <span style="color:#8fb0c4">('+esc(x.mmsi)+')</span></div>';});
        if(coupes.length>15) h+='<div style="color:#8fb0c4">… et '+(coupes.length-15)+' autres</div>';
      }
    }
    out.innerHTML=h; out.style.display='block';
  });
};

$('create').onclick=function(){
  var raw=$('names').value.trim();
  if(!raw){say($('createMsg'),'Indique au moins un nom.','err');return;}
  say($('createMsg'),'…','');
  api('/api/admin/fleets',{method:'POST',body:JSON.stringify({name:raw})}).then(function(r){
    if(r.code!==201){say($('createMsg'),(r.body&&r.body.error)||'Erreur','err');return;}
    say($('createMsg'),r.body.created.length+' flotte'+(r.body.created.length>1?'s créées':' créée')+'.','ok');
    $('names').value='';reload();
  });
};

$('adopt').onclick=function(){
  var v=$('adoptId').value.trim();
  say($('adoptMsg'),'…','');
  api('/api/admin/adopt',{method:'POST',body:JSON.stringify({id:v})}).then(function(r){
    if(r.code!==200){say($('adoptMsg'),(r.body&&r.body.error)||'Erreur','err');return;}
    say($('adoptMsg'),'« '+r.body.name+' » rattachée.','ok');
    $('adoptId').value='';reload();
  });
};

var lo=$('logout');
if(lo)lo.onclick=function(e){e.preventDefault();if(!confirm('Oublier la clé sur cet appareil ?'))return;forgetKey();location.href='/admin';};

fetch('/api/version').then(function(r){return r.json();}).then(function(d){
  var v=$('ver'); if(v&&d&&d.build)v.textContent='version '+d.build;
}).catch(function(){});

boot();
</script>
</body>
</html>
`;
const ICONS = { '/icon-180.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAGrklEQVR42u2dPW5VSRCFr4smISdxCiLzIAIStkHGQljELAIhRoMmYRsIiQAhUnsFLAFhJvCMsYzxu91dP6eqz5EDB+/ndvXXp6r7dt93dO/40UZRN0kYAopwUISDIhwU4aAIB0U4KMJBEQ6KcFCEg6IIB0U4KMJBGaqtOij6R8X5OeEgCrs/pDoujTSofUs5VhqZ0P/2KpQ0MkFKKsIhkuYKc1LSiIXfBWdDpBELIpIfDqmyXpcHkUYsiEhOOKT66j42IkIy2NJUziHr3Q6EtBAhGWx7BucQ7h/AspC2LBlHcmf/i3+cf/eOBgAfbREyulDY83ZzXAD4aIWxmARi/4dbgRKdYlo9MkyZuP0bTSiJs5BWiQx/LG68AH1EgvhoBcgIZ8LDSCL4aKnJ0MXi7MvHy/8fnDyFMxJ3PlpSMtDcwgkRXz6EZDjnGvxpf4RzaLQqIxb6FuLlH0IyUlqIi3+0FGTUwELZQuz9Q0hGYgsx9g+pH8HpaW291mHAMYH2kdyJjZ0bH1PNtDSPBksGwsC1Wg6/6YvGv8Ws+JClyLgYppd/J6//vv31p58//PouxBRj4x9wNYdF9G/s14NkXOXj4KeVLEEalG3oRsc61hY32Mbzi0FykZJkHBzZO23jd+ZhWjuPf5R2ckFJK1rBNTL8g3zofjVIfhEE21CJxf6+6bKNKDoHP0TVPCScDOehNkzGHvOAGPp6vRCfVub3hbv1RC8f6lve06aViITS+3bThILQQF3zkNSe4X/NXeaRt5mq6xy+1cZYvPxt49oFux6b01j2kHS2EU7GgHmENBkjrfTbRrowpeRj2s4zHWwfjmxgQoHl2wUOL9uwiqnIzz8X83CNwJx5SPlxY2cbM3ykiJ4428bKCSWmmyf6KMEUFDlJ50guVQvSmVj42IY/Hxng6PSrqicMEgyY0cwipaIQVG1UNQ8pSYb/5oGSfIhP9F3bL3Ly6q+IWAruyBm6NlDnmNlHGUPGtp1+eg+yszpTWkkxpw/nAzCqAtgHMztcomxjPj7mnd1/VbV+4QZAp5/eQ10PdFrpHRAzt5cgbGOCD49YregcMGRUUn44lB4opTsKayQXCekM9en7sG3YnWwY48M2U3ReDOS8g8KIcIWaA7ba+M88WHNE5ZQEdWja29f85SyaRz04stiG75p6KBz8jb6VZv5Zf0VrS7XqZZpc7OKc9ck+6dZD0zzeI33NwexGOMrYxoB5EI71Zrap+MgHB+whNqYVkrGQeTCtkI8ScDChEA6aB+FY3jbw+RCSQTGt0DwqwlHbNpD5QIHD9QGu8AKJhoC3cIVqY9I87EjqhMPlJ9RZfBiqpwehaw5OUlhzkAzQyhQIDtakF3zgxAHUOZhQ6sNBM7BOLqYR7ofDcsJy0VRP2/hx/n0hgjv7Di6thCQUKETOvnxkzUGh8yEOg3L/i/948w/JwCnp6Bw0D104bGpS2oYtH/295uEce9yPZAAuEzCtMLmow9HpUbdjTtvo5aPbNoYqAToHBQwHbQM2uRzdO340gZb5o9AUnlSx+yKvPmLl4ZNnPhO3gbrSJ6ckSCsKNbndzaAIMsqmlbFY6PBx8afFhManhUXDKa1sfg/Z1HwSkkiUVcz3sVtO2bat+aeJ+AdeXY3XQVCQ9lQ7p6GmEOjOgTjGhxVVEX3vl1DmWufqHF///Pb/v984QR3W/Zd38xSku/F0axXJUDFFqUo9PQNmKsuTcGjS6BEpjz9tAwCOHlTJhy0ZSkYu64wDekYoHJ3Akg+TKOnVf9rOQT6qkLFxsw/lCwfNo4RtmDkH+chPBlBaIR+A0TCDox9k8jEeB5sVakvn4Jq6j8ziLFDXTfNAKDVwp7Ir84HWdns4WHxkKzV8nYN8JCTDMa2Qj2xk+NYcnLxki6Qgt2oF84CankTPVshHEjI2hRNvg0xqQhl/Suo3Uj6D5J6XW0zY+o9C7ekDEEpMzqVFVGwtLISqfFztlUBErI4rBtXyLXKIGfARYiS2R1jjZnmhcFy2XMS6z9RB8TjTHD35j4bD0kJu78suXAKesgKwLIQBhwsf8f2digwkOIxTTBohrSPPwvH47buNQtXnF89n3s6jCRThoPoVtHzeB3BdgrHvVLc0ESyGSIYNDC1ZNAsgkmdfS0sZ2aSIZNvu1BJHOREiOXfB5YTjWsRhKUm+M7JtBYRGSZXdsm2rpFhKyu2gbltJXesnEdJAOHb34gAu6x2taNua4iGaHeK9FYpwUISDIhwU4aAIB0U4KMJBEQ6KcFCEg6IIB0U4KAX9C2pef+UnN8OcAAAAAElFTkSuQmCC', 'base64'), '/icon-192.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAHIElEQVR42u2dPY5eNRSG7zimSU+TFpRuQBQ0bIOOhbAIFoEQCETDNiKkFFGUNlkBS4hmhiLJMAqZbz7b59/Pqymm+H6ujx+/59j3s+/F4ydPD4Rm1QgBAiAEQAiAEAAhBEAIgBAAIQBCCIAQACEAQgCEEAAhAEKR1AnBh6E0PpaurwlbhxXhz9mMqg40il+0AUwdaIAJgIJxc/qqapHU4QaStgeotcSXnRyjDjpgtCVArdYSaFqMOuiA0TYAtT1uvKTCqIMOGC1dJvTQ9roO1PixQHQratCDFZVzINDJY0Udem510R6d/+Kb6yu3+ERiqG9LzxAu57zdDqlIDPWt0FmE5vwPV4cpTDrrO9Cjys3pb9QlKYAV9cL02HPjQJI3Q70kPRHQ+eQlqWDkylCvRI84N29ePb/9/4vLb+Makh9DvQY9AS3H2pCcGGrQE6FCSjSTDeBAcu3Mi46WFZn7UE9KTwF0tDCyZahBT8GMZpjLGvTAUIYUJtGe2ujIpzOTXNa2G5qzursmtEN7IwG0bD9BopmPIf1E1qFn6LsU70jc83Wr36WcyNrm9Fy0R3f/Ln/5/fTrX7/8+//v2tmH4tZAen1zX98/SM9dhs75wPihiA3QAvh5e0IVo4Am1ALSo2c5J15zpv3cZ0IT32juFS0VQDHqHr1efJAhjQsImMhaNNilYjTUc0P248txtETWqtJz/oun6TnThHxbp81QrEol3YRlgiGpZhZNYbOAe4VVO3mFaqyGCdXZROw1KEdNKGw5HAAgJ/uZzgtS9jPNkPjuWHsTatmdY/rtLskrTvPjATQFdfbwLZqQZxCETChxDbQSdw37cWQovwOZ20+9Xyc6REPChNpusX7Yflr778/QhJKOCgmAbO1Hl560Y8PLhFpGC4msRRNKF9VlgGx/tpHCfpIlsrUebIkGyibbenKFaKNtPZbVz3oi22NbT57zeO1rZ8diyLIfrQmYG1irw7GlPMXGJ1b1Utg6PZc//+YzI3vxzIWhJACNh8YhHN5Jdp0hI+xmLzK6A63/fNPLfqQ4Dm5CxZ/+F4Ge1y+e5ZpwBAVoYiQF+dWmO0OmoTMCqCV4TlSI5JUwbqSwiHpvQqSw6CYc2H5WElnYLNZrDQcxenSjH+yZX+YOpJ/IHeeuqlsTVxKZRUzGe7ZQDRS5dq47q0//mDfkG/kqDpTEfuqZUKnzgVLQs1IMbXM+ENpGJQCKc9N01ITyZ7E211vRlI6e9Vl9kJl85RUdZBD/VqDBSe3nvQk5nZNHDRQ6paoyBEBUP8zCgtATe6P7DibEOhAM7QpQGfshhaF9TSgrQFXtJx1DDXoQKQwTAiDsJydDOBDaCaB9qp8sJhQOoBNPuaZ2PgyfOB4FoGgN3s2EtOM/DpDTjrg97cchkQ32L0U02qCI3rn6CV5NRwToo7RN7XzLUMCCkhSGwgO0Mm6wn5VEZuBYOBDFkD1A+jP5d0PHxX5urq/2Xbsa79m4DuSbvGJi9ObV802LaNaj7RmyiXlQB/rq1z9hpfQsrMoRf7VNyKBP7RzofEfFftYZMqsZwqUw6NkjhSFmZKsAjafMB30V+xFhaCZ/zRa1OBBKlcJODA7sR8SEjJfcLh4/ebpGoNFzC2UOVhq82rtH0H35zXcGGWEdBcv8lSmFyQwsm+UrP3q2mIVNh0aMIT2MhD7cOUSmANkuSYsFSBwjuQ+0hmDtspdroMPuAViSxZBEE5TGj7X9rDWhyyA83gE311dzKEy/8dwgPtgWTdPNRc+R9IFzKgw5JeWMhbMCQCMm9M9Pbz/8+/ZAovr8x8+Mh0qL3kgUO7ByAI3gDEP+9Ahlau6FoTgAYUKb2Y+zA8FQgTBKAzSINgw50CO6TtE2H0B4TzyAxgGHITt6pJdJdRyITT8xpdAvLfd4wn4KpjAS2R7JS9+BYKg6PUfAlWgYyhUcZYCmwIch4bBozmn0HYgZWbmZl3kKoxgqV/rErYFgKFcorACiGKpV+ng4EAyVo8c8hcFQLXo8aiAmZbUi3FK0cEMTCjvtijELg6ES9BwyW5vn6RXGV3G3obTk9xA61QauO1On9kSf0ythSdLae+pXWXpvbZZm6G4/hcJIcduy67wkwN54HYaCGJL6dnfvWW2MwxXUGPIiyeiYhABrImFO53gXi9bM+lUcJtOzNcIspwU73kXZik739xBSnkexRFqMjXc+kCFDgZjISc8R9IApk3SWTyHvAjXiBT3+DvT1H3/Rxen08ofvSzsQyiAAQktyvZk6yXx16FMVfz1rfEtilHDe0HPHugxGaaecvULcU2OUfLWi1xm+6TAqsdBVAqCP+iM4SbUWSPtRTzFJKrqw3o/CGnoGD9AAUAiYNruF148N9ck+nqCK272bAgQNcuJeGAIgBEAIgBAAIQRACIAQACEAQgiAEAAhAEIAhBAAIWn9C9MBrxKmJhT1AAAAAElFTkSuQmCC', 'base64'), '/icon-512.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAASAUlEQVR42u3dPY4c59UF4O6accLcCVMbzGjDgRNvQ5kX4kV4EYZgQ4YTb0MQwEAgmIor0BIENh0MLA9haH5qqrruved5oOzTJ/dUv+859/YMOedXr9+cAMizeAQACgAABQCAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAABQCAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAYJVbj4CJg80+k83l4tGiAGBivr/8f1dDoACgfdZv+Gq1AgoApsX96i9KJaAAYGbiP/er1gcoACS+Z6IPUAAIfY9LGaAAEPoeozJAASD3PVtNgAJA7nvamgAFgND3FigDFABy3/uiCVAAiP7st0kNoACQ+xYCDwMFgNzXBKAAEP2xb6saQAEg9y0EHgYKANFvIUABIPpRAygA5D6J50ETKABEPxYCFACiHzWAAkD0owZQAIh+1AAKANGPGkABIPpRA/R6Sz0C6Q/OmA0A1xKsAgoA0Q9qQAEg+kENzHz3PALpD06jDQCXDawCCgDRD2pg/NvlEUh/cFZtALhOYBWwASD9wem1AeDygFXABoD0B+fZBoCrAlYBGwDSH5xwBYC7Ac55Gz4CciXgoAPv4yAbANIfJx8bgDvAZs7Lzbb/wc+XT57qLuffHqAARD8VUn7d/5Zu2OAiqAEFIP2pkPWbvDatYBVQAEj/gYm/4vXrAx2gABxx0T859J/4pSmDRy6IGlAA0l/oKwOrAApA+gt9ZaADUADSX+4HPB9NoAMUgPQX+h5adhnoAAUg+uW+MshtAt8WVgDSX/Rz92Bza0AHKADpL/fVQOhCoAMUgPQX/eQuBDpAAUh/uU/uQqADFID0F/3kLgQ6QAFIf9FPbg3oAAUg/eX+Ch8/vHv03/nN2z/OeL8mN4EOUADSX/STuxDoAAUg/UU/uTWgAxSA9Bf95NaADnjJw/MIpL/0T6sBNxEbgDMn+q0C9gAFQHb6i341oAMUAHHpL/rVwKga0AHPfWAegfRHDbihNgBSzpboZ/IqYA9QANJf9JNbAzrgic/JI5D+MPCc+CzIBuAkiX5yVwF7gA1A+kt/ck+OPcAGEHt6RD9WAXuADcD4Bs4SCiBj/HdjcaLGrPL78RHQtBMj+tn1aHX9OMgHQTYA6Q+5Z8weoACkP+gAFMCc83FebqT/Hp7yC4RjO6DrkdMBCsA4hg5w9lAAvUcDNxAn0BKgAKQ/lgDnUAcogIDT4EN/HeBA6gAFYOACJxMFkDEIuGMrJtP7/zzr/8sSMPx8xi8B8QUg/YcG/R4fSnz88G6//7gOkADXl/1XQUh/EbPpy5jz29Vf/GQ6PYrgvyXCR0Air9+Mf+DL+OH9d/VfpBOLDWDO+B97l1p/4fdffOZm0GkPSF0CUjcA6T900n/79TfHLgE2g66nN/KbAZEFIP0L5/5L/iNXSP/VHbDtV6oDdMAm/D4AN8fXePDXPv4DombfE7YBGP8l43VG/g3/g1cb/1++BOz9KJxnS4ACkP51c3/GF7hhB5wCPhrSAQqA3PTfNd2uPP73fVDONqkF0KHY592QKwy2B6b/tktAwkLQ4yuKWQJiCkD6m2S7dcDUx6gDFACT0/+amTXpw5+cGvBZkAJQ5gPvQ+bfgrD3EjDy8Tb4QgKWgIACkP5zs6nO+H+1DphUAzpAAaRzkwekv5Nj91UACjzx9PubLw9ZAiY9/OpfwuglwAbg3LdMn5rj//U7YEYNmCEUgOp2Y3unvwyVJArAezb8uvrMp+ASMOCt8UGQAjCsif4J4/+BHdC6BgwWCmB+XbuceL9avuyJS4ANwPnu9LK7fPp/7BLgsPFEE38hjO/9Dr2Nvve77u3zy1i2zJZZvzpYVhptzGJjlwAHj7ACqDr+u4SB478OGPiCZ33AMKsApP9Gr9YINnIBbXcO5YwCwK1r/Ol/nSWg6SqAAjD+S//GdIAlQAEYqL1UvNeOpQKIKeQuZ7fyp8MzfvSz2hJwavUtgaKvc8QSYAMwDJqwQjvAu8+IAjD+D32R/uSXM2AJUAAulfS3BDiulhUFMLGEXaccOmBcgvbOH+mZeJfqv0If/jgVWkoB9Ktft4imS4DTG7gE2ABMecZ/HWA+sAEY/6dfHumPY2wJsAG41VgCnBYUQMad6XKfjf/OjH5SAP12LrdF+g9bApzq1olkA8CsdO9y/vzPs/59HeD8jHbb9T67JLNu75bjvz8buPUpqvlbhcu9sIa/MdhVgSPVXwKYvBsb/43/o8Z/HeCQSycbgLVd+pN5olAA0bfCXbUEOO1MLIBKG5b7YPzXAV5V5YyyAQAwoACM/8Z/S4AzZgmwASD9dYCThgJwAdxJnDdXYHYB+OOdgxj/uy8BzMgrqWr2QQe4CDYAFJLxH4GrAOxTbqD0twTogPGpJVgdd3SAG2oDUKTO+s7vo/HfObQEKAAH3U3AEuCeKgASTvmynE6nt3/7h3fNaUQBtJwcSx3xNvftv79YUfqPXwJckI67rw2A0KOvA8AVtW7vnv7G/5A29UGQApC5mP13WAK+/9ZTdWfDCsCJ73isv3zXjP9RHSB2e+WYhO10pqU/OkAbKQBkU+oS4DkTUQBOea9x5v/eL+N/bAcYvbukmZB1lKW/THF/bQA4x5Ko0RJQ+8lLXgXQPlMc4nXvlPFfB6iiFnOS0+MEm/0HdrBziwLggNwx/l97CdDEKICp80uvMUr6H9YBLpFdZEgBGGfajv94R2j0Hjk0bHaOjf8HLwE6AAUwScXVVcqYMbufYRSAU7st43+JJQA3uncBGDAbjv/Sv1AHWAKsaDYAdLN3ChSAgWVfxv9ySwDutQJwWA2VuR1Q7P0SvgqAvsdkMf5PetegZAE4sq3GJelfeglwqhWzDcAx1cpRb64/GuZ2P92tR8Dg8X/dhRcTpEx3HoEhZd74f15u7v7JPEJllwDNqgBodDpafu9Xypx8EES/AihwTGXHU/jeLzbsGYu10cDprH5GmbQEmLFsABj/uXoHgAJA+gMKwHL6wLlwMMYtAd5TN10BOJfG/9wOcM4pWgDGE+M/3lnvhQ0A4z+zlwBsALQZTKS/wRMFMNnhn0v6YJScJcB1UwD0YPzXASgAfD6AdxkFgPEfSwAKwEiyiZqfSEp/HZB25tNyzwaAGvZeYwMA478lAAWQxjZKXAe8/86tdwwUAMZ/UABEH4RF+lsCUABYRdEBTr4CII/xHxQAYAlAAWD8RwegABh6ChbpDwrgsPQBLAGZs5cN4Eh+FMH4T2YHuPsKAOkPCgAzCJYA518BEDT+f/2NhwAKALAE+G6wAsD4jw5AASD9AQUAWAJQABj/0QEoAAAUAMZ/LAEoAKQ/OgAFAIACwPiPJQAFAOgAFADGf0ABIP2xBKAAAB2AAsD4DygAwBKAAsD4DygApD+WABQAoANQAMZ/4z+gAKQ/WAJQALV8vnzyEIjtAOdfAWD8BxSAGRzClgB3P7sALhcXyfiPDkh0dPrZAKQ/YAMAsAQoAIz/oAMUAAAKgH1s9aMIxn96LQF+CEcBsA3pT8cOQAEAoAAO0n0VNf5jCUi79QoA0AEogGDGf6BzAcT/bRCrt1HpT9MlwCcwFXLPBgBgA6Ab4z+tlwAUAKADUACHOvwTyee+AOM/rlvfF6AAWE/6YwlAAQA6gO4F4PeCGf8hR43EswEU4nNJEpYA59wGIH+N/+R2gJuuAJD+gAIALAEogHAPLKfGfwZ0gI9fFMAvKPBt8bKnU/rDnDte5ocebQC44VzPxw/vPAQbAM/IL+P/imd4949HoQN4wK1HQE6bnpcbOwTYANpcfuP/4DfXEuAAKIB7/IUQXx5T6Q/TVEo5GwAQtASgAHosAcZ/dAAK4IDw9RDAvVYAHON3f/+Xh4AlgLAC8H1g6Y8OmKpYvtkAbIvgRtsAMP6DJUABAOgABXCE4G8DGP9hrHrJZgP4Rdf/0FD6YwmYcZdtAABVOgAFUJrxH1AAp9OpyodlNkfovgRUucUlv7VpAzD+w/AOQAHUHR+kP1jiFUCDjQmwBIxJMxvAwYz/ENEBCsAWKf1hwM1VANF7E2AJGJBjNoDDRgnjPxj/FQDA6CVAAWD8Bx2gAJ6jzMdnG26U0h+63NYxCWYDACwBKIDjxgrjP+zaAb79O6sA/DAo0FH57LIBXHUJMP7DrkuA8f9Zzq9ev2myq1TpqvNyU+stLPZ6ir+hP3z/7aP/zm//8CfT4nVGosmvp8MbagNIX0pcD08j7uyhACYd+sYdoAbaPgQXQQEYkVADvnC65pUNwOzjwvh6XQEbAGrJROzLFLUKwNDU9A5MuJl3+TivCaZ8XU7+pPXuVgdSuu+XZcgXAjYAS4AlYM3g7MU7XcZ/BeDkJXbAqdvnJ0M/xXLa5+nzJ4H/11m1SqvsH8Tt+ieEex6DdqPfmJwt98JaHYOG3wO4XEpd/s+XTzWjtuwL2/6aHXgeMj7fl/5Tz4NvAjOrDPbuA9/RZZDbrhfeEmAJeHpGrz4t4t74P/q02ADm397EDpDj09OfTSyu9Ph74g7jVBsyZhWAE6kDcJ5RALgzOC2EFUC9nav4tXGrcYxDssgGgA7ACeEhzX8K6IifB/3xrz89+H//yamCQ/z6L78y/tsAJh4ywMVUABXq11ED6d99/LcB6ABwGW0AlgCAsOSxAZg7wDW0Aahihw+kf8z4bwPQAeDq2QAsAQ4iSP+k8d8GoAPAdbMBWAIAwnJm8d6YSsD4nzll+ghIB4ArFmpiARxa0Q4ojL1c4z5ktgHoAHCtbACWAIcVpH/M+G8DALABWAIsAWD8Txr/p28AOgCkv/QPLQDHF1wfcgugQHU7xND44oz++wVsADoAXBkbgCUAICk9Fu+iiQaM/5mzo4+AdAC4JqFiCqBGmTvc0OOCZHx0nLQB6ACQ/tI/tAAcdHApyC0APxEESIncDcAHQWD8l/6hBeDQg4tAbgGUKXlHH+kvGRSADgDpLxMUgA4A6S/9FQAACsASAMZ/478C0AEg/aW/AtABIP2lvwJwPcDxRgE0HwRcEqS/8V8BOA2A+64Aws6EJQDjv/RXAC4MOMwogLzRwLVB+hv/FYAOAOkv/RWADgDpL/0VgLMCuNEKYPiJsQRg/Jf+CsB1AscVBZA3OLhUSH/jvwLQASD9pb8C0AHgcEp/BeAkAe6sAhh+niwBGP+lvwLQAeBASn8FoAPAUZT+CkAHgPRHAegAkP4oAKcN3EcUwLAzZwkg/eBJfwWgA0D6owB0AEh/Hnd+9fqNp7BFk06u0vNy4x3u6PPlk9mLB9x6BJudxbkd8HOOaAK5L/0VAHEdcD9Z1IDol/4KgMQOUAOiX/orAKI74ORzIbkv/RUAyR1gIRD90l8BkN4BFgK5L/0VANEdYCEQ/dJfAfDlqQ2uAU0g90W/ArAK5P6J6/v5pQyEvvRXADogPdc0gdyX/gpAB0i69DIQ+tJfAegACRhUBkJf+iuA4JOtBvLKQOiLfgWAVWBlYrbrA4kv/RUAOmDHPC3SCrJe+isAVp14NbBP8m7eDVJe9CsArALtuwHpzx3R4w6Ak28D4PCbYBVA9GMDcCvAOUcBuBvghLMLHwFVvSE+DkL0YwNwW8B5xgZgFQDRjw3A/QGnl8wN4Pf//Lc3Dyji/Z+/sgEAoAAAUAAAKAAAFAAACgAABQCAAgBAAQCwufOr1288hbn9ruDZgr/RYSh/GVzAvVUDiH4UgBoA0Y8CUAMg+hUAagBEvwIg7p5rAuS+AsBCgOhHAaAGEP0oADITQRPIfRQAFgJEPwoACwFyHwWAJkDuowBIzBQ1IPpRAFgIPAy5jwIgPnGUgdBHAWAt8DDkPgoATYDcRwEQnlbKQOijAJBiykDoowCQbvpA4qMAkH1pfSDxUQDweDIOqARxjwKAzdKzbCvIehQAHJyzOzWEfEcBQPuGAE4nP4MBoAAAUAAAKAAAFAAACgAABQCAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAUAAAKAAAFAAACgAABQCAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAALzYfwAGQwh6/XGzZAAAAABJRU5ErkJggg==', 'base64') };
const BUILD = '01/08c — maille vent adaptative';
const LEAFLET_JS = `/* @preserve
 * Leaflet 1.9.4, a JS library for interactive maps. https://leafletjs.com
 * (c) 2010-2023 Vladimir Agafonkin, (c) 2010-2011 CloudMade
 */
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t="undefined"!=typeof globalThis?globalThis:t||self).leaflet={})}(this,function(t){"use strict";function l(t){for(var e,i,n=1,o=arguments.length;n<o;n++)for(e in i=arguments[n])t[e]=i[e];return t}var R=Object.create||function(t){return N.prototype=t,new N};function N(){}function a(t,e){var i,n=Array.prototype.slice;return t.bind?t.bind.apply(t,n.call(arguments,1)):(i=n.call(arguments,2),function(){return t.apply(e,i.length?i.concat(n.call(arguments)):arguments)})}var D=0;function h(t){return"_leaflet_id"in t||(t._leaflet_id=++D),t._leaflet_id}function j(t,e,i){var n,o,s=function(){n=!1,o&&(r.apply(i,o),o=!1)},r=function(){n?o=arguments:(t.apply(i,arguments),setTimeout(s,e),n=!0)};return r}function H(t,e,i){var n=e[1],e=e[0],o=n-e;return t===n&&i?t:((t-e)%o+o)%o+e}function u(){return!1}function i(t,e){return!1===e?t:(e=Math.pow(10,void 0===e?6:e),Math.round(t*e)/e)}function W(t){return t.trim?t.trim():t.replace(/^\\s+|\\s+$/g,"")}function F(t){return W(t).split(/\\s+/)}function c(t,e){for(var i in Object.prototype.hasOwnProperty.call(t,"options")||(t.options=t.options?R(t.options):{}),e)t.options[i]=e[i];return t.options}function U(t,e,i){var n,o=[];for(n in t)o.push(encodeURIComponent(i?n.toUpperCase():n)+"="+encodeURIComponent(t[n]));return(e&&-1!==e.indexOf("?")?"&":"?")+o.join("&")}var V=/\\{ *([\\w_ -]+) *\\}/g;function q(t,i){return t.replace(V,function(t,e){e=i[e];if(void 0===e)throw new Error("No value provided for variable "+t);return e="function"==typeof e?e(i):e})}var d=Array.isArray||function(t){return"[object Array]"===Object.prototype.toString.call(t)};function G(t,e){for(var i=0;i<t.length;i++)if(t[i]===e)return i;return-1}var K="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";function Y(t){return window["webkit"+t]||window["moz"+t]||window["ms"+t]}var X=0;function J(t){var e=+new Date,i=Math.max(0,16-(e-X));return X=e+i,window.setTimeout(t,i)}var $=window.requestAnimationFrame||Y("RequestAnimationFrame")||J,Q=window.cancelAnimationFrame||Y("CancelAnimationFrame")||Y("CancelRequestAnimationFrame")||function(t){window.clearTimeout(t)};function x(t,e,i){if(!i||$!==J)return $.call(window,a(t,e));t.call(e)}function r(t){t&&Q.call(window,t)}var tt={__proto__:null,extend:l,create:R,bind:a,get lastId(){return D},stamp:h,throttle:j,wrapNum:H,falseFn:u,formatNum:i,trim:W,splitWords:F,setOptions:c,getParamString:U,template:q,isArray:d,indexOf:G,emptyImageUrl:K,requestFn:$,cancelFn:Q,requestAnimFrame:x,cancelAnimFrame:r};function et(){}et.extend=function(t){function e(){c(this),this.initialize&&this.initialize.apply(this,arguments),this.callInitHooks()}var i,n=e.__super__=this.prototype,o=R(n);for(i in(o.constructor=e).prototype=o,this)Object.prototype.hasOwnProperty.call(this,i)&&"prototype"!==i&&"__super__"!==i&&(e[i]=this[i]);if(t.statics&&l(e,t.statics),t.includes){var s=t.includes;if("undefined"!=typeof L&&L&&L.Mixin){s=d(s)?s:[s];for(var r=0;r<s.length;r++)s[r]===L.Mixin.Events&&console.warn("Deprecated include of L.Mixin.Events: this property will be removed in future releases, please inherit from L.Evented instead.",(new Error).stack)}l.apply(null,[o].concat(t.includes))}return l(o,t),delete o.statics,delete o.includes,o.options&&(o.options=n.options?R(n.options):{},l(o.options,t.options)),o._initHooks=[],o.callInitHooks=function(){if(!this._initHooksCalled){n.callInitHooks&&n.callInitHooks.call(this),this._initHooksCalled=!0;for(var t=0,e=o._initHooks.length;t<e;t++)o._initHooks[t].call(this)}},e},et.include=function(t){var e=this.prototype.options;return l(this.prototype,t),t.options&&(this.prototype.options=e,this.mergeOptions(t.options)),this},et.mergeOptions=function(t){return l(this.prototype.options,t),this},et.addInitHook=function(t){var e=Array.prototype.slice.call(arguments,1),i="function"==typeof t?t:function(){this[t].apply(this,e)};return this.prototype._initHooks=this.prototype._initHooks||[],this.prototype._initHooks.push(i),this};var e={on:function(t,e,i){if("object"==typeof t)for(var n in t)this._on(n,t[n],e);else for(var o=0,s=(t=F(t)).length;o<s;o++)this._on(t[o],e,i);return this},off:function(t,e,i){if(arguments.length)if("object"==typeof t)for(var n in t)this._off(n,t[n],e);else{t=F(t);for(var o=1===arguments.length,s=0,r=t.length;s<r;s++)o?this._off(t[s]):this._off(t[s],e,i)}else delete this._events;return this},_on:function(t,e,i,n){"function"!=typeof e?console.warn("wrong listener type: "+typeof e):!1===this._listens(t,e,i)&&(e={fn:e,ctx:i=i===this?void 0:i},n&&(e.once=!0),this._events=this._events||{},this._events[t]=this._events[t]||[],this._events[t].push(e))},_off:function(t,e,i){var n,o,s;if(this._events&&(n=this._events[t]))if(1===arguments.length){if(this._firingCount)for(o=0,s=n.length;o<s;o++)n[o].fn=u;delete this._events[t]}else"function"!=typeof e?console.warn("wrong listener type: "+typeof e):!1!==(e=this._listens(t,e,i))&&(i=n[e],this._firingCount&&(i.fn=u,this._events[t]=n=n.slice()),n.splice(e,1))},fire:function(t,e,i){if(this.listens(t,i)){var n=l({},e,{type:t,target:this,sourceTarget:e&&e.sourceTarget||this});if(this._events){var o=this._events[t];if(o){this._firingCount=this._firingCount+1||1;for(var s=0,r=o.length;s<r;s++){var a=o[s],h=a.fn;a.once&&this.off(t,h,a.ctx),h.call(a.ctx||this,n)}this._firingCount--}}i&&this._propagateEvent(n)}return this},listens:function(t,e,i,n){"string"!=typeof t&&console.warn('"string" type argument expected');var o=e,s=("function"!=typeof e&&(n=!!e,i=o=void 0),this._events&&this._events[t]);if(s&&s.length&&!1!==this._listens(t,o,i))return!0;if(n)for(var r in this._eventParents)if(this._eventParents[r].listens(t,e,i,n))return!0;return!1},_listens:function(t,e,i){if(this._events){var n=this._events[t]||[];if(!e)return!!n.length;i===this&&(i=void 0);for(var o=0,s=n.length;o<s;o++)if(n[o].fn===e&&n[o].ctx===i)return o}return!1},once:function(t,e,i){if("object"==typeof t)for(var n in t)this._on(n,t[n],e,!0);else for(var o=0,s=(t=F(t)).length;o<s;o++)this._on(t[o],e,i,!0);return this},addEventParent:function(t){return this._eventParents=this._eventParents||{},this._eventParents[h(t)]=t,this},removeEventParent:function(t){return this._eventParents&&delete this._eventParents[h(t)],this},_propagateEvent:function(t){for(var e in this._eventParents)this._eventParents[e].fire(t.type,l({layer:t.target,propagatedFrom:t.target},t),!0)}},it=(e.addEventListener=e.on,e.removeEventListener=e.clearAllEventListeners=e.off,e.addOneTimeEventListener=e.once,e.fireEvent=e.fire,e.hasEventListeners=e.listens,et.extend(e));function p(t,e,i){this.x=i?Math.round(t):t,this.y=i?Math.round(e):e}var nt=Math.trunc||function(t){return 0<t?Math.floor(t):Math.ceil(t)};function m(t,e,i){return t instanceof p?t:d(t)?new p(t[0],t[1]):null==t?t:"object"==typeof t&&"x"in t&&"y"in t?new p(t.x,t.y):new p(t,e,i)}function f(t,e){if(t)for(var i=e?[t,e]:t,n=0,o=i.length;n<o;n++)this.extend(i[n])}function _(t,e){return!t||t instanceof f?t:new f(t,e)}function s(t,e){if(t)for(var i=e?[t,e]:t,n=0,o=i.length;n<o;n++)this.extend(i[n])}function g(t,e){return t instanceof s?t:new s(t,e)}function v(t,e,i){if(isNaN(t)||isNaN(e))throw new Error("Invalid LatLng object: ("+t+", "+e+")");this.lat=+t,this.lng=+e,void 0!==i&&(this.alt=+i)}function w(t,e,i){return t instanceof v?t:d(t)&&"object"!=typeof t[0]?3===t.length?new v(t[0],t[1],t[2]):2===t.length?new v(t[0],t[1]):null:null==t?t:"object"==typeof t&&"lat"in t?new v(t.lat,"lng"in t?t.lng:t.lon,t.alt):void 0===e?null:new v(t,e,i)}p.prototype={clone:function(){return new p(this.x,this.y)},add:function(t){return this.clone()._add(m(t))},_add:function(t){return this.x+=t.x,this.y+=t.y,this},subtract:function(t){return this.clone()._subtract(m(t))},_subtract:function(t){return this.x-=t.x,this.y-=t.y,this},divideBy:function(t){return this.clone()._divideBy(t)},_divideBy:function(t){return this.x/=t,this.y/=t,this},multiplyBy:function(t){return this.clone()._multiplyBy(t)},_multiplyBy:function(t){return this.x*=t,this.y*=t,this},scaleBy:function(t){return new p(this.x*t.x,this.y*t.y)},unscaleBy:function(t){return new p(this.x/t.x,this.y/t.y)},round:function(){return this.clone()._round()},_round:function(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this},floor:function(){return this.clone()._floor()},_floor:function(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this},ceil:function(){return this.clone()._ceil()},_ceil:function(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this},trunc:function(){return this.clone()._trunc()},_trunc:function(){return this.x=nt(this.x),this.y=nt(this.y),this},distanceTo:function(t){var e=(t=m(t)).x-this.x,t=t.y-this.y;return Math.sqrt(e*e+t*t)},equals:function(t){return(t=m(t)).x===this.x&&t.y===this.y},contains:function(t){return t=m(t),Math.abs(t.x)<=Math.abs(this.x)&&Math.abs(t.y)<=Math.abs(this.y)},toString:function(){return"Point("+i(this.x)+", "+i(this.y)+")"}},f.prototype={extend:function(t){var e,i;if(t){if(t instanceof p||"number"==typeof t[0]||"x"in t)e=i=m(t);else if(e=(t=_(t)).min,i=t.max,!e||!i)return this;this.min||this.max?(this.min.x=Math.min(e.x,this.min.x),this.max.x=Math.max(i.x,this.max.x),this.min.y=Math.min(e.y,this.min.y),this.max.y=Math.max(i.y,this.max.y)):(this.min=e.clone(),this.max=i.clone())}return this},getCenter:function(t){return m((this.min.x+this.max.x)/2,(this.min.y+this.max.y)/2,t)},getBottomLeft:function(){return m(this.min.x,this.max.y)},getTopRight:function(){return m(this.max.x,this.min.y)},getTopLeft:function(){return this.min},getBottomRight:function(){return this.max},getSize:function(){return this.max.subtract(this.min)},contains:function(t){var e,i;return(t=("number"==typeof t[0]||t instanceof p?m:_)(t))instanceof f?(e=t.min,i=t.max):e=i=t,e.x>=this.min.x&&i.x<=this.max.x&&e.y>=this.min.y&&i.y<=this.max.y},intersects:function(t){t=_(t);var e=this.min,i=this.max,n=t.min,t=t.max,o=t.x>=e.x&&n.x<=i.x,t=t.y>=e.y&&n.y<=i.y;return o&&t},overlaps:function(t){t=_(t);var e=this.min,i=this.max,n=t.min,t=t.max,o=t.x>e.x&&n.x<i.x,t=t.y>e.y&&n.y<i.y;return o&&t},isValid:function(){return!(!this.min||!this.max)},pad:function(t){var e=this.min,i=this.max,n=Math.abs(e.x-i.x)*t,t=Math.abs(e.y-i.y)*t;return _(m(e.x-n,e.y-t),m(i.x+n,i.y+t))},equals:function(t){return!!t&&(t=_(t),this.min.equals(t.getTopLeft())&&this.max.equals(t.getBottomRight()))}},s.prototype={extend:function(t){var e,i,n=this._southWest,o=this._northEast;if(t instanceof v)i=e=t;else{if(!(t instanceof s))return t?this.extend(w(t)||g(t)):this;if(e=t._southWest,i=t._northEast,!e||!i)return this}return n||o?(n.lat=Math.min(e.lat,n.lat),n.lng=Math.min(e.lng,n.lng),o.lat=Math.max(i.lat,o.lat),o.lng=Math.max(i.lng,o.lng)):(this._southWest=new v(e.lat,e.lng),this._northEast=new v(i.lat,i.lng)),this},pad:function(t){var e=this._southWest,i=this._northEast,n=Math.abs(e.lat-i.lat)*t,t=Math.abs(e.lng-i.lng)*t;return new s(new v(e.lat-n,e.lng-t),new v(i.lat+n,i.lng+t))},getCenter:function(){return new v((this._southWest.lat+this._northEast.lat)/2,(this._southWest.lng+this._northEast.lng)/2)},getSouthWest:function(){return this._southWest},getNorthEast:function(){return this._northEast},getNorthWest:function(){return new v(this.getNorth(),this.getWest())},getSouthEast:function(){return new v(this.getSouth(),this.getEast())},getWest:function(){return this._southWest.lng},getSouth:function(){return this._southWest.lat},getEast:function(){return this._northEast.lng},getNorth:function(){return this._northEast.lat},contains:function(t){t=("number"==typeof t[0]||t instanceof v||"lat"in t?w:g)(t);var e,i,n=this._southWest,o=this._northEast;return t instanceof s?(e=t.getSouthWest(),i=t.getNorthEast()):e=i=t,e.lat>=n.lat&&i.lat<=o.lat&&e.lng>=n.lng&&i.lng<=o.lng},intersects:function(t){t=g(t);var e=this._southWest,i=this._northEast,n=t.getSouthWest(),t=t.getNorthEast(),o=t.lat>=e.lat&&n.lat<=i.lat,t=t.lng>=e.lng&&n.lng<=i.lng;return o&&t},overlaps:function(t){t=g(t);var e=this._southWest,i=this._northEast,n=t.getSouthWest(),t=t.getNorthEast(),o=t.lat>e.lat&&n.lat<i.lat,t=t.lng>e.lng&&n.lng<i.lng;return o&&t},toBBoxString:function(){return[this.getWest(),this.getSouth(),this.getEast(),this.getNorth()].join(",")},equals:function(t,e){return!!t&&(t=g(t),this._southWest.equals(t.getSouthWest(),e)&&this._northEast.equals(t.getNorthEast(),e))},isValid:function(){return!(!this._southWest||!this._northEast)}};var ot={latLngToPoint:function(t,e){t=this.projection.project(t),e=this.scale(e);return this.transformation._transform(t,e)},pointToLatLng:function(t,e){e=this.scale(e),t=this.transformation.untransform(t,e);return this.projection.unproject(t)},project:function(t){return this.projection.project(t)},unproject:function(t){return this.projection.unproject(t)},scale:function(t){return 256*Math.pow(2,t)},zoom:function(t){return Math.log(t/256)/Math.LN2},getProjectedBounds:function(t){var e;return this.infinite?null:(e=this.projection.bounds,t=this.scale(t),new f(this.transformation.transform(e.min,t),this.transformation.transform(e.max,t)))},infinite:!(v.prototype={equals:function(t,e){return!!t&&(t=w(t),Math.max(Math.abs(this.lat-t.lat),Math.abs(this.lng-t.lng))<=(void 0===e?1e-9:e))},toString:function(t){return"LatLng("+i(this.lat,t)+", "+i(this.lng,t)+")"},distanceTo:function(t){return st.distance(this,w(t))},wrap:function(){return st.wrapLatLng(this)},toBounds:function(t){var t=180*t/40075017,e=t/Math.cos(Math.PI/180*this.lat);return g([this.lat-t,this.lng-e],[this.lat+t,this.lng+e])},clone:function(){return new v(this.lat,this.lng,this.alt)}}),wrapLatLng:function(t){var e=this.wrapLng?H(t.lng,this.wrapLng,!0):t.lng;return new v(this.wrapLat?H(t.lat,this.wrapLat,!0):t.lat,e,t.alt)},wrapLatLngBounds:function(t){var e=t.getCenter(),i=this.wrapLatLng(e),n=e.lat-i.lat,e=e.lng-i.lng;return 0==n&&0==e?t:(i=t.getSouthWest(),t=t.getNorthEast(),new s(new v(i.lat-n,i.lng-e),new v(t.lat-n,t.lng-e)))}},st=l({},ot,{wrapLng:[-180,180],R:6371e3,distance:function(t,e){var i=Math.PI/180,n=t.lat*i,o=e.lat*i,s=Math.sin((e.lat-t.lat)*i/2),e=Math.sin((e.lng-t.lng)*i/2),t=s*s+Math.cos(n)*Math.cos(o)*e*e,i=2*Math.atan2(Math.sqrt(t),Math.sqrt(1-t));return this.R*i}}),rt=6378137,rt={R:rt,MAX_LATITUDE:85.0511287798,project:function(t){var e=Math.PI/180,i=this.MAX_LATITUDE,i=Math.max(Math.min(i,t.lat),-i),i=Math.sin(i*e);return new p(this.R*t.lng*e,this.R*Math.log((1+i)/(1-i))/2)},unproject:function(t){var e=180/Math.PI;return new v((2*Math.atan(Math.exp(t.y/this.R))-Math.PI/2)*e,t.x*e/this.R)},bounds:new f([-(rt=rt*Math.PI),-rt],[rt,rt])};function at(t,e,i,n){d(t)?(this._a=t[0],this._b=t[1],this._c=t[2],this._d=t[3]):(this._a=t,this._b=e,this._c=i,this._d=n)}function ht(t,e,i,n){return new at(t,e,i,n)}at.prototype={transform:function(t,e){return this._transform(t.clone(),e)},_transform:function(t,e){return t.x=(e=e||1)*(this._a*t.x+this._b),t.y=e*(this._c*t.y+this._d),t},untransform:function(t,e){return new p((t.x/(e=e||1)-this._b)/this._a,(t.y/e-this._d)/this._c)}};var lt=l({},st,{code:"EPSG:3857",projection:rt,transformation:ht(lt=.5/(Math.PI*rt.R),.5,-lt,.5)}),ut=l({},lt,{code:"EPSG:900913"});function ct(t){return document.createElementNS("http://www.w3.org/2000/svg",t)}function dt(t,e){for(var i,n,o,s,r="",a=0,h=t.length;a<h;a++){for(i=0,n=(o=t[a]).length;i<n;i++)r+=(i?"L":"M")+(s=o[i]).x+" "+s.y;r+=e?b.svg?"z":"x":""}return r||"M0 0"}var _t=document.documentElement.style,pt="ActiveXObject"in window,mt=pt&&!document.addEventListener,n="msLaunchUri"in navigator&&!("documentMode"in document),ft=y("webkit"),gt=y("android"),vt=y("android 2")||y("android 3"),yt=parseInt(/WebKit\\/([0-9]+)|$/.exec(navigator.userAgent)[1],10),yt=gt&&y("Google")&&yt<537&&!("AudioNode"in window),xt=!!window.opera,wt=!n&&y("chrome"),bt=y("gecko")&&!ft&&!xt&&!pt,Pt=!wt&&y("safari"),Lt=y("phantom"),o="OTransition"in _t,Tt=0===navigator.platform.indexOf("Win"),Mt=pt&&"transition"in _t,zt="WebKitCSSMatrix"in window&&"m11"in new window.WebKitCSSMatrix&&!vt,_t="MozPerspective"in _t,Ct=!window.L_DISABLE_3D&&(Mt||zt||_t)&&!o&&!Lt,Zt="undefined"!=typeof orientation||y("mobile"),St=Zt&&ft,Et=Zt&&zt,kt=!window.PointerEvent&&window.MSPointerEvent,Ot=!(!window.PointerEvent&&!kt),At="ontouchstart"in window||!!window.TouchEvent,Bt=!window.L_NO_TOUCH&&(At||Ot),It=Zt&&xt,Rt=Zt&&bt,Nt=1<(window.devicePixelRatio||window.screen.deviceXDPI/window.screen.logicalXDPI),Dt=function(){var t=!1;try{var e=Object.defineProperty({},"passive",{get:function(){t=!0}});window.addEventListener("testPassiveEventSupport",u,e),window.removeEventListener("testPassiveEventSupport",u,e)}catch(t){}return t}(),jt=!!document.createElement("canvas").getContext,Ht=!(!document.createElementNS||!ct("svg").createSVGRect),Wt=!!Ht&&((Wt=document.createElement("div")).innerHTML="<svg/>","http://www.w3.org/2000/svg"===(Wt.firstChild&&Wt.firstChild.namespaceURI));function y(t){return 0<=navigator.userAgent.toLowerCase().indexOf(t)}var b={ie:pt,ielt9:mt,edge:n,webkit:ft,android:gt,android23:vt,androidStock:yt,opera:xt,chrome:wt,gecko:bt,safari:Pt,phantom:Lt,opera12:o,win:Tt,ie3d:Mt,webkit3d:zt,gecko3d:_t,any3d:Ct,mobile:Zt,mobileWebkit:St,mobileWebkit3d:Et,msPointer:kt,pointer:Ot,touch:Bt,touchNative:At,mobileOpera:It,mobileGecko:Rt,retina:Nt,passiveEvents:Dt,canvas:jt,svg:Ht,vml:!Ht&&function(){try{var t=document.createElement("div"),e=(t.innerHTML='<v:shape adj="1"/>',t.firstChild);return e.style.behavior="url(#default#VML)",e&&"object"==typeof e.adj}catch(t){return!1}}(),inlineSvg:Wt,mac:0===navigator.platform.indexOf("Mac"),linux:0===navigator.platform.indexOf("Linux")},Ft=b.msPointer?"MSPointerDown":"pointerdown",Ut=b.msPointer?"MSPointerMove":"pointermove",Vt=b.msPointer?"MSPointerUp":"pointerup",qt=b.msPointer?"MSPointerCancel":"pointercancel",Gt={touchstart:Ft,touchmove:Ut,touchend:Vt,touchcancel:qt},Kt={touchstart:function(t,e){e.MSPOINTER_TYPE_TOUCH&&e.pointerType===e.MSPOINTER_TYPE_TOUCH&&O(e);ee(t,e)},touchmove:ee,touchend:ee,touchcancel:ee},Yt={},Xt=!1;function Jt(t,e,i){return"touchstart"!==e||Xt||(document.addEventListener(Ft,$t,!0),document.addEventListener(Ut,Qt,!0),document.addEventListener(Vt,te,!0),document.addEventListener(qt,te,!0),Xt=!0),Kt[e]?(i=Kt[e].bind(this,i),t.addEventListener(Gt[e],i,!1),i):(console.warn("wrong event specified:",e),u)}function $t(t){Yt[t.pointerId]=t}function Qt(t){Yt[t.pointerId]&&(Yt[t.pointerId]=t)}function te(t){delete Yt[t.pointerId]}function ee(t,e){if(e.pointerType!==(e.MSPOINTER_TYPE_MOUSE||"mouse")){for(var i in e.touches=[],Yt)e.touches.push(Yt[i]);e.changedTouches=[e],t(e)}}var ie=200;function ne(t,i){t.addEventListener("dblclick",i);var n,o=0;function e(t){var e;1!==t.detail?n=t.detail:"mouse"===t.pointerType||t.sourceCapabilities&&!t.sourceCapabilities.firesTouchEvents||((e=Ne(t)).some(function(t){return t instanceof HTMLLabelElement&&t.attributes.for})&&!e.some(function(t){return t instanceof HTMLInputElement||t instanceof HTMLSelectElement})||((e=Date.now())-o<=ie?2===++n&&i(function(t){var e,i,n={};for(i in t)e=t[i],n[i]=e&&e.bind?e.bind(t):e;return(t=n).type="dblclick",n.detail=2,n.isTrusted=!1,n._simulated=!0,n}(t)):n=1,o=e))}return t.addEventListener("click",e),{dblclick:i,simDblclick:e}}var oe,se,re,ae,he,le,ue=we(["transform","webkitTransform","OTransform","MozTransform","msTransform"]),ce=we(["webkitTransition","transition","OTransition","MozTransition","msTransition"]),de="webkitTransition"===ce||"OTransition"===ce?ce+"End":"transitionend";function _e(t){return"string"==typeof t?document.getElementById(t):t}function pe(t,e){var i=t.style[e]||t.currentStyle&&t.currentStyle[e];return"auto"===(i=i&&"auto"!==i||!document.defaultView?i:(t=document.defaultView.getComputedStyle(t,null))?t[e]:null)?null:i}function P(t,e,i){t=document.createElement(t);return t.className=e||"",i&&i.appendChild(t),t}function T(t){var e=t.parentNode;e&&e.removeChild(t)}function me(t){for(;t.firstChild;)t.removeChild(t.firstChild)}function fe(t){var e=t.parentNode;e&&e.lastChild!==t&&e.appendChild(t)}function ge(t){var e=t.parentNode;e&&e.firstChild!==t&&e.insertBefore(t,e.firstChild)}function ve(t,e){return void 0!==t.classList?t.classList.contains(e):0<(t=xe(t)).length&&new RegExp("(^|\\\\s)"+e+"(\\\\s|$)").test(t)}function M(t,e){var i;if(void 0!==t.classList)for(var n=F(e),o=0,s=n.length;o<s;o++)t.classList.add(n[o]);else ve(t,e)||ye(t,((i=xe(t))?i+" ":"")+e)}function z(t,e){void 0!==t.classList?t.classList.remove(e):ye(t,W((" "+xe(t)+" ").replace(" "+e+" "," ")))}function ye(t,e){void 0===t.className.baseVal?t.className=e:t.className.baseVal=e}function xe(t){return void 0===(t=t.correspondingElement?t.correspondingElement:t).className.baseVal?t.className:t.className.baseVal}function C(t,e){if("opacity"in t.style)t.style.opacity=e;else if("filter"in t.style){var i=!1,n="DXImageTransform.Microsoft.Alpha";try{i=t.filters.item(n)}catch(t){if(1===e)return}e=Math.round(100*e),i?(i.Enabled=100!==e,i.Opacity=e):t.style.filter+=" progid:"+n+"(opacity="+e+")"}}function we(t){for(var e=document.documentElement.style,i=0;i<t.length;i++)if(t[i]in e)return t[i];return!1}function be(t,e,i){e=e||new p(0,0);t.style[ue]=(b.ie3d?"translate("+e.x+"px,"+e.y+"px)":"translate3d("+e.x+"px,"+e.y+"px,0)")+(i?" scale("+i+")":"")}function Z(t,e){t._leaflet_pos=e,b.any3d?be(t,e):(t.style.left=e.x+"px",t.style.top=e.y+"px")}function Pe(t){return t._leaflet_pos||new p(0,0)}function Le(){S(window,"dragstart",O)}function Te(){k(window,"dragstart",O)}function Me(t){for(;-1===t.tabIndex;)t=t.parentNode;t.style&&(ze(),le=(he=t).style.outlineStyle,t.style.outlineStyle="none",S(window,"keydown",ze))}function ze(){he&&(he.style.outlineStyle=le,le=he=void 0,k(window,"keydown",ze))}function Ce(t){for(;!((t=t.parentNode).offsetWidth&&t.offsetHeight||t===document.body););return t}function Ze(t){var e=t.getBoundingClientRect();return{x:e.width/t.offsetWidth||1,y:e.height/t.offsetHeight||1,boundingClientRect:e}}ae="onselectstart"in document?(re=function(){S(window,"selectstart",O)},function(){k(window,"selectstart",O)}):(se=we(["userSelect","WebkitUserSelect","OUserSelect","MozUserSelect","msUserSelect"]),re=function(){var t;se&&(t=document.documentElement.style,oe=t[se],t[se]="none")},function(){se&&(document.documentElement.style[se]=oe,oe=void 0)});pt={__proto__:null,TRANSFORM:ue,TRANSITION:ce,TRANSITION_END:de,get:_e,getStyle:pe,create:P,remove:T,empty:me,toFront:fe,toBack:ge,hasClass:ve,addClass:M,removeClass:z,setClass:ye,getClass:xe,setOpacity:C,testProp:we,setTransform:be,setPosition:Z,getPosition:Pe,get disableTextSelection(){return re},get enableTextSelection(){return ae},disableImageDrag:Le,enableImageDrag:Te,preventOutline:Me,restoreOutline:ze,getSizedParentNode:Ce,getScale:Ze};function S(t,e,i,n){if(e&&"object"==typeof e)for(var o in e)ke(t,o,e[o],i);else for(var s=0,r=(e=F(e)).length;s<r;s++)ke(t,e[s],i,n);return this}var E="_leaflet_events";function k(t,e,i,n){if(1===arguments.length)Se(t),delete t[E];else if(e&&"object"==typeof e)for(var o in e)Oe(t,o,e[o],i);else if(e=F(e),2===arguments.length)Se(t,function(t){return-1!==G(e,t)});else for(var s=0,r=e.length;s<r;s++)Oe(t,e[s],i,n);return this}function Se(t,e){for(var i in t[E]){var n=i.split(/\\d/)[0];e&&!e(n)||Oe(t,n,null,null,i)}}var Ee={mouseenter:"mouseover",mouseleave:"mouseout",wheel:!("onwheel"in window)&&"mousewheel"};function ke(e,t,i,n){var o,s,r=t+h(i)+(n?"_"+h(n):"");e[E]&&e[E][r]||(s=o=function(t){return i.call(n||e,t||window.event)},!b.touchNative&&b.pointer&&0===t.indexOf("touch")?o=Jt(e,t,o):b.touch&&"dblclick"===t?o=ne(e,o):"addEventListener"in e?"touchstart"===t||"touchmove"===t||"wheel"===t||"mousewheel"===t?e.addEventListener(Ee[t]||t,o,!!b.passiveEvents&&{passive:!1}):"mouseenter"===t||"mouseleave"===t?e.addEventListener(Ee[t],o=function(t){t=t||window.event,We(e,t)&&s(t)},!1):e.addEventListener(t,s,!1):e.attachEvent("on"+t,o),e[E]=e[E]||{},e[E][r]=o)}function Oe(t,e,i,n,o){o=o||e+h(i)+(n?"_"+h(n):"");var s,r,i=t[E]&&t[E][o];i&&(!b.touchNative&&b.pointer&&0===e.indexOf("touch")?(n=t,r=i,Gt[s=e]?n.removeEventListener(Gt[s],r,!1):console.warn("wrong event specified:",s)):b.touch&&"dblclick"===e?(n=i,(r=t).removeEventListener("dblclick",n.dblclick),r.removeEventListener("click",n.simDblclick)):"removeEventListener"in t?t.removeEventListener(Ee[e]||e,i,!1):t.detachEvent("on"+e,i),t[E][o]=null)}function Ae(t){return t.stopPropagation?t.stopPropagation():t.originalEvent?t.originalEvent._stopped=!0:t.cancelBubble=!0,this}function Be(t){return ke(t,"wheel",Ae),this}function Ie(t){return S(t,"mousedown touchstart dblclick contextmenu",Ae),t._leaflet_disable_click=!0,this}function O(t){return t.preventDefault?t.preventDefault():t.returnValue=!1,this}function Re(t){return O(t),Ae(t),this}function Ne(t){if(t.composedPath)return t.composedPath();for(var e=[],i=t.target;i;)e.push(i),i=i.parentNode;return e}function De(t,e){var i,n;return e?(n=(i=Ze(e)).boundingClientRect,new p((t.clientX-n.left)/i.x-e.clientLeft,(t.clientY-n.top)/i.y-e.clientTop)):new p(t.clientX,t.clientY)}var je=b.linux&&b.chrome?window.devicePixelRatio:b.mac?3*window.devicePixelRatio:0<window.devicePixelRatio?2*window.devicePixelRatio:1;function He(t){return b.edge?t.wheelDeltaY/2:t.deltaY&&0===t.deltaMode?-t.deltaY/je:t.deltaY&&1===t.deltaMode?20*-t.deltaY:t.deltaY&&2===t.deltaMode?60*-t.deltaY:t.deltaX||t.deltaZ?0:t.wheelDelta?(t.wheelDeltaY||t.wheelDelta)/2:t.detail&&Math.abs(t.detail)<32765?20*-t.detail:t.detail?t.detail/-32765*60:0}function We(t,e){var i=e.relatedTarget;if(!i)return!0;try{for(;i&&i!==t;)i=i.parentNode}catch(t){return!1}return i!==t}var mt={__proto__:null,on:S,off:k,stopPropagation:Ae,disableScrollPropagation:Be,disableClickPropagation:Ie,preventDefault:O,stop:Re,getPropagationPath:Ne,getMousePosition:De,getWheelDelta:He,isExternalTarget:We,addListener:S,removeListener:k},Fe=it.extend({run:function(t,e,i,n){this.stop(),this._el=t,this._inProgress=!0,this._duration=i||.25,this._easeOutPower=1/Math.max(n||.5,.2),this._startPos=Pe(t),this._offset=e.subtract(this._startPos),this._startTime=+new Date,this.fire("start"),this._animate()},stop:function(){this._inProgress&&(this._step(!0),this._complete())},_animate:function(){this._animId=x(this._animate,this),this._step()},_step:function(t){var e=+new Date-this._startTime,i=1e3*this._duration;e<i?this._runFrame(this._easeOut(e/i),t):(this._runFrame(1),this._complete())},_runFrame:function(t,e){t=this._startPos.add(this._offset.multiplyBy(t));e&&t._round(),Z(this._el,t),this.fire("step")},_complete:function(){r(this._animId),this._inProgress=!1,this.fire("end")},_easeOut:function(t){return 1-Math.pow(1-t,this._easeOutPower)}}),A=it.extend({options:{crs:lt,center:void 0,zoom:void 0,minZoom:void 0,maxZoom:void 0,layers:[],maxBounds:void 0,renderer:void 0,zoomAnimation:!0,zoomAnimationThreshold:4,fadeAnimation:!0,markerZoomAnimation:!0,transform3DLimit:8388608,zoomSnap:1,zoomDelta:1,trackResize:!0},initialize:function(t,e){e=c(this,e),this._handlers=[],this._layers={},this._zoomBoundLayers={},this._sizeChanged=!0,this._initContainer(t),this._initLayout(),this._onResize=a(this._onResize,this),this._initEvents(),e.maxBounds&&this.setMaxBounds(e.maxBounds),void 0!==e.zoom&&(this._zoom=this._limitZoom(e.zoom)),e.center&&void 0!==e.zoom&&this.setView(w(e.center),e.zoom,{reset:!0}),this.callInitHooks(),this._zoomAnimated=ce&&b.any3d&&!b.mobileOpera&&this.options.zoomAnimation,this._zoomAnimated&&(this._createAnimProxy(),S(this._proxy,de,this._catchTransitionEnd,this)),this._addLayers(this.options.layers)},setView:function(t,e,i){if((e=void 0===e?this._zoom:this._limitZoom(e),t=this._limitCenter(w(t),e,this.options.maxBounds),i=i||{},this._stop(),this._loaded&&!i.reset&&!0!==i)&&(void 0!==i.animate&&(i.zoom=l({animate:i.animate},i.zoom),i.pan=l({animate:i.animate,duration:i.duration},i.pan)),this._zoom!==e?this._tryAnimatedZoom&&this._tryAnimatedZoom(t,e,i.zoom):this._tryAnimatedPan(t,i.pan)))return clearTimeout(this._sizeTimer),this;return this._resetView(t,e,i.pan&&i.pan.noMoveStart),this},setZoom:function(t,e){return this._loaded?this.setView(this.getCenter(),t,{zoom:e}):(this._zoom=t,this)},zoomIn:function(t,e){return t=t||(b.any3d?this.options.zoomDelta:1),this.setZoom(this._zoom+t,e)},zoomOut:function(t,e){return t=t||(b.any3d?this.options.zoomDelta:1),this.setZoom(this._zoom-t,e)},setZoomAround:function(t,e,i){var n=this.getZoomScale(e),o=this.getSize().divideBy(2),t=(t instanceof p?t:this.latLngToContainerPoint(t)).subtract(o).multiplyBy(1-1/n),n=this.containerPointToLatLng(o.add(t));return this.setView(n,e,{zoom:i})},_getBoundsCenterZoom:function(t,e){e=e||{},t=t.getBounds?t.getBounds():g(t);var i=m(e.paddingTopLeft||e.padding||[0,0]),n=m(e.paddingBottomRight||e.padding||[0,0]),o=this.getBoundsZoom(t,!1,i.add(n));return(o="number"==typeof e.maxZoom?Math.min(e.maxZoom,o):o)===1/0?{center:t.getCenter(),zoom:o}:(e=n.subtract(i).divideBy(2),n=this.project(t.getSouthWest(),o),i=this.project(t.getNorthEast(),o),{center:this.unproject(n.add(i).divideBy(2).add(e),o),zoom:o})},fitBounds:function(t,e){if((t=g(t)).isValid())return t=this._getBoundsCenterZoom(t,e),this.setView(t.center,t.zoom,e);throw new Error("Bounds are not valid.")},fitWorld:function(t){return this.fitBounds([[-90,-180],[90,180]],t)},panTo:function(t,e){return this.setView(t,this._zoom,{pan:e})},panBy:function(t,e){var i;return e=e||{},(t=m(t).round()).x||t.y?(!0===e.animate||this.getSize().contains(t)?(this._panAnim||(this._panAnim=new Fe,this._panAnim.on({step:this._onPanTransitionStep,end:this._onPanTransitionEnd},this)),e.noMoveStart||this.fire("movestart"),!1!==e.animate?(M(this._mapPane,"leaflet-pan-anim"),i=this._getMapPanePos().subtract(t).round(),this._panAnim.run(this._mapPane,i,e.duration||.25,e.easeLinearity)):(this._rawPanBy(t),this.fire("move").fire("moveend"))):this._resetView(this.unproject(this.project(this.getCenter()).add(t)),this.getZoom()),this):this.fire("moveend")},flyTo:function(n,o,t){if(!1===(t=t||{}).animate||!b.any3d)return this.setView(n,o,t);this._stop();var s=this.project(this.getCenter()),r=this.project(n),e=this.getSize(),a=this._zoom,h=(n=w(n),o=void 0===o?a:o,Math.max(e.x,e.y)),i=h*this.getZoomScale(a,o),l=r.distanceTo(s)||1,u=1.42,c=u*u;function d(t){t=(i*i-h*h+(t?-1:1)*c*c*l*l)/(2*(t?i:h)*c*l),t=Math.sqrt(t*t+1)-t;return t<1e-9?-18:Math.log(t)}function _(t){return(Math.exp(t)-Math.exp(-t))/2}function p(t){return(Math.exp(t)+Math.exp(-t))/2}var m=d(0);function f(t){return h*(p(m)*(_(t=m+u*t)/p(t))-_(m))/c}var g=Date.now(),v=(d(1)-m)/u,y=t.duration?1e3*t.duration:1e3*v*.8;return this._moveStart(!0,t.noMoveStart),function t(){var e=(Date.now()-g)/y,i=(1-Math.pow(1-e,1.5))*v;e<=1?(this._flyToFrame=x(t,this),this._move(this.unproject(s.add(r.subtract(s).multiplyBy(f(i)/l)),a),this.getScaleZoom(h/(e=i,h*(p(m)/p(m+u*e))),a),{flyTo:!0})):this._move(n,o)._moveEnd(!0)}.call(this),this},flyToBounds:function(t,e){t=this._getBoundsCenterZoom(t,e);return this.flyTo(t.center,t.zoom,e)},setMaxBounds:function(t){return t=g(t),this.listens("moveend",this._panInsideMaxBounds)&&this.off("moveend",this._panInsideMaxBounds),t.isValid()?(this.options.maxBounds=t,this._loaded&&this._panInsideMaxBounds(),this.on("moveend",this._panInsideMaxBounds)):(this.options.maxBounds=null,this)},setMinZoom:function(t){var e=this.options.minZoom;return this.options.minZoom=t,this._loaded&&e!==t&&(this.fire("zoomlevelschange"),this.getZoom()<this.options.minZoom)?this.setZoom(t):this},setMaxZoom:function(t){var e=this.options.maxZoom;return this.options.maxZoom=t,this._loaded&&e!==t&&(this.fire("zoomlevelschange"),this.getZoom()>this.options.maxZoom)?this.setZoom(t):this},panInsideBounds:function(t,e){this._enforcingBounds=!0;var i=this.getCenter(),t=this._limitCenter(i,this._zoom,g(t));return i.equals(t)||this.panTo(t,e),this._enforcingBounds=!1,this},panInside:function(t,e){var i=m((e=e||{}).paddingTopLeft||e.padding||[0,0]),n=m(e.paddingBottomRight||e.padding||[0,0]),o=this.project(this.getCenter()),t=this.project(t),s=this.getPixelBounds(),i=_([s.min.add(i),s.max.subtract(n)]),s=i.getSize();return i.contains(t)||(this._enforcingBounds=!0,n=t.subtract(i.getCenter()),i=i.extend(t).getSize().subtract(s),o.x+=n.x<0?-i.x:i.x,o.y+=n.y<0?-i.y:i.y,this.panTo(this.unproject(o),e),this._enforcingBounds=!1),this},invalidateSize:function(t){if(!this._loaded)return this;t=l({animate:!1,pan:!0},!0===t?{animate:!0}:t);var e=this.getSize(),i=(this._sizeChanged=!0,this._lastCenter=null,this.getSize()),n=e.divideBy(2).round(),o=i.divideBy(2).round(),n=n.subtract(o);return n.x||n.y?(t.animate&&t.pan?this.panBy(n):(t.pan&&this._rawPanBy(n),this.fire("move"),t.debounceMoveend?(clearTimeout(this._sizeTimer),this._sizeTimer=setTimeout(a(this.fire,this,"moveend"),200)):this.fire("moveend")),this.fire("resize",{oldSize:e,newSize:i})):this},stop:function(){return this.setZoom(this._limitZoom(this._zoom)),this.options.zoomSnap||this.fire("viewreset"),this._stop()},locate:function(t){var e,i;return t=this._locateOptions=l({timeout:1e4,watch:!1},t),"geolocation"in navigator?(e=a(this._handleGeolocationResponse,this),i=a(this._handleGeolocationError,this),t.watch?this._locationWatchId=navigator.geolocation.watchPosition(e,i,t):navigator.geolocation.getCurrentPosition(e,i,t)):this._handleGeolocationError({code:0,message:"Geolocation not supported."}),this},stopLocate:function(){return navigator.geolocation&&navigator.geolocation.clearWatch&&navigator.geolocation.clearWatch(this._locationWatchId),this._locateOptions&&(this._locateOptions.setView=!1),this},_handleGeolocationError:function(t){var e;this._container._leaflet_id&&(e=t.code,t=t.message||(1===e?"permission denied":2===e?"position unavailable":"timeout"),this._locateOptions.setView&&!this._loaded&&this.fitWorld(),this.fire("locationerror",{code:e,message:"Geolocation error: "+t+"."}))},_handleGeolocationResponse:function(t){if(this._container._leaflet_id){var e,i,n=new v(t.coords.latitude,t.coords.longitude),o=n.toBounds(2*t.coords.accuracy),s=this._locateOptions,r=(s.setView&&(e=this.getBoundsZoom(o),this.setView(n,s.maxZoom?Math.min(e,s.maxZoom):e)),{latlng:n,bounds:o,timestamp:t.timestamp});for(i in t.coords)"number"==typeof t.coords[i]&&(r[i]=t.coords[i]);this.fire("locationfound",r)}},addHandler:function(t,e){return e&&(e=this[t]=new e(this),this._handlers.push(e),this.options[t]&&e.enable()),this},remove:function(){if(this._initEvents(!0),this.options.maxBounds&&this.off("moveend",this._panInsideMaxBounds),this._containerId!==this._container._leaflet_id)throw new Error("Map container is being reused by another instance");try{delete this._container._leaflet_id,delete this._containerId}catch(t){this._container._leaflet_id=void 0,this._containerId=void 0}for(var t in void 0!==this._locationWatchId&&this.stopLocate(),this._stop(),T(this._mapPane),this._clearControlPos&&this._clearControlPos(),this._resizeRequest&&(r(this._resizeRequest),this._resizeRequest=null),this._clearHandlers(),this._loaded&&this.fire("unload"),this._layers)this._layers[t].remove();for(t in this._panes)T(this._panes[t]);return this._layers=[],this._panes=[],delete this._mapPane,delete this._renderer,this},createPane:function(t,e){e=P("div","leaflet-pane"+(t?" leaflet-"+t.replace("Pane","")+"-pane":""),e||this._mapPane);return t&&(this._panes[t]=e),e},getCenter:function(){return this._checkIfLoaded(),this._lastCenter&&!this._moved()?this._lastCenter.clone():this.layerPointToLatLng(this._getCenterLayerPoint())},getZoom:function(){return this._zoom},getBounds:function(){var t=this.getPixelBounds();return new s(this.unproject(t.getBottomLeft()),this.unproject(t.getTopRight()))},getMinZoom:function(){return void 0===this.options.minZoom?this._layersMinZoom||0:this.options.minZoom},getMaxZoom:function(){return void 0===this.options.maxZoom?void 0===this._layersMaxZoom?1/0:this._layersMaxZoom:this.options.maxZoom},getBoundsZoom:function(t,e,i){t=g(t),i=m(i||[0,0]);var n=this.getZoom()||0,o=this.getMinZoom(),s=this.getMaxZoom(),r=t.getNorthWest(),t=t.getSouthEast(),i=this.getSize().subtract(i),t=_(this.project(t,n),this.project(r,n)).getSize(),r=b.any3d?this.options.zoomSnap:1,a=i.x/t.x,i=i.y/t.y,t=e?Math.max(a,i):Math.min(a,i),n=this.getScaleZoom(t,n);return r&&(n=Math.round(n/(r/100))*(r/100),n=e?Math.ceil(n/r)*r:Math.floor(n/r)*r),Math.max(o,Math.min(s,n))},getSize:function(){return this._size&&!this._sizeChanged||(this._size=new p(this._container.clientWidth||0,this._container.clientHeight||0),this._sizeChanged=!1),this._size.clone()},getPixelBounds:function(t,e){t=this._getTopLeftPoint(t,e);return new f(t,t.add(this.getSize()))},getPixelOrigin:function(){return this._checkIfLoaded(),this._pixelOrigin},getPixelWorldBounds:function(t){return this.options.crs.getProjectedBounds(void 0===t?this.getZoom():t)},getPane:function(t){return"string"==typeof t?this._panes[t]:t},getPanes:function(){return this._panes},getContainer:function(){return this._container},getZoomScale:function(t,e){var i=this.options.crs;return e=void 0===e?this._zoom:e,i.scale(t)/i.scale(e)},getScaleZoom:function(t,e){var i=this.options.crs,t=(e=void 0===e?this._zoom:e,i.zoom(t*i.scale(e)));return isNaN(t)?1/0:t},project:function(t,e){return e=void 0===e?this._zoom:e,this.options.crs.latLngToPoint(w(t),e)},unproject:function(t,e){return e=void 0===e?this._zoom:e,this.options.crs.pointToLatLng(m(t),e)},layerPointToLatLng:function(t){t=m(t).add(this.getPixelOrigin());return this.unproject(t)},latLngToLayerPoint:function(t){return this.project(w(t))._round()._subtract(this.getPixelOrigin())},wrapLatLng:function(t){return this.options.crs.wrapLatLng(w(t))},wrapLatLngBounds:function(t){return this.options.crs.wrapLatLngBounds(g(t))},distance:function(t,e){return this.options.crs.distance(w(t),w(e))},containerPointToLayerPoint:function(t){return m(t).subtract(this._getMapPanePos())},layerPointToContainerPoint:function(t){return m(t).add(this._getMapPanePos())},containerPointToLatLng:function(t){t=this.containerPointToLayerPoint(m(t));return this.layerPointToLatLng(t)},latLngToContainerPoint:function(t){return this.layerPointToContainerPoint(this.latLngToLayerPoint(w(t)))},mouseEventToContainerPoint:function(t){return De(t,this._container)},mouseEventToLayerPoint:function(t){return this.containerPointToLayerPoint(this.mouseEventToContainerPoint(t))},mouseEventToLatLng:function(t){return this.layerPointToLatLng(this.mouseEventToLayerPoint(t))},_initContainer:function(t){t=this._container=_e(t);if(!t)throw new Error("Map container not found.");if(t._leaflet_id)throw new Error("Map container is already initialized.");S(t,"scroll",this._onScroll,this),this._containerId=h(t)},_initLayout:function(){var t=this._container,e=(this._fadeAnimated=this.options.fadeAnimation&&b.any3d,M(t,"leaflet-container"+(b.touch?" leaflet-touch":"")+(b.retina?" leaflet-retina":"")+(b.ielt9?" leaflet-oldie":"")+(b.safari?" leaflet-safari":"")+(this._fadeAnimated?" leaflet-fade-anim":"")),pe(t,"position"));"absolute"!==e&&"relative"!==e&&"fixed"!==e&&"sticky"!==e&&(t.style.position="relative"),this._initPanes(),this._initControlPos&&this._initControlPos()},_initPanes:function(){var t=this._panes={};this._paneRenderers={},this._mapPane=this.createPane("mapPane",this._container),Z(this._mapPane,new p(0,0)),this.createPane("tilePane"),this.createPane("overlayPane"),this.createPane("shadowPane"),this.createPane("markerPane"),this.createPane("tooltipPane"),this.createPane("popupPane"),this.options.markerZoomAnimation||(M(t.markerPane,"leaflet-zoom-hide"),M(t.shadowPane,"leaflet-zoom-hide"))},_resetView:function(t,e,i){Z(this._mapPane,new p(0,0));var n=!this._loaded,o=(this._loaded=!0,e=this._limitZoom(e),this.fire("viewprereset"),this._zoom!==e);this._moveStart(o,i)._move(t,e)._moveEnd(o),this.fire("viewreset"),n&&this.fire("load")},_moveStart:function(t,e){return t&&this.fire("zoomstart"),e||this.fire("movestart"),this},_move:function(t,e,i,n){void 0===e&&(e=this._zoom);var o=this._zoom!==e;return this._zoom=e,this._lastCenter=t,this._pixelOrigin=this._getNewPixelOrigin(t),n?i&&i.pinch&&this.fire("zoom",i):((o||i&&i.pinch)&&this.fire("zoom",i),this.fire("move",i)),this},_moveEnd:function(t){return t&&this.fire("zoomend"),this.fire("moveend")},_stop:function(){return r(this._flyToFrame),this._panAnim&&this._panAnim.stop(),this},_rawPanBy:function(t){Z(this._mapPane,this._getMapPanePos().subtract(t))},_getZoomSpan:function(){return this.getMaxZoom()-this.getMinZoom()},_panInsideMaxBounds:function(){this._enforcingBounds||this.panInsideBounds(this.options.maxBounds)},_checkIfLoaded:function(){if(!this._loaded)throw new Error("Set map center and zoom first.")},_initEvents:function(t){this._targets={};var e=t?k:S;e((this._targets[h(this._container)]=this)._container,"click dblclick mousedown mouseup mouseover mouseout mousemove contextmenu keypress keydown keyup",this._handleDOMEvent,this),this.options.trackResize&&e(window,"resize",this._onResize,this),b.any3d&&this.options.transform3DLimit&&(t?this.off:this.on).call(this,"moveend",this._onMoveEnd)},_onResize:function(){r(this._resizeRequest),this._resizeRequest=x(function(){this.invalidateSize({debounceMoveend:!0})},this)},_onScroll:function(){this._container.scrollTop=0,this._container.scrollLeft=0},_onMoveEnd:function(){var t=this._getMapPanePos();Math.max(Math.abs(t.x),Math.abs(t.y))>=this.options.transform3DLimit&&this._resetView(this.getCenter(),this.getZoom())},_findEventTargets:function(t,e){for(var i,n=[],o="mouseout"===e||"mouseover"===e,s=t.target||t.srcElement,r=!1;s;){if((i=this._targets[h(s)])&&("click"===e||"preclick"===e)&&this._draggableMoved(i)){r=!0;break}if(i&&i.listens(e,!0)){if(o&&!We(s,t))break;if(n.push(i),o)break}if(s===this._container)break;s=s.parentNode}return n=n.length||r||o||!this.listens(e,!0)?n:[this]},_isClickDisabled:function(t){for(;t&&t!==this._container;){if(t._leaflet_disable_click)return!0;t=t.parentNode}},_handleDOMEvent:function(t){var e,i=t.target||t.srcElement;!this._loaded||i._leaflet_disable_events||"click"===t.type&&this._isClickDisabled(i)||("mousedown"===(e=t.type)&&Me(i),this._fireDOMEvent(t,e))},_mouseEvents:["click","dblclick","mouseover","mouseout","contextmenu"],_fireDOMEvent:function(t,e,i){"click"===t.type&&((a=l({},t)).type="preclick",this._fireDOMEvent(a,a.type,i));var n=this._findEventTargets(t,e);if(i){for(var o=[],s=0;s<i.length;s++)i[s].listens(e,!0)&&o.push(i[s]);n=o.concat(n)}if(n.length){"contextmenu"===e&&O(t);var r,a=n[0],h={originalEvent:t};for("keypress"!==t.type&&"keydown"!==t.type&&"keyup"!==t.type&&(r=a.getLatLng&&(!a._radius||a._radius<=10),h.containerPoint=r?this.latLngToContainerPoint(a.getLatLng()):this.mouseEventToContainerPoint(t),h.layerPoint=this.containerPointToLayerPoint(h.containerPoint),h.latlng=r?a.getLatLng():this.layerPointToLatLng(h.layerPoint)),s=0;s<n.length;s++)if(n[s].fire(e,h,!0),h.originalEvent._stopped||!1===n[s].options.bubblingMouseEvents&&-1!==G(this._mouseEvents,e))return}},_draggableMoved:function(t){return(t=t.dragging&&t.dragging.enabled()?t:this).dragging&&t.dragging.moved()||this.boxZoom&&this.boxZoom.moved()},_clearHandlers:function(){for(var t=0,e=this._handlers.length;t<e;t++)this._handlers[t].disable()},whenReady:function(t,e){return this._loaded?t.call(e||this,{target:this}):this.on("load",t,e),this},_getMapPanePos:function(){return Pe(this._mapPane)||new p(0,0)},_moved:function(){var t=this._getMapPanePos();return t&&!t.equals([0,0])},_getTopLeftPoint:function(t,e){return(t&&void 0!==e?this._getNewPixelOrigin(t,e):this.getPixelOrigin()).subtract(this._getMapPanePos())},_getNewPixelOrigin:function(t,e){var i=this.getSize()._divideBy(2);return this.project(t,e)._subtract(i)._add(this._getMapPanePos())._round()},_latLngToNewLayerPoint:function(t,e,i){i=this._getNewPixelOrigin(i,e);return this.project(t,e)._subtract(i)},_latLngBoundsToNewLayerBounds:function(t,e,i){i=this._getNewPixelOrigin(i,e);return _([this.project(t.getSouthWest(),e)._subtract(i),this.project(t.getNorthWest(),e)._subtract(i),this.project(t.getSouthEast(),e)._subtract(i),this.project(t.getNorthEast(),e)._subtract(i)])},_getCenterLayerPoint:function(){return this.containerPointToLayerPoint(this.getSize()._divideBy(2))},_getCenterOffset:function(t){return this.latLngToLayerPoint(t).subtract(this._getCenterLayerPoint())},_limitCenter:function(t,e,i){var n,o;return!i||(n=this.project(t,e),o=this.getSize().divideBy(2),o=new f(n.subtract(o),n.add(o)),o=this._getBoundsOffset(o,i,e),Math.abs(o.x)<=1&&Math.abs(o.y)<=1)?t:this.unproject(n.add(o),e)},_limitOffset:function(t,e){var i;return e?(i=new f((i=this.getPixelBounds()).min.add(t),i.max.add(t)),t.add(this._getBoundsOffset(i,e))):t},_getBoundsOffset:function(t,e,i){e=_(this.project(e.getNorthEast(),i),this.project(e.getSouthWest(),i)),i=e.min.subtract(t.min),e=e.max.subtract(t.max);return new p(this._rebound(i.x,-e.x),this._rebound(i.y,-e.y))},_rebound:function(t,e){return 0<t+e?Math.round(t-e)/2:Math.max(0,Math.ceil(t))-Math.max(0,Math.floor(e))},_limitZoom:function(t){var e=this.getMinZoom(),i=this.getMaxZoom(),n=b.any3d?this.options.zoomSnap:1;return n&&(t=Math.round(t/n)*n),Math.max(e,Math.min(i,t))},_onPanTransitionStep:function(){this.fire("move")},_onPanTransitionEnd:function(){z(this._mapPane,"leaflet-pan-anim"),this.fire("moveend")},_tryAnimatedPan:function(t,e){t=this._getCenterOffset(t)._trunc();return!(!0!==(e&&e.animate)&&!this.getSize().contains(t))&&(this.panBy(t,e),!0)},_createAnimProxy:function(){var t=this._proxy=P("div","leaflet-proxy leaflet-zoom-animated");this._panes.mapPane.appendChild(t),this.on("zoomanim",function(t){var e=ue,i=this._proxy.style[e];be(this._proxy,this.project(t.center,t.zoom),this.getZoomScale(t.zoom,1)),i===this._proxy.style[e]&&this._animatingZoom&&this._onZoomTransitionEnd()},this),this.on("load moveend",this._animMoveEnd,this),this._on("unload",this._destroyAnimProxy,this)},_destroyAnimProxy:function(){T(this._proxy),this.off("load moveend",this._animMoveEnd,this),delete this._proxy},_animMoveEnd:function(){var t=this.getCenter(),e=this.getZoom();be(this._proxy,this.project(t,e),this.getZoomScale(e,1))},_catchTransitionEnd:function(t){this._animatingZoom&&0<=t.propertyName.indexOf("transform")&&this._onZoomTransitionEnd()},_nothingToAnimate:function(){return!this._container.getElementsByClassName("leaflet-zoom-animated").length},_tryAnimatedZoom:function(t,e,i){if(!this._animatingZoom){if(i=i||{},!this._zoomAnimated||!1===i.animate||this._nothingToAnimate()||Math.abs(e-this._zoom)>this.options.zoomAnimationThreshold)return!1;var n=this.getZoomScale(e),n=this._getCenterOffset(t)._divideBy(1-1/n);if(!0!==i.animate&&!this.getSize().contains(n))return!1;x(function(){this._moveStart(!0,i.noMoveStart||!1)._animateZoom(t,e,!0)},this)}return!0},_animateZoom:function(t,e,i,n){this._mapPane&&(i&&(this._animatingZoom=!0,this._animateToCenter=t,this._animateToZoom=e,M(this._mapPane,"leaflet-zoom-anim")),this.fire("zoomanim",{center:t,zoom:e,noUpdate:n}),this._tempFireZoomEvent||(this._tempFireZoomEvent=this._zoom!==this._animateToZoom),this._move(this._animateToCenter,this._animateToZoom,void 0,!0),setTimeout(a(this._onZoomTransitionEnd,this),250))},_onZoomTransitionEnd:function(){this._animatingZoom&&(this._mapPane&&z(this._mapPane,"leaflet-zoom-anim"),this._animatingZoom=!1,this._move(this._animateToCenter,this._animateToZoom,void 0,!0),this._tempFireZoomEvent&&this.fire("zoom"),delete this._tempFireZoomEvent,this.fire("move"),this._moveEnd(!0))}});function Ue(t){return new B(t)}var B=et.extend({options:{position:"topright"},initialize:function(t){c(this,t)},getPosition:function(){return this.options.position},setPosition:function(t){var e=this._map;return e&&e.removeControl(this),this.options.position=t,e&&e.addControl(this),this},getContainer:function(){return this._container},addTo:function(t){this.remove(),this._map=t;var e=this._container=this.onAdd(t),i=this.getPosition(),t=t._controlCorners[i];return M(e,"leaflet-control"),-1!==i.indexOf("bottom")?t.insertBefore(e,t.firstChild):t.appendChild(e),this._map.on("unload",this.remove,this),this},remove:function(){return this._map&&(T(this._container),this.onRemove&&this.onRemove(this._map),this._map.off("unload",this.remove,this),this._map=null),this},_refocusOnMap:function(t){this._map&&t&&0<t.screenX&&0<t.screenY&&this._map.getContainer().focus()}}),Ve=(A.include({addControl:function(t){return t.addTo(this),this},removeControl:function(t){return t.remove(),this},_initControlPos:function(){var i=this._controlCorners={},n="leaflet-",o=this._controlContainer=P("div",n+"control-container",this._container);function t(t,e){i[t+e]=P("div",n+t+" "+n+e,o)}t("top","left"),t("top","right"),t("bottom","left"),t("bottom","right")},_clearControlPos:function(){for(var t in this._controlCorners)T(this._controlCorners[t]);T(this._controlContainer),delete this._controlCorners,delete this._controlContainer}}),B.extend({options:{collapsed:!0,position:"topright",autoZIndex:!0,hideSingleBase:!1,sortLayers:!1,sortFunction:function(t,e,i,n){return i<n?-1:n<i?1:0}},initialize:function(t,e,i){for(var n in c(this,i),this._layerControlInputs=[],this._layers=[],this._lastZIndex=0,this._handlingClick=!1,this._preventClick=!1,t)this._addLayer(t[n],n);for(n in e)this._addLayer(e[n],n,!0)},onAdd:function(t){this._initLayout(),this._update(),(this._map=t).on("zoomend",this._checkDisabledLayers,this);for(var e=0;e<this._layers.length;e++)this._layers[e].layer.on("add remove",this._onLayerChange,this);return this._container},addTo:function(t){return B.prototype.addTo.call(this,t),this._expandIfNotCollapsed()},onRemove:function(){this._map.off("zoomend",this._checkDisabledLayers,this);for(var t=0;t<this._layers.length;t++)this._layers[t].layer.off("add remove",this._onLayerChange,this)},addBaseLayer:function(t,e){return this._addLayer(t,e),this._map?this._update():this},addOverlay:function(t,e){return this._addLayer(t,e,!0),this._map?this._update():this},removeLayer:function(t){t.off("add remove",this._onLayerChange,this);t=this._getLayer(h(t));return t&&this._layers.splice(this._layers.indexOf(t),1),this._map?this._update():this},expand:function(){M(this._container,"leaflet-control-layers-expanded"),this._section.style.height=null;var t=this._map.getSize().y-(this._container.offsetTop+50);return t<this._section.clientHeight?(M(this._section,"leaflet-control-layers-scrollbar"),this._section.style.height=t+"px"):z(this._section,"leaflet-control-layers-scrollbar"),this._checkDisabledLayers(),this},collapse:function(){return z(this._container,"leaflet-control-layers-expanded"),this},_initLayout:function(){var t="leaflet-control-layers",e=this._container=P("div",t),i=this.options.collapsed,n=(e.setAttribute("aria-haspopup",!0),Ie(e),Be(e),this._section=P("section",t+"-list")),o=(i&&(this._map.on("click",this.collapse,this),S(e,{mouseenter:this._expandSafely,mouseleave:this.collapse},this)),this._layersLink=P("a",t+"-toggle",e));o.href="#",o.title="Layers",o.setAttribute("role","button"),S(o,{keydown:function(t){13===t.keyCode&&this._expandSafely()},click:function(t){O(t),this._expandSafely()}},this),i||this.expand(),this._baseLayersList=P("div",t+"-base",n),this._separator=P("div",t+"-separator",n),this._overlaysList=P("div",t+"-overlays",n),e.appendChild(n)},_getLayer:function(t){for(var e=0;e<this._layers.length;e++)if(this._layers[e]&&h(this._layers[e].layer)===t)return this._layers[e]},_addLayer:function(t,e,i){this._map&&t.on("add remove",this._onLayerChange,this),this._layers.push({layer:t,name:e,overlay:i}),this.options.sortLayers&&this._layers.sort(a(function(t,e){return this.options.sortFunction(t.layer,e.layer,t.name,e.name)},this)),this.options.autoZIndex&&t.setZIndex&&(this._lastZIndex++,t.setZIndex(this._lastZIndex)),this._expandIfNotCollapsed()},_update:function(){if(this._container){me(this._baseLayersList),me(this._overlaysList),this._layerControlInputs=[];for(var t,e,i,n=0,o=0;o<this._layers.length;o++)i=this._layers[o],this._addItem(i),e=e||i.overlay,t=t||!i.overlay,n+=i.overlay?0:1;this.options.hideSingleBase&&(this._baseLayersList.style.display=(t=t&&1<n)?"":"none"),this._separator.style.display=e&&t?"":"none"}return this},_onLayerChange:function(t){this._handlingClick||this._update();var e=this._getLayer(h(t.target)),t=e.overlay?"add"===t.type?"overlayadd":"overlayremove":"add"===t.type?"baselayerchange":null;t&&this._map.fire(t,e)},_createRadioElement:function(t,e){t='<input type="radio" class="leaflet-control-layers-selector" name="'+t+'"'+(e?' checked="checked"':"")+"/>",e=document.createElement("div");return e.innerHTML=t,e.firstChild},_addItem:function(t){var e,i=document.createElement("label"),n=this._map.hasLayer(t.layer),n=(t.overlay?((e=document.createElement("input")).type="checkbox",e.className="leaflet-control-layers-selector",e.defaultChecked=n):e=this._createRadioElement("leaflet-base-layers_"+h(this),n),this._layerControlInputs.push(e),e.layerId=h(t.layer),S(e,"click",this._onInputClick,this),document.createElement("span")),o=(n.innerHTML=" "+t.name,document.createElement("span"));return i.appendChild(o),o.appendChild(e),o.appendChild(n),(t.overlay?this._overlaysList:this._baseLayersList).appendChild(i),this._checkDisabledLayers(),i},_onInputClick:function(){if(!this._preventClick){var t,e,i=this._layerControlInputs,n=[],o=[];this._handlingClick=!0;for(var s=i.length-1;0<=s;s--)t=i[s],e=this._getLayer(t.layerId).layer,t.checked?n.push(e):t.checked||o.push(e);for(s=0;s<o.length;s++)this._map.hasLayer(o[s])&&this._map.removeLayer(o[s]);for(s=0;s<n.length;s++)this._map.hasLayer(n[s])||this._map.addLayer(n[s]);this._handlingClick=!1,this._refocusOnMap()}},_checkDisabledLayers:function(){for(var t,e,i=this._layerControlInputs,n=this._map.getZoom(),o=i.length-1;0<=o;o--)t=i[o],e=this._getLayer(t.layerId).layer,t.disabled=void 0!==e.options.minZoom&&n<e.options.minZoom||void 0!==e.options.maxZoom&&n>e.options.maxZoom},_expandIfNotCollapsed:function(){return this._map&&!this.options.collapsed&&this.expand(),this},_expandSafely:function(){var t=this._section,e=(this._preventClick=!0,S(t,"click",O),this.expand(),this);setTimeout(function(){k(t,"click",O),e._preventClick=!1})}})),qe=B.extend({options:{position:"topleft",zoomInText:'<span aria-hidden="true">+</span>',zoomInTitle:"Zoom in",zoomOutText:'<span aria-hidden="true">&#x2212;</span>',zoomOutTitle:"Zoom out"},onAdd:function(t){var e="leaflet-control-zoom",i=P("div",e+" leaflet-bar"),n=this.options;return this._zoomInButton=this._createButton(n.zoomInText,n.zoomInTitle,e+"-in",i,this._zoomIn),this._zoomOutButton=this._createButton(n.zoomOutText,n.zoomOutTitle,e+"-out",i,this._zoomOut),this._updateDisabled(),t.on("zoomend zoomlevelschange",this._updateDisabled,this),i},onRemove:function(t){t.off("zoomend zoomlevelschange",this._updateDisabled,this)},disable:function(){return this._disabled=!0,this._updateDisabled(),this},enable:function(){return this._disabled=!1,this._updateDisabled(),this},_zoomIn:function(t){!this._disabled&&this._map._zoom<this._map.getMaxZoom()&&this._map.zoomIn(this._map.options.zoomDelta*(t.shiftKey?3:1))},_zoomOut:function(t){!this._disabled&&this._map._zoom>this._map.getMinZoom()&&this._map.zoomOut(this._map.options.zoomDelta*(t.shiftKey?3:1))},_createButton:function(t,e,i,n,o){i=P("a",i,n);return i.innerHTML=t,i.href="#",i.title=e,i.setAttribute("role","button"),i.setAttribute("aria-label",e),Ie(i),S(i,"click",Re),S(i,"click",o,this),S(i,"click",this._refocusOnMap,this),i},_updateDisabled:function(){var t=this._map,e="leaflet-disabled";z(this._zoomInButton,e),z(this._zoomOutButton,e),this._zoomInButton.setAttribute("aria-disabled","false"),this._zoomOutButton.setAttribute("aria-disabled","false"),!this._disabled&&t._zoom!==t.getMinZoom()||(M(this._zoomOutButton,e),this._zoomOutButton.setAttribute("aria-disabled","true")),!this._disabled&&t._zoom!==t.getMaxZoom()||(M(this._zoomInButton,e),this._zoomInButton.setAttribute("aria-disabled","true"))}}),Ge=(A.mergeOptions({zoomControl:!0}),A.addInitHook(function(){this.options.zoomControl&&(this.zoomControl=new qe,this.addControl(this.zoomControl))}),B.extend({options:{position:"bottomleft",maxWidth:100,metric:!0,imperial:!0},onAdd:function(t){var e="leaflet-control-scale",i=P("div",e),n=this.options;return this._addScales(n,e+"-line",i),t.on(n.updateWhenIdle?"moveend":"move",this._update,this),t.whenReady(this._update,this),i},onRemove:function(t){t.off(this.options.updateWhenIdle?"moveend":"move",this._update,this)},_addScales:function(t,e,i){t.metric&&(this._mScale=P("div",e,i)),t.imperial&&(this._iScale=P("div",e,i))},_update:function(){var t=this._map,e=t.getSize().y/2,t=t.distance(t.containerPointToLatLng([0,e]),t.containerPointToLatLng([this.options.maxWidth,e]));this._updateScales(t)},_updateScales:function(t){this.options.metric&&t&&this._updateMetric(t),this.options.imperial&&t&&this._updateImperial(t)},_updateMetric:function(t){var e=this._getRoundNum(t);this._updateScale(this._mScale,e<1e3?e+" m":e/1e3+" km",e/t)},_updateImperial:function(t){var e,i,t=3.2808399*t;5280<t?(i=this._getRoundNum(e=t/5280),this._updateScale(this._iScale,i+" mi",i/e)):(i=this._getRoundNum(t),this._updateScale(this._iScale,i+" ft",i/t))},_updateScale:function(t,e,i){t.style.width=Math.round(this.options.maxWidth*i)+"px",t.innerHTML=e},_getRoundNum:function(t){var e=Math.pow(10,(Math.floor(t)+"").length-1),t=t/e;return e*(t=10<=t?10:5<=t?5:3<=t?3:2<=t?2:1)}})),Ke=B.extend({options:{position:"bottomright",prefix:'<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">'+(b.inlineSvg?'<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8" class="leaflet-attribution-flag"><path fill="#4C7BE1" d="M0 0h12v4H0z"/><path fill="#FFD500" d="M0 4h12v3H0z"/><path fill="#E0BC00" d="M0 7h12v1H0z"/></svg> ':"")+"Leaflet</a>"},initialize:function(t){c(this,t),this._attributions={}},onAdd:function(t){for(var e in(t.attributionControl=this)._container=P("div","leaflet-control-attribution"),Ie(this._container),t._layers)t._layers[e].getAttribution&&this.addAttribution(t._layers[e].getAttribution());return this._update(),t.on("layeradd",this._addAttribution,this),this._container},onRemove:function(t){t.off("layeradd",this._addAttribution,this)},_addAttribution:function(t){t.layer.getAttribution&&(this.addAttribution(t.layer.getAttribution()),t.layer.once("remove",function(){this.removeAttribution(t.layer.getAttribution())},this))},setPrefix:function(t){return this.options.prefix=t,this._update(),this},addAttribution:function(t){return t&&(this._attributions[t]||(this._attributions[t]=0),this._attributions[t]++,this._update()),this},removeAttribution:function(t){return t&&this._attributions[t]&&(this._attributions[t]--,this._update()),this},_update:function(){if(this._map){var t,e=[];for(t in this._attributions)this._attributions[t]&&e.push(t);var i=[];this.options.prefix&&i.push(this.options.prefix),e.length&&i.push(e.join(", ")),this._container.innerHTML=i.join(' <span aria-hidden="true">|</span> ')}}}),n=(A.mergeOptions({attributionControl:!0}),A.addInitHook(function(){this.options.attributionControl&&(new Ke).addTo(this)}),B.Layers=Ve,B.Zoom=qe,B.Scale=Ge,B.Attribution=Ke,Ue.layers=function(t,e,i){return new Ve(t,e,i)},Ue.zoom=function(t){return new qe(t)},Ue.scale=function(t){return new Ge(t)},Ue.attribution=function(t){return new Ke(t)},et.extend({initialize:function(t){this._map=t},enable:function(){return this._enabled||(this._enabled=!0,this.addHooks()),this},disable:function(){return this._enabled&&(this._enabled=!1,this.removeHooks()),this},enabled:function(){return!!this._enabled}})),ft=(n.addTo=function(t,e){return t.addHandler(e,this),this},{Events:e}),Ye=b.touch?"touchstart mousedown":"mousedown",Xe=it.extend({options:{clickTolerance:3},initialize:function(t,e,i,n){c(this,n),this._element=t,this._dragStartTarget=e||t,this._preventOutline=i},enable:function(){this._enabled||(S(this._dragStartTarget,Ye,this._onDown,this),this._enabled=!0)},disable:function(){this._enabled&&(Xe._dragging===this&&this.finishDrag(!0),k(this._dragStartTarget,Ye,this._onDown,this),this._enabled=!1,this._moved=!1)},_onDown:function(t){var e,i;this._enabled&&(this._moved=!1,ve(this._element,"leaflet-zoom-anim")||(t.touches&&1!==t.touches.length?Xe._dragging===this&&this.finishDrag():Xe._dragging||t.shiftKey||1!==t.which&&1!==t.button&&!t.touches||((Xe._dragging=this)._preventOutline&&Me(this._element),Le(),re(),this._moving||(this.fire("down"),i=t.touches?t.touches[0]:t,e=Ce(this._element),this._startPoint=new p(i.clientX,i.clientY),this._startPos=Pe(this._element),this._parentScale=Ze(e),i="mousedown"===t.type,S(document,i?"mousemove":"touchmove",this._onMove,this),S(document,i?"mouseup":"touchend touchcancel",this._onUp,this)))))},_onMove:function(t){var e;this._enabled&&(t.touches&&1<t.touches.length?this._moved=!0:!(e=new p((e=t.touches&&1===t.touches.length?t.touches[0]:t).clientX,e.clientY)._subtract(this._startPoint)).x&&!e.y||Math.abs(e.x)+Math.abs(e.y)<this.options.clickTolerance||(e.x/=this._parentScale.x,e.y/=this._parentScale.y,O(t),this._moved||(this.fire("dragstart"),this._moved=!0,M(document.body,"leaflet-dragging"),this._lastTarget=t.target||t.srcElement,window.SVGElementInstance&&this._lastTarget instanceof window.SVGElementInstance&&(this._lastTarget=this._lastTarget.correspondingUseElement),M(this._lastTarget,"leaflet-drag-target")),this._newPos=this._startPos.add(e),this._moving=!0,this._lastEvent=t,this._updatePosition()))},_updatePosition:function(){var t={originalEvent:this._lastEvent};this.fire("predrag",t),Z(this._element,this._newPos),this.fire("drag",t)},_onUp:function(){this._enabled&&this.finishDrag()},finishDrag:function(t){z(document.body,"leaflet-dragging"),this._lastTarget&&(z(this._lastTarget,"leaflet-drag-target"),this._lastTarget=null),k(document,"mousemove touchmove",this._onMove,this),k(document,"mouseup touchend touchcancel",this._onUp,this),Te(),ae();var e=this._moved&&this._moving;this._moving=!1,Xe._dragging=!1,e&&this.fire("dragend",{noInertia:t,distance:this._newPos.distanceTo(this._startPos)})}});function Je(t,e,i){for(var n,o,s,r,a,h,l,u=[1,4,2,8],c=0,d=t.length;c<d;c++)t[c]._code=si(t[c],e);for(s=0;s<4;s++){for(h=u[s],n=[],c=0,o=(d=t.length)-1;c<d;o=c++)r=t[c],a=t[o],r._code&h?a._code&h||((l=oi(a,r,h,e,i))._code=si(l,e),n.push(l)):(a._code&h&&((l=oi(a,r,h,e,i))._code=si(l,e),n.push(l)),n.push(r));t=n}return t}function $e(t,e){var i,n,o,s,r,a,h;if(!t||0===t.length)throw new Error("latlngs not passed");I(t)||(console.warn("latlngs are not flat! Only the first ring will be used"),t=t[0]);for(var l=w([0,0]),u=g(t),c=(u.getNorthWest().distanceTo(u.getSouthWest())*u.getNorthEast().distanceTo(u.getNorthWest())<1700&&(l=Qe(t)),t.length),d=[],_=0;_<c;_++){var p=w(t[_]);d.push(e.project(w([p.lat-l.lat,p.lng-l.lng])))}for(_=r=a=h=0,i=c-1;_<c;i=_++)n=d[_],o=d[i],s=n.y*o.x-o.y*n.x,a+=(n.x+o.x)*s,h+=(n.y+o.y)*s,r+=3*s;u=0===r?d[0]:[a/r,h/r],u=e.unproject(m(u));return w([u.lat+l.lat,u.lng+l.lng])}function Qe(t){for(var e=0,i=0,n=0,o=0;o<t.length;o++){var s=w(t[o]);e+=s.lat,i+=s.lng,n++}return w([e/n,i/n])}var ti,gt={__proto__:null,clipPolygon:Je,polygonCenter:$e,centroid:Qe};function ei(t,e){if(e&&t.length){var i=t=function(t,e){for(var i=[t[0]],n=1,o=0,s=t.length;n<s;n++)(function(t,e){var i=e.x-t.x,e=e.y-t.y;return i*i+e*e})(t[n],t[o])>e&&(i.push(t[n]),o=n);o<s-1&&i.push(t[s-1]);return i}(t,e=e*e),n=i.length,o=new(typeof Uint8Array!=void 0+""?Uint8Array:Array)(n);o[0]=o[n-1]=1,function t(e,i,n,o,s){var r,a,h,l=0;for(a=o+1;a<=s-1;a++)h=ri(e[a],e[o],e[s],!0),l<h&&(r=a,l=h);n<l&&(i[r]=1,t(e,i,n,o,r),t(e,i,n,r,s))}(i,o,e,0,n-1);var s,r=[];for(s=0;s<n;s++)o[s]&&r.push(i[s]);return r}return t.slice()}function ii(t,e,i){return Math.sqrt(ri(t,e,i,!0))}function ni(t,e,i,n,o){var s,r,a,h=n?ti:si(t,i),l=si(e,i);for(ti=l;;){if(!(h|l))return[t,e];if(h&l)return!1;a=si(r=oi(t,e,s=h||l,i,o),i),s===h?(t=r,h=a):(e=r,l=a)}}function oi(t,e,i,n,o){var s,r,a=e.x-t.x,e=e.y-t.y,h=n.min,n=n.max;return 8&i?(s=t.x+a*(n.y-t.y)/e,r=n.y):4&i?(s=t.x+a*(h.y-t.y)/e,r=h.y):2&i?(s=n.x,r=t.y+e*(n.x-t.x)/a):1&i&&(s=h.x,r=t.y+e*(h.x-t.x)/a),new p(s,r,o)}function si(t,e){var i=0;return t.x<e.min.x?i|=1:t.x>e.max.x&&(i|=2),t.y<e.min.y?i|=4:t.y>e.max.y&&(i|=8),i}function ri(t,e,i,n){var o=e.x,e=e.y,s=i.x-o,r=i.y-e,a=s*s+r*r;return 0<a&&(1<(a=((t.x-o)*s+(t.y-e)*r)/a)?(o=i.x,e=i.y):0<a&&(o+=s*a,e+=r*a)),s=t.x-o,r=t.y-e,n?s*s+r*r:new p(o,e)}function I(t){return!d(t[0])||"object"!=typeof t[0][0]&&void 0!==t[0][0]}function ai(t){return console.warn("Deprecated use of _flat, please use L.LineUtil.isFlat instead."),I(t)}function hi(t,e){var i,n,o,s,r,a;if(!t||0===t.length)throw new Error("latlngs not passed");I(t)||(console.warn("latlngs are not flat! Only the first ring will be used"),t=t[0]);for(var h=w([0,0]),l=g(t),u=(l.getNorthWest().distanceTo(l.getSouthWest())*l.getNorthEast().distanceTo(l.getNorthWest())<1700&&(h=Qe(t)),t.length),c=[],d=0;d<u;d++){var _=w(t[d]);c.push(e.project(w([_.lat-h.lat,_.lng-h.lng])))}for(i=d=0;d<u-1;d++)i+=c[d].distanceTo(c[d+1])/2;if(0===i)a=c[0];else for(n=d=0;d<u-1;d++)if(o=c[d],s=c[d+1],i<(n+=r=o.distanceTo(s))){a=[s.x-(r=(n-i)/r)*(s.x-o.x),s.y-r*(s.y-o.y)];break}l=e.unproject(m(a));return w([l.lat+h.lat,l.lng+h.lng])}var vt={__proto__:null,simplify:ei,pointToSegmentDistance:ii,closestPointOnSegment:function(t,e,i){return ri(t,e,i)},clipSegment:ni,_getEdgeIntersection:oi,_getBitCode:si,_sqClosestPointOnSegment:ri,isFlat:I,_flat:ai,polylineCenter:hi},yt={project:function(t){return new p(t.lng,t.lat)},unproject:function(t){return new v(t.y,t.x)},bounds:new f([-180,-90],[180,90])},xt={R:6378137,R_MINOR:6356752.314245179,bounds:new f([-20037508.34279,-15496570.73972],[20037508.34279,18764656.23138]),project:function(t){var e=Math.PI/180,i=this.R,n=t.lat*e,o=this.R_MINOR/i,o=Math.sqrt(1-o*o),s=o*Math.sin(n),s=Math.tan(Math.PI/4-n/2)/Math.pow((1-s)/(1+s),o/2),n=-i*Math.log(Math.max(s,1e-10));return new p(t.lng*e*i,n)},unproject:function(t){for(var e,i=180/Math.PI,n=this.R,o=this.R_MINOR/n,s=Math.sqrt(1-o*o),r=Math.exp(-t.y/n),a=Math.PI/2-2*Math.atan(r),h=0,l=.1;h<15&&1e-7<Math.abs(l);h++)e=s*Math.sin(a),e=Math.pow((1-e)/(1+e),s/2),a+=l=Math.PI/2-2*Math.atan(r*e)-a;return new v(a*i,t.x*i/n)}},wt={__proto__:null,LonLat:yt,Mercator:xt,SphericalMercator:rt},Pt=l({},st,{code:"EPSG:3395",projection:xt,transformation:ht(bt=.5/(Math.PI*xt.R),.5,-bt,.5)}),li=l({},st,{code:"EPSG:4326",projection:yt,transformation:ht(1/180,1,-1/180,.5)}),Lt=l({},ot,{projection:yt,transformation:ht(1,0,-1,0),scale:function(t){return Math.pow(2,t)},zoom:function(t){return Math.log(t)/Math.LN2},distance:function(t,e){var i=e.lng-t.lng,e=e.lat-t.lat;return Math.sqrt(i*i+e*e)},infinite:!0}),o=(ot.Earth=st,ot.EPSG3395=Pt,ot.EPSG3857=lt,ot.EPSG900913=ut,ot.EPSG4326=li,ot.Simple=Lt,it.extend({options:{pane:"overlayPane",attribution:null,bubblingMouseEvents:!0},addTo:function(t){return t.addLayer(this),this},remove:function(){return this.removeFrom(this._map||this._mapToAdd)},removeFrom:function(t){return t&&t.removeLayer(this),this},getPane:function(t){return this._map.getPane(t?this.options[t]||t:this.options.pane)},addInteractiveTarget:function(t){return this._map._targets[h(t)]=this},removeInteractiveTarget:function(t){return delete this._map._targets[h(t)],this},getAttribution:function(){return this.options.attribution},_layerAdd:function(t){var e,i=t.target;i.hasLayer(this)&&(this._map=i,this._zoomAnimated=i._zoomAnimated,this.getEvents&&(e=this.getEvents(),i.on(e,this),this.once("remove",function(){i.off(e,this)},this)),this.onAdd(i),this.fire("add"),i.fire("layeradd",{layer:this}))}})),ui=(A.include({addLayer:function(t){var e;if(t._layerAdd)return e=h(t),this._layers[e]||((this._layers[e]=t)._mapToAdd=this,t.beforeAdd&&t.beforeAdd(this),this.whenReady(t._layerAdd,t)),this;throw new Error("The provided object is not a Layer.")},removeLayer:function(t){var e=h(t);return this._layers[e]&&(this._loaded&&t.onRemove(this),delete this._layers[e],this._loaded&&(this.fire("layerremove",{layer:t}),t.fire("remove")),t._map=t._mapToAdd=null),this},hasLayer:function(t){return h(t)in this._layers},eachLayer:function(t,e){for(var i in this._layers)t.call(e,this._layers[i]);return this},_addLayers:function(t){for(var e=0,i=(t=t?d(t)?t:[t]:[]).length;e<i;e++)this.addLayer(t[e])},_addZoomLimit:function(t){isNaN(t.options.maxZoom)&&isNaN(t.options.minZoom)||(this._zoomBoundLayers[h(t)]=t,this._updateZoomLevels())},_removeZoomLimit:function(t){t=h(t);this._zoomBoundLayers[t]&&(delete this._zoomBoundLayers[t],this._updateZoomLevels())},_updateZoomLevels:function(){var t,e=1/0,i=-1/0,n=this._getZoomSpan();for(t in this._zoomBoundLayers)var o=this._zoomBoundLayers[t].options,e=void 0===o.minZoom?e:Math.min(e,o.minZoom),i=void 0===o.maxZoom?i:Math.max(i,o.maxZoom);this._layersMaxZoom=i===-1/0?void 0:i,this._layersMinZoom=e===1/0?void 0:e,n!==this._getZoomSpan()&&this.fire("zoomlevelschange"),void 0===this.options.maxZoom&&this._layersMaxZoom&&this.getZoom()>this._layersMaxZoom&&this.setZoom(this._layersMaxZoom),void 0===this.options.minZoom&&this._layersMinZoom&&this.getZoom()<this._layersMinZoom&&this.setZoom(this._layersMinZoom)}}),o.extend({initialize:function(t,e){var i,n;if(c(this,e),this._layers={},t)for(i=0,n=t.length;i<n;i++)this.addLayer(t[i])},addLayer:function(t){var e=this.getLayerId(t);return this._layers[e]=t,this._map&&this._map.addLayer(t),this},removeLayer:function(t){t=t in this._layers?t:this.getLayerId(t);return this._map&&this._layers[t]&&this._map.removeLayer(this._layers[t]),delete this._layers[t],this},hasLayer:function(t){return("number"==typeof t?t:this.getLayerId(t))in this._layers},clearLayers:function(){return this.eachLayer(this.removeLayer,this)},invoke:function(t){var e,i,n=Array.prototype.slice.call(arguments,1);for(e in this._layers)(i=this._layers[e])[t]&&i[t].apply(i,n);return this},onAdd:function(t){this.eachLayer(t.addLayer,t)},onRemove:function(t){this.eachLayer(t.removeLayer,t)},eachLayer:function(t,e){for(var i in this._layers)t.call(e,this._layers[i]);return this},getLayer:function(t){return this._layers[t]},getLayers:function(){var t=[];return this.eachLayer(t.push,t),t},setZIndex:function(t){return this.invoke("setZIndex",t)},getLayerId:h})),ci=ui.extend({addLayer:function(t){return this.hasLayer(t)?this:(t.addEventParent(this),ui.prototype.addLayer.call(this,t),this.fire("layeradd",{layer:t}))},removeLayer:function(t){return this.hasLayer(t)?((t=t in this._layers?this._layers[t]:t).removeEventParent(this),ui.prototype.removeLayer.call(this,t),this.fire("layerremove",{layer:t})):this},setStyle:function(t){return this.invoke("setStyle",t)},bringToFront:function(){return this.invoke("bringToFront")},bringToBack:function(){return this.invoke("bringToBack")},getBounds:function(){var t,e=new s;for(t in this._layers){var i=this._layers[t];e.extend(i.getBounds?i.getBounds():i.getLatLng())}return e}}),di=et.extend({options:{popupAnchor:[0,0],tooltipAnchor:[0,0],crossOrigin:!1},initialize:function(t){c(this,t)},createIcon:function(t){return this._createIcon("icon",t)},createShadow:function(t){return this._createIcon("shadow",t)},_createIcon:function(t,e){var i=this._getIconUrl(t);if(i)return i=this._createImg(i,e&&"IMG"===e.tagName?e:null),this._setIconStyles(i,t),!this.options.crossOrigin&&""!==this.options.crossOrigin||(i.crossOrigin=!0===this.options.crossOrigin?"":this.options.crossOrigin),i;if("icon"===t)throw new Error("iconUrl not set in Icon options (see the docs).");return null},_setIconStyles:function(t,e){var i=this.options,n=i[e+"Size"],n=m(n="number"==typeof n?[n,n]:n),o=m("shadow"===e&&i.shadowAnchor||i.iconAnchor||n&&n.divideBy(2,!0));t.className="leaflet-marker-"+e+" "+(i.className||""),o&&(t.style.marginLeft=-o.x+"px",t.style.marginTop=-o.y+"px"),n&&(t.style.width=n.x+"px",t.style.height=n.y+"px")},_createImg:function(t,e){return(e=e||document.createElement("img")).src=t,e},_getIconUrl:function(t){return b.retina&&this.options[t+"RetinaUrl"]||this.options[t+"Url"]}});var _i=di.extend({options:{iconUrl:"marker-icon.png",iconRetinaUrl:"marker-icon-2x.png",shadowUrl:"marker-shadow.png",iconSize:[25,41],iconAnchor:[12,41],popupAnchor:[1,-34],tooltipAnchor:[16,-28],shadowSize:[41,41]},_getIconUrl:function(t){return"string"!=typeof _i.imagePath&&(_i.imagePath=this._detectIconPath()),(this.options.imagePath||_i.imagePath)+di.prototype._getIconUrl.call(this,t)},_stripUrl:function(t){function e(t,e,i){return(e=e.exec(t))&&e[i]}return(t=e(t,/^url\\((['"])?(.+)\\1\\)$/,2))&&e(t,/^(.*)marker-icon\\.png$/,1)},_detectIconPath:function(){var t=P("div","leaflet-default-icon-path",document.body),e=pe(t,"background-image")||pe(t,"backgroundImage");return document.body.removeChild(t),(e=this._stripUrl(e))?e:(t=document.querySelector('link[href$="leaflet.css"]'))?t.href.substring(0,t.href.length-"leaflet.css".length-1):""}}),pi=n.extend({initialize:function(t){this._marker=t},addHooks:function(){var t=this._marker._icon;this._draggable||(this._draggable=new Xe(t,t,!0)),this._draggable.on({dragstart:this._onDragStart,predrag:this._onPreDrag,drag:this._onDrag,dragend:this._onDragEnd},this).enable(),M(t,"leaflet-marker-draggable")},removeHooks:function(){this._draggable.off({dragstart:this._onDragStart,predrag:this._onPreDrag,drag:this._onDrag,dragend:this._onDragEnd},this).disable(),this._marker._icon&&z(this._marker._icon,"leaflet-marker-draggable")},moved:function(){return this._draggable&&this._draggable._moved},_adjustPan:function(t){var e=this._marker,i=e._map,n=this._marker.options.autoPanSpeed,o=this._marker.options.autoPanPadding,s=Pe(e._icon),r=i.getPixelBounds(),a=i.getPixelOrigin(),a=_(r.min._subtract(a).add(o),r.max._subtract(a).subtract(o));a.contains(s)||(o=m((Math.max(a.max.x,s.x)-a.max.x)/(r.max.x-a.max.x)-(Math.min(a.min.x,s.x)-a.min.x)/(r.min.x-a.min.x),(Math.max(a.max.y,s.y)-a.max.y)/(r.max.y-a.max.y)-(Math.min(a.min.y,s.y)-a.min.y)/(r.min.y-a.min.y)).multiplyBy(n),i.panBy(o,{animate:!1}),this._draggable._newPos._add(o),this._draggable._startPos._add(o),Z(e._icon,this._draggable._newPos),this._onDrag(t),this._panRequest=x(this._adjustPan.bind(this,t)))},_onDragStart:function(){this._oldLatLng=this._marker.getLatLng(),this._marker.closePopup&&this._marker.closePopup(),this._marker.fire("movestart").fire("dragstart")},_onPreDrag:function(t){this._marker.options.autoPan&&(r(this._panRequest),this._panRequest=x(this._adjustPan.bind(this,t)))},_onDrag:function(t){var e=this._marker,i=e._shadow,n=Pe(e._icon),o=e._map.layerPointToLatLng(n);i&&Z(i,n),e._latlng=o,t.latlng=o,t.oldLatLng=this._oldLatLng,e.fire("move",t).fire("drag",t)},_onDragEnd:function(t){r(this._panRequest),delete this._oldLatLng,this._marker.fire("moveend").fire("dragend",t)}}),mi=o.extend({options:{icon:new _i,interactive:!0,keyboard:!0,title:"",alt:"Marker",zIndexOffset:0,opacity:1,riseOnHover:!1,riseOffset:250,pane:"markerPane",shadowPane:"shadowPane",bubblingMouseEvents:!1,autoPanOnFocus:!0,draggable:!1,autoPan:!1,autoPanPadding:[50,50],autoPanSpeed:10},initialize:function(t,e){c(this,e),this._latlng=w(t)},onAdd:function(t){this._zoomAnimated=this._zoomAnimated&&t.options.markerZoomAnimation,this._zoomAnimated&&t.on("zoomanim",this._animateZoom,this),this._initIcon(),this.update()},onRemove:function(t){this.dragging&&this.dragging.enabled()&&(this.options.draggable=!0,this.dragging.removeHooks()),delete this.dragging,this._zoomAnimated&&t.off("zoomanim",this._animateZoom,this),this._removeIcon(),this._removeShadow()},getEvents:function(){return{zoom:this.update,viewreset:this.update}},getLatLng:function(){return this._latlng},setLatLng:function(t){var e=this._latlng;return this._latlng=w(t),this.update(),this.fire("move",{oldLatLng:e,latlng:this._latlng})},setZIndexOffset:function(t){return this.options.zIndexOffset=t,this.update()},getIcon:function(){return this.options.icon},setIcon:function(t){return this.options.icon=t,this._map&&(this._initIcon(),this.update()),this._popup&&this.bindPopup(this._popup,this._popup.options),this},getElement:function(){return this._icon},update:function(){var t;return this._icon&&this._map&&(t=this._map.latLngToLayerPoint(this._latlng).round(),this._setPos(t)),this},_initIcon:function(){var t=this.options,e="leaflet-zoom-"+(this._zoomAnimated?"animated":"hide"),i=t.icon.createIcon(this._icon),n=!1,i=(i!==this._icon&&(this._icon&&this._removeIcon(),n=!0,t.title&&(i.title=t.title),"IMG"===i.tagName&&(i.alt=t.alt||"")),M(i,e),t.keyboard&&(i.tabIndex="0",i.setAttribute("role","button")),this._icon=i,t.riseOnHover&&this.on({mouseover:this._bringToFront,mouseout:this._resetZIndex}),this.options.autoPanOnFocus&&S(i,"focus",this._panOnFocus,this),t.icon.createShadow(this._shadow)),o=!1;i!==this._shadow&&(this._removeShadow(),o=!0),i&&(M(i,e),i.alt=""),this._shadow=i,t.opacity<1&&this._updateOpacity(),n&&this.getPane().appendChild(this._icon),this._initInteraction(),i&&o&&this.getPane(t.shadowPane).appendChild(this._shadow)},_removeIcon:function(){this.options.riseOnHover&&this.off({mouseover:this._bringToFront,mouseout:this._resetZIndex}),this.options.autoPanOnFocus&&k(this._icon,"focus",this._panOnFocus,this),T(this._icon),this.removeInteractiveTarget(this._icon),this._icon=null},_removeShadow:function(){this._shadow&&T(this._shadow),this._shadow=null},_setPos:function(t){this._icon&&Z(this._icon,t),this._shadow&&Z(this._shadow,t),this._zIndex=t.y+this.options.zIndexOffset,this._resetZIndex()},_updateZIndex:function(t){this._icon&&(this._icon.style.zIndex=this._zIndex+t)},_animateZoom:function(t){t=this._map._latLngToNewLayerPoint(this._latlng,t.zoom,t.center).round();this._setPos(t)},_initInteraction:function(){var t;this.options.interactive&&(M(this._icon,"leaflet-interactive"),this.addInteractiveTarget(this._icon),pi&&(t=this.options.draggable,this.dragging&&(t=this.dragging.enabled(),this.dragging.disable()),this.dragging=new pi(this),t&&this.dragging.enable()))},setOpacity:function(t){return this.options.opacity=t,this._map&&this._updateOpacity(),this},_updateOpacity:function(){var t=this.options.opacity;this._icon&&C(this._icon,t),this._shadow&&C(this._shadow,t)},_bringToFront:function(){this._updateZIndex(this.options.riseOffset)},_resetZIndex:function(){this._updateZIndex(0)},_panOnFocus:function(){var t,e,i=this._map;i&&(t=(e=this.options.icon.options).iconSize?m(e.iconSize):m(0,0),e=e.iconAnchor?m(e.iconAnchor):m(0,0),i.panInside(this._latlng,{paddingTopLeft:e,paddingBottomRight:t.subtract(e)}))},_getPopupAnchor:function(){return this.options.icon.options.popupAnchor},_getTooltipAnchor:function(){return this.options.icon.options.tooltipAnchor}});var fi=o.extend({options:{stroke:!0,color:"#3388ff",weight:3,opacity:1,lineCap:"round",lineJoin:"round",dashArray:null,dashOffset:null,fill:!1,fillColor:null,fillOpacity:.2,fillRule:"evenodd",interactive:!0,bubblingMouseEvents:!0},beforeAdd:function(t){this._renderer=t.getRenderer(this)},onAdd:function(){this._renderer._initPath(this),this._reset(),this._renderer._addPath(this)},onRemove:function(){this._renderer._removePath(this)},redraw:function(){return this._map&&this._renderer._updatePath(this),this},setStyle:function(t){return c(this,t),this._renderer&&(this._renderer._updateStyle(this),this.options.stroke&&t&&Object.prototype.hasOwnProperty.call(t,"weight")&&this._updateBounds()),this},bringToFront:function(){return this._renderer&&this._renderer._bringToFront(this),this},bringToBack:function(){return this._renderer&&this._renderer._bringToBack(this),this},getElement:function(){return this._path},_reset:function(){this._project(),this._update()},_clickTolerance:function(){return(this.options.stroke?this.options.weight/2:0)+(this._renderer.options.tolerance||0)}}),gi=fi.extend({options:{fill:!0,radius:10},initialize:function(t,e){c(this,e),this._latlng=w(t),this._radius=this.options.radius},setLatLng:function(t){var e=this._latlng;return this._latlng=w(t),this.redraw(),this.fire("move",{oldLatLng:e,latlng:this._latlng})},getLatLng:function(){return this._latlng},setRadius:function(t){return this.options.radius=this._radius=t,this.redraw()},getRadius:function(){return this._radius},setStyle:function(t){var e=t&&t.radius||this._radius;return fi.prototype.setStyle.call(this,t),this.setRadius(e),this},_project:function(){this._point=this._map.latLngToLayerPoint(this._latlng),this._updateBounds()},_updateBounds:function(){var t=this._radius,e=this._radiusY||t,i=this._clickTolerance(),t=[t+i,e+i];this._pxBounds=new f(this._point.subtract(t),this._point.add(t))},_update:function(){this._map&&this._updatePath()},_updatePath:function(){this._renderer._updateCircle(this)},_empty:function(){return this._radius&&!this._renderer._bounds.intersects(this._pxBounds)},_containsPoint:function(t){return t.distanceTo(this._point)<=this._radius+this._clickTolerance()}});var vi=gi.extend({initialize:function(t,e,i){if(c(this,e="number"==typeof e?l({},i,{radius:e}):e),this._latlng=w(t),isNaN(this.options.radius))throw new Error("Circle radius cannot be NaN");this._mRadius=this.options.radius},setRadius:function(t){return this._mRadius=t,this.redraw()},getRadius:function(){return this._mRadius},getBounds:function(){var t=[this._radius,this._radiusY||this._radius];return new s(this._map.layerPointToLatLng(this._point.subtract(t)),this._map.layerPointToLatLng(this._point.add(t)))},setStyle:fi.prototype.setStyle,_project:function(){var t,e,i,n,o,s=this._latlng.lng,r=this._latlng.lat,a=this._map,h=a.options.crs;h.distance===st.distance?(n=Math.PI/180,o=this._mRadius/st.R/n,t=a.project([r+o,s]),e=a.project([r-o,s]),e=t.add(e).divideBy(2),i=a.unproject(e).lat,n=Math.acos((Math.cos(o*n)-Math.sin(r*n)*Math.sin(i*n))/(Math.cos(r*n)*Math.cos(i*n)))/n,!isNaN(n)&&0!==n||(n=o/Math.cos(Math.PI/180*r)),this._point=e.subtract(a.getPixelOrigin()),this._radius=isNaN(n)?0:e.x-a.project([i,s-n]).x,this._radiusY=e.y-t.y):(o=h.unproject(h.project(this._latlng).subtract([this._mRadius,0])),this._point=a.latLngToLayerPoint(this._latlng),this._radius=this._point.x-a.latLngToLayerPoint(o).x),this._updateBounds()}});var yi=fi.extend({options:{smoothFactor:1,noClip:!1},initialize:function(t,e){c(this,e),this._setLatLngs(t)},getLatLngs:function(){return this._latlngs},setLatLngs:function(t){return this._setLatLngs(t),this.redraw()},isEmpty:function(){return!this._latlngs.length},closestLayerPoint:function(t){for(var e=1/0,i=null,n=ri,o=0,s=this._parts.length;o<s;o++)for(var r=this._parts[o],a=1,h=r.length;a<h;a++){var l,u,c=n(t,l=r[a-1],u=r[a],!0);c<e&&(e=c,i=n(t,l,u))}return i&&(i.distance=Math.sqrt(e)),i},getCenter:function(){if(this._map)return hi(this._defaultShape(),this._map.options.crs);throw new Error("Must add layer to map before using getCenter()")},getBounds:function(){return this._bounds},addLatLng:function(t,e){return e=e||this._defaultShape(),t=w(t),e.push(t),this._bounds.extend(t),this.redraw()},_setLatLngs:function(t){this._bounds=new s,this._latlngs=this._convertLatLngs(t)},_defaultShape:function(){return I(this._latlngs)?this._latlngs:this._latlngs[0]},_convertLatLngs:function(t){for(var e=[],i=I(t),n=0,o=t.length;n<o;n++)i?(e[n]=w(t[n]),this._bounds.extend(e[n])):e[n]=this._convertLatLngs(t[n]);return e},_project:function(){var t=new f;this._rings=[],this._projectLatlngs(this._latlngs,this._rings,t),this._bounds.isValid()&&t.isValid()&&(this._rawPxBounds=t,this._updateBounds())},_updateBounds:function(){var t=this._clickTolerance(),t=new p(t,t);this._rawPxBounds&&(this._pxBounds=new f([this._rawPxBounds.min.subtract(t),this._rawPxBounds.max.add(t)]))},_projectLatlngs:function(t,e,i){var n,o,s=t[0]instanceof v,r=t.length;if(s){for(o=[],n=0;n<r;n++)o[n]=this._map.latLngToLayerPoint(t[n]),i.extend(o[n]);e.push(o)}else for(n=0;n<r;n++)this._projectLatlngs(t[n],e,i)},_clipPoints:function(){var t=this._renderer._bounds;if(this._parts=[],this._pxBounds&&this._pxBounds.intersects(t))if(this.options.noClip)this._parts=this._rings;else for(var e,i,n,o,s=this._parts,r=0,a=0,h=this._rings.length;r<h;r++)for(e=0,i=(o=this._rings[r]).length;e<i-1;e++)(n=ni(o[e],o[e+1],t,e,!0))&&(s[a]=s[a]||[],s[a].push(n[0]),n[1]===o[e+1]&&e!==i-2||(s[a].push(n[1]),a++))},_simplifyPoints:function(){for(var t=this._parts,e=this.options.smoothFactor,i=0,n=t.length;i<n;i++)t[i]=ei(t[i],e)},_update:function(){this._map&&(this._clipPoints(),this._simplifyPoints(),this._updatePath())},_updatePath:function(){this._renderer._updatePoly(this)},_containsPoint:function(t,e){var i,n,o,s,r,a,h=this._clickTolerance();if(this._pxBounds&&this._pxBounds.contains(t))for(i=0,s=this._parts.length;i<s;i++)for(n=0,o=(r=(a=this._parts[i]).length)-1;n<r;o=n++)if((e||0!==n)&&ii(t,a[o],a[n])<=h)return!0;return!1}});yi._flat=ai;var xi=yi.extend({options:{fill:!0},isEmpty:function(){return!this._latlngs.length||!this._latlngs[0].length},getCenter:function(){if(this._map)return $e(this._defaultShape(),this._map.options.crs);throw new Error("Must add layer to map before using getCenter()")},_convertLatLngs:function(t){var t=yi.prototype._convertLatLngs.call(this,t),e=t.length;return 2<=e&&t[0]instanceof v&&t[0].equals(t[e-1])&&t.pop(),t},_setLatLngs:function(t){yi.prototype._setLatLngs.call(this,t),I(this._latlngs)&&(this._latlngs=[this._latlngs])},_defaultShape:function(){return(I(this._latlngs[0])?this._latlngs:this._latlngs[0])[0]},_clipPoints:function(){var t=this._renderer._bounds,e=this.options.weight,e=new p(e,e),t=new f(t.min.subtract(e),t.max.add(e));if(this._parts=[],this._pxBounds&&this._pxBounds.intersects(t))if(this.options.noClip)this._parts=this._rings;else for(var i,n=0,o=this._rings.length;n<o;n++)(i=Je(this._rings[n],t,!0)).length&&this._parts.push(i)},_updatePath:function(){this._renderer._updatePoly(this,!0)},_containsPoint:function(t){var e,i,n,o,s,r,a,h,l=!1;if(!this._pxBounds||!this._pxBounds.contains(t))return!1;for(o=0,a=this._parts.length;o<a;o++)for(s=0,r=(h=(e=this._parts[o]).length)-1;s<h;r=s++)i=e[s],n=e[r],i.y>t.y!=n.y>t.y&&t.x<(n.x-i.x)*(t.y-i.y)/(n.y-i.y)+i.x&&(l=!l);return l||yi.prototype._containsPoint.call(this,t,!0)}});var wi=ci.extend({initialize:function(t,e){c(this,e),this._layers={},t&&this.addData(t)},addData:function(t){var e,i,n,o=d(t)?t:t.features;if(o){for(e=0,i=o.length;e<i;e++)((n=o[e]).geometries||n.geometry||n.features||n.coordinates)&&this.addData(n);return this}var s,r=this.options;return(!r.filter||r.filter(t))&&(s=bi(t,r))?(s.feature=Zi(t),s.defaultOptions=s.options,this.resetStyle(s),r.onEachFeature&&r.onEachFeature(t,s),this.addLayer(s)):this},resetStyle:function(t){return void 0===t?this.eachLayer(this.resetStyle,this):(t.options=l({},t.defaultOptions),this._setLayerStyle(t,this.options.style),this)},setStyle:function(e){return this.eachLayer(function(t){this._setLayerStyle(t,e)},this)},_setLayerStyle:function(t,e){t.setStyle&&("function"==typeof e&&(e=e(t.feature)),t.setStyle(e))}});function bi(t,e){var i,n,o,s,r="Feature"===t.type?t.geometry:t,a=r?r.coordinates:null,h=[],l=e&&e.pointToLayer,u=e&&e.coordsToLatLng||Li;if(!a&&!r)return null;switch(r.type){case"Point":return Pi(l,t,i=u(a),e);case"MultiPoint":for(o=0,s=a.length;o<s;o++)i=u(a[o]),h.push(Pi(l,t,i,e));return new ci(h);case"LineString":case"MultiLineString":return n=Ti(a,"LineString"===r.type?0:1,u),new yi(n,e);case"Polygon":case"MultiPolygon":return n=Ti(a,"Polygon"===r.type?1:2,u),new xi(n,e);case"GeometryCollection":for(o=0,s=r.geometries.length;o<s;o++){var c=bi({geometry:r.geometries[o],type:"Feature",properties:t.properties},e);c&&h.push(c)}return new ci(h);case"FeatureCollection":for(o=0,s=r.features.length;o<s;o++){var d=bi(r.features[o],e);d&&h.push(d)}return new ci(h);default:throw new Error("Invalid GeoJSON object.")}}function Pi(t,e,i,n){return t?t(e,i):new mi(i,n&&n.markersInheritOptions&&n)}function Li(t){return new v(t[1],t[0],t[2])}function Ti(t,e,i){for(var n,o=[],s=0,r=t.length;s<r;s++)n=e?Ti(t[s],e-1,i):(i||Li)(t[s]),o.push(n);return o}function Mi(t,e){return void 0!==(t=w(t)).alt?[i(t.lng,e),i(t.lat,e),i(t.alt,e)]:[i(t.lng,e),i(t.lat,e)]}function zi(t,e,i,n){for(var o=[],s=0,r=t.length;s<r;s++)o.push(e?zi(t[s],I(t[s])?0:e-1,i,n):Mi(t[s],n));return!e&&i&&0<o.length&&o.push(o[0].slice()),o}function Ci(t,e){return t.feature?l({},t.feature,{geometry:e}):Zi(e)}function Zi(t){return"Feature"===t.type||"FeatureCollection"===t.type?t:{type:"Feature",properties:{},geometry:t}}Tt={toGeoJSON:function(t){return Ci(this,{type:"Point",coordinates:Mi(this.getLatLng(),t)})}};function Si(t,e){return new wi(t,e)}mi.include(Tt),vi.include(Tt),gi.include(Tt),yi.include({toGeoJSON:function(t){var e=!I(this._latlngs);return Ci(this,{type:(e?"Multi":"")+"LineString",coordinates:zi(this._latlngs,e?1:0,!1,t)})}}),xi.include({toGeoJSON:function(t){var e=!I(this._latlngs),i=e&&!I(this._latlngs[0]),t=zi(this._latlngs,i?2:e?1:0,!0,t);return Ci(this,{type:(i?"Multi":"")+"Polygon",coordinates:t=e?t:[t]})}}),ui.include({toMultiPoint:function(e){var i=[];return this.eachLayer(function(t){i.push(t.toGeoJSON(e).geometry.coordinates)}),Ci(this,{type:"MultiPoint",coordinates:i})},toGeoJSON:function(e){var i,n,t=this.feature&&this.feature.geometry&&this.feature.geometry.type;return"MultiPoint"===t?this.toMultiPoint(e):(i="GeometryCollection"===t,n=[],this.eachLayer(function(t){t.toGeoJSON&&(t=t.toGeoJSON(e),i?n.push(t.geometry):"FeatureCollection"===(t=Zi(t)).type?n.push.apply(n,t.features):n.push(t))}),i?Ci(this,{geometries:n,type:"GeometryCollection"}):{type:"FeatureCollection",features:n})}});var Mt=Si,Ei=o.extend({options:{opacity:1,alt:"",interactive:!1,crossOrigin:!1,errorOverlayUrl:"",zIndex:1,className:""},initialize:function(t,e,i){this._url=t,this._bounds=g(e),c(this,i)},onAdd:function(){this._image||(this._initImage(),this.options.opacity<1&&this._updateOpacity()),this.options.interactive&&(M(this._image,"leaflet-interactive"),this.addInteractiveTarget(this._image)),this.getPane().appendChild(this._image),this._reset()},onRemove:function(){T(this._image),this.options.interactive&&this.removeInteractiveTarget(this._image)},setOpacity:function(t){return this.options.opacity=t,this._image&&this._updateOpacity(),this},setStyle:function(t){return t.opacity&&this.setOpacity(t.opacity),this},bringToFront:function(){return this._map&&fe(this._image),this},bringToBack:function(){return this._map&&ge(this._image),this},setUrl:function(t){return this._url=t,this._image&&(this._image.src=t),this},setBounds:function(t){return this._bounds=g(t),this._map&&this._reset(),this},getEvents:function(){var t={zoom:this._reset,viewreset:this._reset};return this._zoomAnimated&&(t.zoomanim=this._animateZoom),t},setZIndex:function(t){return this.options.zIndex=t,this._updateZIndex(),this},getBounds:function(){return this._bounds},getElement:function(){return this._image},_initImage:function(){var t="IMG"===this._url.tagName,e=this._image=t?this._url:P("img");M(e,"leaflet-image-layer"),this._zoomAnimated&&M(e,"leaflet-zoom-animated"),this.options.className&&M(e,this.options.className),e.onselectstart=u,e.onmousemove=u,e.onload=a(this.fire,this,"load"),e.onerror=a(this._overlayOnError,this,"error"),!this.options.crossOrigin&&""!==this.options.crossOrigin||(e.crossOrigin=!0===this.options.crossOrigin?"":this.options.crossOrigin),this.options.zIndex&&this._updateZIndex(),t?this._url=e.src:(e.src=this._url,e.alt=this.options.alt)},_animateZoom:function(t){var e=this._map.getZoomScale(t.zoom),t=this._map._latLngBoundsToNewLayerBounds(this._bounds,t.zoom,t.center).min;be(this._image,t,e)},_reset:function(){var t=this._image,e=new f(this._map.latLngToLayerPoint(this._bounds.getNorthWest()),this._map.latLngToLayerPoint(this._bounds.getSouthEast())),i=e.getSize();Z(t,e.min),t.style.width=i.x+"px",t.style.height=i.y+"px"},_updateOpacity:function(){C(this._image,this.options.opacity)},_updateZIndex:function(){this._image&&void 0!==this.options.zIndex&&null!==this.options.zIndex&&(this._image.style.zIndex=this.options.zIndex)},_overlayOnError:function(){this.fire("error");var t=this.options.errorOverlayUrl;t&&this._url!==t&&(this._url=t,this._image.src=t)},getCenter:function(){return this._bounds.getCenter()}}),ki=Ei.extend({options:{autoplay:!0,loop:!0,keepAspectRatio:!0,muted:!1,playsInline:!0},_initImage:function(){var t="VIDEO"===this._url.tagName,e=this._image=t?this._url:P("video");if(M(e,"leaflet-image-layer"),this._zoomAnimated&&M(e,"leaflet-zoom-animated"),this.options.className&&M(e,this.options.className),e.onselectstart=u,e.onmousemove=u,e.onloadeddata=a(this.fire,this,"load"),t){for(var i=e.getElementsByTagName("source"),n=[],o=0;o<i.length;o++)n.push(i[o].src);this._url=0<i.length?n:[e.src]}else{d(this._url)||(this._url=[this._url]),!this.options.keepAspectRatio&&Object.prototype.hasOwnProperty.call(e.style,"objectFit")&&(e.style.objectFit="fill"),e.autoplay=!!this.options.autoplay,e.loop=!!this.options.loop,e.muted=!!this.options.muted,e.playsInline=!!this.options.playsInline;for(var s=0;s<this._url.length;s++){var r=P("source");r.src=this._url[s],e.appendChild(r)}}}});var Oi=Ei.extend({_initImage:function(){var t=this._image=this._url;M(t,"leaflet-image-layer"),this._zoomAnimated&&M(t,"leaflet-zoom-animated"),this.options.className&&M(t,this.options.className),t.onselectstart=u,t.onmousemove=u}});var Ai=o.extend({options:{interactive:!1,offset:[0,0],className:"",pane:void 0,content:""},initialize:function(t,e){t&&(t instanceof v||d(t))?(this._latlng=w(t),c(this,e)):(c(this,t),this._source=e),this.options.content&&(this._content=this.options.content)},openOn:function(t){return(t=arguments.length?t:this._source._map).hasLayer(this)||t.addLayer(this),this},close:function(){return this._map&&this._map.removeLayer(this),this},toggle:function(t){return this._map?this.close():(arguments.length?this._source=t:t=this._source,this._prepareOpen(),this.openOn(t._map)),this},onAdd:function(t){this._zoomAnimated=t._zoomAnimated,this._container||this._initLayout(),t._fadeAnimated&&C(this._container,0),clearTimeout(this._removeTimeout),this.getPane().appendChild(this._container),this.update(),t._fadeAnimated&&C(this._container,1),this.bringToFront(),this.options.interactive&&(M(this._container,"leaflet-interactive"),this.addInteractiveTarget(this._container))},onRemove:function(t){t._fadeAnimated?(C(this._container,0),this._removeTimeout=setTimeout(a(T,void 0,this._container),200)):T(this._container),this.options.interactive&&(z(this._container,"leaflet-interactive"),this.removeInteractiveTarget(this._container))},getLatLng:function(){return this._latlng},setLatLng:function(t){return this._latlng=w(t),this._map&&(this._updatePosition(),this._adjustPan()),this},getContent:function(){return this._content},setContent:function(t){return this._content=t,this.update(),this},getElement:function(){return this._container},update:function(){this._map&&(this._container.style.visibility="hidden",this._updateContent(),this._updateLayout(),this._updatePosition(),this._container.style.visibility="",this._adjustPan())},getEvents:function(){var t={zoom:this._updatePosition,viewreset:this._updatePosition};return this._zoomAnimated&&(t.zoomanim=this._animateZoom),t},isOpen:function(){return!!this._map&&this._map.hasLayer(this)},bringToFront:function(){return this._map&&fe(this._container),this},bringToBack:function(){return this._map&&ge(this._container),this},_prepareOpen:function(t){if(!(i=this._source)._map)return!1;if(i instanceof ci){var e,i=null,n=this._source._layers;for(e in n)if(n[e]._map){i=n[e];break}if(!i)return!1;this._source=i}if(!t)if(i.getCenter)t=i.getCenter();else if(i.getLatLng)t=i.getLatLng();else{if(!i.getBounds)throw new Error("Unable to get source layer LatLng.");t=i.getBounds().getCenter()}return this.setLatLng(t),this._map&&this.update(),!0},_updateContent:function(){if(this._content){var t=this._contentNode,e="function"==typeof this._content?this._content(this._source||this):this._content;if("string"==typeof e)t.innerHTML=e;else{for(;t.hasChildNodes();)t.removeChild(t.firstChild);t.appendChild(e)}this.fire("contentupdate")}},_updatePosition:function(){var t,e,i;this._map&&(e=this._map.latLngToLayerPoint(this._latlng),t=m(this.options.offset),i=this._getAnchor(),this._zoomAnimated?Z(this._container,e.add(i)):t=t.add(e).add(i),e=this._containerBottom=-t.y,i=this._containerLeft=-Math.round(this._containerWidth/2)+t.x,this._container.style.bottom=e+"px",this._container.style.left=i+"px")},_getAnchor:function(){return[0,0]}}),Bi=(A.include({_initOverlay:function(t,e,i,n){var o=e;return o instanceof t||(o=new t(n).setContent(e)),i&&o.setLatLng(i),o}}),o.include({_initOverlay:function(t,e,i,n){var o=i;return o instanceof t?(c(o,n),o._source=this):(o=e&&!n?e:new t(n,this)).setContent(i),o}}),Ai.extend({options:{pane:"popupPane",offset:[0,7],maxWidth:300,minWidth:50,maxHeight:null,autoPan:!0,autoPanPaddingTopLeft:null,autoPanPaddingBottomRight:null,autoPanPadding:[5,5],keepInView:!1,closeButton:!0,autoClose:!0,closeOnEscapeKey:!0,className:""},openOn:function(t){return!(t=arguments.length?t:this._source._map).hasLayer(this)&&t._popup&&t._popup.options.autoClose&&t.removeLayer(t._popup),t._popup=this,Ai.prototype.openOn.call(this,t)},onAdd:function(t){Ai.prototype.onAdd.call(this,t),t.fire("popupopen",{popup:this}),this._source&&(this._source.fire("popupopen",{popup:this},!0),this._source instanceof fi||this._source.on("preclick",Ae))},onRemove:function(t){Ai.prototype.onRemove.call(this,t),t.fire("popupclose",{popup:this}),this._source&&(this._source.fire("popupclose",{popup:this},!0),this._source instanceof fi||this._source.off("preclick",Ae))},getEvents:function(){var t=Ai.prototype.getEvents.call(this);return(void 0!==this.options.closeOnClick?this.options.closeOnClick:this._map.options.closePopupOnClick)&&(t.preclick=this.close),this.options.keepInView&&(t.moveend=this._adjustPan),t},_initLayout:function(){var t="leaflet-popup",e=this._container=P("div",t+" "+(this.options.className||"")+" leaflet-zoom-animated"),i=this._wrapper=P("div",t+"-content-wrapper",e);this._contentNode=P("div",t+"-content",i),Ie(e),Be(this._contentNode),S(e,"contextmenu",Ae),this._tipContainer=P("div",t+"-tip-container",e),this._tip=P("div",t+"-tip",this._tipContainer),this.options.closeButton&&((i=this._closeButton=P("a",t+"-close-button",e)).setAttribute("role","button"),i.setAttribute("aria-label","Close popup"),i.href="#close",i.innerHTML='<span aria-hidden="true">&#215;</span>',S(i,"click",function(t){O(t),this.close()},this))},_updateLayout:function(){var t=this._contentNode,e=t.style,i=(e.width="",e.whiteSpace="nowrap",t.offsetWidth),i=Math.min(i,this.options.maxWidth),i=(i=Math.max(i,this.options.minWidth),e.width=i+1+"px",e.whiteSpace="",e.height="",t.offsetHeight),n=this.options.maxHeight,o="leaflet-popup-scrolled";(n&&n<i?(e.height=n+"px",M):z)(t,o),this._containerWidth=this._container.offsetWidth},_animateZoom:function(t){var t=this._map._latLngToNewLayerPoint(this._latlng,t.zoom,t.center),e=this._getAnchor();Z(this._container,t.add(e))},_adjustPan:function(){var t,e,i,n,o,s,r,a;this.options.autoPan&&(this._map._panAnim&&this._map._panAnim.stop(),this._autopanning?this._autopanning=!1:(t=this._map,e=parseInt(pe(this._container,"marginBottom"),10)||0,e=this._container.offsetHeight+e,a=this._containerWidth,(i=new p(this._containerLeft,-e-this._containerBottom))._add(Pe(this._container)),i=t.layerPointToContainerPoint(i),o=m(this.options.autoPanPadding),n=m(this.options.autoPanPaddingTopLeft||o),o=m(this.options.autoPanPaddingBottomRight||o),s=t.getSize(),r=0,i.x+a+o.x>s.x&&(r=i.x+a-s.x+o.x),i.x-r-n.x<(a=0)&&(r=i.x-n.x),i.y+e+o.y>s.y&&(a=i.y+e-s.y+o.y),i.y-a-n.y<0&&(a=i.y-n.y),(r||a)&&(this.options.keepInView&&(this._autopanning=!0),t.fire("autopanstart").panBy([r,a]))))},_getAnchor:function(){return m(this._source&&this._source._getPopupAnchor?this._source._getPopupAnchor():[0,0])}})),Ii=(A.mergeOptions({closePopupOnClick:!0}),A.include({openPopup:function(t,e,i){return this._initOverlay(Bi,t,e,i).openOn(this),this},closePopup:function(t){return(t=arguments.length?t:this._popup)&&t.close(),this}}),o.include({bindPopup:function(t,e){return this._popup=this._initOverlay(Bi,this._popup,t,e),this._popupHandlersAdded||(this.on({click:this._openPopup,keypress:this._onKeyPress,remove:this.closePopup,move:this._movePopup}),this._popupHandlersAdded=!0),this},unbindPopup:function(){return this._popup&&(this.off({click:this._openPopup,keypress:this._onKeyPress,remove:this.closePopup,move:this._movePopup}),this._popupHandlersAdded=!1,this._popup=null),this},openPopup:function(t){return this._popup&&(this instanceof ci||(this._popup._source=this),this._popup._prepareOpen(t||this._latlng)&&this._popup.openOn(this._map)),this},closePopup:function(){return this._popup&&this._popup.close(),this},togglePopup:function(){return this._popup&&this._popup.toggle(this),this},isPopupOpen:function(){return!!this._popup&&this._popup.isOpen()},setPopupContent:function(t){return this._popup&&this._popup.setContent(t),this},getPopup:function(){return this._popup},_openPopup:function(t){var e;this._popup&&this._map&&(Re(t),e=t.layer||t.target,this._popup._source!==e||e instanceof fi?(this._popup._source=e,this.openPopup(t.latlng)):this._map.hasLayer(this._popup)?this.closePopup():this.openPopup(t.latlng))},_movePopup:function(t){this._popup.setLatLng(t.latlng)},_onKeyPress:function(t){13===t.originalEvent.keyCode&&this._openPopup(t)}}),Ai.extend({options:{pane:"tooltipPane",offset:[0,0],direction:"auto",permanent:!1,sticky:!1,opacity:.9},onAdd:function(t){Ai.prototype.onAdd.call(this,t),this.setOpacity(this.options.opacity),t.fire("tooltipopen",{tooltip:this}),this._source&&(this.addEventParent(this._source),this._source.fire("tooltipopen",{tooltip:this},!0))},onRemove:function(t){Ai.prototype.onRemove.call(this,t),t.fire("tooltipclose",{tooltip:this}),this._source&&(this.removeEventParent(this._source),this._source.fire("tooltipclose",{tooltip:this},!0))},getEvents:function(){var t=Ai.prototype.getEvents.call(this);return this.options.permanent||(t.preclick=this.close),t},_initLayout:function(){var t="leaflet-tooltip "+(this.options.className||"")+" leaflet-zoom-"+(this._zoomAnimated?"animated":"hide");this._contentNode=this._container=P("div",t),this._container.setAttribute("role","tooltip"),this._container.setAttribute("id","leaflet-tooltip-"+h(this))},_updateLayout:function(){},_adjustPan:function(){},_setPosition:function(t){var e,i=this._map,n=this._container,o=i.latLngToContainerPoint(i.getCenter()),i=i.layerPointToContainerPoint(t),s=this.options.direction,r=n.offsetWidth,a=n.offsetHeight,h=m(this.options.offset),l=this._getAnchor(),i="top"===s?(e=r/2,a):"bottom"===s?(e=r/2,0):(e="center"===s?r/2:"right"===s?0:"left"===s?r:i.x<o.x?(s="right",0):(s="left",r+2*(h.x+l.x)),a/2);t=t.subtract(m(e,i,!0)).add(h).add(l),z(n,"leaflet-tooltip-right"),z(n,"leaflet-tooltip-left"),z(n,"leaflet-tooltip-top"),z(n,"leaflet-tooltip-bottom"),M(n,"leaflet-tooltip-"+s),Z(n,t)},_updatePosition:function(){var t=this._map.latLngToLayerPoint(this._latlng);this._setPosition(t)},setOpacity:function(t){this.options.opacity=t,this._container&&C(this._container,t)},_animateZoom:function(t){t=this._map._latLngToNewLayerPoint(this._latlng,t.zoom,t.center);this._setPosition(t)},_getAnchor:function(){return m(this._source&&this._source._getTooltipAnchor&&!this.options.sticky?this._source._getTooltipAnchor():[0,0])}})),Ri=(A.include({openTooltip:function(t,e,i){return this._initOverlay(Ii,t,e,i).openOn(this),this},closeTooltip:function(t){return t.close(),this}}),o.include({bindTooltip:function(t,e){return this._tooltip&&this.isTooltipOpen()&&this.unbindTooltip(),this._tooltip=this._initOverlay(Ii,this._tooltip,t,e),this._initTooltipInteractions(),this._tooltip.options.permanent&&this._map&&this._map.hasLayer(this)&&this.openTooltip(),this},unbindTooltip:function(){return this._tooltip&&(this._initTooltipInteractions(!0),this.closeTooltip(),this._tooltip=null),this},_initTooltipInteractions:function(t){var e,i;!t&&this._tooltipHandlersAdded||(e=t?"off":"on",i={remove:this.closeTooltip,move:this._moveTooltip},this._tooltip.options.permanent?i.add=this._openTooltip:(i.mouseover=this._openTooltip,i.mouseout=this.closeTooltip,i.click=this._openTooltip,this._map?this._addFocusListeners():i.add=this._addFocusListeners),this._tooltip.options.sticky&&(i.mousemove=this._moveTooltip),this[e](i),this._tooltipHandlersAdded=!t)},openTooltip:function(t){return this._tooltip&&(this instanceof ci||(this._tooltip._source=this),this._tooltip._prepareOpen(t)&&(this._tooltip.openOn(this._map),this.getElement?this._setAriaDescribedByOnLayer(this):this.eachLayer&&this.eachLayer(this._setAriaDescribedByOnLayer,this))),this},closeTooltip:function(){if(this._tooltip)return this._tooltip.close()},toggleTooltip:function(){return this._tooltip&&this._tooltip.toggle(this),this},isTooltipOpen:function(){return this._tooltip.isOpen()},setTooltipContent:function(t){return this._tooltip&&this._tooltip.setContent(t),this},getTooltip:function(){return this._tooltip},_addFocusListeners:function(){this.getElement?this._addFocusListenersOnLayer(this):this.eachLayer&&this.eachLayer(this._addFocusListenersOnLayer,this)},_addFocusListenersOnLayer:function(t){var e="function"==typeof t.getElement&&t.getElement();e&&(S(e,"focus",function(){this._tooltip._source=t,this.openTooltip()},this),S(e,"blur",this.closeTooltip,this))},_setAriaDescribedByOnLayer:function(t){t="function"==typeof t.getElement&&t.getElement();t&&t.setAttribute("aria-describedby",this._tooltip._container.id)},_openTooltip:function(t){var e;this._tooltip&&this._map&&(this._map.dragging&&this._map.dragging.moving()&&!this._openOnceFlag?(this._openOnceFlag=!0,(e=this)._map.once("moveend",function(){e._openOnceFlag=!1,e._openTooltip(t)})):(this._tooltip._source=t.layer||t.target,this.openTooltip(this._tooltip.options.sticky?t.latlng:void 0)))},_moveTooltip:function(t){var e=t.latlng;this._tooltip.options.sticky&&t.originalEvent&&(t=this._map.mouseEventToContainerPoint(t.originalEvent),t=this._map.containerPointToLayerPoint(t),e=this._map.layerPointToLatLng(t)),this._tooltip.setLatLng(e)}}),di.extend({options:{iconSize:[12,12],html:!1,bgPos:null,className:"leaflet-div-icon"},createIcon:function(t){var t=t&&"DIV"===t.tagName?t:document.createElement("div"),e=this.options;return e.html instanceof Element?(me(t),t.appendChild(e.html)):t.innerHTML=!1!==e.html?e.html:"",e.bgPos&&(e=m(e.bgPos),t.style.backgroundPosition=-e.x+"px "+-e.y+"px"),this._setIconStyles(t,"icon"),t},createShadow:function(){return null}}));di.Default=_i;var Ni=o.extend({options:{tileSize:256,opacity:1,updateWhenIdle:b.mobile,updateWhenZooming:!0,updateInterval:200,zIndex:1,bounds:null,minZoom:0,maxZoom:void 0,maxNativeZoom:void 0,minNativeZoom:void 0,noWrap:!1,pane:"tilePane",className:"",keepBuffer:2},initialize:function(t){c(this,t)},onAdd:function(){this._initContainer(),this._levels={},this._tiles={},this._resetView()},beforeAdd:function(t){t._addZoomLimit(this)},onRemove:function(t){this._removeAllTiles(),T(this._container),t._removeZoomLimit(this),this._container=null,this._tileZoom=void 0},bringToFront:function(){return this._map&&(fe(this._container),this._setAutoZIndex(Math.max)),this},bringToBack:function(){return this._map&&(ge(this._container),this._setAutoZIndex(Math.min)),this},getContainer:function(){return this._container},setOpacity:function(t){return this.options.opacity=t,this._updateOpacity(),this},setZIndex:function(t){return this.options.zIndex=t,this._updateZIndex(),this},isLoading:function(){return this._loading},redraw:function(){var t;return this._map&&(this._removeAllTiles(),(t=this._clampZoom(this._map.getZoom()))!==this._tileZoom&&(this._tileZoom=t,this._updateLevels()),this._update()),this},getEvents:function(){var t={viewprereset:this._invalidateAll,viewreset:this._resetView,zoom:this._resetView,moveend:this._onMoveEnd};return this.options.updateWhenIdle||(this._onMove||(this._onMove=j(this._onMoveEnd,this.options.updateInterval,this)),t.move=this._onMove),this._zoomAnimated&&(t.zoomanim=this._animateZoom),t},createTile:function(){return document.createElement("div")},getTileSize:function(){var t=this.options.tileSize;return t instanceof p?t:new p(t,t)},_updateZIndex:function(){this._container&&void 0!==this.options.zIndex&&null!==this.options.zIndex&&(this._container.style.zIndex=this.options.zIndex)},_setAutoZIndex:function(t){for(var e,i=this.getPane().children,n=-t(-1/0,1/0),o=0,s=i.length;o<s;o++)e=i[o].style.zIndex,i[o]!==this._container&&e&&(n=t(n,+e));isFinite(n)&&(this.options.zIndex=n+t(-1,1),this._updateZIndex())},_updateOpacity:function(){if(this._map&&!b.ielt9){C(this._container,this.options.opacity);var t,e=+new Date,i=!1,n=!1;for(t in this._tiles){var o,s=this._tiles[t];s.current&&s.loaded&&(o=Math.min(1,(e-s.loaded)/200),C(s.el,o),o<1?i=!0:(s.active?n=!0:this._onOpaqueTile(s),s.active=!0))}n&&!this._noPrune&&this._pruneTiles(),i&&(r(this._fadeFrame),this._fadeFrame=x(this._updateOpacity,this))}},_onOpaqueTile:u,_initContainer:function(){this._container||(this._container=P("div","leaflet-layer "+(this.options.className||"")),this._updateZIndex(),this.options.opacity<1&&this._updateOpacity(),this.getPane().appendChild(this._container))},_updateLevels:function(){var t=this._tileZoom,e=this.options.maxZoom;if(void 0!==t){for(var i in this._levels)i=Number(i),this._levels[i].el.children.length||i===t?(this._levels[i].el.style.zIndex=e-Math.abs(t-i),this._onUpdateLevel(i)):(T(this._levels[i].el),this._removeTilesAtZoom(i),this._onRemoveLevel(i),delete this._levels[i]);var n=this._levels[t],o=this._map;return n||((n=this._levels[t]={}).el=P("div","leaflet-tile-container leaflet-zoom-animated",this._container),n.el.style.zIndex=e,n.origin=o.project(o.unproject(o.getPixelOrigin()),t).round(),n.zoom=t,this._setZoomTransform(n,o.getCenter(),o.getZoom()),u(n.el.offsetWidth),this._onCreateLevel(n)),this._level=n}},_onUpdateLevel:u,_onRemoveLevel:u,_onCreateLevel:u,_pruneTiles:function(){if(this._map){var t,e,i,n=this._map.getZoom();if(n>this.options.maxZoom||n<this.options.minZoom)this._removeAllTiles();else{for(t in this._tiles)(i=this._tiles[t]).retain=i.current;for(t in this._tiles)(i=this._tiles[t]).current&&!i.active&&(e=i.coords,this._retainParent(e.x,e.y,e.z,e.z-5)||this._retainChildren(e.x,e.y,e.z,e.z+2));for(t in this._tiles)this._tiles[t].retain||this._removeTile(t)}}},_removeTilesAtZoom:function(t){for(var e in this._tiles)this._tiles[e].coords.z===t&&this._removeTile(e)},_removeAllTiles:function(){for(var t in this._tiles)this._removeTile(t)},_invalidateAll:function(){for(var t in this._levels)T(this._levels[t].el),this._onRemoveLevel(Number(t)),delete this._levels[t];this._removeAllTiles(),this._tileZoom=void 0},_retainParent:function(t,e,i,n){var t=Math.floor(t/2),e=Math.floor(e/2),i=i-1,o=new p(+t,+e),o=(o.z=i,this._tileCoordsToKey(o)),o=this._tiles[o];return o&&o.active?o.retain=!0:(o&&o.loaded&&(o.retain=!0),n<i&&this._retainParent(t,e,i,n))},_retainChildren:function(t,e,i,n){for(var o=2*t;o<2*t+2;o++)for(var s=2*e;s<2*e+2;s++){var r=new p(o,s),r=(r.z=i+1,this._tileCoordsToKey(r)),r=this._tiles[r];r&&r.active?r.retain=!0:(r&&r.loaded&&(r.retain=!0),i+1<n&&this._retainChildren(o,s,i+1,n))}},_resetView:function(t){t=t&&(t.pinch||t.flyTo);this._setView(this._map.getCenter(),this._map.getZoom(),t,t)},_animateZoom:function(t){this._setView(t.center,t.zoom,!0,t.noUpdate)},_clampZoom:function(t){var e=this.options;return void 0!==e.minNativeZoom&&t<e.minNativeZoom?e.minNativeZoom:void 0!==e.maxNativeZoom&&e.maxNativeZoom<t?e.maxNativeZoom:t},_setView:function(t,e,i,n){var o=Math.round(e),o=void 0!==this.options.maxZoom&&o>this.options.maxZoom||void 0!==this.options.minZoom&&o<this.options.minZoom?void 0:this._clampZoom(o),s=this.options.updateWhenZooming&&o!==this._tileZoom;n&&!s||(this._tileZoom=o,this._abortLoading&&this._abortLoading(),this._updateLevels(),this._resetGrid(),void 0!==o&&this._update(t),i||this._pruneTiles(),this._noPrune=!!i),this._setZoomTransforms(t,e)},_setZoomTransforms:function(t,e){for(var i in this._levels)this._setZoomTransform(this._levels[i],t,e)},_setZoomTransform:function(t,e,i){var n=this._map.getZoomScale(i,t.zoom),e=t.origin.multiplyBy(n).subtract(this._map._getNewPixelOrigin(e,i)).round();b.any3d?be(t.el,e,n):Z(t.el,e)},_resetGrid:function(){var t=this._map,e=t.options.crs,i=this._tileSize=this.getTileSize(),n=this._tileZoom,o=this._map.getPixelWorldBounds(this._tileZoom);o&&(this._globalTileRange=this._pxBoundsToTileRange(o)),this._wrapX=e.wrapLng&&!this.options.noWrap&&[Math.floor(t.project([0,e.wrapLng[0]],n).x/i.x),Math.ceil(t.project([0,e.wrapLng[1]],n).x/i.y)],this._wrapY=e.wrapLat&&!this.options.noWrap&&[Math.floor(t.project([e.wrapLat[0],0],n).y/i.x),Math.ceil(t.project([e.wrapLat[1],0],n).y/i.y)]},_onMoveEnd:function(){this._map&&!this._map._animatingZoom&&this._update()},_getTiledPixelBounds:function(t){var e=this._map,i=e._animatingZoom?Math.max(e._animateToZoom,e.getZoom()):e.getZoom(),i=e.getZoomScale(i,this._tileZoom),t=e.project(t,this._tileZoom).floor(),e=e.getSize().divideBy(2*i);return new f(t.subtract(e),t.add(e))},_update:function(t){var e=this._map;if(e){var i=this._clampZoom(e.getZoom());if(void 0===t&&(t=e.getCenter()),void 0!==this._tileZoom){var n,e=this._getTiledPixelBounds(t),o=this._pxBoundsToTileRange(e),s=o.getCenter(),r=[],e=this.options.keepBuffer,a=new f(o.getBottomLeft().subtract([e,-e]),o.getTopRight().add([e,-e]));if(!(isFinite(o.min.x)&&isFinite(o.min.y)&&isFinite(o.max.x)&&isFinite(o.max.y)))throw new Error("Attempted to load an infinite number of tiles");for(n in this._tiles){var h=this._tiles[n].coords;h.z===this._tileZoom&&a.contains(new p(h.x,h.y))||(this._tiles[n].current=!1)}if(1<Math.abs(i-this._tileZoom))this._setView(t,i);else{for(var l=o.min.y;l<=o.max.y;l++)for(var u=o.min.x;u<=o.max.x;u++){var c,d=new p(u,l);d.z=this._tileZoom,this._isValidTile(d)&&((c=this._tiles[this._tileCoordsToKey(d)])?c.current=!0:r.push(d))}if(r.sort(function(t,e){return t.distanceTo(s)-e.distanceTo(s)}),0!==r.length){this._loading||(this._loading=!0,this.fire("loading"));for(var _=document.createDocumentFragment(),u=0;u<r.length;u++)this._addTile(r[u],_);this._level.el.appendChild(_)}}}}},_isValidTile:function(t){var e=this._map.options.crs;if(!e.infinite){var i=this._globalTileRange;if(!e.wrapLng&&(t.x<i.min.x||t.x>i.max.x)||!e.wrapLat&&(t.y<i.min.y||t.y>i.max.y))return!1}return!this.options.bounds||(e=this._tileCoordsToBounds(t),g(this.options.bounds).overlaps(e))},_keyToBounds:function(t){return this._tileCoordsToBounds(this._keyToTileCoords(t))},_tileCoordsToNwSe:function(t){var e=this._map,i=this.getTileSize(),n=t.scaleBy(i),i=n.add(i);return[e.unproject(n,t.z),e.unproject(i,t.z)]},_tileCoordsToBounds:function(t){t=this._tileCoordsToNwSe(t),t=new s(t[0],t[1]);return t=this.options.noWrap?t:this._map.wrapLatLngBounds(t)},_tileCoordsToKey:function(t){return t.x+":"+t.y+":"+t.z},_keyToTileCoords:function(t){var t=t.split(":"),e=new p(+t[0],+t[1]);return e.z=+t[2],e},_removeTile:function(t){var e=this._tiles[t];e&&(T(e.el),delete this._tiles[t],this.fire("tileunload",{tile:e.el,coords:this._keyToTileCoords(t)}))},_initTile:function(t){M(t,"leaflet-tile");var e=this.getTileSize();t.style.width=e.x+"px",t.style.height=e.y+"px",t.onselectstart=u,t.onmousemove=u,b.ielt9&&this.options.opacity<1&&C(t,this.options.opacity)},_addTile:function(t,e){var i=this._getTilePos(t),n=this._tileCoordsToKey(t),o=this.createTile(this._wrapCoords(t),a(this._tileReady,this,t));this._initTile(o),this.createTile.length<2&&x(a(this._tileReady,this,t,null,o)),Z(o,i),this._tiles[n]={el:o,coords:t,current:!0},e.appendChild(o),this.fire("tileloadstart",{tile:o,coords:t})},_tileReady:function(t,e,i){e&&this.fire("tileerror",{error:e,tile:i,coords:t});var n=this._tileCoordsToKey(t);(i=this._tiles[n])&&(i.loaded=+new Date,this._map._fadeAnimated?(C(i.el,0),r(this._fadeFrame),this._fadeFrame=x(this._updateOpacity,this)):(i.active=!0,this._pruneTiles()),e||(M(i.el,"leaflet-tile-loaded"),this.fire("tileload",{tile:i.el,coords:t})),this._noTilesToLoad()&&(this._loading=!1,this.fire("load"),b.ielt9||!this._map._fadeAnimated?x(this._pruneTiles,this):setTimeout(a(this._pruneTiles,this),250)))},_getTilePos:function(t){return t.scaleBy(this.getTileSize()).subtract(this._level.origin)},_wrapCoords:function(t){var e=new p(this._wrapX?H(t.x,this._wrapX):t.x,this._wrapY?H(t.y,this._wrapY):t.y);return e.z=t.z,e},_pxBoundsToTileRange:function(t){var e=this.getTileSize();return new f(t.min.unscaleBy(e).floor(),t.max.unscaleBy(e).ceil().subtract([1,1]))},_noTilesToLoad:function(){for(var t in this._tiles)if(!this._tiles[t].loaded)return!1;return!0}});var Di=Ni.extend({options:{minZoom:0,maxZoom:18,subdomains:"abc",errorTileUrl:"",zoomOffset:0,tms:!1,zoomReverse:!1,detectRetina:!1,crossOrigin:!1,referrerPolicy:!1},initialize:function(t,e){this._url=t,(e=c(this,e)).detectRetina&&b.retina&&0<e.maxZoom?(e.tileSize=Math.floor(e.tileSize/2),e.zoomReverse?(e.zoomOffset--,e.minZoom=Math.min(e.maxZoom,e.minZoom+1)):(e.zoomOffset++,e.maxZoom=Math.max(e.minZoom,e.maxZoom-1)),e.minZoom=Math.max(0,e.minZoom)):e.zoomReverse?e.minZoom=Math.min(e.maxZoom,e.minZoom):e.maxZoom=Math.max(e.minZoom,e.maxZoom),"string"==typeof e.subdomains&&(e.subdomains=e.subdomains.split("")),this.on("tileunload",this._onTileRemove)},setUrl:function(t,e){return this._url===t&&void 0===e&&(e=!0),this._url=t,e||this.redraw(),this},createTile:function(t,e){var i=document.createElement("img");return S(i,"load",a(this._tileOnLoad,this,e,i)),S(i,"error",a(this._tileOnError,this,e,i)),!this.options.crossOrigin&&""!==this.options.crossOrigin||(i.crossOrigin=!0===this.options.crossOrigin?"":this.options.crossOrigin),"string"==typeof this.options.referrerPolicy&&(i.referrerPolicy=this.options.referrerPolicy),i.alt="",i.src=this.getTileUrl(t),i},getTileUrl:function(t){var e={r:b.retina?"@2x":"",s:this._getSubdomain(t),x:t.x,y:t.y,z:this._getZoomForUrl()};return this._map&&!this._map.options.crs.infinite&&(t=this._globalTileRange.max.y-t.y,this.options.tms&&(e.y=t),e["-y"]=t),q(this._url,l(e,this.options))},_tileOnLoad:function(t,e){b.ielt9?setTimeout(a(t,this,null,e),0):t(null,e)},_tileOnError:function(t,e,i){var n=this.options.errorTileUrl;n&&e.getAttribute("src")!==n&&(e.src=n),t(i,e)},_onTileRemove:function(t){t.tile.onload=null},_getZoomForUrl:function(){var t=this._tileZoom,e=this.options.maxZoom;return(t=this.options.zoomReverse?e-t:t)+this.options.zoomOffset},_getSubdomain:function(t){t=Math.abs(t.x+t.y)%this.options.subdomains.length;return this.options.subdomains[t]},_abortLoading:function(){var t,e,i;for(t in this._tiles)this._tiles[t].coords.z!==this._tileZoom&&((i=this._tiles[t].el).onload=u,i.onerror=u,i.complete||(i.src=K,e=this._tiles[t].coords,T(i),delete this._tiles[t],this.fire("tileabort",{tile:i,coords:e})))},_removeTile:function(t){var e=this._tiles[t];if(e)return e.el.setAttribute("src",K),Ni.prototype._removeTile.call(this,t)},_tileReady:function(t,e,i){if(this._map&&(!i||i.getAttribute("src")!==K))return Ni.prototype._tileReady.call(this,t,e,i)}});function ji(t,e){return new Di(t,e)}var Hi=Di.extend({defaultWmsParams:{service:"WMS",request:"GetMap",layers:"",styles:"",format:"image/jpeg",transparent:!1,version:"1.1.1"},options:{crs:null,uppercase:!1},initialize:function(t,e){this._url=t;var i,n=l({},this.defaultWmsParams);for(i in e)i in this.options||(n[i]=e[i]);var t=(e=c(this,e)).detectRetina&&b.retina?2:1,o=this.getTileSize();n.width=o.x*t,n.height=o.y*t,this.wmsParams=n},onAdd:function(t){this._crs=this.options.crs||t.options.crs,this._wmsVersion=parseFloat(this.wmsParams.version);var e=1.3<=this._wmsVersion?"crs":"srs";this.wmsParams[e]=this._crs.code,Di.prototype.onAdd.call(this,t)},getTileUrl:function(t){var e=this._tileCoordsToNwSe(t),i=this._crs,i=_(i.project(e[0]),i.project(e[1])),e=i.min,i=i.max,e=(1.3<=this._wmsVersion&&this._crs===li?[e.y,e.x,i.y,i.x]:[e.x,e.y,i.x,i.y]).join(","),i=Di.prototype.getTileUrl.call(this,t);return i+U(this.wmsParams,i,this.options.uppercase)+(this.options.uppercase?"&BBOX=":"&bbox=")+e},setParams:function(t,e){return l(this.wmsParams,t),e||this.redraw(),this}});Di.WMS=Hi,ji.wms=function(t,e){return new Hi(t,e)};var Wi=o.extend({options:{padding:.1},initialize:function(t){c(this,t),h(this),this._layers=this._layers||{}},onAdd:function(){this._container||(this._initContainer(),M(this._container,"leaflet-zoom-animated")),this.getPane().appendChild(this._container),this._update(),this.on("update",this._updatePaths,this)},onRemove:function(){this.off("update",this._updatePaths,this),this._destroyContainer()},getEvents:function(){var t={viewreset:this._reset,zoom:this._onZoom,moveend:this._update,zoomend:this._onZoomEnd};return this._zoomAnimated&&(t.zoomanim=this._onAnimZoom),t},_onAnimZoom:function(t){this._updateTransform(t.center,t.zoom)},_onZoom:function(){this._updateTransform(this._map.getCenter(),this._map.getZoom())},_updateTransform:function(t,e){var i=this._map.getZoomScale(e,this._zoom),n=this._map.getSize().multiplyBy(.5+this.options.padding),o=this._map.project(this._center,e),n=n.multiplyBy(-i).add(o).subtract(this._map._getNewPixelOrigin(t,e));b.any3d?be(this._container,n,i):Z(this._container,n)},_reset:function(){for(var t in this._update(),this._updateTransform(this._center,this._zoom),this._layers)this._layers[t]._reset()},_onZoomEnd:function(){for(var t in this._layers)this._layers[t]._project()},_updatePaths:function(){for(var t in this._layers)this._layers[t]._update()},_update:function(){var t=this.options.padding,e=this._map.getSize(),i=this._map.containerPointToLayerPoint(e.multiplyBy(-t)).round();this._bounds=new f(i,i.add(e.multiplyBy(1+2*t)).round()),this._center=this._map.getCenter(),this._zoom=this._map.getZoom()}}),Fi=Wi.extend({options:{tolerance:0},getEvents:function(){var t=Wi.prototype.getEvents.call(this);return t.viewprereset=this._onViewPreReset,t},_onViewPreReset:function(){this._postponeUpdatePaths=!0},onAdd:function(){Wi.prototype.onAdd.call(this),this._draw()},_initContainer:function(){var t=this._container=document.createElement("canvas");S(t,"mousemove",this._onMouseMove,this),S(t,"click dblclick mousedown mouseup contextmenu",this._onClick,this),S(t,"mouseout",this._handleMouseOut,this),t._leaflet_disable_events=!0,this._ctx=t.getContext("2d")},_destroyContainer:function(){r(this._redrawRequest),delete this._ctx,T(this._container),k(this._container),delete this._container},_updatePaths:function(){if(!this._postponeUpdatePaths){for(var t in this._redrawBounds=null,this._layers)this._layers[t]._update();this._redraw()}},_update:function(){var t,e,i,n;this._map._animatingZoom&&this._bounds||(Wi.prototype._update.call(this),t=this._bounds,e=this._container,i=t.getSize(),n=b.retina?2:1,Z(e,t.min),e.width=n*i.x,e.height=n*i.y,e.style.width=i.x+"px",e.style.height=i.y+"px",b.retina&&this._ctx.scale(2,2),this._ctx.translate(-t.min.x,-t.min.y),this.fire("update"))},_reset:function(){Wi.prototype._reset.call(this),this._postponeUpdatePaths&&(this._postponeUpdatePaths=!1,this._updatePaths())},_initPath:function(t){this._updateDashArray(t);t=(this._layers[h(t)]=t)._order={layer:t,prev:this._drawLast,next:null};this._drawLast&&(this._drawLast.next=t),this._drawLast=t,this._drawFirst=this._drawFirst||this._drawLast},_addPath:function(t){this._requestRedraw(t)},_removePath:function(t){var e=t._order,i=e.next,e=e.prev;i?i.prev=e:this._drawLast=e,e?e.next=i:this._drawFirst=i,delete t._order,delete this._layers[h(t)],this._requestRedraw(t)},_updatePath:function(t){this._extendRedrawBounds(t),t._project(),t._update(),this._requestRedraw(t)},_updateStyle:function(t){this._updateDashArray(t),this._requestRedraw(t)},_updateDashArray:function(t){if("string"==typeof t.options.dashArray){for(var e,i=t.options.dashArray.split(/[, ]+/),n=[],o=0;o<i.length;o++){if(e=Number(i[o]),isNaN(e))return;n.push(e)}t.options._dashArray=n}else t.options._dashArray=t.options.dashArray},_requestRedraw:function(t){this._map&&(this._extendRedrawBounds(t),this._redrawRequest=this._redrawRequest||x(this._redraw,this))},_extendRedrawBounds:function(t){var e;t._pxBounds&&(e=(t.options.weight||0)+1,this._redrawBounds=this._redrawBounds||new f,this._redrawBounds.extend(t._pxBounds.min.subtract([e,e])),this._redrawBounds.extend(t._pxBounds.max.add([e,e])))},_redraw:function(){this._redrawRequest=null,this._redrawBounds&&(this._redrawBounds.min._floor(),this._redrawBounds.max._ceil()),this._clear(),this._draw(),this._redrawBounds=null},_clear:function(){var t,e=this._redrawBounds;e?(t=e.getSize(),this._ctx.clearRect(e.min.x,e.min.y,t.x,t.y)):(this._ctx.save(),this._ctx.setTransform(1,0,0,1,0,0),this._ctx.clearRect(0,0,this._container.width,this._container.height),this._ctx.restore())},_draw:function(){var t,e,i=this._redrawBounds;this._ctx.save(),i&&(e=i.getSize(),this._ctx.beginPath(),this._ctx.rect(i.min.x,i.min.y,e.x,e.y),this._ctx.clip()),this._drawing=!0;for(var n=this._drawFirst;n;n=n.next)t=n.layer,(!i||t._pxBounds&&t._pxBounds.intersects(i))&&t._updatePath();this._drawing=!1,this._ctx.restore()},_updatePoly:function(t,e){if(this._drawing){var i,n,o,s,r=t._parts,a=r.length,h=this._ctx;if(a){for(h.beginPath(),i=0;i<a;i++){for(n=0,o=r[i].length;n<o;n++)s=r[i][n],h[n?"lineTo":"moveTo"](s.x,s.y);e&&h.closePath()}this._fillStroke(h,t)}}},_updateCircle:function(t){var e,i,n,o;this._drawing&&!t._empty()&&(e=t._point,i=this._ctx,n=Math.max(Math.round(t._radius),1),1!=(o=(Math.max(Math.round(t._radiusY),1)||n)/n)&&(i.save(),i.scale(1,o)),i.beginPath(),i.arc(e.x,e.y/o,n,0,2*Math.PI,!1),1!=o&&i.restore(),this._fillStroke(i,t))},_fillStroke:function(t,e){var i=e.options;i.fill&&(t.globalAlpha=i.fillOpacity,t.fillStyle=i.fillColor||i.color,t.fill(i.fillRule||"evenodd")),i.stroke&&0!==i.weight&&(t.setLineDash&&t.setLineDash(e.options&&e.options._dashArray||[]),t.globalAlpha=i.opacity,t.lineWidth=i.weight,t.strokeStyle=i.color,t.lineCap=i.lineCap,t.lineJoin=i.lineJoin,t.stroke())},_onClick:function(t){for(var e,i,n=this._map.mouseEventToLayerPoint(t),o=this._drawFirst;o;o=o.next)(e=o.layer).options.interactive&&e._containsPoint(n)&&(("click"===t.type||"preclick"===t.type)&&this._map._draggableMoved(e)||(i=e));this._fireEvent(!!i&&[i],t)},_onMouseMove:function(t){var e;!this._map||this._map.dragging.moving()||this._map._animatingZoom||(e=this._map.mouseEventToLayerPoint(t),this._handleMouseHover(t,e))},_handleMouseOut:function(t){var e=this._hoveredLayer;e&&(z(this._container,"leaflet-interactive"),this._fireEvent([e],t,"mouseout"),this._hoveredLayer=null,this._mouseHoverThrottled=!1)},_handleMouseHover:function(t,e){if(!this._mouseHoverThrottled){for(var i,n,o=this._drawFirst;o;o=o.next)(i=o.layer).options.interactive&&i._containsPoint(e)&&(n=i);n!==this._hoveredLayer&&(this._handleMouseOut(t),n&&(M(this._container,"leaflet-interactive"),this._fireEvent([n],t,"mouseover"),this._hoveredLayer=n)),this._fireEvent(!!this._hoveredLayer&&[this._hoveredLayer],t),this._mouseHoverThrottled=!0,setTimeout(a(function(){this._mouseHoverThrottled=!1},this),32)}},_fireEvent:function(t,e,i){this._map._fireDOMEvent(e,i||e.type,t)},_bringToFront:function(t){var e,i,n=t._order;n&&(e=n.next,i=n.prev,e&&((e.prev=i)?i.next=e:e&&(this._drawFirst=e),n.prev=this._drawLast,(this._drawLast.next=n).next=null,this._drawLast=n,this._requestRedraw(t)))},_bringToBack:function(t){var e,i,n=t._order;n&&(e=n.next,(i=n.prev)&&((i.next=e)?e.prev=i:i&&(this._drawLast=i),n.prev=null,n.next=this._drawFirst,this._drawFirst.prev=n,this._drawFirst=n,this._requestRedraw(t)))}});function Ui(t){return b.canvas?new Fi(t):null}var Vi=function(){try{return document.namespaces.add("lvml","urn:schemas-microsoft-com:vml"),function(t){return document.createElement("<lvml:"+t+' class="lvml">')}}catch(t){}return function(t){return document.createElement("<"+t+' xmlns="urn:schemas-microsoft.com:vml" class="lvml">')}}(),zt={_initContainer:function(){this._container=P("div","leaflet-vml-container")},_update:function(){this._map._animatingZoom||(Wi.prototype._update.call(this),this.fire("update"))},_initPath:function(t){var e=t._container=Vi("shape");M(e,"leaflet-vml-shape "+(this.options.className||"")),e.coordsize="1 1",t._path=Vi("path"),e.appendChild(t._path),this._updateStyle(t),this._layers[h(t)]=t},_addPath:function(t){var e=t._container;this._container.appendChild(e),t.options.interactive&&t.addInteractiveTarget(e)},_removePath:function(t){var e=t._container;T(e),t.removeInteractiveTarget(e),delete this._layers[h(t)]},_updateStyle:function(t){var e=t._stroke,i=t._fill,n=t.options,o=t._container;o.stroked=!!n.stroke,o.filled=!!n.fill,n.stroke?(e=e||(t._stroke=Vi("stroke")),o.appendChild(e),e.weight=n.weight+"px",e.color=n.color,e.opacity=n.opacity,n.dashArray?e.dashStyle=d(n.dashArray)?n.dashArray.join(" "):n.dashArray.replace(/( *, *)/g," "):e.dashStyle="",e.endcap=n.lineCap.replace("butt","flat"),e.joinstyle=n.lineJoin):e&&(o.removeChild(e),t._stroke=null),n.fill?(i=i||(t._fill=Vi("fill")),o.appendChild(i),i.color=n.fillColor||n.color,i.opacity=n.fillOpacity):i&&(o.removeChild(i),t._fill=null)},_updateCircle:function(t){var e=t._point.round(),i=Math.round(t._radius),n=Math.round(t._radiusY||i);this._setPath(t,t._empty()?"M0 0":"AL "+e.x+","+e.y+" "+i+","+n+" 0,23592600")},_setPath:function(t,e){t._path.v=e},_bringToFront:function(t){fe(t._container)},_bringToBack:function(t){ge(t._container)}},qi=b.vml?Vi:ct,Gi=Wi.extend({_initContainer:function(){this._container=qi("svg"),this._container.setAttribute("pointer-events","none"),this._rootGroup=qi("g"),this._container.appendChild(this._rootGroup)},_destroyContainer:function(){T(this._container),k(this._container),delete this._container,delete this._rootGroup,delete this._svgSize},_update:function(){var t,e,i;this._map._animatingZoom&&this._bounds||(Wi.prototype._update.call(this),e=(t=this._bounds).getSize(),i=this._container,this._svgSize&&this._svgSize.equals(e)||(this._svgSize=e,i.setAttribute("width",e.x),i.setAttribute("height",e.y)),Z(i,t.min),i.setAttribute("viewBox",[t.min.x,t.min.y,e.x,e.y].join(" ")),this.fire("update"))},_initPath:function(t){var e=t._path=qi("path");t.options.className&&M(e,t.options.className),t.options.interactive&&M(e,"leaflet-interactive"),this._updateStyle(t),this._layers[h(t)]=t},_addPath:function(t){this._rootGroup||this._initContainer(),this._rootGroup.appendChild(t._path),t.addInteractiveTarget(t._path)},_removePath:function(t){T(t._path),t.removeInteractiveTarget(t._path),delete this._layers[h(t)]},_updatePath:function(t){t._project(),t._update()},_updateStyle:function(t){var e=t._path,t=t.options;e&&(t.stroke?(e.setAttribute("stroke",t.color),e.setAttribute("stroke-opacity",t.opacity),e.setAttribute("stroke-width",t.weight),e.setAttribute("stroke-linecap",t.lineCap),e.setAttribute("stroke-linejoin",t.lineJoin),t.dashArray?e.setAttribute("stroke-dasharray",t.dashArray):e.removeAttribute("stroke-dasharray"),t.dashOffset?e.setAttribute("stroke-dashoffset",t.dashOffset):e.removeAttribute("stroke-dashoffset")):e.setAttribute("stroke","none"),t.fill?(e.setAttribute("fill",t.fillColor||t.color),e.setAttribute("fill-opacity",t.fillOpacity),e.setAttribute("fill-rule",t.fillRule||"evenodd")):e.setAttribute("fill","none"))},_updatePoly:function(t,e){this._setPath(t,dt(t._parts,e))},_updateCircle:function(t){var e=t._point,i=Math.max(Math.round(t._radius),1),n="a"+i+","+(Math.max(Math.round(t._radiusY),1)||i)+" 0 1,0 ",e=t._empty()?"M0 0":"M"+(e.x-i)+","+e.y+n+2*i+",0 "+n+2*-i+",0 ";this._setPath(t,e)},_setPath:function(t,e){t._path.setAttribute("d",e)},_bringToFront:function(t){fe(t._path)},_bringToBack:function(t){ge(t._path)}});function Ki(t){return b.svg||b.vml?new Gi(t):null}b.vml&&Gi.include(zt),A.include({getRenderer:function(t){t=(t=t.options.renderer||this._getPaneRenderer(t.options.pane)||this.options.renderer||this._renderer)||(this._renderer=this._createRenderer());return this.hasLayer(t)||this.addLayer(t),t},_getPaneRenderer:function(t){var e;return"overlayPane"!==t&&void 0!==t&&(void 0===(e=this._paneRenderers[t])&&(e=this._createRenderer({pane:t}),this._paneRenderers[t]=e),e)},_createRenderer:function(t){return this.options.preferCanvas&&Ui(t)||Ki(t)}});var Yi=xi.extend({initialize:function(t,e){xi.prototype.initialize.call(this,this._boundsToLatLngs(t),e)},setBounds:function(t){return this.setLatLngs(this._boundsToLatLngs(t))},_boundsToLatLngs:function(t){return[(t=g(t)).getSouthWest(),t.getNorthWest(),t.getNorthEast(),t.getSouthEast()]}});Gi.create=qi,Gi.pointsToPath=dt,wi.geometryToLayer=bi,wi.coordsToLatLng=Li,wi.coordsToLatLngs=Ti,wi.latLngToCoords=Mi,wi.latLngsToCoords=zi,wi.getFeature=Ci,wi.asFeature=Zi,A.mergeOptions({boxZoom:!0});var _t=n.extend({initialize:function(t){this._map=t,this._container=t._container,this._pane=t._panes.overlayPane,this._resetStateTimeout=0,t.on("unload",this._destroy,this)},addHooks:function(){S(this._container,"mousedown",this._onMouseDown,this)},removeHooks:function(){k(this._container,"mousedown",this._onMouseDown,this)},moved:function(){return this._moved},_destroy:function(){T(this._pane),delete this._pane},_resetState:function(){this._resetStateTimeout=0,this._moved=!1},_clearDeferredResetState:function(){0!==this._resetStateTimeout&&(clearTimeout(this._resetStateTimeout),this._resetStateTimeout=0)},_onMouseDown:function(t){if(!t.shiftKey||1!==t.which&&1!==t.button)return!1;this._clearDeferredResetState(),this._resetState(),re(),Le(),this._startPoint=this._map.mouseEventToContainerPoint(t),S(document,{contextmenu:Re,mousemove:this._onMouseMove,mouseup:this._onMouseUp,keydown:this._onKeyDown},this)},_onMouseMove:function(t){this._moved||(this._moved=!0,this._box=P("div","leaflet-zoom-box",this._container),M(this._container,"leaflet-crosshair"),this._map.fire("boxzoomstart")),this._point=this._map.mouseEventToContainerPoint(t);var t=new f(this._point,this._startPoint),e=t.getSize();Z(this._box,t.min),this._box.style.width=e.x+"px",this._box.style.height=e.y+"px"},_finish:function(){this._moved&&(T(this._box),z(this._container,"leaflet-crosshair")),ae(),Te(),k(document,{contextmenu:Re,mousemove:this._onMouseMove,mouseup:this._onMouseUp,keydown:this._onKeyDown},this)},_onMouseUp:function(t){1!==t.which&&1!==t.button||(this._finish(),this._moved&&(this._clearDeferredResetState(),this._resetStateTimeout=setTimeout(a(this._resetState,this),0),t=new s(this._map.containerPointToLatLng(this._startPoint),this._map.containerPointToLatLng(this._point)),this._map.fitBounds(t).fire("boxzoomend",{boxZoomBounds:t})))},_onKeyDown:function(t){27===t.keyCode&&(this._finish(),this._clearDeferredResetState(),this._resetState())}}),Ct=(A.addInitHook("addHandler","boxZoom",_t),A.mergeOptions({doubleClickZoom:!0}),n.extend({addHooks:function(){this._map.on("dblclick",this._onDoubleClick,this)},removeHooks:function(){this._map.off("dblclick",this._onDoubleClick,this)},_onDoubleClick:function(t){var e=this._map,i=e.getZoom(),n=e.options.zoomDelta,i=t.originalEvent.shiftKey?i-n:i+n;"center"===e.options.doubleClickZoom?e.setZoom(i):e.setZoomAround(t.containerPoint,i)}})),Zt=(A.addInitHook("addHandler","doubleClickZoom",Ct),A.mergeOptions({dragging:!0,inertia:!0,inertiaDeceleration:3400,inertiaMaxSpeed:1/0,easeLinearity:.2,worldCopyJump:!1,maxBoundsViscosity:0}),n.extend({addHooks:function(){var t;this._draggable||(t=this._map,this._draggable=new Xe(t._mapPane,t._container),this._draggable.on({dragstart:this._onDragStart,drag:this._onDrag,dragend:this._onDragEnd},this),this._draggable.on("predrag",this._onPreDragLimit,this),t.options.worldCopyJump&&(this._draggable.on("predrag",this._onPreDragWrap,this),t.on("zoomend",this._onZoomEnd,this),t.whenReady(this._onZoomEnd,this))),M(this._map._container,"leaflet-grab leaflet-touch-drag"),this._draggable.enable(),this._positions=[],this._times=[]},removeHooks:function(){z(this._map._container,"leaflet-grab"),z(this._map._container,"leaflet-touch-drag"),this._draggable.disable()},moved:function(){return this._draggable&&this._draggable._moved},moving:function(){return this._draggable&&this._draggable._moving},_onDragStart:function(){var t,e=this._map;e._stop(),this._map.options.maxBounds&&this._map.options.maxBoundsViscosity?(t=g(this._map.options.maxBounds),this._offsetLimit=_(this._map.latLngToContainerPoint(t.getNorthWest()).multiplyBy(-1),this._map.latLngToContainerPoint(t.getSouthEast()).multiplyBy(-1).add(this._map.getSize())),this._viscosity=Math.min(1,Math.max(0,this._map.options.maxBoundsViscosity))):this._offsetLimit=null,e.fire("movestart").fire("dragstart"),e.options.inertia&&(this._positions=[],this._times=[])},_onDrag:function(t){var e,i;this._map.options.inertia&&(e=this._lastTime=+new Date,i=this._lastPos=this._draggable._absPos||this._draggable._newPos,this._positions.push(i),this._times.push(e),this._prunePositions(e)),this._map.fire("move",t).fire("drag",t)},_prunePositions:function(t){for(;1<this._positions.length&&50<t-this._times[0];)this._positions.shift(),this._times.shift()},_onZoomEnd:function(){var t=this._map.getSize().divideBy(2),e=this._map.latLngToLayerPoint([0,0]);this._initialWorldOffset=e.subtract(t).x,this._worldWidth=this._map.getPixelWorldBounds().getSize().x},_viscousLimit:function(t,e){return t-(t-e)*this._viscosity},_onPreDragLimit:function(){var t,e;this._viscosity&&this._offsetLimit&&(t=this._draggable._newPos.subtract(this._draggable._startPos),e=this._offsetLimit,t.x<e.min.x&&(t.x=this._viscousLimit(t.x,e.min.x)),t.y<e.min.y&&(t.y=this._viscousLimit(t.y,e.min.y)),t.x>e.max.x&&(t.x=this._viscousLimit(t.x,e.max.x)),t.y>e.max.y&&(t.y=this._viscousLimit(t.y,e.max.y)),this._draggable._newPos=this._draggable._startPos.add(t))},_onPreDragWrap:function(){var t=this._worldWidth,e=Math.round(t/2),i=this._initialWorldOffset,n=this._draggable._newPos.x,o=(n-e+i)%t+e-i,n=(n+e+i)%t-e-i,t=Math.abs(o+i)<Math.abs(n+i)?o:n;this._draggable._absPos=this._draggable._newPos.clone(),this._draggable._newPos.x=t},_onDragEnd:function(t){var e,i,n,o,s=this._map,r=s.options,a=!r.inertia||t.noInertia||this._times.length<2;s.fire("dragend",t),!a&&(this._prunePositions(+new Date),t=this._lastPos.subtract(this._positions[0]),a=(this._lastTime-this._times[0])/1e3,e=r.easeLinearity,a=(t=t.multiplyBy(e/a)).distanceTo([0,0]),i=Math.min(r.inertiaMaxSpeed,a),t=t.multiplyBy(i/a),n=i/(r.inertiaDeceleration*e),(o=t.multiplyBy(-n/2).round()).x||o.y)?(o=s._limitOffset(o,s.options.maxBounds),x(function(){s.panBy(o,{duration:n,easeLinearity:e,noMoveStart:!0,animate:!0})})):s.fire("moveend")}})),St=(A.addInitHook("addHandler","dragging",Zt),A.mergeOptions({keyboard:!0,keyboardPanDelta:80}),n.extend({keyCodes:{left:[37],right:[39],down:[40],up:[38],zoomIn:[187,107,61,171],zoomOut:[189,109,54,173]},initialize:function(t){this._map=t,this._setPanDelta(t.options.keyboardPanDelta),this._setZoomDelta(t.options.zoomDelta)},addHooks:function(){var t=this._map._container;t.tabIndex<=0&&(t.tabIndex="0"),S(t,{focus:this._onFocus,blur:this._onBlur,mousedown:this._onMouseDown},this),this._map.on({focus:this._addHooks,blur:this._removeHooks},this)},removeHooks:function(){this._removeHooks(),k(this._map._container,{focus:this._onFocus,blur:this._onBlur,mousedown:this._onMouseDown},this),this._map.off({focus:this._addHooks,blur:this._removeHooks},this)},_onMouseDown:function(){var t,e,i;this._focused||(i=document.body,t=document.documentElement,e=i.scrollTop||t.scrollTop,i=i.scrollLeft||t.scrollLeft,this._map._container.focus(),window.scrollTo(i,e))},_onFocus:function(){this._focused=!0,this._map.fire("focus")},_onBlur:function(){this._focused=!1,this._map.fire("blur")},_setPanDelta:function(t){for(var e=this._panKeys={},i=this.keyCodes,n=0,o=i.left.length;n<o;n++)e[i.left[n]]=[-1*t,0];for(n=0,o=i.right.length;n<o;n++)e[i.right[n]]=[t,0];for(n=0,o=i.down.length;n<o;n++)e[i.down[n]]=[0,t];for(n=0,o=i.up.length;n<o;n++)e[i.up[n]]=[0,-1*t]},_setZoomDelta:function(t){for(var e=this._zoomKeys={},i=this.keyCodes,n=0,o=i.zoomIn.length;n<o;n++)e[i.zoomIn[n]]=t;for(n=0,o=i.zoomOut.length;n<o;n++)e[i.zoomOut[n]]=-t},_addHooks:function(){S(document,"keydown",this._onKeyDown,this)},_removeHooks:function(){k(document,"keydown",this._onKeyDown,this)},_onKeyDown:function(t){if(!(t.altKey||t.ctrlKey||t.metaKey)){var e,i,n=t.keyCode,o=this._map;if(n in this._panKeys)o._panAnim&&o._panAnim._inProgress||(i=this._panKeys[n],t.shiftKey&&(i=m(i).multiplyBy(3)),o.options.maxBounds&&(i=o._limitOffset(m(i),o.options.maxBounds)),o.options.worldCopyJump?(e=o.wrapLatLng(o.unproject(o.project(o.getCenter()).add(i))),o.panTo(e)):o.panBy(i));else if(n in this._zoomKeys)o.setZoom(o.getZoom()+(t.shiftKey?3:1)*this._zoomKeys[n]);else{if(27!==n||!o._popup||!o._popup.options.closeOnEscapeKey)return;o.closePopup()}Re(t)}}})),Et=(A.addInitHook("addHandler","keyboard",St),A.mergeOptions({scrollWheelZoom:!0,wheelDebounceTime:40,wheelPxPerZoomLevel:60}),n.extend({addHooks:function(){S(this._map._container,"wheel",this._onWheelScroll,this),this._delta=0},removeHooks:function(){k(this._map._container,"wheel",this._onWheelScroll,this)},_onWheelScroll:function(t){var e=He(t),i=this._map.options.wheelDebounceTime,e=(this._delta+=e,this._lastMousePos=this._map.mouseEventToContainerPoint(t),this._startTime||(this._startTime=+new Date),Math.max(i-(+new Date-this._startTime),0));clearTimeout(this._timer),this._timer=setTimeout(a(this._performZoom,this),e),Re(t)},_performZoom:function(){var t=this._map,e=t.getZoom(),i=this._map.options.zoomSnap||0,n=(t._stop(),this._delta/(4*this._map.options.wheelPxPerZoomLevel)),n=4*Math.log(2/(1+Math.exp(-Math.abs(n))))/Math.LN2,i=i?Math.ceil(n/i)*i:n,n=t._limitZoom(e+(0<this._delta?i:-i))-e;this._delta=0,this._startTime=null,n&&("center"===t.options.scrollWheelZoom?t.setZoom(e+n):t.setZoomAround(this._lastMousePos,e+n))}})),kt=(A.addInitHook("addHandler","scrollWheelZoom",Et),A.mergeOptions({tapHold:b.touchNative&&b.safari&&b.mobile,tapTolerance:15}),n.extend({addHooks:function(){S(this._map._container,"touchstart",this._onDown,this)},removeHooks:function(){k(this._map._container,"touchstart",this._onDown,this)},_onDown:function(t){var e;clearTimeout(this._holdTimeout),1===t.touches.length&&(e=t.touches[0],this._startPos=this._newPos=new p(e.clientX,e.clientY),this._holdTimeout=setTimeout(a(function(){this._cancel(),this._isTapValid()&&(S(document,"touchend",O),S(document,"touchend touchcancel",this._cancelClickPrevent),this._simulateEvent("contextmenu",e))},this),600),S(document,"touchend touchcancel contextmenu",this._cancel,this),S(document,"touchmove",this._onMove,this))},_cancelClickPrevent:function t(){k(document,"touchend",O),k(document,"touchend touchcancel",t)},_cancel:function(){clearTimeout(this._holdTimeout),k(document,"touchend touchcancel contextmenu",this._cancel,this),k(document,"touchmove",this._onMove,this)},_onMove:function(t){t=t.touches[0];this._newPos=new p(t.clientX,t.clientY)},_isTapValid:function(){return this._newPos.distanceTo(this._startPos)<=this._map.options.tapTolerance},_simulateEvent:function(t,e){t=new MouseEvent(t,{bubbles:!0,cancelable:!0,view:window,screenX:e.screenX,screenY:e.screenY,clientX:e.clientX,clientY:e.clientY});t._simulated=!0,e.target.dispatchEvent(t)}})),Ot=(A.addInitHook("addHandler","tapHold",kt),A.mergeOptions({touchZoom:b.touch,bounceAtZoomLimits:!0}),n.extend({addHooks:function(){M(this._map._container,"leaflet-touch-zoom"),S(this._map._container,"touchstart",this._onTouchStart,this)},removeHooks:function(){z(this._map._container,"leaflet-touch-zoom"),k(this._map._container,"touchstart",this._onTouchStart,this)},_onTouchStart:function(t){var e,i,n=this._map;!t.touches||2!==t.touches.length||n._animatingZoom||this._zooming||(e=n.mouseEventToContainerPoint(t.touches[0]),i=n.mouseEventToContainerPoint(t.touches[1]),this._centerPoint=n.getSize()._divideBy(2),this._startLatLng=n.containerPointToLatLng(this._centerPoint),"center"!==n.options.touchZoom&&(this._pinchStartLatLng=n.containerPointToLatLng(e.add(i)._divideBy(2))),this._startDist=e.distanceTo(i),this._startZoom=n.getZoom(),this._moved=!1,this._zooming=!0,n._stop(),S(document,"touchmove",this._onTouchMove,this),S(document,"touchend touchcancel",this._onTouchEnd,this),O(t))},_onTouchMove:function(t){if(t.touches&&2===t.touches.length&&this._zooming){var e=this._map,i=e.mouseEventToContainerPoint(t.touches[0]),n=e.mouseEventToContainerPoint(t.touches[1]),o=i.distanceTo(n)/this._startDist;if(this._zoom=e.getScaleZoom(o,this._startZoom),!e.options.bounceAtZoomLimits&&(this._zoom<e.getMinZoom()&&o<1||this._zoom>e.getMaxZoom()&&1<o)&&(this._zoom=e._limitZoom(this._zoom)),"center"===e.options.touchZoom){if(this._center=this._startLatLng,1==o)return}else{i=i._add(n)._divideBy(2)._subtract(this._centerPoint);if(1==o&&0===i.x&&0===i.y)return;this._center=e.unproject(e.project(this._pinchStartLatLng,this._zoom).subtract(i),this._zoom)}this._moved||(e._moveStart(!0,!1),this._moved=!0),r(this._animRequest);n=a(e._move,e,this._center,this._zoom,{pinch:!0,round:!1},void 0);this._animRequest=x(n,this,!0),O(t)}},_onTouchEnd:function(){this._moved&&this._zooming?(this._zooming=!1,r(this._animRequest),k(document,"touchmove",this._onTouchMove,this),k(document,"touchend touchcancel",this._onTouchEnd,this),this._map.options.zoomAnimation?this._map._animateZoom(this._center,this._map._limitZoom(this._zoom),!0,this._map.options.zoomSnap):this._map._resetView(this._center,this._map._limitZoom(this._zoom))):this._zooming=!1}})),Xi=(A.addInitHook("addHandler","touchZoom",Ot),A.BoxZoom=_t,A.DoubleClickZoom=Ct,A.Drag=Zt,A.Keyboard=St,A.ScrollWheelZoom=Et,A.TapHold=kt,A.TouchZoom=Ot,t.Bounds=f,t.Browser=b,t.CRS=ot,t.Canvas=Fi,t.Circle=vi,t.CircleMarker=gi,t.Class=et,t.Control=B,t.DivIcon=Ri,t.DivOverlay=Ai,t.DomEvent=mt,t.DomUtil=pt,t.Draggable=Xe,t.Evented=it,t.FeatureGroup=ci,t.GeoJSON=wi,t.GridLayer=Ni,t.Handler=n,t.Icon=di,t.ImageOverlay=Ei,t.LatLng=v,t.LatLngBounds=s,t.Layer=o,t.LayerGroup=ui,t.LineUtil=vt,t.Map=A,t.Marker=mi,t.Mixin=ft,t.Path=fi,t.Point=p,t.PolyUtil=gt,t.Polygon=xi,t.Polyline=yi,t.Popup=Bi,t.PosAnimation=Fe,t.Projection=wt,t.Rectangle=Yi,t.Renderer=Wi,t.SVG=Gi,t.SVGOverlay=Oi,t.TileLayer=Di,t.Tooltip=Ii,t.Transformation=at,t.Util=tt,t.VideoOverlay=ki,t.bind=a,t.bounds=_,t.canvas=Ui,t.circle=function(t,e,i){return new vi(t,e,i)},t.circleMarker=function(t,e){return new gi(t,e)},t.control=Ue,t.divIcon=function(t){return new Ri(t)},t.extend=l,t.featureGroup=function(t,e){return new ci(t,e)},t.geoJSON=Si,t.geoJson=Mt,t.gridLayer=function(t){return new Ni(t)},t.icon=function(t){return new di(t)},t.imageOverlay=function(t,e,i){return new Ei(t,e,i)},t.latLng=w,t.latLngBounds=g,t.layerGroup=function(t,e){return new ui(t,e)},t.map=function(t,e){return new A(t,e)},t.marker=function(t,e){return new mi(t,e)},t.point=m,t.polygon=function(t,e){return new xi(t,e)},t.polyline=function(t,e){return new yi(t,e)},t.popup=function(t,e){return new Bi(t,e)},t.rectangle=function(t,e){return new Yi(t,e)},t.setOptions=c,t.stamp=h,t.svg=Ki,t.svgOverlay=function(t,e,i){return new Oi(t,e,i)},t.tileLayer=ji,t.tooltip=function(t,e){return new Ii(t,e)},t.transformation=ht,t.version="1.9.4",t.videoOverlay=function(t,e,i){return new ki(t,e,i)},window.L);t.noConflict=function(){return window.L=Xi,this},window.L=t});
//# sourceMappingURL=leaflet.js.map`;
const LEAFLET_CSS = `/* required styles */

.leaflet-pane,
.leaflet-tile,
.leaflet-marker-icon,
.leaflet-marker-shadow,
.leaflet-tile-container,
.leaflet-pane > svg,
.leaflet-pane > canvas,
.leaflet-zoom-box,
.leaflet-image-layer,
.leaflet-layer {
	position: absolute;
	left: 0;
	top: 0;
	}
.leaflet-container {
	overflow: hidden;
	}
.leaflet-tile,
.leaflet-marker-icon,
.leaflet-marker-shadow {
	-webkit-user-select: none;
	   -moz-user-select: none;
	        user-select: none;
	  -webkit-user-drag: none;
	}
/* Prevents IE11 from highlighting tiles in blue */
.leaflet-tile::selection {
	background: transparent;
}
/* Safari renders non-retina tile on retina better with this, but Chrome is worse */
.leaflet-safari .leaflet-tile {
	image-rendering: -webkit-optimize-contrast;
	}
/* hack that prevents hw layers "stretching" when loading new tiles */
.leaflet-safari .leaflet-tile-container {
	width: 1600px;
	height: 1600px;
	-webkit-transform-origin: 0 0;
	}
.leaflet-marker-icon,
.leaflet-marker-shadow {
	display: block;
	}
/* .leaflet-container svg: reset svg max-width decleration shipped in Joomla! (joomla.org) 3.x */
/* .leaflet-container img: map is broken in FF if you have max-width: 100% on tiles */
.leaflet-container .leaflet-overlay-pane svg {
	max-width: none !important;
	max-height: none !important;
	}
.leaflet-container .leaflet-marker-pane img,
.leaflet-container .leaflet-shadow-pane img,
.leaflet-container .leaflet-tile-pane img,
.leaflet-container img.leaflet-image-layer,
.leaflet-container .leaflet-tile {
	max-width: none !important;
	max-height: none !important;
	width: auto;
	padding: 0;
	}

.leaflet-container img.leaflet-tile {
	/* See: https://bugs.chromium.org/p/chromium/issues/detail?id=600120 */
	mix-blend-mode: plus-lighter;
}

.leaflet-container.leaflet-touch-zoom {
	-ms-touch-action: pan-x pan-y;
	touch-action: pan-x pan-y;
	}
.leaflet-container.leaflet-touch-drag {
	-ms-touch-action: pinch-zoom;
	/* Fallback for FF which doesn't support pinch-zoom */
	touch-action: none;
	touch-action: pinch-zoom;
}
.leaflet-container.leaflet-touch-drag.leaflet-touch-zoom {
	-ms-touch-action: none;
	touch-action: none;
}
.leaflet-container {
	-webkit-tap-highlight-color: transparent;
}
.leaflet-container a {
	-webkit-tap-highlight-color: rgba(51, 181, 229, 0.4);
}
.leaflet-tile {
	filter: inherit;
	visibility: hidden;
	}
.leaflet-tile-loaded {
	visibility: inherit;
	}
.leaflet-zoom-box {
	width: 0;
	height: 0;
	-moz-box-sizing: border-box;
	     box-sizing: border-box;
	z-index: 800;
	}
/* workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=888319 */
.leaflet-overlay-pane svg {
	-moz-user-select: none;
	}

.leaflet-pane         { z-index: 400; }

.leaflet-tile-pane    { z-index: 200; }
.leaflet-overlay-pane { z-index: 400; }
.leaflet-shadow-pane  { z-index: 500; }
.leaflet-marker-pane  { z-index: 600; }
.leaflet-tooltip-pane   { z-index: 650; }
.leaflet-popup-pane   { z-index: 700; }

.leaflet-map-pane canvas { z-index: 100; }
.leaflet-map-pane svg    { z-index: 200; }

.leaflet-vml-shape {
	width: 1px;
	height: 1px;
	}
.lvml {
	behavior: url(#default#VML);
	display: inline-block;
	position: absolute;
	}


/* control positioning */

.leaflet-control {
	position: relative;
	z-index: 800;
	pointer-events: visiblePainted; /* IE 9-10 doesn't have auto */
	pointer-events: auto;
	}
.leaflet-top,
.leaflet-bottom {
	position: absolute;
	z-index: 1000;
	pointer-events: none;
	}
.leaflet-top {
	top: 0;
	}
.leaflet-right {
	right: 0;
	}
.leaflet-bottom {
	bottom: 0;
	}
.leaflet-left {
	left: 0;
	}
.leaflet-control {
	float: left;
	clear: both;
	}
.leaflet-right .leaflet-control {
	float: right;
	}
.leaflet-top .leaflet-control {
	margin-top: 10px;
	}
.leaflet-bottom .leaflet-control {
	margin-bottom: 10px;
	}
.leaflet-left .leaflet-control {
	margin-left: 10px;
	}
.leaflet-right .leaflet-control {
	margin-right: 10px;
	}


/* zoom and fade animations */

.leaflet-fade-anim .leaflet-popup {
	opacity: 0;
	-webkit-transition: opacity 0.2s linear;
	   -moz-transition: opacity 0.2s linear;
	        transition: opacity 0.2s linear;
	}
.leaflet-fade-anim .leaflet-map-pane .leaflet-popup {
	opacity: 1;
	}
.leaflet-zoom-animated {
	-webkit-transform-origin: 0 0;
	    -ms-transform-origin: 0 0;
	        transform-origin: 0 0;
	}
svg.leaflet-zoom-animated {
	will-change: transform;
}

.leaflet-zoom-anim .leaflet-zoom-animated {
	-webkit-transition: -webkit-transform 0.25s cubic-bezier(0,0,0.25,1);
	   -moz-transition:    -moz-transform 0.25s cubic-bezier(0,0,0.25,1);
	        transition:         transform 0.25s cubic-bezier(0,0,0.25,1);
	}
.leaflet-zoom-anim .leaflet-tile,
.leaflet-pan-anim .leaflet-tile {
	-webkit-transition: none;
	   -moz-transition: none;
	        transition: none;
	}

.leaflet-zoom-anim .leaflet-zoom-hide {
	visibility: hidden;
	}


/* cursors */

.leaflet-interactive {
	cursor: pointer;
	}
.leaflet-grab {
	cursor: -webkit-grab;
	cursor:    -moz-grab;
	cursor:         grab;
	}
.leaflet-crosshair,
.leaflet-crosshair .leaflet-interactive {
	cursor: crosshair;
	}
.leaflet-popup-pane,
.leaflet-control {
	cursor: auto;
	}
.leaflet-dragging .leaflet-grab,
.leaflet-dragging .leaflet-grab .leaflet-interactive,
.leaflet-dragging .leaflet-marker-draggable {
	cursor: move;
	cursor: -webkit-grabbing;
	cursor:    -moz-grabbing;
	cursor:         grabbing;
	}

/* marker & overlays interactivity */
.leaflet-marker-icon,
.leaflet-marker-shadow,
.leaflet-image-layer,
.leaflet-pane > svg path,
.leaflet-tile-container {
	pointer-events: none;
	}

.leaflet-marker-icon.leaflet-interactive,
.leaflet-image-layer.leaflet-interactive,
.leaflet-pane > svg path.leaflet-interactive,
svg.leaflet-image-layer.leaflet-interactive path {
	pointer-events: visiblePainted; /* IE 9-10 doesn't have auto */
	pointer-events: auto;
	}

/* visual tweaks */

.leaflet-container {
	background: #ddd;
	outline-offset: 1px;
	}
.leaflet-container a {
	color: #0078A8;
	}
.leaflet-zoom-box {
	border: 2px dotted #38f;
	background: rgba(255,255,255,0.5);
	}


/* general typography */
.leaflet-container {
	font-family: "Helvetica Neue", Arial, Helvetica, sans-serif;
	font-size: 12px;
	font-size: 0.75rem;
	line-height: 1.5;
	}


/* general toolbar styles */

.leaflet-bar {
	box-shadow: 0 1px 5px rgba(0,0,0,0.65);
	border-radius: 4px;
	}
.leaflet-bar a {
	background-color: #fff;
	border-bottom: 1px solid #ccc;
	width: 26px;
	height: 26px;
	line-height: 26px;
	display: block;
	text-align: center;
	text-decoration: none;
	color: black;
	}
.leaflet-bar a,
.leaflet-control-layers-toggle {
	background-position: 50% 50%;
	background-repeat: no-repeat;
	display: block;
	}
.leaflet-bar a:hover,
.leaflet-bar a:focus {
	background-color: #f4f4f4;
	}
.leaflet-bar a:first-child {
	border-top-left-radius: 4px;
	border-top-right-radius: 4px;
	}
.leaflet-bar a:last-child {
	border-bottom-left-radius: 4px;
	border-bottom-right-radius: 4px;
	border-bottom: none;
	}
.leaflet-bar a.leaflet-disabled {
	cursor: default;
	background-color: #f4f4f4;
	color: #bbb;
	}

.leaflet-touch .leaflet-bar a {
	width: 30px;
	height: 30px;
	line-height: 30px;
	}
.leaflet-touch .leaflet-bar a:first-child {
	border-top-left-radius: 2px;
	border-top-right-radius: 2px;
	}
.leaflet-touch .leaflet-bar a:last-child {
	border-bottom-left-radius: 2px;
	border-bottom-right-radius: 2px;
	}

/* zoom control */

.leaflet-control-zoom-in,
.leaflet-control-zoom-out {
	font: bold 18px 'Lucida Console', Monaco, monospace;
	text-indent: 1px;
	}

.leaflet-touch .leaflet-control-zoom-in, .leaflet-touch .leaflet-control-zoom-out  {
	font-size: 22px;
	}


/* layers control */

.leaflet-control-layers {
	box-shadow: 0 1px 5px rgba(0,0,0,0.4);
	background: #fff;
	border-radius: 5px;
	}
.leaflet-control-layers-toggle {
	background-image: url(images/layers.png);
	width: 36px;
	height: 36px;
	}
.leaflet-retina .leaflet-control-layers-toggle {
	background-image: url(images/layers-2x.png);
	background-size: 26px 26px;
	}
.leaflet-touch .leaflet-control-layers-toggle {
	width: 44px;
	height: 44px;
	}
.leaflet-control-layers .leaflet-control-layers-list,
.leaflet-control-layers-expanded .leaflet-control-layers-toggle {
	display: none;
	}
.leaflet-control-layers-expanded .leaflet-control-layers-list {
	display: block;
	position: relative;
	}
.leaflet-control-layers-expanded {
	padding: 6px 10px 6px 6px;
	color: #333;
	background: #fff;
	}
.leaflet-control-layers-scrollbar {
	overflow-y: scroll;
	overflow-x: hidden;
	padding-right: 5px;
	}
.leaflet-control-layers-selector {
	margin-top: 2px;
	position: relative;
	top: 1px;
	}
.leaflet-control-layers label {
	display: block;
	font-size: 13px;
	font-size: 1.08333em;
	}
.leaflet-control-layers-separator {
	height: 0;
	border-top: 1px solid #ddd;
	margin: 5px -10px 5px -6px;
	}

/* Default icon URLs */
.leaflet-default-icon-path { /* used only in path-guessing heuristic, see L.Icon.Default */
	background-image: url(images/marker-icon.png);
	}


/* attribution and scale controls */

.leaflet-container .leaflet-control-attribution {
	background: #fff;
	background: rgba(255, 255, 255, 0.8);
	margin: 0;
	}
.leaflet-control-attribution,
.leaflet-control-scale-line {
	padding: 0 5px;
	color: #333;
	line-height: 1.4;
	}
.leaflet-control-attribution a {
	text-decoration: none;
	}
.leaflet-control-attribution a:hover,
.leaflet-control-attribution a:focus {
	text-decoration: underline;
	}
.leaflet-attribution-flag {
	display: inline !important;
	vertical-align: baseline !important;
	width: 1em;
	height: 0.6669em;
	}
.leaflet-left .leaflet-control-scale {
	margin-left: 5px;
	}
.leaflet-bottom .leaflet-control-scale {
	margin-bottom: 5px;
	}
.leaflet-control-scale-line {
	border: 2px solid #777;
	border-top: none;
	line-height: 1.1;
	padding: 2px 5px 1px;
	white-space: nowrap;
	-moz-box-sizing: border-box;
	     box-sizing: border-box;
	background: rgba(255, 255, 255, 0.8);
	text-shadow: 1px 1px #fff;
	}
.leaflet-control-scale-line:not(:first-child) {
	border-top: 2px solid #777;
	border-bottom: none;
	margin-top: -2px;
	}
.leaflet-control-scale-line:not(:first-child):not(:last-child) {
	border-bottom: 2px solid #777;
	}

.leaflet-touch .leaflet-control-attribution,
.leaflet-touch .leaflet-control-layers,
.leaflet-touch .leaflet-bar {
	box-shadow: none;
	}
.leaflet-touch .leaflet-control-layers,
.leaflet-touch .leaflet-bar {
	border: 2px solid rgba(0,0,0,0.2);
	background-clip: padding-box;
	}


/* popup */

.leaflet-popup {
	position: absolute;
	text-align: center;
	margin-bottom: 20px;
	}
.leaflet-popup-content-wrapper {
	padding: 1px;
	text-align: left;
	border-radius: 12px;
	}
.leaflet-popup-content {
	margin: 13px 24px 13px 20px;
	line-height: 1.3;
	font-size: 13px;
	font-size: 1.08333em;
	min-height: 1px;
	}
.leaflet-popup-content p {
	margin: 17px 0;
	margin: 1.3em 0;
	}
.leaflet-popup-tip-container {
	width: 40px;
	height: 20px;
	position: absolute;
	left: 50%;
	margin-top: -1px;
	margin-left: -20px;
	overflow: hidden;
	pointer-events: none;
	}
.leaflet-popup-tip {
	width: 17px;
	height: 17px;
	padding: 1px;

	margin: -10px auto 0;
	pointer-events: auto;

	-webkit-transform: rotate(45deg);
	   -moz-transform: rotate(45deg);
	    -ms-transform: rotate(45deg);
	        transform: rotate(45deg);
	}
.leaflet-popup-content-wrapper,
.leaflet-popup-tip {
	background: white;
	color: #333;
	box-shadow: 0 3px 14px rgba(0,0,0,0.4);
	}
.leaflet-container a.leaflet-popup-close-button {
	position: absolute;
	top: 0;
	right: 0;
	border: none;
	text-align: center;
	width: 24px;
	height: 24px;
	font: 16px/24px Tahoma, Verdana, sans-serif;
	color: #757575;
	text-decoration: none;
	background: transparent;
	}
.leaflet-container a.leaflet-popup-close-button:hover,
.leaflet-container a.leaflet-popup-close-button:focus {
	color: #585858;
	}
.leaflet-popup-scrolled {
	overflow: auto;
	}

.leaflet-oldie .leaflet-popup-content-wrapper {
	-ms-zoom: 1;
	}
.leaflet-oldie .leaflet-popup-tip {
	width: 24px;
	margin: 0 auto;

	-ms-filter: "progid:DXImageTransform.Microsoft.Matrix(M11=0.70710678, M12=0.70710678, M21=-0.70710678, M22=0.70710678)";
	filter: progid:DXImageTransform.Microsoft.Matrix(M11=0.70710678, M12=0.70710678, M21=-0.70710678, M22=0.70710678);
	}

.leaflet-oldie .leaflet-control-zoom,
.leaflet-oldie .leaflet-control-layers,
.leaflet-oldie .leaflet-popup-content-wrapper,
.leaflet-oldie .leaflet-popup-tip {
	border: 1px solid #999;
	}


/* div icon */

.leaflet-div-icon {
	background: #fff;
	border: 1px solid #666;
	}


/* Tooltip */
/* Base styles for the element that has a tooltip */
.leaflet-tooltip {
	position: absolute;
	padding: 6px;
	background-color: #fff;
	border: 1px solid #fff;
	border-radius: 3px;
	color: #222;
	white-space: nowrap;
	-webkit-user-select: none;
	-moz-user-select: none;
	-ms-user-select: none;
	user-select: none;
	pointer-events: none;
	box-shadow: 0 1px 3px rgba(0,0,0,0.4);
	}
.leaflet-tooltip.leaflet-interactive {
	cursor: pointer;
	pointer-events: auto;
	}
.leaflet-tooltip-top:before,
.leaflet-tooltip-bottom:before,
.leaflet-tooltip-left:before,
.leaflet-tooltip-right:before {
	position: absolute;
	pointer-events: none;
	border: 6px solid transparent;
	background: transparent;
	content: "";
	}

/* Directions */

.leaflet-tooltip-bottom {
	margin-top: 6px;
}
.leaflet-tooltip-top {
	margin-top: -6px;
}
.leaflet-tooltip-bottom:before,
.leaflet-tooltip-top:before {
	left: 50%;
	margin-left: -6px;
	}
.leaflet-tooltip-top:before {
	bottom: 0;
	margin-bottom: -12px;
	border-top-color: #fff;
	}
.leaflet-tooltip-bottom:before {
	top: 0;
	margin-top: -12px;
	margin-left: -6px;
	border-bottom-color: #fff;
	}
.leaflet-tooltip-left {
	margin-left: -6px;
}
.leaflet-tooltip-right {
	margin-left: 6px;
}
.leaflet-tooltip-left:before,
.leaflet-tooltip-right:before {
	top: 50%;
	margin-top: -6px;
	}
.leaflet-tooltip-left:before {
	right: 0;
	margin-right: -12px;
	border-left-color: #fff;
	}
.leaflet-tooltip-right:before {
	left: 0;
	margin-left: -12px;
	border-right-color: #fff;
	}

/* Printing */

@media print {
	/* Prevent printers from removing background-images of controls. */
	.leaflet-control {
		-webkit-print-color-adjust: exact;
		print-color-adjust: exact;
		}
	}
`;
const SW_JS = "self.addEventListener('install',function(e){self.skipWaiting();});self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});self.addEventListener('fetch',function(e){});";

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  try {
    if (p === '/api/tracks' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const id = id16(), publishKey = key24();
      const meta = { id, name: (body.name || 'Navigation').toString().slice(0, 80), keyHash: sha(publishKey), createdAt: Date.now(), fleets: [] };
      await store.create(meta);
      await store.devSet(meta.keyHash, id);
      return json(res, 201, { id, publishKey, name: meta.name });
    }
    const mTrack = p.match(/^\/api\/tracks\/([a-f0-9]{16})$/);
    const mPos = p.match(/^\/api\/tracks\/([a-f0-9]{16})\/positions$/);
    const mStream = p.match(/^\/api\/tracks\/([a-f0-9]{16})\/stream$/);

    if (mTrack && req.method === 'GET') {
      const meta = await store.getMeta(mTrack[1]); if (!meta) return json(res, 404, { error: 'introuvable' });
      const pts = await store.points(mTrack[1]);
      const since = num(parseFloat(u.searchParams.get('since'))) || 0;
      const out = since ? pts.filter((x) => x[2] > since) : pts;
      const last = pts.length ? pts[pts.length - 1] : null;
      return json(res, 200, { id: meta.id, name: meta.name, createdAt: meta.createdAt, count: pts.length, last, points: out, fleets: (meta.fleets || []).length });
    }
    if (mPos && req.method === 'POST') {
      const meta = await store.getMeta(mPos[1]); if (!meta) return json(res, 404, { error: 'introuvable' });
      if (sha(req.headers['x-publish-key'] || '') !== meta.keyHash) return json(res, 401, { error: 'clé invalide' });
      await store.devSet(meta.keyHash, mPos[1]);
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const raw = Array.isArray(body.points) ? body.points : [body];
      const norm = [];
      for (const q of raw) {
        const lat = num(q.lat), lon = num(q.lon);
        if (lat === null || lon === null) continue;
        const sog = num(q.sog), cog = num(q.cog);
        norm.push([r6(lat), r6(lon), Math.round(num(q.t) || Date.now()), sog === null ? null : Math.round(sog * 10) / 10, cog === null ? null : Math.round(cog)]);
      }
      let count = 0;
      if (norm.length) { count = await store.append(mPos[1], norm); for (const pt of norm) { broadcast(mPos[1], pt); if (meta.fleets && meta.fleets.length) for (const fid of meta.fleets) broadcastFleet(fid, { b: mPos[1], n: meta.name, p: pt }); } }
      return json(res, 200, { ok: true, added: norm.length, count });
    }
    if (mStream && req.method === 'GET') {
      const meta = await store.getMeta(mStream[1]); if (!meta) return json(res, 404, { error: 'introuvable' });
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }, CORS));
      res.write('retry: 5000\n\n');
      if (!clients.has(meta.id)) clients.set(meta.id, new Set());
      clients.get(meta.id).add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); const s = clients.get(meta.id); if (s) { s.delete(res); if (!s.size) clients.delete(meta.id); } });
      return;
    }

    if (p === '/api/fleets' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const fid = id16();
      const fm = { id: fid, name: (body.name || 'Flotte').toString().slice(0, 80), createdAt: Date.now() };
      await store.fleetCreate(fm);
      await store.fleetIndexAdd(fm.id);
      return json(res, 201, fm);
    }
    if (p.indexOf('/api/admin/') === 0) {
      if (!ADMIN_KEY) return json(res, 503, { error: 'Console non configuree : ajoute la variable ADMIN_KEY sur le serveur.' });
      const k = req.headers['x-admin-key'] || u.searchParams.get('k') || '';
      if (k !== ADMIN_KEY) return json(res, 401, { error: 'Cle console invalide' });

      if (p === '/api/admin/diag' && req.method === 'GET') {
        const names = Object.keys(process.env).filter((n) => /AIS|OWM|UPSTASH|ADMIN|DATA|PORT|VESSEL/i.test(n));
        const suivis = aisInfo.size, total = Object.keys(aisMap).length;
        const horsPlafond = aisHorsPlafond();
        const resume = [
          'Version ' + BUILD,
          'Bateaux AIS : ' + suivis + ' suivi(s) actif(s), ' + aisExclus.length + ' desactive(s) (case Emet), ' + aisOrphelins.length + ' orphelin(s) — ' + total + ' MMSI enregistres',
          'Mode aisstream : ' + (aisMode === 'zone'
            ? ('zone geographique (' + aisZoneInfo + ') — sans limite de nombre, ' + aisHorsFlotte + ' message(s) de bateaux tiers ignore(s)')
            : 'filtre MMSI (plafond 50 impose par le service, aucun palier superieur disponible)'),
          horsPlafond.length
            ? 'Plafond aisstream : ' + AIS_PLAFOND + ' MMSI en temps reel, ' + horsPlafond.length + ' bateau(x) uniquement via VesselAPI'
            : 'Plafond aisstream : ' + suivis + '/' + AIS_PLAFOND + ' MMSI, aucun bateau exclu',
          'Positions AIS enregistrees depuis le demarrage : ' + aisIngeres
            + ' — ' + Array.from(aisInfo.keys()).filter(function (m) { return !aisLastT.get(m); }).length + ' bateau(x) jamais recu(s)',
          'VesselAPI : ' + (VAPI_KEY ? (vapiLastEvent
            + ' — ' + (function () {
                const tr = new Set(aisPrioritaires());
                const horsTR = Array.from(aisInfo.keys()).filter((m) => !tr.has(m)).length;
                const lots = Math.ceil(horsTR / 50);
                const parJour = vapiPollMs > 0 ? Math.round(lots * 86400000 / vapiPollMs) : 0;
                return horsTR + ' bateau(x) a interroger (' + lots + ' lot(s)), '
                  + (vapiQuotaRestant !== null ? 'quota restant ' + vapiQuotaRestant + ', ' : '')
                  + (vapiPollMs ? Math.round(vapiPollMs / 60000) + ' min entre interrogations, ~' + parJour + ' requete(s)/jour' : 'inactif');
              })()) : 'cle absente'),
            + (VAPI_KEY && vapiPollMs ? ' — 1 interrogation toutes les ' + Math.round(vapiPollMs / 60000) + ' min' : ''),
          'aisstream : ' + (AIS_KEY ? (aisWs ? 'connecte' : 'deconnecte') + ' — ' + aisLastEvent + (aisDerniereErreur ? ' — derniere erreur serveur : ' + aisDerniereErreur : '') + (aisProchain > Date.now() ? ' (attente ' + Math.round((aisProchain - Date.now()) / 60000) + ' min)' : '') : 'non configure'),
          'Messages AIS recus par type : ' + (Object.keys(aisParType).length
              ? Object.keys(aisParType).sort((a, b) => aisParType[b] - aisParType[a]).map((k) => k + ' x' + aisParType[k]).join(', ')
              : 'aucun message recu'),
          'Positions retenues : ' + aisPosOk + ' — ecartees : ' + aisRejetInconnu + ' hors liste, ' + aisRejetCoord + ' sans coordonnees',
          'Stockage : ' + (stockErreurs ? stockErreurs + ' erreur(s) — ' + stockDerniereErreur : 'aucune erreur'),
          'API : ' + (apiErreurs ? apiErreurs + ' erreur(s) — ' + apiDerniereErreur : 'aucune erreur'),
          'Archive longue duree : ' + archiveInfo
            + (archiveStats.dernierPassage ? ' — dernier passage ' + archiveStats.dernierPassage.slice(11, 16)
               + ' UTC : ' + archiveStats.pointsArchives + ' point(s) archive(s), ' + archiveStats.erreurs + ' erreur(s)' : '')
            + (archiveDernier ? ' — ' + archiveDernier : ''),
          'Trait de cote (fleches/routeur) : ' + terreInfo,
          'Courants 2D Shom : ' + c2dInfo + (mareeDerniereErreur ? ' — maree : derniere erreur ' + mareeDerniereErreur : ' — maree : ' + (mareeCache.size ? mareeCache.size + ' port(s) en cache' : 'pas encore interrogee')),
          'Meteo OWM : ' + (process.env.OWM_API_KEY ? 'cle presente' : 'absente')
        ];
        return json(res, 200, {
          resume: resume,
          build: BUILD,
          varsVues: names.map((n) => ({ nom: n, longueurNom: n.length, valeurRenseignee: !!process.env[n], longueurValeur: (process.env[n] || '').length })),
          aisKeyDetectee: !!AIS_KEY,
          aisKeyLongueur: AIS_KEY.length,
          websocketDispo: typeof WebSocket === 'function',
          aisConnexion: aisWs ? 'ouverte' : 'fermee',
          aisDernierEvenement: aisLastEvent,
          aisMmsiSuivis: Array.from(aisInfo.keys()),
          /* etat par bateau suivi : temps reel ou non, sans flotte (donc muet
             en diffusion), age de la derniere position recue par ce serveur */
          aisDetail: (function () {
            const rt = new Set(aisPrioritaires());
            const out = [];
            for (const [mmsi, inf] of aisInfo) {
              const t = aisLastT.get(mmsi) || 0;
              out.push({
                mmsi: mmsi,
                nom: inf.name,
                tempsReel: rt.has(mmsi),
                flottes: inf.fleets.length,
                intervalleMin: Math.round(inf.ms / 60000),
                dernierRecuIlYaMin: t ? Math.round((Date.now() - t) / 60000) : null
              });
            }
            out.sort(function (a, b) { return (b.dernierRecuIlYaMin === null ? 1 : 0) - (a.dernierRecuIlYaMin === null ? 1 : 0) || (b.dernierRecuIlYaMin || 0) - (a.dernierRecuIlYaMin || 0); });
            for (const x of aisExclus) out.push({ mmsi: x.mmsi, tid: x.tid, nom: x.nom, desactive: true });
            return out;
          })(),
          aisMmsiOrphelins: aisOrphelins,
          aisPositionsIngerees: aisIngeres,
          aisMmsiEnregistres: Object.keys(aisMap).length,
          aisPlafond: AIS_PLAFOND,
          aisMmsiHorsPlafond: horsPlafond,
          aisAbonnes: aisSubCount,
          aisMessagesRecus: aisMsgCount,
          aisDernierMessageIlYaSec: aisLastMsgAt ? Math.round((Date.now() - aisLastMsgAt) / 1000) : null,
          vesselapiCleDetectee: !!VAPI_KEY,
          vesselapiIntervalleSec: vapiPollMs ? Math.round(vapiPollMs / 1000) : null,
          vesselapiDernierEvenement: vapiLastEvent,
          vesselapiPositionsEnregistrees: vapiPositions,
          vesselapiDerniereLectureIlYaSec: vapiLastAt ? Math.round((Date.now() - vapiLastAt) / 1000) : null,
          vesselapiReponseBrute: vapiBrut,
          stockageErreurs: stockErreurs,
          stockageDerniereErreur: stockDerniereErreur || null,
          apiErreurs: apiErreurs,
          apiDerniereErreur: apiDerniereErreur || null,
          apiDerniereErreurIlYaSec: apiDerniereErreurAt ? Math.round((Date.now() - apiDerniereErreurAt) / 1000) : null
        });
      }
      if (p === '/api/admin/aistest' && req.method === 'GET') {
        if (!AIS_KEY) return json(res, 200, { ok: false, raison: 'aucune cle AIS configuree' });
        if (typeof WebSocket !== 'function') return json(res, 200, { ok: false, raison: 'websocket indisponible' });
        const filtre = u.searchParams.get('filtre') === '1';
        if (Date.now() < aisProchain) return json(res, 200, { ok: false, verdict: 'Tentatives en pause : le service nous a limites (429). Prochain essai dans ' + Math.round((aisProchain - Date.now()) / 60000) + ' min. Ne pas relancer ce test entre-temps.' });
        const list = Object.keys(aisMap).slice(0, 50);
        const out = { filtreMmsi: filtre, mmsi: filtre ? list : 'aucun (ecoute mondiale)', etapes: [], messagesRecus: 0 };
        const t0 = Date.now();
        // 1) le serveur joint-il seulement l'hote ?
        for (const cible of ['https://aisstream.io/', 'https://stream.aisstream.io/v0/stream']) {
          const d0 = Date.now();
          try {
            const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000);
            const r = await fetch(cible, { signal: ctrl.signal });
            clearTimeout(to);
            out.etapes.push('HTTPS ' + cible + ' -> ' + r.status + ' (' + (Date.now() - d0) + ' ms)');
          } catch (e) {
            out.etapes.push('HTTPS ' + cible + ' -> echec: ' + ((e && (e.cause && e.cause.code || e.name || e.message)) || 'inconnu'));
          }
        }
        // 2) puis la connexion temps reel
        await new Promise((resolve) => {
          let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
          let ws;
          try { ws = new WebSocket('wss://stream.aisstream.io/v0/stream'); }
          catch (e) { out.etapes.push('creation impossible: ' + (e && e.message)); return fin(); }
          const to = setTimeout(() => { out.etapes.push('aucune reponse en 12 s'); try { ws.close(); } catch {} fin(); }, 12000);
          ws.onopen = () => {
            out.etapes.push('connexion ouverte (' + (Date.now() - t0) + ' ms)');
            const sub = { APIKey: AIS_KEY, BoundingBoxes: [[[-90, -180], [90, 180]]], FilterMessageTypes: ['PositionReport'] };
            if (filtre && list.length) sub.FiltersShipMMSI = list;
            try { ws.send(JSON.stringify(sub)); out.etapes.push('abonnement envoye'); }
            catch (e) { out.etapes.push('envoi impossible'); }
          };
          ws.onmessage = (ev) => {
            out.messagesRecus++;
            if (out.messagesRecus === 1) {
              const txt = String(ev.data).slice(0, 180);
              out.etapes.push('1er message en ' + (Date.now() - t0) + ' ms : ' + txt);
              clearTimeout(to); try { ws.close(); } catch {} fin();
            }
          };
          ws.onerror = (ev) => { const e = ev && (ev.error || ev.message); out.etapes.push('erreur websocket' + (e ? ': ' + String(e.cause && e.cause.code || e.message || e).slice(0, 140) : '')); };
          ws.onclose = (ev) => {
            out.etapes.push('ferme' + (ev && ev.code ? ' (code ' + ev.code + ')' : '') + (ev && ev.reason ? ' : ' + String(ev.reason).slice(0, 120) : ''));
            clearTimeout(to); fin();
          };
        });
        out.ok = out.messagesRecus > 0;
        out.verdict = out.ok ? 'La liaison AIS fonctionne.' : 'Aucun message recu — voir les etapes.';
        return json(res, 200, out);
      }
      if (p === '/api/admin/meteotest' && req.method === 'GET') {
        const k = process.env.OWM_API_KEY || '';
        if (!k) return json(res, 200, { ok: false, raison: 'aucune cle OWM_API_KEY configuree' });
        const out = { cleLongueur: k.length, essais: [] };
        const cibles = [
          ['donnees (weather)', 'https://api.openweathermap.org/data/2.5/weather?lat=47.7&lon=-3.4&appid=' + k],
          ['tuile nuages', 'https://tile.openweathermap.org/map/clouds_new/4/7/5.png?appid=' + k],
          ['tuile vent', 'https://tile.openweathermap.org/map/wind_new/4/7/5.png?appid=' + k]
        ];
        for (const [nom, url] of cibles) {
          try {
            const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000);
            const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(to);
            const ct = r.headers.get('content-type') || '';
            let detail = '';
            if (!r.ok) { const t = await r.text(); detail = ' — ' + t.slice(0, 120); }
            else if (ct.indexOf('image') >= 0) { const b = await r.arrayBuffer(); detail = ' — image ' + b.byteLength + ' octets'; }
            out.essais.push({ cible: nom, code: r.status, type: ct.split(';')[0], detail });
          } catch (e) { out.essais.push({ cible: nom, erreur: (e && (e.name || e.message)) || 'echec' }); }
        }
        const tuiles = out.essais.filter((e) => e.cible.indexOf('tuile') === 0);
        out.ok = tuiles.every((e) => e.code === 200);
        out.verdict = out.ok ? 'Les tuiles meteo fonctionnent.' : (out.essais[0] && out.essais[0].code === 401 ? 'Cle refusee par OpenWeatherMap.' : 'Les tuiles ne sont pas accessibles avec cette cle.');
        return json(res, 200, out);
      }
      if (p === '/api/admin/fleets' && req.method === 'GET') {
        const ids = await store.fleetIndex();
        const lots = await Promise.all(ids.map(async (fid) => {
          try {
            const [f, mem] = await Promise.all([store.fleetGet(fid), store.fleetMembers(fid).catch(() => [])]);
            if (!f) return null;
            const mn = num(f.aisIntervalMin);
            return { id: fid, name: f.name, createdAt: f.createdAt, boats: (mem || []).length, aisIntervalMin: (mn !== null && mn >= 1 && mn <= 180) ? mn : AIS_DEFAULT_MIN };
          } catch { return null; }
        }));
        const out = lots.filter(Boolean);
        out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return json(res, 200, { fleets: out, aisEnabled: !!(AIS_KEY || VAPI_KEY) });
      }

      if (p === '/api/admin/fleets' && req.method === 'POST') {
        let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
        let names = [];
        if (Array.isArray(body.names)) names = body.names;
        else if (body.name) names = String(body.name).split(/[,\n]/);
        names = names.map((x) => String(x).trim().slice(0, 80)).filter(Boolean);
        if (!names.length) return json(res, 400, { error: 'Indique au moins un nom de flotte' });
        if (names.length > 20) return json(res, 400, { error: 'Maximum 20 flottes a la fois' });
        const created = [];
        for (const nm of names) {
          const fid = id16();
          const fm2 = { id: fid, name: nm, createdAt: Date.now() };
          await store.fleetCreate(fm2);
          await store.fleetIndexAdd(fid);
          created.push({ id: fid, name: nm });
        }
        return json(res, 201, { created });
      }

      if (p === '/api/admin/adopt' && req.method === 'POST') {
        let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
        const fid = String(body.id || '').trim().toLowerCase();
        if (!/^[a-f0-9]{16}$/.test(fid)) return json(res, 400, { error: 'Identifiant de flotte invalide' });
        const f = await store.fleetGet(fid); if (!f) return json(res, 404, { error: 'Aucune flotte avec cet identifiant' });
        await store.fleetIndexAdd(fid);
        return json(res, 200, { id: fid, name: f.name });
      }

      if (p === '/api/admin/archive' && req.method === 'POST') {
        if (!ARCHIVE_ACTIVE) return json(res, 503, { error: 'archivage non configure (variables S3 absentes)' });
        const st = await archiveBasculer(true);
        return json(res, 200, { ok: true, ...st, dernierMessage: archiveDernier || null });
      }
      if (p === '/api/admin/suivi' && req.method === 'POST') {
        let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
        const ids = Array.isArray(body.ids) ? body.ids.filter((x) => /^[a-f0-9]{16}$/.test(String(x))) : [];
        const actif = body.suivi !== false;
        if (!ids.length) return json(res, 400, { error: 'aucun bateau' });
        let n = 0, echecs = 0;
        const LOT = 8;
        for (let i = 0; i < ids.length; i += LOT) {
          const lot = ids.slice(i, i + LOT);
          const r = await Promise.all(lot.map(async (id) => {
            for (let essai = 0; essai < 3; essai++) {
              try { const m = await store.getMeta(id); if (!m) return false; m.suivi = actif; await store.setMeta(m); return true; }
              catch { await new Promise((z) => setTimeout(z, 120 * (essai + 1))); }
            }
            return null;
          }));
          for (const x of r) { if (x === true) n++; else if (x === null) echecs++; }
        }
        await aisRefresh(false);
        return json(res, 200, { modifies: n, echecs, suivi: actif, suivis: aisInfo.size, total: ids.length });
      }
      const mAdmB = p.match(/^\/api\/admin\/boats\/([a-f0-9]{16})$/);
      if (mAdmB && req.method === 'POST') {
        let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
        const nm = String(body.name || '').trim().slice(0, 80);
        if (!nm) return json(res, 400, { error: 'Nom vide' });
        const meta = await store.getMeta(mAdmB[1]); if (!meta) return json(res, 404, { error: 'bateau introuvable' });
        meta.name = nm; await store.setMeta(meta); await aisRefresh(false);
        return json(res, 200, { id: mAdmB[1], name: nm });
      }
      const mAdmF = p.match(/^\/api\/admin\/fleets\/([a-f0-9]{16})$/);
      if (mAdmF && req.method === 'POST') {
        let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
        const nm = String(body.name || '').trim().slice(0, 80);
        if (!nm) return json(res, 400, { error: 'Nom vide' });
        const f = await store.fleetUpdate(mAdmF[1], { name: nm });
        if (!f) return json(res, 404, { error: 'flotte introuvable' });
        return json(res, 200, { id: mAdmF[1], name: nm });
      }
      if (mAdmF && req.method === 'DELETE') {
        const detaches = await fleetDetachAll(mAdmF[1]);
        await store.fleetDelete(mAdmF[1]);
        await aisRefresh(false);
        return json(res, 200, { ok: true, detaches });
      }
      /* purge complete d'un bateau : traces, meta, appartenances et entree MMSI */
      if (mAdmB && req.method === 'DELETE') {
        const tid = mAdmB[1];
        const meta = await store.getMeta(tid);
        if (!meta) return json(res, 404, { error: 'bateau introuvable' });
        for (const fid of (meta.fleets || [])) {
          try { await store.fleetRemove(fid, tid); broadcastFleet(fid, { rm: tid }); } catch {}
        }
        if (meta.mmsi) { try { await store.mmsiDel(String(meta.mmsi)); } catch {} }
        try { await store.boatDelete(tid); } catch {}
        await aisRefresh(false);
        return json(res, 200, { ok: true, nom: meta.name, mmsi: meta.mmsi || null });
      }
      return json(res, 404, { error: 'route console inconnue' });
    }
    const mFleetRemove = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/remove$/);
    if (mFleetRemove && req.method === 'POST') {
      if (!adminOk(req, u)) return json(res, 401, ERR_GESTION);
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const tid = String(body.trackId || '');
      if (!/^[a-f0-9]{16}$/.test(tid)) return json(res, 400, { error: 'trackId invalide' });
      await fleetDetach(mFleetRemove[1], tid);
      tracesVider(mFleetRemove[1]);
      broadcastFleet(mFleetRemove[1], { rm: tid });
      await aisRefresh(false);
      return json(res, 200, { ok: true });
    }
    const mFleetSet = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/settings$/);
    if (mFleetSet) {
      const fid = mFleetSet[1];
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      if (req.method === 'GET') {
        const mn = num(fleet.aisIntervalMin);
        return json(res, 200, { aisIntervalMin: (mn !== null && mn >= 1 && mn <= 180) ? mn : AIS_DEFAULT_MIN, aisEnabled: !!(AIS_KEY || VAPI_KEY), aisDefaultMin: AIS_DEFAULT_MIN });
      }
      if (req.method === 'POST') {
        if (!adminOk(req, u)) return json(res, 401, ERR_GESTION);
        let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
        const mn = num(parseInt(body.aisIntervalMin, 10));
        if (mn === null || mn < 1 || mn > 180) return json(res, 400, { error: 'Intervalle attendu entre 1 et 180 minutes' });
        await store.fleetUpdate(fid, { aisIntervalMin: mn });
        await aisRefresh(false);
        return json(res, 200, { aisIntervalMin: mn });
      }
    }
    const mFleetImp = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/mmsi\/import$/);
    if (mFleetImp && req.method === 'POST') {
      const fid = mFleetImp[1];
      if (!adminOk(req, u)) return json(res, 401, ERR_GESTION);
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      if (!AIS_KEY && !VAPI_KEY) return json(res, 503, { error: 'Suivi AIS non configure sur ce serveur' });
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      let lignes = [];
      try {
        if (body.b64) lignes = lignesDepuisFichier(body.name || '', Buffer.from(String(body.b64), 'base64'));
        else if (body.text) lignes = String(body.text).split(/\r?\n/);
      } catch { return json(res, 400, { error: 'Fichier illisible' }); }
      if (body.apercu) {
        const ex = [];
        for (const l of lignes) {
          const ch = champsLigne(l);
          const nums = (String(l).match(/\b\d{9}\b/g) || []);
          if (!nums.length) continue;
          ex.push({ champs: ch.slice(0, 12), mmsi: nums.find((v) => !mmsiEcarte(v)) || nums[0] });
          if (ex.length >= 3) break;
        }
        return json(res, 200, { apercu: ex, lignes: lignes.length });
      }
      const col = (body.colonne === null || body.colonne === undefined || body.colonne === '') ? null : (parseInt(body.colonne, 10) - 1);
      const items = parseMmsiLignes(lignes, (col !== null && col >= 0) ? col : null).slice(0, 200);
      if (!items.length) return json(res, 400, { error: 'Aucun MMSI a 9 chiffres trouve dans ce contenu' });
      const known = await store.mmsiAll();
      const bilan = { lignes: lignes.length, trouves: items.length, ajoutes: 0, deja: 0, renommes: 0, noms: [] };
      for (const it of items) {
        const mmsi = it.mmsi, nom = it.name || ('MMSI ' + mmsi);
        if (known[mmsi]) {
          try {
            const m0 = await store.getMeta(known[mmsi]);
            if (m0 && it.name && m0.name !== nom) { m0.name = nom; await store.setMeta(m0); bilan.renommes++; }
          } catch {}
          await fleetAttach(fid, known[mmsi]);
          bilan.deja++; continue;
        }
        const id = id16(), publishKey = key24();
        const meta = { id, name: nom, keyHash: sha(publishKey), createdAt: Date.now(), fleets: [fid], mmsi: mmsi };
        await store.create(meta);
        await fleetAttach(fid, id);
        await store.mmsiSet(mmsi, id);
        known[mmsi] = id;
        bilan.ajoutes++;
        if (bilan.noms.length < 5) bilan.noms.push(nom + ' (' + mmsi + ')');
      }
      tracesVider(fid);
      await aisRefresh(false);
      return json(res, 201, bilan);
    }
    const mFleetMmsi = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/mmsi$/);
    if (mFleetMmsi && req.method === 'POST') {
      const fid = mFleetMmsi[1];
      if (!adminOk(req, u)) return json(res, 401, ERR_GESTION);
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const mmsi = String(body.mmsi || '').replace(/[^0-9]/g, '');
      if (!/^[0-9]{9}$/.test(mmsi)) return json(res, 400, { error: 'MMSI invalide (9 chiffres attendus)' });
      if (!AIS_KEY && !VAPI_KEY) return json(res, 503, { error: 'Suivi AIS non configure sur ce serveur (AIS_API_KEY ou VESSELAPI_KEY manquante)' });
      const known = await store.mmsiAll();
      if (known && known[mmsi]) {
        /* MMSI deja connu : l'ajout explicite vaut intention de suivre.
           On applique le nom saisi et on reactive le suivi si la case Emet
           l'avait coupe — sinon le bateau resterait invisible sous son ancien
           nom, sans aucune source AIS, et sans que rien ne le signale. */
        const tid0 = known[mmsi];
        let renomme = false, reactive = false;
        try {
          const m0 = await store.getMeta(tid0);
          if (m0) {
            const nv = (body.name || '').toString().slice(0, 80);
            if (nv && m0.name !== nv) { m0.name = nv; renomme = true; }
            if (m0.suivi === false) { m0.suivi = true; reactive = true; }
            if (renomme || reactive) await store.setMeta(m0);
          }
        } catch {}
        await fleetAttach(fid, tid0);
        tracesVider(fid);
        await aisRefresh(true);
        return json(res, 200, { id: tid0, mmsi, already: true, renomme, reactive });
      }
      const id = id16(), publishKey = key24();
      const meta = { id, name: (body.name || ('MMSI ' + mmsi)).toString().slice(0, 80), keyHash: sha(publishKey), createdAt: Date.now(), fleets: [fid], mmsi: mmsi };
      await store.create(meta);
      await fleetAttach(fid, id);
      await store.mmsiSet(mmsi, id);
      tracesVider(fid);
      await aisRefresh(true);
      return json(res, 201, { id, mmsi, name: meta.name });
    }
    const mFleetJoin = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/join$/);
    const mFleet = p.match(/^\/api\/fleets\/([a-f0-9]{16})$/);
    const mFleetStream = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/stream$/);
    if (mFleetJoin && req.method === 'POST') {
      const fid = mFleetJoin[1];
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const id = id16(), publishKey = key24();
      const meta = { id, name: (body.name || 'Bateau').toString().slice(0, 80), keyHash: sha(publishKey), createdAt: Date.now(), fleets: [fid] };
      await store.create(meta);
      await fleetAttach(fid, id);
      await store.devSet(meta.keyHash, id);
      return json(res, 201, { id, publishKey, name: meta.name, fleet: fid });
    }
    if (mFleet && req.method === 'GET') {
      const fleet = await store.fleetGet(mFleet[1]); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      const ids = await store.fleetMembers(mFleet[1]);
      /* ?tracks=1 renvoie aussi l'historique, decime a `max` points par bateau,
         pour que la carte de flotte redessine les traces au chargement. */
      const avecTraces = u.searchParams.get('tracks') === '1';
      const demande = parseInt(u.searchParams.get('max'), 10);
      /* sans consigne, on repartit un budget global de points sur la flotte :
         400 points pour un bateau seul, ~180 pour cent bateaux. */
      const maxPts = demande
        ? Math.min(2000, Math.max(50, demande))
        : Math.min(400, Math.max(60, Math.round(12000 / Math.max(1, ids.length))));
      const depuis = num(parseFloat(u.searchParams.get('since'))) || 0;
      const cle = mFleet[1] + '|' + maxPts + '|' + depuis;
      if (avecTraces) { const vu = tracesLire(cle); if (vu) return json(res, 200, vu, req); }
      const boats = [];
      for (let i = 0; i < ids.length; i += 12) {
        const lot = await Promise.all(ids.slice(i, i + 12).map(async (id) => {
          try {
            if (avecTraces) {
              const [m, pts] = await Promise.all([store.getMeta(id), store.points(id)]);
              if (!m) return null;
              const util = depuis ? (pts || []).filter((x) => x[2] > depuis) : (pts || []);
              return { id, name: m.name, last: util.length ? util[util.length - 1] : null, mmsi: m.mmsi || null, suivi: m.suivi !== false, points: decime(util, maxPts), total: util.length };
            }
            const [m, last] = await Promise.all([store.getMeta(id), store.lastPoint(id)]);
            return m ? { id, name: m.name, last, mmsi: m.mmsi || null, suivi: m.suivi !== false } : null;
          } catch { return null; }
        }));
        for (const x of lot) if (x) boats.push(x);
      }
      const mn = num(fleet.aisIntervalMin);
      const sortie = { id: fleet.id, name: fleet.name, boats, aisIntervalMin: (mn !== null && mn >= 1 && mn <= 180) ? mn : AIS_DEFAULT_MIN };
      if (avecTraces) tracesEcrire(cle, sortie);
      return json(res, 200, sortie, req);
    }
    if (mFleetStream && req.method === 'GET') {
      const fleet = await store.fleetGet(mFleetStream[1]); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }, CORS));
      res.write('retry: 5000\n\n');
      if (!fleetClients.has(fleet.id)) fleetClients.set(fleet.id, new Set());
      fleetClients.get(fleet.id).add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); const st = fleetClients.get(fleet.id); if (st) { st.delete(res); if (!st.size) fleetClients.delete(fleet.id); } });
      return;
    }

    const mLeave = p.match(/^\/api\/tracks\/([a-f0-9]{16})\/leave$/);
    if (mLeave && req.method === 'POST') {
      const tid = mLeave[1];
      const meta = await store.getMeta(tid); if (!meta) return json(res, 404, { error: 'introuvable' });
      if (sha(req.headers['x-publish-key'] || '') !== meta.keyHash) return json(res, 401, { error: 'cle invalide' });
      const fids = meta.fleets || [];
      for (const fid of fids) { await store.fleetRemove(fid, tid); broadcastFleet(fid, { rm: tid }); }
      meta.fleets = [];
      await store.setMeta(meta);
      await aisRefresh(false);
      return json(res, 200, { ok: true, retire: fids.length });
    }
    const mExport = p.match(/^\/api\/tracks\/([a-f0-9]{16})\/export$/);
    if (mExport && req.method === 'GET') {
      const meta = await store.getMeta(mExport[1]); if (!meta) return json(res, 404, { error: 'introuvable' });
      const points = await store.points(mExport[1]);
      const fmt = (u.searchParams.get('format') || 'gpx').toLowerCase();
      const tracks = [{ name: meta.name, points }];
      if (fmt === 'csv') return sendFile(res, tracksToCSV(tracks, false), 'text/csv', fnameSafe(meta.name) + '.csv');
      return sendFile(res, tracksToGPX(tracks), 'application/gpx+xml', fnameSafe(meta.name) + '.gpx');
    }
    const mFleetExport = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/export$/);
    if (mFleetExport && req.method === 'GET') {
      const fleet = await store.fleetGet(mFleetExport[1]); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      const ids = await store.fleetMembers(mFleetExport[1]);
      const tracks = [];
      for (const id of ids){ const m = await store.getMeta(id); if (!m) continue; const pts = await store.points(id); if (pts.length) tracks.push({ name: m.name, points: pts }); }
      const fmt = (u.searchParams.get('format') || 'gpx').toLowerCase();
      const base = fnameSafe(fleet.name) + '_flotte';
      if (fmt === 'csv') return sendFile(res, tracksToCSV(tracks, true), 'text/csv', base + '.csv');
      return sendFile(res, tracksToGPX(tracks), 'application/gpx+xml', base + '.gpx');
    }
    if (p === '/api/osmand') {
      const params = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      if (req.method === 'POST') {
        const raw = await new Promise((resolve) => { let b = '', n = 0; req.on('data', (c) => { n += c.length; if (n > 1e5) { req.destroy(); resolve(''); } else b += c; }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
        const body = (raw || '').trim();
        if (body) {
          if (body[0] === '{' || body[0] === '[') {
            try { const j = JSON.parse(body); const o = Array.isArray(j) ? (j[0] || {}) : j; Object.assign(params, o); if (o.location) Object.assign(params, o.location); if (o.location && o.location.coords) Object.assign(params, o.location.coords); } catch {}
          } else { try { new URLSearchParams(body).forEach((v, k) => { if (params[k] == null) params[k] = v; }); } catch {} }
        }
      }
      const idp = params.id != null ? params.id : params.deviceId;
      const lat = num(parseFloat(params.lat != null ? params.lat : params.latitude));
      const lon = num(parseFloat(params.lon != null ? params.lon : params.longitude));
      if (!idp) { res.writeHead(400, CORS); return res.end('no id'); }
      if (lat === null || lon === null) { res.writeHead(200, CORS); return res.end('OK'); }
      const tid = await store.devGet(sha(String(idp)));
      if (!tid) { res.writeHead(404, CORS); return res.end('device inconnu'); }
      let t = Date.now(); const ts = params.timestamp != null ? params.timestamp : params.time;
      if (ts) { const tss = String(ts); if (/^\d+$/.test(tss)) { const n = parseInt(tss, 10); t = n < 1e12 ? n * 1000 : n; } else { const d = Date.parse(tss.replace(' ', 'T')); if (!isNaN(d)) t = d; } }
      const sog = num(parseFloat(params.speed));
      let cog = num(parseFloat(params.bearing)); if (cog === null) cog = num(parseFloat(params.heading)); if (cog === null) cog = num(parseFloat(params.course));
      const pt = [r6(lat), r6(lon), Math.round(t), sog === null ? null : Math.round(sog * 10) / 10, cog === null ? null : Math.round(cog)];
      const meta = await store.getMeta(tid);
      await store.append(tid, [pt]);
      broadcast(tid, pt);
      if (meta && meta.fleets && meta.fleets.length) for (const fid of meta.fleets) broadcastFleet(fid, { b: tid, n: meta.name, p: pt });
      res.writeHead(200, CORS); return res.end('OK');
    }
    if (p === '/api/wind' && req.method === 'GET') {
      const clat = num(parseFloat(u.searchParams.get('lat')));
      const clon = num(parseFloat(u.searchParams.get('lon')));
      const model = u.searchParams.get('model') || '';
      const hour = parseInt(u.searchParams.get('hour'), 10) || 0;
      const vel = await fetchWind(clat === null ? 47 : clat, clon === null ? -4 : clon, model, hour);
      return json(res, 200, vel);
    }
    if (p === '/api/forecast' && req.method === 'GET') {
      const clat = num(parseFloat(u.searchParams.get('lat')));
      const clon = num(parseFloat(u.searchParams.get('lon')));
      const model = u.searchParams.get('model') || '';
      const fc = await fetchForecast(clat === null ? 47 : clat, clon === null ? -4 : clon, model);
      return json(res, 200, fc);
    }
    /* Profondeur Litto3D au point demande, via GetFeatureInfo du WMS Shom.
       Proxy indispensable : le WMS ne sert pas d'en-tetes CORS aux navigateurs.
       Reference verticale NGF-IGN69 (pas le zero hydrographique) : valeur
       negative = sous le niveau moyen. Repond { fond: n } ou { fond: null }. */
    /* Profondeur au point demande. Deux sources en cascade :
       1. Litto3D (Shom) — resolution metrique, reference NGF-IGN69 ;
       2. EMODnet — resolution ~115 m, reference proche du zero hydrographique,
          interrogeable partout en Europe. Utilise si le Shom ne repond pas.
       Proxy indispensable (pas de CORS chez ces fournisseurs).
       ?debug=1 avec la cle de gestion : montre chaque tentative brute. */
    /* Courant de maree Shom au point demande (mode validation : h et coef
       explicites ; le calcul automatique de la phase de maree viendra avec le
       routeur). */
    /* ---- grilles pour le routeur ----
       Vent : echantillonnage Open-Meteo par lots de points (le service accepte
       des listes de coordonnees), horaire, cache par (domaine, modele, heure).
       Courant : evaluation directe du socle Shom en memoire, phase de maree
       calculee une fois par port implique. */
    /* Champ de courant de maree sur la fenetre visible : ~15 x 15 points,
       phase de maree calculee une fois par port implique. Sert au calque de
       fleches ; le calcul lui-meme reutilise le socle Shom valide. */
    /* ---- Analyse de flotte ----
       Pour chaque bateau d'une flotte : vitesse et cap LISSES sur une fenetre
       reglable (les instantanes AIS sont trop bruites pour comparer), plus,
       si une marque est fournie, le VMC (vitesse de rapprochement) et le CMG
       (cap moyen suivi). Le gain/perte se mesure sur la meme fenetre doublee.
       Tout est calcule a partir des traces deja stockees : aucune donnee
       nouvelle, aucun appel externe. */
    /* Historique complet d'un bateau : archive froide + points chauds, fusionnes
       et ordonnes. C'est l'entree unique pour toute analyse sur la duree. */
    /* Fiche d'un bateau : statistiques agregees sur tout son historique
       (archive + chaud). Tout est calcule ici, jamais dans la page : la fiche
       doit rester lisible sur un telephone sans transferer 100 000 points. */
    /* ---- Polaire OBSERVEE d'un bateau ----
       Reconstruite depuis son historique reel : pour chaque segment, vitesse
       fond mesuree, corrigee du courant de maree Shom pour obtenir la vitesse
       surface, croisee avec le vent archive au point et a l'heure. Agregation
       par tranches (TWS 2 kt, TWA 10 deg) avec MEDIANE — pas moyenne : les
       manoeuvres, les arrets et les positions aberrantes ne doivent pas tirer
       la grille. Chaque case porte son nombre de mesures : une case a 3
       mesures ne vaut pas une case a 200, et la page doit le montrer. */
    const mPolObs = p.match(/^\/api\/boats\/([a-f0-9]{16})\/polaire$/);
    if (mPolObs && req.method === 'GET') {
      const bid = mPolObs[1];
      const meta = await store.getMeta(bid);
      if (!meta) return json(res, 404, { error: 'bateau introuvable' });
      /* periode : soit une duree en jours, soit un intervalle explicite */
      const jours = Math.min(400, Math.max(1, parseInt(u.searchParams.get('jours'), 10) || 90));
      const dep0 = u.searchParams.get('depuis') ? Date.parse(u.searchParams.get('depuis')) : null;
      const jus0 = u.searchParams.get('jusqua') ? Date.parse(u.searchParams.get('jusqua')) : null;
      if ((dep0 !== null && !isFinite(dep0)) || (jus0 !== null && !isFinite(jus0)))
        return json(res, 400, { error: 'dates invalides (AAAA-MM-JJ attendu)' });
      const t1p = jus0 !== null ? jus0 + 86399999 : Date.now();
      const t0p = dep0 !== null ? dep0 : t1p - jours * 86400e3;
      if (t1p - t0p > 400 * 86400e3) return json(res, 400, { error: 'periode trop longue (400 jours maximum)' });
      const maxSegments = Math.min(4000, Math.max(100, parseInt(u.searchParams.get('max'), 10) || 1500));

      /* historique complet */
      const tous = [];
      if (ARCHIVE_ACTIVE) {
        const d0 = new Date(t0p), d1 = new Date();
        let an = d0.getUTCFullYear(), mo = d0.getUTCMonth() + 1;
        while (an < d1.getUTCFullYear() || (an === d1.getUTCFullYear() && mo <= d1.getUTCMonth() + 1)) {
          try { const pk = await archiveLire(bid, an, mo); if (pk && pk.points) tous.push(...pk.points); } catch {}
          mo++; if (mo > 12) { mo = 1; an++; }
        }
      }
      tous.push(...(await store.points(bid)));
      const parT = new Map();
      for (const q of tous) if (q[2] >= t0p && q[2] <= t1p) parT.set(q[2], q);
      const pts = Array.from(parT.values()).sort((a, b) => a[2] - b[2]);
      if (pts.length < 3) return json(res, 200, { bateau: bid, nom: meta.name, jours: jours,
        depuis: new Date(t0p).toISOString(), jusqua: new Date(t1p).toISOString(), vide: true, n: pts.length }, req);

      const R_NM = 3440.065, RAD = Math.PI / 180;
      const dNm = (a, b) => {
        const dp = (b[0] - a[0]) * RAD, dl = (b[1] - a[1]) * RAD;
        const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dl / 2) ** 2;
        return 2 * R_NM * Math.asin(Math.sqrt(h));
      };
      const capVers = (a, b) => {
        const p1 = a[0] * RAD, p2 = b[0] * RAD, dl = (b[1] - a[1]) * RAD;
        const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return (Math.atan2(y, x) / RAD + 360) % 360;
      };

      /* segments exploitables : entre 4 et 90 min, distance credible */
      const segments = [];
      for (let i = 1; i < pts.length && segments.length < maxSegments; i++) {
        const a = pts[i - 1], b = pts[i];
        const dtMin = (b[2] - a[2]) / 60000;
        if (dtMin < 4 || dtMin > 90) continue;
        const d = dNm(a, b);
        const vFond = d / (dtMin / 60);
        if (!isFinite(vFond) || vFond < 0.8 || vFond > 35) continue;   /* a l'arret ou aberrant */
        segments.push({ a: a, b: b, d: d, dtMin: dtMin, vFond: vFond, cog: capVers(a, b),
                        lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2, t: (a[2] + b[2]) / 2 });
      }

      /* grille : TWS par 2 kt (0..40), TWA par 10 deg (0..180) */
      const TWS_PAS = 2, TWA_PAS = 10;
      const cases = new Map();
      let nUtil = 0, nSansVent = 0, nCourant = 0;
      for (const sg of segments) {
        const vt = await ventArchive(sg.lat, sg.lon, sg.t);
        if (!vt || vt.tws === null) { nSansVent++; continue; }
        /* vitesse surface = vecteur fond moins courant de maree */
        let vSurface = sg.vFond, cSurface = sg.cog;
        if (C2D) {
          const sonde = courantAu(sg.lat, sg.lon, 0, 70);
          if (sonde) {
            const coefS = await coefficientA(sg.t);
            const refS = await phasePour(sonde.port, sonde.base, sg.t);
            if (refS && coefS !== null && Math.abs(sg.t - refS.t) <= 8 * 3600e3) {
              const hRel = Math.max(-6, Math.min(6, (sg.t - refS.t) / 3600e3));
              const c2 = courantAu(sg.lat, sg.lon, hRel, coefS);
              if (c2) {
                const vx = sg.vFond * Math.sin(sg.cog * RAD) - c2.u;
                const vy = sg.vFond * Math.cos(sg.cog * RAD) - c2.v;
                vSurface = Math.sqrt(vx * vx + vy * vy);
                cSurface = (Math.atan2(vx, vy) / RAD + 360) % 360;
                nCourant++;
              }
            }
          }
        }
        const twa = Math.abs(((cSurface - vt.twd + 540) % 360) - 180);
        const iTws = Math.round(vt.tws / TWS_PAS) * TWS_PAS;
        const iTwa = Math.round(twa / TWA_PAS) * TWA_PAS;
        if (iTws > 40 || iTwa > 180) continue;
        const cle = iTws + ':' + iTwa;
        if (!cases.has(cle)) cases.set(cle, []);
        cases.get(cle).push(Math.round(vSurface * 100) / 100);
        nUtil++;
      }

      const grille = [];
      for (const [cle, vals] of cases) {
        vals.sort((x, y) => x - y);
        const med = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
        const q1 = vals[Math.floor(vals.length * 0.25)], q3 = vals[Math.floor(vals.length * 0.75)];
        const [tws, twa] = cle.split(':').map(Number);
        grille.push({ tws: tws, twa: twa, n: vals.length,
                      mediane: Math.round(med * 100) / 100,
                      max: vals[vals.length - 1],
                      dispersion: Math.round((q3 - q1) * 100) / 100 });
      }
      grille.sort((a, b) => a.tws - b.tws || a.twa - b.twa);
      return json(res, 200, {
        bateau: bid, nom: meta.name, mmsi: meta.mmsi || null, jours: jours,
        depuis: new Date(t0p).toISOString(), jusqua: new Date(t1p).toISOString(),
        segments: segments.length, retenus: nUtil, sansVent: nSansVent, avecCourant: nCourant,
        pasTws: TWS_PAS, pasTwa: TWA_PAS,
        appelsMeteo: ventArchiveAppels, erreursMeteo: ventArchiveErreurs,
        cases: grille.length, grille: grille
      }, req);
    }
    const mFiche = p.match(/^\/api\/boats\/([a-f0-9]{16})\/fiche$/);
    if (mFiche && req.method === 'GET') {
      const bid = mFiche[1];
      const meta = await store.getMeta(bid);
      if (!meta) return json(res, 404, { error: 'bateau introuvable' });
      const jours = Math.min(400, Math.max(1, parseInt(u.searchParams.get('jours'), 10) || 90));
      const depF = u.searchParams.get('depuis') ? Date.parse(u.searchParams.get('depuis')) : null;
      const jusF = u.searchParams.get('jusqua') ? Date.parse(u.searchParams.get('jusqua')) : null;
      if ((depF !== null && !isFinite(depF)) || (jusF !== null && !isFinite(jusF)))
        return json(res, 400, { error: 'dates invalides (AAAA-MM-JJ attendu)' });
      const t1f = jusF !== null ? jusF + 86399999 : Date.now();
      const t0f = depF !== null ? depF : t1f - jours * 86400e3;
      if (t1f - t0f > 400 * 86400e3) return json(res, 400, { error: 'periode trop longue (400 jours maximum)' });

      /* rassembler l'historique : archive mensuelle + points chauds */
      const tous = [];
      if (ARCHIVE_ACTIVE) {
        const d0 = new Date(t0f), d1 = new Date();
        let an = d0.getUTCFullYear(), mo = d0.getUTCMonth() + 1;
        while (an < d1.getUTCFullYear() || (an === d1.getUTCFullYear() && mo <= d1.getUTCMonth() + 1)) {
          try { const pk = await archiveLire(bid, an, mo); if (pk && pk.points) tous.push(...pk.points); } catch {}
          mo++; if (mo > 12) { mo = 1; an++; }
        }
      }
      tous.push(...(await store.points(bid)));
      const parT = new Map();
      for (const q of tous) if (q[2] >= t0f && q[2] <= t1f) parT.set(q[2], q);
      const pts = Array.from(parT.values()).sort((a, b) => a[2] - b[2]);
      if (pts.length < 2) return json(res, 200, { bateau: bid, nom: meta.name, mmsi: meta.mmsi || null, jours: jours, n: pts.length, vide: true }, req);

      const R_NM = 3440.065, RAD = Math.PI / 180;
      const dNm = (a, b) => {
        const dp = (b[0] - a[0]) * RAD, dl = (b[1] - a[1]) * RAD;
        const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dl / 2) ** 2;
        return 2 * R_NM * Math.asin(Math.sqrt(h));
      };
      /* Une « sortie » = suite de points separes de moins de 6 h. Un saut plus
         long signifie que le bateau n'emettait pas : on ne compte ni la
         distance ni le temps de ces trous, sinon les chiffres seraient faux. */
      const TROU_MS = 6 * 3600e3;
      let distTot = 0, tempsNavMs = 0, vMax = 0;
      const sorties = [];
      let debutSortie = pts[0], distSortie = 0, precedent = pts[0];
      const histVitesse = new Array(16).fill(0);   /* 0-1, 1-2 ... 15+ noeuds */
      let nMesures = 0, sommeV = 0;
      const parMois = new Map();

      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dt = b[2] - a[2];
        if (dt > TROU_MS || dt <= 0) {
          if (distSortie > 0.5) sorties.push({ debut: debutSortie[2], fin: a[2], distance: Math.round(distSortie * 10) / 10 });
          debutSortie = b; distSortie = 0; precedent = b; continue;
        }
        const d = dNm(a, b);
        if (d > 60) { precedent = b; continue; }        /* saut aberrant : ignore */
        distTot += d; distSortie += d; tempsNavMs += dt;
        const v = d / (dt / 3600e3);
        if (isFinite(v) && v < 40) {
          vMax = Math.max(vMax, v);
          histVitesse[Math.min(15, Math.floor(v))] += dt / 3600e3;
          sommeV += v * (dt / 3600e3); nMesures += dt / 3600e3;
        }
        const cle = new Date(b[2]).toISOString().slice(0, 7);
        const m = parMois.get(cle) || { mois: cle, distance: 0, heures: 0 };
        m.distance += d; m.heures += dt / 3600e3;
        parMois.set(cle, m);
        precedent = b;
      }
      if (distSortie > 0.5) sorties.push({ debut: debutSortie[2], fin: pts[pts.length - 1][2], distance: Math.round(distSortie * 10) / 10 });

      const mois = Array.from(parMois.values()).map((m) => ({ mois: m.mois, distance: Math.round(m.distance), heures: Math.round(m.heures) })).sort((a, b) => a.mois < b.mois ? -1 : 1);
      /* trace allegee pour l'affichage : au plus 800 points */
      const pas = Math.max(1, Math.ceil(pts.length / 800));
      const trace = [];
      for (let i = 0; i < pts.length; i += pas) trace.push([Math.round(pts[i][0] * 1e4) / 1e4, Math.round(pts[i][1] * 1e4) / 1e4]);

      return json(res, 200, {
        bateau: bid, nom: meta.name, mmsi: meta.mmsi || null, jours: jours,
        n: pts.length,
        premier: new Date(pts[0][2]).toISOString(),
        dernier: new Date(pts[pts.length - 1][2]).toISOString(),
        distanceNm: Math.round(distTot),
        heuresNav: Math.round(tempsNavMs / 3600e3),
        vitesseMoyenne: nMesures > 0 ? Math.round(sommeV / nMesures * 100) / 100 : null,
        vitesseMax: Math.round(vMax * 10) / 10,
        sorties: sorties.length,
        plusLongue: sorties.length ? sorties.slice().sort((a, b) => b.distance - a.distance)[0] : null,
        histogrammeVitesse: histVitesse.map((h) => Math.round(h * 10) / 10),
        parMois: mois,
        trace: trace
      }, req);
    }
    const mHist = p.match(/^\/api\/boats\/([a-f0-9]{16})\/historique$/);
    if (mHist && req.method === 'GET') {
      const bid = mHist[1];
      const meta = await store.getMeta(bid);
      if (!meta) return json(res, 404, { error: 'bateau introuvable' });
      const depuis = u.searchParams.get('depuis') ? Date.parse(u.searchParams.get('depuis')) : null;
      const jusqua = u.searchParams.get('jusqua') ? Date.parse(u.searchParams.get('jusqua')) : null;
      if ((depuis !== null && !isFinite(depuis)) || (jusqua !== null && !isFinite(jusqua)))
        return json(res, 400, { error: 'dates invalides (ISO 8601 attendu)' });
      const t0h = depuis !== null ? depuis : Date.now() - 30 * 86400e3;
      const t1h = jusqua !== null ? jusqua : Date.now();
      if (t1h - t0h > 400 * 86400e3) return json(res, 400, { error: 'periode trop longue (400 jours maximum par requete)' });
      const tous = [];
      let moisLus = 0, archiveDispo = ARCHIVE_ACTIVE;
      if (ARCHIVE_ACTIVE) {
        const d0 = new Date(t0h), d1 = new Date(t1h);
        let an = d0.getUTCFullYear(), mo = d0.getUTCMonth() + 1;
        while (an < d1.getUTCFullYear() || (an === d1.getUTCFullYear() && mo <= d1.getUTCMonth() + 1)) {
          try {
            const paquet = await archiveLire(bid, an, mo);
            if (paquet && paquet.points) { tous.push(...paquet.points); moisLus++; }
          } catch { archiveDispo = false; }
          mo++; if (mo > 12) { mo = 1; an++; }
        }
      }
      const chauds = await store.points(bid);
      tous.push(...chauds);
      const parT = new Map();
      for (const q of tous) if (q[2] >= t0h && q[2] <= t1h) parT.set(q[2], q);
      const points = Array.from(parT.values()).sort((a, b) => a[2] - b[2]);
      return json(res, 200, {
        bateau: bid, nom: meta.name, mmsi: meta.mmsi || null,
        depuis: new Date(t0h).toISOString(), jusqua: new Date(t1h).toISOString(),
        moisArchivesLus: moisLus, archive: archiveDispo ? 'ok' : 'indisponible',
        champs: ['lat', 'lon', 't', 'sog', 'cog'],
        n: points.length, points: points
      }, req);
    }
    const mAnalyse = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/analyse$/);
    if (mAnalyse && req.method === 'GET') {
      const fid = mAnalyse[1];
      const meta = await store.fleetGet(fid);
      if (!meta) return json(res, 404, { error: 'flotte introuvable' });
      const membres = await store.fleetMembers(fid).catch(() => []);
      const fenetreMin = Math.min(120, Math.max(1, num(parseFloat(u.searchParams.get('fenetre'))) || 10));
      const mLat = num(parseFloat(u.searchParams.get('mlat')));
      const mLon = num(parseFloat(u.searchParams.get('mlon')));
      const aMarque = mLat !== null && mLon !== null;
      const maintenant = Date.now();
      const fenetreMs = fenetreMin * 60000;

      const R_NM = 3440.065, RAD = Math.PI / 180;
      const distNm = (a, b) => {
        const dp = (b[0] - a[0]) * RAD, dl = (b[1] - a[1]) * RAD;
        const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dl / 2) ** 2;
        return 2 * R_NM * Math.asin(Math.sqrt(h));
      };
      const capVers = (a, b) => {
        const p1 = a[0] * RAD, p2 = b[0] * RAD, dl = (b[1] - a[1]) * RAD;
        const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return (Math.atan2(y, x) / RAD + 360) % 360;
      };

      const lignes = [];
      for (const bid of membres) {
        const bm = await store.getMeta(bid);
        if (!bm) continue;
        const pts = await store.points(bid);
        if (!pts.length) { lignes.push({ id: bid, nom: bm.name, vide: true }); continue; }
        const dernier = pts[pts.length - 1];
        const ageMin = Math.round((maintenant - dernier[2]) / 60000);
        /* segment de la fenetre : du plus recent jusqu'a fenetreMs avant */
        const fin = dernier[2];
        const debut = fin - fenetreMs;
        /* Fenetre de lissage ADAPTATIVE : avec un AIS differe (une position
           toutes les 10 a 60 min), une fenetre de 10 min ne contient qu'un
           seul point — donc aucun calcul possible. On elargit alors juste ce
           qu'il faut pour disposer de deux points, jusqu'a 4 fois la fenetre
           demandee, et on signale l'elargissement. Au-dela, on retombe sur les
           valeurs brutes du transpondeur plutot que d'afficher des tirets. */
        let seg = pts.filter((q) => q[2] >= debut);
        let fenetreReelleMin = fenetreMin, elargie = false;
        if (seg.length < 2) {
          for (const facteur of [2, 4]) {
            const seg2 = pts.filter((q) => q[2] >= fin - fenetreMs * facteur);
            if (seg2.length >= 2) { seg = seg2; fenetreReelleMin = fenetreMin * facteur; elargie = true; break; }
          }
        }
        if (seg.length < 2 && pts.length >= 2) {
          /* dernier recours : les deux dernieres positions, quel que soit l'ecart */
          const av = pts[pts.length - 2];
          if (fin - av[2] <= 6 * 3600e3) {
            seg = [av, dernier];
            fenetreReelleMin = Math.round((fin - av[2]) / 60000);
            elargie = true;
          }
        }
        let sogLisse = null, cmg = null, distFenetre = null;
        if (seg.length >= 2) {
          let d = 0;
          for (let i = 1; i < seg.length; i++) d += distNm(seg[i - 1], seg[i]);
          const dt = (seg[seg.length - 1][2] - seg[0][2]) / 3600e3;
          if (dt > 0) { sogLisse = Math.round(d / dt * 100) / 100; distFenetre = Math.round(d * 100) / 100; }
          cmg = Math.round(capVers(seg[0], seg[seg.length - 1]));
        }
        /* repli sur les valeurs brutes du transpondeur si le lissage reste
           impossible (un seul point connu) : mieux vaut une donnee instantanee
           signalee comme telle qu'une case vide */
        let brut = false;
        if (sogLisse === null && dernier[3] !== undefined && dernier[3] !== null) {
          sogLisse = Math.round(dernier[3] * 100) / 100; brut = true;
          if (dernier[4] !== undefined && dernier[4] !== null) cmg = Math.round(dernier[4]);
        }
        /* Vitesse-surface : on retranche le vecteur courant de maree au vecteur
           fond mesure. C'est la vraie mesure de performance — deux bateaux a
           8 noeuds fond n'ont pas la meme valeur si l'un a 2 noeuds de courant
           porteur. Le courant est evalue au milieu du segment, a mi-temps. */
        let sogSurface = null, courantInfo = null;
        if (sogLisse !== null && seg.length >= 2 && C2D) {
          const pm = seg[Math.floor(seg.length / 2)];
          const tm = (seg[0][2] + seg[seg.length - 1][2]) / 2;
          const sonde = courantAu(pm[0], pm[1], 0, 70);
          if (sonde) {
            const coefM = await coefficientA(tm);
            const refM = await phasePour(sonde.port, sonde.base, tm);
            if (refM && coefM !== null && Math.abs(tm - refM.t) <= 8 * 3600e3) {
              const hRel = Math.max(-6, Math.min(6, (tm - refM.t) / 3600e3));
              const c2 = courantAu(pm[0], pm[1], hRel, coefM);
              if (c2 && cmg !== null) {
                /* vecteur fond (cmg, sogLisse) moins vecteur courant (u,v) */
                const vx = sogLisse * Math.sin(cmg * RAD) - c2.u;
                const vy = sogLisse * Math.cos(cmg * RAD) - c2.v;
                sogSurface = Math.round(Math.sqrt(vx * vx + vy * vy) * 100) / 100;
                courantInfo = { vitesse: c2.vitesse, dir: c2.dir };
              }
            }
          }
        }
        const ligne = {
          id: bid, nom: bm.name, sogSurface: sogSurface, courant: courantInfo,
          fenetreReelleMin: fenetreReelleMin, elargie: elargie, brut: brut, nPoints: seg.length,
          lat: dernier[0], lon: dernier[1], tDernier: dernier[2], ageMin: ageMin,
          sogBrut: dernier[3] === undefined ? null : dernier[3],
          cogBrut: dernier[4] === undefined ? null : dernier[4],
          sogLisse: sogLisse, cmg: cmg, distFenetre: distFenetre
        };
        if (aMarque) {
          const M = [mLat, mLon];
          ligne.distMarque = Math.round(distNm(dernier, M) * 100) / 100;
          ligne.capMarque = Math.round(capVers(dernier, M));
          if (seg.length >= 2) {
            /* VMC = gain de distance vers la marque sur la fenetre, en noeuds */
            const d0 = distNm(seg[0], M), d1 = distNm(seg[seg.length - 1], M);
            const dt = (seg[seg.length - 1][2] - seg[0][2]) / 3600e3;
            if (dt > 0) ligne.vmc = Math.round((d0 - d1) / dt * 100) / 100;
          }
        }
        lignes.push(ligne);
      }
      /* classement et ecarts : par distance a la marque si elle est fournie */
      if (aMarque) {
        const classables = lignes.filter((x) => x.distMarque !== undefined);
        classables.sort((a, b) => a.distMarque - b.distMarque);
        classables.forEach((x, i) => { x.rang = i + 1; x.ecartMeneurNm = Math.round((x.distMarque - classables[0].distMarque) * 100) / 100; });
      }
      /* Pourcentage de polaire : demande explicitement (parametre polaire=cle),
         car il exige un appel meteo. Le vent est pris au barycentre de la
         flotte — a l'echelle d'une regate c'est suffisant, et cela evite un
         appel par bateau. */
      const clePol = (u.searchParams.get('polaire') || '').replace(/[^a-z0-9_]/gi, '');
      let ventInfo = null;
      if (clePol && POLAIRES_SERVEUR[clePol]) {
        const avecPos = lignes.filter((x) => x.lat !== undefined);
        if (avecPos.length) {
          const bLat = avecPos.reduce((a, x) => a + x.lat, 0) / avecPos.length;
          const bLon = avecPos.reduce((a, x) => a + x.lon, 0) / avecPos.length;
          try {
            const ac = new AbortController();
            const tm2 = setTimeout(() => ac.abort(), 7000);
            const rv = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + bLat.toFixed(3)
              + '&longitude=' + bLon.toFixed(3) + '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn', { signal: ac.signal });
            clearTimeout(tm2);
            const dv = await rv.json();
            if (dv && dv.current) {
              ventInfo = { tws: dv.current.wind_speed_10m, twd: dv.current.wind_direction_10m, lat: Math.round(bLat * 1000) / 1000, lon: Math.round(bLon * 1000) / 1000 };
              const P = POLAIRES_SERVEUR[clePol];
              for (const L2 of lignes) {
                const ref = L2.sogSurface !== null && L2.sogSurface !== undefined ? L2.sogSurface : L2.sogLisse;
                if (ref === null || ref === undefined || L2.cmg === null || L2.cmg === undefined) continue;
                const twa = ((L2.cmg - ventInfo.twd + 540) % 360) - 180;
                const cible = polarSpeedServeur(P, ventInfo.tws, twa);
                L2.twa = Math.round(twa);
                L2.viseePolaire = Math.round(cible * 100) / 100;
                /* L'angle mort au pres (|TWA| < 35) n'est pas decrit par les
                   polaires : les fichiers .pol y portent des valeurs de
                   remplissage, et le rapport y explose (285 % observe le
                   30/07). Meme logique que le routeur : on ne calcule pas.
                   Idem au-dela de 200 %, signe d'un bateau au moteur, d'un cap
                   moyen non representatif ou d'un vent local different. */
                /* L'angle mort au pres (|TWA| < 35) reste ecarte : les fichiers
                   .pol y portent des valeurs de remplissage, le rapport n'y a
                   aucun sens. Au-dela, aucun plafond : un pourcentage eleve est
                   une information (surf, rafale, polaire inadaptee au bateau),
                   c'est au marin de l'interpreter, pas au logiciel de le cacher. */
                if (Math.abs(twa) < 35) { L2.motifPol = 'angle mort (TWA ' + Math.round(Math.abs(twa)) + '°)'; }
                else if (cible <= 0.3) { L2.motifPol = 'polaire nulle a ce point'; }
                else L2.pctPolaire = Math.round(ref / cible * 100);
              }
            }
          } catch { ventInfo = null; }
        }
      }
      return json(res, 200, {
        fenetreMin: fenetreMin,
        vent: ventInfo,
        polaire: clePol && POLAIRES_SERVEUR[clePol] ? clePol : null,
        marque: aMarque ? { lat: mLat, lon: mLon } : null,
        t: new Date(maintenant).toISOString(),
        bateaux: lignes
      }, req);
    }
    /* Champ de vent en grille : alimente les fleches du calque « Vent ».
       Meme forme de reponse que /api/courant/champ (points [lat,lon,val,dir])
       pour reutiliser la mecanique d'affichage. La vitesse est convertie en
       noeuds ; dir est la direction D'OU vient le vent (convention Open-Meteo). */
    if (p === '/api/vent/champ' && req.method === 'GET') {
      const va0 = num(parseFloat(u.searchParams.get('lat0'))), va1 = num(parseFloat(u.searchParams.get('lat1')));
      const vo0 = num(parseFloat(u.searchParams.get('lon0'))), vo1 = num(parseFloat(u.searchParams.get('lon1')));
      if (va0 === null || va1 === null || vo0 === null || vo1 === null) return json(res, 400, { error: 'lat0 lat1 lon0 lon1 requis' });
      if (va1 - va0 <= 0 || vo1 - vo0 <= 0 || va1 - va0 > 20 || vo1 - vo0 > 30) return json(res, 400, { error: 'fenetre invalide (max 20 x 30 degres)' });
      const modele = u.searchParams.get('modele') || '';
      const heure = parseInt(u.searchParams.get('heure'), 10) || 0;
      /* Maille demandee par le client, qui la calcule d'apres la taille reelle
         de la carte : une grille carree donnait des fleches serrees en largeur
         et tres espacees en hauteur sur un ecran en portrait. Open-Meteo
         accepte 1000 points par requete ; on plafonne bien en dessous, la
         limite utile etant la lisibilite, pas l'API. */
      let nx = parseInt(u.searchParams.get('nx'), 10) || 9;
      let ny = parseInt(u.searchParams.get('ny'), 10) || 9;
      nx = Math.max(3, Math.min(20, nx)); ny = Math.max(3, Math.min(30, ny));
      while (nx * ny > 400) { if (ny >= nx) ny--; else nx--; }
      const pA = (va1 - va0) / (ny - 1), pO = (vo1 - vo0) / (nx - 1);
      const qlat = [], qlon = [];
      for (let ia = 0; ia < ny; ia++) for (let io = 0; io < nx; io++) { qlat.push(va0 + ia * pA); qlon.push(vo0 + io * pO); }
      const e = await omGrid(qlat, qlon, modele, heure);
      if (!e || !e.length) return json(res, 502, { error: 'vent indisponible' });
      const pts = [];
      for (let i = 0; i < qlat.length; i++) {
        const g = e[i]; if (!g) continue;
        const kt = (num(g.sp) || 0) * 1.94384;
        pts.push([Math.round(qlat[i] * 1e4) / 1e4, Math.round(qlon[i] * 1e4) / 1e4, Math.round(kt * 10) / 10, Math.round(num(g.dr) || 0)]);
      }
      return json(res, 200, { t: new Date().toISOString(), points: pts }, req);
    }
    if (p === '/api/courant/champ' && req.method === 'GET') {
      if (!C2D) return json(res, 503, { error: 'Donnees courants 2D absentes' });
      const fa0 = num(parseFloat(u.searchParams.get('lat0'))), fa1 = num(parseFloat(u.searchParams.get('lat1')));
      const fo0 = num(parseFloat(u.searchParams.get('lon0'))), fo1 = num(parseFloat(u.searchParams.get('lon1')));
      if (fa0 === null || fa1 === null || fo0 === null || fo1 === null) return json(res, 400, { error: 'lat0 lat1 lon0 lon1 requis' });
      if (fa1 - fa0 <= 0 || fo1 - fo0 <= 0 || fa1 - fa0 > 4 || fo1 - fo0 > 6) return json(res, 400, { error: 'fenetre invalide (max 4 x 6 degres)' });
      const tf = u.searchParams.get('t') ? Date.parse(u.searchParams.get('t')) : Date.now();
      if (!isFinite(tf)) return json(res, 400, { error: 't invalide' });
      const N = 21;   /* maille du champ : 441 points, lisible sur telephone */
      const pasA = (fa1 - fa0) / (N - 1), pasO = (fo1 - fo0) / (N - 1);
      /* phase et coefficient : une interrogation par port de reference */
      const coefF = await coefficientA(tf);
      const refs = new Map();
      const points = [];
      for (let ia = 0; ia < N; ia++) {
        for (let io = 0; io < N; io++) {
          const la = fa0 + ia * pasA, lo = fo0 + io * pasO;
          if (surTerreServeur(la, lo)) continue;   /* pas de courant sur la terre */
          const sonde = courantAu(la, lo, 0, 70);
          if (!sonde) continue;
          const cle = sonde.port + '|' + sonde.base;
          if (!refs.has(cle)) refs.set(cle, await phasePour(sonde.port, sonde.base, tf));
          const ref = refs.get(cle);
          if (!ref || coefF === null) continue;
          const hRel = Math.max(-6, Math.min(6, (tf - ref.t) / 3600e3));
          const r2 = courantAu(la, lo, hRel, coefF);
          if (!r2 || r2.vitesse < 0.03) continue;
          points.push([Math.round(la * 1e4) / 1e4, Math.round(lo * 1e4) / 1e4, r2.vitesse, r2.dir]);
        }
      }
      return json(res, 200, { t: new Date(tf).toISOString(), coef: coefF, points: points }, req);
    }
    if (p === '/api/routeur/grilles' && req.method === 'GET') {
      const la0 = num(parseFloat(u.searchParams.get('lat0'))), la1 = num(parseFloat(u.searchParams.get('lat1')));
      const lo0 = num(parseFloat(u.searchParams.get('lon0'))), lo1 = num(parseFloat(u.searchParams.get('lon1')));
      if (la0 === null || la1 === null || lo0 === null || lo1 === null) return json(res, 400, { error: 'lat0 lat1 lon0 lon1 requis' });
      if (la1 - la0 <= 0 || lo1 - lo0 <= 0 || la1 - la0 > 45 || lo1 - lo0 > 80) return json(res, 400, { error: 'domaine invalide (max 45 x 80 degres)' });
      const modele = (u.searchParams.get('modele') || 'best_match').replace(/[^a-z_0-9]/g, '');
      /* horizon Open-Meteo : 16 jours maximum — au-dela, plus de prevision */
      const heures = Math.min(384, Math.max(12, parseInt(u.searchParams.get('heures'), 10) || 48));
      /* au long cours, un pas de 3 h suffit et divise le volume par trois */
      const pasTemps = heures > 120 ? 3 : 1;
      /* grille adaptative : fine en cotier, jusqu'a 26 points par axe en transat */
      const axeMax = (la1 - la0 > 8 || lo1 - lo0 > 10) ? 25 : 17;
      const pasLat = Math.max(0.05, (la1 - la0) / axeMax), pasLon = Math.max(0.05, (lo1 - lo0) / axeMax);
      const lats = [], lons = [];
      for (let a2 = la0; a2 <= la1 + 1e-9; a2 += pasLat) lats.push(Math.round(a2 * 1000) / 1000);
      for (let o2 = lo0; o2 <= lo1 + 1e-9; o2 += pasLon) lons.push(Math.round(o2 * 1000) / 1000);
      const cle = ['rg', lats[0], lats[lats.length-1], lons[0], lons[lons.length-1], modele, heures, pasTemps, Math.floor(Date.now() / 3600e3)].join('|');
      const enCache = tracesLire(cle);
      if (enCache) return json(res, 200, enCache, req);
      /* vent : requetes par lots de 90 points */
      const ptsG = [];
      for (const a2 of lats) for (const o2 of lons) ptsG.push([a2, o2]);
      const vent = new Array(ptsG.length).fill(null);
      let tempsVent = null;
      try {
        for (let i = 0; i < ptsG.length; i += 90) {
          const lot = ptsG.slice(i, i + 90);
          const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lot.map((q) => q[0]).join(',')
            + '&longitude=' + lot.map((q) => q[1]).join(',')
            + '&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn'
            + '&forecast_days=' + Math.min(16, Math.ceil(heures / 24 + 0.5)) + '&timezone=UTC'
            + (modele !== 'best_match' ? '&models=' + modele : '');
          const ac = new AbortController();
          const tm = setTimeout(() => ac.abort(), 12000);
          const rep = await fetch(url, { signal: ac.signal });
          clearTimeout(tm);
          const dj = await rep.json();
          const tab = Array.isArray(dj) ? dj : [dj];
          for (let k2 = 0; k2 < tab.length; k2++) {
            const h2 = tab[k2].hourly;
            if (!h2) continue;
            const pick = (tab2) => { const o3 = []; for (let q2 = 0; q2 <= heures; q2 += pasTemps) o3.push(tab2[q2] === undefined ? null : tab2[q2]); return o3; };
            if (!tempsVent) tempsVent = pick(h2.time);
            vent[i + k2] = { s: pick(h2.wind_speed_10m).map((x2) => x2 === null ? null : Math.round(x2 * 10) / 10),
                             d: pick(h2.wind_direction_10m).map((x2) => x2 === null ? null : Math.round(x2)) };
          }
        }
      } catch (e) { return json(res, 502, { error: 'grille vent indisponible : ' + String(e && e.message || e).slice(0, 100) }); }
      if (!tempsVent) return json(res, 502, { error: 'grille vent vide' });
      /* courant : meme grille, meme axe temps, via le socle Shom */
      const t0g = Date.parse(tempsVent[0] + ':00Z');
      const courant = new Array(ptsG.length).fill(null);
      if (C2D) {
        /* phase de maree par port implique, calculee une fois par heure demandee */
        const phases = new Map(); /* port|type -> evts */
        for (let ip = 0; ip < ptsG.length; ip++) {
          const sonde = courantAu(ptsG[ip][0], ptsG[ip][1], 0, 70);
          if (!sonde) continue;
          const cleP = sonde.port + '|' + sonde.base;
          if (!phases.has(cleP)) phases.set(cleP, { port: sonde.port, base: sonde.base });
        }
        const nT = Math.floor(heures / pasTemps) + 1;
        const coefParH = [];
        for (let it = 0; it < nT; it++) coefParH.push(await coefficientA(t0g + it * pasTemps * 3600e3));
        const refParPortH = new Map();
        for (const [cleP, pp] of phases) {
          const tabRef = [];
          for (let it = 0; it < nT; it++) tabRef.push(await phasePour(pp.port, pp.base, t0g + it * pasTemps * 3600e3));
          refParPortH.set(cleP, tabRef);
        }
        for (let ip = 0; ip < ptsG.length; ip++) {
          const sonde = courantAu(ptsG[ip][0], ptsG[ip][1], 0, 70);
          if (!sonde) continue;
          const tabRef = refParPortH.get(sonde.port + '|' + sonde.base);
          const su = [], sv2 = [];
          const nT2 = Math.floor(heures / pasTemps) + 1;
          for (let it = 0; it < nT2; it++) {
            const tAbs = t0g + it * pasTemps * 3600e3;
            const ref = tabRef && tabRef[it], coefH = coefParH[it];
            /* au-dela de l'horizon des predictions de niveau (~7 j), la phase
               retombe sur l'evenement le plus proche : on coupe plutot que de
               servir un courant de maree faux */
            if (!ref || coefH === null || Math.abs(tAbs - ref.t) > 8 * 3600e3) { su.push(null); sv2.push(null); continue; }
            const hRel = Math.max(-6, Math.min(6, (tAbs - ref.t) / 3600e3));
            const r2 = courantAu(ptsG[ip][0], ptsG[ip][1], hRel, coefH);
            su.push(r2 ? Math.round(r2.u * 100) / 100 : null);
            sv2.push(r2 ? Math.round(r2.v * 100) / 100 : null);
          }
          courant[ip] = { u: su, v: sv2 };
        }
      }
      const sortieG = { lats, lons, temps: tempsVent, pasH: pasTemps, modele, vent, courant, t0: t0g };
      tracesEcrire(cle, sortieG);
      return json(res, 200, sortieG, req);
    }
    if (p === '/api/courant' && req.method === 'GET') {
      if (!C2D) return json(res, 503, { error: 'Donnees courants 2D absentes du serveur (courants2d.json.gz)' });
      const clat = num(parseFloat(u.searchParams.get('lat')));
      const clon = num(parseFloat(u.searchParams.get('lon')));
      if (clat === null || clon === null) return json(res, 400, { error: 'lat et lon requis' });
      let ch = num(parseFloat(u.searchParams.get('h')));
      let ccoef = num(parseFloat(u.searchParams.get('coef')));
      let phase = null;
      if (ch === null || ccoef === null) {
        /* mode automatique : la phase de maree est calculee pour l'instant t
           (parametre ISO, defaut maintenant) au port de reference de la zone */
        const t = u.searchParams.get('t') ? Date.parse(u.searchParams.get('t')) : Date.now();
        if (!isFinite(t)) return json(res, 400, { error: 't invalide (ISO 8601 attendu)' });
        const sonde = courantAu(clat, clon, 0, 70);
        if (!sonde) return json(res, 200, { courant: null, note: 'hors couverture des atlas 2D' });
        const [ref, coefAuto] = await Promise.all([phasePour(sonde.port, sonde.base, t), coefficientA(t)]);
        if (!ref || coefAuto === null)
          return json(res, 503, { error: 'Phase de maree indisponible', detail: mareeDerniereErreur || null });
        ch = Math.max(-6, Math.min(6, (t - ref.t) / 3600e3));
        ccoef = ccoef === null ? coefAuto : ccoef;
        phase = { evenement: sonde.base, port: sonde.port, heure: new Date(ref.t).toISOString(), h: Math.round(ch * 100) / 100, coef: ccoef, correctionMin: ref.correctionMin };
      } else {
        if (ch < -6.001 || ch > 6.001) return json(res, 400, { error: 'h doit etre entre -6 et +6' });
        if (ccoef < 20 || ccoef > 120) return json(res, 400, { error: 'coef doit etre entre 20 et 120' });
      }
      const r = courantAu(clat, clon, ch, ccoef);
      if (!r) return json(res, 200, { courant: null, note: 'hors couverture des atlas 2D' });
      const sortieC = { courant: r, h: Math.round(ch * 100) / 100, coef: ccoef };
      if (phase) sortieC.maree = phase;
      return json(res, 200, sortieC);
    }
    if (p === '/api/fond' && req.method === 'GET') {
      const clat = num(parseFloat(u.searchParams.get('lat')));
      const clon = num(parseFloat(u.searchParams.get('lon')));
      if (clat === null || clon === null) return json(res, 400, { error: 'lat/lon requis' });
      const debug = u.searchParams.get('debug') === '1' && adminOk(req, u);
      const essais = [];
      const d = 0.0015;
      /* Extraction de la valeur d'altitude dans une reponse GetFeatureInfo.
         1. JSON GeoServer : la valeur vit dans features[n].properties (souvent
            GRAY_INDEX) — surtout ne pas prendre le premier nombre du texte,
            les identifiants de feature et l'horodatage en sont pleins.
         2. Texte plat : motif « cle = valeur ».
         3. Dernier recours : premier nombre plausible. */
      function plausible(n2) { return isFinite(n2) && n2 > -1000 && n2 < 500 && Math.abs(Math.abs(n2) - 9999) > 1; }
      function extraireValeur(txt) {
        try {
          const j = JSON.parse(txt);
          const fs = (j && j.features) || [];
          for (const ft of fs) {
            const pr = (ft && ft.properties) || {};
            if (pr.GRAY_INDEX !== undefined) { const v = parseFloat(pr.GRAY_INDEX); if (plausible(v)) return Math.round(v * 10) / 10; }
            for (const k of Object.keys(pr)) {
              const v = parseFloat(pr[k]);
              if (plausible(v)) return Math.round(v * 10) / 10;
            }
          }
          return null; /* JSON valide mais sans propriete numerique : ne pas retomber sur la peche au filet */
        } catch {}
        let m = txt.match(/=\s*(-?\d+(?:[.,]\d+)?)/);
        if (m) { const v = parseFloat(m[1].replace(',', '.')); if (plausible(v)) return Math.round(v * 10) / 10; }
        m = txt.match(/-?\d+(?:[.,]\d+)?/);
        if (m) { const v = parseFloat(m[0].replace(',', '.')); if (plausible(v)) return Math.round(v * 10) / 10; }
        return null;
      }
      async function interroger(url) {
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), 5000);
        try {
          const rep = await fetch(url, { signal: ac.signal });
          clearTimeout(tm);
          const txt = await rep.text();
          if (debug) essais.push({ url: url.slice(0, 220), statut: rep.status, extrait: txt.slice(0, 260) });
          if (!rep.ok) return null;
          return extraireValeur(txt);
        } catch (e) { clearTimeout(tm); if (debug) essais.push({ url: url.slice(0, 220), erreur: String(e && e.message || e).slice(0, 120) }); return null; }
      }
      /* 1. Shom : couche par couche (certains serveurs refusent le multi-couches) */
      const bbox13 = [clat - d, clon - d, clat + d, clon + d].join(',');
      let fond = null, source = null, ref = null;
      for (const c of LITTO3D_COUCHES) {
        for (const fmt of ['application/json', 'text/plain']) {
          const qs = 'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&CRS=EPSG:4326'
            + '&BBOX=' + bbox13 + '&WIDTH=101&HEIGHT=101&I=50&J=50'
            + '&LAYERS=' + c + '&QUERY_LAYERS=' + c
            + '&STYLES=&FORMAT=image/png&INFO_FORMAT=' + encodeURIComponent(fmt);
          fond = await interroger('https://services.data.shom.fr/INSPIRE/wms/r?' + qs);
          if (fond !== null) { source = 'Litto3D (Shom)'; ref = 'NGF-IGN69'; break; }
        }
        if (fond !== null) break;
      }
      /* 2. repli EMODnet (WMS 1.1.1, bbox lon/lat).
         Couche 'emodnet:mean' : la grille de profondeurs elle-meme. Surtout pas
         les couches stylees (mean_atlas_land, etc.) dont le GetFeatureInfo
         renvoie l'index de palette du pixel (0-255) et non des metres — c'est
         ce qui produisait des « fonds » de 214 ou 234 m dans 20 m d'eau. */
      if (fond === null) {
        const bbox11 = [clon - d, clat - d, clon + d, clat + d].join(',');
        const qs = 'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&SRS=EPSG:4326'
          + '&BBOX=' + bbox11 + '&WIDTH=101&HEIGHT=101&X=50&Y=50'
          + '&LAYERS=emodnet:mean&QUERY_LAYERS=emodnet:mean'
          + '&STYLES=&FORMAT=image/png&INFO_FORMAT=' + encodeURIComponent('application/json');
        fond = await interroger('https://ows.emodnet-bathymetry.eu/wms?' + qs);
        /* garde-fou : sur nos cotes, aucune valeur legitime au-dessus de +100 m
           pres de l'eau — un entier eleve signe un index de palette residuel */
        if (fond !== null && fond > 100) fond = null;
        if (fond !== null) { source = 'EMODnet'; ref = 'zéro hydro / LAT'; }
      }
      const sortie = { fond: fond, source: source, ref: ref };
      if (fond !== null && source === 'Litto3D (Shom)') {
        const e = ecartZHapprox(clat, clon);
        sortie.ecartZH = e;
        /* fond NGF -4,0 avec ZH a -2,9 => environ 1,1 m au-dessus du ZH */
        if (fond < 0) sortie.sondeApprox = Math.round((-fond - e) * 10) / 10;
      }
      if (debug) sortie.essais = essais;
      return json(res, 200, sortie);
    }
    if (p === '/api/point' && req.method === 'GET') {
      const clat = num(parseFloat(u.searchParams.get('lat')));
      const clon = num(parseFloat(u.searchParams.get('lon')));
      const pt = await fetchPoint(clat === null ? 47 : clat, clon === null ? -4 : clon);
      return json(res, 200, pt);
    }
  } catch (e) {
    /* le message reste generique cote client, mais l'erreur reelle est
       consultable dans /api/admin/diag et dans les logs Render */
    apiErreurs++;
    apiDerniereErreur = (req.method + ' ' + p + ' — ' + ((e && (e.message || e.name)) || 'inconnue')).slice(0, 200);
    apiDerniereErreurAt = Date.now();
    console.error('[api]', apiDerniereErreur);
    return json(res, 500, { error: 'stockage indisponible' });
  }

  if (p === '/windy.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE_WINDYJS); }
  if (p === '/routeur.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE_ROUTEURJS); }
  if (p === '/routeur-polaires.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE_ROUTEUR_POLAIRES); }
  if (p === '/terre.json.gz' || p === '/terre.json') {
    try {
      const brutT = fs.readFileSync(__dirname + '/terre.json.gz');
      if (p === '/terre.json.gz') { res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'public, max-age=86400' }); return res.end(brutT); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' }); return res.end(zlib.gunzipSync(brutT));
    } catch { res.writeHead(404); return res.end('terre.json.gz absent'); }
  }
  if (p === '/b') return serveHTML(res, PAGE_FICHE, req.url);
  if (p === '/carte.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE_CARTEJS); }
  if (p === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('window.OWM_KEY=' + JSON.stringify(process.env.OWM_API_KEY || '') + ';'); }
  if (p === '/') return serveHTML(res, PAGE_INDEX, req.url);
  if (p === '/v') return serveHTML(res, PAGE_VIEWER, req.url);
  if (p === '/p') return serveHTML(res, PAGE_PUBLISHER, req.url);
  if (p === '/meteo') return serveHTML(res, PAGE_METEO, req.url);
  if (p === '/vf') return serveHTML(res, PAGE_FLEET, req.url);
  if (p === '/join') return serveHTML(res, PAGE_JOIN, req.url);
  if (ICONS[p]) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }); return res.end(ICONS[p]); }
  if (p === '/api/version') { return json(res, 200, { build: BUILD }); }
  if (p === '/vendor/leaflet.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800' }); return res.end(LEAFLET_JS); }
  if (p === '/vendor/leaflet.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=604800' }); return res.end(LEAFLET_CSS); }
  if (p === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(SW_JS); }
  if (p === '/manifest.webmanifest') {
    let start = u.searchParams.get('s') || '';
    if (!start) {
      const ref = req.headers.referer || '';
      try { const ru = new URL(ref); if (ru.host === (req.headers.host || ru.host)) start = ru.pathname + ru.search; } catch {}
    }
    if (!start || start.charAt(0) !== '/' || start.charAt(1) === '/') start = '/';
    const man = {
      name: 'Sea Tracker', short_name: 'Sea Tracker',
      description: 'Suivi de flotte en direct',
      start_url: start, scope: '/', display: 'standalone', orientation: 'any',
      background_color: '#0a1a26', theme_color: '#0a1a26',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    };
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    return res.end(JSON.stringify(man));
  }
  if (p === '/admin') return serveHTML(res, PAGE_ADMIN, req.url);
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404');
});

/* ---- Ingestion AIS (aisstream.io) : bateaux suivis par MMSI ---- */
const AIS_KEY = process.env.AIS_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const VAPI_KEY = process.env.VESSELAPI_KEY || '';
let vapiTimer = null, vapiPollMs = 0, vapiLastEvent = 'inactif', vapiPositions = 0, vapiLastAt = 0, vapiBrut = '', vapiPauseJusqua = 0, vapiQuotaRestant = null;
const AIS_DEFAULT_MIN = 60;
const aisInfo = new Map();
let aisMap = {};
const aisLast = new Map();
const aisLastT = new Map();
let aisWs = null, aisRetry = 0, aisTimer = null;
let aisMsgCount = 0, aisLastMsgAt = 0, aisLastEvent = 'jamais connecte', aisSubCount = 0;
/* Compteurs de diagnostic : combien de messages de chaque type nous parviennent
   reellement, et combien sont ecartes et pourquoi. Purement observationnel :
   aucun filtre n'est modifie. */
const aisParType = Object.create(null);
let aisRejetInconnu = 0;   /* position d'un MMSI hors de notre liste */
let aisRejetCoord = 0;     /* position sans latitude/longitude exploitable */
let aisPosOk = 0;          /* positions effectivement transmises a aisIngest */
let aisDerniereErreur = ''; /* derniere erreur envoyee par aisstream, conservee malgre la fermeture */
let aisOuvertA = 0, aisDureeDerniereConnexion = 0; /* pour reperer les rejets d'abonnement (fermetures immediates) */
let aisExclus = [];    /* bateaux avec suivi desactive (case Emet de la console) */
let aisOrphelins = []; /* entrees MMSI dont la fiche bateau n'existe plus */
let aisIngeres = 0; /* positions AIS effectivement enregistrees (toutes sources) */

async function aisHandle(raw) {
  aisMsgCount++; aisLastMsgAt = Date.now();
  /* le WebSocket natif de Node livre les trames binaires en Blob (ou
     ArrayBuffer selon binaryType) : String(raw) donnerait "[object Blob]"
     et chaque message serait perdu au parsing. */
  let txt;
  if (typeof raw === 'string') txt = raw;
  else if (raw && typeof raw.text === 'function') { try { txt = await raw.text(); } catch { txt = ''; } }
  else if (raw instanceof ArrayBuffer) txt = Buffer.from(raw).toString('utf8');
  else if (ArrayBuffer.isView(raw)) txt = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  else txt = String(raw);
  let m; try { m = JSON.parse(txt); } catch { aisLastEvent = 'reponse non JSON: ' + txt.slice(0, 140); return; }
  if (m && m.error) { aisDerniereErreur = String(m.error).slice(0, 140); aisLastEvent = 'erreur AIS: ' + aisDerniereErreur; return; }
  if (m && m.Error) { aisDerniereErreur = String(m.Error).slice(0, 140); aisLastEvent = 'erreur AIS: ' + aisDerniereErreur; return; }
  if (!m || !m.MessageType) { aisLastEvent = 'message inattendu: ' + txt.slice(0, 140); return; }
  aisParType[m.MessageType] = (aisParType[m.MessageType] || 0) + 1;
  const TYPES_POSITION = { PositionReport: 1, StandardClassBPositionReport: 1, ExtendedClassBPositionReport: 1 };
  if (!TYPES_POSITION[m.MessageType]) { aisLastEvent = 'recu ' + m.MessageType; return; }
  const md = m.MetaData || {};
  /* le rapport porte le nom de son type ; Latitude/Longitude/Sog/Cog y sont
     identiques en classe A et B */
  const pr = (m.Message && m.Message[m.MessageType]) || {};
  const mmsi = String(md.MMSI || pr.UserID || '');
  const info = aisInfo.get(mmsi);
  if (!info) {
    if (aisMode === 'zone') { aisHorsFlotte++; return; }   /* normal en mode zone */
    aisRejetInconnu++; aisLastEvent = 'position hors liste (' + mmsi + ')'; return;
  }
  const now = Date.now();
  const lat = num(pr.Latitude != null ? pr.Latitude : md.latitude);
  const lon = num(pr.Longitude != null ? pr.Longitude : md.longitude);
  let t = now;
  if (md.time_utc) { const d = Date.parse(String(md.time_utc).replace(' +0000 UTC', 'Z').replace(' ', 'T')); if (!isNaN(d)) t = d; }
  if (lat === null || lon === null) { aisRejetCoord++; aisLastEvent = 'position sans coordonnees (' + mmsi + ')'; return; }
  aisPosOk++;
  await aisIngest(mmsi, lat, lon, t, num(pr.Sog), num(pr.Cog));
}

/* enregistrement d'une position AIS, quelle que soit la source */
async function aisIngest(mmsi, lat, lon, t, sog, cog) {
  const info = aisInfo.get(String(mmsi));
  if (!info) return false;
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  const now = Date.now();
  const key = String(mmsi);
  const tms = Math.round(t || now);
  if ((aisLastT.get(key) || 0) >= tms) return false;
  if (now - (aisLast.get(key) || 0) < info.ms) return false;
  aisLast.set(key, now); aisLastT.set(key, tms);
  const pt = [r6(lat), r6(lon), Math.round(t || now),
    (sog === null || sog >= 102.3) ? null : Math.round(sog * 10) / 10,
    (cog === null || cog >= 360) ? null : Math.round(cog)];
  try {
    await store.append(info.tid, [pt]);
    aisIngeres++;
    broadcast(info.tid, pt);
    for (const fid of info.fleets) broadcastFleet(fid, { b: info.tid, n: info.name, p: pt });
    return true;
  } catch { return false; }
}
const AIS_ATTENTES = [30000, 60000, 180000, 600000, 1800000, 3600000, 7200000];
const AIS_PLAFOND = 50; /* limite d'abonnement aisstream.io */
let aisProchain = 0;
/* les MMSI retenus pour le flux temps reel, du plus exigeant au moins exigeant */
function aisPrioritaires() {
  return Array.from(aisInfo.entries())
    .sort((a, b) => (a[1].ms - b[1].ms) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, AIS_PLAFOND)
    .map((e) => e[0]);
}
/* les MMSI suivis mais hors abonnement temps reel */
function aisHorsPlafond() {
  const dans = new Set(aisPrioritaires());
  return Array.from(aisInfo.keys()).filter((m) => !dans.has(m));
}
function aisReconnect() {
  if (!AIS_KEY) return;
  aisRetry = Math.min(aisRetry + 1, AIS_ATTENTES.length);
  const attente = AIS_ATTENTES[aisRetry - 1];
  aisProchain = Date.now() + attente;
  if (aisTimer) clearTimeout(aisTimer);
  aisTimer = setTimeout(aisConnect, attente);
  aisLastEvent += ' — nouvelle tentative dans ' + Math.round(attente / 60000) + ' min';
}
let aisMode = 'mmsi', aisZoneInfo = '', aisHorsFlotte = 0;
/* Boite englobant les dernieres positions connues de la flotte, elargie d'une
   marge. Retourne null si la flotte est trop dispersee ou trop peu localisee :
   dans ce cas on garde le filtre MMSI plutot que d'inonder la liaison. */
function aisBoiteFlotte() {
  const pos = [];
  for (const mmsi of aisInfo.keys()) {
    const p = aisLast.get(mmsi);
    if (p && isFinite(p[0]) && isFinite(p[1])) pos.push(p);
  }
  if (pos.length < 3) return null;
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (const p of pos) {
    if (p[0] < la0) la0 = p[0];
    if (p[0] > la1) la1 = p[0];
    if (p[1] < lo0) lo0 = p[1];
    if (p[1] > lo1) lo1 = p[1];
  }
  const marge = 2;
  la0 = Math.max(-90, la0 - marge); la1 = Math.min(90, la1 + marge);
  lo0 = Math.max(-180, lo0 - marge); lo1 = Math.min(180, lo1 + marge);
  const hauteur = la1 - la0, largeur = lo1 - lo0;
  if (hauteur > 40 || largeur > 60) return null;
  return { boite: [[la0, lo0], [la1, lo1]],
           info: Math.round(hauteur) + '\u00b0 x ' + Math.round(largeur) + '\u00b0, ' + pos.length + ' positions connues' };
}
function aisConnect(force) {
  if (!AIS_KEY || typeof WebSocket !== 'function') return;
  if (!force && Date.now() < aisProchain) return;
  if (aisTimer) { clearTimeout(aisTimer); aisTimer = null; }
  if (aisWs) { try { aisWs.onclose = null; aisWs.close(); } catch {} aisWs = null; }
  /* aisstream plafonne FiltersShipMMSI a 50 valeurs (documentation verifiee le
     31/07/2026) et n'offre AUCUN palier superieur : le service est gratuit.
     Mais le filtre MMSI est facultatif — l'abonnement se fait par boites
     geographiques. Donc :
       - 50 bateaux ou moins : filtre MMSI, volume minimal (mode « mmsi ») ;
       - au-dela, si la flotte tient dans une region raisonnable : abonnement
         a la zone sans filtre, tri des MMSI a la reception (mode « zone »),
         sans aucune limite de nombre. */
  const list = aisPrioritaires();
  const tousMmsi = Array.from(aisInfo.keys());
  let boites = [[[-90, -180], [90, 180]]], filtre = list;
  aisMode = 'mmsi';
  if (tousMmsi.length > 50) {
    const b = aisBoiteFlotte();
    if (b) { boites = [b.boite]; filtre = null; aisMode = 'zone'; aisZoneInfo = b.info; }
  }
  if (aisMode === 'mmsi' && !list.length) return;
  let ws;
  try { ws = new WebSocket('wss://stream.aisstream.io/v0/stream'); } catch { return aisReconnect(); }
  aisWs = ws;
  try { ws.binaryType = 'arraybuffer'; } catch {}
  ws.onopen = () => {
    aisRetry = 0; aisProchain = 0; aisOuvertA = Date.now();
    /* Pas de FilterMessageTypes : ce champ optionnel a provoque des fermetures
       en boucle (code 1006) des qu'on y a ajoute les types classe B. Le filtre
       FiltersShipMMSI borne deja le volume a nos bateaux ; le tri des types de
       message (classe A + classe B) est fait a la reception, dans aisHandle. */
    const sub = { APIKey: AIS_KEY, BoundingBoxes: boites };
    if (filtre) sub.FiltersShipMMSI = filtre;
    try { ws.send(JSON.stringify(sub)); } catch {}
    aisSubCount = filtre ? filtre.length : tousMmsi.length;
    aisLastEvent = filtre ? ('connecte, abonne a ' + filtre.length + ' MMSI')
                          : ('connecte, abonne a la zone (' + aisZoneInfo + ') pour ' + tousMmsi.length + ' bateaux');
    console.log('AIS: abonnement a ' + list.length + ' MMSI');
  };
  ws.onmessage = (ev) => { aisHandle(ev.data); };
  ws.onerror = () => { aisLastEvent = 'erreur de connexion'; };
  ws.onclose = (ev) => { if (aisOuvertA) aisDureeDerniereConnexion = Date.now() - aisOuvertA; aisLastEvent = 'connexion fermee' + (ev && ev.code ? ' (code ' + ev.code + ')' : '') + (aisDureeDerniereConnexion ? ' apres ' + Math.round(aisDureeDerniereConnexion / 1000) + ' s' : ''); if (aisWs === ws) { aisWs = null; aisReconnect(); } };
}
/* seconde source AIS : VesselAPI (REST, interrogation periodique) */
async function vapiPoll() {
  /* N'interroger QUE les bateaux qu'aisstream ne couvre pas en temps reel.
     Avant le 31/07, la liste complete etait envoyee — y compris les 50 deja
     recus gratuitement en direct — ce qui triplait la consommation de quota
     pour rien. Le quota est une ressource rare : chaque requete doit servir
     un bateau reellement non couvert. */
  const tempsReel = new Set(aisPrioritaires());
  const list = Array.from(aisInfo.keys()).filter((m) => !tempsReel.has(m));
  if (!VAPI_KEY || !list.length) { vapiLastEvent = VAPI_KEY ? 'inutile : tous les bateaux sont en temps reel' : 'inactif'; return; }
  if (Date.now() < vapiPauseJusqua) { vapiLastEvent = 'en pause (quota) encore ' + Math.round((vapiPauseJusqua - Date.now()) / 60000) + ' min'; return; }
  let lus = 0, gardes = 0, pages = 0, req = 0, erreur = '';
  const depuis = new Date(Date.now() - 24 * 3600000).toISOString();
  for (let i = 0; i < list.length; i += 50) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));   /* un lot par seconde : aucune rafale */
    const chunk = list.slice(i, i + 50);
    let curseur = '';
    for (let garde = 0; garde < 10; garde++) {
      let url = 'https://api.vesselapi.com/v1/vessels/positions?filter.idType=mmsi&pagination.limit=50'
        + '&time.from=' + encodeURIComponent(depuis) + '&filter.ids=' + chunk.join(',');
      if (curseur) url += '&pagination.cursor=' + encodeURIComponent(curseur);
      req++;
      let brut = '';
      try {
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + VAPI_KEY } });
        brut = await r.text();
        if (i === 0 && !curseur) vapiBrut = brut.slice(0, 300);
        if (!r.ok) {
          /* Documentation VesselAPI (verifiee le 31/07/2026) :
             - 429 = limite de debit courte OU quota mensuel epuise. L'en-tete
               Retry-After donne le delai exact : on le respecte a la seconde.
             - 403 = blocage pour abus soutenu (jusqu'a 6 h). Il se declenche
               quand un client insiste malgre des 429 repetes. On s'arrete donc
               franchement, sans jamais reessayer avant la fin du delai annonce.
             Ne jamais reessayer a l'interieur de la fenetre Retry-After : c'est
             precisement ce qui transforme une limite passagere en blocage long. */
          const enTeteRetry = parseInt(r.headers.get('retry-after') || '', 10);
          const restant = r.headers.get('x-ratelimit-remaining');
          if (restant !== null && restant !== undefined) vapiQuotaRestant = restant;
          if (r.status === 403) {
            erreur = 'HTTP 403 — cle temporairement suspendue (abus soutenu)';
            const sec = isFinite(enTeteRetry) && enTeteRetry > 0 ? Math.min(43200, enTeteRetry + 60) : 6 * 3600;
            vapiPauseJusqua = Date.now() + sec * 1000;
            erreur += ' — pause ' + Math.round(sec / 60) + ' min avant nouvel essai';
          } else if (r.status === 429) {
            let sec = 300;
            if (isFinite(enTeteRetry) && enTeteRetry > 0) sec = Math.min(43200, enTeteRetry + 5);
            else { const m = brut.match(/retry_after_seconds"?\s*:\s*(\d+)/i) || brut.match(/Retry after (\d+) seconds/i); if (m) sec = Math.min(43200, parseInt(m[1], 10) + 5); }
            const mensuel = /monthly quota/i.test(brut);
            erreur = 'HTTP 429 — ' + (mensuel ? 'quota mensuel epuise' : 'debit trop rapide');
            vapiPauseJusqua = Date.now() + (mensuel ? 6 * 3600 : sec) * 1000;
            erreur += ' — pause ' + Math.round((mensuel ? 360 : sec / 60)) + ' min';
          } else {
            erreur = 'HTTP ' + r.status + (r.status === 401 ? ' (cle refusee)' : r.status === 400 ? ' (requete refusee)' : '');
          }
          break;
        }
        { const restantOk = r.headers.get('x-ratelimit-remaining'); if (restantOk) vapiQuotaRestant = restantOk; }
      } catch (e) { erreur = 'echec reseau'; break; }
      let j = {}; try { j = JSON.parse(brut); } catch { erreur = 'reponse illisible'; break; }
      let rows = Array.isArray(j) ? j : (j.vesselPositions || j.data || j.vessels || j.positions || j.results || null);
      if (!rows) { for (const k of Object.keys(j || {})) { if (Array.isArray(j[k]) && j[k].length && typeof j[k][0] === 'object') { rows = j[k]; break; } } }
      rows = rows || [];
      pages++; lus += rows.length;
      for (const row of rows) {
        if (row.suspected_glitch) continue;
        const t = Date.parse(row.timestamp || row.processed_timestamp || '') || Date.now();
        if (await aisIngest(row.mmsi, num(row.latitude), num(row.longitude), t, num(row.sog), num(row.cog))) gardes++;
      }
      const suite = (j && (j.nextCursor || j.next_cursor || (j.pagination && (j.pagination.nextCursor || j.pagination.next_cursor)))) || '';
      if (!suite || !rows.length) break;
      curseur = suite;
    }
  }
  vapiPositions += gardes;
  vapiLastAt = Date.now();
  vapiLastEvent = erreur ? erreur : (list.length + ' MMSI · ' + req + ' requete(s) · ' + lus + ' position(s) lues · ' + gardes + ' enregistree(s)');
}
function vapiSchedule() {
  if (vapiTimer) { clearInterval(vapiTimer); vapiTimer = null; }
  if (!VAPI_KEY) return;
  /* on interroge au rythme du bateau le plus exigeant : interroger moins vite
     que lui rendrait son reglage inoperant. Les planchers ci-dessous protegent
     le quota mensuel en fonction du nombre de bateaux suivis. */
  let ms = null;
  for (const v of aisInfo.values()) if (v.ms && (ms === null || v.ms < ms)) ms = v.ms;
  if (ms === null) ms = 3600000;
  /* la cadence depend du nombre de bateaux HORS temps reel : ce sont les seuls
     qui coutent des requetes */
  const tempsReel2 = new Set(aisPrioritaires());
  const n = Array.from(aisInfo.keys()).filter((m) => !tempsReel2.has(m)).length;
  const mini = n === 0 ? 6 * 3600000 : (n > 50 ? 3600000 : (n > 20 ? 1800000 : 900000));
  if (ms < mini) ms = mini;
  vapiPollMs = ms;
  vapiTimer = setInterval(vapiPoll, ms);
  if (vapiTimer.unref) vapiTimer.unref();
  vapiPoll();
}

/* surveillance : retablit la liaison AIS si elle est tombee */
const aisWatch = setInterval(() => {
  if (!AIS_KEY || aisWs || !aisInfo.size) return;
  if (Date.now() < aisProchain) return;
  if (aisTimer) return;
  aisLastEvent = 'reconnexion automatique'; aisConnect();
}, 300000);
if (aisWatch.unref) aisWatch.unref();

/* Reconciliation : l'appartenance a une flotte vit a deux endroits (liste des
   membres de la flotte, et meta.fleets du bateau). Les bateaux crees avant la
   correction du 25/07 ont un meta.fleets vide : leurs positions AIS etaient
   stockees mais jamais diffusees aux flottes, et leur intervalle retombait au
   defaut. On repare ici en prenant la composition des flottes comme reference,
   sans jamais retirer une appartenance existante. */
async function reconcilierFlottes() {
  let repares = 0;
  try {
    const fids = await store.fleetIndex();
    for (const fid of fids) {
      let ids = [];
      try { ids = await store.fleetMembers(fid); } catch { continue; }
      for (let i = 0; i < ids.length; i += 12) {
        await Promise.all(ids.slice(i, i + 12).map(async (tid) => {
          try {
            const m = await store.getMeta(tid);
            if (!m) return;
            const f = m.fleets || [];
            if (f.indexOf(fid) < 0) { f.push(fid); m.fleets = f; await store.setMeta(m); repares++; }
          } catch {}
        }));
      }
    }
  } catch {}
  if (repares) console.log('[reconciliation] ' + repares + ' appartenance(s) de flotte reparee(s)');
  return repares;
}

async function aisRefresh(reconnect) {
  await reconcilierFlottes();
  try { aisMap = (await store.mmsiAll()) || {}; } catch { aisMap = {}; }
  aisInfo.clear();
  const fcache = new Map();
  const mmsis = Object.keys(aisMap);
  const metas = [];
  for (let i = 0; i < mmsis.length; i += 12) {
    const lot = mmsis.slice(i, i + 12);
    const r = await Promise.all(lot.map((m) => store.getMeta(aisMap[m]).catch(() => null)));
    for (const x of r) metas.push(x);
  }
  aisExclus = []; aisOrphelins = [];
  for (let k = 0; k < mmsis.length; k++) {
    const mmsi = mmsis[k];
    const tid = aisMap[mmsi];
    const meta = metas[k];
    if (!meta) { aisOrphelins.push(mmsi); continue; }
    if (meta.suivi === false) { aisExclus.push({ mmsi: mmsi, tid: tid, nom: meta.name || ('MMSI ' + mmsi) }); continue; }
    const fids = (meta && meta.fleets) || [];
    let best = null;
    for (const fid of fids) {
      let v = fcache.get(fid);
      if (v === undefined) {
        let f = null; try { f = await store.fleetGet(fid); } catch {}
        const mn = num(f && f.aisIntervalMin);
        v = (mn !== null && mn >= 1 && mn <= 180) ? mn : AIS_DEFAULT_MIN;
        fcache.set(fid, v);
      }
      if (best === null || v < best) best = v;
    }
    aisInfo.set(mmsi, { tid: tid, name: (meta && meta.name) || ('MMSI ' + mmsi), fleets: fids, ms: (best === null ? AIS_DEFAULT_MIN : best) * 60000 });
  }
  /* on oublie l'etat des MMSI qui ne sont plus suivis (sinon les deux Map
     grossissent indefiniment au fil des imports et des suppressions) */
  for (const k of Array.from(aisLast.keys())) if (!aisInfo.has(k)) aisLast.delete(k);
  for (const k of Array.from(aisLastT.keys())) if (!aisInfo.has(k)) aisLastT.delete(k);
  vapiSchedule();
  if (reconnect) aisConnect();
}

/* bascule automatique : au demarrage (differee) puis toutes les heures */
if (ARCHIVE_ACTIVE) {
  setTimeout(() => { archiveBasculer(false).catch(() => {}); }, 120000);
  setInterval(() => { archiveBasculer(false).catch(() => {}); }, 3600e3);
}
server.listen(PORT, () => { console.log('Sea Tracker (' + (USE_REDIS ? 'Upstash Redis' : 'fichiers') + ') sur http://localhost:' + PORT); if (AIS_KEY || VAPI_KEY) aisRefresh(!!AIS_KEY); });
