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

  var api = {
    R: R, add: add, sub: sub, mul: mul, div: div, cmp: cmp, parse: parse, parseSigned: parseSigned,
    rounded: rounded, unrounded: unrounded, show: show,
    AREA_UNITS: AREA_UNITS, SPRAY_RATE_UNITS: SPRAY_RATE_UNITS, PRODUCT_UNITS: PRODUCT_UNITS,
    echoProduct: echoProduct, echoArea: echoArea, echoSprayRate: echoSprayRate,
    mix: mix, mixMany: mixMany, unitKey: unitKey, toCents: toCents, money: money, quoteTotals: quoteTotals
  };
  root.StelCalc = api;
})(typeof self !== "undefined" ? self : this);
