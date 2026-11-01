"use strict";

/* ═══════════════════════════════════════════════════════════════════════
   STEL Field

   Clients, quotes, jobs, tank mixes and the Queensland spray record, on one
   phone, with or without internet. The STEL Spray Log's screens were brought in
   here on 1 Nov 2026 and share one set of records with quoting.

   Four things this app deliberately does NOT do:
     1. Suggest an application rate. Every rate is typed by the operator off
        the label, and the app only does the arithmetic. A wrong rate is an
        off-label offence. Same rule as STEL Weed ID.
     2. Say a product is fine for drone application. That is on the label.
     3. Treat a forecast as an on-site reading. Forecasts are kept apart and
        labelled. Delta T bands are a guide and the label wins.
     4. Put anything about customers, prices or licences in this file. The repo
        is public. All of that is typed in on the phone and stays there.

   The record fields come from Business Queensland's page on making and keeping
   records of agricultural chemical applications. See HANDOVER.md.
   ═══════════════════════════════════════════════════════════════════════ */

var C = self.StelCalc;
var STORES = ["settings","people","drones","licences","clients","paddocks","recipes","jobs","records","quotes","items"];
var S = {};               /* every store, held in memory. These lists stay small. */
var db = null;
var PRODUCTS = null;      /* lazy: the APVMA list */
var deferredInstall = null;
var persisted = null;
var currentSettle = null;
var stampLast = 0;
var JOURNAL = "stel-field-j:";

var LS_THEME = "stel-field-theme";
var LS_RECENT = "stel-field-recent";
var LS_FC = "stel-field-forecast";
var LS_WRITE = "stel-field-write";
var LS_ROUTE = "stel-field-route";
var lastWrite = "";

var QLD_IMAGERY = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}";
var QLD_CREDIT = "Includes material © State of Queensland; © Planet Labs Netherlands B.V. reproduced under licence from Planet and Geoplex, all rights reserved";
var QLD_PARCELS = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/identify";
var MET_FORECAST = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
var HOME = [-23.38, 150.51];  /* Rockhampton, where the map opens with nothing else to go on */

var app = document.getElementById("app");
var mastTitle = document.getElementById("mastTitle");

/* ─────────── small helpers ─────────── */
function el(tag, cls, txt){
  var n = document.createElement(tag);
  if(cls) n.className = cls;
  if(txt != null) n.textContent = txt;
  return n;
}
function add(parent, tag, cls, txt){ var n = el(tag, cls, txt); parent.appendChild(n); return n; }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function clone(o){ return JSON.parse(JSON.stringify(o)); }
/* Strict on purpose. "1,5" must not quietly read as 15, or "2-3" as 2, in a chemical sum.
   Anything but a plain number comes back as not a number, and the sums ask for it again. */
function num(v){
  if(v === "" || v == null) return NaN;
  var s = String(v).trim();
  if(!/\d/.test(s) || !/^-?(\d{1,3}(,\d{3})+|\d+)?(\.\d*)?$/.test(s)) return NaN;
  return parseFloat(s.replace(/,/g, ""));
}
/* the exact sums take plain decimals only, so "1,200" can't be read there even though it's a number */
function unreadable(v, signed){
  var s = String(v == null ? "" : v).trim();
  return s !== "" && !(signed ? C.parseSigned(s) : C.parse(s));
}
function ls(k, d){ try { var v = localStorage.getItem(k); return v == null ? d : v; } catch(e){ return d; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
function lsJson(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } }
function byId(store, id){
  var list = S[store] || [];
  for(var i = 0; i < list.length; i++) if(list[i].id === id) return list[i];
  return null;
}
function debounce(fn, ms){
  var t = null;
  function run(){ clearTimeout(t); t = setTimeout(function(){ t = null; fn(); }, ms); }
  run.flush = function(){ if(t){ clearTimeout(t); t = null; fn(); } };
  run.cancel = function(){ clearTimeout(t); t = null; };
  return run;
}
function toast(msg){
  var old = document.querySelector(".toast");
  if(old) old.remove();
  var t = el("div", "toast", msg);
  t.setAttribute("role", "status");
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3200);
}
function loadScript(src){
  loadScript.cache = loadScript.cache || {};
  if(!loadScript.cache[src]){
    loadScript.cache[src] = new Promise(function(res, rej){
      var s = document.createElement("script");
      s.src = src; s.onload = res;
      s.onerror = function(){ delete loadScript.cache[src]; rej(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }
  return loadScript.cache[src];
}

/* ─────────── dates, all on the phone's local clock ─────────── */
function pad(n){ return (n < 10 ? "0" : "") + n; }
function todayISO(){ var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function nowTime(){ var d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function nowStamp(){ return todayISO() + "T" + nowTime(); }
function fmtDate(iso){
  var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso || "");
  return m ? m[3] + "/" + m[2] + "/" + m[1] : (iso || "");
}
function parts(iso){ var m = iso.slice(0, 10).split("-"); return [+m[0], +m[1] - 1, +m[2]]; }
function isoFromUTC(ms){ var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
function addDays(iso, n){ var p = parts(iso); return isoFromUTC(Date.UTC(p[0], p[1], p[2] + n)); }
function addYears(iso, n){ var p = parts(iso); return isoFromUTC(Date.UTC(p[0] + n, p[1], p[2])); }
function daysFromToday(iso){
  var p = parts(iso), t = parts(todayISO());
  return Math.round((Date.UTC(p[0], p[1], p[2]) - Date.UTC(t[0], t[1], t[2])) / 86400000);
}

/* ─────────── the sums live in calc.js. These are only the words around them ─────────── */
/* It starts blank so the unit has to be read off the label. A preselected unit let a
   g/ha rate sit on kg/ha, a thousand times out, and still pass the volume check. */
var RATE_UNITS = [
  ["","Pick a unit"],
  ["L/ha","L per ha"], ["mL/ha","mL per ha"], ["kg/ha","kg per ha"], ["g/ha","g per ha"],
  ["L/1000 m²","L per 1000 m²"], ["mL/1000 m²","mL per 1000 m²"], ["kg/1000 m²","kg per 1000 m²"], ["g/1000 m²","g per 1000 m²"],
  ["L/100 L","L per 100 L of mix"], ["mL/100 L","mL per 100 L of mix"], ["kg/100 L","kg per 100 L of mix"], ["g/100 L","g per 100 L of mix"]
];

function fmtN(v, d){
  var n = Number(v);
  return isNaN(n) ? "?" : n.toLocaleString("en-AU", {maximumFractionDigits: d});
}
function fmtAmount(v, dry){
  if(v >= 1000) return fmtN(v / 1000, 3) + (dry ? " kg" : " L");
  if(v > 0 && v < 0.01) return "under 0.01" + (dry ? " g" : " mL");
  return fmtN(v, v >= 100 ? 0 : v >= 10 ? 1 : 2) + (dry ? " g" : " mL");
}
function isDry(it){ return /^(kg|g)\//.test(it.unit || ""); }
/* What went on the record: the total typed in L or kg if there is one, or else the worked-out one */
function usedText(it, worked){
  var typed = String(it.used == null ? "" : it.used).trim();
  if(!typed) return worked || "";
  var n = num(typed);
  return isNaN(n) ? typed : fmtAmount(n * 1000, isDry(it));
}
/* Delta T: air temperature less wet bulb, from Stull's 2011 wet bulb formula. */
function deltaT(t, rh){
  if(isNaN(t) || isNaN(rh) || rh <= 0 || rh > 100) return null;
  var tw = t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(t + rh) - Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
  return Math.max(0, t - tw);   /* the formula dips just below zero at 100 % humidity */
}
/* The bands follow GRDC's Practical Tips for Spraying fact sheet, January 2025. */
function deltaTBand(d){
  if(d == null) return null;
  if(d < 2) return {k: "warn", t: "Under 2: drift risk, watch for an inversion"};
  if(d <= 8) return {k: "good", t: "Inside the common 2 to 8"};
  if(d <= 10) return {k: "warn", t: "8 to 10: above the common 2 to 8"};
  if(d <= 12) return {k: "stop", t: "10 to 12: GRDC says very coarse droplets or larger only"};
  return {k: "stop", t: "Over 12: GRDC says avoid spraying"};
}

/* Paddock area from its corners, flat-earth at the paddock's own latitude using
   the WGS84 ellipsoid. A sphere reads about half a percent high at this latitude,
   and hectares drive how much chemical goes in the tank. */
var RAD = Math.PI / 180;
function ringCentre(r){
  if(!r || !r.length) return null;
  var la = 0, ln = 0;
  r.forEach(function(p){ la += p[0]; ln += p[1]; });
  return [la / r.length, ln / r.length];
}
function metresPerDegree(lat){
  var a = 6378137, e2 = 0.00669437999014, s = Math.sin(lat * RAD), w = Math.sqrt(1 - e2 * s * s);
  return { x: RAD * (a / w) * Math.cos(lat * RAD), y: RAD * (a * (1 - e2) / (w * w * w)) };
}
function ringHa(r){
  if(!r || r.length < 3) return 0;
  var c = ringCentre(r), k = metresPerDegree(c[0]), sum = 0;
  for(var i = 0; i < r.length; i++){
    var a = r[i], b = r[(i + 1) % r.length];
    sum += (a[1] - c[1]) * k.x * (b[0] - c[0]) * k.y - (b[1] - c[1]) * k.x * (a[0] - c[0]) * k.y;
  }
  return Math.abs(sum) / 2 / 10000;
}
/* Corners tapped out of order make a bow-tie, whose two halves cancel in the area sum */
function ringCrosses(r){
  if(!r || r.length < 4) return false;
  function side(a, b, c){ return (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]); }
  var n = r.length;
  for(var i = 0; i < n; i++){
    for(var j = i + 2; j < n; j++){
      if(i === 0 && j === n - 1) continue;
      var a = r[i], b = r[(i + 1) % n], c = r[j], d = r[(j + 1) % n];
      if(side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
    }
  }
  return false;
}
function distM(a, b){
  var k = metresPerDegree((a[0] + b[0]) / 2), dx = (a[1] - b[1]) * k.x, dy = (a[0] - b[0]) * k.y;
  return Math.sqrt(dx * dx + dy * dy);
}
var COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function compass(deg){ return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }
function msToKmh(ms){ return ms * 3.6; }

/* ─────────── what Queensland asks for, driven by what is in the tank ─────────── */
var PRESCRIBED = ["ametryn","atrazine","diuron","hexazinone","tebuthiuron"];
function activesLower(it){
  var a = (it.actives || []).map(function(x){ return (x[0] || "") + " " + (x[3] || ""); }).join(" ");
  return (a + " " + (it.activesText || "")).toLowerCase();
}
function prescribedIn(items){
  var hay = (items || []).map(activesLower).join(" ");
  return PRESCRIBED.filter(function(p){ return hay.indexOf(p) >= 0; });
}
/* Sections 21 to 23 of the Agricultural Chemicals Distribution Control Regulation 2021 */
function hazardIn(items){
  var hit = [];
  (items || []).forEach(function(it){
    /* each active on its own, or a 2,4-D salt mixed with some other ester would trip it */
    var a = (it.actives || []).some(function(x){
      var name = (x[0] || "").toLowerCase();
      return /picloram/.test(name) || (/^(2,4-d|mcpa)/.test(name) && /ester/.test(name));
    });
    var t = (it.activesText || "").toLowerCase();
    if(a || /picloram/.test(t) || /(2,4-d|mcpa)[^,;\n]*ester/.test(t)) hit.push(it.name);
  });
  return hit;
}
/* 3 days only once the Reef rules are known to apply. Until then the shorter 2 days
   shows, because a reminder that comes early can't make a record late. */
function recordDue(rec){
  return addDays(rec.date || todayISO(), rec.reef && rec.reef.applies === true && prescribedIn(rec.items).length ? 3 : 2);
}
/* 6 years for any tebuthiuron, Reef or not: keeping it longer can't break a rule */
function keepUntil(rec){
  var from = rec.date || todayISO();
  if(rec.endDate && rec.endDate > from) from = rec.endDate;
  return addYears(from, prescribedIn(rec.items).indexOf("tebuthiuron") >= 0 ? 6 : 2);
}
function reefCopyDue(rec){
  return rec.finishedAt ? addDays(rec.finishedAt, 5) : "";
}
function labelUrl(apvma){ return "https://elabels.apvma.gov.au/" + encodeURIComponent(apvma) + "ELBL.pdf"; }
function canLink(it){ return /^\d+$/.test(it.apvma || ""); }
function activesText(it){
  if(it.activesText) return it.activesText;
  return (it.actives || []).map(function(a){ return a[0] + (a[1] ? " " + a[1] + " " + (a[2] || "") : ""); }).join(", ");
}
/* A few APVMA rows hold an amount of 0, so those have to be typed off the label */
function hasActiveAmount(it){
  if(it.activesText) return /\d/.test(it.activesText);
  var a = it.actives || [];
  return a.length > 0 && a.every(function(x){ return Number(x[1]) > 0; });
}
function isLapsed(d){
  var m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(d || "");
  return !!m && daysFromToday(m[3] + "-" + m[2] + "-" + m[1]) < 0;
}
function itemLapsed(it){ return it.regTo ? isLapsed(it.regTo) : !!it.lapsed; }

/* ─────────── storage ─────────── */
function dbOpen(){
  return new Promise(function(res, rej){
    var r = indexedDB.open("stel-field", 2);
    r.onupgradeneeded = function(){
      STORES.forEach(function(s){
        if(!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, {keyPath: "id"});
      });
    };
    r.onsuccess = function(){ db = r.result; res(); };
    r.onerror = function(){ rej(r.error); };
    r.onblocked = function(){ rej(new Error("The database is locked by another window.")); };
  });
}
function loadAll(){
  return Promise.all(STORES.map(function(s){
    return new Promise(function(res, rej){
      var r = db.transaction(s).objectStore(s).getAll();
      r.onsuccess = function(){ S[s] = r.result || []; res(); };
      r.onerror = function(){ rej(r.error); };
    });
  }));
}
/* A failed save stays on screen until a save works. A toast is gone in 3 seconds. */
function saveFailed(){
  if(document.getElementById("saveErr")) return;
  var n = el("div", "note stop save-err");
  n.id = "saveErr";
  n.setAttribute("role", "alert");
  var flag = document.getElementById("savedFlag");
  if(flag) flag.textContent = "NOT SAVED";
  add(n, "b", null, "That did not save.");
  n.appendChild(document.createTextNode(" The phone may be out of space. Don't rely on what's on screen until this goes away."));
  document.querySelector(".mast").after(n);
}
function saveWorked(){
  var n = document.getElementById("saveErr");
  if(n) n.remove();
  /* tells any other open copy of the app that its copy of the data is now old */
  lastWrite = uid();
  lsSet(LS_WRITE, lastWrite);
  var flag = document.getElementById("savedFlag");
  if(flag) flag.textContent = "Saved " + new Date().toLocaleTimeString("en-AU", {hour: "numeric", minute: "2-digit"});
}
function write(store, fn){
  return new Promise(function(res, rej){
    var tx;
    try {
      tx = db.transaction(store, "readwrite");
      fn(tx.objectStore(store));
    } catch(e){ saveFailed(); rej(e); return; }
    tx.oncomplete = function(){ saveWorked(); res(); };
    tx.onerror = function(){ saveFailed(); rej(tx.error); };
    tx.onabort = function(){ saveFailed(); rej(tx.error); };
  });
}
function put(store, obj){
  if(!obj.id) obj.id = uid();
  var list = S[store], at = -1;
  for(var i = 0; i < list.length; i++) if(list[i].id === obj.id){ at = i; break; }
  if(at < 0) list.push(obj); else list[at] = obj;
  var stamp = obj.updatedAt = nextStamp();
  journal(store, obj);
  return write(store, function(os){ os.put(obj); }).then(function(){ unjournal(store, obj, stamp); });
}
function del(store, id){
  try { localStorage.removeItem(journalKey(store, id)); } catch(e){}
  S[store] = S[store].filter(function(x){ return x.id !== id; });
  return write(store, function(os){ os.delete(id); });
}
function cfg(){
  var c = byId("settings", "main");
  if(!c){ c = {id: "main", business: {}, labelNos: {}, lastBackup: ""}; S.settings.push(c); }
  return c;
}
function saveCfg(){ return put("settings", cfg()); }
/* ─────────── getting around: Android's back button works through history ─────────── */
var stack = [];
var leave = null;
var hideHook = null;    /* runs when Android takes the app off screen, and it may never come back */
var skipPop = false;
var curTab = "jobs";
var ROOTS = {};

function setTitle(t){ mastTitle.textContent = t; }
function runLeave(){ if(leave){ var f = leave; leave = null; f(); } }
function render(){
  var top = stack[stack.length - 1];
  app.textContent = "";
  leave = null;
  hideHook = null;
  top.fn();
  window.scrollTo(0, top.y || 0);
}
function rerender(){
  stack[stack.length - 1].y = window.scrollY;
  runLeave();
  render();
}
function push(fn){
  runLeave();
  stack[stack.length - 1].y = window.scrollY;
  stack.push({fn: fn, y: 0});
  history.pushState({d: stack.length}, "");
  render();
}
function back(){ history.back(); }
window.addEventListener("popstate", function(){
  if(skipPop){ skipPop = false; return; }
  runLeave();
  if(stack.length > 1){
    stack.pop();
    render();
    setRoute(stack[stack.length - 1].route || {k: "tab"});
  }
});
function setTab(name){
  runLeave();
  var depth = stack.length - 1;
  if(depth > 0){ skipPop = true; history.go(-depth); }
  curTab = name;
  stack = [{fn: ROOTS[name], y: 0}];
  var lit = name === "records" ? "jobs" : name === "setup" ? "home" : name;
  document.querySelectorAll(".tab").forEach(function(b){
    if(b.getAttribute("data-tab") === lit) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  render();
  setRoute({k: "tab"});
}
document.getElementById("tabs").addEventListener("click", function(e){
  var b = e.target.closest(".tab");
  if(b) setTab(b.getAttribute("data-tab"));
});
/* A tab left open from installing would otherwise write its old copy over newer records */
function otherWindowChanged(){
  lastWrite = ls(LS_WRITE, "");
  var deep = stack.length > 1;
  leave = null;
  hideHook = null;
  loadAll().then(function(){
    if(deep) toast("Updated from another window, so that screen closed.");
    setTab(curTab);
  });
}
window.addEventListener("storage", function(e){
  if(e.key === LS_WRITE && e.newValue !== lastWrite) otherWindowChanged();
});
document.addEventListener("visibilitychange", function(){
  if(document.visibilityState === "hidden"){ if(hideHook) hideHook(); }
  else if(stack.length && ls(LS_WRITE, "") !== lastWrite) otherWindowChanged();
});
window.addEventListener("pagehide", function(){ if(hideHook) hideHook(); });
function backBtn(){
  var b = add(app, "button", "back", "Back");
  b.type = "button";
  b.addEventListener("click", back);
}
/* ─────────── building blocks for the screens ─────────── */
function btn(p, label, cls, fn){
  var b = add(p, "button", "btn" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
function input(obj, key, o){
  o = o || {};
  var n = el(o.area ? "textarea" : "input");
  if(!o.area) n.type = o.type || "text";
  if(o.num){ n.inputMode = "decimal"; n.autocomplete = "off"; n.enterKeyHint = "next"; }
  if(o.ph) n.placeholder = o.ph;
  n.dataset.f = key;
  n.value = obj[key] == null ? "" : obj[key];
  /* strict is for figures the exact sums read, so the red box means what "can't be read" means */
  function mark(){
    if(!o.num) return;
    var s = n.value.trim();
    n.classList.toggle("bad", o.strict ? (s === "" ? !!o.need : unreadable(s, o.signed)) : s !== "" && isNaN(num(s)));
  }
  mark();
  n.addEventListener("input", function(){ obj[key] = n.value; mark(); if(o.on) o.on(n.value); });
  return n;
}
function select(obj, key, opts, o){
  o = o || {};
  var n = el("select");
  n.dataset.f = key;
  opts.forEach(function(x){
    var op = add(n, "option", null, x[1]);
    op.value = x[0];
  });
  n.value = obj[key] == null ? "" : obj[key];
  n.addEventListener("change", function(){ obj[key] = n.value; if(o.on) o.on(n.value); });
  return n;
}
function fld(p, label, control, hint){
  var w = add(p, "label", "f");
  add(w, "span", "f-l", label);
  w.appendChild(control);
  if(hint) add(w, "span", "f-h", hint);
  return w;
}
function checkbox(p, obj, key, label, on){
  var w = add(p, "label", "check");
  var c = add(w, "input");
  c.type = "checkbox";
  c.checked = !!obj[key];
  c.addEventListener("change", function(){ obj[key] = c.checked; if(on) on(); });
  add(w, "span", null, label);
  return w;
}
function note(p, cls, strong, text){
  var n = add(p, "div", "note" + (cls ? " " + cls : ""));
  if(strong) add(n, "b", null, strong + " ");
  if(text) n.appendChild(document.createTextNode(text));
  return n;
}
function chipRow(p, opts, current, on){
  var r = add(p, "div", "chips");
  opts.forEach(function(o){
    var c = add(r, "button", "chip", o[1]);
    c.type = "button";
    c.setAttribute("aria-pressed", String(o[0] === current));
    c.addEventListener("click", function(){ on(o[0]); });
  });
  return r;
}
function panelForm(p){ return add(add(p, "div", "panel"), "div", "form"); }
function listPanel(p){ return add(add(p, "div", "panel"), "div", "list"); }
function rowItem(list, name, metaBits, onClick){
  var b = add(list, "button", "item");
  b.type = "button";
  add(b, "div", "item-name", name);
  var meta = add(b, "div", "item-meta");
  (metaBits || []).forEach(function(m){
    if(!m) return;
    if(typeof m === "string") add(meta, "span", null, m);
    else add(meta, "span", "tag " + (m.k || ""), m.t);
  });
  b.addEventListener("click", onClick);
  return b;
}

/* What couldn't be saved yet, such as a walked boundary with no name, is kept here and
   offered back on the Jobs tab rather than thrown away. */
function stashDraft(o, draft){
  put("settings", {id: "stash:" + draft.id, store: o.store, title: o.title, why: o.invalid, at: nowStamp(), draft: clone(draft)}).catch(function(){});
}
function getStash(id){ return byId("settings", "stash:" + id); }
function allStashes(){ return S.settings.filter(function(x){ return String(x.id).indexOf("stash:") === 0; }); }
function clearStash(id){
  if(id && getStash(id)) del("settings", "stash:" + id).catch(function(){});
}

/* A form on its own screen. Anything valid is saved on the way out, or when Android
   takes the app off screen, so a phone call or a stray back press in a paddock never
   loses what was typed. */
function editView(o){
  var draft = clone(o.item), gone = false;
  if(!draft.id) draft.id = uid();
  var snap = JSON.stringify(draft);
  function saveNow(){
    /* an untouched record keeps its date, so just opening it can't beat a newer copy in a merge */
    var unchanged = JSON.stringify(draft) === snap && !!byId(o.store, draft.id);
    snap = JSON.stringify(draft);
    clearStash(draft.id);
    /* straight away, so the form behind this one draws with what was just added */
    if(o.after) o.after(draft);
    if(unchanged) return Promise.resolve();
    return put(o.store, clone(draft)).catch(function(e){ snap = null; throw e; });
  }
  /* true if it couldn't be saved and was stashed instead */
  function settle(){
    var same = JSON.stringify(draft) === snap;
    /* a job that came pre-filled from a quote or a client is kept even if nothing was typed */
    if(gone || (same && !(o.keepIfValid && !byId(o.store, draft.id) && o.valid(draft)))) return false;
    if(o.valid(draft)){ saveNow().catch(function(){}); return false; }
    stashDraft(o, draft);
    return true;
  }
  var isSaved = !!byId(o.store, draft.id);
  push(function(){
    if(o.refresh){
      var was = JSON.stringify(draft) === snap;
      o.refresh(draft);
      if(was) snap = JSON.stringify(draft);
    }
    setTitle(byId(o.store, draft.id) ? o.title : "New " + o.title.toLowerCase()); backBtn();
    var sec = add(app, "section");
    if(o.before) o.before(sec, draft);
    o.build(panelForm(sec), draft);
    function ensure(){
      if(!o.valid(draft)){ toast(o.invalid); return false; }
      saveNow().catch(function(){});
      return true;
    }
    if(o.more && o.moreFirst) o.more(sec, draft, ensure);
    btn(sec, "Done", o.moreFirst ? "ghost" : "", function(){
      if(!o.valid(draft)){ toast(o.invalid); return; }
      saveNow().then(function(){ back(); }, function(){});
    });
    if(o.more && !o.moreFirst) o.more(sec, draft, ensure);
    if(isSaved && o.del !== false){
      btn(sec, "Delete", "danger", function(){
        var why = o.keep ? o.keep(draft) : "";
        if(why){ toast(why); return; }
        if(!confirm("Delete this for good?")) return;
        gone = true;
        clearStash(draft.id);
        del(o.store, draft.id).then(back);
      });
    }
    hideHook = settle;
    /* saved on every change, not just on the way out */
    currentSettle = settle;
    sec.addEventListener("input", settle);
    sec.addEventListener("change", settle);
    leave = function(){
      currentSettle = null;
      if(o.cleanup) o.cleanup();
      if(settle()) toast("Not saved yet. " + o.invalid + " It's kept on the Home screen.");
    };
  });
  markRoute({k: "edit", store: o.store, rid: draft.id});
}
/* ─────────── sharing a file: Android's share menu, or a download on a computer ───────────
   Chrome only lets a short list of file types through the share menu. PDF, CSV and
   plain text are on it, JSON is not, so the backup is written as a .txt file. */
function saveFile(blob, name){
  var a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 20000);
  return true;
}
/* true once shared, false if cancelled, "download" if it went to a download we can't see land */
function shareFile(blob, name, title){
  var f = new File([blob], name, {type: blob.type});
  if(navigator.canShare && navigator.canShare({files: [f]})){
    return navigator.share({files: [f], title: title}).then(function(){ return true; }, function(e){
      if(e && e.name === "AbortError") return false;
      saveFile(blob, name);
      return "download";
    });
  }
  saveFile(blob, name);
  return Promise.resolve("download");
}
function safeName(s){ return String(s || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
/* ─────────── things that need attention, shown at the top of Jobs and Records ─────────── */
function licenceAlerts(){
  return S.licences.filter(function(l){ return l.expiry && daysFromToday(l.expiry) <= 30; })
    .sort(function(a, b){ return a.expiry < b.expiry ? -1 : 1; });
}
function banners(p){
  allStashes().forEach(function(kept){
    var ks = note(p, "", "Not saved yet:", kept.title.toLowerCase() + " from " + fmtDate(kept.at) + ". " + kept.why);
    var kb = add(ks, "div", "btns");
    btn(kb, "Open it", "small", function(){
      var open = {jobs: jobView, clients: clientView, paddocks: paddockView, people: personView, drones: droneView, licences: licenceView}[kept.store];
      if(open) open(kept.draft);
    });
    btn(kb, "Throw it away", "ghost small", function(){
      if(!confirm("Throw this away for good?")) return;
      clearStash(kept.draft.id);
      rerender();
    });
  });
  var drafts = S.records.filter(function(r){ return r.status !== "final" && !r.finishedAt; })
    .sort(function(a, b){ return recordDue(a) < recordDue(b) ? -1 : 1; });
  if(drafts.length && curTab !== "records"){
    var soon = recordDue(drafts[0]);
    note(p, daysFromToday(soon) < 0 ? "stop" : "",
      drafts.length === 1 ? "1 spray record to finish." : drafts.length + " spray records to finish.",
      "The next is due " + fmtDate(soon) + ".");
  }
  S.records.forEach(function(r){
    if(r.status === "final" && r.reef && r.reef.applies === true && !r.reef.copyGiven && prescribedIn(r.items).length){
      note(p, daysFromToday(reefCopyDue(r)) < 0 ? "stop" : "", "Reef copy owed.",
        "Give " + (r.owner.name || "the customer") + " a copy of the " + fmtDate(r.date) + " record by " + fmtDate(reefCopyDue(r)) + ".");
    }
  });
  licenceAlerts().forEach(function(l){
    var d = daysFromToday(l.expiry);
    note(p, d < 0 ? "stop" : "", l.kind + (d < 0 ? " has run out." : " runs out soon."), fmtDate(l.expiry) + (l.holder ? ", " + l.holder : "") + ".");
  });
  if(S.records.length || S.quotes.length || S.jobs.length || S.clients.length){
    var last = cfg().lastBackup;
    if(!last || daysFromToday(last) < -7){
      var n = note(p, "stop", "Back up your records.",
        (last ? "The last backup was " + fmtDate(last) + "." : "There is no backup yet.") + " These records must be kept for years and they live only on this phone.");
      btn(n, "Back up now", "small", function(){ backupNow().then(function(){ rerender(); }); });
    }
  }
}

/* ═════════════ JOBS ═════════════ */
var jobFilter = {status: "open", client: ""};
var JOB_STATUS = [["planned","Planned"],["booked","Booked"],["done","Done"],["cancelled","Cancelled"]];

function jobPaddocks(j){ return (j.paddockIds || []).map(function(id){ return byId("paddocks", id); }).filter(Boolean); }
function jobHa(j){ return jobPaddocks(j).reduce(function(s, p){ return s + (num(p.ha) || 0); }, 0); }
/* paddocks with no area, which a total of hectares would otherwise quietly leave out */
function noHaNames(list){
  return list.filter(function(p){ return !(num(p.ha) > 0); }).map(function(p){ return p.name; });
}
function clientName(id){ var c = byId("clients", id); return c ? c.name : ""; }
function roundHa(v){ return String(Math.round(v * 100) / 100); }
function openJobsUsing(test){
  return S.jobs.filter(function(j){ return (j.status === "planned" || j.status === "booked") && test(j); });
}
function stillUsed(what, jobs){
  return jobs.length ? what + " is on " + jobs.length + (jobs.length === 1 ? " open job" : " open jobs") + ". Change the job first." : "";
}

function jobsView(){
  setTitle("Jobs");
  if(jobFilter.client && !byId("clients", jobFilter.client)) jobFilter.client = "";
  var sec = add(app, "section");
  btn(sec, "New job", "", function(){ jobView(newJobItem()); });
  btn(sec, "Spray records (" + S.records.length + ")", "ghost", function(){ setTab("records"); });

  chipRow(sec, [["open","Open"],["done","Done"],["all","All"]], jobFilter.status, function(v){ jobFilter.status = v; rerender(); });
  if(S.clients.length > 1){
    var f = add(sec, "div");
    fld(f, "Client", select(jobFilter, "client", [["","All clients"]].concat(sortedClients().map(function(c){ return [c.id, c.name]; })), {on: rerender}));
  }

  var jobs = S.jobs.filter(function(j){
    if(jobFilter.client && j.clientId !== jobFilter.client) return false;
    if(jobFilter.status === "open") return j.status === "planned" || j.status === "booked";
    if(jobFilter.status === "done") return j.status === "done";
    return true;
  }).sort(function(a, b){
    if(!a.due && !b.due) return 0;
    if(!a.due) return 1;
    if(!b.due) return -1;
    return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
  });

  if(!jobs.length){
    add(sec, "div", "panel").appendChild(el("div", "empty", S.jobs.length ? "No jobs match that." : "No jobs yet. Tap New job to plan the first one."));
    return;
  }
  var list = listPanel(sec);
  jobs.forEach(function(j){
    var pads = jobPaddocks(j), ha = jobHa(j), st = "";
    JOB_STATUS.forEach(function(x){ if(x[0] === j.status) st = x[1]; });
    var open = j.status === "planned" || j.status === "booked";
    var late = open && j.due && daysFromToday(j.due) < 0;
    rowItem(list, clientName(j.clientId) || j.clientName || "No client yet", [
      {t: st, k: j.status === "done" ? "good" : ""},
      j.due ? {t: "Due " + fmtDate(j.due), k: late ? "stop" : ""} : null,
      ha ? fmtN(ha, 2) + " ha" : null,
      pads.length ? pads.map(function(p){ return p.name; }).join(", ") : null
    ], function(){ jobView(j); });
  });
}
function sortedClients(){
  return S.clients.slice().sort(function(a, b){ return (a.name || "").localeCompare(b.name || ""); });
}
function warnNotes(p, items){
  var pres = prescribedIn(items), haz = hazardIn(items);
  if(pres.length){
    note(p, "", "Reef rules may apply.", "This mix has " + pres.join(", ") + ". For sugarcane or cattle grazing in the Wet Tropics, Burdekin or Mackay Whitsunday regions, Queensland asks for more on the record, and allows 3 days to make it. " +
      (pres.indexOf("tebuthiuron") >= 0 ? "Records for tebuthiuron are kept for 6 years." : ""));
  }
  if(haz.length){
    note(p, "", "Hazardous areas.", "Queensland limits picloram and ester forms of 2,4-D and MCPA in declared hazardous areas. Check whether this paddock is in one (" + haz.join(", ") + ").");
  }
}
/* The only hard limit is products exceeding the spray volume, and a g for kg slip can
   stay under that. A big share of the tank is the sign to look again. */
function shareNote(p, res){
  if(res.ok && res.share >= 0.2){
    note(p, "", "Check the rates and units.", "Products make up " + fmtN(res.share * 100, 0) + " % of the spray. That can be right, but a slip between g and kg, or mL and L, is a thousand times out.");
  }
}

function itemEditor(parent, item, o){
  var box = add(parent, "div", "prod");
  var head = add(box, "div", "prod-head");
  var left = add(head, "div");
  add(left, "div", "item-name", item.name);
  var meta = add(left, "div", "item-meta");
  if(item.apvma) add(meta, "span", null, "APVMA " + item.apvma);
  if(item.maker) add(meta, "span", null, item.maker);
  if(item.additive) add(meta, "span", "tag", "Additive");
  if(itemLapsed(item)) add(meta, "span", "tag warn", "Registration lapsed");
  var acts = activesText(item);
  if(acts) add(left, "div", "prod-act", acts);
  if(o.onRemove){
    var x = add(head, "button", "x edit-only", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Remove " + item.name);
    x.addEventListener("click", o.onRemove);
  }
  var row = add(box, "div", "two");
  var echoEl = null, unitEl = null;
  function drawEcho(){
    if(echoEl) echoEl.textContent = C.echoProduct(cleanNum(item.rate), item.unit);
    if(unitEl) unitEl.classList.toggle("need", !item.unit);
  }
  fld(row, "Rate, from the label", input(item, "rate", {num: true, ph: "Rate", on: function(){ drawEcho(); o.onChange(); }}));
  var usedLabel = null;
  function usedName(){ return "Total actually used, in " + (item.unit ? (isDry(item) ? "kg" : "L") : "L or kg"); }
  unitEl = select(item, "unit", RATE_UNITS, {on: function(){
    if(usedLabel) usedLabel.textContent = usedName();
    drawEcho();
    o.onChange();
  }});
  fld(row, "Unit", unitEl);
  echoEl = add(box, "p", "echo");
  drawEcho();
  if(o.labelNo){
    fld(box, "Label no.", input(item, "labelNo", {ph: "Printed on the label", on: function(v){
      if(item.apvma){ cfg().labelNos = cfg().labelNos || {}; cfg().labelNos[item.apvma] = v; saveCfg(); }
      o.onChange();
    }}));
    if(!hasActiveAmount(item)){
      fld(box, "Active constituent and amount", input(item, "activesText", {ph: "From the label, e.g. Name 100 g/L", on: o.onChange}), "The APVMA list doesn't give an amount for this one.");
    }
  }
  if(o.used){
    usedLabel = fld(box, usedName(), input(item, "used", {num: true, ph: "Blank uses the worked-out total", on: o.onChange})).querySelector(".f-l");
  }
  if(canLink(item)){
    var a = add(box, "a", "lnk", "Open the approved label");
    a.href = labelUrl(item.apvma);
    a.target = "_blank";
    a.rel = "noopener";
  }
}
function recipeView(rc){
  push(function(){
    setTitle(rc.name); backBtn();
    var sec = add(app, "section");
    var list = listPanel(sec);
    rc.items.forEach(function(it){
      var d = add(list, "div", "item");
      add(d, "div", "item-name", it.name);
      add(d, "div", "item-meta", (it.rate || "?") + " " + it.unit + ", typed by you");
    });
    btn(sec, "Use this mix", "", function(){
      var m = mixState();
      m.sprayMode = "rate";
      m.sprayRateUnit = "L/ha";
      m.waterRate = rc.waterRate;
      m.items = clone(rc.items);
      m.jobLabel = "";
      m.jobId = "";
      m.recipeId = "";
      m.sprayTotal = "";
      m.mixed = 0;
      m.mixedSig = "";
      mixSave();
      toast("Loaded " + rc.name + ". Check it against the current label.");
      setTab("mix");
    });
    btn(sec, "Delete", "danger", function(){
      var why = stillUsed("This mix", openJobsUsing(function(j){ return j.recipeId === rc.id; }));
      if(why){ toast(why); return; }
      if(!confirm("Delete this saved mix?")) return;
      del("recipes", rc.id).then(back);
    });
  });
}

/* ─────────── picking a product from the APVMA list ─────────── */
function loadProducts(){
  if(PRODUCTS) return Promise.resolve(PRODUCTS);
  return fetch("./data/products.json").then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function(d){
    PRODUCTS = d.products.map(function(p){
      p.hay = (p[0] + " " + p[1] + " " + p[2] + " " + (p[4] || []).map(function(a){ return a[0]; }).join(" ")).toLowerCase();
      return p;
    });
    return PRODUCTS;
  });
}
function itemFromProduct(p){
  var saved = (cfg().labelNos || {})[p[0]] || "";
  return {
    apvma: p[0], name: p[1], maker: p[2], form: p[3], actives: p[4] || [],
    additive: p[8] === "tank", regTo: p[6] || "", rate: "", unit: "", labelNo: saved
  };
}
/* Apparent first, because that is what the shed is stocked with, then whatever is
   registered in Queensland. Same order as Weed ID. */
function productRank(p){
  return (/^apparent\b/i.test(p[1] || "") ? 0 : 2) + ((p[5] || []).indexOf("QLD") >= 0 ? 0 : 1);
}
function searchProducts(q){
  var words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length || !PRODUCTS) return [];
  return PRODUCTS.filter(function(p){
    return words.every(function(w){ return p.hay.indexOf(w) >= 0; });
  }).sort(function(a, b){
    return productRank(a) - productRank(b) || a[1].localeCompare(b[1]);
  }).slice(0, 60);
}
function pickProduct(cb){
  var state = {q: ""};
  function take(it){
    if(it.apvma){
      var recent = (lsJson(LS_RECENT) || []).filter(function(r){ return r.apvma !== it.apvma; });
      recent.unshift(clone(it));
      lsSet(LS_RECENT, JSON.stringify(recent.slice(0, 12)));
    }
    cb(it);
    back();
  }
  function row(list, it, tags){
    rowItem(list, it.name, tags, function(){ take(it); });
  }
  push(function(){
    setTitle(state.hand ? "Add a product" : "Pick a product"); backBtn();
    var sec = add(app, "section");
    if(state.hand){ handProduct(sec, take); return; }
    var s = add(sec, "div", "search");
    var box = input(state, "q", {ph: "Name, active or APVMA number", on: draw});
    box.setAttribute("aria-label", "Search products");
    s.appendChild(box);
    var out = add(sec, "div");
    add(sec, "p", "hint", "Whether a product can go on by drone is on its label. This list doesn't say.");
    btn(sec, "Not on the list? Add it by hand", "ghost", function(){ state.hand = true; rerender(); });
    function draw(){
      out.textContent = "";
      if(state.q.trim().length < 2){
        var rec = lsJson(LS_RECENT) || [];
        if(rec.length){
          add(out, "h2", "sec", "Used lately").style.marginBottom = "10px";
          var l1 = listPanel(out);
          rec.forEach(function(r){
            var it = clone(r);
            it.rate = ""; it.used = ""; it.unit = "";
            it.labelNo = (cfg().labelNos || {})[it.apvma] || it.labelNo || "";
            row(l1, it, ["APVMA " + it.apvma, it.maker]);
          });
        }
        return;
      }
      if(!PRODUCTS){
        out.appendChild(el("div", "loading", "Loading the product list…"));
        loadProducts().then(draw, function(){
          out.textContent = "";
          out.appendChild(el("div", "empty", "The product list couldn't load. Open the app once with signal, or add the product by hand."));
        });
        return;
      }
      var res = searchProducts(state.q);
      if(!res.length){
        add(out, "div", "panel").appendChild(el("div", "empty", "Nothing matches that."));
        return;
      }
      var list = listPanel(out);
      res.forEach(function(p){
        var it = itemFromProduct(p), qld = (p[5] || []).indexOf("QLD") >= 0;
        row(list, it, [
          "APVMA " + p[0],
          p[7] ? {t: p[7]} : null,
          qld ? {t: "QLD", k: "good"} : {t: "Not QLD", k: "warn"},
          itemLapsed(it) ? {t: "Registration lapsed", k: "warn"} : null
        ]);
      });
    }
    draw();
    box.focus();
  });
}
function handProduct(sec, done){
  var it = {apvma: "", name: "", maker: "", activesText: "", rate: "", unit: "", labelNo: "", additive: false};
  var f = panelForm(sec);
  fld(f, "Trade name", input(it, "name"));
  fld(f, "APVMA number or permit", input(it, "apvma"));
  fld(f, "Manufacturer", input(it, "maker"));
  fld(f, "Active constituents and amounts", input(it, "activesText", {area: true, ph: "e.g. Active name 100 g/L"}));
  checkbox(f, it, "additive", "This is an additive, such as a wetter or spreader");
  btn(sec, "Add product", "", function(){
    if(!it.name.trim()){ toast("Enter the trade name."); return; }
    done(it);
  });
}
/* ─────────── the paddock map ─────────── */
function qldLayer(){
  return L.tileLayer(QLD_IMAGERY, {
    minZoom: 5, maxZoom: 20, crossOrigin: "anonymous",
    bounds: [[-29.6, 137.5], [-9, 154]],
    attribution: QLD_CREDIT
  });
}
function lookupLot(lat, lng){
  var e = 0.005;
  var url = QLD_PARCELS + "?geometry=" + lng + "," + lat + "&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=1" +
    "&mapExtent=" + (lng - e) + "," + (lat - e) + "," + (lng + e) + "," + (lat + e) +
    "&imageDisplay=400,400,96&returnGeometry=false&f=json";
  return fetch(url).then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function(d){
    /* roads and rivers come back as parcels too, with the word "Null" for a lot number */
    function real(v){ return v && v !== "Null" ? v : ""; }
    var hit = (d.results || []).filter(function(x){ return x.attributes && real(x.attributes["Lot/plan"]); })[0];
    if(!hit) return null;
    var a = hit.attributes;
    return {lot: a["Lot/plan"], locality: real(a.Locality), areaM2: num(a["Lot area (m²)"]), tenure: real(a.Tenure)};
  });
}
function gpsPoint(){
  return new Promise(function(res, rej){
    if(!navigator.geolocation){ rej(new Error("This phone has no GPS access.")); return; }
    navigator.geolocation.getCurrentPosition(function(p){
      res([p.coords.latitude, p.coords.longitude]);
    }, function(e){ rej(new Error(e.code === 1 ? "Location is turned off for this app." : "The GPS couldn't get a fix.")); },
    {enableHighAccuracy: true, timeout: 20000, maximumAge: 30000});
  });
}

function paddockView(item, saved){
  var map = null, watchId = null, wake = null, poly = null, dots = null, mode = "";
  function stopWatch(){
    if(watchId != null){ navigator.geolocation.clearWatch(watchId); watchId = null; }
    if(wake){ wake.release().catch(function(){}); wake = null; }
  }
  editView({
    title: "Site or paddock", store: "paddocks", item: item,
    valid: function(d){
      return !!(d.name || "").trim() && !!d.clientId && (d.ha === "" || d.ha == null || num(d.ha) > 0);
    },
    invalid: "Give it a name, and any area as a number above 0.",
    after: function(d){ if(saved) saved(d); },
    keep: function(d){
      return stillUsed("This paddock", openJobsUsing(function(j){ return (j.paddockIds || []).indexOf(d.id) >= 0; }));
    },
    cleanup: function(){
      stopWatch();
      mode = "";
      poly = null;
      if(map){ map.remove(); map = null; }
    },
    before: function(sec, d){
      var panel = add(sec, "div", "panel");
      var box = add(panel, "div", "map");
      var bar = add(panel, "div", "map-bar");
      var info = add(panel, "div", "map-info");
      info.setAttribute("role", "status");
      var ha = {};
      /* a GPS walk wobbles over its own line, which barely moves the area, so only tapped corners are checked */
      function crossed(){ return mode !== "walk" && ringCrosses(d.ring); }
      function haText(){
        if(crossed()) return "The boundary crosses itself, so the hectares weren't changed. Undo back to where it went wrong, then tap the corners in order.";
        var a = ringHa(d.ring);
        return d.ring && d.ring.length >= 3 ? fmtN(a, 2) + " ha from the map" : "";
      }
      function say(t){ info.textContent = t || haText() || (navigator.onLine === false ? "Map pictures need internet unless you've looked here before. You can walk the boundary with the GPS, or just type the hectares below." : "Draw the paddock, or walk its boundary with the GPS. You can also just type the hectares below."); }
      function redraw(){
        if(!map) return;
        var r = d.ring || [];
        if(poly){ map.removeLayer(poly); poly = null; }
        dots.clearLayers();
        if(r.length >= 2) poly = L.polygon(r, {color: "#FFD23F", weight: 3, fillOpacity: .18}).addTo(map);
        r.forEach(function(p){ L.circleMarker(p, {radius: 5, color: "#FFD23F", fillColor: "#FFFFFF", fillOpacity: 1, weight: 2}).addTo(dots); });
      }
      function ringChanged(){
        var a = ringHa(d.ring);
        if(!crossed()){
          if(a > 0){
            d.ha = roundHa(a);
            d.haFromMap = true;
          } else if(d.haFromMap){
            d.ha = "";     /* the shape it came from has gone, so the figure goes too */
            d.haFromMap = false;
          }
          if(ha.input) ha.input.value = d.ha == null ? "" : d.ha;
        }
        d.centre = ringCentre(d.ring);
        redraw();
        say();
        if(currentSettle) currentSettle();
      }
      function addLot(lat, lng){
        say("Looking up the lot and plan…");
        lookupLot(lat, lng).then(function(hit){
          if(!hit){ say("No lot at that spot. It may be a road or a river, and lookups only cover Queensland."); return; }
          var lots = (d.lot || "").split(/,\s*/).filter(Boolean);
          if(lots.indexOf(hit.lot) < 0) lots.push(hit.lot);
          d.lot = lots.join(", ");
          if(hit.locality) d.locality = hit.locality;
          if(!box.isConnected){
            /* the form closed while this was on its way, so it goes straight to the saved paddock */
            var stored = byId("paddocks", d.id);
            if(stored){ stored.lot = d.lot; stored.locality = d.locality; put("paddocks", stored); }
            return;
          }
          if(ha.lot) ha.lot.value = d.lot;
          if(ha.locality) ha.locality.value = d.locality || "";
          say("Lot " + hit.lot + (hit.locality ? ", " + hit.locality : "") + ".");
        }, function(){
          say("That lookup needs signal. Type the lot and plan, or try again when you have bars.");
        });
      }
      var buttons = {};
      function setMode(m){
        stopWatch();
        mode = mode === m ? "" : m;
        Object.keys(buttons).forEach(function(k){ buttons[k].setAttribute("aria-pressed", String(k === mode)); });
        if(mode === "draw") say("Tap each corner of the paddock.");
        else if(mode === "lot") say("Tap inside a block to get its lot and plan.");
        else if(mode === "walk") startWalk();
        else say();
      }
      function startWalk(){
        if(!navigator.geolocation){ say("This phone has no GPS access."); return; }
        if((d.ring || []).length && !confirm("Start the boundary again from here?")){ setMode("walk"); return; }
        d.ring = [];
        ringChanged();
        if(navigator.wakeLock) navigator.wakeLock.request("screen").then(function(w){ wake = w; }, function(){});
        say("Waiting for a GPS fix…");
        watchId = navigator.geolocation.watchPosition(function(p){
          var acc = p.coords.accuracy, pt = [p.coords.latitude, p.coords.longitude];
          if(acc > 30){ say("GPS is only good to " + Math.round(acc) + " m, waiting for better."); return; }
          var last = d.ring[d.ring.length - 1];
          if(!last || distM(last, pt) >= 4){
            d.ring.push(pt);
            ringChanged();
            if(map) map.panTo(pt);
          }
          say(d.ring.length + " points, " + fmtN(ringHa(d.ring), 2) + " ha, GPS good to " + Math.round(acc) + " m. Tap Walk again to finish.");
        }, function(e){
          say(e.code === 1 ? "Location is turned off for this app." : "The GPS couldn't get a fix.");
        }, {enableHighAccuracy: true, maximumAge: 2000, timeout: 30000});
      }
      [["draw","Draw"],["walk","Walk"],["lot","Lot and plan"]].forEach(function(b){
        var x = add(bar, "button", "map-btn", b[1]);
        x.type = "button";
        x.setAttribute("aria-pressed", "false");
        x.addEventListener("click", function(){ setMode(b[0]); });
        buttons[b[0]] = x;
      });
      [["Undo", function(){ (d.ring || []).pop(); ringChanged(); }],
       ["Clear", function(){ if(confirm("Clear the boundary?")){ d.ring = []; ringChanged(); } }],
       ["My spot", function(){
         say("Finding you…");
         gpsPoint().then(function(p){ if(map) map.setView(p, 16); say(); }, function(e){ say(e.message); });
       }]].forEach(function(b){
        var x = add(bar, "button", "map-btn", b[0]);
        x.type = "button";
        x.addEventListener("click", b[1]);
      });
      say();
      d._ha = ha;
      loadScript("./vendor/leaflet.js").then(function(){
        if(!box.isConnected) return;
        map = L.map(box, {zoomControl: true});
        map.attributionControl.setPrefix(false);
        qldLayer().addTo(map);
        dots = L.layerGroup().addTo(map);
        if(d.ring && d.ring.length) map.fitBounds(L.latLngBounds(d.ring).pad(.25), {maxZoom: 17});
        else map.setView(d.centre || HOME, d.centre ? 16 : 9);
        redraw();
        map.on("click", function(e){
          if(mode === "draw"){
            d.ring = (d.ring || []).concat([[e.latlng.lat, e.latlng.lng]]);
            ringChanged();
          } else if(mode === "lot"){
            addLot(e.latlng.lat, e.latlng.lng);
          }
        });
      }, function(){ say("The map couldn't load. Open the app once with signal. You can still type the hectares."); });
    },
    build: function(f, d){
      var ha = d._ha || {};
      delete d._ha;
      fld(f, "Site or paddock name", input(d, "name", {ph: "e.g. River flat"}));
      fld(f, "Site address or location", input(d, "address"));
      var r = add(f, "div", "two");
      ha.input = input(d, "ha", {num: true, ph: "Hectares", on: function(){ d.haFromMap = false; }});
      fld(r, "Area, ha", ha.input);
      fld(r, "Crop or situation", input(d, "crop"));
      ha.lot = input(d, "lot", {ph: "Lot number and plan number"});
      fld(f, "Lot and plan", ha.lot, "Queensland's Real Property Description. Lookups need signal.");
      ha.locality = input(d, "locality");
      fld(f, "Locality", ha.locality);
      fld(f, "Notes", input(d, "notes", {area: true, ph: "Gates, powerlines, neighbours' crops"}));
    }
  });
}

/* ─────────── forecast: always labelled, never an on-site reading ─────────── */
function readForecast(json){
  var ts = json.properties.timeseries, now = Date.now(), best = ts[0], gap = Infinity;
  ts.forEach(function(t){
    var g = Math.abs(new Date(t.time).getTime() - now);
    if(g < gap){ gap = g; best = t; }
  });
  var d = best.data.instant.details, n = best.data.next_1_hours;
  return {
    time: best.time, temp: d.air_temperature, rh: d.relative_humidity,
    wind: Math.round(msToKmh(d.wind_speed) * 10) / 10, dir: compass(d.wind_from_direction),
    cloud: Math.round(d.cloud_area_fraction), rain: n ? n.details.precipitation_amount : null
  };
}
function fmtWhen(iso){
  var d = new Date(iso);
  if(isNaN(d.getTime())) return "";
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function forecastLine(f){
  return "For " + fmtWhen(f.time) + ": " + fmtN(f.temp, 1) + " °C, " + fmtN(f.rh, 0) + " % humidity, wind " + fmtN(f.wind, 1) +
    " km/h from the " + f.dir + ", cloud " + f.cloud + " %" + (f.rain != null ? ", rain " + fmtN(f.rain, 1) + " mm next hour" : "") + ".";
}
function getForecast(p){
  var lat = p[0].toFixed(4), lng = p[1].toFixed(4), key = lat + "," + lng, c = lsJson(LS_FC);
  /* MET Norway asks for responses to be reused rather than fetched again */
  if(c && c.key === key && Date.now() - c.at < 1800000) return Promise.resolve(readForecast(c.json));
  return fetch(MET_FORECAST + "?lat=" + lat + "&lon=" + lng).then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function(json){
    lsSet(LS_FC, JSON.stringify({key: key, at: Date.now(), json: json}));
    return readForecast(json);
  });
}
function forecastBox(parent, point, onKeep){
  add(parent, "h3", null, "Forecast");
  var out = add(parent, "div");
  add(out, "p", "hint", "A guide for planning, not an on-site reading. Needs signal.");
  btn(parent, "Get the forecast", "ghost small", function(){
    out.textContent = "";
    out.appendChild(el("div", "loading", "Getting the forecast…"));
    point().then(getForecast).then(function(f){
      out.textContent = "";
      var dt = deltaT(f.temp, f.rh), band = deltaTBand(dt);
      add(out, "div", "f-l", "For right now, " + fmtWhen(f.time));
      add(out, "div", "item-name", fmtN(f.temp, 1) + " °C, " + fmtN(f.rh, 0) + " % humidity");
      add(out, "div", null, "Wind " + fmtN(f.wind, 1) + " km/h from the " + f.dir + ", cloud " + f.cloud + " %" + (f.rain != null ? ", rain " + fmtN(f.rain, 1) + " mm next hour" : ""));
      if(dt != null){
        var r = add(out, "div", "dt");
        add(r, "b", null, "Delta T " + fmtN(dt, 1));
        add(r, "span", "tag " + band.k, band.t);
      }
      add(out, "p", "hint", "Forecast from MET Norway (CC BY 4.0), not measured on site.").style.marginTop = "8px";
      if(onKeep) btn(out, "Keep with this record, marked as forecast", "ghost small", function(){ onKeep(f); });
    }).catch(function(e){
      out.textContent = "";
      add(out, "p", "hint", /fetch|network/i.test(e.message) ? "That needs signal. Try again when you have bars." : e.message);
    });
  });
}

/* ═════════════ RECORDS ═════════════ */
function newRecord(job){
  var rec = {
    /* today, not the job's due date: a planned date must never pass as the day it was sprayed */
    status: "draft", jobId: job ? job.id : "", created: nowStamp(), date: todayISO(),
    endDate: "", startTime: "", endTime: "",
    clientId: job ? job.clientId : "",
    owner: {name: "", property: "", address: "", phone: ""},
    applicator: {name: "", address: "", phone: "", quals: ""},
    supervisor: {name: "", address: "", phone: "", quals: ""},
    rings: [], lots: "", paddockNames: "", gps: "", area: "",
    droneId: "", aircraft: "", rego: "", tank: "",
    method: "Aerial, remotely piloted aircraft (drone)", nozzle: "",
    waterRate: "", diluent: "Water", items: [], situation: "", purpose: "", labelNotes: "",
    weather: [
      {stage: "Before", time: "", temp: "", rh: "", wind: "", dir: "", cloud: "", rain: ""},
      {stage: "During", time: "", temp: "", rh: "", wind: "", dir: "", cloud: "", rain: ""},
      {stage: "After",  time: "", temp: "", rh: "", wind: "", dir: "", cloud: "", rain: ""}
    ],
    forecast: null,
    reef: {applies: null, receipt: "", qualsCopy: false, copyGiven: ""},
    sessions: [{id: uid(), date: todayISO(), start: "", finish: ""}], notes: "",
    history: [], finishedAt: "", amendedAt: ""
  };
  if(job){
    var c = byId("clients", job.clientId);
    if(c) fillOwner(rec, c);
    jobPaddocks(job).forEach(function(p){ addRing(rec, p); });
    syncPaddocks(rec);
    rec.situation = job.situation || "";
    rec.purpose = job.purpose || "";
    rec.notes = job.notes || "";
    var mixHa = jobMixHa(job);
    if(mixHa) rec.area = mixHa;
    var mx = jobMixSource(job);
    if(mx){
      rec.waterRate = mixWater(mx);
      rec.items = mixItems(mx.items);
    }
    var pl = byId("people", job.pilotId) || onlyOne(S.people);
    if(pl) fillPerson(rec.applicator, pl);
    var dr = byId("drones", job.droneId) || onlyOne(S.drones);
    if(dr) fillDrone(rec, dr);
  } else {
    var p0 = onlyOne(S.people), d0 = onlyOne(S.drones);
    if(p0) fillPerson(rec.applicator, p0);
    if(d0) fillDrone(rec, d0);
  }
  recordDrift(rec);
  return rec;
}
/* With two pilots or two drones the app can't know who flew, so it doesn't guess */
function onlyOne(list){ return list.length === 1 ? list[0] : null; }
/* What was worked out for this job on the Mix tab, or failing that its saved mix */
function jobMixSource(job){
  var m = mixState();
  if(m.jobId === job.id && m.items.length) return m;
  if(job.mixItems && job.mixItems.length) return {waterRate: job.mixWater, items: job.mixItems};
  return byId("recipes", job.recipeId);
}
function mixItems(items){
  return clone(items).map(function(it){
    it.labelNo = (cfg().labelNos || {})[it.apvma] || it.labelNo || "";
    return it;
  });
}
function mixSig(water, items){
  return String(water || "") + "#" + items.map(function(it){ return [it.apvma || it.name, it.rate, it.unit].join("|"); }).join(";");
}
function padSig(ids, haOf){
  return ids.slice().sort().map(function(id){ return id + "=" + haOf(id); }).join(";");
}
/* A draft is fixed when it starts, so say so if its job has moved on since */
function recordDrift(rec){
  var j = byId("jobs", rec.jobId);
  if(!j || rec.status === "final" || rec.finishedAt) return null;
  var src = jobMixSource(j);
  var mixNow = src ? mixSig(mixWater(src), src.items) : "";
  var padNow = padSig(j.paddockIds || [], function(id){ var p = byId("paddocks", id); return p ? String(p.ha || "") : ""; });
  /* what the job looked like when this record started. Editing the record isn't the job changing */
  if(rec.jobMixSig === undefined){ rec.jobMixSig = mixNow; rec.jobPadSig = padNow; return null; }
  var what = [];
  if(src && mixNow !== rec.jobMixSig) what.push("mix");
  if(padNow !== rec.jobPadSig) what.push("paddocks");
  return what.length ? {what: what, src: src, job: j, mixNow: mixNow, padNow: padNow} : null;
}
function applyDrift(rec, dr){
  if(dr.what.indexOf("mix") >= 0 && dr.src){
    var old = {};
    rec.items.forEach(function(it){ old[it.apvma || it.name] = it; });
    rec.waterRate = mixWater(dr.src);
    rec.items = mixItems(dr.src.items).map(function(it){
      var was = old[it.apvma || it.name];
      if(was){
        it.labelNo = was.labelNo || it.labelNo;
        if(was.activesText) it.activesText = was.activesText;
        if(was.used) it.used = was.used;
      }
      return it;
    });
  }
  if(dr.what.indexOf("paddocks") >= 0){
    rec.rings = [];
    jobPaddocks(dr.job).forEach(function(p){ addRing(rec, p); });
    syncPaddocks(rec);
  }
  rec.jobMixSig = dr.mixNow;
  rec.jobPadSig = dr.padNow;
}
function fillOwner(rec, c){
  rec.clientId = c.id;
  rec.owner = {name: c.name || "", property: c.property || "", address: c.address || "", phone: c.phone || ""};
}
function fillPerson(t, p){ t.name = p.name || ""; t.address = p.address || ""; t.phone = p.phone || ""; t.quals = p.quals || ""; }
function fillDrone(rec, d){ rec.droneId = d.id; rec.aircraft = d.name || ""; rec.rego = d.rego || ""; rec.tank = d.tank || ""; rec.nozzle = d.nozzle || ""; }
function addRing(rec, p){
  rec.rings.push({id: p.id, name: p.name, ring: p.ring || [], lot: p.lot || "", locality: p.locality || "", ha: p.ha || "", centre: p.centre || null});
}
/* Refills from the paddock list, and empties when the last paddock comes off, but never
   writes over what was typed by hand, such as the area of a part-sprayed block. */
function syncPaddocks(rec){
  var auto = rec.auto || (rec.auto = {});
  function fill(key, val){
    var cur = String(rec[key] == null ? "" : rec[key]);
    var ours = !cur.trim() || cur === String(auto[key] == null ? "" : auto[key]);
    auto[key] = val;
    if(ours) rec[key] = val;
    return ours || cur === val;
  }
  fill("paddockNames", rec.rings.map(function(r){ return r.name; }).join(", "));
  var lots = [];
  rec.rings.forEach(function(r){ (r.lot || "").split(/,\s*/).forEach(function(l){ if(l && lots.indexOf(l) < 0) lots.push(l); }); });
  fill("lots", lots.join(", "));
  var ha = rec.rings.reduce(function(s, r){ return s + (num(r.ha) || 0); }, 0);
  if(!fill("area", ha ? roundHa(ha) : "")){
    toast("Total area kept at " + rec.area + " ha as typed. The paddocks come to " + fmtN(ha, 2) + " ha.");
  }
  var c = rec.rings.filter(function(r){ return r.centre; }).map(function(r){ return r.centre; });
  fill("gps", c.map(function(x){ return x[0].toFixed(5) + ", " + x[1].toFixed(5); }).join("; "));
}
function openRecordFor(job){
  var r = S.records.filter(function(x){ return x.jobId === job.id; })[0];
  if(r){ recordView(r); return; }
  var rec = newRecord(job);
  put("records", rec).then(function(){ recordView(rec); });
}

function recordTitle(r){ return (r.owner && r.owner.name) || "No client yet"; }
var recFilter = {status: "todo", from: "", to: ""};

function recordsView(){
  setTitle("Spray records");
  var sec = add(app, "section");
  banners(sec);
  btn(sec, "New spray record", "", function(){
    var rec = newRecord(null);
    put("records", rec).then(function(){ recordView(rec); });
  });
  chipRow(sec, [["todo","To finish"],["final","Finished"],["all","All"]], recFilter.status, function(v){ recFilter.status = v; rerender(); });
  var recs = S.records.filter(function(r){
    if(recFilter.status === "todo") return r.status !== "final";
    if(recFilter.status === "final") return r.status === "final";
    return true;
  }).sort(function(a, b){ return (a.date || "") < (b.date || "") ? 1 : (a.date || "") > (b.date || "") ? -1 : 0; });
  if(!recs.length){
    add(sec, "div", "panel").appendChild(el("div", "empty", recFilter.status === "todo" ? "Nothing to finish." : "No records here yet."));
  } else {
    var list = listPanel(sec);
    recs.forEach(function(r){
      var due = recordDue(r), late = daysFromToday(due) < 0;
      rowItem(list, recordTitle(r), [
        fmtDate(r.date),
        r.paddockNames || null,
        r.area ? fmtN(num(r.area), 2) + " ha" : null,
        r.status === "final" ? {t: "Keep until " + fmtDate(keepUntil(r)), k: "good"} :
          r.finishedAt ? {t: "Being amended", k: "warn"} : {t: "Due " + fmtDate(due), k: late ? "stop" : "warn"}
      ], function(){ recordView(r); });
    });
  }
  add(sec, "h2", "sec", "Spreadsheet");
  var f = panelForm(sec);
  var r2 = add(f, "div", "two");
  fld(r2, "From", input(recFilter, "from", {type: "date"}));
  fld(r2, "To", input(recFilter, "to", {type: "date"}));
  btn(f, "Export finished records", "ghost", function(){
    var pick = S.records.filter(function(r){
      return r.status === "final" && (!recFilter.from || r.date >= recFilter.from) && (!recFilter.to || r.date <= recFilter.to);
    });
    if(!pick.length){ toast("No finished records in those dates."); return; }
    var blob = new Blob(["﻿" + recordsCsv(pick)], {type: "text/csv"});
    shareFile(blob, "STEL-Spray-Records-" + todayISO() + ".csv", "STEL spray records");
  });
}

function missingFor(rec){
  var m = [];
  function need(v, label){ if(!String(v == null ? "" : v).trim()) m.push(label); }
  need(rec.date, "Date applied");
  var today = todayISO();
  if(rec.date && rec.date > today) m.push("Date applied can't be in the future");
  if(rec.endDate && rec.endDate > today) m.push("Last day can't be in the future");
  if(rec.endDate && rec.date && rec.endDate < rec.date) m.push("Last day can't be before the date applied");
  need(rec.owner.name, "Landowner or occupier's name");
  need(rec.owner.address, "Landowner's address");
  need(rec.owner.phone, "Landowner's phone");
  need(rec.applicator.name, "Pilot in command's name");
  need(rec.applicator.address, "Pilot's address");
  need(rec.applicator.phone, "Pilot's phone");
  need(rec.applicator.quals, "Pilot's qualifications");
  /* optional as a whole, but once any of it is filled in Queensland wants all of it */
  var sup = rec.supervisor;
  if([sup.name, sup.address, sup.phone, sup.quals].some(function(v){ return String(v || "").trim(); })){
    need(sup.name, "Organiser or supervisor's name");
    need(sup.address, "Organiser or supervisor's address");
    need(sup.phone, "Organiser or supervisor's phone");
    need(sup.quals, "Organiser or supervisor's qualifications");
  }
  if(!String(rec.lots || "").trim() && !String(rec.paddockNames || "").trim()) m.push("Lot and plan or paddock names");
  need(rec.rego, "Aircraft registration mark");
  need(rec.method, "Equipment and method");
  need(rec.nozzle, "Nozzle type");
  need(rec.diluent, "Diluent");
  if(!rec.items.length) m.push("At least one product");
  /* if the sums can't run, the record has no totals, so those failures stop it finishing too */
  var mix = calcMix({ha: rec.area, waterRate: rec.waterRate, items: rec.items, noTank: true});
  if(!mix.ok) m = m.concat(mix.errors);
  rec.items.forEach(function(it){
    need(it.apvma, "APVMA number for " + it.name);
    need(it.labelNo, "Label number for " + it.name);
    need(it.maker, "Manufacturer of " + it.name);
    if(!hasActiveAmount(it)) m.push("Active constituent and amount for " + it.name);
    if(String(it.used == null ? "" : it.used).trim() && !(num(it.used) >= 0)) m.push("Total actually used for " + it.name + ", as a plain number");
  });
  need(rec.situation, "Crop or situation");
  need(rec.purpose, "Purpose");
  function gapsIn(w){
    var gaps = [];
    if(!w.time) gaps.push("time");
    if(isNaN(num(w.temp))) gaps.push("temperature");
    if(!(num(w.rh) >= 0 && num(w.rh) <= 100)) gaps.push("humidity from 0 to 100");
    if(!(num(w.wind) >= 0)) gaps.push("wind speed");
    if(!w.dir) gaps.push("wind direction");
    if(!String(w.cloud == null ? "" : w.cloud).trim()) gaps.push("cloud");
    if(!(num(w.rain) >= 0)) gaps.push("rain");
    return gaps;
  }
  ["Before","During","After"].forEach(function(st){
    var w = rec.weather.filter(function(x){ return x.stage === st; })[0];
    if(!w){ m.push("Weather " + st.toLowerCase()); return; }
    var gaps = gapsIn(w);
    if(gaps.length) m.push("Weather " + st.toLowerCase() + ": " + gaps.join(", "));
  });
  rec.weather.filter(function(x){ return x.stage === "Change"; }).forEach(function(w){
    var gaps = gapsIn(w);
    if(gaps.length) m.push("Weather change" + (w.time ? " at " + w.time : "") + ": " + gaps.join(", "));
  });
  if(prescribedIn(rec.items).length){
    if(rec.reef.applies == null) m.push("Whether the Reef rules apply");
    if(rec.reef.applies === true){
      need(rec.reef.receipt, "Purchase record for the prescribed product");
      if(!rec.reef.qualsCopy) m.push("Copy of qualifications");
    }
  }
  return m;
}

function recordView(rec){ push(function(){ buildRecord(rec); }); markRoute({k: "record", rid: rec.id}); }

function buildRecord(rec){
  var final = rec.status === "final";
  setTitle(final ? "Spray record" : "Spray record, draft");
  backBtn();
  var sec = add(app, "section");
  var save = debounce(function(){ rec.updated = nowStamp(); put("records", rec); }, 60);
  leave = function(){ save.flush(); };
  hideHook = function(){ save.flush(); };
  function changed(){ save(); }
  if(rec.diluent == null) rec.diluent = "Water";   /* drafts started before this field existed */

  if(final){
    note(sec, "good", "Finished " + fmtDate(rec.finishedAt) + ".",
      "Keep until " + fmtDate(keepUntil(rec)) + "." + (rec.amendedAt ? " Amended " + fmtDate(rec.amendedAt) + ", earlier versions kept." : ""));
    if(!cfg().lastBackup || cfg().lastBackup < (rec.amendedAt || rec.finishedAt)){
      var bn = note(sec, "stop", "Back this up.", "This record is only on this phone until you do.");
      btn(bn, "Back up now", "small", function(){ backupNow().then(function(){ rerender(); }); });
    }
  } else if(rec.finishedAt){
    note(sec, "", "Being amended.", "This was finished " + fmtDate(rec.finishedAt) + ". That version is kept, and this one replaces it when you finish. Saved as you type.");
  } else {
    var due = recordDue(rec), d = daysFromToday(due), hasPres = prescribedIn(rec.items).length;
    note(sec, d < 0 ? "stop" : "", "Due " + fmtDate(due) + ".",
      (hasPres ? (rec.reef.applies === true ? "3 days under the Reef rules." : "2 days, or 3 if the Reef rules apply.") : "2 days.") + " Saved as you type.");
    var drift = recordDrift(rec);
    if(drift){
      var dn = note(sec, "stop", "The job has changed.", "Its " + drift.what.join(" and ") + " changed after this record started.");
      var db2 = add(dn, "div", "btns");
      btn(db2, "Update this record", "small", function(){
        if(!confirm("Replace this record's " + drift.what.join(" and ") + " with the job's?")) return;
        applyDrift(rec, drift);
        changed();
        rerender();
      });
      btn(db2, "Keep it as it is", "ghost small", function(){
        rec.jobMixSig = drift.mixNow;
        rec.jobPadSig = drift.padNow;
        changed();
        rerender();
      });
    }
  }

  var fs = add(sec, "fieldset", "bare");
  fs.disabled = final;

  /* the job */
  add(fs, "h2", "sec", "The job");
  var f1 = panelForm(fs);
  sessionsBlock(f1, rec, changed, final);
  fld(f1, "Crop or situation", input(rec, "situation", {on: changed}));
  fld(f1, "Purpose", input(rec, "purpose", {ph: "What is being controlled, and why", on: changed}));

  /* the people */
  var f2 = foldForm(fs, "People", final || peopleGaps(rec));
  if(S.clients.length){
    var pickC = {v: rec.clientId || ""};
    var cw = fld(f2, "Fill from a client", select(pickC, "v", [["","Pick"]].concat(sortedClients().map(function(c){ return [c.id, c.name]; })), {on: function(v){
      var c = byId("clients", v);
      if(c){ fillOwner(rec, c); changed(); rerender(); }
    }}));
    cw.classList.add("edit-only");
  }
  add(f2, "h3", null, "Landowner or occupier");
  fld(f2, "Name", input(rec.owner, "name", {on: changed}));
  fld(f2, "Property", input(rec.owner, "property", {on: changed}));
  fld(f2, "Address", input(rec.owner, "address", {area: true, on: changed}));
  fld(f2, "Phone", input(rec.owner, "phone", {type: "tel", on: changed}));
  add(f2, "h3", null, "Pilot in command, who applied it");
  if(S.people.length){
    var pickP = {v: ""};
    var pw = fld(f2, "Fill from Setup", select(pickP, "v", [["","Pick"]].concat(S.people.map(function(p){ return [p.id, p.name]; })), {on: function(v){
      var p = byId("people", v);
      if(p){ fillPerson(rec.applicator, p); changed(); rerender(); }
    }}));
    pw.classList.add("edit-only");
  }
  fld(f2, "Name", input(rec.applicator, "name", {on: changed}));
  fld(f2, "Address", input(rec.applicator, "address", {area: true, on: changed}));
  fld(f2, "Phone", input(rec.applicator, "phone", {type: "tel", on: changed}));
  fld(f2, "Qualifications", input(rec.applicator, "quals", {area: true, on: changed}));
  add(f2, "h3", null, "Organiser or supervisor, if any");
  fld(f2, "Name", input(rec.supervisor, "name", {on: changed}));
  fld(f2, "Address", input(rec.supervisor, "address", {on: changed}));
  fld(f2, "Phone", input(rec.supervisor, "phone", {type: "tel", on: changed}));
  fld(f2, "Qualifications", input(rec.supervisor, "quals", {on: changed}));

  /* the land */
  var f3 = foldForm(fs, "Treated land", final || !(rec.lots || rec.paddockNames));
  var pickable = S.paddocks.filter(function(p){ return (!rec.clientId || p.clientId === rec.clientId) && !rec.rings.some(function(r){ return r.id === p.id; }); });
  if(pickable.length){
    var pickPd = {v: ""};
    var ppw = fld(f3, "Add a saved paddock", select(pickPd, "v", [["","Pick"]].concat(pickable.map(function(p){ return [p.id, p.name]; })), {on: function(v){
      var p = byId("paddocks", v);
      if(p){ addRing(rec, p); syncPaddocks(rec); changed(); rerender(); }
    }}));
    ppw.classList.add("edit-only");
  }
  rec.rings.forEach(function(r, i){
    var row = add(f3, "div", "prod-head");
    var left = add(row, "div");
    add(left, "div", "item-name", r.name);
    add(left, "div", "item-meta", [r.ha ? fmtN(num(r.ha), 2) + " ha" : "", r.lot].filter(Boolean).join(", "));
    var x = add(row, "button", "x edit-only", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Take " + r.name + " off this record");
    x.addEventListener("click", function(){ rec.rings.splice(i, 1); syncPaddocks(rec); changed(); rerender(); });
  });
  var padGaps = noHaNames(rec.rings);
  if(padGaps.length) add(f3, "p", "hint", "No hectares for " + padGaps.join(", ") + ", so the total area leaves this out.");
  fld(f3, "Lot and plan", input(rec, "lots", {on: changed}), "Queensland's Real Property Description.");
  fld(f3, "Paddock names", input(rec, "paddockNames", {on: changed}));
  fld(f3, "GPS", input(rec, "gps", {ph: "Latitude, longitude", on: changed}));

  /* aircraft and method */
  var f4 = foldForm(fs, "Aircraft and method", final || !(rec.rego && rec.nozzle));
  if(S.drones.length){
    var pickD = {v: rec.droneId || ""};
    var dw = fld(f4, "Fill from Setup", select(pickD, "v", [["","Pick"]].concat(S.drones.map(function(x){ return [x.id, x.name]; })), {on: function(v){
      var x = byId("drones", v);
      if(x){ fillDrone(rec, x); changed(); rerender(); }
    }}));
    dw.classList.add("edit-only");
  }
  var r4 = add(f4, "div", "two");
  fld(r4, "Aircraft", input(rec, "aircraft", {on: changed}));
  fld(r4, "Registration mark", input(rec, "rego", {on: changed}));
  fld(f4, "Method", input(rec, "method", {on: changed}));
  fld(f4, "Nozzle type", input(rec, "nozzle", {on: changed}));

  /* the chemical */
  add(fs, "h2", "sec", "Products and mix");
  var f5 = panelForm(fs);
  areaSprayFields(f5, rec, function(){ changed(); redrawMix(); });
  fld(f5, "Diluent", input(rec, "diluent", {ph: "e.g. Water", on: function(){ changed(); redrawMix(); }}));
  rec.items.forEach(function(it, i){
    itemEditor(fs, it, {
      labelNo: true, used: true,
      onChange: function(){ changed(); redrawMix(); },
      onRemove: function(){ rec.items.splice(i, 1); changed(); rerender(); }
    });
  });
  var addP = btn(fs, "Add a product", "ghost edit-only", function(){
    pickProduct(function(it){ rec.items.push(it); changed(); });
  });
  addP.style.width = "100%";
  var warnBox = add(fs, "div");
  warnBox.style.cssText = "display:flex;flex-direction:column;gap:10px";
  var mixBox = add(add(fs, "div", "panel"), "div", "result");
  function redrawMix(){
    warnBox.textContent = "";
    if(!final) warnNotes(warnBox, rec.items);
    mixBox.textContent = "";
    var res = calcMix({ha: rec.area, waterRate: rec.waterRate, tank: rec.tank, items: rec.items, noTank: true});
    if(!final) shareNote(warnBox, res);
    if(!res.ok){
      res.errors.forEach(function(e){ add(mixBox, "p", "hint", e); });
      return;
    }
    var b = add(mixBox, "div", "big", fmtN(res.total, 2) + " L");
    add(b, "small", null, "total spray");
    var dl = add(mixBox, "div", "dt");
    add(dl, "b", null, fmtAmount(res.diluent * 1000, false));
    add(dl, "span", null, rec.diluent || "Diluent");
    res.items.forEach(function(x, i){
      var worked = fmtAmount(x.total, x.dry), shown = usedText(rec.items[i], worked);
      var r = add(mixBox, "div", "dt");
      add(r, "b", null, shown);
      add(r, "span", null, x.name + (shown !== worked ? ", typed by you. Worked out at " + worked + "." : ""));
    });
  }
  redrawMix();
  var fN = panelForm(fs);
  fld(fN, "Anything the label or permit asks to record", input(rec, "labelNotes", {area: true, on: changed}));
  fld(fN, "Notes", input(rec, "notes", {area: true, on: changed}));

  /* Reef */
  var pres = prescribedIn(rec.items);
  if(pres.length){
    add(fs, "h2", "sec", "Reef rules");
    var f6 = panelForm(fs);
    add(f6, "p", "hint", "This mix has " + pres.join(", ") + ". Queensland asks for more when it is used for sugarcane or cattle grazing in the Wet Tropics, Burdekin or Mackay Whitsunday regions.");
    add(f6, "span", "f-l", "Do those rules apply to this job?");
    var ch = add(f6, "div", "edit-only");
    chipRow(ch, [[true,"Yes"],[false,"No"]], rec.reef.applies, function(v){ rec.reef.applies = v; changed(); rerender(); });
    if(final) add(f6, "div", "item-name", rec.reef.applies ? "Yes" : "No");
    if(rec.reef.applies === true){
      fld(f6, "Purchase record or receipt", input(rec.reef, "receipt", {ph: "Supplier, invoice number and date", on: changed}));
      checkbox(f6, rec.reef, "qualsCopy", "A copy of my qualifications is kept with this record", changed);
      if(!final) fld(f6, "Copy given to the customer on", input(rec.reef, "copyGiven", {type: "date", on: changed}), "Due within 5 days of finishing this record.");
    }
  }

  /* weather */
  add(fs, "h2", "sec", "Weather on site");
  var f7 = panelForm(fs);
  add(f7, "p", "hint", "Your own readings, with the time of each. Delta T is GRDC's general guide. The label wins, and Delta T can't rule out a surface inversion.");
  rec.weather.forEach(function(w, i){ weatherRow(f7, rec, w, i, changed); });
  var addW = btn(f7, "Add a reading if conditions changed", "ghost small edit-only", function(){
    rec.weather.splice(rec.weather.length - 1, 0, {stage: "Change", time: nowTime(), temp: "", rh: "", wind: "", dir: "", cloud: "", rain: ""});
    changed(); rerender();
  });
  addW.style.width = "100%";

  var f8 = panelForm(fs);
  forecastBoxForRecord(f8, rec, changed);

  /* The copy falls due after finishing, so this one field stays open on a finished
     record. Handing over a copy doesn't change the record, so it isn't an amendment. */
  if(final && rec.reef.applies === true && pres.length){
    var fc = panelForm(sec);
    fld(fc, "Copy given to the customer on", input(rec.reef, "copyGiven", {type: "date", on: function(){ put("records", rec); }}), "Due by " + fmtDate(reefCopyDue(rec)) + ".");
  }

  /* what can be done with it */
  var acts = add(sec, "div");
  acts.style.cssText = "display:flex;flex-direction:column;gap:10px";
  if(!final){
    btn(acts, "Finish this record", "", function(){
      save.flush();
      var missing = missingFor(rec);
      if(missing.length){
        showMissing.textContent = "";
        add(showMissing, "b", null, "Still needed:");
        var u = add(showMissing, "ul");
        missing.forEach(function(x){ add(u, "li", null, x); });
        showMissing.hidden = false;
        showMissing.scrollIntoView({block: "center"});
        return;
      }
      var was = {finishedAt: rec.finishedAt, amendedAt: rec.amendedAt, snap: rec.snap};
      var stamp = nowStamp();
      rec.status = "final";
      /* the finish date stays the first one: it's what shows the record was made on time */
      if(rec.finishedAt) rec.amendedAt = stamp; else rec.finishedAt = stamp;
      /* frozen now, so sharing this PDF years later still shows what was held on the day */
      if(!rec.snap) rec.snap = {business: clone(cfg().business || {}), licences: licenceList(rec)};
      put("records", rec).then(function(){
        var j = byId("jobs", rec.jobId);
        if(j){ j.status = "done"; put("jobs", j); }
        toast("Record finished");
        rerender();
      }, function(){
        /* it didn't save, so it mustn't look finished */
        rec.status = "draft";
        rec.finishedAt = was.finishedAt;
        rec.amendedAt = was.amendedAt;
        rec.snap = was.snap;
        rerender();
      });
    });
    var showMissing = add(acts, "div", "note stop");
    showMissing.hidden = true;
    showMissing.setAttribute("role", "alert");
  }
  var withLic = {v: cfg().pdfLicences !== false};
  checkbox(acts, withLic, "v", "Put my licences on the PDF", function(){
    cfg().pdfLicences = withLic.v;
    saveCfg();
  });
  btn(acts, final ? "Share as PDF" : "Share a draft PDF", final ? "" : "ghost", function(){
    save.flush();
    recordPdf(rec).then(function(blob){
      return shareFile(blob, "STEL-Spray-Record-" + rec.date + "-" + safeName(rec.owner.name) + ".pdf", "Spray record");
    }).catch(function(e){ toast("The PDF didn't build. " + e.message); });
  });
  if(final){
    btn(acts, "Amend this record", "ghost", function(){
      if(!confirm("Amend this record? The current version is kept with it.")) return;
      var snap = clone(rec);
      delete snap.history;
      rec.history = (rec.history || []).concat([{at: nowStamp(), snapshot: snap}]);
      rec.status = "draft";
      put("records", rec).then(rerender);
    });
    if(daysFromToday(keepUntil(rec)) < 0){
      btn(acts, "Delete", "danger", function(){
        if(!confirm("The time to keep this has passed. Delete it for good?")) return;
        save.cancel();
        leave = null;
        hideHook = null;
        del("records", rec.id).then(back);
      });
    }
  } else if((rec.history || []).length){
    btn(acts, "Cancel this amendment", "danger", function(){
      if(!confirm("Put back the finished version and lose the changes since?")) return;
      save.cancel();
      var hist = rec.history.slice(0, -1), last = clone(rec.history[rec.history.length - 1].snapshot);
      Object.keys(rec).forEach(function(k){ delete rec[k]; });
      Object.assign(rec, last);
      rec.history = hist;
      leave = null;
      hideHook = null;
      put("records", rec).then(rerender);
    });
  } else {
    btn(acts, "Delete this draft", "danger", function(){
      if(!confirm("Delete this draft?")) return;
      save.cancel();
      leave = null;
      hideHook = null;
      del("records", rec.id).then(back);
    });
  }
}

function weatherRow(p, rec, w, i, changed){
  var box = add(p, "div", "wx");
  var head = add(box, "div", "wx-head");
  add(head, "div", "item-name", weatherName(w));
  var dtOut = add(box, "div", "dt");
  function drawDt(){
    dtOut.textContent = "";
    var d = deltaT(num(w.temp), num(w.rh));
    if(d == null) return;
    var band = deltaTBand(d);
    add(dtOut, "b", null, "Delta T " + fmtN(d, 1));
    add(dtOut, "span", "tag " + band.k, band.t);
  }
  function on(){ changed(); drawDt(); }
  var timeBox = input(w, "time", {type: "time", on: on});
  var r0 = add(box, "div", "two");
  fld(r0, "Time", timeBox);
  var now = add(r0, "div", "f edit-only");
  add(now, "span", "f-l", " ");
  btn(now, "Now", "ghost small", function(){ w.time = nowTime(); timeBox.value = w.time; on(); });
  var r1 = add(box, "div", "two");
  fld(r1, "Temp, °C", input(w, "temp", {num: true, on: on}));
  fld(r1, "Humidity, %", input(w, "rh", {num: true, on: on}));
  var r2 = add(box, "div", "two");
  fld(r2, "Wind, km/h", input(w, "wind", {num: true, on: on}));
  fld(r2, "Wind from", select(w, "dir", [["","Pick"]].concat(COMPASS.map(function(c){ return [c, c]; })), {on: on}));
  var r3 = add(box, "div", "two");
  fld(r3, "Cloud cover", input(w, "cloud", {ph: "e.g. 2/8 or clear", on: on}));
  fld(r3, "Rain, mm", input(w, "rain", {num: true, ph: "0 if none", on: on}));
  box.appendChild(dtOut);
  drawDt();
  if(w.stage === "Change"){
    var x = add(head, "button", "x edit-only", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Remove this reading");
    x.addEventListener("click", function(){ rec.weather.splice(i, 1); changed(); rerender(); });
  }
}

function forecastBoxForRecord(p, rec, changed){
  if(rec.forecast){
    add(p, "div", "hint", "Kept with this record, marked as forecast. " + forecastLine(rec.forecast) + " From MET Norway, not measured on site.");
  } else if(rec.status === "final"){
    add(p, "div", "hint", "No forecast was kept with this record.");
  }
  if(rec.status === "final") return;
  forecastBox(p, function(){
    var r = rec.rings.filter(function(x){ return x.centre; })[0];
    return r ? Promise.resolve(r.centre) : gpsPoint();
  }, function(f){
    rec.forecast = f;
    changed();
    rerender();
  });
}

/* ─────────── spreadsheet ─────────── */
function csvCell(v){
  if(v && v.csvText != null) return '"=""' + String(v.csvText).replace(/"/g, '""""') + '"""';
  var s = v == null ? "" : String(v);
  /* a name starting with = or + would run as a formula once it opens in Excel */
  if(/^\s*[=+@-]/.test(s) && isNaN(Number(s))) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/* Excel reads a bare 0412345678 as a number and drops the leading zero */
function csvPhone(v){
  var s = String(v == null ? "" : v).trim();
  return s && /^[\d\s()+-]+$/.test(s) ? {csvText: s} : s;
}
function weatherLine(w){
  var d = deltaT(num(w.temp), num(w.rh));
  return (w.date ? fmtDate(w.date) + " " : "") + w.time + " " + w.temp + "C " + w.rh + "% wind " + w.wind + "km/h " + w.dir + " cloud " + w.cloud + " rain " + w.rain + "mm" +
    (d == null ? "" : " dT " + fmtN(d, 1));
}
function recordsCsv(list){
  var head = ["Date applied","Last day","Start","Finish","Spray sessions","Status","Finished","Amended","Landowner or occupier","Property","Landowner address","Landowner phone",
    "Pilot in command","Pilot address","Pilot phone","Qualifications","Organiser or supervisor","Lot and plan","Paddocks","GPS","Area ha",
    "Aircraft","Registration mark","Method","Nozzle","Product","APVMA number","Label number","Manufacturer","Active constituents",
    "Rate","Unit","Total used","Additive","Spray volume L/ha","Total spray L","Diluent","Diluent L","Crop or situation","Purpose",
    "Weather before","Weather during","Weather after","Weather changes","Forecast, not measured","Label notes","Notes",
    "Reef rules apply","Purchase record","Qualifications copy kept","Copy given to customer","Keep until"];
  var rows = [head];
  list.forEach(function(r){
    var mix = calcMix({ha: r.area, waterRate: r.waterRate, items: r.items, noTank: true});
    function wx(st){ return r.weather.filter(function(w){ return w.stage === st; }).map(weatherLine).join(" | "); }
    var reefOn = prescribedIn(r.items).length && r.reef.applies != null;
    (r.items.length ? r.items : [{}]).forEach(function(it, i){
      var auto = mix.ok && mix.items[i] ? fmtAmount(mix.items[i].total, mix.items[i].dry) : "";
      rows.push([
        r.date, r.endDate, r.startTime, r.endTime, sessionsText(r), r.status, r.finishedAt, r.amendedAt, r.owner.name, r.owner.property, r.owner.address, csvPhone(r.owner.phone),
        r.applicator.name, r.applicator.address, csvPhone(r.applicator.phone), r.applicator.quals,
        [r.supervisor.name, r.supervisor.address, r.supervisor.phone, r.supervisor.quals].filter(Boolean).join(", "),
        r.lots, r.paddockNames, r.gps, r.area, r.aircraft, r.rego, r.method, r.nozzle,
        it.name, it.apvma, it.labelNo, it.maker, activesText(it), it.rate, it.unit, usedText(it, auto), it.additive ? "Yes" : "",
        r.waterRate, mix.ok ? Math.round(mix.total * 100) / 100 : "", r.diluent || "Water", mix.ok ? Math.round(mix.diluent * 100) / 100 : "",
        r.situation, r.purpose,
        wx("Before"), wx("During"), wx("After"), wx("Change"), r.forecast ? forecastLine(r.forecast) : "", r.labelNotes, r.notes,
        reefOn ? (r.reef.applies ? "Yes" : "No") : "", reefOn ? r.reef.receipt : "", reefOn && r.reef.qualsCopy ? "Yes" : "", reefOn ? r.reef.copyGiven : "", keepUntil(r)
      ]);
    });
  });
  return rows.map(function(c){ return c.map(csvCell).join(","); }).join("\r\n");
}

/* ─────────── PDF ─────────── */
function pdfSafe(s){
  return String(s == null ? "" : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}
/* This record's pilot and the business, not every person in Setup */
function licenceList(rec){
  var pilot = String(rec.applicator.name || "").trim().toLowerCase();
  var biz = String((cfg().business || {}).name || "").trim().toLowerCase();
  return S.licences.filter(function(l){
    var h = String(l.holder || "").trim().toLowerCase();
    return !h || h === pilot || h === biz;
  }).map(function(l){ return {kind: l.kind, number: l.number, holder: l.holder, expiry: l.expiry}; });
}
function recordPdf(rec){
  return loadScript("./vendor/jspdf.umd.min.js").then(function(){
    var doc = new window.jspdf.jsPDF({unit: "mm", format: "a4"});
    var frozen = rec.snap || {};
    var W = 210, M = 14, BOTTOM = 282, y = M, biz = frozen.business || cfg().business || {};
    function need(h){ if(y + h > BOTTOM){ doc.addPage(); y = M; } }
    function heading(t, keep){
      need(12 + (keep || 0));   /* keep: room for what must stay on the page under this heading */
      y += 3;
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(84, 120, 26);
      doc.text(pdfSafe(t.toUpperCase()), M, y);
      y += 1.4;
      doc.setDrawColor(185, 192, 172); doc.line(M, y, W - M, y);
      y += 4.4;
      doc.setTextColor(26, 30, 23);
    }
    function kv(k, v){
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      var keys = doc.splitTextToSize(pdfSafe(k), 47);
      doc.setFont("helvetica", "normal");
      var lines = doc.splitTextToSize(pdfSafe(v) || "-", W - M * 2 - 50);
      var rows = Math.max(keys.length, lines.length);
      /* short blocks stay whole, and anything longer than a page runs on across pages */
      if(rows * 4 + 1 <= BOTTOM - M) need(rows * 4 + 1);
      for(var i = 0; i < rows; i++){
        need(4);
        if(keys[i]){ doc.setFont("helvetica", "bold"); doc.text(keys[i], M, y); }
        if(lines[i]){ doc.setFont("helvetica", "normal"); doc.text(lines[i], M + 50, y); }
        y += 4;
      }
      y += .9;
    }
    function para(t){
      doc.setFontSize(9); doc.setFont("helvetica", "normal");
      var lines = doc.splitTextToSize(pdfSafe(t), W - M * 2);
      if(lines.length * 4 + 1 <= BOTTOM - M) need(lines.length * 4 + 1);
      lines.forEach(function(line){
        need(4);
        doc.text(line, M, y);
        y += 4;
      });
      y += 1;
    }
    function table(cols, rows){
      var titles = cols.map(function(c){ return c.t; });
      function row(cells, bold, isHead){
        doc.setFontSize(8); doc.setFont("helvetica", bold ? "bold" : "normal");
        var wrapped = cells.map(function(c, i){ return doc.splitTextToSize(pdfSafe(c) || "-", cols[i].w - 2); });
        var h = Math.max.apply(null, wrapped.map(function(w){ return w.length; })) * 3.4 + 1.8;
        if(y + h > BOTTOM){
          doc.addPage(); y = M;
          if(!isHead) row(titles, true, true);   /* a table that runs over keeps its column names */
          doc.setFontSize(8); doc.setFont("helvetica", bold ? "bold" : "normal");
        }
        var x = M;
        wrapped.forEach(function(w, i){ doc.text(w, x + .5, y + 2.8); x += cols[i].w; });
        y += h;
        doc.setDrawColor(211, 216, 200); doc.line(M, y, W - M, y);
      }
      row(titles, true, true);
      rows.forEach(function(r){ row(r, false, false); });
      y += 3;
    }
    function mapOutline(rings){
      var drawn = rings.filter(function(r){ return r.ring && r.ring.length >= 3; });
      if(!drawn.length) return;
      var all = []; drawn.forEach(function(r){ all = all.concat(r.ring); });
      var c = ringCentre(all), k = metresPerDegree(c[0]);
      function xy(p){ return [(p[1] - c[1]) * k.x, (p[0] - c[0]) * k.y]; }
      var pts = all.map(xy), xs = pts.map(function(p){ return p[0]; }), ys = pts.map(function(p){ return p[1]; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      var boxW = W - M * 2, boxH = 62, s = Math.min(boxW / ((maxX - minX) || 1), boxH / ((maxY - minY) || 1));
      need(boxH + 6);
      var ox = M + (boxW - (maxX - minX) * s) / 2, oy = y + boxH;
      function toPage(p){ var q = xy(p); return [ox + (q[0] - minX) * s, oy - (q[1] - minY) * s]; }
      doc.setDrawColor(84, 120, 26); doc.setLineWidth(.5);
      drawn.forEach(function(r){
        r.ring.forEach(function(p, i){
          var a = toPage(p), b = toPage(r.ring[(i + 1) % r.ring.length]);
          doc.line(a[0], a[1], b[0], b[1]);
        });
        var m = toPage(ringCentre(r.ring));
        doc.setFontSize(8); doc.setFont("helvetica", "bold");
        doc.text(pdfSafe(r.name), m[0], m[1], {align: "center"});
      });
      doc.setLineWidth(.2);
      doc.setFontSize(8); doc.setFont("helvetica", "normal");
      doc.text("N", W - M - 2, y + 4);
      doc.line(W - M - 1, y + 5, W - M - 1, y + 11);
      y += boxH + 5;
    }

    /* the heading */
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(26, 30, 23);
    doc.text("Agricultural chemical application record", M, y + 2);
    y += 8;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    var who = [biz.name, biz.abn ? "ABN " + biz.abn : "", biz.phone, biz.email].filter(Boolean).join("  |  ");
    if(who){ doc.text(pdfSafe(who), M, y); y += 4.4; }
    if(biz.address){ doc.text(pdfSafe(biz.address.replace(/\s*\n\s*/g, ", ")), M, y); y += 4.4; }
    if(rec.status !== "final"){
      doc.setFont("helvetica", "bold"); doc.setTextColor(163, 38, 27);
      doc.text("DRAFT: not finished", M, y); y += 4.4;
      doc.setTextColor(26, 30, 23); doc.setFont("helvetica", "normal");
    } else {
      doc.text(pdfSafe("Finished " + fmtDate(rec.finishedAt) + (rec.amendedAt ? ". Amended " + fmtDate(rec.amendedAt) + ", earlier versions kept." : ".") +
        " Keep until " + fmtDate(keepUntil(rec)) + "."), M, y);
      y += 4.4;
    }

    heading("The job");
    var times = [rec.startTime ? "from " + rec.startTime : "", rec.endTime ? "to " + rec.endTime : ""].filter(Boolean).join(" ");
    kv("Date applied", fmtDate(rec.date) + (rec.endDate ? " to " + fmtDate(rec.endDate) : "") + (times ? ", " + times : ""));
    if((rec.sessions || []).length > 1) kv("Spray sessions", sessionsText(rec));
    kv("Crop or situation", rec.situation);
    kv("Purpose", rec.purpose);

    heading("People");
    kv("Landowner or occupier", [rec.owner.name, rec.owner.property].filter(Boolean).join(", "));
    kv("Contact", [(rec.owner.address || "").replace(/\s*\n\s*/g, ", "), rec.owner.phone].filter(Boolean).join(", "));
    kv("Pilot in command", rec.applicator.name);
    kv("Contact", [(rec.applicator.address || "").replace(/\s*\n\s*/g, ", "), rec.applicator.phone].filter(Boolean).join(", "));
    kv("Qualifications", rec.applicator.quals);
    var sup = rec.supervisor;
    if(sup.name || sup.address || sup.phone || sup.quals){
      kv("Organiser or supervisor", sup.name);
      kv("Their contact", [sup.address, sup.phone].filter(Boolean).join(", "));
      kv("Their qualifications", sup.quals);
    }

    heading("Treated land");
    kv("Lot and plan", rec.lots);
    kv("Paddocks", rec.paddockNames);
    kv("GPS", rec.gps);
    kv("Total area covered", rec.area ? areaLine(rec) : "");
    mapOutline(rec.rings || []);

    heading("Aircraft and method");
    kv("Aircraft", rec.aircraft);
    kv("Registration mark", rec.rego);
    kv("Method", rec.method);
    kv("Nozzle type", rec.nozzle);

    heading("Products", 24);
    var mix = calcMix({ha: rec.area, waterRate: rec.waterRate, items: rec.items, noTank: true});
    table([
      {t: "Trade name", w: 40}, {t: "APVMA no.", w: 16}, {t: "Label no.", w: 18}, {t: "Manufacturer", w: 30},
      {t: "Active constituents", w: 40}, {t: "Rate", w: 18}, {t: "Total used", w: 20}
    ], rec.items.map(function(it, i){
      var auto = mix.ok && mix.items[i] ? fmtAmount(mix.items[i].total, mix.items[i].dry) : "";
      return [it.name + (it.additive ? " (additive)" : ""), it.apvma, it.labelNo, it.maker, activesText(it), (it.rate || "") + " " + (it.unit || ""), usedText(it, auto)];
    }));
    kv("Diluent", (rec.diluent || "Water") + (mix.ok ? ", " + fmtAmount(mix.diluent * 1000, false) : ""));
    kv("Spray volume", (rec.waterRate ? rec.waterRate + " L/ha" : "") + (mix.ok ? ", " + fmtN(mix.total, 2) + " L total spray" : ""));

    heading("Weather on site", 24);
    table([
      {t: "Reading", w: 22}, {t: "Time", w: 14}, {t: "Temp C", w: 15}, {t: "RH %", w: 13}, {t: "Wind km/h", w: 18},
      {t: "From", w: 14}, {t: "Cloud", w: 28}, {t: "Rain mm", w: 16}, {t: "Delta T", w: 42}
    ], rec.weather.map(function(w){
      var d = deltaT(num(w.temp), num(w.rh));
      return [weatherName(w), w.time, w.temp, w.rh, w.wind, w.dir, w.cloud, w.rain, d == null ? "" : fmtN(d, 1)];
    }));
    if(rec.forecast) para("Forecast, not measured on site (MET Norway, CC BY 4.0). " + forecastLine(rec.forecast));

    if(rec.labelNotes){
      heading("Label or permit details");
      para(rec.labelNotes);
    }
    if(rec.notes){
      heading("Notes");
      para(rec.notes);
    }
    if(prescribedIn(rec.items).length){
      heading("Reef rules");
      kv("Prescribed actives", prescribedIn(rec.items).join(", "));
      kv("Rules apply", rec.reef.applies == null ? "Not answered" : (rec.reef.applies ? "Yes" : "No"));
      if(rec.reef.applies){
        kv("Purchase record", rec.reef.receipt);
        kv("Qualifications copy", rec.reef.qualsCopy ? "Kept with this record" : "Not yet");
        kv("Copy given to customer", rec.reef.copyGiven ? fmtDate(rec.reef.copyGiven) :
          (reefCopyDue(rec) ? "Not yet, due by " + fmtDate(reefCopyDue(rec)) : "Not yet, due within 5 days of finishing"));
      }
    }
    var held = frozen.licences || licenceList(rec);
    if(cfg().pdfLicences !== false && held.length){
      heading("Licences held");
      held.forEach(function(l){
        kv(l.kind, [l.number, l.holder, l.expiry ? "to " + fmtDate(l.expiry) : ""].filter(Boolean).join(", "));
      });
    }

    var pages = doc.getNumberOfPages();
    for(var i = 1; i <= pages; i++){
      doc.setPage(i);
      doc.setFontSize(7.5); doc.setFont("helvetica", "normal"); doc.setTextColor(116, 124, 107);
      doc.text("Page " + i + " of " + pages, W - M, 291, {align: "right"});
    }
    return doc.output("blob");
  });
}
var LICENCE_KINDS = ["CASA ReOC","Aviation Reference Number (ARN)","Remote Pilot Licence (RePL)","Aerial Distribution Contractor Licence","Pilot Chemical Rating Licence","Public liability insurance","Other"];

function shrinkPhoto(file){
  return new Promise(function(res, rej){
    var img = new Image();
    img.onload = function(){
      var k = Math.min(1, 1600 / Math.max(img.width, img.height));
      var c = el("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL("image/jpeg", .72));
    };
    img.onerror = function(){ rej(new Error("That photo couldn't be read.")); };
    img.src = URL.createObjectURL(file);
  });
}
function personView(p){
  editView({
    title: "Person", store: "people", item: p,
    keep: function(d){ return stillUsed("This person", openJobsUsing(function(j){ return j.pilotId === d.id; })); },
    valid: function(d){ return !!(d.name || "").trim(); }, invalid: "Enter a name first.",
    build: function(f, d){
      fld(f, "Name", input(d, "name"));
      fld(f, "Address", input(d, "address", {area: true}));
      fld(f, "Phone", input(d, "phone", {type: "tel"}));
      fld(f, "Qualifications", input(d, "quals", {area: true, ph: "Licence types and numbers"}), "This fills in on every spray record.");
    }
  });
}
function droneView(p){
  editView({
    title: "Drone", store: "drones", item: p,
    keep: function(d){ return stillUsed("This drone", openJobsUsing(function(j){ return j.droneId === d.id; })); },
    valid: function(d){ return !!(d.name || "").trim(); }, invalid: "Enter a name first.",
    build: function(f, d){
      fld(f, "Name", input(d, "name", {ph: "e.g. Agras"}));
      fld(f, "Registration mark", input(d, "rego"));
      fld(f, "Tank size, L", input(d, "tank", {num: true}));
      fld(f, "Nozzle type", input(d, "nozzle"));
    }
  });
}
function licenceView(l){
  editView({
    title: "Licence", store: "licences", item: l,
    valid: function(d){ return !!(d.kind || "").trim(); }, invalid: "Pick the type first.",
    build: function(f, d){
      fld(f, "Type", select(d, "kind", LICENCE_KINDS.map(function(k){ return [k, k]; })));
      fld(f, "Number", input(d, "number"));
      fld(f, "Holder", input(d, "holder"));
      fld(f, "Runs to", input(d, "expiry", {type: "date"}), "The app warns you 30 days before.");
      var pick = add(f, "input", "filepick");
      pick.type = "file";
      pick.accept = "image/*";
      pick.setAttribute("aria-label", "Choose a photo of this licence");
      var holder = add(f, "div");
      function draw(){
        holder.textContent = "";
        if(d.photo){
          var img = add(holder, "img", "thumb");
          img.src = d.photo;
          img.alt = "Photo of this licence";
        }
      }
      pick.addEventListener("change", function(){
        if(!pick.files[0]) return;
        shrinkPhoto(pick.files[0]).then(function(url){
          d.photo = url;
          if(holder.isConnected){ draw(); return; }
          /* the form closed while this was shrinking, so it goes straight to the saved licence */
          var stored = byId("licences", d.id);
          if(stored){ stored.photo = url; put("licences", stored); }
        }, function(e){ toast(e.message); });
      });
      btn(f, d.photo ? "Replace the photo" : "Add a photo", "ghost small", function(){ pick.click(); });
      draw();
    }
  });
}

/* ─────────── saving: every keystroke lands twice ───────────
   A small journal in localStorage, written before the handler returns, and the real
   record in IndexedDB. The journal entry goes once IndexedDB has the record. Chrome
   writes localStorage to disk lazily, so what must survive a dead phone (the records,
   the mix, the last screen) always goes to IndexedDB as well. */
function nextStamp(){ stampLast = Math.max(Date.now(), stampLast + 1); return stampLast; }
function journalKey(store, id){ return JOURNAL + store + ":" + id; }
function journal(store, obj){
  try {
    var t = JSON.stringify(obj);
    if(t.length < 200000) localStorage.setItem(journalKey(store, obj.id), t);   /* licence photos are too big, and IndexedDB has them */
  } catch(e){}
}
function unjournal(store, obj, at){
  if(obj.updatedAt === at){ try { localStorage.removeItem(journalKey(store, obj.id)); } catch(e){} }
}
function journalKeys(){
  var out = [];
  try { for(var i = 0; i < localStorage.length; i++){ var k = localStorage.key(i); if(k && k.indexOf(JOURNAL) === 0) out.push(k); } } catch(e){}
  return out;
}
function replayJournal(){
  journalKeys().forEach(function(k){
    var store = k.slice(JOURNAL.length).split(":")[0], rec = null;
    try { rec = JSON.parse(localStorage.getItem(k)); } catch(e){ return; }
    if(!rec || !S[store]) return;
    var have = byId(store, rec.id);
    if(!have || (rec.updatedAt || 0) > (have.updatedAt || 0)) put(store, rec).catch(function(){});
    else { try { localStorage.removeItem(k); } catch(e){} }
  });
}
function clearJournal(){ journalKeys().forEach(function(k){ try { localStorage.removeItem(k); } catch(e){} }); }

/* ─────────── coming back to the screen you left ─────────── */
function setRoute(r){
  r.id = "route";
  r.tab = curTab;
  r.at = Date.now();
  lsSet(LS_ROUTE, JSON.stringify(r));
  var i = S.settings.map(function(x){ return x.id; }).indexOf("route");
  if(i >= 0) S.settings[i] = r; else S.settings.push(r);
  if(db){ try { db.transaction("settings", "readwrite").objectStore("settings").put(r); } catch(e){} }
}
function markRoute(r){ stack[stack.length - 1].route = r; setRoute(r); }
function readRoute(){
  var a = byId("settings", "route"), b = lsJson(LS_ROUTE), r = a;
  if(b && (!a || b.at > a.at)) r = b;
  return r && Date.now() - r.at < 12 * 3600 * 1000 ? r : null;
}
function openRoute(r){
  if(r.k === "edit"){
    var open = {jobs: jobView, clients: clientView, paddocks: paddockView, people: personView, drones: droneView, licences: licenceView}[r.store];
    var kept = getStash(r.rid);
    var item = byId(r.store, r.rid) || (kept ? kept.draft : null);
    if(open && item) open(item);
  } else if(r.k === "record"){
    var rec = byId("records", r.rid);
    if(rec) recordView(rec);
  } else if(r.k === "quote"){
    var q = byId("quotes", r.rid);
    if(q) quoteView(q);
  } else if(r.k === "sheet"){
    var qs = byId("quotes", r.rid);
    if(qs) quoteSheet(qs);
  }
}

/* ─────────── folding: long forms stay short until you need them ─────────── */
function fold(parent, title, open){
  var d = add(parent, "details", "fold");
  if(open) d.open = true;
  add(d, "summary", null, title);
  return d;
}
function foldForm(parent, title, open){ return add(add(fold(parent, title, open), "div", "panel"), "div", "form"); }
function unitPick(form, label, obj, key, opts, on){
  add(form, "span", "f-l", label);
  chipRow(form, opts, obj[key], function(v){ obj[key] = v; on(); });
}

/* ─────────── the sums for records, PDFs and spreadsheets, off the exact engine ─────────── */
function cleanNum(v){
  var s = String(v == null ? "" : v).trim();
  return isNaN(num(s)) ? s : s.replace(/,/g, "");
}
function calcMix(m){
  var res = C.mixMany({
    area: cleanNum(m.ha), areaUnit: "ha", sprayMode: "rate", sprayRate: cleanNum(m.waterRate), sprayRateUnit: "L/ha",
    tank: cleanNum(m.tank), noTank: !!m.noTank,
    products: (m.items || []).map(function(it){ return {name: it.name, rate: cleanNum(it.rate), unit: it.unit}; })
  });
  if(res.errors.length) return {ok: false, errors: res.errors.map(function(e){ return e.msg; })};
  if(res.stop) return {ok: false, errors: [res.stop + " Check the rates and the spray volume."]};
  var x = res.mix;
  function n(r, k){ return r == null ? null : Number(C.rounded(k ? C.mul(r, C.R(k)) : r, 9).text); }
  return {
    ok: true, ha: n(x.areaHa), water: n(x.lPerHa), tank: n(x.tank), total: n(x.totalSpray),
    full: x.fullTanks == null ? null : Number(x.fullTanks), part: n(x.partLoad), haPerTank: n(x.areaPerTank),
    share: n(x.share), diluent: n(x.waterTotal), waterPerFull: n(x.waterPerTank), waterPerPart: n(x.waterPart),
    items: x.products.map(function(p){
      return {name: p.name, dry: p.mass, total: n(p.total, 1000), perFull: n(p.perTank, 1000), perPart: n(p.perPart, 1000)};
    })
  };
}

/* ═════════════ MIX ═════════════ */
var MIX = null;
function blankMixState(){
  /* area is always hectares and spray always L/ha, and the tank starts on the 450 L
     mixing tank. A product's unit starts empty: it comes off the label every time. */
  return {id: "mix", area: "", areaUnit: "ha", sprayMode: "rate", waterRate: "", sprayRateUnit: "L/ha", sprayTotal: "", tank: "450",
    droneId: "", paddockId: "", items: [], jobLabel: "", jobId: "", recipeId: "", mixed: 0, mixedSig: ""};
}
/* A mix kept from when this screen also took acres, m² or L/1000 m² comes across as the same
   area and rate in hectares and L/ha, so it can't be reread as hectares and its sums don't move. */
function hectaresOnly(m){
  var a = C.parse(m.area), au = C.AREA_UNITS[m.areaUnit];
  if(m.areaUnit !== "ha" && a && au) m.area = C.unrounded(C.mul(a, au.toHa), 40);
  m.areaUnit = "ha";
  var key = C.unitKey(m.sprayRateUnit), v = C.parse(m.waterRate), su = C.SPRAY_RATE_UNITS[key];
  if(key !== "L/ha" && v && su) m.waterRate = C.unrounded(C.mul(v, su.toLha), 40);
  m.sprayRateUnit = "L/ha";
}
function mixState(){
  if(!MIX) MIX = Object.assign(blankMixState(), byId("settings", "mix") || {});
  hectaresOnly(MIX);
  return MIX;
}
function mixInput(m){
  return {area: m.area, areaUnit: m.areaUnit, sprayMode: m.sprayMode, sprayRate: m.waterRate, sprayRateUnit: m.sprayRateUnit,
    sprayTotal: m.sprayTotal, tank: m.tank,
    products: (m.items || []).map(function(it){ return {name: it.name, rate: it.rate, unit: it.unit}; })};
}
/* L/ha as a plain number, whichever way the spray was entered */
function mixWater(src){
  if(src.id !== "mix") return src.waterRate || "";
  var lha = null;
  if(src.sprayMode === "total"){
    var total = C.parse(src.sprayTotal), a = C.parse(src.area), u = C.AREA_UNITS[src.areaUnit];
    if(total && a && a.n > 0n && u) lha = C.div(total, C.mul(a, u.toHa));
  } else {
    var v = C.parse(src.waterRate), su = C.SPRAY_RATE_UNITS[C.unitKey(src.sprayRateUnit)];
    if(v && su) lha = C.mul(v, su.toLha);
  }
  return lha ? C.rounded(lha, 6).text : "";
}
var lastMixSaved = null;
function mixSave(){
  var m = MIX, now = JSON.stringify(Object.assign({}, m, {updatedAt: 0}));
  if(now === lastMixSaved) return;
  lastMixSaved = now;
  put("settings", m).catch(function(){});
  /* the job keeps its own copy, so working out another job's mix can't lose this one */
  var j = m.jobId ? byId("jobs", m.jobId) : null;
  if(!j) return;
  var next = {mixItems: clone(m.items), mixWater: mixWater(m), mixWaterTyped: m.waterRate, mixSprayUnit: m.sprayRateUnit, mixSprayMode: m.sprayMode,
    mixSprayTotal: m.sprayTotal, mixArea: m.area, mixAreaUnit: m.areaUnit, mixTank: m.tank, mixed: m.mixed, mixedSig: m.mixedSig, mixRecipeId: m.recipeId || ""};
  var changed = Object.keys(next).some(function(k){ return JSON.stringify(j[k]) !== JSON.stringify(next[k]); });
  if(changed){ Object.assign(j, next); put("jobs", j).catch(function(){}); }
}
/* The area the job's mix was last worked out on, in hectares */
function jobMixHa(j){
  var a = C.parse(j.mixArea), u = C.AREA_UNITS[j.mixAreaUnit || "ha"];
  return a && u && a.n > 0n ? C.unrounded(C.mul(a, u.toHa), 40) : "";
}
function openMixFor(j){
  var m = mixState(), rec = byId("recipes", j.recipeId), ha = jobHa(j), same = m.jobId === j.id;
  if(!same){
    /* the same job comes back exactly as it was left. Nothing it was typed in gets reread as hectares */
    m.area = j.mixArea ? j.mixArea : (ha ? roundHa(ha) : "");
    m.areaUnit = j.mixArea ? (j.mixAreaUnit || "ha") : "ha";
    m.sprayMode = j.mixSprayMode || "rate";
    m.sprayRateUnit = j.mixSprayUnit || "L/ha";
    m.waterRate = j.mixWaterTyped != null ? j.mixWaterTyped : (j.mixWater || "");
    m.sprayTotal = j.mixSprayTotal || "";
    m.items = j.mixItems && j.mixItems.length ? clone(j.mixItems) : [];
    if(j.mixTank) m.tank = j.mixTank;
    m.mixed = j.mixed || 0;
    m.mixedSig = j.mixedSig || "";
    hectaresOnly(m);
  }
  /* a saved mix picked on the job since its last mix, or a first go with one */
  if(rec && (j.recipeId !== (j.mixRecipeId || "") || !m.items.length)){
    m.sprayMode = "rate";
    m.sprayRateUnit = "L/ha";
    m.waterRate = rec.waterRate;
    m.sprayTotal = "";
    m.items = clone(rec.items);
    m.mixed = 0;
    m.mixedSig = "";
  }
  m.paddockId = "";
  m.recipeId = j.recipeId || "";
  m.jobId = j.id;
  m.jobLabel = clientName(j.clientId) || j.clientName || "this job";
  mixSave();
  setTab("mix");
}

function mxRow(k, v, also, fx, id){
  return '<div class="row"' + (id ? ' data-out="' + id + '"' : "") + '><div class="k">' + escH(k) + '</div><div class="v">' + escH(v) + "</div>" +
    (also ? '<div class="also">' + escH(also) + "</div>" : "") + (fx ? '<div class="fx">' + escH(fx) + "</div>" : "") + "</div>";
}
function escH(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]; });
}
function mixResultHtml(res, m){
  if(res.stop){
    return '<div class="note stop big-stop" data-out="stop"><b>' + escH(res.stop) + "</b>" +
      (res.hint ? '<p data-out="hint">' + escH(res.hint) + "</p>" : "") + "<p>No tank figures until this is fixed.</p></div>";
  }
  if(!res.mix){
    var bad = res.errors.filter(function(e){ return !e.blank; }), blanks = res.errors.filter(function(e){ return e.blank; });
    return (bad.length ? '<div class="note stop">' + bad.map(function(e){ return escH(e.msg); }).join("<br>") + "</div>" : "") +
      (blanks.length ? '<div class="note" data-out="needs"><b>Still needed:</b><br>' + blanks.map(function(e){ return escH(e.msg); }).join("<br>") + "</div>" : "");
  }
  var x = res.mix, thou = C.R(1000);
  function L(v){ return C.show(v, 3) + " L"; }
  function W(v){ return C.show(v, 3, 1) + " L"; }
  function fx(v){ return C.show(v, 6); }
  function P(p, v){ return C.show(v, 3, 1) + " " + p.unit; }
  function also(p, v){ return C.show(C.mul(v, thou), 3) + " " + p.smallUnit + ". Unrounded: " + C.unrounded(v) + " " + p.unit + "."; }
  function prodFx(p, load, areaOf){
    return p.concBased ? fx(load) + " L × " + fx(p.per100) + " " + p.unit + "/100 L ÷ 100"
      : fx(areaOf) + " ha × " + fx(p.perHa) + " " + p.unit + "/ha";
  }
  var names = x.products.length > 1;
  function pName(p, i, what){ return (p.name || (names ? "Product " + (i + 1) : "Product")) + what; }
  var anyDry = x.products.some(function(p){ return p.mass; });
  var liquids = x.products.filter(function(p){ return !p.mass; });
  function waterFx(load, key){
    return liquids.length ? fx(load) + " L − " + liquids.map(function(p){ return fx(p[key]) + " L"; }).join(" − ") : "Whole load: dry product is taken as adding no volume.";
  }
  var full = x.fullTanks.toString(), hasFull = x.fullTanks > 0n, hasPart = x.partLoad.n !== 0n;
  var html = res.warnings.map(function(w){ return '<div class="note stop" data-out="warn"><b>' + escH(w) + "</b></div>"; }).join("");

  html += '<div class="tank-card"><h3>Tank loads</h3>' +
    mxRow("Full tanks", full + " × " + fx(x.tank) + " L", hasPart ? "Plus a part load of " + L(x.partLoad) + "." : "No part load.", fx(x.totalSpray) + " L ÷ " + fx(x.tank) + " L, whole tanks only", "full") +
    tickHtml(x, m) + "</div>";

  if(hasFull){
    html += '<div class="tank-card"><h3>In each full tank</h3>' +
      x.products.map(function(p, i){ return mxRow(pName(p, i, " per full tank"), P(p, p.perTank), also(p, p.perTank), prodFx(p, x.tank, x.areaPerTank), "pTank" + i); }).join("") +
      mxRow("Water per tank", W(x.waterPerTank), "", waterFx(x.tank, "perTank"), "wTank") +
      mxRow("Area per full tank", C.show(x.areaPerTank, 3) + " ha", "", fx(x.tank) + " L ÷ " + fx(x.lPerHa) + " L/ha", "aTank") + "</div>";
  }
  if(hasPart){
    html += '<div class="tank-card"><h3>In the part load</h3>' +
      mxRow("Part load", L(x.partLoad), "", fx(x.totalSpray) + " L − (" + full + " × " + fx(x.tank) + " L)", "part") +
      x.products.map(function(p, i){ return mxRow(pName(p, i, " in part load"), P(p, p.perPart), also(p, p.perPart), prodFx(p, x.partLoad, x.areaPart), "pPart" + i); }).join("") +
      mxRow("Water in part load", W(x.waterPart), "", waterFx(x.partLoad, "perPart"), "wPart") +
      mxRow("Area in part load", C.show(x.areaPart, 3) + " ha", "", fx(x.partLoad) + " L ÷ " + fx(x.lPerHa) + " L/ha", "aPart") + "</div>";
  }
  html += '<div class="tank-card"><h3>Whole job</h3>' +
    mxRow("Total spray volume", L(x.totalSpray), "", x.sprayMode === "rate" ? fx(x.areaHa) + " ha × " + fx(x.lPerHa) + " L/ha" : "As typed, " + fx(x.areaHa) + " ha at " + fx(x.lPerHa) + " L/ha", "total") +
    x.products.map(function(p, i){ return mxRow(pName(p, i, " total"), P(p, p.total), also(p, p.total), prodFx(p, x.totalSpray, x.areaHa), "pTotal" + i); }).join("") +
    mxRow("Total water", W(x.waterTotal), "", waterFx(x.totalSpray, "total"), "wTotal") +
    '<div class="row"><div class="k">Check</div>' +
    '<div class="checkline ' + (x.sprayChecks ? "ok" : "no") + '" data-out="check1">' + full + " × " + fx(x.tank) + " + " + fx(x.partLoad) + " = " + fx(x.totalSpray) + " L " + (x.sprayChecks ? "✓" : "✗ does not add up") + "</div>" +
    x.products.map(function(p, i){
      return '<div class="checkline ' + (x.productChecks ? "ok" : "no") + '" data-out="check' + (i + 2) + '">' + full + " × " + fx(p.perTank) + " + " + fx(p.perPart) + " = " + fx(p.total) + " " + p.unit + " " + (x.productChecks ? "✓" : "✗ does not add up") + "</div>";
    }).join("") + "</div></div>";
  if(x.products.some(function(p){ return p.concBased; })) html += '<p class="hint">Per 100 L is worked on the finished mix in the tank, not on water alone.</p>';
  if(anyDry) html += '<p class="hint">Dry product takes up no room in these water figures, because the app can\'t know how much it needs. Fill to the tank mark.</p>';
  return html;
}
/* Tick each tank off as it goes in, so a batch doesn't get missed or mixed twice. */
function tickHtml(x, m){
  var part = x.partLoad.n !== 0n ? 1 : 0, full = Number(x.fullTanks), loads = full + part;
  if(loads < 1) return "";
  var sig = [m.jobId || "", C.unrounded(x.totalSpray, 40), C.unrounded(x.tank, 40)].concat((m.items || []).map(function(it){ return [it.apvma || it.name, it.rate, it.unit].join("|"); })).join("#");
  if(!(m.mixed > 0)){ m.mixed = 0; m.mixedSig = sig; }
  if(m.mixed > loads) m.mixed = loads;
  var moved = m.mixed > 0 && m.mixedSig !== sig;
  var left = m.mixed >= loads ? "All mixed." : m.mixed < full ? "Next: a full tank." : "Next: the part load of " + C.show(x.partLoad, 3) + " L.";
  return '<div class="tick"><div class="tick-n" data-out="ticks">' + m.mixed + " of " + loads + " mixed</div>" +
    '<div class="hint" data-out="next">' + escH(left) + "</div>" +
    (moved ? '<div class="note stop" data-out="tickMoved"><b>This mix changed after you started counting.</b> Check the count.<button type="button" class="btn small" data-tick="reset">Start the count again</button></div>' : "") +
    '<div class="btns"><button type="button" class="btn" data-tick="up"' + (m.mixed >= loads ? " disabled" : "") + ">One more mixed</button>" +
    '<button type="button" class="btn ghost" data-tick="down"' + (m.mixed < 1 ? " disabled" : "") + ">Back one</button></div></div>";
}

function mixView(){
  var m = mixState();
  setTitle("Mix calculator");
  var sec = add(app, "section");
  note(sec, "", "Check the current product label.", "This app has no label rates in it. It only does the maths on what you type.");
  if(m.jobId){
    var n = note(sec, "good", "Mix for", m.jobLabel + ".");
    btn(n, "Start a blank mix", "ghost small", function(){
      var tank = m.tank;
      MIX = blankMixState();
      MIX.tank = tank;
      mixSave();
      rerender();
    });
    var mj0 = byId("jobs", m.jobId);
    if(mj0){
      var gaps0 = noHaNames(jobPaddocks(mj0));
      if(gaps0.length) note(sec, "", "No hectares:", gaps0.join(", ") + ". The area below leaves this out.");
    }
  }
  function staleNote(text, label, apply){
    var sn = note(sec, "stop", "Out of date.", text);
    btn(sn, label, "small", function(){ apply(); mixSave(); rerender(); });
  }
  var sp = byId("paddocks", m.paddockId), sd = byId("drones", m.droneId), sj = byId("jobs", m.jobId);
  if(sp && String(sp.ha || "") !== String(m.area || "")){
    staleNote(sp.name + " is now " + (sp.ha ? sp.ha + " ha" : "blank") + ", and this mix uses " + (m.area || "nothing") + ".", "Use the paddock's area", function(){ m.area = sp.ha || ""; });
  } else if(sj && !m.paddockId && jobHa(sj) && roundHa(jobHa(sj)) !== String(m.area || "")){
    staleNote("This job's paddocks now come to " + roundHa(jobHa(sj)) + " ha, and this mix uses " + (m.area ? m.area + " ha" : "nothing") + ".", "Use the job's area", function(){ m.area = roundHa(jobHa(sj)); });
  }
  if(sd && String(sd.tank || "") !== String(m.tank || "")){
    staleNote(sd.name + "'s tank is now " + (sd.tank ? sd.tank + " L" : "blank") + ", and this mix uses " + (m.tank || "nothing") + ".", "Use the drone's tank", function(){ m.tank = sd.tank || ""; });
  }
  var results, warns, saveBtn, jobBtn;
  function refresh(){
    var res = C.mixMany(mixInput(m));
    document.getElementById("eSpray").textContent = m.sprayMode === "total" ? res.echo.spray : "";
    results.innerHTML = mixResultHtml(res, m);
    mixSave();
    warns.textContent = "";
    warnNotes(warns, m.items);
    if(res.mix) shareNote(warns, {ok: true, share: Number(C.rounded(res.mix.share, 6).text)});
    saveBtn.disabled = !!res.stop;
    jobBtn.disabled = !!res.stop;
  }
  var form = panelForm(sec);
  var haBox, padSel = null, droneSel = null;
  if(S.paddocks.length){
    padSel = select(m, "paddockId", [["","Type the area instead"]].concat(S.paddocks.map(function(p){
      return [p.id, (clientName(p.clientId) ? clientName(p.clientId) + ", " : "") + p.name + (p.ha ? " (" + fmtN(num(p.ha), 2) + " ha)" : "")];
    })), {on: function(v){
      var p = byId("paddocks", v);
      if(p) m.area = p.ha || "";
      rerender();
    }});
    fld(form, "Paddock", padSel);
  }
  haBox = input(m, "area", {num: true, on: function(){
    m.paddockId = "";
    if(padSel) padSel.value = "";
    refresh();
  }});
  fld(form, "Area to treat, ha", haBox);

  if(m.sprayMode === "total"){
    fld(form, "Total spray volume, L", input(m, "sprayTotal", {num: true, on: refresh}));
    var toRate = add(form, "button", "linkbtn", "Use a spray rate instead");
    toRate.type = "button";
    toRate.addEventListener("click", function(){ m.sprayMode = "rate"; mixSave(); rerender(); });
  } else {
    fld(form, "Spray rate, L/ha", input(m, "waterRate", {num: true, on: refresh}));
    var toTotal =add(form, "button", "linkbtn", "Use a total spray volume instead");
    toTotal.type = "button";
    toTotal.addEventListener("click", function(){ m.sprayMode = "total"; mixSave(); rerender(); });
  }
  add(form, "p", "echo").id = "eSpray";

  var tankBox = input(m, "tank", {num: true, on: function(){
    m.droneId = "";
    if(droneSel) droneSel.value = "";
    refresh();
  }});
  fld(form, "Tank size, L", tankBox, "Starts on your 450 L mixing tank. Type over it, or pick a drone below.");
  if(S.drones.length){
    droneSel = select(m, "droneId", [["","Mixing tank, or as typed"]].concat(S.drones.map(function(d){ return [d.id, d.name + (d.tank ? " (" + d.tank + " L)" : "")]; })), {on: function(v){
      var d = byId("drones", v);
      if(d && d.tank){ m.tank = d.tank; tankBox.value = m.tank; }
      refresh();
    }});
    fld(form, "Use a drone's tank", droneSel);
  }

  add(sec, "h2", "sec", "Products");
  m.items.forEach(function(it, i){
    itemEditor(sec, it, {onChange: refresh, onRemove: function(){ m.items.splice(i, 1); mixSave(); rerender(); }});
  });
  btn(sec, m.items.length ? "Add another product" : "Add a product", m.items.length ? "ghost" : "", function(){
    pickProduct(function(it){ m.items.push(it); mixSave(); });
  });
  warns = add(sec, "div", "stack");

  add(sec, "h2", "sec", "The mix");
  results = add(sec, "div", "stack");
  results.id = "mixOut";
  results.setAttribute("aria-live", "polite");
  results.addEventListener("click", function(e){
    var b = e.target.closest("[data-tick]");
    if(!b) return;
    var what = b.getAttribute("data-tick");
    if(what === "reset"){ m.mixed = 0; m.mixedSig = ""; }
    else m.mixed = Math.max(0, (m.mixed || 0) + (what === "up" ? 1 : -1));
    refresh();
  });

  jobBtn = btn(sec, "Start a job with this mix", "ghost", function(){
    var j = newJobItem();
    m.jobId = j.id = uid();
    m.jobLabel = "this job";
    m.mixed = 0;
    m.mixedSig = "";
    lastMixSaved = null;
    put("jobs", j).then(function(){ mixSave(); jobView(byId("jobs", j.id)); });
  });

  var keep = fold(sec, "Saved mixes", false);
  var save = {name: ""}, sf = add(add(keep, "div", "panel"), "div", "form");
  fld(sf, "Save this mix as", input(save, "name", {ph: "e.g. Woody weeds, pasture"}));
  saveBtn = btn(sf, "Save mix", "ghost small", function(){
    if(!save.name.trim()){ toast("Give the mix a name first."); return; }
    if(!m.items.length){ toast("Add a product first."); return; }
    /* only the names, numbers and units you entered */
    put("recipes", {name: save.name.trim(), waterRate: mixWater(m), items: clone(m.items), saved: nowStamp()}).then(function(){
      toast("Mix saved"); rerender();
    });
  });
  if(S.recipes.length){
    var list = listPanel(keep);
    S.recipes.slice().sort(function(a, b){ return a.name.localeCompare(b.name); }).forEach(function(rc){
      rowItem(list, rc.name, [
        fmtN(rc.items.length, 0) + (rc.items.length === 1 ? " product" : " products"),
        rc.waterRate ? rc.waterRate + " L/ha" : null, "Rates typed by you"
      ], function(){ recipeView(rc); });
    });
  }
  btn(sec, "Clear everything", "danger", function(){
    if(!confirm("Clear this mix?")) return;
    MIX = blankMixState();
    mixSave();
    rerender();
  });
  refresh();
}

/* ═════════════ JOBS ═════════════ */
function newJobItem(){ return {status: "planned", paddockIds: [], due: "", created: nowStamp()}; }
function clientInUse(c, d){
  function other(x){ return x.clientId === c.id && (!d || x.id !== d.id); }
  return S.jobs.some(other) || S.quotes.some(other) || S.paddocks.some(other) || S.records.some(other);
}
/* One box: pick a client, or type a new name and keep going. Details can wait. */
function clientBox(form, d, after, typing){
  var box = {v: clientName(d.clientId) || d.clientName || ""};
  /* kept as it's typed, so a phone call or a dead battery can't lose a half typed name */
  var inp = input(box, "v", {ph: "Start typing a name", on: function(v){ d.clientName = v; if(typing) typing(); }});
  inp.dataset.f = "clientName";
  inp.setAttribute("list", "clientNames");
  inp.setAttribute("autocomplete", "off");
  var w = fld(form, "Client", inp, "Pick one, or type a new name and keep going. Add their details later.");
  var dl = add(w, "datalist");
  dl.id = "clientNames";
  sortedClients().forEach(function(c){ add(dl, "option").value = c.name; });
  var which = add(form, "div");
  /* a name typed in passing and then changed doesn't stay behind as a client */
  function dropQuick(cur, keepId){ if(cur && cur.quick && cur.id !== keepId && !clientInUse(cur, d)) del("clients", cur.id).catch(function(){}); }
  inp.addEventListener("change", function(){
    var name = inp.value.trim(), cur = byId("clients", d.clientId);
    which.textContent = "";
    if(!name){ dropQuick(cur, ""); d.clientId = ""; d.clientName = ""; after(null); return; }
    var same = S.clients.filter(function(c){ return (c.name || "").trim().toLowerCase() === name.toLowerCase(); });
    if(same.length > 1){
      /* two clients share this name, and only you can say which */
      var pick = {v: ""};
      fld(which, "Which " + name + "?", select(pick, "v", [["","Pick one"]].concat(same.map(function(c){
        return [c.id, [c.name, c.contact || c.property || c.phone || c.address].filter(Boolean).join(", ")];
      })), {on: function(v){
        var c = byId("clients", v);
        if(c){ dropQuick(cur, c.id); d.clientId = c.id; d.clientName = c.name; after(c); }
      }}));
      return;
    }
    if(same.length === 1){ dropQuick(cur, same[0].id); d.clientId = same[0].id; d.clientName = same[0].name; after(same[0]); return; }
    /* a slip in a name just typed fixes that client rather than making a second one */
    if(cur && cur.quick && !clientInUse(cur, d)){ cur.name = name; d.clientName = name; put("clients", cur).catch(function(){}); after(cur); return; }
    var fresh = {name: name, quick: true, created: nowStamp()};
    put("clients", fresh).catch(function(){});
    d.clientId = fresh.id;
    d.clientName = name;
    after(fresh);
  });
}
function jobView(job){
  editView({
    title: "Job", store: "jobs", item: job,
    moreFirst: true,
    keepIfValid: true,
    valid: function(d){ return !!(d.clientId || d.clientName || (d.paddockIds || []).length || d.due || d.situation || d.purpose || d.notes || d.recipeId || (d.mixItems && d.mixItems.length)); },
    invalid: "Type something on the job first.",
    /* finishing the spray record marks the job done while this form sits behind it */
    refresh: function(d){
      var live = byId("jobs", d.id);
      if(live) Object.keys(live).forEach(function(k){ if(k === "status" || k.indexOf("mix") === 0) d[k] = live[k]; });
    },
    build: function(form, d){
      if(d.quoteNumber) add(form, "p", "hint", "From quote " + d.quoteNumber + ".");
      clientBox(form, d, function(){ d.paddockIds = []; rerender(); });
      if(d.clientId){
        var c0 = byId("clients", d.clientId);
        if(c0) btn(form, "Client details", "ghost small", function(){ clientView(c0); });
        var pads = S.paddocks.filter(function(p){ return p.clientId === d.clientId; });
        add(form, "span", "f-l", "Paddocks");
        if(!pads.length) add(form, "p", "hint", "No paddocks saved for this client yet.");
        pads.forEach(function(p){
          var w = add(form, "label", "check");
          var c = add(w, "input");
          c.type = "checkbox";
          c.checked = (d.paddockIds || []).indexOf(p.id) >= 0;
          c.addEventListener("change", function(){
            d.paddockIds = (d.paddockIds || []).filter(function(x){ return x !== p.id; });
            if(c.checked) d.paddockIds.push(p.id);
          });
          add(w, "span", null, p.name + (p.ha ? " (" + fmtN(num(p.ha), 2) + " ha)" : ""));
        });
        btn(form, "Add a paddock", "ghost small", function(){
          paddockView({clientId: d.clientId}, function(p){
            d.paddockIds = d.paddockIds || [];
            if(d.paddockIds.indexOf(p.id) < 0) d.paddockIds.push(p.id);
          });
        });
      }
      var r = add(form, "div", "two");
      fld(r, "Due", input(d, "due", {type: "date"}));
      fld(r, "Status", select(d, "status", JOB_STATUS));
      var r2 = add(form, "div", "two");
      fld(r2, "Pilot", select(d, "pilotId", [["","Pick"]].concat(S.people.map(function(x){ return [x.id, x.name]; }))));
      fld(r2, "Drone", select(d, "droneId", [["","Pick"]].concat(S.drones.map(function(x){ return [x.id, x.name]; }))));
      var more = add(add(fold(form, "Mix, crop, purpose and notes", !!(d.situation || d.purpose || d.notes || d.recipeId)), "div"), "div", "form inner");
      fld(more, "Saved mix", select(d, "recipeId", [["","No saved mix"]].concat(S.recipes.map(function(x){ return [x.id, x.name]; }))));
      fld(more, "Crop or situation", input(d, "situation", {ph: "e.g. improved pasture"}));
      fld(more, "Purpose", input(d, "purpose", {ph: "e.g. giant rats tail grass control"}));
      fld(more, "Notes", input(d, "notes", {area: true}));
    },
    more: function(sec, d, ensure){
      var gaps = noHaNames(jobPaddocks(d));
      if(gaps.length) note(sec, "", "No hectares:", gaps.join(", ") + ". The job's total leaves this out until it has an area.");
      btn(sec, "1. Work out the mix", "", function(){ if(ensure()) openMixFor(d); });
      btn(sec, "2. Spray record", "ghost", function(){ if(ensure()) openRecordFor(d); });
      var box = add(fold(sec, "Forecast (needs internet)", false), "div", "panel");
      forecastBox(add(box, "div", "form"), function(){
        var p = jobPaddocks(d)[0];
        return p && p.centre ? Promise.resolve(p.centre) : gpsPoint();
      });
    },
    keep: function(d){
      return S.records.some(function(r){ return r.jobId === d.id; }) ? "This job has a spray record, so it stays." : "";
    }
  });
}

/* ═════════════ CLIENTS ═════════════ */
function paddocksView(){
  setTitle("Clients");
  var sec = add(app, "section");
  btn(sec, "New client", "", function(){ clientView({}); });
  if(!S.clients.length){
    add(sec, "div", "panel").appendChild(el("div", "empty", "No clients yet. Add one, then add their paddocks or sites."));
    return;
  }
  var state = {q: ""}, s = add(sec, "div", "search");
  var box = input(state, "q", {ph: "Search clients", on: draw});
  box.setAttribute("aria-label", "Search clients");
  s.appendChild(box);
  var out = add(sec, "div");
  function draw(){
    out.textContent = "";
    var words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    var rows = sortedClients().filter(function(c){
      var pads = S.paddocks.filter(function(p){ return p.clientId === c.id; });
      var hay = [c.name, c.contact, c.property, c.phone, c.email, c.address, c.notes].concat(pads.map(function(p){ return [p.name, p.address, p.locality].join(" "); })).join(" ").toLowerCase();
      return words.every(function(w){ return hay.indexOf(w) >= 0; });
    });
    if(!rows.length){ add(out, "div", "panel").appendChild(el("div", "empty", "No client matches that.")); return; }
    var list = listPanel(out);
    rows.forEach(function(c){
      var pads = S.paddocks.filter(function(p){ return p.clientId === c.id; });
      var ha = pads.reduce(function(t, p){ return t + (num(p.ha) || 0); }, 0);
      rowItem(list, c.name, [
        c.contact || null, c.phone || null,
        pads.length ? fmtN(pads.length, 0) + (pads.length === 1 ? " site" : " sites") : null,
        ha ? fmtN(ha, 2) + " ha" : null
      ], function(){ clientView(c); });
    });
  }
  draw();
}
function clientView(client, picked){
  if(client) delete client.quick;
  editView({
    title: "Client", store: "clients", item: client,
    valid: function(d){ return !!(d.name || "").trim(); },
    invalid: "Enter the client's name first.",
    after: function(d){ if(picked) picked(d); },
    build: function(f, d){
      fld(f, "Business or person's name", input(d, "name"));
      fld(f, "Contact name", input(d, "contact"));
      var r = add(f, "div", "two");
      fld(r, "Phone", input(d, "phone", {type: "tel"}));
      fld(r, "Email", input(d, "email", {type: "email"}));
      if(d.phone || d.email){
        var acts = add(f, "div", "btns");
        if(d.phone){ var a = add(acts, "a", "btn ghost small", "Call"); a.href = "tel:" + d.phone.replace(/[^\d+]/g, ""); }
        if(d.email){ var e = add(acts, "a", "btn ghost small", "Email"); e.href = "mailto:" + d.email; }
      }
      fld(f, "Notes", input(d, "notes", {area: true}));
      var more = add(fold(f, "Property and postal address", !!(d.property || d.address)), "div", "form inner");
      fld(more, "Property name", input(d, "property"));
      fld(more, "Address", input(d, "address", {area: true}), "A spray record needs the landowner or occupier's address and phone.");
    },
    more: function(sec, d, ensure){
      add(sec, "h2", "sec", "Sites and paddocks");
      var pads = S.paddocks.filter(function(p){ return p.clientId === d.id; });
      if(pads.length){
        var list = listPanel(sec);
        pads.forEach(function(p){
          rowItem(list, p.name, [p.ha ? fmtN(num(p.ha), 2) + " ha" : null, p.address || p.locality || null, p.lot || null], function(){ paddockView(p); });
        });
      }
      btn(sec, "Add a site or paddock", "ghost", function(){ if(ensure()) paddockView({clientId: d.id}); });
      var acts = add(sec, "div", "btns");
      btn(acts, "New quote", "ghost", function(){ if(ensure()) quoteView(newQuoteItem(byId("clients", d.id) || d)); });
      btn(acts, "New job", "ghost", function(){
        if(!ensure()) return;
        var j = newJobItem();
        j.clientId = d.id;
        jobView(j);
      });
    },
    keep: function(d){
      if(S.paddocks.some(function(p){ return p.clientId === d.id; })) return "Delete this client's sites first.";
      if(S.jobs.some(function(j){ return j.clientId === d.id; })) return "This client has jobs, so it stays.";
      return "";
    }
  });
}

/* ═════════════ RECORD EXTRAS ═════════════ */
function sessionText(s){ return fmtDate(s.date) + (s.start ? " from " + s.start : "") + (s.finish ? " to " + s.finish : ""); }
function sessionsText(r){ return (r.sessions || []).map(sessionText).join("; "); }
function ensureSessions(rec){
  if(rec.sessions && rec.sessions.length) return;
  if(rec.endDate && rec.endDate !== rec.date){
    /* an older record over several days: its start belongs to the first day and its finish to the last */
    rec.sessions = [{id: uid(), date: rec.date || todayISO(), start: rec.startTime || "", finish: ""}, {id: uid(), date: rec.endDate, start: "", finish: rec.endTime || ""}];
  } else {
    rec.sessions = [{id: uid(), date: rec.date || todayISO(), start: rec.startTime || "", finish: rec.endTime || ""}];
  }
}
/* The record's own dates and times follow its sessions */
function syncSessions(rec){
  var days = rec.sessions.map(function(s){ return s.date; }).filter(Boolean).sort();
  rec.date = days[0] || "";
  var last = days[days.length - 1] || "";
  rec.endDate = last && last !== rec.date ? last : "";
  var inOrder = rec.sessions.slice().sort(function(a, b){ return (a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0; });
  rec.startTime = inOrder[0].start || "";
  rec.endTime = inOrder[inOrder.length - 1].finish || "";
}
function sessionsBlock(f, rec, changed, final){
  if(final && !(rec.sessions && rec.sessions.length)){
    /* finished before sessions existed, so it shows exactly what was recorded */
    var r1 = add(f, "div", "two");
    fld(r1, "Date applied", input(rec, "date", {type: "date"}));
    fld(r1, "Last day, if longer", input(rec, "endDate", {type: "date"}));
    var r2 = add(f, "div", "two");
    fld(r2, "Start", input(rec, "startTime", {type: "time"}));
    fld(r2, "Finish", input(rec, "endTime", {type: "time"}));
    return;
  }
  ensureSessions(rec);
  function on(){ syncSessions(rec); changed(); }
  rec.sessions.forEach(function(s, i){
    var box = add(f, "div", "wx");
    var head = add(box, "div", "wx-head");
    add(head, "div", "item-name", rec.sessions.length > 1 ? "Spraying, session " + (i + 1) : "Spraying");
    if(rec.sessions.length > 1){
      var x = add(head, "button", "x edit-only", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Remove this session");
      x.addEventListener("click", function(){ rec.sessions.splice(i, 1); on(); rerender(); });
    }
    fld(box, "Date", input(s, "date", {type: "date", on: on}));
    var r = add(box, "div", "two");
    fld(r, "Start", input(s, "start", {type: "time", on: on}));
    fld(r, "Finish", input(s, "finish", {type: "time", on: on}));
    var acts = add(box, "div", "btns edit-only");
    btn(acts, "Start now", "ghost small", function(){ s.start = nowTime(); if(!s.date) s.date = todayISO(); on(); rerender(); });
    btn(acts, "Finish now", "ghost small", function(){ s.finish = nowTime(); if(!s.date) s.date = todayISO(); on(); rerender(); });
    var w = btn(box, "Add a weather reading for this session", "ghost small edit-only", function(){
      rec.weather.splice(rec.weather.length - 1, 0, {stage: "Change", date: s.date, time: nowTime(), temp: "", rh: "", wind: "", dir: "", cloud: "", rain: ""});
      changed();
      rerender();
    });
    w.dataset.session = String(i);
  });
  btn(f, "Add another session", "ghost small edit-only", function(){
    rec.sessions.push({id: uid(), date: todayISO(), start: "", finish: ""});
    on();
    rerender();
  });
}
function weatherName(w){ return (w.stage === "Change" ? "Change during" : w.stage) + (w.date ? " " + fmtDate(w.date) : ""); }
/* Area and spray can be entered in other units, and the record keeps ha and L/ha */
function areaSprayFields(form, rec, on){
  rec.areaUnit = rec.areaUnit || "ha";
  rec.sprayUnit = rec.sprayUnit || "L/ha";
  /* set from a paddock or the job since it was typed, so the figure stands and the old typing goes */
  if(rec.areaUnit !== "ha" && rec.area !== rec.areaWorked) rec.areaUnit = "ha";
  if(rec.sprayUnit !== "L/ha" && rec.waterRate !== rec.sprayWorked) rec.sprayUnit = "L/ha";
  if(rec.areaUnit === "ha") rec.areaTyped = rec.area;
  if(rec.sprayUnit === "L/ha") rec.sprayTyped = rec.waterRate;
  var eA = null, eS = null;
  function work(){
    if(rec.areaUnit === "ha") rec.area = rec.areaTyped;
    else {
      var a = C.parse(cleanNum(rec.areaTyped));
      rec.area = a ? C.unrounded(C.mul(a, C.AREA_UNITS[rec.areaUnit].toHa), 40) : "";
    }
    rec.areaWorked = rec.area;
    if(rec.sprayUnit === "L/ha") rec.waterRate = rec.sprayTyped;
    else {
      var s = C.parse(cleanNum(rec.sprayTyped));
      rec.waterRate = s ? C.unrounded(C.mul(s, C.SPRAY_RATE_UNITS[C.unitKey(rec.sprayUnit)].toLha), 40) : "";
    }
    rec.sprayWorked = rec.waterRate;
    if(eA) eA.textContent = C.echoArea(cleanNum(rec.areaTyped), rec.areaUnit);
    if(eS) eS.textContent = C.echoSprayRate(cleanNum(rec.sprayTyped), rec.sprayUnit);
  }
  fld(form, "Area treated", input(rec, "areaTyped", {num: true, on: function(){ work(); on(); }}));
  var ch = add(form, "div", "edit-only");
  unitPick(ch, "Area unit", rec, "areaUnit", [["ha","ha"],["ac","acres"],["m2","m²"]], function(){ work(); on(); rerender(); });
  eA = add(form, "p", "echo");
  fld(form, "Spray rate", input(rec, "sprayTyped", {num: true, on: function(){ work(); on(); }}));
  var ch2 = add(form, "div", "edit-only");
  unitPick(ch2, "Spray rate unit", rec, "sprayUnit", [["L/ha","L/ha"],["L/1000 m²","L/1000 m²"]], function(){ work(); on(); rerender(); });
  eS = add(form, "p", "echo");
  work();
}
function areaLine(rec){
  var a = C.parse(cleanNum(rec.area));
  return (a ? C.rounded(a, 4).text : rec.area) + " ha" + (rec.areaUnit && rec.areaUnit !== "ha" && rec.areaTyped ? " (" + rec.areaTyped + " " + C.AREA_UNITS[rec.areaUnit].label + ")" : "");
}
function peopleGaps(rec){ return !(rec.owner.name && rec.owner.address && rec.owner.phone && rec.applicator.name && rec.applicator.address && rec.applicator.phone && rec.applicator.quals); }

/* ═════════════ QUOTES ═════════════ */
var QUOTE_STATUS = ["Draft","Quoted","Follow up","Won","Lost","No response"];
/* the price list and the quote wording: they start in rates.js and then live in settings */
var PRICES = self.StelRates;
var LEAD_SOURCES = ["Word of mouth","Facebook","Google Ads","Referral","Noticeboard","Field day","Repeat customer"];
var MAX_APPS = 4;
/* GST from the owner's price list and quotes. Editable. */
function freshQuoteCfg(){ return {gstOn: true, gstRate: "10", prefix: "Q-", footer: ""}; }
function quoteCfg(){
  var c = cfg();
  c.quote = c.quote || freshQuoteCfg();
  /* First use: the wording the Quote Builder already publishes, then it's the owner's to change
     under Backup and setup. The footer is left alone: it's what a typed quote prints, as it always did. */
  if(!c.quote.words){
    c.quote.words = clone(PRICES.WORDING);
    saveCfg().catch(function(){});
  }
  return c.quote;
}
/* Your business is the one place for these five, read fresh each time a priced quote prints.
   A box left blank there falls back to the rate card's wording. */
function quoteBusiness(){
  var typed = cfg().business || {}, out = clone(quoteCfg().words.business || {}), list = PRICES.WORDING.business;
  ["name","abn","address","phone","email"].forEach(function(k){
    out[k] = String(typed[k] || "").trim() ? typed[k] : list[k];
  });
  return out;
}
/* The rate card lives in settings, so it goes in the backup. On first use it starts from what
   the owner edited in the Quote Builder on this same web address, if anything. That copy is
   only read: the Quote Builder keeps its own. */
function rateCard(){
  var c = cfg();
  if(!c.rates){
    var card = clone(PRICES.DEFAULTS), kept = null;
    try { kept = JSON.parse(ls("stel-rates-v1", "null")); } catch(e){ kept = null; }
    if(kept && typeof kept === "object"){
      Object.keys(kept).forEach(function(k){
        if(k in card && Array.isArray(card[k]) === Array.isArray(kept[k])) card[k] = kept[k];
      });
      c.ratesFrom = "builder";
      if(typeof kept.gst === "number") quoteCfg().gstRate = String(kept.gst);
    }
    c.rates = card;
    saveCfg().catch(function(){});
  }
  return c.rates;
}
function listPriceOf(card, a){
  if(a.rateKey && a.rateKey.charAt(0) === "i"){
    var o = card[a.svc][parseInt(a.rateKey.slice(1), 10)];
    return o ? String(o.r) : "0";
  }
  return "0";
}
function newApp(card){
  var a = {svc: "spray", area: "", rateKey: "i0", chargeBy: "ha", price: "", label: "", hours: "", hourly: String(card.hourly), spot: false, product: ""};
  a.price = listPriceOf(card, a);
  return a;
}
function pickService(a, card, v){
  a.svc = v;
  a.rateKey = "i0";
  a.price = listPriceOf(card, a);
  if(v !== "spray") a.spot = false;
}
/* "Something else" is your own line, so what you typed stays. P.O.A. and over the top go to nothing on purpose. */
function pickRate(a, card, v){
  a.rateKey = v;
  if(v !== "other") a.price = listPriceOf(card, a);
}
function newJob(){
  var card = clone(rateCard());
  return {card: card, apps: [newApp(card)], km: "", locations: "", washdowns: "", hazards: [], deposit: "", validDays: "30", followDays: "7", ref: "", leadSource: LEAD_SOURCES[0]};
}
function rateOptions(card, svc){
  var M = PRICES.META[svc];
  var o = card[svc].map(function(x, k){ return ["i" + k, x.t]; });
  if(M.extra) o.push([M.extra.v, M.extra.t]);
  o.push(["other", "Something else"]);
  return o;
}
function priceOf(q){ return C.priceJob(q.job, q.job.card, PRICES); }
/* The builder's answer goes into q.lines, marked auto, ahead of anything typed. The sheet, the
   CSV and the totals then all read one source, so what prints always adds up to the cent. */
function writePriced(q){
  var r = priceOf(q), typed = q.lines.filter(function(l){ return !l.auto; });
  var priced = r.poa ? [] : r.lines.map(function(l, i){ return {id: "auto" + i, auto: true, desc: l.d, note: l.c, qty: l.qty, unit: l.unit, rate: l.rate}; });
  q.poa = r.poa;
  q.lines = priced.concat(typed);
  return r;
}
function sameFigure(x, y){
  var a = C.parse(x), b = C.parse(y);
  return !!a && !!b && C.cmp(a, b) === 0;
}
/* two rate cards or sets of wording, where 50 typed in a box is a string and 50 off the list isn't */
function sameData(a, b){
  function s(x){ return JSON.stringify(x, function(k, v){ return typeof v === "number" ? String(v) : v; }); }
  return s(a) === s(b);
}
/* A quote keeps the card it was priced on, so changing a rate never changes a quote that went
   out. A draft, or a copy, moves to today's card: list prices follow it, own prices stay. */
function jobUseCurrentCard(q){
  var j = q.job, old = j.card, cur = rateCard();
  if(JSON.stringify(old) === JSON.stringify(cur)) return false;
  j.apps.forEach(function(a){
    if(a.rateKey !== "other" && sameFigure(a.price, listPriceOf(old, a))) a.price = listPriceOf(cur, a);
    if(sameFigure(a.hourly, old.hourly)) a.hourly = String(cur.hourly);
  });
  j.card = clone(cur);
  writePriced(q);
  return true;
}
function refreshDraftCard(q){
  /* a draft held by a merge stays put until the owner says to move it */
  if(q.job && q.status === "Draft" && !q.ratesHeld && jobUseCurrentCard(q) && byId("quotes", q.id)) put("quotes", q).catch(function(){});
}
/* Only ever into an empty box on a draft. A figure someone typed, or a quote that has gone out, stays. */
function fillSiteHa(q, p){
  var first = q.job && q.job.apps[0];
  if(!first || q.status !== "Draft" || !p || !p.ha || String(first.area || "").trim()) return;
  var ha = C.parse(String(p.ha));
  if(!ha) return;
  first.area = C.rounded(ha, 2).text;
  first.fromSite = p.id;
  writePriced(q);
}
/* what the hint under Hectares says: never that a figure came from the site unless it did */
function siteHint(q, a){
  var site = byId("paddocks", q.paddockId);
  if(!site) return "";
  if(a.fromSite === site.id) return "Filled in from the site. Check it.";
  var ha = C.parse(String(site.ha || "")), typed = String(a.area || "").trim();
  if(!ha || !typed || q.status !== "Draft") return "";
  var onFile = C.rounded(ha, 2).text;
  return sameFigure(typed, onFile) ? "" : "The site's record says " + onFile + " ha. Hectares stays as it is unless you change it.";
}
function depositOf(q){ return Math.min(100, Math.max(0, parseFloat(q.job.deposit) || 0)); }
function depositCents(q, t){
  return C.toCents(C.mul(C.R(t.total, 100n), C.div(C.parse(String(depositOf(q))) || C.R(0), C.R(100))));
}
/* a quote with its date cleared out still prints a real one */
function quoteDate(q){ return /^\d{4}-\d\d-\d\d/.test(q.date || "") ? q.date : todayISO(); }
function longDate(iso){ var p = parts(iso); return new Date(p[0], p[1], p[2]).toLocaleDateString("en-AU", {day: "numeric", month: "long", year: "numeric"}); }
function shortDate(iso){ var p = parts(iso); return p[2] + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][p[1]] + " " + p[0]; }
function slashDate(iso){ var p = parts(iso); return pad(p[2]) + "/" + pad(p[1] + 1) + "/" + p[0]; }
function nextQuoteNumber(){
  var max = 0;
  S.quotes.forEach(function(q){
    var m = /(\d+)\s*$/.exec(q.number || "");
    if(m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = String(max + 1);
  while(n.length < 4) n = "0" + n;
  return (quoteCfg().prefix || "") + n;
}
function blankLine(){ return {id: uid(), desc: "", qty: "", unit: "", rate: ""}; }
function newQuoteItem(client){
  rateCard();
  var qc = quoteCfg();
  var q = {id: uid(), number: nextQuoteNumber(), date: todayISO(), status: "Draft", clientId: "", clientName: "", contact: "", email: "", phone: "",
    paddockId: "", location: "", lines: [], job: newJob(), gstOn: !!qc.gstOn, gstRate: qc.gstRate, notes: ""};
  writePriced(q);
  if(client) quoteClient(q, client);
  return q;
}
function quoteClient(q, c){
  q.clientId = c ? c.id : "";
  q.clientName = c ? c.name : "";
  q.contact = c ? (c.contact || "") : "";
  q.email = c ? (c.email || "") : "";
  q.phone = c ? (c.phone || "") : "";
  /* a quote that has gone out keeps where it was for. It only lets go of another client's site */
  if(q.status !== "Draft"){
    var was = byId("paddocks", q.paddockId);
    if(was && (!c || was.clientId !== c.id)) q.paddockId = "";
    return;
  }
  q.paddockId = "";
  q.location = "";
  var pads = c ? S.paddocks.filter(function(p){ return p.clientId === c.id; }) : [];
  if(pads.length === 1) quoteSite(q, pads[0]);
}
/* once a quote has gone out it keeps the details it went with */
function refreshDraftClient(q){
  var c = q.status === "Draft" ? byId("clients", q.clientId) : null;
  if(c){ q.clientName = c.name; q.contact = c.contact || ""; q.email = c.email || ""; q.phone = c.phone || ""; }
}
function quoteSite(q, p){
  q.paddockId = p ? p.id : "";
  if(p && (q.status === "Draft" || !String(q.location || "").trim())) q.location = [p.name, p.address || p.locality].filter(Boolean).join(", ");
  fillSiteHa(q, p);
}
function plain(cents){ return C.money(cents).replace(/[$,]/g, ""); }
function rateText(s){
  var r = C.parseSigned(s);
  if(!r) return s || "";
  var c = C.toCents(r);
  if(C.cmp(C.R(c, 100n), r) === 0) return C.money(c);
  return (r.n < 0n ? "-$" : "$") + C.unrounded(r.n < 0n ? C.R(-r.n, r.d) : r);
}
function totalsHtml(q, t){
  var html = t.bad ? '<div class="note stop"><b>A number on this quote can\'t be read.</b> Fix it before you send this.</div>' : "";
  html += "<div><span>" + (q.gstOn ? "Subtotal, excluding GST" : "Subtotal") + "</span><span>" + escH(C.money(t.subtotal)) + "</span></div>";
  html += q.gstOn ? "<div><span>GST (" + escH(q.gstRate) + "%)</span><span>" + escH(C.money(t.gst)) + "</span></div>" : "<div><span>GST</span><span>Not charged</span></div>";
  html += '<div class="grand"><span>' + (q.gstOn ? "Total including GST" : "Total") + '</span><span data-out="qTotal">' + escH(C.money(t.total)) + "</span></div>";
  return html;
}
function quotesView(){
  setTitle("Quotes");
  var sec = add(app, "section");
  btn(sec, "New quote", "", function(){ quoteView(newQuoteItem()); });
  if(!S.quotes.length){
    add(sec, "div", "panel").appendChild(el("div", "empty", "No quotes yet."));
    return;
  }
  var state = {q: ""}, s = add(sec, "div", "search");
  var box = input(state, "q", {ph: "Search quotes", on: draw});
  box.setAttribute("aria-label", "Search quotes");
  s.appendChild(box);
  var out = add(sec, "div");
  function draw(){
    out.textContent = "";
    var words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    var rows = S.quotes.filter(function(x){
      var hay = [x.number, x.clientName, x.location, x.status, x.notes].join(" ").toLowerCase();
      return words.every(function(w){ return hay.indexOf(w) >= 0; });
    }).sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if(!rows.length){ add(out, "div", "panel").appendChild(el("div", "empty", "No quote matches that.")); return; }
    var list = listPanel(out);
    rows.forEach(function(x){
      var t = C.quoteTotals(x.lines, x.gstOn, x.gstRate);
      rowItem(list, x.number + " " + (x.clientName || "No client yet"), [
        {t: x.status, k: x.status === "Won" ? "good" : x.status === "Draft" ? "warn" : ""},
        fmtDate(x.date), x.job && x.poa ? "P.O.A." : C.money(t.total)
      ], function(){ quoteSheet(x); });
    });
  }
  draw();
}
/* The priced part of the form: one card per application, then travel, then the price. Returns
   the function that repaints the price and what shows on the cards without touching the fields. */
function jobForm(sec, q, save){
  var j = q.job, card = j.card, uis = [];
  var usual = C.parse(String(card.hourly)) || C.R(0);
  function changed(){ writePriced(q); save(); paint(); }
  function hintOf(w){ return w.querySelector(".f-h"); }

  add(sec, "h2", "sec", "The job");
  j.apps.forEach(function(a, i){
    var box = add(sec, "div", "prod"), M = PRICES.META[a.svc], u = {};
    if(j.apps.length > 1) add(box, "h3", "q-app", "Application " + (i + 1));
    chipRow(box, Object.keys(PRICES.META).map(function(s){ return [s, PRICES.META[s].chip]; }), a.svc, function(v){
      if(v === a.svc) return;
      pickService(a, card, v);
      changed();
      rerender();
    });
    var rs = card[a.svc].map(function(o){ return Number(o.r) || 0; });
    if(rs.length) add(box, "p", "hint", M.name + " runs " + C.money(BigInt(Math.round(Math.min.apply(null, rs) * 100))) + " to " + C.money(BigInt(Math.round(Math.max.apply(null, rs) * 100))) + " a hectare.");
    u.area = fld(box, "Hectares", input(a, "area", {num: true, strict: true, on: function(){ delete a.fromSite; changed(); }}), " ");
    fld(box, M.rateLabel, select(a, "rateKey", rateOptions(card, a.svc), {on: function(v){
      pickRate(a, card, v);
      changed();
      rerender();
    }}));
    u.label = fld(box, "Call it what on the quote", input(a, "label", {ph: PRICES.LABEL_HINT, on: changed}));
    u.price = fld(box, "Price per hectare, $", input(a, "price", {num: true, strict: true, on: changed}), " ");
    u.hoursRow = add(box, "div", "two");
    fld(u.hoursRow, "Hours on site", input(a, "hours", {num: true, strict: true, on: changed}));
    u.hourly = fld(u.hoursRow, "Hourly rate, $", input(a, "hourly", {num: true, strict: true, on: changed}));
    u.why = add(box, "p", "hint");
    u.more = fold(box, "By the hour, product, spot spraying", a.chargeBy === "hour" || !!a.product || !!a.spot);
    var mf = add(add(u.more, "div", "panel"), "div", "form");
    fld(mf, "Charge by", select(a, "chargeBy", [["ha","The hectare"],["hour","The hour"]], {on: changed}));
    fld(mf, "Chemical or product", input(a, "product", {ph: "Leave blank: client supplies", on: changed}));
    if(a.svc === "spray") checkbox(mf, a, "spot", "Spot spraying, not broadacre", changed);
    if(j.apps.length > 1) btn(box, "Remove this one", "danger small", function(){
      if(!confirm("Remove this application?")) return;
      j.apps.splice(j.apps.indexOf(a), 1);
      writePriced(q);
      save();
      rerender();
    });
    uis.push(u);
  });
  if(j.apps.length < MAX_APPS) btn(sec, "+ Another application", "ghost", function(){ j.apps.push(newApp(card)); writePriced(q); save(); rerender(); });

  add(sec, "h2", "sec", "Site and travel");
  var tf = panelForm(sec);
  var kmF = fld(tf, "Distance from base, one way, km", input(j, "km", {num: true, strict: true, on: changed}), " ");
  var locF = fld(tf, "Operating locations", input(j, "locations", {num: true, strict: true, on: changed}), " ");
  var hz = {};
  (j.hazards || []).forEach(function(k){ hz[k] = true; });
  var extra = foldForm(sec, "Wash downs and hazards", !!(j.hazards || []).length || !!String(j.washdowns || "").trim());
  var washF = fld(extra, "Chemical and seed wash downs", input(j, "washdowns", {num: true, strict: true, on: changed}), " ");
  add(extra, "span", "f-l", "Hazards and complexity");
  Object.keys(PRICES.HAZARDS).forEach(function(k){
    checkbox(extra, hz, k, PRICES.HAZARDS[k].tick, function(){
      j.hazards = Object.keys(PRICES.HAZARDS).filter(function(x){ return hz[x]; });
      changed();
    });
  });

  add(sec, "h2", "sec", "The price");
  var out = add(sec, "div", "stack");
  out.dataset.out = "qPrice";

  function paint(){
    var r = priceOf(q), t = C.quoteTotals(q.lines, q.gstOn, q.gstRate);
    r.apps.forEach(function(a, i){
      var u = uis[i], typed = j.apps[i];
      var areaHint = i === 0 ? siteHint(q, typed) : "";
      hintOf(u.area).textContent = areaHint;
      hintOf(u.area).hidden = !areaHint;
      u.label.hidden = a.rv !== "other";
      /* The rule is the Quote Builder's. What shows is not left to chance: any box a message asks
         for is on show, and so is any box holding a number that can't be read, so there's always
         something to fix. Hours are the way out while the job is hourly and only wants hours. */
      var hoursWay = a.hourly && (!a.poa || a.needHours);
      u.price.hidden = hoursWay && !unreadable(typed.price);
      u.price.classList.toggle("override", a.custom);
      hintOf(u.price).textContent = a.custom ? "Your own price for this job." : !C.isZero(a.listP) ? "Straight off the price list. Change it for a one-off price." : "The price list has no rate for this one. Put your own price in.";
      u.hoursRow.hidden = !(a.byHour || hoursWay || unreadable(typed.hours) || unreadable(typed.hourly));
      u.hourly.classList.toggle("override", C.cmp(a.jobHourly, usual) !== 0);
      var ownPriceWins = a.byHour && !a.hourly;
      u.why.hidden = !(a.byHour || hoursWay);
      u.why.textContent = ownPriceWins
        ? "Charge by is set to the hour, but there are no hours in yet, so your own price of $" + C.decimal(a.price) + " a hectare is being used. Put the hours on site in and it charges by the hour."
        : a.hourlyWhy;
      if(a.poa && !a.onlyArea) u.more.open = true;
    });
    var each = "$" + C.decimal(r.setupEach);
    hintOf(locF).textContent = r.locs > 0
      ? each + " each operating location, " + C.moneyOf(C.mul(C.R(r.locs), r.setupEach)) + " on this job."
      : each + " each operating location. Leave at 0 if you are not charging it.";
    var wash = "$" + C.decimal(r.washEach);
    hintOf(washF).textContent = r.washes > 0
      ? wash + " each, " + C.moneyOf(C.mul(C.R(r.washes), r.washEach)) + " on this job."
      : wash + " each. Leave at 0 if there is no wash down.";
    hintOf(kmF).textContent = r.local
      ? "Inside the " + C.decimal(r.localKm) + " km local zone. No travel charge."
      : "Out of local range. " + C.decimal(r.minAwayHrs) + " hour minimum applies. Travel is the full round trip at " + C.moneyOf(r.travelRate) + "/km.";
    priceOut(out, q, r, t);
  }
  return paint;
}
/* Every number on a priced quote that can't be read, in words. Any one of them stops it going out. */
function quoteUnreadable(q, r, t){
  var j = q.job || {}, out = r.bad.map(function(w){ return w + " can't be read. Numbers only, like 12.5."; });
  q.lines.forEach(function(l, i){
    if(t.lines[i].bad) out.push((String(l.desc || "").trim() || "A line you typed") + ": the quantity or the rate can't be read. Numbers only, like 12.5.");
  });
  if(t.gstBad) out.push("The GST rate can't be read. Numbers only, like 10.");
  [["deposit","Deposit"],["validDays","Valid for, days"],["followDays","Follow up in, days"]].forEach(function(x){
    if(unreadable(j[x[0]])) out.push(x[1] + " can't be read. Numbers only, like 12.5.");
  });
  return out;
}
function priceOut(out, q, r, t){
  out.textContent = "";
  add(out, "div", "q-basis", r.local ? "LOCAL / WITHIN " + C.decimal(r.localKm) + " KM" : "OUT OF RANGE / " + C.plainText(r.km) + " KM");
  if(r.poa){
    var box, stopped = r.apps.filter(function(a){ return a.poa; });
    if(r.bad.length) box = note(out, "stop", "A number can't be read.", "Fix it and the price will work itself out.");
    else if(stopped.every(function(a){ return a.onlyArea; })) box = note(out, "", "No price yet.");
    else box = note(out, "", "P.O.A. Set your own price.", "The price list does not put a rate on this job. " + (stopped.some(function(a){ return a.byHour || a.needHours; })
      ? "Put the hours on site in above and it works the whole quote out from there."
      : stopped.some(function(a){ return C.isZero(a.area); })
        ? "Put the hectares and your own figure in Price per hectare above, or switch Charge by to the hour."
        : "Put your own figure in Price per hectare above, or switch Charge by to the hour."));
    box.dataset.out = "qPoa";
    var ul = add(box, "ul");
    r.reasons.forEach(function(x){ add(ul, "li", null, x); });
  }
  /* the sheet won't let a quote out with one of these, so the form says so as well */
  var unread = r.bad.length ? [] : quoteUnreadable(q, r, t);
  if(unread.length && (r.poa || !t.bad)){
    var sb = note(out, "stop", "A number on this quote can't be read.", "Fix it before you send this.");
    sb.dataset.out = "qUnread";
    var sl = add(sb, "ul");
    unread.forEach(function(x){ add(sl, "li", null, x); });
  }
  var shown = q.lines.filter(function(l, i){ return !t.lines[i].blank || l.desc; });
  if(shown.length){
    var list = add(out, "div", "q-lines");
    q.lines.forEach(function(l, i){
      var c = t.lines[i];
      if(c.blank && !l.desc) return;
      var row = add(list, "div", "q-line"), d = add(row, "div", "q-line-d", l.desc);
      var sub = l.auto ? l.note : [l.qty + (l.unit ? " " + l.unit : ""), l.rate ? "at " + rateText(l.rate) : ""].filter(Boolean).join(" ");
      if(sub) add(d, "span", "q-line-c", sub);
      add(row, "div", "q-line-a", c.bad ? "Check this" : c.total === null ? "" : C.money(c.total));
    });
  }
  r.flags.forEach(function(f){
    var w = add(out, "div", "q-flag" + (f.warn ? " warn" : ""));
    add(w, "span", "q-flag-t", f.tag);
    add(w, "span", null, f.txt);
  });
  if(r.poa){
    if(shown.length) add(out, "p", "hint", "Your typed lines come to " + C.money(t.subtotal) + " on top of the P.O.A.");
    return;
  }
  var box2 = add(out, "div", "totals panelish");
  box2.id = "qTotals";
  box2.innerHTML = totalsHtml(q, t);
  var dep = depositOf(q);
  if(dep > 0){
    var dr = add(box2, "div");
    add(dr, "span", null, "Deposit before the job (" + dep + "%)");
    add(dr, "span", null, C.money(depositCents(q, t)));
  }
}
/* the typed lines: the whole form on a typed quote, folded away on a priced one */
function typedLines(host, q, save, refresh){
  var n = 0;
  q.lines.forEach(function(l, i){
    if(l.auto) return;
    n++;
    var card = add(host, "div", "prod");
    fld(card, "Line " + n + " description", input(l, "desc", {on: function(){ save(); if(q.job) refresh(); }}));
    var r2 = add(card, "div", "two");
    fld(r2, "Quantity", input(l, "qty", {num: true, strict: true, on: function(){ save(); refresh(); }}));
    var un = input(l, "unit", {on: save});
    un.setAttribute("list", "unitList");
    fld(r2, "Unit", un);
    fld(card, "Unit rate, $" + (q.gstOn ? " excluding GST" : ""), input(l, "rate", {num: true, strict: true, signed: true, on: function(){ save(); refresh(); }}));
    add(card, "p", "line-total").id = "lt-" + l.id;
    var acts = add(card, "div", "btns");
    btn(acts, "Keep for reuse", "ghost small", function(){
      if(!(l.desc || "").trim()){ toast("Give the line a description first."); return; }
      var same = S.items.filter(function(it){ return it.desc === l.desc && it.unit === l.unit; })[0];
      var it = same || {};
      it.desc = l.desc; it.unit = l.unit; it.rate = l.rate;
      put("items", it).then(function(){ toast("Kept for reuse"); rerender(); });
    });
    btn(acts, "Remove line", "danger small", function(){
      if(!confirm("Remove this line?")) return;
      /* the priced lines ahead of it come and go as the job is typed, so its place can have moved */
      var at = q.lines.indexOf(l);
      if(at >= 0) q.lines.splice(at, 1);
      if(!q.job && !q.lines.length) q.lines.push(blankLine());
      save();
      rerender();
    });
  });
  var dl = add(host, "datalist");
  dl.id = "unitList";
  ["ha","acre","hour","km","each","job"].forEach(function(u){ add(dl, "option").value = u; });
  btn(host, "Add a line", "ghost", function(){ q.lines.push(blankLine()); save(); rerender(); });
  if(S.items.length){
    var pick = {v: ""};
    fld(host, "Add a saved line", select(pick, "v", [["","Choose a saved line"]].concat(S.items.slice().sort(function(a, b){ return (a.desc || "").localeCompare(b.desc || ""); }).map(function(it){ return [it.id, it.desc]; })), {on: function(v){
      var it = byId("items", v);
      if(!it) return;
      var site = byId("paddocks", q.paddockId);
      /* a per hectare line picks up the site's hectares, ready to check */
      q.lines.push({id: uid(), desc: it.desc, unit: it.unit, rate: it.rate, qty: it.unit === "ha" && site && site.ha ? site.ha : ""});
      save();
      rerender();
    }}));
  }
}
function quoteView(q){
  refreshDraftClient(q);
  refreshDraftCard(q);
  push(function(){
    setTitle("Quote " + (q.number || ""));
    backBtn();
    var sec = add(app, "section");
    var typedOnce = !!byId("quotes", q.id), paint = null;
    function save(){ typedOnce = true; put("quotes", q).catch(function(){}); }
    function refresh(){
      var t = C.quoteTotals(q.lines, q.gstOn, q.gstRate);
      q.lines.forEach(function(l, i){
        var e = document.getElementById("lt-" + l.id), r = t.lines[i];
        if(e) e.textContent = r.bad ? "Check this line: numbers only" : r.total === null ? "" : "Line total " + C.money(r.total);
      });
      if(paint){ paint(); return; }
      var box = document.getElementById("qTotals");
      if(box) box.innerHTML = totalsHtml(q, t);
    }
    var dupe = S.quotes.some(function(x){ return x.id !== q.id && x.number === q.number; });
    function details(form){
      var r = add(form, "div", "two");
      fld(r, "Quote number", input(q, "number", {on: save}));
      fld(r, "Date", input(q, "date", {type: "date", on: save}));
      if(dupe) add(form, "p", "msg-bad", "Another quote already has this number.");
      fld(form, "Status", select(q, "status", QUOTE_STATUS.map(function(s){ return [s, s]; }), {on: save}));
    }
    function gstForm(form){
      chipRow(form, [["on","GST on"],["off","GST off"]], q.gstOn ? "on" : "off", function(v){ q.gstOn = v === "on"; save(); rerender(); });
      if(q.gstOn) fld(form, "GST rate, %", input(q, "gstRate", {num: true, strict: true, need: true, on: function(){ save(); refresh(); }}));
    }
    var f = panelForm(sec);
    clientBox(f, q, function(c){ quoteClient(q, c); save(); rerender(); }, save);
    var pads = S.paddocks.filter(function(p){ return p.clientId === q.clientId; });
    if(pads.length){
      fld(f, "Site", select(q, "paddockId", [["","Pick a site"]].concat(pads.map(function(p){ return [p.id, p.name + (p.ha ? " (" + fmtN(num(p.ha), 2) + " ha)" : "")]; })), {on: function(v){
        quoteSite(q, byId("paddocks", v));
        save();
        rerender();
      }}));
    }
    fld(f, "Site or location", input(q, "location", {on: save}));

    if(q.job){
      var sameCard = sameData(q.job.card, rateCard());
      if(q.status !== "Draft" && !sameCard) note(sec, "", "This quote keeps the rates it was made with.", "Copy it to a new quote to use today's rates.");
      if(q.ratesHeld && q.status === "Draft"){
        if(sameCard) delete q.ratesHeld;
        else {
          var hn = note(sec, "", "This draft keeps the rates it was made with.", "It came through a backup and your rates on this phone are different, so its price hasn't moved.");
          hn.dataset.out = "qHeld";
          btn(hn, "Move it to this phone's rates", "small", function(){
            delete q.ratesHeld;
            jobUseCurrentCard(q);
            save();
            rerender();
          });
        }
      }
      var anyTyped = q.lines.some(function(l){ return !l.auto; });
      if(!anyTyped) delete q.linesKept;
      if(q.linesKept) note(sec, "", "Your old lines are still on this quote.", "They add on top of the price below. Take out any the price list now covers, or the job gets charged twice.").dataset.out = "qKept";
      paint = jobForm(sec, q, save);
      typedLines(add(fold(sec, "Extra lines you type yourself", anyTyped), "div", "stack"), q, save, refresh);
      var j = q.job, gstStuck = q.gstOn && !C.parse(q.gstRate);
      var more = foldForm(sec, "Number, status, GST, deposit and notes", dupe || gstStuck || unreadable(j.deposit) || unreadable(j.validDays) || unreadable(j.followDays));
      details(more);
      add(more, "span", "f-l", "GST");
      gstForm(more);
      fld(more, "Deposit, %", input(j, "deposit", {num: true, strict: true, on: function(){ save(); refresh(); }}));
      var r3 = add(more, "div", "two");
      fld(r3, "Valid for, days", input(j, "validDays", {num: true, strict: true, on: function(){ save(); refresh(); }}));
      fld(r3, "Follow up in, days", input(j, "followDays", {num: true, strict: true, on: function(){ save(); refresh(); }}));
      fld(more, "Reference", input(j, "ref", {ph: "Optional, theirs or yours", on: save}));
      fld(more, "Lead source", select(j, "leadSource", LEAD_SOURCES.map(function(s){ return [s, s]; }), {on: save}));
      fld(more, "Notes on the quote", input(q, "notes", {area: true, on: save}));
    } else {
      details(f);
      add(sec, "h2", "sec", "Line items");
      typedLines(sec, q, save, refresh);
      btn(sec, "Work it out from the price list", "ghost", function(){
        var kept = q.lines.filter(function(l){ return String(l.desc || "").trim() || String(l.qty || "").trim() || String(l.rate || "").trim(); });
        if(kept.length && !confirm("Work this quote out from the price list?\n\nThe lines on it now stay on the quote and add on top of the price, so a job can get charged twice. Take out any line the price list now covers.")) return;
        q.job = newJob();
        q.lines = kept;
        if(kept.length) q.linesKept = true;
        fillSiteHa(q, byId("paddocks", q.paddockId));
        writePriced(q);
        save();
        rerender();
      });
      add(sec, "h2", "sec", "GST");
      gstForm(panelForm(sec));
      var totals = add(sec, "div", "totals panelish");
      totals.id = "qTotals";
      fld(panelForm(sec), "Notes on the quote", input(q, "notes", {area: true, on: save}));
    }
    btn(sec, "View, share or print", "", function(){ save(); quoteSheet(q); });
    btn(sec, "Copy to a new quote", "ghost", function(){ save(); copyQuote(q); });
    btn(sec, "Start a job from this quote", "ghost", function(){ save(); jobFromQuote(q); });
    if(q.job) btn(sec, "Just type my own lines", "ghost", function(){
      var priced = priceOf(q).poa ? "Nothing is priced on this job yet, so no priced lines come across." : "What's priced now stays as typed lines, with its wording.";
      if(!confirm("Stop working this quote out from the price list?\n\n" + priced + "\n\nThe hazards, deposit, valid days, follow up days, reference and lead source come off this quote.")) return;
      q.lines.forEach(function(l){
        if(!l.auto) return;
        /* the water rate, the product and "Lifted to the minimum" live in the note, which a typed line hasn't got */
        var n = String(l.note || "").replace(/\.\s+\.\s+/g, ". ").trim().replace(/\.$/, "");
        if(n) l.desc = l.desc + ". " + n;
        l.id = uid();
        delete l.auto;
        delete l.note;
      });
      delete q.job;
      delete q.poa;
      delete q.linesKept;
      delete q.ratesHeld;
      if(!q.lines.length) q.lines.push(blankLine());
      save();
      rerender();
    });
    if(typedOnce) btn(sec, "Delete this quote", "danger", function(){
      if(!confirm("Delete this quote for good?")) return;
      del("quotes", q.id).then(back);
    });
    refresh();
  });
  markRoute({k: "quote", rid: q.id});
}
function copyQuote(q){
  var n = clone(q);
  n.id = uid();
  n.number = nextQuoteNumber();
  n.date = todayISO();
  n.status = "Draft";
  delete n.ratesHeld;
  n.lines.forEach(function(l){ if(!l.auto) l.id = uid(); });
  if(n.job) jobUseCurrentCard(n);
  put("quotes", n).then(function(){ quoteView(n); });
}
function jobFromQuote(q){
  var j = newJobItem();
  j.clientId = q.clientId;
  j.quoteNumber = q.number;
  if(q.paddockId) j.paddockIds = [q.paddockId];
  jobView(j);
}
function quoteText(q){
  if(q.job) return pricedText(q);
  var b = cfg().business || {}, qc = quoteCfg(), t = C.quoteTotals(q.lines, q.gstOn, q.gstRate), out = [];
  if(b.name) out.push(b.name);
  out.push("Quote " + q.number + ". " + fmtDate(q.date), "");
  if(q.clientName) out.push(q.clientName);
  if(q.contact) out.push(q.contact);
  if(q.location) out.push(q.location);
  if(q.clientName || q.contact || q.location) out.push("");
  q.lines.forEach(function(l, i){
    if(t.lines[i].blank && !l.desc) return;
    var bits = [l.desc];
    if(l.qty) bits.push(l.qty + (l.unit ? " " + l.unit : ""));
    if(l.rate) bits.push(rateText(l.rate) + (l.unit ? " per " + l.unit : ""));
    if(t.lines[i].total !== null) bits.push(C.money(t.lines[i].total));
    out.push(bits.filter(Boolean).join(", "));
  });
  out.push("");
  out.push((q.gstOn ? "Subtotal, excluding GST " : "Subtotal ") + C.money(t.subtotal));
  if(q.gstOn) out.push("GST (" + q.gstRate + "%) " + C.money(t.gst));
  out.push((q.gstOn ? "TOTAL INCLUDING GST " : "TOTAL ") + C.money(t.total));
  if(q.notes) out.push("", q.notes);
  if(qc.footer) out.push("", qc.footer);
  var who = [b.name, b.phone, b.email, b.abn ? "ABN " + b.abn : ""].filter(Boolean);
  if(who.length) out.push("", who.join("\n"));
  return out.join("\n");
}
function copyText(text, done){
  function fallback(){
    var t = el("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    try { document.execCommand("copy"); } catch(e){}
    t.remove();
    done();
  }
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
/* Once a quote has gone anywhere it isn't a draft any more, so it stops moving with today's rates. */
function markGone(q, st){
  if(q.status !== "Draft") return "";
  q.status = "Quoted";
  if(st) st.value = "Quoted";
  put("quotes", q).catch(function(){});
  return " Marked as Quoted.";
}
function toastGone(q, st){
  var m = markGone(q, st);
  if(m) toast(m.trim());
}
function shareQuoteText(q, st){
  var text = quoteText(q);
  function copied(){ toast("Copied. Paste it into an email or message." + markGone(q, st)); }
  if(navigator.share){
    navigator.share({title: "Quote " + q.number, text: text}).then(function(){ toast("Handed to your phone's share menu. Nothing is sent until you send it there." + markGone(q, st)); }, function(e){
      if(e && e.name !== "AbortError") copyText(text, copied);
    });
  } else copyText(text, copied);
}
function copyQuoteText(q, st){
  copyText(quoteText(q), function(){ toast("Copied. Paste it into an email or message." + markGone(q, st)); });
}
function saveQuoteCsv(q, st){
  shareFile(new Blob([csvQuoteLines(q)], {type: "text/csv"}), "Quote-" + safeName(q.number) + ".csv", "Quote " + q.number).then(function(done){
    if(done) toastGone(q, st);
  });
}
function printQuote(q, st){
  window.print();
  toastGone(q, st);
}
function quoteSheet(q){
  if(q.job){ pricedSheet(q); return; }
  refreshDraftClient(q);
  push(function(){
    setTitle("Quote " + q.number);
    backBtn();
    var sec = add(app, "section");
    var b = cfg().business || {}, qc = quoteCfg(), t = C.quoteTotals(q.lines, q.gstOn, q.gstRate);
    var ctl = add(sec, "div", "stack no-print");
    var st = select(q, "status", QUOTE_STATUS.map(function(s){ return [s, s]; }), {on: function(){ put("quotes", q).catch(function(){}); }});
    fld(ctl, "Status", st);
    btn(ctl, "Edit this quote", "", function(){ quoteView(q); });
    var a1 = add(ctl, "div", "btns");
    var sh = btn(a1, "Share as text", "ghost", function(){ shareQuoteText(q, st); });
    var cp = btn(a1, "Copy text", "ghost", function(){ copyQuoteText(q, st); });
    var a2 = add(ctl, "div", "btns");
    var pr = btn(a2, "Print or save PDF", "ghost", function(){ printQuote(q, st); });
    btn(a2, "Save CSV", "ghost", function(){ saveQuoteCsv(q, st); });
    if(t.bad){ sh.disabled = true; cp.disabled = true; pr.disabled = true; }
    var a3 = add(ctl, "div", "btns");
    btn(a3, "Copy to a new quote", "ghost", function(){ copyQuote(q); });
    btn(a3, "Start a job", "ghost", function(){ jobFromQuote(q); });
    if(!b.name && !b.abn) note(ctl, "", "Your business name and ABN aren't on this quote yet.", "Add them under Backup and setup.");

    var sheet = add(sec, "div", "sheet paper");
    if(b.name) add(sheet, "h2", null, b.name);
    if(b.abn) add(sheet, "div", null, "ABN " + b.abn);
    [b.address, b.phone, b.email].filter(Boolean).forEach(function(x){ add(sheet, "div", null, x); });
    add(sheet, "h3", null, "Quote " + q.number);
    add(sheet, "div", null, fmtDate(q.date));
    if(q.clientName){ var who = add(sheet, "p"); add(who, "b", null, q.clientName); if(q.contact){ add(who, "br"); who.appendChild(document.createTextNode(q.contact)); } }
    if(q.location) add(sheet, "p", null, q.location);
    var tw = add(sheet, "div", "tblw"), tb = add(tw, "table", "tbl");
    var hr = add(add(tb, "thead"), "tr");
    ["Description","Qty","Unit","Rate","Total"].forEach(function(h){ add(hr, "th", null, h); });
    var bd = add(tb, "tbody");
    q.lines.forEach(function(l, i){
      if(t.lines[i].blank && !l.desc) return;
      var tr = add(bd, "tr");
      add(tr, "td", null, l.desc);
      add(tr, "td", "n", l.qty);
      add(tr, "td", null, l.unit);
      add(tr, "td", "n", rateText(l.rate));
      add(tr, "td", "n", t.lines[i].total === null ? "" : C.money(t.lines[i].total));
    });
    add(sheet, "div", "totals").innerHTML = totalsHtml(q, t);
    if(q.notes) add(sheet, "p", "pre", q.notes);
    if(qc.footer) add(sheet, "p", "pre", qc.footer);
  });
  markRoute({k: "sheet", rid: q.id});
}

/* ─────────── the priced quote: its text, its document, its PDF and its Pipeline row ─────────── */
/* The customer text, line for line as the Quote Builder writes it. Only the quote number on the
   second line, GST off, typed lines and notes are this app's own. */
function pricedText(q){
  var r = priceOf(q), t = C.quoteTotals(q.lines, q.gstOn, q.gstRate), w = quoteCfg().words, b = quoteBusiness();
  var dep = depositOf(q), W = 56, L = [];
  function row(a, c){ return String(a).padEnd(W) + String(c).padStart(12); }
  var contact = String(q.contact || "").trim(), biz = String(q.clientName || "").trim(), job = String(q.location || "").trim();
  L.push(String(b.name || "").toUpperCase());
  L.push("Quote " + q.number + ". " + longDate(quoteDate(q)));
  L.push("");
  if(contact) L.push(contact);
  if(biz) L.push(biz);
  if(contact || biz) L.push("");

  L.push("THE JOB");
  if(job) L.push(job);
  var many = r.apps.length > 1, ind = many ? "   " : "";
  r.apps.forEach(function(a, k){
    L.push((many ? (k + 1) + ". " : "") + a.name + (!C.isZero(a.area) ? ", " + C.plainText(a.area) + " ha" : ""));
    if(a.label) L.push(ind + (a.rv === "other" ? "Application" : PRICES.META[a.svc].rateLabel) + ": " + a.label);
    if(a.product) L.push(ind + "Product: " + a.product);
  });
  if(r.hz.length) L.push("Hazards noted: " + r.hzText + ".");
  if(!r.apps.some(function(a){ return a.product; })) L.push("Product: supplied by you.");
  L.push("");

  function typedRows(){
    q.lines.forEach(function(l, i){
      var c = t.lines[i];
      if(l.auto || (c.blank && !l.desc)) return;
      L.push(row(l.desc, c.total === null ? "" : C.money(c.total)));
      if(String(l.qty || "").trim()) L.push("  " + l.qty + (l.unit ? " " + l.unit : "") + (l.rate ? " at " + rateText(l.rate) : ""));
    });
  }
  if(r.poa){
    L.push("PRICE");
    L.push("Price on application. This job sits outside the standard rates:");
    r.reasons.forEach(function(x){ L.push("  - " + x); });
    L.push("");
    L.push("Happy to look at a map or walk the block and give you a firm");
    L.push("number. Give me a call.");
    if(q.lines.length){ L.push(""); L.push("ALSO ON THIS QUOTE, ON TOP OF THE ABOVE"); typedRows(); }
  } else {
    L.push("PRICE");
    q.lines.forEach(function(l, i){
      if(!l.auto) return;
      L.push(row(l.desc, C.money(t.lines[i].total)));
      L.push("  " + l.note);
    });
    typedRows();
    L.push(row("", "------------"));
    L.push(row(q.gstOn ? "Subtotal, excluding GST" : "Subtotal", C.money(t.subtotal)));
    if(q.gstOn) L.push(row("GST", C.money(t.gst)));
    L.push(row("", "============"));
    L.push(row(q.gstOn ? "TOTAL INCLUDING GST" : "TOTAL", C.money(t.total)));
    L.push("");
    if(dep > 0){
      L.push("Deposit of " + dep + "% (" + C.money(depositCents(q, t)) + ") before the job starts.");
      L.push("Balance within 7 days of invoice.");
    }
  }
  if(q.notes) L.push("", q.notes);

  L.push("");
  L.push("WHAT I NEED FROM YOU");
  var need = String(w.textNeed || "").split("\n");
  if(r.anyAir && w.textAir){
    var at = need.length - 1;
    while(at > 0 && need[at].charAt(0) !== "-") at--;
    Array.prototype.splice.apply(need, [at, 0].concat(w.textAir.split("\n")));
  }
  need.forEach(function(x){ L.push(x); });
  L.push("");
  L.push("TERMS");
  String(w.textTerms || "").split("\n").forEach(function(x){ L.push(x); });
  /* the licence line, never the footer: a footer was typed for typed quotes and could say anything */
  if(String(w.licence || "").trim()){
    L.push("");
    L.push("LICENSED AND INSURED");
    String(w.licence).split("\n").forEach(function(x){ L.push(x); });
  }
  L.push("");
  [b.signText, b.name, b.phone, b.email, b.abn ? "ABN " + b.abn : ""].filter(Boolean).forEach(function(x){ L.push(x); });
  return L.join("\n");
}
/* Everything the document says, in one place, so the screen and the PDF can't disagree. */
function docParts(q){
  var r = priceOf(q), t = C.quoteTotals(q.lines, q.gstOn, q.gstRate), w = quoteCfg().words, b = quoteBusiness(), j = q.job;
  var dep = depositOf(q);
  var billTo = [q.contact ? "Attn: " + q.contact : "", q.clientName, q.location, q.email, q.phone].map(function(x){ return String(x || "").trim(); }).filter(Boolean);
  if(!billTo.length) billTo.push("Client details not filled in yet");
  var ours = [b.name ? "trading as " + b.name : ""].concat(String(b.address || "").split("\n"), [b.abn ? "ABN " + b.abn : "", b.email, b.phone]).filter(Boolean);
  var figs = [
    {k: r.poa ? "Price" : q.gstOn ? "Total inc GST" : "Total", v: r.poa ? "P.O.A." : C.money(t.total), big: true},
    {k: "Valid until", v: shortDate(addDays(quoteDate(q), Math.max(1, Math.round(parseFloat(j.validDays) || 30))))},
    {k: "Issue date", v: shortDate(quoteDate(q))},
    {k: "Quote number", v: q.number || ""}
  ];
  if(String(j.ref || "").trim()) figs.push({k: "Reference", v: j.ref.trim()});
  var tax = q.gstOn ? q.gstRate + "%" : "";
  var rows = [];
  q.lines.forEach(function(l, i){
    var c = t.lines[i];
    if(c.blank && !l.desc) return;
    /* a priced line says which one it is, so it can't pick up its neighbour's figures */
    var src = l.auto ? r.lines[parseInt(String(l.id).slice(4), 10)] : null;
    rows.push({
      d: l.desc, sub: l.auto ? l.note : "",
      q: src ? src.q : String(l.qty || "") + (l.unit ? " " + l.unit : ""),
      u: src ? (src.u ? C.moneyOf(src.u).replace("$", "") : "") : rateText(l.rate).replace("$", ""),
      tax: tax, a: c.total === null ? "" : C.money(c.total).replace("$", "")
    });
  });
  var totals = [[q.gstOn ? "Subtotal" : "Subtotal, no GST", C.money(t.subtotal).replace("$", "")]];
  if(q.gstOn) totals.push(["Total GST " + q.gstRate + "%", C.money(t.gst).replace("$", "")]);
  totals.push([q.gstOn ? "Total inc GST" : "Total", C.money(t.total), "grand"]);
  if(dep > 0) totals.push(["Deposit before the job (" + dep + "%)", C.money(depositCents(q, t)), "dep"]);
  var need = String(w.docNeed || "").split("\n").filter(Boolean);
  if(r.anyAir && w.docAir) need.splice(Math.max(0, need.length - 1), 0, w.docAir);
  var terms = String(w.docTerms || "").split("\n").filter(Boolean);
  if(dep > 0 && terms[0]) terms[0] = terms[0].replace(/^Deposit before/, "Deposit of " + dep + "% before");
  return {
    r: r, t: t, billTo: billTo, legal: b.legal || b.name || "", ours: ours, figs: figs, rows: rows, totals: totals, need: need, terms: terms,
    poaCall: "Happy to look at a map or walk the block and give you a firm price." + (b.signText && b.phone ? " Give " + b.signText + " a call on " + b.phone + "." : ""),
    licence: String(w.licence || "").replace(/\s*\n\s*/g, " ").trim(), notes: q.notes || "",
    sign: [b.signDoc, b.name, b.phone, b.email].filter(Boolean), logoAlt: b.name || ""
  };
}
function quoteDoc(host, q){
  var d = docParts(q), doc = add(host, "div", "qdoc");
  var top = add(doc, "div", "qd-top");
  add(top, "div", "qd-title", "Quote");
  var logo = add(top, "img", "qd-logo");
  logo.src = self.STEL_LOGO;
  logo.alt = d.logoAlt;
  function lines(p, list){ list.forEach(function(x){ add(p, "div", null, x); }); }
  var par = add(doc, "div", "qd-parties");
  var p1 = add(par, "div", "qd-party");
  add(p1, "div", "qd-lbl", "Prepared for");
  lines(p1, d.billTo);
  var p2 = add(par, "div", "qd-party right");
  add(p2, "div", "qd-lbl", d.legal);
  lines(p2, d.ours);
  var figs = add(doc, "div", "qd-figs");
  d.figs.forEach(function(f){
    var w = add(figs, "div", "qd-fig" + (f.big ? " big" : ""));
    add(w, "div", "k", f.k);
    add(w, "div", "v", f.v);
  });
  add(doc, "div", "qd-rule");
  if(d.r.poa){
    var pb = add(doc, "div", "qd-poa");
    add(pb, "b", null, "Price on application");
    add(pb, "div", null, "This job sits outside our standard rates, so we will not put a number on it sight unseen:");
    var ul = add(pb, "ul");
    d.r.reasons.forEach(function(x){ add(ul, "li", null, x); });
    add(pb, "div", "qd-gap", d.poaCall);
  }
  if(d.rows.length){
    var tb = add(add(doc, "div", "tblw"), "table", "qd-items");
    var hr = add(add(tb, "thead"), "tr");
    ["Description","Quantity","Price","Tax","Amount"].forEach(function(h){ add(hr, "th", null, h); });
    var bd = add(tb, "tbody");
    d.rows.forEach(function(x){
      var tr = add(bd, "tr"), c = add(tr, "td", null, x.d);
      if(x.sub) add(c, "span", "qd-sub", x.sub);
      add(tr, "td", "qd-num", x.q);
      add(tr, "td", "qd-num", x.u);
      add(tr, "td", "qd-num", x.tax);
      add(tr, "td", "qd-num", x.a);
    });
  }
  if(!d.r.poa){
    var tt = add(add(doc, "div", "qd-totals"), "table"), tbody = add(tt, "tbody");
    d.totals.forEach(function(x){
      var tr = add(tbody, "tr", x[2] || null);
      add(tr, "td", null, x[0]);
      add(tr, "td", "qd-num", x[1]);
    });
  }
  if(d.notes) add(doc, "p", "pre qd-notes", d.notes);
  var cols = add(doc, "div", "qd-cols");
  [["What we need from you", d.need], ["Terms", d.terms]].forEach(function(g){
    var col = add(cols, "div", "qd-col");
    add(col, "div", "qd-h", g[0]);
    var u = add(col, "ul");
    g[1].forEach(function(x){ add(u, "li", null, x); });
  });
  if(d.r.hz.length){
    var hz = add(doc, "div", "qd-lic");
    add(hz, "b", null, "Hazards noted on site. ");
    hz.appendChild(document.createTextNode(d.r.hzText + ". Please confirm these are complete before we fly."));
  }
  if(d.licence){
    var lic = add(doc, "div", "qd-lic");
    add(lic, "b", null, "Licensed and insured. ");
    lic.appendChild(document.createTextNode(d.licence));
  }
  var sign = add(doc, "div", "qd-sign");
  lines(sign, d.sign);
}
function quotePdf(q){
  return loadScript("./vendor/jspdf.umd.min.js").then(function(){
    var d = docParts(q), doc = new window.jspdf.jsPDF({unit: "mm", format: "a4"});
    var W = 210, M = 14, CW = W - M * 2, BOTTOM = 282, y = M, BLUE = [38, 34, 97], INK = [17, 17, 17], SOFT = [85, 85, 85];
    function need(h){ if(y + h > BOTTOM){ doc.addPage(); y = M; } }
    function font(size, bold, col){
      doc.setFontSize(size);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      var c = col || INK;
      doc.setTextColor(c[0], c[1], c[2]);
    }
    function wrap(s, w){ return doc.splitTextToSize(pdfSafe(s), w); }
    function rule(col, wide){ doc.setDrawColor(col[0], col[1], col[2]); doc.setLineWidth(wide); doc.line(M, y, W - M, y); }

    font(22, true);
    doc.text("Quote", M, y + 7);
    doc.addImage(self.STEL_LOGO, "PNG", W - M - 48, y - 3, 48, 48 * 200 / 440);
    y += 24;

    var startY = y;
    font(9, true);
    doc.text("Prepared for", M, y);
    y += 4;
    font(9, false);
    d.billTo.forEach(function(s){ wrap(s, CW / 2 - 4).forEach(function(l){ doc.text(l, M, y); y += 4; }); });
    var leftEnd = y;
    y = startY;
    font(9, true);
    doc.text(pdfSafe(d.legal), W - M, y, {align: "right"});
    y += 4;
    font(9, false);
    d.ours.forEach(function(s){ wrap(s, CW / 2 - 4).forEach(function(l){ doc.text(l, W - M, y, {align: "right"}); y += 4; }); });
    y = Math.max(leftEnd, y) + 3;

    var x = M;
    d.figs.forEach(function(f){
      font(8, false, SOFT);
      doc.text(f.k, x, y);
      font(f.big ? 14 : 11, true);
      var v = pdfSafe(f.v);
      doc.text(v, x, y + 6);
      x += Math.max(doc.getTextWidth(v), 22) + 8;
    });
    y += 10;
    rule(BLUE, .6);
    y += 5;

    if(d.r.poa){
      font(10, true);
      doc.text("Price on application", M, y);
      y += 5;
      font(9, false);
      wrap("This job sits outside our standard rates, so we will not put a number on it sight unseen:", CW).forEach(function(l){ doc.text(l, M, y); y += 4; });
      d.r.reasons.forEach(function(s){ wrap("- " + s, CW - 3).forEach(function(l){ need(4); doc.text(l, M + 3, y); y += 4; }); });
      y += 1;
      wrap(d.poaCall, CW).forEach(function(l){ need(4); doc.text(l, M, y); y += 4; });
      y += 4;
    }
    if(d.rows.length){
      var cols = [{t: "Description", w: 92, l: true}, {t: "Quantity", w: 26}, {t: "Price", w: 22}, {t: "Tax", w: 12}, {t: "Amount", w: 30}];
      var head = function(){
        font(8, true, SOFT);
        var cx = M;
        cols.forEach(function(c){ cx += c.w; if(c.l) doc.text(c.t, M, y); else doc.text(c.t, cx, y, {align: "right"}); });
        y += 1.5;
        rule([187, 187, 187], .2);
        y += 4;
      };
      head();
      d.rows.forEach(function(x2){
        font(9, false);
        var dl = wrap(x2.d, 88);
        font(8, false, SOFT);
        var sl = x2.sub ? wrap(x2.sub, 88) : [];
        var h = dl.length * 4 + sl.length * 3.4 + 2;
        if(y + h > BOTTOM){ doc.addPage(); y = M; head(); }
        var yy = y;
        font(9, false);
        dl.forEach(function(l){ doc.text(l, M, yy); yy += 4; });
        font(8, false, SOFT);
        sl.forEach(function(l){ doc.text(l, M, yy); yy += 3.4; });
        font(9, false);
        var cx = M + cols[0].w;
        [x2.q, x2.u, x2.tax, x2.a].forEach(function(v, i){ cx += cols[i + 1].w; doc.text(pdfSafe(v), cx, y, {align: "right"}); });
        y += h;
        rule([226, 226, 226], .2);
        y += 4;
      });
    }
    if(!d.r.poa){
      need(d.totals.length * 6 + 4);
      d.totals.forEach(function(x2){
        var big = x2[2] === "grand";
        font(big ? 11 : 9.5, big || x2[2] === "dep", x2[2] === "dep" ? BLUE : big ? INK : SOFT);
        doc.text(pdfSafe(x2[0]), W - M - 40, y, {align: "right"});
        font(big ? 11 : 9.5, big || x2[2] === "dep", x2[2] === "dep" ? BLUE : INK);
        doc.text(pdfSafe(x2[1]), W - M, y, {align: "right"});
        y += big ? 6 : 5;
      });
      y += 2;
    }
    if(d.notes){
      font(9, false);
      wrap(d.notes, CW).forEach(function(l){ need(4); doc.text(l, M, y); y += 4; });
      y += 2;
    }
    function bullets(title, list, cx, cw){
      var yy = y;
      font(8, true, BLUE);
      doc.text(title.toUpperCase(), cx, yy);
      yy += 4.5;
      font(8.2, false);
      list.forEach(function(s){ wrap("- " + s, cw).forEach(function(l){ doc.text(l, cx, yy); yy += 3.6; }); yy += .6; });
      return yy;
    }
    /* the two columns stay on one page together */
    font(8.2, false);
    var cw = CW / 2 - 4;
    function colH(list){ return list.reduce(function(s, x2){ return s + wrap("- " + x2, cw).length * 3.6 + .6; }, 5); }
    need(Math.max(colH(d.need), colH(d.terms)) + 2);
    y += 2;
    var e1 = bullets("What we need from you", d.need, M, cw), e2 = bullets("Terms", d.terms, M + CW / 2 + 4, cw);
    y = Math.max(e1, e2) + 2;
    function lic(head2, body){
      font(8.2, false);
      var ls = wrap(head2 + " " + body, CW);
      need(ls.length * 3.8 + 4);
      rule([221, 221, 221], .2);
      y += 4;
      ls.forEach(function(l){ doc.text(l, M, y); y += 3.8; });
      y += 1;
    }
    if(d.r.hz.length) lic("Hazards noted on site.", d.r.hzText + ". Please confirm these are complete before we fly.");
    if(d.licence) lic("Licensed and insured.", d.licence);
    y += 2;
    font(9, false);
    need(d.sign.length * 4);
    d.sign.forEach(function(s){ doc.text(pdfSafe(s), M, y); y += 4; });

    var pages = doc.getNumberOfPages();
    for(var i = 1; i <= pages; i++){
      doc.setPage(i);
      font(7.5, false, SOFT);
      doc.text("Page " + i + " of " + pages, W - M, 291, {align: "right"});
    }
    return doc.output("blob");
  });
}
/* the 13 columns of the owner's CRM Pipeline tab, as the Quote Builder fills them */
var PIPE_COLS = [["A","Date Quoted"],["B","Property / Business Name"],["C","Contact Name"],["D","Email"],["E","Phone"],["F","Service Quoted"],["G","Area (ha)"],["H","Quote Value ($ ex GST)"],["I","Status"],["J","Date Won / Lost"],["K","Reason if Lost"],["L","Follow Up Date"],["M","Notes"]];
function pipeCells(q){
  var r = priceOf(q), t = C.quoteTotals(q.lines, q.gstOn, q.gstRate), j = q.job, notes = [];
  var many = r.apps.length > 1;
  if(r.poa){
    notes.push("P.O.A.");
    r.reasons.forEach(function(x){ notes.push(x.replace(/\.$/, "")); });
  } else {
    r.apps.forEach(function(a){
      var pre = many ? a.crm + " " : "", tail = a.product ? " (" + a.product + ")" : "";
      if(a.hourly) notes.push(pre + C.plainText(a.hrs) + " hrs @ $" + C.plainText(a.jobHourly) + "/hr" + tail);
      else notes.push(pre + C.plainText(a.area) + " ha @ $" + C.plainText(a.price) + "/ha, " + a.label + (a.custom ? ", own price" : "") + tail);
    });
    if(r.minApplied) notes.push("minimum charge applied");
    if(r.locs > 1) notes.push(r.locs + " operating locations");
    if(r.washes > 0) notes.push(r.washes + " wash down" + (r.washes > 1 ? "s" : "") + " " + C.moneyOf(r.wash));
    if(!r.local) notes.push(C.plainText(r.km) + " km out, travel " + C.moneyOf(r.travel));
    notes.push((q.gstOn ? "Total inc GST " : "Total ") + C.money(t.total));
  }
  if(r.hz.length) notes.push("Hazards: " + r.hzText);
  var job = String(q.location || "").trim();
  if(job) notes.push(job);
  if(j.leadSource) notes.push("Lead: " + j.leadSource);
  var follow = addDays(quoteDate(q), Math.max(0, Math.round(parseFloat(j.followDays) || 0)));
  return [
    slashDate(quoteDate(q)),
    String(q.clientName || "").trim(),
    String(q.contact || "").trim(),
    String(q.email || "").trim(),
    String(q.phone || "").trim(),
    r.apps.map(function(a){ return a.crm; }).filter(function(v, k, arr){ return arr.indexOf(v) === k; }).join(", "),
    C.isZero(r.area) ? "" : C.plainText(r.area),
    r.poa ? "" : plain(t.subtotal),
    /* the CRM has no Draft: copying the row across is what makes it quoted */
    q.status === "Draft" ? "Quoted" : q.status,
    "",
    "",
    slashDate(follow),
    notes.join(". ")
  ];
}
function pricedSheet(q){
  refreshDraftClient(q);
  refreshDraftCard(q);
  push(function(){
    setTitle("Quote " + q.number);
    backBtn();
    var sec = add(app, "section");
    var t = C.quoteTotals(q.lines, q.gstOn, q.gstRate), stuck = quoteUnreadable(q, priceOf(q), t);
    /* a number nobody can read stops every way out, and the page says which number */
    if(stuck.length){
      var why = note(sec, "stop", "This quote can't go out yet.", "A number on it can't be read, so sharing, copying, the PDF, printing, the Pipeline row and the CSV are all stopped. Tap Edit this quote and fix it.");
      why.dataset.out = "qStuck";
      var wl = add(why, "ul");
      stuck.forEach(function(x){ add(wl, "li", null, x); });
    }
    var ctl = add(sec, "div", "stack no-print");
    var st = select(q, "status", QUOTE_STATUS.map(function(s){ return [s, s]; }), {on: function(){ put("quotes", q).catch(function(){}); rerender(); }});
    fld(ctl, "Status", st);
    btn(ctl, "Edit this quote", "", function(){ quoteView(q); });
    var a1 = add(ctl, "div", "btns");
    var sh = btn(a1, "Share as text", "ghost", function(){ shareQuoteText(q, st); });
    var cp = btn(a1, "Copy text", "ghost", function(){ copyQuoteText(q, st); });
    var a2 = add(ctl, "div", "btns");
    var pd = btn(a2, "Save as PDF", "ghost", function(){
      quotePdf(q).then(function(blob){ return shareFile(blob, "Quote-" + safeName(q.number) + ".pdf", "Quote " + q.number); }).then(function(done){
        if(done) toastGone(q, st);
      }).catch(function(e){ toast("The PDF didn't build. " + e.message); });
    });
    var pr = btn(a2, "Print", "ghost", function(){ printQuote(q, st); });
    var cs = btn(ctl, "Save CSV", "ghost", function(){ saveQuoteCsv(q, st); });
    var a3 = add(ctl, "div", "btns");
    btn(a3, "Copy to a new quote", "ghost", function(){ copyQuote(q); });
    btn(a3, "Start a job", "ghost", function(){ jobFromQuote(q); });

    var pf = fold(ctl, "Pipeline row for STEL-CRM", false);
    var pw = add(add(pf, "div", "panel"), "div", "form");
    add(pw, "p", "hint", "Open the CRM workbook, click the Pipeline tab, click the first empty cell in column A, paste. It fills all thirteen columns.");
    var cells = stuck.length ? [] : pipeCells(q);
    var pc = btn(pw, "Copy pipeline row", "ghost", function(){ copyText(cells.join("\t"), function(){ toast("Copied, now paste." + markGone(q, st)); }); });
    if(stuck.length){
      [sh, cp, pd, pr, cs, pc].forEach(function(b){ b.disabled = true; });
      return;
    }
    var dl = add(pw, "div", "pipe-cols");
    dl.dataset.out = "pipeRow";
    cells.forEach(function(v, i){
      var row = add(dl, "div");
      add(row, "span", "pipe-k", PIPE_COLS[i][0] + ". " + PIPE_COLS[i][1]);
      add(row, "span", null, v || "-");
    });
    add(pw, "p", "hint", "Quote Value goes in excluding GST, same as the rest of your sheet. Follow Up Date is the column that goes amber when it falls due, so do not leave it blank.");

    var tf = fold(ctl, "The quote as text", false);
    add(tf, "pre", "q-text", quoteText(q)).dataset.out = "quoteText";

    quoteDoc(add(sec, "div", "sheet"), q);
  });
  markRoute({k: "sheet", rid: q.id});
}
/* the rate card under Backup and setup */
function ratesForm(form){
  var card = rateCard();
  function saveIt(){ saveCfg().catch(function(){}); }
  add(form, "p", "hint", (cfg().ratesFrom ? "These started from the rates saved in the Quote Builder on this phone. " : "") + "Changes here stay on this phone and go in your backup. A draft moves to these rates when you next open it. Sharing, copying, printing or saving a quote marks it Quoted, and then it keeps the rates it went with. GST is under Quotes, below.");
  [["spray","Spraying, by water rate"],["spread","Spreading, by load"],["map","Mapping, by type"]].forEach(function(g){
    add(form, "h3", null, g[1]);
    card[g[0]].forEach(function(o){
      var row = add(form, "div", "two");
      fld(row, "Name", input(o, "t", {on: saveIt}));
      fld(row, "$ a hectare", input(o, "r", {num: true, strict: true, on: saveIt}));
    });
  });
  add(form, "h3", null, "Everything else");
  [["hourly","Hourly rate, $"],["setup","Set up per location, $"],["washFee","Wash down fee, $"],["localKm","Free travel zone, km"],
   ["travelSpray","Travel, spray and spread, $ a km"],["travelMap","Travel, mapping, $ a km"],["minLocalHrs","Minimum hours, local"],["minAwayHrs","Minimum hours, out of range"],
   ["minMapping","Minimum charge, mapping, $"],["spreadCut","Spreading goes hourly under, ha"],["mapCut","Mapping goes hourly under, ha"]].forEach(function(x){
    fld(form, x[1], input(card, x[0], {num: true, strict: true, on: saveIt}));
  });
  btn(form, "Reset to the price list", "ghost", function(){
    if(!confirm("Put every rate back to the price list?")) return;
    cfg().rates = clone(PRICES.DEFAULTS);
    saveIt();
    rerender();
  });
}
/* the wording under Backup and setup */
function wordingForm(form){
  var qc = quoteCfg(), w = qc.words, b = w.business;
  function saveIt(){ saveCfg().catch(function(){}); }
  function one(p, label, obj, key, area){
    var n = input(obj, key, {area: !!area, on: saveIt});
    n.dataset.f = "w-" + key;
    fld(p, label, n);
  }
  add(form, "p", "hint", "This is what prints on a quote worked out from the price list. Your business name, ABN, phone, email and address come from Your business above.");
  one(form, "Trust or legal name", b, "legal");
  one(form, "Sign off on the text", b, "signText");
  one(form, "Sign off on the document", b, "signDoc");
  one(form, "Licence line, printed under Licensed and insured", w, "licence", true);
  one(form, "What I need from you, on the text", w, "textNeed", true);
  one(form, "Spray and spread jobs also need, on the text", w, "textAir", true);
  one(form, "Terms, on the text", w, "textTerms", true);
  one(form, "What we need from you, on the document, one a line", w, "docNeed", true);
  one(form, "Spray and spread jobs also need, on the document", w, "docAir", true);
  one(form, "Terms, on the document, one a line", w, "docTerms", true);
  btn(form, "Reset the wording", "ghost", function(){
    if(!confirm("Put all this wording back as it first was?")) return;
    qc.words = clone(PRICES.WORDING);
    saveIt();
    rerender();
  });
}

/* ─────────── spreadsheets. Column names match the owner's CRM tabs where the same thing is meant ─────────── */
function csvOf(rows){ return "﻿" + rows.map(function(r){ return r.map(csvCell).join(","); }).join("\r\n") + "\r\n"; }
function csvClients(){
  var rows = [["Property / Business Name","Contact Name","Phone","Email","Property","Address","Site","Location","Area (ha)","Lot and plan","Notes"]];
  sortedClients().forEach(function(c){
    var pads = S.paddocks.filter(function(p){ return p.clientId === c.id; });
    (pads.length ? pads : [{}]).forEach(function(p){
      rows.push([c.name, c.contact, csvPhone(c.phone), c.email, c.property, c.address, p.name, p.address || p.locality, p.ha, p.lot, c.notes]);
    });
  });
  return csvOf(rows);
}
function csvQuotes(){
  var rows = [["Quote Number","Date Quoted","Property / Business Name","Contact Name","Email","Phone","Location","Subtotal ($ ex GST)","GST on","GST rate (%)","GST ($)","Total ($)","Status","Notes"]];
  S.quotes.forEach(function(q){
    var t = C.quoteTotals(q.lines, q.gstOn, q.gstRate), nope = "Can't be read";
    var stuck = !!q.job && quoteUnreadable(q, priceOf(q), t).length > 0;
    rows.push([q.number, q.date, q.clientName, q.contact, q.email, csvPhone(q.phone), q.location, stuck ? nope : plain(t.subtotal), q.gstOn ? "Yes" : "No", q.gstOn ? q.gstRate : "", stuck ? nope : plain(t.gst), stuck ? nope : q.job && q.poa ? "P.O.A." : plain(t.total), q.status, q.notes]);
  });
  return csvOf(rows);
}
function csvQuoteLines(only){
  var rows = [["Quote Number","Line","Description","Quantity","Unit","Unit Rate ($)","Line Total ($)"]];
  (only ? [only] : S.quotes).forEach(function(q){
    var t = C.quoteTotals(q.lines, q.gstOn, q.gstRate);
    q.lines.forEach(function(l, i){ rows.push([q.number, i + 1, l.desc, l.qty, l.unit, l.rate, t.lines[i].total === null ? "" : plain(t.lines[i].total)]); });
  });
  return csvOf(rows);
}
function csvJobs(){
  var rows = [["Due","Client","Paddocks","Area (ha)","Status","Pilot","Drone","Crop or situation","Purpose","Quote Number","Notes"]];
  S.jobs.forEach(function(j){
    var p = byId("people", j.pilotId), d = byId("drones", j.droneId);
    rows.push([j.due, clientName(j.clientId), jobPaddocks(j).map(function(x){ return x.name; }).join(", "), jobHa(j) ? roundHa(jobHa(j)) : "", j.status, p ? p.name : "", d ? d.name : "", j.situation, j.purpose, j.quoteNumber, j.notes]);
  });
  return csvOf(rows);
}

/* ═════════════ BACKUP AND RESTORE ═════════════ */
function phoneOnly(x){ var i = String(x.id); return i === "route" || i === "preRestore" || i.indexOf("stash:") === 0; }
function backupStores(){
  var out = {};
  STORES.forEach(function(s){
    out[s] = S[s].filter(function(x){ return !(s === "settings" && phoneOnly(x)); });
  });
  return out;
}
function backupText(){ return JSON.stringify({app: "stel-field", v: 2, at: nowStamp(), stores: backupStores()}); }
function backupNow(){
  /* Android's share menu refuses .json files, so this copy goes out as .txt. It restores the same. */
  var blob = new Blob([backupText()], {type: "text/plain"});
  return shareFile(blob, "STEL-Field-Backup-" + todayISO() + ".txt", "STEL Field backup").then(function(done){
    if(done === "download") done = confirm("Did the backup file save? Check your Downloads folder, then tap OK only if it's there.");
    if(done){
      cfg().lastBackup = nowStamp();
      saveCfg();
      toast("Backup made. Check it landed in OneDrive.");
    }
    return done;
  });
}
function backupJson(){
  saveFile(new Blob([backupText()], {type: "application/json"}), "STEL-Field-Backup-" + todayISO() + ".json");
  cfg().lastBackup = nowStamp();
  saveCfg();
  toast("Saved to your downloads. Move a copy off this phone.");
}
function readBackup(text){
  var d = JSON.parse(text);
  if(!d || (d.app !== "stel-field" && d.app !== "stel-spray") || !d.stores) throw new Error("That isn't a STEL Field or Spray Log backup file.");
  /* checked before anything is touched: a bad row part way through mustn't leave records half gone */
  STORES.forEach(function(s){
    var rows = d.stores[s];
    if(rows == null) return;
    if(!Array.isArray(rows) || !rows.every(function(x){ return x && x.id; })) throw new Error("That backup has damaged records in " + s + ".");
    if(s === "quotes" && !rows.every(function(q){ return Array.isArray(q.lines); })) throw new Error("That backup has a damaged quote.");
    if(s === "records" && !rows.every(function(r){ return Array.isArray(r.items) && Array.isArray(r.weather) && r.owner && r.applicator; })) throw new Error("That backup has a damaged spray record.");
  });
  return d;
}
function writeAll(next){
  return new Promise(function(res, rej){
    var tx = db.transaction(STORES, "readwrite");
    tx.oncomplete = function(){ saveWorked(); clearJournal(); loadAll().then(function(){ MIX = null; res(); }, rej); };
    tx.onerror = function(){ rej(tx.error); };
    tx.onabort = function(){ rej(tx.error || new Error("Restore stopped")); };
    try {
      STORES.forEach(function(s){
        var os = tx.objectStore(s);
        os.clear();
        (next[s] || []).forEach(function(x){ os.put(x); });
      });
    } catch(e){ tx.abort(); }
  });
}
/* Replace: this phone becomes exactly what's in the file. What was here is kept once for Undo. */
function restoreReplace(d){
  var next = {};
  STORES.forEach(function(s){ next[s] = (d.stores[s] || []).slice(); });
  next.settings = next.settings.filter(function(x){ return !phoneOnly(x); });
  next.settings.push({id: "preRestore", at: nowStamp(), ms: Date.now(), snapshot: backupStores()});
  return writeAll(next);
}
/* Merge: bring records in. The newest copy of each wins and nothing here is removed.
   Your settings stay, apart from filling in business details that are still blank. */
function rowStamp(x){
  /* the old Spray Log never wrote updatedAt, but its records carry their own dates */
  return x.updatedAt || Math.max(Date.parse(x.updated || "") || 0, Date.parse(x.amendedAt || "") || 0, Date.parse(x.finishedAt || "") || 0);
}
function hasOwnRates(c){ return !!c.rates && !sameData(c.rates, PRICES.DEFAULTS); }
function hasOwnWording(c){
  var qc = c.quote || {};
  return !!String(qc.footer || "").trim() || (!!qc.words && !sameData(qc.words, PRICES.WORDING));
}
/* Resolves to anything the owner needs telling, or "". */
function restoreMerge(d){
  var next = {}, came = {};
  STORES.forEach(function(s){ next[s] = S[s].slice(); });
  STORES.forEach(function(s){
    if(s === "settings") return;
    (d.stores[s] || []).forEach(function(row){
      var i = next[s].map(function(x){ return x.id; }).indexOf(row.id);
      if(i < 0) next[s].push(row);
      else if(rowStamp(row) > rowStamp(next[s][i])) next[s][i] = row;
      else return;
      if(s === "quotes") came[row.id] = true;
    });
  });
  var theirs = (d.stores.settings || []).filter(function(x){ return x.id === "main"; })[0];
  var mine = clone(cfg()), keptRates = false, keptWording = false, cardMoved = false;
  if(theirs){
    mine.business = mine.business || {};
    Object.keys(theirs.business || {}).forEach(function(k){ if(!mine.business[k]) mine.business[k] = theirs.business[k]; });
    mine.labelNos = Object.assign({}, theirs.labelNos || {}, mine.labelNos || {});
    if(mine.pdfLicences === undefined && theirs.pdfLicences !== undefined) mine.pdfLicences = theirs.pdfLicences;
    /* A phone with no rates or wording of its own takes the backup's. One with its own keeps them. */
    if(theirs.rates){
      if(hasOwnRates(mine)) keptRates = !sameData(mine.rates, theirs.rates);
      else {
        cardMoved = !sameData(mine.rates || PRICES.DEFAULTS, theirs.rates);
        mine.rates = clone(theirs.rates);
        if(theirs.ratesFrom) mine.ratesFrom = theirs.ratesFrom; else delete mine.ratesFrom;
      }
    }
    var tq = theirs.quote || {}, theirFooter = String(tq.footer || "").trim();
    if(tq.words || theirFooter){
      if(hasOwnWording(mine)){
        var mq = mine.quote;
        keptWording = (!!tq.words && !sameData(tq.words, mq.words || PRICES.WORDING)) || (!!theirFooter && theirFooter !== String(mq.footer || "").trim());
      } else {
        mine.quote = Object.assign(freshQuoteCfg(), mine.quote || {});
        if(tq.words) mine.quote.words = clone(tq.words);
        if(theirFooter) mine.quote.footer = tq.footer;
      }
    }
    next.settings = next.settings.filter(function(x){ return x.id !== "main"; }).concat([mine]);
  }
  /* A draft moves to the phone's rates when it opens. One that just came in, or one whose phone just
     took new rates, would move to prices nobody picked, so it stays put until the owner says. */
  var card = mine.rates || rateCard(), held = 0;
  next.quotes = next.quotes.map(function(q){
    if(!q.job || q.status !== "Draft" || q.ratesHeld || !(came[q.id] || cardMoved) || sameData(q.job.card, card)) return q;
    var keep = clone(q);
    keep.ratesHeld = true;
    held++;
    return keep;
  });
  var say = [];
  if(keptRates || keptWording) say.push("This phone has its own " + (keptRates && keptWording ? "rates and wording" : keptRates ? "rates" : "quote wording") + ", so it kept them and the backup's weren't brought across.");
  if(held) say.push((held === 1 ? "1 draft keeps the rates it was made with" : held + " drafts keep the rates they were made with") + ". Open one to move it to this phone's rates.");
  return writeAll(next).then(function(){ return say.join(" "); });
}
function undoRestore(){
  var pre = byId("settings", "preRestore");
  if(!pre) return Promise.resolve();
  var next = {};
  STORES.forEach(function(s){ next[s] = (pre.snapshot[s] || []).slice(); });
  return writeAll(next);
}

/* ─────────── what the old Spray Log left on this phone ─────────── */
function readSprayLog(){
  if(!indexedDB.databases) return Promise.resolve(null);
  return indexedDB.databases().then(function(list){
    if(!list.some(function(x){ return x.name === "stel-spray"; })) return null;
    return new Promise(function(res){
      /* only ever read. The old app and its records are left exactly as they were */
      var r = indexedDB.open("stel-spray");
      r.onerror = function(){ res(null); };
      r.onsuccess = function(){
        var d = r.result, names = STORES.filter(function(s){ return d.objectStoreNames.contains(s); });
        if(!names.length){ d.close(); res(null); return; }
        var out = {}, tx = d.transaction(names), left = names.length;
        names.forEach(function(s){
          var q = tx.objectStore(s).getAll();
          q.onsuccess = function(){ out[s] = q.result || []; if(!--left){ d.close(); res({app: "stel-spray", stores: out}); } };
          q.onerror = function(){ if(!--left){ d.close(); res(null); } };
        });
      };
    });
  }).catch(function(){ return null; });
}
var sprayLogFound = null;
function sprayLogNew(){
  if(!sprayLogFound) return 0;
  var n = 0;
  STORES.forEach(function(s){
    if(s === "settings") return;
    (sprayLogFound.stores[s] || []).forEach(function(x){
      var have = byId(s, x.id);
      if(!have || rowStamp(x) > rowStamp(have)) n++;
    });
  });
  return n;
}
function bringSprayLog(){
  return restoreMerge(sprayLogFound).then(function(){
    cfg().sprayImported = nowStamp();
    return saveCfg();
  }).then(function(){ toast("Spray Log brought across. The old app wasn't changed."); rerender(); }, function(){ toast("That didn't work. Nothing here was changed."); });
}
function howMany(n, word){ return n + " " + word + (n === 1 ? "" : "s"); }
function sprayLogNote(p){
  if(!sprayLogNew() || cfg().sprayImported) return;
  var st = sprayLogFound.stores;
  var n = note(p, "good", "Your Spray Log is on this phone.", howMany((st.records || []).length, "spray record") + ", " + howMany((st.jobs || []).length, "job") + " and " + howMany((st.clients || []).length, "client") + ". Bring them into this app. The old app stays as it was.");
  btn(n, "Bring them across", "small", bringSprayLog);
}

/* ═════════════ HOME ═════════════ */
function homeView(){
  setTitle("Home");
  var sec = add(app, "section");
  var off = add(sec, "div");
  off.id = "offlineNote";
  showOfflineState();
  sprayLogNote(sec);
  if(deferredInstall){
    var i = note(sec, "good", "Install this app", "so it opens from the home screen and works with no internet.");
    btn(i, "Install", "small", function(){ deferredInstall.prompt(); deferredInstall = null; rerender(); });
  }
  banners(sec);
  var hero = btn(sec, "Mix calculator", "hero", function(){ setTab("mix"); });
  hero.dataset.go = "mix";
  var g = add(sec, "div", "btns");
  btn(g, "New job", "ghost", function(){ jobView(newJobItem()); });
  btn(g, "New quote", "ghost", function(){ quoteView(newQuoteItem()); });
  var open =S.jobs.filter(function(j){ return j.status === "planned" || j.status === "booked"; }).sort(function(a, b){
    if(!a.due) return 1;
    if(!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }).slice(0, 5);
  if(open.length){
    add(sec, "h2", "sec", "Next jobs");
    var list = listPanel(sec);
    open.forEach(function(j){
      rowItem(list, clientName(j.clientId) || j.clientName || "No client yet", [
        j.due ? {t: "Due " + fmtDate(j.due), k: daysFromToday(j.due) < 0 ? "stop" : ""} : null,
        jobHa(j) ? fmtN(jobHa(j), 2) + " ha" : null
      ], function(){ jobView(j); });
    });
  }
  var more = listPanel(sec);
  rowItem(more, "Spray records", [howMany(S.records.length, "record")], function(){ setTab("records"); });
  rowItem(more, "Backup and setup", [], function(){ setTab("setup"); });
}

/* ═════════════ BACKUP AND SETUP ═════════════ */
var restoreDraft = null;
var mergeSaid = "";
function setupView(){
  setTitle("Backup and setup");
  var sec = add(app, "section");
  var c = cfg();
  c.business = c.business || {};
  var qc = quoteCfg();
  function saveBiz(){ saveCfg(); }

  if(!S.people.length || !S.drones.length){
    note(sec, "good", "Start here.", "Add yourself and your drone below, once, and every spray record fills them in for you.");
  }
  sprayLogNote(sec);

  var bk = foldForm(sec, "Back up", true);
  add(bk, "div", "item-name", c.lastBackup ? "Last backup " + fmtDate(c.lastBackup) : "No backup yet");
  add(bk, "p", "hint", "Everything lives only on this phone, and each phone keeps its own. Losing the phone or clearing Chrome's data wipes it unless you have a backup. Save it to OneDrive.");
  if(persisted === true) add(bk, "div", "dt").appendChild(el("span", "tag good", "Android is protecting this app's storage"));
  if(persisted === false) add(bk, "p", "hint", "Android hasn't promised to protect this app's storage yet. Installing the app to the home screen usually fixes that.");
  var st = add(bk, "p", "hint");
  st.id = "offlineStatus";
  btn(bk, "Back up to OneDrive or email", "", function(){ backupNow().then(function(){ rerender(); }); });
  btn(bk, "Save backup file (.json)", "ghost", function(){ backupJson(); rerender(); });
  var pick = add(bk, "input", "filepick");
  pick.type = "file";
  pick.accept = ".txt,.json,application/json,text/plain";
  pick.setAttribute("aria-label", "Choose a backup file");
  pick.dataset.f = "restoreFile";
  pick.addEventListener("change", function(){
    var file = pick.files[0];
    if(!file) return;
    file.text().then(function(text){
      restoreDraft = readBackup(text);
      rerender();
    }).catch(function(e){
      restoreDraft = null;
      toast(/backup/i.test(e.message || "") ? e.message : "That file can't be read as a backup. Nothing was changed.");
      var m = document.getElementById("restoreMsg");
      if(m) m.textContent = e.message && /backup/i.test(e.message) ? e.message : "That file can't be read as a backup. Nothing was changed.";
    });
    pick.value = "";
  });
  btn(bk, "Open a backup file", "ghost", function(){ pick.click(); });
  add(bk, "p", "msg-bad").id = "restoreMsg";
  if(mergeSaid){
    note(bk, "", "Merged.", mergeSaid).dataset.out = "mergeSaid";
    mergeSaid = "";
  }
  if(restoreDraft){
    var d = restoreDraft, s = d.stores;
    function n(k){ return (s[k] || []).length; }
    var sum = note(bk, "good", d.importOnly ? "This import holds" : "This file holds", howMany(n("clients"), "client") + ", " + howMany(n("paddocks"), "site") + ", " + howMany(n("quotes"), "quote") + ", " + howMany(n("jobs"), "job") + ", " + howMany(n("records"), "spray record") + ", " + howMany(n("recipes"), "saved mix").replace("mixs", "mixes") + " and " + howMany(n("items"), "saved line") + ".");
    sum.dataset.out = "restoreSummary";
    btn(bk, "Merge: add these, newest copy of each wins", "", function(){
      restoreMerge(d).then(function(said){
        restoreDraft = null;
        mergeSaid = said;
        toast(said ? "Merged. " + said : "Merged.");
        rerender();
      }, restoreFailed);
    });
    /* an import or an old Spray Log file only holds part of the picture, so it can't replace what's here */
    if(!d.importOnly && d.app === "stel-field"){
      btn(bk, "Replace everything on this phone", "danger", function(){
        if(!confirm("Replace everything on this phone with this file? You can undo it once.")) return;
        restoreReplace(d).then(function(){ restoreDraft = null; toast("Replaced. Undo is below."); rerender(); }, restoreFailed);
      });
    }
    btn(bk, "Cancel", "ghost", function(){ restoreDraft = null; rerender(); });
  }
  /* offered for a day only: after that, putting it back would wipe real work */
  var pre = byId("settings", "preRestore");
  if(pre && Date.now() - (pre.ms || 0) < 86400000){
    btn(bk, "Undo the last replace", "ghost", function(){
      if(!confirm("Put everything back as it was before the replace on " + fmtDate(pre.at) + "? Anything added since then will be lost.")) return;
      undoRestore().then(function(){ toast("Put back as it was."); rerender(); }, restoreFailed);
    });
  }
  function restoreFailed(){ toast("Couldn't restore that. Nothing on this phone was changed."); rerender(); }

  var biz = foldForm(sec, "Your business", !c.business.name);
  add(biz, "p", "hint", "This goes on your quotes and spray records. It stays on this phone. A box left blank here prints the price list's wording on a quote off the price list, and stays blank on typed quotes and spray records.");
  fld(biz, "Trading name", input(c.business, "name", {on: saveBiz}));
  fld(biz, "ABN", input(c.business, "abn", {on: saveBiz}));
  fld(biz, "Address", input(c.business, "address", {area: true, on: saveBiz}));
  var r = add(biz, "div", "two");
  fld(r, "Phone", input(c.business, "phone", {type: "tel", on: saveBiz}));
  fld(r, "Email", input(c.business, "email", {type: "email", on: saveBiz}));
  fld(biz, "Terms or licence line for the bottom of a quote you type yourself", input(qc, "footer", {area: true, on: saveBiz}), "A quote off the price list prints the licence line under Quote wording and sign off instead.");

  var ppl = fold(sec, "Pilots (" + S.people.length + ")", !S.people.length);
  if(S.people.length){
    var pl = listPanel(ppl);
    S.people.forEach(function(p){ rowItem(pl, p.name, [p.phone || null], function(){ personView(p); }); });
  }
  btn(ppl, "Add a person", "ghost", function(){ personView({}); });

  var dr = fold(sec, "Drones (" + S.drones.length + ")", !S.drones.length);
  if(S.drones.length){
    var dl = listPanel(dr);
    S.drones.forEach(function(x){ rowItem(dl, x.name, [x.rego || "No registration mark", x.tank ? x.tank + " L tank" : null], function(){ droneView(x); }); });
  }
  btn(dr, "Add a drone", "ghost", function(){ droneView({}); });

  var soon = licenceAlerts().length;
  var lic = fold(sec, "Licences (" + S.licences.length + ")", !!soon);
  if(S.licences.length){
    var ll = listPanel(lic);
    S.licences.slice().sort(function(a, b){ return (a.expiry || "9") < (b.expiry || "9") ? -1 : 1; }).forEach(function(l){
      var days = l.expiry ? daysFromToday(l.expiry) : null;
      rowItem(ll, l.kind, [
        l.number || null,
        l.expiry ? {t: "To " + fmtDate(l.expiry), k: days < 0 ? "stop" : days <= 30 ? "warn" : "good"} : null,
        l.photo ? "Photo" : null
      ], function(){ licenceView(l); });
    });
  }
  btn(lic, "Add a licence", "ghost", function(){ licenceView({kind: LICENCE_KINDS[0]}); });

  ratesForm(foldForm(sec, "Your rates. Edit any of them", false));
  wordingForm(foldForm(sec, "Quote wording and sign off", false));

  var qf = foldForm(sec, "Quotes: GST, numbers and saved lines", false);
  add(qf, "span", "f-l", "GST on new quotes");
  chipRow(qf, [["on","GST on"],["off","GST off"]], qc.gstOn ? "on" : "off", function(v){ qc.gstOn = v === "on"; saveBiz(); rerender(); });
  var r2 = add(qf, "div", "two");
  fld(r2, "GST rate, %", input(qc, "gstRate", {num: true, strict: true, need: true, on: saveBiz}));
  fld(r2, "Numbers start with", input(qc, "prefix", {on: saveBiz}));
  add(qf, "h3", null, "Saved lines");
  if(!S.items.length) add(qf, "p", "hint", "None yet. Add your own here, or tap Keep for reuse on a quote line.");
  S.items.slice().sort(function(a, b){ return (a.desc || "").localeCompare(b.desc || ""); }).forEach(function(it){
    var card = add(qf, "div", "prod");
    function saveIt(){ put("items", it).catch(function(){}); }
    fld(card, "Description", input(it, "desc", {on: saveIt}));
    var rr = add(card, "div", "two");
    fld(rr, "Unit", input(it, "unit", {on: saveIt}));
    fld(rr, "Unit rate, $", input(it, "rate", {num: true, on: saveIt}));
    btn(card, "Delete this saved line", "danger small", function(){
      if(!confirm("Delete this saved line?")) return;
      del("items", it.id).then(rerender);
    });
  });
  btn(qf, "Add a saved line", "ghost small", function(){ put("items", {desc: "", unit: "", rate: ""}).then(rerender); });

  var cs = foldForm(sec, "Spreadsheet exports (CSV)", false);
  function sendCsv(name, text){ shareFile(new Blob([text], {type: "text/csv"}), "STEL-Field-" + name + "-" + todayISO() + ".csv", "STEL Field " + name); }
  var e1 = add(cs, "div", "btns");
  btn(e1, "Clients", "ghost", function(){ sendCsv("Clients", csvClients()); });
  btn(e1, "Quotes", "ghost", function(){ sendCsv("Quotes", csvQuotes()); });
  var e2 = add(cs, "div", "btns");
  btn(e2, "Quote lines", "ghost", function(){ sendCsv("Quote-lines", csvQuoteLines()); });
  btn(e2, "Jobs", "ghost", function(){ sendCsv("Jobs", csvJobs()); });
  btn(cs, "Spray records", "ghost", function(){ setTab("records"); });

  if(sprayLogFound && cfg().sprayImported){
    var again = foldForm(sec, "Old Spray Log", !!sprayLogNew());
    add(again, "p", "hint", sprayLogNew() ? sprayLogNew() + " things in the old Spray Log are newer or aren't here yet." : "Everything in the old Spray Log is here.");
    if(sprayLogNew()) btn(again, "Bring them across", "ghost", bringSprayLog);
  }

  var look = foldForm(sec, "Look", false);
  var th = {v: ls(LS_THEME, "light")};
  fld(look, "Theme", select(th, "v", [["light","Light, best in the sun"],["dark","Dark, for night work"],["auto","Follow the phone"]], {on: function(v){
    lsSet(LS_THEME, v);
    applyTheme();
  }}));

  var ab = fold(sec, "What needs internet, and where things come from", false);
  var cr = add(ab, "div", "credits");
  cr.appendChild(document.createTextNode("With no internet: clients, quotes, jobs, the mix calculator, spray records, product search, saved mixes, backups, PDFs and spreadsheets all still work. Needs internet: map pictures you haven't already looked at, lot and plan lookups, forecasts, opening an approved label, sending anything, and getting app updates, which land by themselves next time you open it."));
  add(cr, "br"); add(cr, "br");
  cr.appendChild(document.createTextNode("Product data from the APVMA PubCRIS open dataset, CC BY 3.0 AU"));
  var dataNote = add(cr, "span", "mono");
  fetch("./data/meta.json").then(function(r){ return r.json(); }).then(function(m){ dataNote.textContent = ", built " + m.built; }).catch(function(){});
  cr.appendChild(document.createTextNode(". Lot lookups from the State of Queensland. Map imagery can be a few years old: " + QLD_CREDIT + ". Forecasts from MET Norway, CC BY 4.0. Delta T guide from GRDC. Maps by Leaflet, PDFs by jsPDF."));
  add(cr, "br"); add(cr, "br");
  cr.appendChild(document.createTextNode("The record form follows Business Queensland's guidance on chemical records. Check it against your licence conditions. Other states may ask for different things."));
  showOfflineState();
}

/* ─────────── offline state ─────────── */
var offlineState = "checking";
function showOfflineState(){
  var msgs = {checking: "Checking the offline copy.", ready: "Offline copy: ready. Everything but the internet extras works with no signal.", no: "Offline copy: not ready. Open this app once with internet, from its proper web address."};
  var s = document.getElementById("offlineStatus");
  if(s) s.textContent = msgs[offlineState];
  var h = document.getElementById("offlineNote");
  if(h){
    h.textContent = "";
    if(offlineState === "no") note(h, "stop", "Not ready for no signal yet.", "Keep internet on until this message goes.");
  }
}
function checkOffline(){
  if(!self.caches || !navigator.serviceWorker){ offlineState = "no"; showOfflineState(); return; }
  Promise.all(["index.html","calc.js","rates.js","logo.js","app.js","data/products.json"].map(function(f){
    return caches.match(new URL(f, location.href).href);
  })).then(function(hits){
    offlineState = hits.every(Boolean) ? "ready" : "no";
    showOfflineState();
  }, function(){ offlineState = "no"; showOfflineState(); });
}
function startServiceWorker(){
  if(!navigator.serviceWorker || !/^https?:$/.test(location.protocol)){ offlineState = "no"; showOfflineState(); return; }
  navigator.serviceWorker.addEventListener("controllerchange", checkOffline);
  function notReady(){ offlineState = "no"; showOfflineState(); }
  navigator.serviceWorker.register("./sw.js").then(function(reg){
    var w = reg.installing;
    if(w) w.addEventListener("statechange", function(){ if(w.state === "redundant") notReady(); });
    setTimeout(function(){ if(offlineState === "checking") notReady(); }, 8000);
    navigator.serviceWorker.ready.then(checkOffline);
  }, notReady);
}

/* ─────────── start up ─────────── */
function applyTheme(){ document.documentElement.setAttribute("data-theme", ls(LS_THEME, "light")); }
applyTheme();
document.getElementById("mastLogo").src = self.STEL_LOGO;

ROOTS = {home: homeView, mix: mixView, clients: paddocksView, quotes: quotesView, jobs: jobsView, records: recordsView, setup: setupView};

window.addEventListener("beforeinstallprompt", function(e){
  e.preventDefault();
  deferredInstall = e;
  if(curTab === "home" && stack.length === 1) rerender();
});

dbOpen().then(loadAll).then(function(){
  replayJournal();
  var oldUndo = byId("settings", "preRestore");
  if(oldUndo && Date.now() - (oldUndo.ms || 0) >= 86400000) del("settings", "preRestore").catch(function(){});
  cfg();
  lastWrite = ls(LS_WRITE, "");
  var r = readRoute();
  stack = [{fn: homeView, y: 0}];
  history.replaceState({d: 1}, "");
  setTab(r && r.tab && ROOTS[r.tab] ? r.tab : "home");
  if(r && r.k !== "tab") openRoute(r);
  if(navigator.storage && navigator.storage.persist){
    navigator.storage.persist().then(function(v){ persisted = v; }, function(){});
  }
  startServiceWorker();
  readSprayLog().then(function(d){
    sprayLogFound = d;
    if(sprayLogNew() && curTab === "home" && stack.length === 1) rerender();
  });
}).catch(function(e){
  app.textContent = "";
  var sec = add(app, "section");
  note(sec, "stop", "Your records couldn't open.", (e && e.message ? e.message + " " : "") + "Nothing has been lost. Close the app and open it again.");
});

/* for the test pages only */
self.StelFieldTest = {
  S: function(){ return S; }, offlineState: function(){ return offlineState; }, quoteText: quoteText,
  csvOf: csvOf, csvClients: csvClients, csvQuotes: csvQuotes, csvJobs: csvJobs, backupText: backupText, sprayLogNew: sprayLogNew
};
