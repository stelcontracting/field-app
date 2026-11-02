"use strict";

/* ═══════════════════════════════════════════════════════════════════════
   CRM sync: this phone and the CRM workbook, both ways.

   Goes straight to the workbook in the business OneDrive through Microsoft's Excel
   service. No server, and no script on the computer. It can only run while the app is
   open with internet: on opening, soon after a change, and on Sync now. The rest of the
   app never waits on it and works the same with no internet and no sign-in.

   The rules:
     1. Rows pair up by name, never by position. A hidden ID column was the first plan,
        but both tabs' filters stop at the last column, so sorting in Excel would sort
        the rows and leave a column beside them behind, and every ID would then sit on
        the wrong person. By name, sorting can't hurt anything.
     2. Each side is compared with the last synced copy kept on the phone, field by field.
        Changed on one side: that side wins. Changed on both to different things: ask.
     3. Never delete a row or a record without asking, and never delete a row at all from
        here. Other columns on the row belong to Excel.
     4. Only the columns in CRM_TABS are ever written. Leads, Referral Partners, Lists and
        Start Here aren't opened.
     5. Nothing is written to a workbook on the first sync until the owner has seen what
        it would do and said go ahead.
     6. A sync that stops half way is safe: nothing here is saved until the writes have
        worked, and the next sync finds what already matches and carries on.
   ═══════════════════════════════════════════════════════════════════════ */

/* None of these is a secret. A phone app's sign-in has no password of its own: see the PKCE part below. */
var MS = {
  tenant: "f6367471-f198-44f5-a4d3-3a45337c2e3c",
  client: "01953f7e-3c66-4c5a-b8b8-a4adf55e0774",
  redirect: "https://stelcontracting.github.io/field-app/index.html",
  scope: "openid profile offline_access https://graph.microsoft.com/Files.ReadWrite",
  /* the owner said yes to the real one on 2 Nov 2026, after it was tested on a copy */
  workbook: "Documents/STEL-CRM.xlsx"
};
var MS_LOGIN = "https://login.microsoftonline.com/" + MS.tenant + "/oauth2/v2.0/";
var MS_GRAPH = "https://graph.microsoft.com/v1.0";
/* Sign-ins live in localStorage, away from the records, so they can't end up in a backup file. */
var LS_MS = "stel-field-ms";
var LS_PKCE = "stel-field-ms-pkce";
var LS_LOCK = "stel-field-ms-lock";
var CRM_STATE = "sync:state";
var CRM_CHANGE_WAIT = 20000;
var CRM_WAKE_GAP = 300000;
var crmBusy = false;
var crmApplying = false;
var crmTimer = null;
var crmTried = 0;
var crmMsg = null;    /* what the last try came to, if that's not a clean sync: {k: "stop" or "", t: words} */

var CRM_TABS = {
  Clients: {name: "Clients", fields: [
    {f: "name", head: "Property / Business Name", label: "Name"},
    {f: "contact", head: "Contact Name", label: "Contact"},
    {f: "phone", head: "Phone", label: "Phone", type: "phone"},
    {f: "email", head: "Email", label: "Email"},
    {f: "location", head: "Location", label: "Location"},
    {f: "notes", head: "Notes", label: "Notes"}
  ]},
  Pipeline: {name: "Pipeline", fields: [
    {f: "quotedOn", head: "Date Quoted", label: "Date quoted", type: "date"},
    {f: "name", head: "Property / Business Name", label: "Name"},
    {f: "contact", head: "Contact Name", label: "Contact"},
    {f: "email", head: "Email", label: "Email"},
    {f: "phone", head: "Phone", label: "Phone", type: "phone"},
    {f: "pipeService", head: "Service Quoted", label: "Service"},
    {f: "pipeArea", head: "Area (ha)", label: "Area, ha", type: "num"},
    {f: "pipeValue", head: "Quote Value ($ ex GST)", label: "Value, $ ex GST", type: "num", fmt: "\"$\"#,##0"},
    {f: "pipeStatus", head: "Status", label: "Status"},
    {f: "pipeClosed", head: "Date Won / Lost", label: "Date won or lost", type: "date"},
    {f: "pipeReason", head: "Reason if Lost", label: "Reason if lost"},
    {f: "followUp", head: "Follow Up Date", label: "Follow up", type: "date"},
    {f: "notes", head: "Notes", label: "Notes"}
  ]}
};
var CRM_DATE_FMT = "dd/mm/yyyy";

function crmStop(kind, words){ var e = new Error(words); e.crm = kind; return e; }
function crmFd(tab, f){ return CRM_TABS[tab].fields.filter(function(x){ return x.f === f; })[0]; }

/* ─────────── reading and writing a cell ─────────── */
function crmText(v){ return v == null ? "" : String(v).replace(/\r\n?/g, "\n").trim(); }
function crmKey(s){ return crmText(s).toLowerCase().replace(/\s+/g, " "); }
/* Excel keeps a mobile as a number, which drops the leading 0 */
function crmPhoneFix(s){ return /^4\d{8}$/.test(s) ? "0" + s : s; }
function crmPhoneKey(s){
  var d = crmText(s).replace(/\D/g, "");
  if(/^61\d{9}$/.test(d)) d = "0" + d.slice(2);
  return crmPhoneFix(d);
}
var CRM_EPOCH = Date.UTC(1899, 11, 30);
function crmSerial(iso){
  var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso);
  return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - CRM_EPOCH) / 86400000 : null;
}
/* A real date, or typed as dd/mm/yyyy. Anything else is words in a date box: null, and it's left alone. */
function crmDateOf(v){
  if(typeof v === "number") return isoFromUTC(CRM_EPOCH + Math.floor(v) * 86400000);
  var s = crmText(v), m;
  if(!s) return "";
  if(/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? m[3] + "-" + pad(+m[2]) + "-" + pad(+m[1]) : null;
}
function crmFromCell(fd, v){
  if(fd.type === "date") return crmDateOf(v);
  if(typeof v === "number"){
    if(fd.type === "phone") return crmPhoneFix(String(v));
    return String(+v.toFixed(6));
  }
  var s = crmText(v);
  return fd.type === "phone" ? crmPhoneFix(s) : s;
}
/* Excel reads what it's given the way it reads typing, so 0412 loses its 0, 1/2 turns into a date and
   =1+1 runs as a formula. An apostrophe in front keeps anything like that as the words it is. */
function crmWords(s){
  return /^[^A-Za-z]|^(true|false)$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s.,\/-]*\d/i.test(s) ? "'" + s : s;
}
function crmToCell(fd, v){
  v = crmText(v);
  if(v === "") return "";
  if(fd.type === "date"){ var n = crmSerial(v); return n === null ? crmWords(v) : n; }
  if(fd.type === "num" && !isNaN(num(v))) return num(v);
  return crmWords(v);
}
function crmSame(fd, a, b){
  a = crmText(a);
  b = crmText(b);
  if(a === b) return true;
  if(fd.type === "phone") return !!crmPhoneKey(a) && crmPhoneKey(a) === crmPhoneKey(b);
  if(fd.type === "num") return !isNaN(num(a)) && num(a) === num(b);
  return false;
}
function crmColIndex(letters){
  var n = 0;
  for(var i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n - 1;
}
function crmColName(i){
  var s = "";
  for(i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
  return s;
}
/* One tab, as Excel gave it, into rows named the way the app names them. Columns are found by their headings. */
function crmParse(tab, res){
  var def = CRM_TABS[tab], grid = res.values || [];
  var at = /^\$?([A-Z]+)\$?(\d+)/.exec(String(res.address || "").split("!").pop());
  if(!at) throw crmStop("layout", "The " + tab + " tab can't be read. Nothing was written.");
  var col0 = crmColIndex(at[1]), row0 = +at[2], head = -1, i;
  for(i = 0; i < grid.length && head < 0; i++){
    if(grid[i].map(crmText).indexOf("Property / Business Name") >= 0) head = i;
  }
  if(head < 0) throw crmStop("layout", "The " + tab + " tab has no heading row. Nothing was written.");
  var titles = grid[head].map(crmText), pos = {}, missing = [];
  def.fields.forEach(function(fd){
    var k = titles.indexOf(fd.head);
    if(k < 0) missing.push(fd.head); else pos[fd.f] = k;
  });
  if(missing.length) throw crmStop("layout", "The " + tab + " tab has changed. It has no " + missing.join(", ") + " column. Nothing was written.");
  var cols = {}, out = {tab: tab, cols: cols, rows: [], last: row0 + head, noName: 0};
  def.fields.forEach(function(fd){ cols[fd.f] = col0 + pos[fd.f]; });
  for(i = head + 1; i < grid.length; i++){
    var cells = grid[i], rowNo = row0 + i;
    if(!cells.some(function(v){ return crmText(v) !== ""; })) continue;
    out.last = rowNo;
    var biz = crmText(cells[pos.name]), who = crmText(cells[pos.contact]);
    /* some Pipeline rows only have a person's name, under Contact */
    var name = tab === "Pipeline" ? biz || who : biz;
    if(!name){ out.noName++; continue; }
    if(/^EXAMPLE ROW/i.test(name)) continue;
    var values = {}, locked = {};
    def.fields.forEach(function(fd){
      var got = crmFromCell(fd, cells[pos[fd.f]]);
      if(got === null){ locked[fd.f] = true; got = ""; }
      values[fd.f] = got;
    });
    values.name = name;
    values.contact = who === name ? "" : who;
    out.rows.push({row: rowNo, key: crmKey(name), biz: biz, who: who, values: values, locked: locked});
  }
  return out;
}

/* ─────────── what the phone says for a field ─────────── */
/* Someone in the pipeline who's been sent a quote: until they've got a figure of their own, the CRM gets the quote's */
function crmQuoteFacts(c){
  var q = latestQuote(c), out = {};
  if(!q || q.status === "Draft") return out;
  out.pipeStatus = q.status;
  out.quotedOn = quoteDate(q);
  try {
    var t = C.quoteTotals(q.lines, q.gstOn, q.gstRate);
    if(q.job){
      if(quoteUnreadable(q, priceOf(q), t).length) return out;
      var cells = pipeCells(q);
      out.pipeService = cells[5];
      out.pipeArea = cells[6];
      out.pipeValue = cells[7];
      out.followUp = addDays(quoteDate(q), Math.max(0, Math.round(parseFloat(q.job.followDays) || 0)));
    } else out.pipeValue = plain(t.subtotal);
  } catch(e){}
  return out;
}
function crmPhoneVal(r, f, facts){
  var v = r[f];
  return crmText(v == null || v === "" ? facts[f] : v);
}

/* ─────────── comparing ─────────── */
/* same, up to the CRM, down to the phone, leave both as they are, or ask */
function crmAct(fd, p, c, bp, bc){
  var f = fd.f;
  if(crmSame(fd, p, c)) return "same";
  if(!(f in bp)){
    /* the import file packed the CRM's other columns into the phone's notes, and they don't belong in its Notes column */
    if(f === "notes" && /From STEL-CRM\.xlsx/.test(p)) return "leave";
    if(p === "") return "down";
    if(c === "") return "up";
    return "ask";
  }
  var pc = !crmSame(fd, p, bp[f]), cc = !crmSame(fd, c, bc[f]);
  if(!pc && !cc) return "leave";
  if(pc && cc) return "ask";
  /* left different on purpose last time, so one side moving doesn't get to wipe out the other */
  if(!crmSame(fd, bp[f], bc[f])) return "ask";
  return pc ? "up" : "down";
}
function crmCompare(tabs, clients, st){
  var base = st.base, dec = st.decisions, ignore = st.ignore;
  var out = {rows: [], adds: [], phone: [], fresh: [], items: [], notes: [], base: {}};
  var by = {Clients: {}, Pipeline: {}}, held = {};
  ["Clients", "Pipeline"].forEach(function(tab){
    tabs[tab].rows.forEach(function(row){
      Object.keys(row.locked).forEach(function(f){
        out.notes.push(row.values.name + ": the " + crmFd(tab, f).label.toLowerCase() + " box in the CRM isn't a date, so it's left alone.");
      });
      if(!by[tab][row.key]){ by[tab][row.key] = row; return; }
      row.used = true;
      out.notes.push("More than one row called " + row.values.name + " on the " + tab + " tab. Row " + row.row + " is left alone.");
    });
    if(tabs[tab].noName) out.notes.push(howMany(tabs[tab].noName, "row") + " on the " + tab + " tab with no name, left alone.");
  });
  function use(row){ if(row) row.used = true; }
  function pair(r, row, tab, b, stageOff){
    var def = CRM_TABS[tab], facts = tab === "Pipeline" ? crmQuoteFacts(r) : {}, was = b && b.tab === tab ? b : null;
    var bp = was ? was.p : {}, bc = was ? was.c : {}, picks = (dec[r.id] || {}).fields || {};
    var np = {}, nc = {}, cells = {}, set = {}, had = {}, key = row.key;
    use(row);
    def.fields.forEach(function(fd){
      var f = fd.f;
      if(row.locked[f]){ if(f in bp){ np[f] = bp[f]; nc[f] = bc[f]; } return; }
      var p = crmPhoneVal(r, f, facts), c = row.values[f], act = crmAct(fd, p, c, bp, bc), pick = picks[f];
      if(act === "ask" && pick && crmSame(fd, pick.p, p) && crmSame(fd, pick.c, c)) act = {phone: "up", crm: "down", leave: "leave"}[pick.pick];
      if(act === "same" || act === "up"){
        np[f] = nc[f] = p;
        if(act === "up") cells[f] = p;
        if(f === "name") key = crmKey(p);
      } else if(act === "down"){
        np[f] = nc[f] = c;
        set[f] = c;
        had[f] = p;
      } else if(act === "leave"){
        np[f] = p;
        nc[f] = c;
      } else {
        if(f in bp){ np[f] = bp[f]; nc[f] = bc[f]; }
        out.items.push({kind: "field", id: r.id, who: r.name, f: f, tab: tab, label: fd.label, p: p, c: c});
      }
    });
    if(Object.keys(cells).length) out.rows.push({tab: tab, at: row, who: r.name, cells: cells});
    if(Object.keys(set).length || stageOff) out.phone.push({id: r.id, who: r.name, tab: tab, set: set, had: had, stageOff: !!stageOff});
    out.base[r.id] = {tab: tab, key: key, p: np, c: nc};
  }
  function addRow(r, tab){
    var facts = tab === "Pipeline" ? crmQuoteFacts(r) : {}, np = {}, nc = {}, cells = {};
    CRM_TABS[tab].fields.forEach(function(fd){
      var p = crmPhoneVal(r, fd.f, facts);
      np[fd.f] = nc[fd.f] = p;
      if(p !== "") cells[fd.f] = p;
    });
    out.adds.push({tab: tab, key: crmKey(r.name), who: r.name, cells: cells});
    out.base[r.id] = {tab: tab, key: crmKey(r.name), p: np, c: nc};
  }
  /* won on the phone: their Pipeline row says so and stays as the history of it */
  function closePipe(r, row){
    use(row);
    var cells = {};
    if(r.pipeStatus && !crmSame({}, r.pipeStatus, row.values.pipeStatus)) cells.pipeStatus = r.pipeStatus;
    if(r.pipeClosed && !row.locked.pipeClosed && r.pipeClosed !== row.values.pipeClosed) cells.pipeClosed = r.pipeClosed;
    if(Object.keys(cells).length) out.rows.push({tab: "Pipeline", at: row, who: r.name, cells: cells});
  }
  function gone(r, b, d){
    if(d.row === "putBack"){ addRow(r, b.tab); return; }
    out.base[r.id] = b;
    held[b.tab] = true;
    out.items.push({kind: "gone", id: r.id, who: r.name, tab: b.tab, canDelete: !clientInUse(r), maybe: []});
  }
  clients.forEach(function(r){
    var key = crmKey(r.name);
    if(!key) return;
    if(r.crmOff){ use(by.Clients[key]); use(by.Pipeline[key]); return; }
    var b = base[r.id], d = dec[r.id] || {};
    if(r.quick && !b && !clientInUse(r)) return;
    var cRow = (b && b.tab === "Clients" && by.Clients[b.key]) || by.Clients[key];
    var pRow = (b && b.tab === "Pipeline" && by.Pipeline[b.key]) || by.Pipeline[key];
    if(b && d.renamed && by[b.tab][d.renamed]){
      if(b.tab === "Clients") cRow = by.Clients[d.renamed]; else pRow = by.Pipeline[d.renamed];
    }
    var moving = !b || b.tab === "Pipeline";
    if(!isPotential(r)){
      if(pRow){ if(moving) closePipe(r, pRow); else use(pRow); }
      if(cRow){ pair(r, cRow, "Clients", b); return; }
      if(b && b.tab === "Clients"){ gone(r, b, d); return; }
      addRow(r, "Clients");
      return;
    }
    if(cRow){
      use(pRow);
      if(b && b.tab === "Clients"){
        /* moved back to the pipeline on the phone, and the row is still on the Clients tab */
        use(cRow);
        out.base[r.id] = b;
        out.items.push({kind: "moved", id: r.id, who: r.name});
        return;
      }
      pair(r, cRow, "Clients", b, true);
      return;
    }
    if(pRow){ pair(r, pRow, "Pipeline", b); return; }
    if(b && b.tab === "Pipeline"){ gone(r, b, d); return; }
    addRow(r, "Pipeline");
  });
  /* deleted on the phone, with the row still in the CRM */
  Object.keys(base).forEach(function(id){
    if(clients.some(function(c){ return c.id === id; })) return;
    var b = base[id], row = by[b.tab][b.key];
    if(!row) return;
    use(row);
    if((dec[id] || {}).row === "bringBack"){
      var rec = crmFreshRecord(row, b.tab);
      rec.id = id;
      out.fresh.push(rec);
      out.base[id] = crmRowBase(row, b.tab);
      return;
    }
    out.base[id] = b;
    out.items.push({kind: "phoneDel", id: id, who: row.values.name, tab: b.tab, key: b.key});
  });
  /* someone on both tabs is one client, and their Pipeline row stays in the workbook as history */
  var known = {};
  tabs.Clients.rows.forEach(function(row){
    known[row.key] = true;
    if(row.who) known[crmKey(row.who)] = true;
  });
  tabs.Pipeline.rows.forEach(function(row){
    if(known[row.key] || known[crmKey(row.biz)] || known[crmKey(row.who)]) use(row);
  });
  /* what's left is new in the CRM */
  ["Clients", "Pipeline"].forEach(function(tab){
    var free = tabs[tab].rows.filter(function(row){ return !row.used && !ignore[tab + "|" + row.key]; });
    if(held[tab]){
      /* a row gone and a new one here may be the same person renamed, so nothing new comes in until he's said */
      out.items.forEach(function(it){
        if(it.kind === "gone" && it.tab === tab) it.maybe = free.slice(0, 4).map(function(row){ return {key: row.key, name: row.values.name}; });
      });
      return;
    }
    free.forEach(function(row){
      var rec = crmFreshRecord(row, tab);
      rec.id = uid();
      out.fresh.push(rec);
      out.base[rec.id] = crmRowBase(row, tab);
    });
  });
  return out;
}
function crmFreshRecord(row, tab){
  var rec = {created: nowStamp()};
  if(tab === "Pipeline") rec.stage = "potential";
  CRM_TABS[tab].fields.forEach(function(fd){ if(row.values[fd.f]) rec[fd.f] = row.values[fd.f]; });
  return rec;
}
function crmRowBase(row, tab){
  var np = {}, nc = {};
  CRM_TABS[tab].fields.forEach(function(fd){
    if(!row.locked[fd.f]) np[fd.f] = nc[fd.f] = row.values[fd.f];
  });
  return {tab: tab, key: row.key, p: np, c: nc};
}

/* ─────────── the phone's record of the last sync ─────────── */
function crmState(){
  var st = byId("settings", CRM_STATE);
  if(!st) st = {id: CRM_STATE, base: {}, decisions: {}, ignore: {}, items: [], notes: []};
  return st;
}
function crmSave(st){ return put("settings", st); }
function crmEditorOpen(){
  return stack.some(function(x){ return x.route && x.route.k === "edit" && x.route.store === "clients"; });
}

/* ─────────── signing in to Microsoft ───────────
   PKCE, the way a web app does it with no password of its own: a random secret made on the
   phone for each sign-in, whose fingerprint goes out first and the secret itself only when
   the code comes back. Microsoft ends this kind of sign-in after 24 hours whatever we do, so
   about once a day it takes a tap, usually with nothing to type. */
function crmTokens(){ return lsJson(LS_MS); }
function crmSignedIn(){ var t = crmTokens(); return !!(t && t.rt); }
function crmB64(bytes){
  var s = "";
  bytes.forEach(function(b){ s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function crmRandom(n){ return crmB64(crypto.getRandomValues(new Uint8Array(n))); }
function crmAuthUrl(challenge, state){
  var q = new URLSearchParams({client_id: MS.client, response_type: "code", redirect_uri: MS.redirect, response_mode: "fragment", scope: MS.scope, code_challenge: challenge, code_challenge_method: "S256", state: state});
  return MS_LOGIN + "authorize?" + q.toString();
}
function crmSignIn(go){
  var v = crmRandom(48), s = crmRandom(16);
  lsSet(LS_PKCE, JSON.stringify({v: v, s: s}));
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)).then(function(h){
    var url = crmAuthUrl(crmB64(new Uint8Array(h)), s);
    (go || function(u){ location.assign(u); })(url);
    return url;
  });
}
function crmWhoFrom(idToken){
  try {
    var part = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(part)))).preferred_username || "";
  } catch(e){ return ""; }
}
function crmTokenCall(params){
  params.client_id = MS.client;
  params.scope = MS.scope;
  return fetch(MS_LOGIN + "token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams(params).toString()}).catch(function(){
    throw crmStop("net", "Couldn't reach Microsoft. It will try again when there's internet.");
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(j){
      if(!res.ok || !j.access_token){
        /* the sign-in has run out, or was turned down */
        if(res.status >= 400 && res.status < 500){
          var had = crmTokens();
          if(had){ delete had.rt; delete had.at; lsSet(LS_MS, JSON.stringify(had)); }
          throw crmStop("signin", "Sign in to Microsoft again to carry on syncing.");
        }
        throw crmStop("busy", "Microsoft's sign-in isn't answering. It will try again later.");
      }
      var was = crmTokens() || {};
      lsSet(LS_MS, JSON.stringify({at: j.access_token, atEnd: Date.now() + (j.expires_in || 3600) * 1000, rt: j.refresh_token || was.rt, who: (j.id_token && crmWhoFrom(j.id_token)) || was.who || ""}));
      return j.access_token;
    });
  });
}
function crmToken(){
  var t = crmTokens();
  if(!t || !t.rt) return Promise.reject(crmStop("signin", "Sign in to Microsoft first."));
  if(t.at && t.atEnd - Date.now() > 60000) return Promise.resolve(t.at);
  return crmTokenCall({grant_type: "refresh_token", refresh_token: t.rt});
}
/* Coming back from Microsoft's page: the code or the refusal arrives in the address. Taken out of it straight away. */
function crmReturn(){
  var h = location.hash;
  if(!/^#(.*&)?(code|error)=/.test(h)) return null;
  var q = new URLSearchParams(h.slice(1)), saved = lsJson(LS_PKCE);
  history.replaceState(null, "", location.pathname + location.search);
  try { localStorage.removeItem(LS_PKCE); } catch(e){}
  if(q.get("error")){
    crmMsg = {k: "stop", t: "Microsoft didn't finish the sign-in. " + (q.get("error_description") || q.get("error")).split(/\r?\n/)[0].slice(0, 200)};
    return Promise.resolve(false);
  }
  if(!saved || saved.s !== q.get("state")){
    crmMsg = {k: "stop", t: "That sign-in didn't match the one this app started, so it wasn't used. Try again."};
    return Promise.resolve(false);
  }
  return crmTokenCall({grant_type: "authorization_code", code: q.get("code"), redirect_uri: MS.redirect, code_verifier: saved.v}).then(function(){
    crmMsg = null;
    return true;
  }, function(e){
    crmMsg = {k: "stop", t: e.message};
    return false;
  });
}
function crmSignOut(){
  try { localStorage.removeItem(LS_MS); } catch(e){}
  crmMsg = null;
}

/* ─────────── Microsoft's Excel service ─────────── */
function crmError(res, j){
  var inner = j && j.error && j.error.innerError && j.error.innerError.code, code = String(inner || (j && j.error && j.error.code) || "").toLowerCase();
  if(res.status === 401) return crmStop("signin", "Sign in to Microsoft again to carry on syncing.");
  if(/accessconflict|conflictuncategorized|resourcelocked/.test(code) || res.status === 423 || res.status === 409){
    return crmStop("locked", "The CRM is tied up: Excel may have it open in a way that blocks this. Nothing was lost. It will try again later.");
  }
  if(res.status === 404) return crmStop("missing", "Couldn't find " + MS.workbook + " in OneDrive. Nothing was written.");
  if(res.status === 429 || res.status === 503 || res.status === 504) return crmStop("busy", "Microsoft is busy. Nothing was lost. It will try again later.");
  if(/unsupportedworkbook/.test(code)) return crmStop("layout", "Microsoft can't open the CRM this way. Nothing was written.");
  return crmStop("other", "Microsoft said no (" + res.status + (code ? " " + code : "") + "). Nothing was lost.");
}
function crmGraph(method, path, body, session, again){
  return crmToken().then(function(tok){
    var headers = {Authorization: "Bearer " + tok};
    if(body) headers["Content-Type"] = "application/json";
    if(session) headers["workbook-session-id"] = session;
    var ctl = new AbortController(), wait = setTimeout(function(){ ctl.abort(); }, 45000);
    return fetch(MS_GRAPH + path, {method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal}).then(function(res){
      clearTimeout(wait);
      if(res.status === 401 && !again){
        var t = crmTokens();
        if(t){ delete t.at; lsSet(LS_MS, JSON.stringify(t)); }
        return crmGraph(method, path, body, session, true);
      }
      if(res.status === 204) return null;
      return res.json().catch(function(){ return null; }).then(function(j){
        if(!res.ok) throw crmError(res, j);
        return j;
      });
    }, function(e){
      clearTimeout(wait);
      throw crmStop("net", e && e.name === "AbortError" ? "The internet's too slow to reach the CRM right now. It will try again later." : "Couldn't reach Microsoft. It will try again when there's internet.");
    });
  });
}
function crmSheet(item, tab){ return "/me/drive/items/" + item + "/workbook/worksheets('" + tab + "')"; }
function crmRead(item, tab, session){
  return crmGraph("GET", crmSheet(item, tab) + "/usedRange(valuesOnly=true)?$select=address,values", null, session).then(function(res){ return crmParse(tab, res); });
}
/* cells, by field, into one write across the row. A null in the grid leaves that cell exactly as it is. */
function crmRowWrite(item, parsed, rowNo, cells, session){
  var def = CRM_TABS[parsed.tab], lo = Infinity, hi = -1, values = [], formats = [], needFmt = false, i;
  def.fields.forEach(function(fd){ lo = Math.min(lo, parsed.cols[fd.f]); hi = Math.max(hi, parsed.cols[fd.f]); });
  for(i = lo; i <= hi; i++){ values.push(null); formats.push(null); }
  Object.keys(cells).forEach(function(f){
    var fd = crmFd(parsed.tab, f), k = parsed.cols[f] - lo;
    values[k] = crmToCell(fd, cells[f]);
    /* a row past the last one used has no date or dollar format yet */
    var fmt = fd.type === "date" ? CRM_DATE_FMT : fd.fmt;
    if(fmt && values[k] !== ""){ formats[k] = fmt; needFmt = true; }
  });
  var body = {values: [values]};
  if(needFmt) body.numberFormat = [formats];
  return crmGraph("PATCH", crmSheet(item, parsed.tab) + "/range(address='" + crmColName(lo) + rowNo + ":" + crmColName(hi) + rowNo + "')", body, session);
}
/* A row with only a person's name keeps it under Contact, the way it came. */
function crmPipeNames(cells, row){
  var out = Object.assign({}, cells);
  if(!row.biz && ("name" in cells || "contact" in cells)){
    var nm = "name" in cells ? cells.name : row.values.name, who = "contact" in cells ? cells.contact : row.values.contact;
    if(who){ out.name = nm; out.contact = who; }
    else { delete out.name; out.contact = nm; }
  }
  return out;
}
/* Rows are written one at a time, which is what Microsoft asks for. Excel may be open on the computer, so
   the tab is read again right before writing: a row that's moved since the comparison stops the lot. */
function crmWriteAll(item, plan, session){
  var tabs = ["Clients", "Pipeline"].filter(function(tab){
    return plan.rows.concat(plan.adds).some(function(x){ return x.tab === tab; });
  });
  var chain = Promise.resolve(), done = {rows: 0, adds: 0};
  tabs.forEach(function(tab){
    var parsed, next;
    chain = chain.then(function(){ return crmRead(item, tab, session); }).then(function(p){
      parsed = p;
      next = p.last + 1;
      plan.rows.forEach(function(w){
        if(w.tab !== tab) return;
        var now = p.rows.filter(function(row){ return row.row === w.at.row; })[0];
        if(!now || now.key !== w.at.key) throw crmStop("moved", "The CRM changed while this was syncing, so it stopped. Nothing's been lost. It will try again.");
      });
    });
    plan.rows.forEach(function(w){
      if(w.tab !== tab) return;
      chain = chain.then(function(){
        return crmRowWrite(item, parsed, w.at.row, tab === "Pipeline" ? crmPipeNames(w.cells, w.at) : w.cells, session);
      }).then(function(){ done.rows++; });
    });
    plan.adds.forEach(function(a){
      if(a.tab !== tab) return;
      chain = chain.then(function(){
        /* someone's just typed this very name in Excel: the next sync pairs them up */
        if(parsed.rows.some(function(row){ return row.key === a.key; })) return null;
        var at = next++;
        return crmRowWrite(item, parsed, at, a.cells, session).then(function(){ done.adds++; });
      });
    });
  });
  return chain.then(function(){ return done; });
}
/* What came from the CRM lands on the phone, unless the same field's been changed on the phone in the last few seconds */
function crmApply(plan){
  var saves = [], changed = plan.fresh.length;
  crmApplying = true;
  try {
    plan.phone.forEach(function(ch){
      var r = byId("clients", ch.id);
      if(!r) return;
      var copy = clone(r), facts = ch.tab === "Pipeline" ? crmQuoteFacts(copy) : {};
      Object.keys(ch.set).forEach(function(f){
        if(crmSame(crmFd(ch.tab, f), crmPhoneVal(copy, f, facts), ch.had[f])){
          copy[f] = ch.set[f];
          changed++;
        } else {
          delete plan.base[ch.id].p[f];
          delete plan.base[ch.id].c[f];
        }
      });
      if(ch.stageOff){ delete copy.stage; changed++; }
      saves.push(put("clients", copy));
    });
    plan.fresh.forEach(function(rec){ saves.push(put("clients", rec)); });
  } finally { crmApplying = false; }
  return Promise.all(saves).then(function(){ return changed; });
}

/* ─────────── one sync ─────────── */
function crmLockTaken(){
  var at = +ls(LS_LOCK, "0");
  return Date.now() - at < 90000;
}
function crmUnlock(){ try { localStorage.removeItem(LS_LOCK); } catch(e){} }
/* o.go: he's seen the first sync's list and said go ahead. o.auto: nobody asked, so it keeps quiet about it. */
function crmRun(o){
  o = o || {};
  if(crmBusy || !crmSignedIn()) return Promise.resolve();
  crmTried = Date.now();
  if(navigator.onLine === false){
    crmMsg = {k: "", t: "No internet. Anything changed here goes across when there's internet and the app is open."};
    crmRepaint();
    return Promise.resolve();
  }
  /* a form open on a client holds its own copy, and would write it back over whatever came in */
  if(crmEditorOpen()){
    if(o.auto) crmSoon(60000);
    return Promise.resolve();
  }
  /* a second window of the app has it in hand */
  if(o.auto && crmLockTaken()) return Promise.resolve();
  lsSet(LS_LOCK, String(Date.now()));
  crmBusy = true;
  crmRepaint();
  var st = crmState(), session = null, item = null, phoneMoved = 0;
  return crmGraph("GET", "/me/drive/root:/" + encodeURI(MS.workbook) + ":?$select=id,name").then(function(file){
    item = file.id;
    /* a different workbook starts from scratch */
    if(st.item && st.item !== item){ st.base = {}; st.decisions = {}; st.ignore = {}; st.firstDone = false; }
    st.item = item;
    return crmGraph("POST", "/me/drive/items/" + item + "/workbook/createSession", {persistChanges: true});
  }).then(function(s){
    session = s.id;
    return crmRead(item, "Clients", session);
  }).then(function(c){
    return crmRead(item, "Pipeline", session).then(function(p){ return {Clients: c, Pipeline: p}; });
  }).then(function(tabs){
    var plan = crmCompare(tabs, S.clients, st), work = plan.rows.length + plan.adds.length + plan.phone.length + plan.fresh.length;
    if(!st.firstDone && !o.go && (work || plan.items.length)){
      st.items = plan.items;
      st.notes = plan.notes;
      st.preview = crmPreview(plan);
      return crmSave(st);
    }
    return crmWriteAll(item, plan, session).then(function(done){
      /* opened a client while this ran: its changes wait, and the next sync finds the CRM's part already matching */
      if(crmEditorOpen()){
        crmSoon(60000);
        return null;
      }
      return crmApply(plan).then(function(n){
        phoneMoved = n;
        st.base = plan.base;
        st.items = plan.items;
        st.notes = plan.notes;
        st.decisions = {};
        st.preview = null;
        st.firstDone = true;
        st.last = {at: Date.now(), up: done.rows, added: done.adds, down: n};
        return crmSave(st);
      });
    });
  }).then(function(){
    crmMsg = null;
  }, function(e){
    if(e && e.crm){
      crmMsg = {k: e.crm === "net" ? "" : "stop", t: e.message, kind: e.crm};
      if(e.crm === "signin") crmMsg.k = "";
      if(e.crm === "locked" || e.crm === "busy" || e.crm === "moved") crmSoon(120000);
      return;
    }
    crmMsg = {k: "stop", t: "The sync stopped on something unexpected, so nothing more was written. " + (e && e.message ? e.message : "")};
  }).then(function(){
    var closing = session ? crmGraph("POST", "/me/drive/items/" + item + "/workbook/closeSession", {}, session).catch(function(){}) : null;
    crmBusy = false;
    crmUnlock();
    crmRepaint(phoneMoved > 0);
    return closing;
  });
}
function crmSoon(ms){
  clearTimeout(crmTimer);
  crmTimer = setTimeout(function(){ crmRun({auto: true}); }, ms);
}
/* called whenever a client or quote is saved */
function crmChanged(){
  if(!crmApplying && crmSignedIn()) crmSoon(CRM_CHANGE_WAIT);
}
/* back on screen, or the signal's back */
function crmWake(){
  if(crmSignedIn() && Date.now() - crmTried > CRM_WAKE_GAP) crmSoon(1000);
}
window.addEventListener("online", function(){ if(crmSignedIn()) crmSoon(1000); });
function crmRepaint(moved){
  if(!stack.length || stack.length > 1) return;
  if(curTab === "sync" || curTab === "home" || (moved && curTab === "clients")) rerender();
}

/* ─────────── the first sync's list, for him to read before anything is written ─────────── */
function crmPreview(plan){
  function labels(tab, keys){ return keys.map(function(f){ return crmFd(tab, f).label; }).join(", "); }
  return {
    addClients: plan.adds.filter(function(a){ return a.tab === "Clients"; }).map(function(a){ return a.who; }),
    addPipeline: plan.adds.filter(function(a){ return a.tab === "Pipeline"; }).map(function(a){ return a.who; }),
    changeCrm: plan.rows.map(function(w){ return w.who + ": " + labels(w.tab, Object.keys(w.cells)); }),
    addPhone: plan.fresh.map(function(r){ return r.name; }),
    changePhone: plan.phone.map(function(ch){
      var keys = Object.keys(ch.set);
      return ch.who + ": " + (keys.length ? labels(ch.tab, keys) : "") + (ch.stageOff ? (keys.length ? ", " : "") + "moves to Clients" : "");
    })
  };
}
function crmPreviewList(p, title, list){
  if(!list.length) return;
  add(p, "div", "item-name", title + " (" + list.length + ")");
  var ul = add(p, "ul", "sync-list");
  list.forEach(function(x){ add(ul, "li", null, x); });
}

/* ─────────── the owner's choices ─────────── */
function crmDecide(id, what){
  var st = crmState();
  st.decisions[id] = Object.assign(st.decisions[id] || {}, what);
  return crmSave(st).then(function(){ return crmAgain(st); });
}
function crmPickField(it, pick){
  var st = crmState(), d = st.decisions[it.id] = st.decisions[it.id] || {};
  d.fields = d.fields || {};
  d.fields[it.f] = {pick: pick, p: it.p, c: it.c};
  return crmSave(st).then(function(){ return crmAgain(st); });
}
function crmAgain(st){ return crmRun({go: !!st.firstDone}); }
function crmDropBase(id){
  var st = crmState();
  delete st.base[id];
  return crmSave(st);
}
function crmShown(v){ return v === "" ? "(blank)" : v; }
function crmItemCard(p, it){
  var n, acts;
  if(it.kind === "field"){
    n = note(p, "", it.who + ":", it.label.toLowerCase() + " is different in each place. Which one is right?");
    add(n, "div", "sync-was", "On the phone: " + crmShown(it.p));
    add(n, "div", "sync-was", "In the CRM: " + crmShown(it.c));
    acts = add(n, "div", "btns");
    btn(acts, "Use the phone's", "small", function(){ crmPickField(it, "phone"); });
    btn(acts, "Use the CRM's", "small", function(){ crmPickField(it, "crm"); });
    btn(n, "Leave both as they are", "small", function(){ crmPickField(it, "leave"); });
  } else if(it.kind === "gone"){
    n = note(p, "", it.who + ":", "their row is gone from the CRM's " + it.tab + " tab. What should happen?");
    it.maybe.forEach(function(m){
      btn(n, "It's now called " + m.name, "small", function(){ crmDecide(it.id, {renamed: m.key}); });
    });
    btn(n, "Put them back in the CRM", "small", function(){ crmDecide(it.id, {row: "putBack"}); });
    btn(n, "Keep them on this phone only", "small", function(){
      var r = byId("clients", it.id);
      if(!r) return;
      r.crmOff = true;
      put("clients", r).then(function(){ return crmDropBase(it.id); }).then(function(){ return crmAgain(crmState()); });
    });
    if(it.canDelete){
      btn(n, "Delete them from this phone", "small", function(){
        if(!confirm("Delete " + it.who + " from this phone for good?")) return;
        del("clients", it.id).then(function(){ return crmDropBase(it.id); }).then(function(){ return crmAgain(crmState()); });
      });
    }
  } else if(it.kind === "phoneDel"){
    n = note(p, "", it.who + ":", "deleted on this phone, but their row is still on the CRM's " + it.tab + " tab.");
    btn(n, "Bring them back to this phone", "small", function(){ crmDecide(it.id, {row: "bringBack"}); });
    btn(n, "Leave them off this phone", "small", function(){
      var st = crmState();
      st.ignore[it.tab + "|" + it.key] = true;
      delete st.base[it.id];
      crmSave(st).then(function(){ return crmAgain(st); });
    });
    add(n, "div", "sync-was", "This app never deletes a row. To take them out of the CRM too, delete the row in Excel.");
  } else if(it.kind === "moved"){
    n = note(p, "", it.who + ":", "moved back to the pipeline on this phone, but they're still on the CRM's Clients tab. To keep them in the pipeline, delete their row from the Clients tab in Excel, then sync again.");
    btn(n, "Make them a client again", "small", function(){
      var r = byId("clients", it.id);
      if(!r) return;
      delete r.stage;
      put("clients", r).then(function(){ return crmAgain(crmState()); });
    });
  }
}

/* ─────────── the screen ─────────── */
function crmClock(ms){
  return (new Date(ms).toDateString() === new Date().toDateString() ? "" : fmtDate(isoFromUTC(ms + new Date(ms).getTimezoneOffset() * -60000)) + " ") + new Date(ms).toLocaleTimeString("en-AU", {hour: "numeric", minute: "2-digit"});
}
function crmDidText(l){
  var bits = [];
  if(l.added) bits.push(howMany(l.added, "row") + " added to the CRM");
  if(l.up) bits.push(howMany(l.up, "row") + " changed in the CRM");
  if(l.down) bits.push(howMany(l.down, "change") + " on this phone");
  return bits.length ? bits.join(", ") + "." : "Nothing needed changing.";
}
/* for the row on Home */
function crmHomeBits(){
  var st = crmState(), need = st.items.length;
  if(crmBusy) return ["Syncing"];
  if(!crmSignedIn()) return st.firstDone ? [{t: "Tap to sign in again", k: "warn"}] : ["Not connected"];
  if(st.preview) return [{t: "Check the first sync", k: "warn"}];
  if(need) return [{t: need === 1 ? "1 needs you" : need + " need you", k: "warn"}];
  if(crmMsg && crmMsg.k === "stop") return [{t: "Couldn't sync", k: "stop"}];
  return st.last ? ["Synced " + crmClock(st.last.at)] : ["Connected"];
}
function syncView(){
  setTitle("CRM sync");
  var sec = add(app, "section"), st = crmState(), t = crmTokens() || {};
  if(crmMsg) note(sec, crmMsg.k, null, crmMsg.t).dataset.out = "syncMsg";
  if(!crmSignedIn()){
    var hello = panelForm(sec);
    add(hello, "p", "hint", st.firstDone
      ? "Microsoft ends this sign-in after a day. Tap below and it usually comes straight back with nothing to type. Nothing here has been lost, and changes go across once you're back in."
      : "This keeps your clients and pipeline matching the CRM on your computer, both ways. Sign in once with your STEL business Microsoft account, not your personal one. Microsoft will ask you to allow access to your OneDrive files: this app only opens the CRM, but Microsoft's permission covers the whole OneDrive.");
    btn(hello, "Sign in to Microsoft", "", function(){
      if(navigator.onLine === false){ toast("Signing in needs internet."); return; }
      crmSignIn();
    });
    return;
  }
  if(st.preview){
    var pv = st.preview;
    note(sec, "good", "Ready for the first sync.", "Nothing's been written yet. Read through this, then tap Go ahead.").dataset.out = "syncPreview";
    var list = panelForm(sec);
    add(list, "p", "hint", "Workbook: " + MS.workbook);
    crmPreviewList(list, "Add to the CRM's Clients tab", pv.addClients);
    crmPreviewList(list, "Add to the CRM's Pipeline tab", pv.addPipeline);
    crmPreviewList(list, "Fill in or change in the CRM", pv.changeCrm);
    crmPreviewList(list, "Add to this phone", pv.addPhone);
    crmPreviewList(list, "Fill in or change on this phone", pv.changePhone);
    if(!pv.addClients.length && !pv.addPipeline.length && !pv.changeCrm.length && !pv.addPhone.length && !pv.changePhone.length) add(list, "p", "hint", "Everything already matches.");
    btn(sec, crmBusy ? "Syncing…" : "Go ahead", "", function(){ crmRun({go: true}); }).disabled = crmBusy;
  } else {
    var state = panelForm(sec);
    add(state, "div", "item-name", st.last ? "Last synced " + crmClock(st.last.at) : "Not synced yet").dataset.out = "syncLast";
    if(st.last) add(state, "p", "hint", crmDidText(st.last));
    btn(sec, crmBusy ? "Syncing…" : "Sync now", "", function(){ crmRun({go: !!st.firstDone}); }).disabled = crmBusy;
  }
  if(st.items.length){
    add(sec, "h2", "sec", st.items.length === 1 ? "1 needs you" : st.items.length + " need you");
    var box = add(sec, "div");
    box.dataset.out = "syncItems";
    st.items.forEach(function(it){ crmItemCard(box, it); });
  }
  if(st.notes.length){
    var nt = add(fold(sec, "Left alone (" + st.notes.length + ")", false), "div", "panel");
    var ntf = add(nt, "div", "form");
    st.notes.forEach(function(x){ add(ntf, "p", "hint", x); });
  }
  var how = add(fold(sec, "How this works", false), "div", "panel");
  var hf = add(how, "div", "form");
  add(hf, "p", "hint", "It syncs when you open the app with internet, soon after you change a client, and when you tap Sync now. It can't run while the app is closed, so a change made in Excel reaches this phone next time you open the app.");
  add(hf, "p", "hint", "Only names, contacts, phones, emails, location and notes on the Clients tab, and the Pipeline tab's columns, go across. Other columns and tabs stay in Excel. It never deletes a row. Anything changed in both places waits here for you to pick.");
  add(hf, "p", "hint", "Microsoft ends this sign-in after a day, so about once a day it needs a tap, usually with nothing to type.");
  if(t.who) add(hf, "p", "hint", "Signed in as " + t.who + ".");
  var out = add(hf, "button", "linkbtn", "Sign out of Microsoft on this app");
  out.type = "button";
  out.addEventListener("click", function(){ crmSignOut(); rerender(); });
}
