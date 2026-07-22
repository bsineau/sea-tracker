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
function json(res, code, obj) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS)); res.end(JSON.stringify(obj)); }
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
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
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
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
if(L.maplibreGL) bases['Carte marine (isobathes/sondes)']=L.maplibreGL({style:'https://tiles.openwaters.io/seascape/style.json',attribution:'Fonds &copy; openwaters.io (CC BY 4.0)'});
bases['Océan (Esri)']=esriOcean;
bases['Bathymétrie (EMODnet)']=emodnet;
bases['Satellite']=esriSat;
bases['OpenStreetMap']=osm;
var windGroup=L.layerGroup();
var overlays=Object.assign({'Balises (OpenSeaMap)':seamark,'Balises SHOM':shomBalise,'Vent animé (Open‑Meteo)':windGroup},weather);
var layerCtl=L.control.layers(bases,overlays,{position:'topright',collapsed:true}).addTo(map);
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
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
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
<div class="bar"><b id="flname">Flotte</b><div class="sub" id="flcount">Connexion…</div>
  <select id="flswitch" style="display:none;margin-top:7px;width:100%;background:#0a1e2c;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 7px;font-size:12px"></select>
</div>
<button class="fitbtn" id="fit">⤢ Tout voir</button>
<div id="legend"><div class="lgh">Flotte</div></div>
<div id="windCtl"><div class="t">Vent — modèle (précision) &amp; échéance</div><select id="windModel"></select><select id="windHour"></select></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script src="https://unpkg.com/maplibre-gl/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leaflet-velocity@2.1.4/dist/leaflet-velocity.min.js"></script>
<script src="/config.js"></script>
<script>
"use strict";
var fid=new URLSearchParams(location.search).get('id');
var ADMK=new URLSearchParams(location.search).get('k')||'';
var $=function(i){return document.getElementById(i);};

/* ---- bascule entre flottes (console) ---- */
if(ADMK){
  fetch('/api/admin/fleets',{headers:{'x-admin-key':ADMK}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(!d||!d.fleets||d.fleets.length<1)return;
    var sel=$('flswitch');
    sel.innerHTML='<option value="">↔ Changer de flotte…</option>'
      +d.fleets.map(function(f){return '<option value="'+f.id+'"'+(f.id===fid?' selected':'')+'>'+
        String(f.name).replace(/[&<>"]/g,'')+' ('+f.boats+')</option>';}).join('')
      +'<option value="__admin">⚓️ Console des flottes</option>';
    sel.style.display='block';
    sel.onchange=function(){
      if(this.value==='__admin'){location.href='/admin?k='+encodeURIComponent(ADMK);return;}
      if(this.value&&this.value!==fid)location.href='/vf?id='+this.value+'&k='+encodeURIComponent(ADMK);
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
if(L.maplibreGL) bases['Carte marine (isobathes/sondes)']=L.maplibreGL({style:'https://tiles.openwaters.io/seascape/style.json',attribution:'Fonds &copy; openwaters.io (CC BY 4.0)'});
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
var layerCtl=L.control.layers(bases,overlays,{position:'topright',collapsed:true}).addTo(map);
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
  var tt=b.marker.getTooltip&&b.marker.getTooltip();if(tt&&tt.setOpacity)tt.setOpacity(on?1:0.5);
}
var onlineOnly=false;
function applyVisibility(){
  for(var k in boats){var b=boats[k];var vis=!onlineOnly||isOnline(b);
    if(b.marker){if(vis){if(!map.hasLayer(b.marker))b.marker.addTo(map);}else if(map.hasLayer(b.marker))map.removeLayer(b.marker);}
    if(b.trace){if(vis){if(!map.hasLayer(b.trace))b.trace.addTo(map);}else if(map.hasLayer(b.trace))map.removeLayer(b.trace);}
  }
}
function ensureBoat(id,name){
  if(boats[id]){if(name)boats[id].name=name;return boats[id];}
  var c=boatColor(id);
  boats[id]={name:name||'Bateau',color:c,last:null,marker:null,trace:L.polyline([],{color:c,weight:3,opacity:.85}).addTo(map)};
  return boats[id];
}
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
    var right=on?((b.last&&b.last[3]!=null)?(Math.round(b.last[3]*10)/10)+' kt':'—'):(b.last?'vu '+fmtAge(b.last[2]):'—');
    html+='<div class="lgi'+(on?'':' off')+'" data-id="'+k+'"><span class="dot" style="background:'+(on?b.color:'#6b7f8c')+'"></span><span>'+esc(b.name)+'</span><span class="sp'+(on?'':' offsp')+'">'+right+'</span><span class="del" data-del="'+k+'" title="Retirer de la flotte">✕</span></div>';});
  html+='<div class="lgexp">⤓ Traces flotte : <a href="/api/fleets/'+fid+'/export?format=gpx">GPX</a> · <a href="/api/fleets/'+fid+'/export?format=csv">CSV</a></div>';
  el.innerHTML=html;
  var ntg=$('nameToggle');if(ntg)ntg.onchange=function(){showNames=this.checked;applyNames();};
  var otg=$('onlineToggle');if(otg)otg.onchange=function(){onlineOnly=this.checked;applyVisibility();renderLegend();};
  var rows=el.querySelectorAll('.lgi');
  for(var i=0;i<rows.length;i++){rows[i].onclick=function(){var b=boats[this.getAttribute('data-id')];if(b&&b.last)map.setView([b.last[0],b.last[1]],Math.max(map.getZoom(),12));};}
  var dels=el.querySelectorAll('.del');
  for(var d=0;d<dels.length;d++){dels[d].onclick=function(ev){ev.stopPropagation();var did=this.getAttribute('data-del');var b=boats[did];if(!confirm('Retirer '+((b&&b.name)||'ce bateau')+' de la flotte ?'))return;fetch('/api/fleets/'+fid+'/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trackId:did})}).then(function(){if(b){if(b.marker)map.removeLayer(b.marker);if(b.trace)map.removeLayer(b.trace);}delete boats[did];renderLegend();}).catch(function(){});};}
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
    renderLegend(); fitAll(); subscribe();
  }).catch(function(){$('flcount').textContent='Erreur de chargement';});
}
function subscribe(){
  var es=new EventSource('/api/fleets/'+fid+'/stream');
  es.onopen=function(){$('flcount').textContent='En direct';};
  es.onerror=function(){$('flcount').textContent='Reconnexion…';};
  es.onmessage=function(ev){ try{var m=JSON.parse(ev.data); if(m&&m.p) boatAdd(m.b,m.n,m.p);}catch(e){} };
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
    <p>C'est bon&nbsp;! Ton bateau est créé. Configure <b>Traccar Client</b> (gratuit) avec ces deux valeurs&nbsp;:</p>
    <div class="lbl">URL du serveur</div>
    <div id="turl" class="link"></div>
    <button id="copyUrl" class="copy">Copier l'URL</button>
    <div class="lbl">Identifiant de l'appareil (ta clé)</div>
    <div id="tkey" class="link"></div>
    <button id="copyKey" class="copy">Copier la clé</button>
    <p class="hint">Dans Traccar : colle ces deux valeurs, mets <b>Précision : la plus élevée</b>, puis active le service. Ton bateau émet en arrière-plan, sans page ouverte, et apparaît sur la carte de la flotte.</p>
    <details style="margin-top:12px">
      <summary class="hint" style="cursor:pointer;color:var(--cyan)">Ou émettre depuis le navigateur (sans Traccar)</summary>
      <a id="emit" class="link" target="_blank" style="margin-top:8px"></a>
      <button id="copy" class="copy">Copier le lien</button>
      <p class="hint">Ouvre ce lien sur le tel du bord et <b>garde la page au premier plan</b>.</p>
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
$('go').onclick=function(){
  var name=$('boat').value.trim();
  if(!name){$('err').textContent='Indique un nom de bateau.';return;}
  $('err').textContent='';$('go').disabled=true;$('go').textContent='…';
  fetch('/api/fleets/'+fid+'/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
   .then(function(r){return r.json();}).then(function(d){
     if(d.error){$('err').textContent=d.error;$('go').disabled=false;$('go').textContent='Rejoindre la flotte';return;}
     var url=location.origin+'/p?id='+d.id+'&key='+d.publishKey;
     var osmand=location.origin+'/api/osmand';
     $('turl').textContent=osmand;
     $('tkey').textContent=d.publishKey;
     var a=$('emit');a.textContent=url;a.href=url;
     $('form').style.display='none';$('result').style.display='block';
     function cp(btn,txt){btn.onclick=function(){try{navigator.clipboard.writeText(txt);this.textContent='Copié ✓';}catch(e){}};}
     cp($('copyUrl'),osmand);cp($('copyKey'),d.publishKey);cp($('copy'),url);
   }).catch(function(){$('err').textContent='Erreur réseau, réessaie.';$('go').disabled=false;$('go').textContent='Rejoindre la flotte';});
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
</div>

<script>
"use strict";
var $=function(i){return document.getElementById(i);};
var K=new URLSearchParams(location.search).get('k')||'';
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
  location.search='?k='+encodeURIComponent(v);
};
$('key').addEventListener('keydown',function(e){if(e.key==='Enter')$('auth').click();});

function boot(){
  if(!K){$('authCard').style.display='block';return;}
  api('/api/admin/fleets').then(function(r){
    if(r.code!==200){
      $('authCard').style.display='block';
      say($('authMsg'),(r.body&&r.body.error)||'Accès refusé','err');
      return;
    }
    AIS=!!r.body.aisEnabled;
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
    var vf=ORIGIN+'/vf?id='+f.id+'&k='+encodeURIComponent(K);
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
  document.querySelectorAll('[data-go]').forEach(function(b){b.onclick=function(){location.href=ORIGIN+'/vf?id='+this.getAttribute('data-go')+'&k='+encodeURIComponent(K);};});
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
    if(AIS){
      box.innerHTML+='<div class="lbl" style="margin-top:12px">Ajouter un bateau par AIS</div>'
        +'<input data-mn="'+fid+'" placeholder="Nom du bateau" maxlength="40">'
        +'<input data-mm="'+fid+'" placeholder="MMSI (9 chiffres)" inputmode="numeric" maxlength="9" style="margin-top:6px">'
        +'<button class="sec" data-madd="'+fid+'">Ajouter par MMSI</button>';
    }
    box.querySelectorAll('[data-rm]').forEach(function(s){s.onclick=function(){
      var parts=this.getAttribute('data-rm').split('|');
      if(!confirm('Retirer '+parts[2]+' de la flotte ?'))return;
      fetch('/api/fleets/'+parts[0]+'/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trackId:parts[1]})})
        .then(function(){loadBoats(parts[0]);reload();});
    };});
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

boot();
</script>
</body>
</html>
`;
const ICONS = { '/icon-180.png': Buffer.from('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', 'base64'), '/icon-192.png': Buffer.from('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', 'base64'), '/icon-512.png': Buffer.from('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', 'base64') };
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
      return json(res, 200, { id: meta.id, name: meta.name, createdAt: meta.createdAt, count: pts.length, last, points: out });
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

      if (p === '/api/admin/fleets' && req.method === 'GET') {
        const ids = await store.fleetIndex();
        const out = [];
        for (const fid of ids) {
          const f = await store.fleetGet(fid); if (!f) continue;
          let n = 0; try { n = (await store.fleetMembers(fid)).length; } catch {}
          const mn = num(f.aisIntervalMin);
          out.push({ id: fid, name: f.name, createdAt: f.createdAt, boats: n, aisIntervalMin: (mn !== null && mn >= 1 && mn <= 60) ? mn : AIS_DEFAULT_MIN });
        }
        out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return json(res, 200, { fleets: out, aisEnabled: !!AIS_KEY });
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
      return json(res, 200, { ok: true });
    }
    const mFleetSet = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/settings$/);
    if (mFleetSet) {
      const fid = mFleetSet[1];
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      if (req.method === 'GET') {
        const mn = num(fleet.aisIntervalMin);
        return json(res, 200, { aisIntervalMin: (mn !== null && mn >= 1 && mn <= 60) ? mn : AIS_DEFAULT_MIN, aisEnabled: !!AIS_KEY, aisDefaultMin: AIS_DEFAULT_MIN });
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
    const mFleetMmsi = p.match(/^\/api\/fleets\/([a-f0-9]{16})\/mmsi$/);
    if (mFleetMmsi && req.method === 'POST') {
      const fid = mFleetMmsi[1];
      const fleet = await store.fleetGet(fid); if (!fleet) return json(res, 404, { error: 'flotte introuvable' });
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const mmsi = String(body.mmsi || '').replace(/[^0-9]/g, '');
      if (!/^[0-9]{9}$/.test(mmsi)) return json(res, 400, { error: 'MMSI invalide (9 chiffres attendus)' });
      if (!AIS_KEY) return json(res, 503, { error: 'Suivi AIS non configure sur ce serveur (AIS_API_KEY manquante)' });
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
      const boats = [];
      for (const id of ids) {
        const m = await store.getMeta(id); if (!m) continue;
        const last = await store.lastPoint(id);
        boats.push({ id, name: m.name, last });
      }
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
const AIS_DEFAULT_MIN = 5;
const aisInfo = new Map();
let aisMap = {};
const aisLast = new Map();
let aisWs = null, aisRetry = 0, aisTimer = null;

async function aisHandle(raw) {
  let m; try { m = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
  if (!m || m.MessageType !== 'PositionReport') return;
  const md = m.MetaData || {};
  const pr = (m.Message && m.Message.PositionReport) || {};
  const mmsi = String(md.MMSI || pr.UserID || '');
  const info = aisInfo.get(mmsi);
  if (!info) return;
  const tid = info.tid;
  const now = Date.now();
  if (now - (aisLast.get(mmsi) || 0) < info.ms) return;
  const lat = num(pr.Latitude != null ? pr.Latitude : md.latitude);
  const lon = num(pr.Longitude != null ? pr.Longitude : md.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  aisLast.set(mmsi, now);
  let t = now;
  if (md.time_utc) { const d = Date.parse(String(md.time_utc).replace(' +0000 UTC', 'Z').replace(' ', 'T')); if (!isNaN(d)) t = d; }
  const sog = num(pr.Sog), cog = num(pr.Cog);
  const pt = [r6(lat), r6(lon), Math.round(t), (sog === null || sog >= 102.3) ? null : Math.round(sog * 10) / 10, (cog === null || cog >= 360) ? null : Math.round(cog)];
  try {
    await store.append(tid, [pt]);
    broadcast(tid, pt);
    for (const fid of info.fleets) broadcastFleet(fid, { b: tid, n: info.name, p: pt });
  } catch {}
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
    const sub = { APIKey: AIS_KEY, Apikey: AIS_KEY, BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: list, FilterMessageTypes: ['PositionReport'] };
    try { ws.send(JSON.stringify(sub)); } catch {}
    console.log('AIS: abonnement a ' + list.length + ' MMSI');
  };
  ws.onmessage = (ev) => { aisHandle(ev.data); };
  ws.onerror = () => {};
  ws.onclose = () => { if (aisWs === ws) { aisWs = null; aisReconnect(); } };
}
async function aisRefresh(reconnect) {
  try { aisMap = (await store.mmsiAll()) || {}; } catch { aisMap = {}; }
  aisInfo.clear();
  const fcache = new Map();
  for (const mmsi of Object.keys(aisMap)) {
    const tid = aisMap[mmsi];
    let meta = null; try { meta = await store.getMeta(tid); } catch {}
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
  if (reconnect) aisConnect();
}

server.listen(PORT, () => { console.log('Sea Tracker (' + (USE_REDIS ? 'Upstash Redis' : 'fichiers') + ') sur http://localhost:' + PORT); if (AIS_KEY) aisRefresh(true); });
