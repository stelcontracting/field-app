/* STEL Field: the maths.
   Everything here works in exact fractions (BigInt top and bottom), parsed straight
   from what was typed. Nothing is rounded in here except the two display functions
   and quote money, which rounds to the cent the way an invoice does. No chemical
   names, label rates or prices live in this file: it only multiplies what it's given.
   No screen code, so tests can run it on its own. */
(function (root) {
  "use strict";

  /* ---------- exact fractions ---------- */
  function abs(a) { return a < 0n ? -a : a; }
  function gcd(a, b) { a = abs(a); b = abs(b); while (b) { var t = a % b; a = b; b = t; } return a; }
  function R(n, d) {
    n = BigInt(n); d = d === undefined ? 1n : BigInt(d);
    if (d === 0n) throw new Error("divide by zero");
    if (d < 0n) { n = -n; d = -d; }
    var g = gcd(n, d) || 1n;
    return { n: n / g, d: d / g };
  }
  function add(a, b) { return R(a.n * b.d + b.n * a.d, a.d * b.d); }
  function sub(a, b) { return R(a.n * b.d - b.n * a.d, a.d * b.d); }
  function mul(a, b) { return R(a.n * b.n, a.d * b.d); }
  function div(a, b) { return R(a.n * b.d, a.d * b.n); }
  function cmp(a, b) { var x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; }
  function isZero(a) { return a.n === 0n; }
  function floorInt(a) {
    var q = a.n / a.d;
    if (a.n < 0n && a.n % a.d !== 0n) q -= 1n;
    return q;
  }

  /* A plain decimal typed by a person: "12.5", ".5", "16". No commas, no signs, no
     letters, no exponents. Anything else is null, so "1,200" stops rather than guesses. */
  function parse(str) {
    if (str === null || str === undefined) return null;
    var s = String(str).trim();
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    var dot = s.indexOf(".");
    if (dot < 0) return R(BigInt(s));
    var frac = s.slice(dot + 1);
    return R(BigInt((s.slice(0, dot) || "0") + frac), 10n ** BigInt(frac.length));
  }

  /* Same, but a leading minus is allowed. Used for quote rates, so a discount line works. */
  function parseSigned(str) {
    var s = String(str === null || str === undefined ? "" : str).trim();
    if (s.charAt(0) === "-") {
      var p = parse(s.slice(1));
      return p ? R(-p.n, p.d) : null;
    }
    return parse(s);
  }

  /* ---------- turning a fraction into text: display only ---------- */

  /* Round half up to dp decimals. Returns {text, exact}: exact is false when the
     figure on screen isn't the whole number. */
  function rounded(a, dp, minDp) {
    var neg = a.n < 0n;
    var n = abs(a.n), scale = 10n ** BigInt(dp);
    var scaled = n * scale * 2n + a.d;
    var q = scaled / (a.d * 2n);
    var exact = q * a.d === n * scale;
    var whole = (q / scale).toString();
    var frac = dp > 0 ? (q % scale).toString().padStart(dp, "0") : "";
    var keep = frac.length;
    var min = minDp === undefined ? 0 : minDp;
    while (keep > min && frac.charAt(keep - 1) === "0") keep--;
    frac = frac.slice(0, keep);
    var text = whole + (frac ? "." + frac : "");
    if (neg && q !== 0n) text = "-" + text;
    return { text: text, exact: exact };
  }

  /* The figure with no display rounding. A fraction that never ends (like 2/3) is cut
     at 12 places and marked with "...", never rounded. */
  function unrounded(a, maxDp) {
    var max = maxDp === undefined ? 12 : maxDp;
    var neg = a.n < 0n, n = abs(a.n);
    var whole = n / a.d, rem = n % a.d, frac = "";
    while (rem !== 0n && frac.length < max) {
      rem *= 10n;
      frac += (rem / a.d).toString();
      rem = rem % a.d;
    }
    return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "") + (rem !== 0n ? "..." : "");
  }

  /* ≈ goes in front when the figure shown isn't the exact one. */
  function show(a, dp, minDp) {
    var r = rounded(a, dp === undefined ? 3 : dp, minDp);
    return (r.exact ? "" : "≈ ") + r.text;
  }

  /* ---------- units ---------- */
  var ACRE_IN_HA = parse("0.40468564224");  /* international acre: 4046.8564224 m2, exact */
  var AREA_UNITS = {
    ha: { label: "ha", toHa: R(1) },
    ac: { label: "acres", toHa: ACRE_IN_HA },
    m2: { label: "m²", toHa: R(1n, 10000n) }
  };
  var SPRAY_RATE_UNITS = {
    "L/ha": { label: "L/ha", toLha: R(1) },
    "L/1000m2": { label: "L/1000 m²", toLha: R(10) }
  };
  /* kind "area": toBase turns the number into L or kg per hectare.
     kind "conc": toBase turns the number into L or kg per 100 L of finished mix. */
  var PRODUCT_UNITS = {
    "L/ha": { label: "L/ha", kind: "area", dim: "vol", toBase: R(1) },
    "mL/ha": { label: "mL/ha", kind: "area", dim: "vol", toBase: R(1n, 1000n) },
    "L/1000m2": { label: "L/1000 m²", kind: "area", dim: "vol", toBase: R(10) },
    "mL/1000m2": { label: "mL/1000 m²", kind: "area", dim: "vol", toBase: R(1n, 100n) },
    "L/100L": { label: "L/100 L", kind: "conc", dim: "vol", toBase: R(1) },
    "mL/100L": { label: "mL/100 L", kind: "conc", dim: "vol", toBase: R(1n, 1000n) },
    "kg/ha": { label: "kg/ha", kind: "area", dim: "mass", toBase: R(1) },
    "g/ha": { label: "g/ha", kind: "area", dim: "mass", toBase: R(1n, 1000n) },
    "kg/1000m2": { label: "kg/1000 m²", kind: "area", dim: "mass", toBase: R(10) },
    "g/1000m2": { label: "g/1000 m²", kind: "area", dim: "mass", toBase: R(1n, 100n) },
    "kg/100L": { label: "kg/100 L", kind: "conc", dim: "mass", toBase: R(1) },
    "g/100L": { label: "g/100 L", kind: "conc", dim: "mass", toBase: R(1n, 1000n) }
  };

  /* Same rate in the big and small unit, for the echo line. */
  var ECHO_PAIR = {
    "L/ha": ["L/ha", "mL/ha"], "mL/ha": ["L/ha", "mL/ha"],
    "L/1000m2": ["L/1000m2", "mL/1000m2"], "mL/1000m2": ["L/1000m2", "mL/1000m2"],
    "L/100L": ["L/100L", "mL/100L"], "mL/100L": ["L/100L", "mL/100L"],
    "kg/ha": ["kg/ha", "g/ha"], "g/ha": ["kg/ha", "g/ha"],
    "kg/1000m2": ["kg/1000m2", "g/1000m2"], "g/1000m2": ["kg/1000m2", "g/1000m2"],
    "kg/100L": ["kg/100L", "g/100L"], "g/100L": ["kg/100L", "g/100L"]
  };

  function small(unit) { return unit.indexOf("mL") === 0 || unit.indexOf("g/") === 0; }

  /* Older records write "L/100 L" and new screens "L/1000 m²". Both mean the same key. */
  function unitKey(u) { return String(u === null || u === undefined ? "" : u).replace(/\s+/g, "").replace(/²/g, "2"); }

  /* The rate as typed, plus the same rate in the other size of unit */
  function echoProduct(valueStr, unit) {
    unit = unitKey(unit);
    var v = parse(valueStr), u = PRODUCT_UNITS[unit];
    if (!v || !u) return "";
    var pair = ECHO_PAIR[unit];
    var other = pair[0] === unit ? pair[1] : pair[0];
    var inOther = div(mul(v, u.toBase), PRODUCT_UNITS[other].toBase);
    var typed = unrounded(v) + " " + u.label;
    var conv = show(inOther, 6) + " " + PRODUCT_UNITS[other].label;
    return small(unit) ? typed + " = " + conv : typed + " (" + conv + ")";
  }

  function echoArea(valueStr, unit) {
    var v = parse(valueStr), u = AREA_UNITS[unit];
    if (!v || !u) return "";
    var ha = mul(v, u.toHa);
    var typed = unrounded(v) + " " + u.label;
    if (unit === "ha") return typed + " (" + show(mul(ha, R(10000)), 3) + " m², " + show(div(ha, ACRE_IN_HA), 3) + " acres)";
    return typed + " = " + show(ha, 6) + " ha";
  }

  function echoSprayRate(valueStr, unit) {
    unit = unitKey(unit);
    var v = parse(valueStr), u = SPRAY_RATE_UNITS[unit];
    if (!v || !u) return "";
    var typed = unrounded(v) + " " + u.label;
    if (unit === "L/ha") return typed + " (" + show(div(v, R(10)), 6) + " L/1000 m²)";
    return typed + " = " + show(mul(v, u.toLha), 6) + " L/ha";
  }

  /* ---------- the mix ---------- */
  var NEEDS = {
    area: "Enter the area to treat.",
    areaUnit: "Choose the area unit.",
    spray: "Enter the spray rate or total spray volume.",
    sprayUnit: "Choose the spray rate unit.",
    tank: "Enter the tank size in litres.",
    productRate: "Enter the product rate off the label.",
    productUnit: "Choose the unit shown on the label."
  };
  var BAD_NUMBER = "Numbers only, like 12.5. No commas, spaces or letters.";
  var ABOVE_ZERO = "Must be more than zero.";

  function numberField(errs, key, str, needsMsg) {
    if (str === null || str === undefined || String(str).trim() === "") { errs.push({ field: key, msg: needsMsg, blank: true }); return null; }
    var v = parse(str);
    if (!v) { errs.push({ field: key, msg: BAD_NUMBER }); return null; }
    if (isZero(v)) { errs.push({ field: key, msg: ABOVE_ZERO }); return null; }
    return v;
  }

  /* Takes the raw strings from the form, returns everything a screen shows.
     {area, areaUnit, sprayMode: "rate"|"total", sprayRate, sprayRateUnit, sprayTotal,
      tank, noTank, products: [{name, rate, unit}]}
     result.mix is null unless every input is good and the mix is physically possible,
     so a screen can't show tank figures for a mix that makes no sense. */
  function mixMany(input) {
    var errs = [], warnings = [];
    var mode = input.sprayMode === "total" ? "total" : "rate";
    var noTank = !!input.noTank;
    var area = numberField(errs, "area", input.area, NEEDS.area);
    var aUnit = AREA_UNITS[input.areaUnit];
    if (!aUnit) errs.push({ field: "areaUnit", msg: NEEDS.areaUnit, blank: true });

    var sprayVal = null, sUnit = null;
    if (mode === "rate") {
      sprayVal = numberField(errs, "sprayRate", input.sprayRate, NEEDS.spray);
      sUnit = SPRAY_RATE_UNITS[unitKey(input.sprayRateUnit)];
      if (!sUnit) errs.push({ field: "sprayRateUnit", msg: NEEDS.sprayUnit, blank: true });
    } else {
      sprayVal = numberField(errs, "sprayTotal", input.sprayTotal, NEEDS.spray);
    }
    var tank = noTank ? null : numberField(errs, "tank", input.tank, NEEDS.tank);

    var list = input.products || [];
    var parsed = list.map(function (p, i) {
      var before = errs.length;
      var rate = numberField(errs, "productRate", p.rate, NEEDS.productRate);
      var u = PRODUCT_UNITS[unitKey(p.unit)];
      if (!u) errs.push({ field: "productUnit", msg: NEEDS.productUnit, blank: true });
      var who = p.name ? p.name + ": " : list.length > 1 ? "Product " + (i + 1) + ": " : "";
      errs.slice(before).forEach(function (e) { e.index = i; e.msg = who + e.msg; });
      return { name: p.name || "", rate: rate, u: u, key: unitKey(p.unit) };
    });

    var res = {
      errors: errs, warnings: warnings, stop: null, hint: null, mix: null,
      echo: {
        area: echoArea(input.area, input.areaUnit),
        spray: mode === "rate" ? echoSprayRate(input.sprayRate, input.sprayRateUnit) : "",
        products: list.map(function (p) { return echoProduct(p.rate, p.unit); })
      }
    };
    if (mode === "total" && area && aUnit && sprayVal) {
      var over = mul(area, aUnit.toHa);
      res.echo.spray = unrounded(sprayVal) + " L over " + show(over, 6) + " ha = " + show(div(sprayVal, over), 6) + " L/ha";
    }
    if (errs.length) return res;

    var areaHa = mul(area, aUnit.toHa);
    var totalSpray = mode === "rate" ? mul(areaHa, mul(sprayVal, sUnit.toLha)) : sprayVal;
    var lPerHa = div(totalSpray, areaHa);

    /* each product as a share of the finished mix (1 kg counts as about 1 L for this share) */
    var shareSum = R(0), liquidShare = R(0), biggest = null;
    var rows = parsed.map(function (p) {
      var base = mul(p.rate, p.u.toBase);
      var perHa = p.u.kind === "area" ? base : mul(div(base, R(100)), lPerHa);
      var share = div(perHa, lPerHa);
      shareSum = add(shareSum, share);
      if (p.u.dim !== "mass") liquidShare = add(liquidShare, share);
      var row = { name: p.name, p: p, perHa: perHa, share: share };
      if (!biggest || cmp(share, biggest.share) > 0) biggest = row;
      return row;
    });

    /* The label says one thing, the number and unit say something impossible. */
    if (cmp(shareSum, R(1)) >= 0) {
      res.stop = cmp(shareSum, R(1)) > 0
        ? (rows.length > 1 ? "Check your units: the products add up to more than the tank." : "Check your units: product is larger than the tank.")
        : "Check your units: product takes up the whole tank, with no room for water.";
      if (!small(biggest.p.key)) {
        var smallU = PRODUCT_UNITS[ECHO_PAIR[biggest.p.key][1]];
        res.hint = "If the label says " + unrounded(biggest.p.rate) + " " + smallU.label + ", that is " +
          show(div(mul(biggest.p.rate, smallU.toBase), biggest.p.u.toBase), 6) + " " + biggest.p.u.label + ". Change the unit and the numbers come back.";
      }
      return res;
    }

    var fullTanks = null, partLoad = null, areaPerTank = null, areaPart = null;
    if (!noTank) {
      fullTanks = floorInt(div(totalSpray, tank));
      partLoad = sub(totalSpray, mul(R(fullTanks), tank));
      areaPerTank = div(tank, lPerHa);
      areaPart = div(partLoad, lPerHa);
    }
    var productChecks = true;
    var products = rows.map(function (r) {
      var mass = r.p.u.dim === "mass";
      var out = {
        name: r.name, mass: mass, unit: mass ? "kg" : "L", smallUnit: mass ? "g" : "mL", concBased: r.p.u.kind === "conc",
        perHa: r.perHa, per100: mul(r.share, R(100)), total: mul(totalSpray, r.share), perTank: null, perPart: null
      };
      if (!noTank) {
        out.perTank = mul(tank, r.share);
        out.perPart = mul(partLoad, r.share);
        if (cmp(add(mul(R(fullTanks), out.perTank), out.perPart), out.total) !== 0) productChecks = false;
      }
      return out;
    });

    /* dry product is taken as adding no volume */
    if (cmp(shareSum, R(1n, 2n)) > 0) warnings.push("Check your units: product is more than the water in the tank.");
    rows.forEach(function (r) {
      if (cmp(r.perHa, R(5n, 1000n)) < 0) {
        warnings.push("Check your units: " + (r.name ? r.name + " is" : "that is") + " under 5 " + (r.p.u.dim === "mass" ? "g" : "mL") + " of product per hectare.");
      }
    });
    if (cmp(lPerHa, R(200)) > 0) warnings.push("Check your units: " + show(lPerHa, 3) + " L/ha is a lot of water for a drone.");
    if (cmp(lPerHa, R(1)) < 0) warnings.push("Check your units: " + show(lPerHa, 3) + " L/ha is very little water.");
    if (!noTank && cmp(tank, R(500)) > 0) warnings.push("Check the tank size: " + show(tank, 3) + " L is a very big tank. Is it in litres?");
    if (!noTank && cmp(tank, R(1)) < 0) warnings.push("Check the tank size: " + show(tank, 3) + " L is under a litre. Is it in litres?");

    res.mix = {
      noTank: noTank, sprayMode: mode, area: area, areaUnitLabel: aUnit.label, areaHa: areaHa,
      lPerHa: lPerHa, tank: tank, totalSpray: totalSpray, share: shareSum,
      fullTanks: fullTanks, partLoad: partLoad, areaPerTank: areaPerTank, areaPart: areaPart,
      products: products,
      waterPerTank: noTank ? null : mul(tank, sub(R(1), liquidShare)),
      waterPart: noTank ? null : mul(partLoad, sub(R(1), liquidShare)),
      waterTotal: mul(totalSpray, sub(R(1), liquidShare)),
      /* the same totals added back up from the loads, compared exactly */
      sprayChecks: noTank ? true : cmp(add(mul(R(fullTanks), tank), partLoad), totalSpray) === 0,
      productChecks: productChecks
    };
    return res;
  }

  /* One product, for anything that only has one. */
  function mix(input) {
    var res = mixMany(Object.assign({}, input, { products: [{ rate: input.productRate, unit: input.productUnit }] }));
    res.echo.product = res.echo.products[0];
    if (res.mix) {
      var m = res.mix, p = m.products[0];
      m.mass = p.mass; m.productUnit = p.unit; m.smallUnit = p.smallUnit; m.concBased = p.concBased;
      m.productPerHa = p.perHa; m.per100 = p.per100;
      m.productPerTank = p.perTank; m.productPart = p.perPart; m.productTotal = p.total;
    }
    return res;
  }

  /* ---------- quote money ---------- */

  /* Exact fraction to whole cents, half away from zero. */
  function toCents(a) {
    var neg = a.n < 0n;
    var n = abs(a.n) * 100n * 2n + a.d;
    var c = n / (a.d * 2n);
    return neg ? -c : c;
  }
  function money(cents) {
    var neg = cents < 0n;
    var c = abs(cents);
    var dollars = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-$" : "$") + dollars + "." + (c % 100n).toString().padStart(2, "0");
  }

  /* Each line goes to the cent, the subtotal adds those lines, GST goes to the cent on
     the subtotal, so what's printed always adds up.
     lines: [{qty, rate}] as typed. Returns {lines:[{total|null, bad}], bad, subtotal, gst, total}. */
  function quoteTotals(lines, gstOn, gstRate) {
    var subtotal = 0n, anyBad = false;
    var out = (lines || []).map(function (l) {
      var blank = String(l.qty === undefined ? "" : l.qty).trim() === "" && String(l.rate === undefined ? "" : l.rate).trim() === "";
      if (blank) return { total: null, bad: false, blank: true };
      var q = parse(l.qty), r = parseSigned(l.rate);
      if (!q || !r) { anyBad = true; return { total: null, bad: true }; }
      var c = toCents(mul(q, r));
      subtotal += c;
      return { total: c, bad: false };
    });
    var gst = 0n, gstBad = false;
    if (gstOn) {
      var pct = parse(gstRate);
      if (!pct) { gstBad = true; anyBad = true; }
      else gst = toCents(mul(R(subtotal, 100n), div(pct, R(100))));
    }
    return { lines: out, bad: anyBad, gstBad: gstBad, subtotal: subtotal, gst: gst, total: subtotal + gst };
  }

  /* ---------- pricing a job off the price list ---------- */

  /* The Quote Builder's appCalc, calc and flagsFor, rule for rule, in exact fractions.
     No prices live here: they all come in on the card. Every line carries the qty and
     rate that multiply to its amount, so quoteTotals can add it up from one source.
     b: {apps:[{svc,area,rateKey,chargeBy,price,label,hours,hourly,spot,product}],km,locations,washdowns,hazards:[keys]}
     card: the rate card. P: self.StelRates, for the names and wording. */
  function decimal(a) { return unrounded(a, 40); }
  function commas(s) { var p = s.split("."); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","); return p.join("."); }
  function plainText(a) { return commas(rounded(a, 2).text); }
  function moneyOf(a) { return money(toCents(a)); }
  function isOne(a) { return a.n === 1n && a.d === 1n; }
  /* a count: the nearest whole number, and never below nothing, as the Quote Builder does */
  function wholeCount(v) { return Math.max(0, Math.round(parseFloat(v) || 0)); }

  function priceJob(b, card, P) {
    var ZERO = R(0), bad = [];
    function read(v, what) {
      var s = String(v === null || v === undefined ? "" : v).trim();
      if (s === "") return ZERO;
      var r = parse(s);
      if (!r) { if (bad.indexOf(what) < 0) bad.push(what); return ZERO; }
      return r;
    }
    var LIST = "A figure on your price list", c = {};
    ["hourly", "setup", "washFee", "localKm", "travelSpray", "travelMap", "minLocalHrs", "minAwayHrs", "minMapping", "spreadCut", "mapCut"].forEach(function (k) { c[k] = read(card[k], LIST); });

    var hazKeys = Object.keys(P.HAZARDS);
    var hz = hazKeys.filter(function (k) { return (b.hazards || []).indexOf(k) >= 0; });
    function hazardText(l) {
      if (!l.length) return "";
      var t = l.map(function (k) { return P.HAZARDS[k].say; });
      return t.length === 1 ? t[0] : t.slice(0, -1).join(", ") + " and " + t[t.length - 1];
    }
    var count = b.apps.length;

    /* one application's charge */
    function priceApp(src, i) {
      var svc = P.META[src.svc] ? src.svc : "spray", M = P.META[svc];
      var area = read(src.area, "Hectares"), hrs = read(src.hours, "Hours on site");
      var rv = src.rateKey || "i0";
      var opt = rv.charAt(0) === "i" ? card[svc][parseInt(rv.slice(1), 10)] : null;
      var lp = opt ? read(opt.r, LIST) : ZERO;
      var price = read(src.price, "Price per hectare");
      var custom = rv === "other" || cmp(price, lp) !== 0;
      var label = rv === "other" ? (String(src.label || "").trim() || "Agreed rate")
        : opt ? opt.t
        : (M.extra && rv === M.extra.v) ? M.extra.label : "";
      var byHour = src.chargeBy === "hour";
      var typedHourly = read(src.hourly, "Hourly rate");
      var jobHourly = isZero(typedHourly) ? c.hourly : typedHourly;
      var product = String(src.product || "").trim();
      var a = {
        i: i, svc: svc, name: M.name, crm: M.crm, area: area, hrs: hrs, rv: rv, label: label,
        custom: custom, price: price, listP: lp, product: product, byHour: byHour, jobHourly: jobHourly,
        hourly: false, hourlyWhy: "", poa: false, reasons: [], work: ZERO, line: null
      };
      var tag = count > 1 ? "Application " + i + ": " : "";

      if (svc === "spray") {
        if (src.spot) { a.poa = true; a.reasons.push(tag + "Spot spraying is P.O.A. on the price list."); }
        if (rv === "poa") { a.poa = true; a.reasons.push(tag + M.extra.why); }
        if (hz.length) { a.poa = true; a.reasons.push(tag + "High risk site (" + hazardText(hz) + "). Spray work over hazards is P.O.A."); }
      }
      if (svc === "spread") {
        if (hz.length >= 2) { a.poa = true; a.reasons.push(tag + "Multiple hazards (" + hazardText(hz) + "). Spreading with multiple hazards is P.O.A."); }
        if (rv === "over") { a.hourly = true; a.hourlyWhy = M.extra.label + " is charged at $" + decimal(c.hourly) + "/hr."; }
        else if (!custom && !isZero(area) && cmp(area, c.spreadCut) < 0) { a.hourly = true; a.hourlyWhy = "Under " + decimal(c.spreadCut) + " ha is charged at $" + decimal(c.hourly) + "/hr."; }
      }
      if (svc === "map") {
        if (!custom && !isZero(area) && cmp(area, c.mapCut) < 0) { a.hourly = true; a.hourlyWhy = "Under " + decimal(c.mapCut) + " ha is charged at $" + decimal(c.hourly) + "/hr, processing included."; }
      }
      if (byHour) { a.hourly = true; a.hourlyWhy = "You have set this one to charge by the hour."; }

      if (isZero(area) && !byHour && !a.poa) { a.poa = true; a.onlyArea = true; a.reasons.push(tag + "Put a hectare figure in and the price will work itself out."); }

      if (byHour && !isZero(hrs)) { a.poa = false; a.reasons = []; }
      else if (custom && !isZero(price) && !isZero(area)) { a.poa = false; a.reasons = []; a.hourly = false; }
      if (a.poa) return a;

      if (a.hourly && isZero(hrs)) { a.poa = true; a.needHours = true; a.reasons.push(tag + "No hours set yet."); return a; }
      if (!a.hourly && isZero(price)) { a.poa = true; a.reasons.push(tag + "No price per hectare set."); return a; }

      if (a.hourly) {
        a.work = mul(hrs, jobHourly);
        a.line = {
          d: a.name + (!isZero(area) ? ", " + plainText(area) + " ha" : ""),
          c: (label ? label + ". " : "") + (product ? product + ". " : "") + "Charged by the hour",
          q: plainText(hrs) + (isOne(hrs) ? " hr" : " hrs"), u: jobHourly, a: a.work,
          qty: decimal(hrs), unit: isOne(hrs) ? "hr" : "hrs", rate: decimal(jobHourly)
        };
      } else {
        a.work = mul(area, price);
        a.line = {
          d: a.name + ", " + plainText(area) + " ha",
          c: (label ? label + ". " : "") + product,
          q: plainText(area) + " ha", u: price, a: a.work,
          qty: decimal(area), unit: "ha", rate: decimal(price)
        };
      }
      return a;
    }

    /* the whole job */
    var km = read(b.km, "Distance from base");
    read(b.locations, "Operating locations");
    read(b.washdowns, "Wash downs");
    var locs = wholeCount(b.locations), washes = wholeCount(b.washdowns);
    var local = cmp(km, c.localKm) <= 0;
    var apps = b.apps.map(function (src, k) { return priceApp(src, k + 1); });

    var res = {
      apps: apps, km: km, locs: locs, local: local, hz: hz, hzText: hazardText(hz), washes: washes, wash: ZERO,
      area: apps.reduce(function (s, a) { return add(s, a.area); }, ZERO),
      lines: [], poa: false, reasons: [], bad: bad, flags: [],
      work: ZERO, minApplied: false, minCharge: ZERO,
      travel: ZERO, travelKm: ZERO, travelRate: ZERO, setup: ZERO, sub: ZERO,
      setupEach: c.setup, washEach: c.washFee, localKm: c.localKm, minAwayHrs: c.minAwayHrs,
      anyAir: apps.some(function (a) { return a.svc !== "map"; })
    };
    res.travelRate = res.anyAir ? c.travelSpray : c.travelMap;

    /* a number nobody can read stops the price rather than guessing at it */
    if (bad.length) {
      res.poa = true;
      res.reasons = bad.map(function (w) { return w + " can't be read. Numbers only, like 12.5."; });
      return res;
    }

    var unpriced = apps.filter(function (a) { return a.poa; });
    if (unpriced.length) {
      res.poa = true;
      unpriced.forEach(function (a) { a.reasons.forEach(function (x) { res.reasons.push(x); }); });
      return res;
    }

    apps.forEach(function (a) { res.work = add(res.work, a.work); res.lines.push(a.line); });

    /* minimum applies to the job, not to each application */
    var allMap = apps.every(function (a) { return a.svc === "map"; });
    var minLabel;
    if (allMap) {
      res.minCharge = c.minMapping;
      minLabel = moneyOf(c.minMapping) + " mapping minimum";
    } else {
      var mh = local ? c.minLocalHrs : c.minAwayHrs;
      res.minCharge = mul(mh, apps[0].jobHourly);
      minLabel = plainText(mh) + " hour minimum";
    }
    if (cmp(res.work, res.minCharge) < 0) {
      res.minApplied = true;
      var short = sub(res.minCharge, res.work);
      if (apps.length === 1) {
        var only = res.lines[0];
        only.c = (only.c ? only.c + ". " : "") + "Lifted to the " + minLabel;
        only.a = res.minCharge;
        only.q = ""; only.u = null;
        only.qty = "1"; only.unit = "job"; only.rate = decimal(res.minCharge);
      } else {
        res.lines.push({
          d: "Minimum charge",
          c: "The job together comes under the " + minLabel + " of " + moneyOf(res.minCharge),
          q: "", u: null, a: short, qty: "1", unit: "job", rate: decimal(short)
        });
      }
      res.work = res.minCharge;
    }

    if (locs > 0) {
      res.setup = mul(R(locs), c.setup);
      res.lines.push({
        d: "Set up, clean up and pack up",
        c: locs === 1 ? "One operating location" : locs + " operating locations",
        q: String(locs), u: c.setup, a: res.setup, qty: String(locs), unit: locs === 1 ? "location" : "locations", rate: decimal(c.setup)
      });
    }

    if (washes > 0) {
      res.wash = mul(R(washes), c.washFee);
      res.lines.push({
        d: "Chemical and seed wash down",
        c: "Between jobs and properties",
        q: String(washes), u: c.washFee, a: res.wash, qty: String(washes), unit: washes === 1 ? "wash down" : "wash downs", rate: decimal(c.washFee)
      });
    }

    if (!local) {
      /* the ute is loaded for the heaviest job on the run */
      res.travelKm = mul(km, R(2));
      res.travel = mul(res.travelKm, res.travelRate);
      res.lines.push({
        d: "Travel",
        c: plainText(km) + " km each way, return",
        q: plainText(res.travelKm) + " km", u: res.travelRate, a: res.travel,
        qty: decimal(res.travelKm), unit: "km", rate: decimal(res.travelRate)
      });
    }

    res.sub = add(add(add(res.work, res.setup), res.wash), res.travel);
    res.flags = jobFlags(res, c, P, allMap);
    return res;
  }

  /* the Quote Builder's flagsFor */
  function jobFlags(r, c, P, allMap) {
    var out = [], many = r.apps.length > 1;
    if (r.minApplied) out.push({ tag: "Minimum", txt: allMap
      ? "Job came in under the mapping minimum, so it is charged at " + moneyOf(r.minCharge) + "."
      : "Job came in under the " + (r.local ? "local" : "out of range") + " minimum of " + moneyOf(r.minCharge) + ", so it is charged at the minimum." });

    r.apps.forEach(function (a) {
      var tag = many ? "App " + a.i : "Your price";
      if (a.custom && !a.hourly) out.push({ tag: tag, warn: true,
        txt: (many ? a.name + ". " : "") + "Your own price. " + plainText(a.area) + " ha x $" + plainText(a.price) + " = " + moneyOf(mul(a.area, a.price)) + "." });
      if (a.hourly && a.hourlyWhy) out.push({ tag: many ? "App " + a.i : "Hourly", txt: a.hourlyWhy });
      if (a.hourly && cmp(a.jobHourly, c.hourly) !== 0) out.push({ tag: many ? "App " + a.i : "Your rate", warn: true,
        txt: "Charging $" + plainText(a.jobHourly) + "/hr instead of your usual $" + plainText(c.hourly) + "/hr. " +
          plainText(a.hrs) + " hrs x $" + plainText(a.jobHourly) + " = " + moneyOf(mul(a.hrs, a.jobHourly)) + "." });
    });

    if (r.local && !isZero(r.km)) out.push({ tag: "Travel", txt: "Inside " + decimal(c.localKm) + " km of " + P.WORDING.base + ", so no travel charge." });
    if (!r.local && cmp(r.km, R(P.FAR_KM)) >= 0) out.push({ tag: "Distance", warn: true, txt: "That is " + plainText(r.km) + " km out. " + P.FAR_TEXT + " Travel alone is " + moneyOf(r.travel) + ". Worth lining up a second job on the same trip." });
    if (r.hz.length && !r.apps.some(function (a) { return a.svc === "spray"; })) out.push({ tag: "Hazards", warn: true, txt: "Noted on site: " + r.hzText + ". Get it in writing that the client disclosed these before the job." });
    if (many) out.push({ tag: "Two jobs", txt: r.apps.length + " applications on the one trip. Set up and travel are charged once, not once each." });
    return out;
  }

  var api = {
    R: R, add: add, sub: sub, mul: mul, div: div, cmp: cmp, parse: parse, parseSigned: parseSigned,
    rounded: rounded, unrounded: unrounded, show: show,
    AREA_UNITS: AREA_UNITS, SPRAY_RATE_UNITS: SPRAY_RATE_UNITS, PRODUCT_UNITS: PRODUCT_UNITS,
    echoProduct: echoProduct, echoArea: echoArea, echoSprayRate: echoSprayRate,
    mix: mix, mixMany: mixMany, unitKey: unitKey, toCents: toCents, money: money, quoteTotals: quoteTotals,
    priceJob: priceJob, plainText: plainText, moneyOf: moneyOf, decimal: decimal, commas: commas, isZero: isZero
  };
  root.StelCalc = api;
})(typeof self !== "undefined" ? self : this);
