/* STEL Field: the price list and the quote wording.
   The only file in this app allowed to hold prices. Everything here is copied from the
   STEL Quote Builder (phone-app), which already publishes it in its own public code.
   These are starting values only: the owner's own rates and wording are kept in settings,
   so they go in the backup. Prices are fine here. Chemical rates never are: the "L/ha" and
   "kg/ha" names below are water rates and loads for pricing, not rates to apply a product at. */
self.StelRates = {
  /* the Quote Builder's DEFAULTS */
  DEFAULTS: {
    hourly: 280, setup: 150, washFee: 150, localKm: 35, gst: 10,
    travelSpray: 1.80, travelMap: 1.50,
    minLocalHrs: 2, minAwayHrs: 4, minMapping: 500,
    spreadCut: 30, mapCut: 50,
    spray: [{t: "30 L/ha", r: 50}, {t: "40 L/ha", r: 60}, {t: "50 L/ha", r: 80}, {t: "100 L/ha", r: 150}],
    spread: [{t: "0.5 to 15 kg/ha", r: 35}, {t: "15 to 30 kg/ha", r: 45}, {t: "30 to 60 kg/ha", r: 55}, {t: "60 to 100 kg/ha", r: 75}],
    map: [{t: "Property area and boundary", r: 7}, {t: "Thermal, photo or video", r: 15}, {t: "RTK, 2 cm accurate", r: 17}]
  },

  /* the Quote Builder's META */
  META: {
    spray: {name: "Aerial spraying", crm: "Spraying", chip: "Spraying", rateLabel: "Water rate",
      extra: {v: "poa", t: "Over 100 L/ha, P.O.A.", label: "Over 100 L/ha", why: "Anything over 100 L/ha is P.O.A. on the price list."}},
    spread: {name: "Aerial spreading", crm: "Spreading", chip: "Spreading", rateLabel: "Load",
      extra: {v: "over", t: "Over 100 kg/ha, hourly", label: "Over 100 kg/ha"}},
    map: {name: "Drone mapping", crm: "Mapping", chip: "Mapping", rateLabel: "Mapping type", extra: null}
  },

  HAZARDS: {
    dams: {say: "dams or water", tick: "Dams or water"},
    trees: {say: "trees or timbered country", tick: "Trees or timbered country"},
    powerlines: {say: "powerlines", tick: "Powerlines"},
    obstacles: {say: "fences, irrigation or obstacles", tick: "Fences, irrigation, obstacles"},
    terrain: {say: "steep or complex terrain", tick: "Steep or complex terrain"},
    stock: {say: "livestock in the paddock", tick: "Livestock in the paddock"}
  },

  FAR_KM: 150,
  FAR_TEXT: "Past roughly 150 to 200 km only a big job pays.",
  LABEL_HINT: "e.g. 45 L/ha, heavy mix",

  /* What buildQuote and buildDoc hard-code. Copied into settings on first use and editable
     under Backup and setup, so nothing here is final. */
  WORDING: {
    base: "Alton Downs",
    business: {
      name: "STEL Contracting Pty Ltd", legal: "STEL Family Trust",
      address: "81 Wedel Rd\nALTON DOWNS QLD 4702", abn: "89 565 516 861",
      phone: "0439 893 582", email: "admin@stelcontracting.com.au",
      signText: "Stuart", signDoc: "Stuart Price"
    },
    textNeed: "- Accurate property boundaries before the job.\n- Every hazard disclosed up front. Powerlines, fences, irrigation\n  gear, livestock, obstacles.\n- Vehicle access to the loading point.",
    textAir: "- Chemical or product supplied by you, on site and ready to load.",
    textTerms: "- Deposit before the job, balance within 7 days of invoice.\n- Weather is my call. If wind, rain or a temperature inversion means\n  the application will not hold, I will postpone.\n- Cancellation inside 48 hours of the booked date may attract a fee.\n- A call out fee applies if I arrive and cannot fly because the\n  information I was given was wrong.\n- Where you direct the chemical, the rate or the timing, that call\n  is yours.\n- Imagery, maps and data stay STEL property. You get a licence to\n  use them for managing your place.",
    docNeed: "Accurate property boundaries before the job.\nEvery hazard disclosed up front. Powerlines, fences, irrigation gear, livestock, obstacles.\nVehicle access to the loading point.",
    docAir: "Chemical or product supplied by you, on site and ready to load.",
    docTerms: "Deposit before the job, balance within 7 days of invoice.\nWeather is our call. If wind, rain or a temperature inversion means the application will not hold, we postpone.\nCancellation inside 48 hours of the booked date may attract a fee.\nA call out fee applies if we arrive and cannot fly because the information given was wrong.\nWhere you direct the chemical, the rate or the timing, that call is yours.\nImagery, maps and data stay STEL property. You get a licence to use them for managing your place.",
    licence: "CASA ReOC 9259. ARN 1276251. Aerial Distribution Contractor Licence\nand Pilot Chemical Rating Licence. Public liability insurance held."
  }
};
