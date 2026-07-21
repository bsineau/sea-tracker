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

/* ---- back-end fichiers ---- */
const fileCache = new Map();
const fpath = (id) => path.join(DATA, id + '.json');
function fileLoad(id) {
  if (fileCache.has(id)) return fileCache.get(id);
  try { const t = JSON.parse(fs.readFileSync(fpath(id), 'utf8')); fileCache.set(id, t); return t; } catch { return null; }
}
const fileStore = {
  getMeta: async (id) => { const t = fileLoad(id); return t ? { id: t.id, name: t.name, keyHash: t.keyHash, createdAt: t.createdAt } : null; },
  create: async (m) => { const t = Object.assign({ points: [] }, m); fileCache.set(m.id, t); fs.writeFileSync(fpath(m.id), JSON.stringify(t)); },
  append: async (id, pts) => { const t = fileLoad(id); if (!t) return 0; for (const p of pts) t.points.push(p); fs.writeFileSync(fpath(id), JSON.stringify(t)); return t.points.length; },
  points: async (id) => { const t = fileLoad(id); return t ? t.points : []; }
};

/* ---- back-end Upstash Redis (REST) ---- */
const rMeta = (id) => 'st:' + id + ':meta';
const rPts = (id) => 'st:' + id + ':pts';
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
  append: async (id, pts) => { const a = ['RPUSH', rPts(id)]; for (const p of pts) a.push(JSON.stringify(p)); return await redisCmd(a); },
  points: async (id) => { const arr = await redisCmd(['LRANGE', rPts(id), '0', '-1']); return (arr || []).map((x) => JSON.parse(x)); }
};
const store = USE_REDIS ? redisStore : fileStore;

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
function serveHTML(res, html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }

const PAGE_INDEX = `<!DOCTYPE html>
<html lang="fr">
<head>
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
</script>
</body>
</html>
`;
const PAGE_VIEWER = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Suivi en direct</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
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
  .leaflet-control-attribution{font-size:9px!important;background:rgba(8,21,29,.7)!important;color:#7fa!important}
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

<script src="/config.js"></script>
<script src="/windy.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
"use strict";
var id = new URL(location.href).searchParams.get('id');
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

var map=L.map('map',{zoomControl:true,worldCopyJump:true}).setView([46,-20],4);
var esriOcean=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',{maxZoom:13,attribution:'Fond océan &copy; Esri'}).addTo(map);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}',{maxZoom:13}).addTo(map);
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
var layerCtl=L.control.layers({'Océan':esriOcean},Object.assign({'Balises':seamark},weather),
  {position:'topright',collapsed:true}).addTo(map);
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
<head>
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
</div>
<div class="toast" id="toast"></div>

<script>
"use strict";
var q=new URL(location.href).searchParams;
var id=q.get('id'), key=q.get('key');
var viewerUrl=location.origin+'/v?id='+id;
document.getElementById('viewerLink').textContent=viewerUrl;

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

refresh();
if(queue.length)flush();
</script>
</body>
</html>
`;
const PAGE_METEO = `<!DOCTYPE html>
<html lang="fr">
<head>
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  try {
    if (p === '/api/tracks' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'json' }); }
      const id = id16(), publishKey = key24();
      const meta = { id, name: (body.name || 'Navigation').toString().slice(0, 80), keyHash: sha(publishKey), createdAt: Date.now() };
      await store.create(meta);
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
      if (norm.length) { count = await store.append(mPos[1], norm); for (const pt of norm) broadcast(mPos[1], pt); }
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
  } catch (e) { return json(res, 500, { error: 'stockage indisponible' }); }

  if (p === '/windy.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(PAGE_WINDYJS); }
  if (p === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end('window.OWM_KEY=' + JSON.stringify(process.env.OWM_API_KEY || '') + ';'); }
  if (p === '/') return serveHTML(res, PAGE_INDEX);
  if (p === '/v') return serveHTML(res, PAGE_VIEWER);
  if (p === '/p') return serveHTML(res, PAGE_PUBLISHER);
  if (p === '/meteo') return serveHTML(res, PAGE_METEO);
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404');
});

server.listen(PORT, () => console.log('Sea Tracker (' + (USE_REDIS ? 'Upstash Redis' : 'fichiers') + ') sur http://localhost:' + PORT));
