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
function parseMmsiLignes(lignes) {
  const items = [];
  for (const brut of lignes) {
    const ligne = String(brut).replace(/\u00a0/g, ' ').trim();
    if (!ligne) continue;
    const nums = (ligne.match(/\b\d{9}\b/g) || []);
    if (!nums.length) continue;
    const mmsi = nums.find((v) => !mmsiEcarte(v)) || nums[0];
    let nom = ligne; for (const n of nums) nom = nom.split(n).join(' ');
    nom = nom.replace(/[;,\t|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (/^(mmsi|n°|no|numero)$/i.test(nom)) continue;
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
  getMeta: async (id) => { const t = fileLoad(id); return t ? { id: t.id, name: t.name, keyHash: t.keyHash, createdAt: t.createdAt, fleets: t.fleets || [] } : null; },
  create: async (m) => { const t = Object.assign({ points: [] }, m); fileCache.set(m.id, t); fs.writeFileSync(fpath(m.id), JSON.stringify(t)); },
  setMeta: async (m) => { const t = fileLoad(m.id); if (!t) return; t.name = m.name; t.keyHash = m.keyHash; t.createdAt = m.createdAt; t.fleets = m.fleets || []; fs.writeFileSync(fpath(m.id), JSON.stringify(t)); },
  append: async (id, pts) => { const t = fileLoad(id); if (!t) return 0; for (const p of pts) t.points.push(p); fs.writeFileSync(fpath(id), JSON.stringify(t)); return t.points.length; },
  points: async (id) => { const t = fileLoad(id); return t ? t.points : []; },
  lastPoint: async (id) => { const t = fileLoad(id); return t && t.points.length ? t.points[t.points.length - 1] : null; },
  fleetCreate: async (m) => { const f = Object.assign({ members: [] }, m); fleetCache.set(m.id, f); fs.writeFileSync(fltPath(m.id), JSON.stringify(f)); },
  fleetGet: async (fid) => { const f = fleetLoad(fid); return f ? { id: f.id, name: f.name, createdAt: f.createdAt, aisIntervalMin: f.aisIntervalMin } : null; },
  fleetAdd: async (fid, tid) => { const f = fleetLoad(fid); if (!f) return; if (f.members.indexOf(tid) < 0) { f.members.push(tid); fs.writeFileSync(fltPath(fid), JSON.stringify(f)); } },
  fleetMembers: async (fid) => { const f = fleetLoad(fid); return f ? f.members : []; },
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
async function redisCmd(cmd) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await res.json();
  if (j.error) throw new Error('upstash: ' + j.error);
  return j.result;
}
const redisStore = {
  getMeta: async (id) => { const s = await redisCmd(['GET', rMeta(id)]); return s ? JSON.parse(s) : null; },
  create: async (m) => { await redisCmd(['SET', rMeta(m.id), JSON.stringify(m)]); },
  setMeta: async (m) => { await redisCmd(['SET', rMeta(m.id), JSON.stringify(m)]); },
  append: async (id, pts) => { const a = ['RPUSH', rPts(id)]; for (const p of pts) a.push(JSON.stringify(p)); return await redisCmd(a); },
  points: async (id) => { const arr = await redisCmd(['LRANGE', rPts(id), '0', '-1']); return (arr || []).map((x) => JSON.parse(x)); },
  lastPoint: async (id) => { const v = await redisCmd(['LINDEX', rPts(id), '-1']); return v ? JSON.parse(v) : null; },
  fleetCreate: async (m) => { await redisCmd(['SET', rFlt(m.id), JSON.stringify(m)]); },
  fleetGet: async (fid) => { const s = await redisCmd(['GET', rFlt(fid)]); return s ? JSON.parse(s) : null; },
  fleetAdd: async (fid, tid) => { await redisCmd(['RPUSH', rFltM(fid), tid]); },
  fleetMembers: async (fid) => { const a = await redisCmd(['LRANGE', rFltM(fid), '0', '-1']); return a || []; },
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
const store = USE_REDIS ? redisStore : fileStore;
const fleetClients = new Map();
function broadcastFleet(fid, obj) {
  const set = fleetClients.get(fid); if (!set) return;
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of set) { try { res.write(msg); } catch {} }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-publish-key'
};
function json(res, code, obj) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' }, CORS)); res.end(JSON.stringify(obj)); }
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
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl/dist/maplibre-gl.css">
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
<script src="https://unpkg.com/maplibre-gl/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.js"></script>
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

/* ---- attributions compactes, sans doublon, dépliables au tap ---- */
if(map.attributionControl)map.attributionControl.setPrefix('');
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
map.on('layeradd layerremove baselayerchange overlayadd overlayremove',function(){setTimeout(tidyAttrib,60);});
setTimeout(tidyAttrib,600);

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
var weather={};
var owmKey=(window.OWM_KEY||'');
if(owmKey){
  var owm=function(layer){return L.tileLayer('https://tile.openweathermap.org/map/'+layer+'/{z}/{x}/{y}.png?appid='+owmKey,
    {opacity:0.55,maxZoom:12,attribution:'Météo &copy; OpenWeather'});};
  weather['Vent']=owm('wind_new');
  weather['Pression']=owm('pressure_new');
  weather['Nuages']=owm('clouds_new');
  weather['Pluie']=owm('precipitation_new');
  weather['Température']=owm('temp_new');
}
var bases={};
try{ if(L.maplibreGL && window.maplibregl) bases['Carte marine (isobathes/sondes)']=L.maplibreGL({style:'https://tiles.openwaters.io/seascape/style.json',attribution:'Fonds &copy; openwaters.io (CC BY 4.0)'}); }catch(e){}
bases['Océan (Esri)']=esriOcean;
bases['Bathymétrie (EMODnet)']=emodnet;
bases['Satellite']=esriSat;
bases['OpenStreetMap']=osm;
var windGroup=L.layerGroup();
var overlays=Object.assign({'Balises (OpenSeaMap)':seamark,'Balises SHOM':shomBalise,'Vent animé (Open‑Meteo)':windGroup},weather);
/* ---- menu des calques (maison : ouverture au tap, indépendant de Leaflet) ---- */
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
    inp.onchange=function(){
      if(!this.checked)return;
      if(current&&current!==layer&&map.hasLayer(current))map.removeLayer(current);
      current=layer;
      if(!map.hasLayer(layer))map.addLayer(layer);
      if(layer.bringToBack){try{layer.bringToBack();}catch(e){}}
      map.fire('baselayerchange',{layer:layer,name:name});
    };
  }
  function addOverlay(layer, name){
    var lab=document.createElement('label');
    var inp=document.createElement('input'); inp.type='checkbox'; inp.checked=map.hasLayer(layer);
    var sp=document.createElement('span'); sp.textContent=name;
    lab.appendChild(inp); lab.appendChild(sp); boxO.appendChild(lab);
    inp.onchange=function(){
      if(this.checked){ if(!map.hasLayer(layer))map.addLayer(layer); map.fire('overlayadd',{layer:layer,name:name}); }
      else { if(map.hasLayer(layer))map.removeLayer(layer); map.fire('overlayremove',{layer:layer,name:name}); }
    };
  }
  for(var b in bases) addBase(b, bases[b]);
  for(var o in overlays) addOverlay(overlays[o], o);
  btn.onclick=function(e){ e.stopPropagation(); panel.classList.toggle('open'); };
  panel.addEventListener('click',function(e){ e.stopPropagation(); });
  document.addEventListener('click',function(){ panel.classList.remove('open'); });
  return { addOverlay:addOverlay, panel:panel, button:btn };
}
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
// Vent animé (particules) via leaflet-velocity + Open-Meteo
var MODELS=[{v:'best_match',t:'Auto (best match)'},{v:'meteofrance_arome_france_hd',t:'AROME France HD 1.5 km'},{v:'meteofrance_arpege_europe',t:'ARPEGE Europe 11 km'},{v:'icon_eu',t:'ICON-EU 7 km'},{v:'ecmwf_ifs025',t:'ECMWF 25 km'},{v:'gfs_seamless',t:'GFS 25 km'}];
var HOURS=[{v:0,t:'Maintenant'},{v:6,t:'+6 h'},{v:12,t:'+12 h'},{v:24,t:'+24 h'},{v:48,t:'+48 h'}];
function fillSel(sel,list,def){list.forEach(function(o){var e=document.createElement('option');e.value=o.v;e.textContent=o.t;if(String(o.v)===String(def))e.selected=true;sel.appendChild(e);});}
fillSel(document.getElementById('windModel'),MODELS,'best_match');
fillSel(document.getElementById('windHour'),HOURS,0);
fillSel(document.getElementById('fcModel'),MODELS,'best_match');

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

function dirArrow(deg){var a=['↓','↙','←','↖','↑','↗','→','↘'];return a[Math.round(((deg||0)%360)/45)%8];}
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
  fetch('/api/point?lat='+ll.lat.toFixed(3)+'&lon='+ll.lng.toFixed(3)).then(function(r){return r.json();}).then(function(d){
    pop.setContent('<div style="font-size:12px;line-height:1.6">'
      +'<b>'+fmtCoord(ll.lat,ll.lng)+'</b><br>'
      +'💨 Vent : '+(d.wind!=null?Math.round(d.wind)+' kt '+dtxt(d.windDir):'—')+'<br>'
      +'🔽 Pression : '+(d.pressure!=null?Math.round(d.pressure)+' hPa':'—')+'<br>'
      +'🌊 Courant : '+(d.curSpeed!=null?d.curSpeed.toFixed(1)+' kt '+dtxt(d.curDir):'—')
      +'</div>');
  }).catch(function(){pop.setContent('Erreur de chargement');});
});
// Radar pluie RainViewer (sans clé)
fetch('https://api.rainviewer.com/public/weather-maps.json').then(function(r){return r.json();}).then(function(d){
  if(d&&d.radar&&d.radar.past&&d.radar.past.length){
    var f=d.radar.past[d.radar.past.length-1];
    var radar=L.tileLayer((d.host||'https://tilecache.rainviewer.com')+f.path+'/256/{z}/{x}/{y}/2/1_1.png',
      {opacity:0.6,maxZoom:12,attribution:'Radar &copy; RainViewer'});
    layerCtl.addOverlay(radar,'Radar pluie');
  }
}).catch(function(){});

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
const PAGE_FLEET = `<!DOCTYPE html>
<html lang="fr">
<head><link rel="manifest" href="__MANIFEST__"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Sea Tracker"><meta name="theme-color" content="#0a1a26"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png"><script>if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Suivi de flotte</title>
<link rel="stylesheet" href="/vendor/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl/dist/maplibre-gl.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.css">
<style>
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
  #legend{position:fixed;right:8px;bottom:calc(env(safe-area-inset-bottom) + 8px);z-index:1200;background:var(--panel);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:12px;padding:8px 10px;max-height:46vh;overflow:auto;min-width:150px;max-width:60vw}
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

  .leaflet-tooltip.boat-name{background:rgba(10,26,38,.82);border:0;color:#fff;font-weight:700;font-size:11px;padding:1px 6px;border-radius:6px;box-shadow:none;white-space:nowrap}
  .leaflet-tooltip.boat-name:before{display:none}
  .lgh label{text-transform:none;letter-spacing:0;cursor:pointer}
  .lgh input{vertical-align:-1px}
  .lgi.off{opacity:.55}
  .sp.offsp{color:#8fb0c2;font-size:11px;font-variant-numeric:normal}
  .lgexp{margin-top:8px;padding-top:7px;border-top:1px solid var(--line);font-size:11px;color:var(--dim)}
  .lgexp a{color:#39c0d3;text-decoration:none;font-weight:600}
  .del{margin-left:8px;color:#5f7482;cursor:pointer}
  .del:hover,.del:active{color:#e6584c}
</style>
</head>
<body>
<div id="map"></div>
<div class="bar"><a href="/admin" id="back" style="display:none;color:#39c0d3;text-decoration:none;font-size:12px;font-weight:600">‹ Console</a><b id="flname">Flotte</b><div class="sub" id="flcount">Connexion…</div>
  <select id="flswitch" style="display:none;margin-top:7px;width:100%;background:#0a1e2c;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 7px;font-size:12px"></select>
</div>
<button class="fitbtn" id="fit">⤢ Tout voir</button>
<div id="legend"><div class="lgh">Flotte</div></div>
<div id="windCtl"><div class="t">Vent — modèle (précision) &amp; échéance</div><select id="windModel"></select><select id="windHour"></select></div>

<script src="/vendor/leaflet.js"></script>
<script src="https://unpkg.com/maplibre-gl/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.js"></script>
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

var map=L.map('map',{zoomControl:true,worldCopyJump:true}).setView([47,-5],6);
map.createPane('windPane');map.getPane('windPane').style.zIndex=550;map.getPane('windPane').style.pointerEvents='none';

/* ---- attributions compactes, sans doublon, dépliables au tap ---- */
if(map.attributionControl)map.attributionControl.setPrefix('');
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
map.on('layeradd layerremove baselayerchange overlayadd overlayremove',function(){setTimeout(tidyAttrib,60);});
setTimeout(tidyAttrib,600);


/* ---- fonds de carte (identiques au suivi solo) ---- */
var esriOcean=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',{maxZoom:16,attribution:'Esri Ocean'});
var esriSat=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,attribution:'Esri'});
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
(bases['Carte marine (isobathes/sondes)']||esriOcean).addTo(map);
seamark.addTo(map);
var weather={};
var owmKey=(window.OWM_KEY||'');
if(owmKey){
  var owm=function(layer){return L.tileLayer('https://tile.openweathermap.org/map/'+layer+'/{z}/{x}/{y}.png?appid='+owmKey,{opacity:0.55,maxZoom:12,attribution:'Météo &copy; OpenWeather'});};
  weather['Vent']=owm('wind_new');weather['Pression']=owm('pressure_new');weather['Nuages']=owm('clouds_new');weather['Pluie']=owm('precipitation_new');weather['Température']=owm('temp_new');
}
var windGroup=L.layerGroup();
var overlays=Object.assign({'Balises (OpenSeaMap)':seamark,'Balises SHOM':shomBalise,'Vent animé (Open‑Meteo)':windGroup},weather);
/* ---- menu des calques (maison : ouverture au tap, indépendant de Leaflet) ---- */
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
    inp.onchange=function(){
      if(!this.checked)return;
      if(current&&current!==layer&&map.hasLayer(current))map.removeLayer(current);
      current=layer;
      if(!map.hasLayer(layer))map.addLayer(layer);
      if(layer.bringToBack){try{layer.bringToBack();}catch(e){}}
      map.fire('baselayerchange',{layer:layer,name:name});
    };
  }
  function addOverlay(layer, name){
    var lab=document.createElement('label');
    var inp=document.createElement('input'); inp.type='checkbox'; inp.checked=map.hasLayer(layer);
    var sp=document.createElement('span'); sp.textContent=name;
    lab.appendChild(inp); lab.appendChild(sp); boxO.appendChild(lab);
    inp.onchange=function(){
      if(this.checked){ if(!map.hasLayer(layer))map.addLayer(layer); map.fire('overlayadd',{layer:layer,name:name}); }
      else { if(map.hasLayer(layer))map.removeLayer(layer); map.fire('overlayremove',{layer:layer,name:name}); }
    };
  }
  for(var b in bases) addBase(b, bases[b]);
  for(var o in overlays) addOverlay(overlays[o], o);
  btn.onclick=function(e){ e.stopPropagation(); panel.classList.toggle('open'); };
  panel.addEventListener('click',function(e){ e.stopPropagation(); });
  document.addEventListener('click',function(){ panel.classList.remove('open'); });
  return { addOverlay:addOverlay, panel:panel, button:btn };
}
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
var MODELS=[{v:'best_match',t:'Auto (best match)'},{v:'meteofrance_arome_france_hd',t:'AROME France HD 1.5 km'},{v:'meteofrance_arpege_europe',t:'ARPEGE Europe 11 km'},{v:'icon_eu',t:'ICON-EU 7 km'},{v:'ecmwf_ifs025',t:'ECMWF 25 km'},{v:'gfs_seamless',t:'GFS 25 km'}];
var HOURS=[{v:0,t:'Maintenant'},{v:6,t:'+6 h'},{v:12,t:'+12 h'},{v:24,t:'+24 h'},{v:48,t:'+48 h'}];
function fillSel(sel,list,def){list.forEach(function(o){var e=document.createElement('option');e.value=o.v;e.textContent=o.t;if(String(o.v)===String(def))e.selected=true;sel.appendChild(e);});}
fillSel($('windModel'),MODELS,'best_match');fillSel($('windHour'),HOURS,0);
var windLayer=null,windBusy=false;
function windOpts(d){return {displayValues:true,displayOptions:{velocityType:'Vent',position:'bottomleft',emptyString:'—',angleConvention:'bearingCW',speedUnit:'kt'},data:d,minVelocity:0,maxVelocity:18,velocityScale:0.014,opacity:1,lineWidth:2.4,particleAge:110,paneName:'windPane',particleMultiplier:1/170,colorScale:['#3a4cff','#0091ff','#00c2ff','#00e0a0','#61ff3d','#d4ff00','#ffd000','#ff8a00','#ff3b2f','#ff0a78']};}
function loadWind(){if(!L.velocityLayer)return;windBusy=true;var c=map.getCenter();var model=$('windModel').value,hour=$('windHour').value;fetch('/api/wind?lat='+c.lat.toFixed(2)+'&lon='+c.lng.toFixed(2)+'&model='+encodeURIComponent(model)+'&hour='+hour).then(function(r){return r.json();}).then(function(d){windBusy=false;if(windLayer){windGroup.removeLayer(windLayer);windLayer=null;}windLayer=L.velocityLayer(windOpts(d));windGroup.addLayer(windLayer);}).catch(function(){windBusy=false;});}
map.on('overlayadd',function(e){if(e.layer!==windGroup)return;$('windCtl').style.display='block';if(!windLayer&&!windBusy)loadWind();});
map.on('overlayremove',function(e){if(e.layer!==windGroup)return;$('windCtl').style.display='none';if(windLayer){windGroup.removeLayer(windLayer);windLayer=null;}});
$('windModel').onchange=function(){if(map.hasLayer(windGroup))loadWind();};
$('windHour').onchange=function(){if(map.hasLayer(windGroup))loadWind();};
fetch('https://api.rainviewer.com/public/weather-maps.json').then(function(r){return r.json();}).then(function(d){if(d&&d.radar&&d.radar.past&&d.radar.past.length){var fr=d.radar.past[d.radar.past.length-1];var radar=L.tileLayer((d.host||'https://tilecache.rainviewer.com')+fr.path+'/256/{z}/{x}/{y}/2/1_1.png',{opacity:0.6,maxZoom:12,attribution:'Radar &copy; RainViewer'});layerCtl.addOverlay(radar,'Radar pluie');}}).catch(function(){});

/* ---- gestion des bateaux ---- */
function boatColor(id){var h=0;for(var i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return 'hsl('+(h%360)+',85%,55%)';}
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
var boats={};
var showNames=true;
var OFFLINE_MS=15*60*1000; // seuil hors-ligne (15 min) — réglable
function isOnline(b){return !!(b.last && (Date.now()-b.last[2])<=OFFLINE_MS);}
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

function boatAdd(id,name,p){
  var b=ensureBoat(id,name);
  var ll=[p[0],p[1]];
  b.trace.addLatLng(ll);
  if(!b.marker){
    b.marker=L.circleMarker(ll,{radius:6,color:'#fff',weight:1.6,fillColor:b.color,fillOpacity:1}).addTo(map)
      .bindTooltip(b.name,{permanent:true,direction:'right',offset:[9,0],className:'boat-name'});
    if(!showNames) b.marker.closeTooltip();
  } else { b.marker.setLatLng(ll); b.marker.setTooltipContent(b.name); }
  b.last=p;
  drawVector(b);
  updateBoatStyle(b);
  applyVisibility();
  renderLegend();
}
function applyNames(){for(var k in boats){var b=boats[k];if(b.marker){if(showNames)b.marker.openTooltip();else b.marker.closeTooltip();}}}
function renderLegend(){
  var el=$('legend');
  var ks=Object.keys(boats).filter(function(k){return !onlineOnly||isOnline(boats[k]);});
  var total=Object.keys(boats).length,hidden=total-ks.length;
  var head=ks.length+' bateau'+(ks.length>1?'x':'');
  if(onlineOnly&&hidden>0)head+=' · '+hidden+' masqué'+(hidden>1?'s':'');
  var html='<div class="lgh">'+head+' · <label><input type="checkbox" id="nameToggle"'+(showNames?' checked':'')+'> Noms</label> · <label><input type="checkbox" id="onlineToggle"'+(onlineOnly?' checked':'')+'> Émet</label></div>';
  ks.sort(function(a,bk){return (boats[a].name||'').localeCompare(boats[bk].name||'');});
  ks.forEach(function(k){var b=boats[k];var on=isOnline(b);
    var right;
    if(on){
      var sp=(b.last&&b.last[3]!=null)?(Math.round(b.last[3]*10)/10)+' kt':'—';
      var cp=(b.last&&b.last[4]!=null)?(Math.round(b.last[4])+'°'):'';
      right=cp?(sp+' · '+cp):sp;
    } else right=(b.last?'vu '+fmtAge(b.last[2]):'—');
    html+='<div class="lgi'+(on?'':' off')+'" data-id="'+k+'"><span class="dot" style="background:'+(on?b.color:'#6b7f8c')+'"></span><span>'+esc(b.name)+'</span><span class="sp'+(on?'':' offsp')+'">'+right+'</span><span class="del" data-del="'+k+'" title="Retirer de la flotte">✕</span></div>';});
  html+='<div class="lgexp">⤓ Traces flotte : <a href="/api/fleets/'+fid+'/export?format=gpx">GPX</a> · <a href="/api/fleets/'+fid+'/export?format=csv">CSV</a></div>';
  el.innerHTML=html;
  var ntg=$('nameToggle');if(ntg)ntg.onchange=function(){showNames=this.checked;applyNames();};
  var otg=$('onlineToggle');if(otg)otg.onchange=function(){onlineOnly=this.checked;applyVisibility();renderLegend();};
  var rows=el.querySelectorAll('.lgi');
  for(var i=0;i<rows.length;i++){rows[i].onclick=function(){var b=boats[this.getAttribute('data-id')];if(b&&b.last)map.setView([b.last[0],b.last[1]],Math.max(map.getZoom(),12));};}
  var dels=el.querySelectorAll('.del');
  for(var d=0;d<dels.length;d++){dels[d].onclick=function(ev){ev.stopPropagation();var did=this.getAttribute('data-del');var b=boats[did];if(!confirm('Retirer '+((b&&b.name)||'ce bateau')+' de la flotte ?'))return;fetch('/api/fleets/'+fid+'/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trackId:did})}).then(function(){if(b){if(b.marker)map.removeLayer(b.marker);if(b.trace)map.removeLayer(b.trace);if(b.vec)map.removeLayer(b.vec);}delete boats[did];renderLegend();}).catch(function(){});};}
}
function refreshStatus(){for(var k in boats)updateBoatStyle(boats[k]);applyVisibility();renderLegend();}
setInterval(refreshStatus,30000);
function fitAll(){var g=[];for(var k in boats)if(boats[k].last)g.push([boats[k].last[0],boats[k].last[1]]);if(g.length===1)map.setView(g[0],11);else if(g.length)map.fitBounds(g,{padding:[50,50],maxZoom:12});}
$('fit').onclick=fitAll;

/* ---- chargement + temps réel ---- */
if(!fid){$('flname').textContent='Lien de flotte invalide';}
else{
  fetch('/api/fleets/'+fid).then(function(r){return r.json();}).then(function(d){
    if(d.error){$('flname').textContent='Flotte introuvable';$('flcount').textContent='';return;}
    $('flname').textContent=d.name||'Flotte';
    (d.boats||[]).forEach(function(bo){ if(bo.last) boatAdd(bo.id,bo.name,bo.last); else ensureBoat(bo.id,bo.name); });
    redrawVectors();
    renderLegend(); fitAll(); subscribe();
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
function dirArrow(deg){var a=['↓','↙','←','↖','↑','↗','→','↘'];return a[Math.round(((deg||0)%360)/45)%8];}
map.on('click',function(e){
  var ll=e.latlng;
  var pop=L.popup({maxWidth:230}).setLatLng(ll).setContent('Chargement…').openOn(map);
  function dt(d){return d==null?'—':(dirArrow(d)+' '+Math.round(d)+'°');}
  fetch('/api/point?lat='+ll.lat.toFixed(3)+'&lon='+ll.lng.toFixed(3)).then(function(r){return r.json();}).then(function(d){
    pop.setContent('<div style="font-size:12px;line-height:1.6">'
      +'💨 Vent : '+(d.wind!=null?Math.round(d.wind)+' kt '+dt(d.windDir):'—')+'<br>'
      +'🔽 Pression : '+(d.pressure!=null?Math.round(d.pressure)+' hPa':'—')+'<br>'
      +'🌊 Courant : '+(d.curSpeed!=null?d.curSpeed.toFixed(1)+' kt '+dt(d.curDir):'—')+'</div>');
  }).catch(function(){pop.setContent('Erreur');});
});
</script>
</body>
</html>
`;
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
      <option value="1">1 minute</option>
      <option value="2">2 minutes</option>
      <option value="5">5 minutes</option>
      <option value="10">10 minutes</option>
      <option value="15">15 minutes</option>
      <option value="30">30 minutes</option>
    </select>
    <p id="aisIntMsg" class="hint">Vaut pour les bateaux AIS de cette flotte. Plus l'intervalle est court, plus la trace est fine — et plus le quota de stockage est consommé.</p>
    <p class="hint">Portée : réseau de stations côtières. Un AIS classe B (2 W) porte 8–10 milles — parfait près des côtes, inopérant au large.</p>
  </div>
</div>
<script>
"use strict";
var fid=new URLSearchParams(location.search).get('fleet');
var $=function(i){return document.getElementById(i);};
if(!fid){$('sub').textContent='Lien de flotte invalide ou manquant.';$('form').style.display='none';$('aisBox').style.display='none';}
$('aisGo').onclick=function(){
  var nm=$('aisName').value.trim(), mm=$('aisMmsi').value.replace(/[^0-9]/g,'');
  if(mm.length!==9){$('aisMsg').style.color='#e6584c';$('aisMsg').textContent='Le MMSI doit comporter 9 chiffres.';return;}
  $('aisMsg').style.color='';$('aisMsg').textContent='…';$('aisGo').disabled=true;
  fetch('/api/fleets/'+fid+'/mmsi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm,mmsi:mm})})
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
  fetch('/api/fleets/'+fid+'/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({aisIntervalMin:parseInt(v,10)})})
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
      +'<select data-int="'+f.id+'">'+[1,2,5,10,15,30].map(function(v){return '<option value="'+v+'"'+(v===f.aisIntervalMin?' selected':'')+'>'+v+' min</option>';}).join('')+'</select>'):'')
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
    fetch('/api/fleets/'+fid+'/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({aisIntervalMin:v})})
      .then(function(r){return r.json();}).then(function(d){
        if(d.error){say(m,d.error,'err');return;}
        say(m,'AIS : un point toutes les '+d.aisIntervalMin+' min.','ok');
      });
  };});
  document.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){
    var fid=this.getAttribute('data-del');
    var f=fleets.filter(function(x){return x.id===fid;})[0];
    if(!confirm('Supprimer la flotte « '+((f&&f.name)||fid)+' » ?\\n\\nLes traces des bateaux sont conservées, mais la flotte et ses liens ne fonctionneront plus.'))return;
    api('/api/admin/fleets/'+fid,{method:'DELETE'}).then(function(){reload();});
  };});
}

function loadBoats(fid){
  var box=document.querySelector('[data-boats="'+fid+'"]');
  fetch('/api/fleets/'+fid).then(function(r){return r.json();}).then(function(d){
    var b=(d&&d.boats)||[];
    if(!b.length){box.innerHTML='<div class="empty">Aucun bateau. Partage le lien d\\u2019invitation'+(AIS?' ou ajoute un MMSI ci-dessous':'')+'.</div>';}
    else{
      box.innerHTML=b.map(function(x){
        var on=x.last&&(Date.now()-x.last[2])<900000;
        var st=x.last?(on?((x.last[3]!=null?(Math.round(x.last[3]*10)/10)+' kt':'en ligne')):('vu '+age(x.last[2]))):'jamais vu';
        return '<div class="boat"><span class="dot" style="background:'+(on?'#37c871':'#6b7f8c')+'"></span>'
          +'<span class="bn">'+esc(x.name)+'</span><span class="bs">'+st+'</span>'
          +'<span class="x" data-rm="'+fid+'|'+x.id+'|'+esc(x.name)+'">✕</span></div>';
      }).join('');
    }
    box.innerHTML+='<div class="lbl" style="margin-top:12px">Ajouter un bateau par AIS (MMSI)</div>';
    if(AIS){
      box.innerHTML+='<div class="lbl" style="margin-top:4px">Importer un fichier (txt, csv, xlsx)</div>'
        +'<input type="file" data-bfile="'+fid+'" accept=".txt,.csv,.tsv,.xlsx" style="padding:8px">'
        +'<div class="lbl" style="margin-top:10px">Ou coller une liste</div>'
        +'<textarea data-blk="'+fid+'" placeholder="Une ligne par bateau&#10;Magenta ; 205560470" style="min-height:70px;margin-bottom:6px"></textarea>'
        +'<button class="sec" data-bgo="'+fid+'">Importer la liste collée</button>'
        +'<div class="lbl" style="margin-top:12px">Ou un bateau à la fois</div>'
        +'<input data-mn="'+fid+'" placeholder="Nom du bateau" maxlength="40">'
        +'<input data-mm="'+fid+'" placeholder="MMSI (9 chiffres)" inputmode="numeric" maxlength="9" style="margin-top:6px">'
        +'<button class="sec" data-madd="'+fid+'">Ajouter par MMSI</button>';
    } else {
      box.innerHTML+='<p class="sub" style="margin:4px 0 0">Suivi AIS inactif : il faut une clé <b>aisstream.io</b> (gratuite) '
        +'ajoutée dans la variable <code>AIS_API_KEY</code> sur le serveur. Tant qu\\'elle manque, les bateaux ne peuvent être suivis '
        +'que par l\\'application Traccar (lien d\\'invitation).</p>';
    }
    box.querySelectorAll('[data-rm]').forEach(function(s){s.onclick=function(){
      var parts=this.getAttribute('data-rm').split('|');
      if(!confirm('Retirer '+parts[2]+' de la flotte ?'))return;
      fetch('/api/fleets/'+parts[0]+'/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trackId:parts[1]})})
        .then(function(){loadBoats(parts[0]);reload();});
    };});
    function envoiImport(fid,charge){
      var m=document.querySelector('[data-msg="'+fid+'"]');
      say(m,'Import en cours…','');
      fetch('/api/fleets/'+fid+'/mmsi/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(charge)})
       .then(function(r){return r.json();}).then(function(d){
         if(d.error){say(m,d.error,'err');return;}
         var txt=d.ajoutes+' ajouté(s), '+d.deja+' déjà suivi(s) — '+d.trouves+' MMSI sur '+d.lignes+' ligne(s).';
         if(d.noms&&d.noms.length)txt+=' Ex. : '+d.noms.join(', ');
         say(m,txt,'ok');
         var ta=box.querySelector('[data-blk="'+fid+'"]'); if(ta)ta.value='';
         loadBoats(fid);reload();
       }).catch(function(){say(m,'Erreur réseau.','err');});
    }
    var bgo=box.querySelector('[data-bgo]');
    if(bgo)bgo.onclick=function(){
      var txt=box.querySelector('[data-blk="'+fid+'"]').value;
      if(!txt.trim()){say(document.querySelector('[data-msg="'+fid+'"]'),'Colle une liste d\\'abord.','err');return;}
      envoiImport(fid,{text:txt});
    };
    var bfile=box.querySelector('[data-bfile]');
    if(bfile)bfile.onchange=function(){
      var f=this.files&&this.files[0]; if(!f)return;
      var m=document.querySelector('[data-msg="'+fid+'"]');
      if(f.size>4000000){say(m,'Fichier trop volumineux (4 Mo maximum).','err');return;}
      say(m,'Lecture de '+f.name+'…','');
      var fr=new FileReader();
      fr.onload=function(){
        var b64=String(fr.result).split(',')[1]||'';
        envoiImport(fid,{name:f.name,b64:b64});
      };
      fr.onerror=function(){say(m,'Lecture du fichier impossible.','err');};
      fr.readAsDataURL(f);
    };
    var add=box.querySelector('[data-madd]');
    if(add)add.onclick=function(){
      var nm=box.querySelector('[data-mn="'+fid+'"]').value.trim();
      var mm=box.querySelector('[data-mm="'+fid+'"]').value.replace(/[^0-9]/g,'');
      var m=document.querySelector('[data-msg="'+fid+'"]');
      if(mm.length!==9){say(m,'Le MMSI doit comporter 9 chiffres.','err');return;}
      fetch('/api/fleets/'+fid+'/mmsi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm,mmsi:mm})})
        .then(function(r){return r.json();}).then(function(d){
          if(d.error){say(m,d.error,'err');return;}
          say(m,d.already?'Déjà suivi — rattaché à cette flotte.':'Ajouté. Il apparaîtra dès qu\\u2019une station AIS le captera.','ok');
          loadBoats(fid);reload();
        });
    };
  }).catch(function(){box.innerHTML='<div class="empty">Erreur de chargement.</div>';});
}

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
const BUILD = '22/07 18:36';
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
      req.on('close', () => { clearInterval(ping); const s = clients.get(meta.id); if (s) s.delete(res); });
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
        return json(res, 200, {
          build: BUILD,
          varsVues: names.map((n) => ({ nom: n, longueurNom: n.length, valeurRenseignee: !!process.env[n], longueurValeur: (process.env[n] || '').length })),
          aisKeyDetectee: !!AIS_KEY,
          aisKeyLongueur: AIS_KEY.length,
          websocketDispo: typeof WebSocket === 'function',
          aisConnexion: aisWs ? 'ouverte' : 'fermee',
          aisDernierEvenement: aisLastEvent,
          aisMmsiSuivis: Object.keys(aisMap),
          aisAbonnes: aisSubCount,
          aisMessagesRecus: aisMsgCount,
          aisDernierMessageIlYaSec: aisLastMsgAt ? Math.round((Date.now() - aisLastMsgAt) / 1000) : null,
          vesselapiCleDetectee: !!VAPI_KEY,
          vesselapiIntervalleSec: vapiPollMs ? Math.round(vapiPollMs / 1000) : null,
          vesselapiDernierEvenement: vapiLastEvent,
          vesselapiPositionsEnregistrees: vapiPositions,
          vesselapiDerniereLectureIlYaSec: vapiLastAt ? Math.round((Date.now() - vapiLastAt) / 1000) : null,
          vesselapiReponseBrute: vapiBrut
        });
      }
      if (p === '/api/admin/aistest' && req.method === 'GET') {
        if (!AIS_KEY) return json(res, 200, { ok: false, raison: 'aucune cle AIS configuree' });
        if (typeof WebSocket !== 'function') return json(res, 200, { ok: false, raison: 'websocket indisponible' });
        const filtre = u.searchParams.get('filtre') === '1';
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
      if (p === '/api/admin/fleets' && req.method === 'GET') {
        const ids = await store.fleetIndex();
        const lots = await Promise.all(ids.map(async (fid) => {
          try {
            const [f, mem] = await Promise.all([store.fleetGet(fid), store.fleetMembers(fid).catch(() => [])]);
            if (!f) return null;
            const mn = num(f.aisIntervalMin);
            return { id: fid, name: f.name, createdAt: f.createdAt, boats: (mem || []).length, aisIntervalMin: (mn !== null && mn >= 1 && mn <= 60) ? mn : AIS_DEFAULT_MIN };
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
        await store.fleetDelete(mAdmF[1]);
        await aisRefresh(false);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'route console inconnue' });
    }
    const mFleetRemove = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/remove$/);
    if (mFleetRemove && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const tid = String(body.trackId || '');
      if (!/^[a-f0-9]{16}$/.test(tid)) return json(res, 400, { error: 'trackId invalide' });
      await store.fleetRemove(mFleetRemove[1], tid);
      broadcastFleet(mFleetRemove[1], { rm: tid });
      return json(res, 200, { ok: true });
    }
    const mFleetSet = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/settings$/);
    if (mFleetSet) {
      const fid = mFleetSet[1];
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      if (req.method === 'GET') {
        const mn = num(fleet.aisIntervalMin);
        return json(res, 200, { aisIntervalMin: (mn !== null && mn >= 1 && mn <= 60) ? mn : AIS_DEFAULT_MIN, aisEnabled: !!(AIS_KEY || VAPI_KEY), aisDefaultMin: AIS_DEFAULT_MIN });
      }
      if (req.method === 'POST') {
        let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
        const mn = num(parseInt(body.aisIntervalMin, 10));
        if (mn === null || mn < 1 || mn > 60) return json(res, 400, { error: 'Intervalle attendu entre 1 et 60 minutes' });
        await store.fleetUpdate(fid, { aisIntervalMin: mn });
        await aisRefresh(false);
        return json(res, 200, { aisIntervalMin: mn });
      }
    }
    const mFleetImp = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/mmsi\/import$/);
    if (mFleetImp && req.method === 'POST') {
      const fid = mFleetImp[1];
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      if (!AIS_KEY && !VAPI_KEY) return json(res, 503, { error: 'Suivi AIS non configure sur ce serveur' });
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      let lignes = [];
      try {
        if (body.b64) lignes = lignesDepuisFichier(body.name || '', Buffer.from(String(body.b64), 'base64'));
        else if (body.text) lignes = String(body.text).split(/\r?\n/);
      } catch { return json(res, 400, { error: 'Fichier illisible' }); }
      const items = parseMmsiLignes(lignes).slice(0, 200);
      if (!items.length) return json(res, 400, { error: 'Aucun MMSI a 9 chiffres trouve dans ce contenu' });
      const known = await store.mmsiAll();
      const bilan = { lignes: lignes.length, trouves: items.length, ajoutes: 0, deja: 0, noms: [] };
      for (const it of items) {
        const mmsi = it.mmsi, nom = it.name || ('MMSI ' + mmsi);
        if (known[mmsi]) { await store.fleetAdd(fid, known[mmsi]); bilan.deja++; continue; }
        const id = id16(), publishKey = key24();
        const meta = { id, name: nom, keyHash: sha(publishKey), createdAt: Date.now(), fleets: [fid], mmsi: mmsi };
        await store.create(meta);
        await store.fleetAdd(fid, id);
        await store.mmsiSet(mmsi, id);
        known[mmsi] = id;
        bilan.ajoutes++;
        if (bilan.noms.length < 5) bilan.noms.push(nom + ' (' + mmsi + ')');
      }
      await aisRefresh(false);
      return json(res, 201, bilan);
    }
    const mFleetMmsi = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/mmsi$/);
    if (mFleetMmsi && req.method === 'POST') {
      const fid = mFleetMmsi[1];
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const mmsi = String(body.mmsi || '').replace(/[^0-9]/g, '');
      if (!/^[0-9]{9}$/.test(mmsi)) return json(res, 400, { error: 'MMSI invalide (9 chiffres attendus)' });
      if (!AIS_KEY && !VAPI_KEY) return json(res, 503, { error: 'Suivi AIS non configure sur ce serveur (AIS_API_KEY ou VESSELAPI_KEY manquante)' });
      const known = await store.mmsiAll();
      if (known && known[mmsi]) { await store.fleetAdd(fid, known[mmsi]); await aisRefresh(true); return json(res, 200, { id: known[mmsi], mmsi, already: true }); }
      const id = id16(), publishKey = key24();
      const meta = { id, name: (body.name || ('MMSI ' + mmsi)).toString().slice(0, 80), keyHash: sha(publishKey), createdAt: Date.now(), fleets: [fid], mmsi: mmsi };
      await store.create(meta);
      await store.fleetAdd(fid, id);
      await store.mmsiSet(mmsi, id);
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
      await store.fleetAdd(fid, id);
      await store.devSet(meta.keyHash, id);
      return json(res, 201, { id, publishKey, name: meta.name, fleet: fid });
    }
    if (mFleet && req.method === 'GET') {
      const fleet = await store.fleetGet(mFleet[1]); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      const ids = await store.fleetMembers(mFleet[1]);
      const lots = await Promise.all(ids.map(async (id) => {
        try {
          const [m, last] = await Promise.all([store.getMeta(id), store.lastPoint(id)]);
          return m ? { id, name: m.name, last } : null;
        } catch { return null; }
      }));
      const boats = lots.filter(Boolean);
      return json(res, 200, { id: fleet.id, name: fleet.name, boats });
    }
    if (mFleetStream && req.method === 'GET') {
      const fleet = await store.fleetGet(mFleetStream[1]); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }, CORS));
      res.write('retry: 5000\n\n');
      if (!fleetClients.has(fleet.id)) fleetClients.set(fleet.id, new Set());
      fleetClients.get(fleet.id).add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); const st = fleetClients.get(fleet.id); if (st) st.delete(res); });
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
    if (p === '/api/point' && req.method === 'GET') {
      const clat = num(parseFloat(u.searchParams.get('lat')));
      const clon = num(parseFloat(u.searchParams.get('lon')));
      const pt = await fetchPoint(clat === null ? 47 : clat, clon === null ? -4 : clon);
      return json(res, 200, pt);
    }
  } catch (e) { return json(res, 500, { error: 'stockage indisponible' }); }

  if (p === '/windy.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(PAGE_WINDYJS); }
  if (p === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end('window.OWM_KEY=' + JSON.stringify(process.env.OWM_API_KEY || '') + ';'); }
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
let vapiTimer = null, vapiPollMs = 0, vapiLastEvent = 'inactif', vapiPositions = 0, vapiLastAt = 0, vapiBrut = '';
const AIS_DEFAULT_MIN = 5;
const aisInfo = new Map();
let aisMap = {};
const aisLast = new Map();
const aisLastT = new Map();
let aisWs = null, aisRetry = 0, aisTimer = null;
let aisMsgCount = 0, aisLastMsgAt = 0, aisLastEvent = 'jamais connecte', aisSubCount = 0;

async function aisHandle(raw) {
  aisMsgCount++; aisLastMsgAt = Date.now();
  const txt = typeof raw === 'string' ? raw : String(raw);
  let m; try { m = JSON.parse(txt); } catch { aisLastEvent = 'reponse non JSON: ' + txt.slice(0, 140); return; }
  if (m && m.error) { aisLastEvent = 'erreur AIS: ' + String(m.error).slice(0, 140); return; }
  if (m && m.Error) { aisLastEvent = 'erreur AIS: ' + String(m.Error).slice(0, 140); return; }
  if (!m || !m.MessageType) { aisLastEvent = 'message inattendu: ' + txt.slice(0, 140); return; }
  if (m.MessageType !== 'PositionReport') { aisLastEvent = 'recu ' + m.MessageType; }
  if (!m || m.MessageType !== 'PositionReport') return;
  const md = m.MetaData || {};
  const pr = (m.Message && m.Message.PositionReport) || {};
  const mmsi = String(md.MMSI || pr.UserID || '');
  const info = aisInfo.get(mmsi);
  if (!info) return;
  const now = Date.now();
  const lat = num(pr.Latitude != null ? pr.Latitude : md.latitude);
  const lon = num(pr.Longitude != null ? pr.Longitude : md.longitude);
  let t = now;
  if (md.time_utc) { const d = Date.parse(String(md.time_utc).replace(' +0000 UTC', 'Z').replace(' ', 'T')); if (!isNaN(d)) t = d; }
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
    broadcast(info.tid, pt);
    for (const fid of info.fleets) broadcastFleet(fid, { b: info.tid, n: info.name, p: pt });
    return true;
  } catch { return false; }
}
function aisReconnect() {
  if (!AIS_KEY) return;
  aisRetry = Math.min(aisRetry + 1, 6);
  if (aisTimer) clearTimeout(aisTimer);
  aisTimer = setTimeout(aisConnect, Math.min(60000, 2000 * Math.pow(2, aisRetry - 1)));
}
function aisConnect() {
  if (!AIS_KEY || typeof WebSocket !== 'function') return;
  if (aisTimer) { clearTimeout(aisTimer); aisTimer = null; }
  if (aisWs) { try { aisWs.onclose = null; aisWs.close(); } catch {} aisWs = null; }
  const list = Object.keys(aisMap).slice(0, 50);
  if (!list.length) return;
  let ws;
  try { ws = new WebSocket('wss://stream.aisstream.io/v0/stream'); } catch { return aisReconnect(); }
  aisWs = ws;
  ws.onopen = () => {
    aisRetry = 0;
    const sub = { APIKey: AIS_KEY, BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: list, FilterMessageTypes: ['PositionReport'] };
    try { ws.send(JSON.stringify(sub)); } catch {}
    aisSubCount = list.length; aisLastEvent = 'connecte, abonne a ' + list.length + ' MMSI';
    console.log('AIS: abonnement a ' + list.length + ' MMSI');
  };
  ws.onmessage = (ev) => { aisHandle(ev.data); };
  ws.onerror = () => { aisLastEvent = 'erreur de connexion'; };
  ws.onclose = (ev) => { aisLastEvent = 'connexion fermee' + (ev && ev.code ? ' (code ' + ev.code + ')' : ''); if (aisWs === ws) { aisWs = null; aisReconnect(); } };
}
/* seconde source AIS : VesselAPI (REST, interrogation periodique) */
async function vapiPoll() {
  const list = Object.keys(aisMap);
  if (!VAPI_KEY || !list.length) return;
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const depuis = new Date(Date.now() - 24 * 3600000).toISOString();
    const url = 'https://api.vesselapi.com/v1/vessels/positions?filter.idType=mmsi&pagination.limit=50&time.from=' + encodeURIComponent(depuis) + '&filter.ids=' + chunk.join(',');
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + VAPI_KEY } });
      const brut = await r.text();
      vapiBrut = brut.slice(0, 300);
      if (!r.ok) { vapiLastEvent = 'HTTP ' + r.status + (r.status === 401 ? ' (cle refusee)' : r.status === 429 ? ' (quota atteint)' : r.status === 400 ? ' (requete refusee)' : ''); continue; }
      let j = {}; try { j = JSON.parse(brut); } catch { vapiLastEvent = 'reponse illisible'; continue; }
      let rows = Array.isArray(j) ? j : (j.vesselPositions || j.data || j.vessels || j.positions || j.results || null);
      if (!rows) { for (const k of Object.keys(j || {})) { if (Array.isArray(j[k]) && j[k].length && typeof j[k][0] === 'object') { rows = j[k]; break; } } }
      rows = rows || [];
      let n = 0;
      for (const row of rows) {
        const t = Date.parse(row.timestamp || row.processed_timestamp || '') || Date.now();
        if (row.suspected_glitch) continue;
        if (await aisIngest(row.mmsi, num(row.latitude), num(row.longitude), t, num(row.sog), num(row.cog))) n++;
      }
      vapiPositions += n;
      vapiLastEvent = rows.length + ' position(s) lues, ' + n + ' enregistree(s)';
      vapiLastAt = Date.now();
    } catch (e) { vapiLastEvent = 'echec: ' + ((e && e.message) || 'inconnu'); }
  }
}
function vapiSchedule() {
  if (vapiTimer) { clearInterval(vapiTimer); vapiTimer = null; }
  if (!VAPI_KEY) return;
  let ms = 300000;
  for (const v of aisInfo.values()) if (v.ms && v.ms < ms) ms = v.ms;
  if (ms < 60000) ms = 60000;
  vapiPollMs = ms;
  vapiTimer = setInterval(vapiPoll, ms);
  if (vapiTimer.unref) vapiTimer.unref();
  vapiPoll();
}

/* surveillance : retablit la liaison AIS si elle est tombee */
const aisWatch = setInterval(() => {
  if (AIS_KEY && !aisWs && Object.keys(aisMap).length) { aisLastEvent = 'reconnexion automatique'; aisConnect(); }
}, 300000);
if (aisWatch.unref) aisWatch.unref();

async function aisRefresh(reconnect) {
  try { aisMap = (await store.mmsiAll()) || {}; } catch { aisMap = {}; }
  aisInfo.clear();
  const fcache = new Map();
  const mmsis = Object.keys(aisMap);
  const metas = await Promise.all(mmsis.map((m) => store.getMeta(aisMap[m]).catch(() => null)));
  for (let k = 0; k < mmsis.length; k++) {
    const mmsi = mmsis[k];
    const tid = aisMap[mmsi];
    const meta = metas[k];
    const fids = (meta && meta.fleets) || [];
    let best = null;
    for (const fid of fids) {
      let v = fcache.get(fid);
      if (v === undefined) {
        let f = null; try { f = await store.fleetGet(fid); } catch {}
        const mn = num(f && f.aisIntervalMin);
        v = (mn !== null && mn >= 1 && mn <= 60) ? mn : AIS_DEFAULT_MIN;
        fcache.set(fid, v);
      }
      if (best === null || v < best) best = v;
    }
    aisInfo.set(mmsi, { tid: tid, name: (meta && meta.name) || ('MMSI ' + mmsi), fleets: fids, ms: (best === null ? AIS_DEFAULT_MIN : best) * 60000 });
  }
  vapiSchedule();
  if (reconnect) aisConnect();
}

server.listen(PORT, () => { console.log('Sea Tracker (' + (USE_REDIS ? 'Upstash Redis' : 'fichiers') + ') sur http://localhost:' + PORT); if (AIS_KEY || VAPI_KEY) aisRefresh(!!AIS_KEY); });
