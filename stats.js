/* ==========================================================================
   stats.js — everything derived

   Nothing in the ledger stores a total. A night records who sat down, how
   many buy-ins each took and what each cashed out; every figure in the app
   is recomputed from that. Fixing one cash-out fixes every number that
   depends on it, and a new statistic is a function added here rather than
   a migration.
   ========================================================================== */

window.PL = window.PL || {};

PL.Stats = (function () {
  "use strict";

  function num(v) { return Number(v) || 0; }

  function hasCashOut(row) {
    return row && row.cashOut !== null && row.cashOut !== undefined && row.cashOut !== "";
  }

  /** Nights in the order they were played. */
  function chronological(data) {
    return data.nights.slice().sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id));
    });
  }

  function closedNights(data) {
    return chronological(data).filter(function (n) { return n.status === "closed"; });
  }

  function openNight(data) {
    return data.nights.filter(function (n) { return n.status === "open"; })[0] || null;
  }

  function playerById(data, id) {
    return data.players.filter(function (p) { return p.id === id; })[0] || null;
  }

  /** A player removed from the roster still has results on old nights, so
   *  look in the bin too before falling back to the raw id. */
  function nameOf(data, id) {
    var p = playerById(data, id);
    if (p) return p.name;
    var t = (data.trash || []).filter(function (e) {
      return e.kind === "player" && e.item && e.item.id === id;
    })[0];
    return t ? t.item.name : id;
  }

  /** One player's result on one night. */
  function net(night, pid) {
    var row = (night.entries || {})[pid];
    if (!row) return 0;
    return num(row.cashOut) - num(row.buyIns) * num(night.buyIn);
  }

  function moneyIn(night, pid) {
    var row = (night.entries || {})[pid];
    return row ? num(row.buyIns) * num(night.buyIn) : 0;
  }

  /** Whole-night arithmetic, including the balance check that catches a
   *  miscounted chip stack before it poisons every later figure. */
  function nightTotals(night) {
    var e = night.entries || {};
    var buyIn = num(night.buyIn);
    var t = { players: 0, buyIns: 0, moneyIn: 0, moneyOut: 0, counted: 0 };
    Object.keys(e).forEach(function (pid) {
      var row = e[pid] || {};
      t.players++;
      t.buyIns += num(row.buyIns);
      t.moneyIn += num(row.buyIns) * buyIn;
      if (hasCashOut(row)) { t.moneyOut += num(row.cashOut); t.counted++; }
    });
    t.pot = t.moneyIn;
    t.balance = t.moneyOut - t.moneyIn;
    t.complete = t.players > 0 && t.counted === t.players;
    return t;
  }

  /** Per-player all-time table, over closed nights only. */
  function standings(data) {
    var byId = {};

    data.players.forEach(function (p) {
      byId[p.id] = blank(p.id, p.name, p.active !== false);
    });

    closedNights(data).forEach(function (night) {
      var e = night.entries || {};
      Object.keys(e).forEach(function (pid) {
        if (!byId[pid]) byId[pid] = blank(pid, nameOf(data, pid), false);
        var r = byId[pid];
        var row = e[pid] || {};
        var n = net(night, pid);
        r.nights++;
        r.buyIns += num(row.buyIns);
        r.moneyIn += num(row.buyIns) * num(night.buyIn);
        r.moneyOut += num(row.cashOut);
        r.pnl += n;
        if (n > 0) r.winning++;
        if (r.best === null || n > r.best) { r.best = n; r.bestNight = night.date; }
        if (r.worst === null || n < r.worst) { r.worst = n; r.worstNight = night.date; }
        if (num(row.buyIns) > r.mostBuyIns) { r.mostBuyIns = num(row.buyIns); r.mostBuyInsNight = night.date; }
      });
    });

    return Object.keys(byId).map(function (k) {
      var r = byId[k];
      r.perNight = r.nights ? r.pnl / r.nights : 0;
      r.avgBuyIns = r.nights ? r.buyIns / r.nights : 0;
      r.winRate = r.nights ? r.winning / r.nights : 0;
      return r;
    });
  }

  function blank(id, name, active) {
    return {
      id: id, name: name, active: active,
      nights: 0, buyIns: 0, moneyIn: 0, moneyOut: 0, pnl: 0, winning: 0,
      best: null, worst: null, bestNight: "", worstNight: "",
      mostBuyIns: 0, mostBuyInsNight: ""
    };
  }

  /** Running profit for one player, night by night. */
  function cumulative(data, pid) {
    var out = [], run = 0;
    closedNights(data).forEach(function (night) {
      if (!(night.entries || {})[pid]) return;
      var n = net(night, pid);
      run += n;
      out.push({ date: night.date, id: night.id, net: n, cum: run, buyIns: num(night.entries[pid].buyIns) });
    });
    return out;
  }

  /** Longest run of consecutive nights attended (nights they missed break it). */
  function attendanceStreak(data, pid) {
    var best = 0, run = 0;
    closedNights(data).forEach(function (night) {
      if ((night.entries || {})[pid]) { run++; if (run > best) best = run; }
      else run = 0;
    });
    return best;
  }

  /** Longest run of consecutive nights finishing in profit. */
  function winStreak(data, pid) {
    var best = 0, run = 0;
    cumulative(data, pid).forEach(function (row) {
      if (row.net > 0) { run++; if (run > best) best = run; }
      else run = 0;
    });
    return best;
  }

  /** Player × night presence, most recent nights last. */
  function attendance(data, limit) {
    var nights = closedNights(data);
    if (limit && nights.length > limit) nights = nights.slice(nights.length - limit);
    var seen = {};
    nights.forEach(function (n) { Object.keys(n.entries || {}).forEach(function (p) { seen[p] = true; }); });
    var players = data.players
      .filter(function (p) { return seen[p.id]; })
      .map(function (p) { return { id: p.id, name: p.name }; });
    Object.keys(seen).forEach(function (pid) {
      if (!players.some(function (p) { return p.id === pid; })) players.push({ id: pid, name: nameOf(data, pid) });
    });
    players.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return { nights: nights, players: players };
  }

  /* ---------------- the record book ---------------- */

  function row(who, whoId, value, when, format) {
    return { who: who, whoId: whoId, value: value, when: when, format: format || "money" };
  }

  function topN(rows, n, dir) {
    var s = rows.slice().sort(function (a, b) {
      return dir === "asc" ? a.value - b.value : b.value - a.value;
    });
    return s.slice(0, n || 5);
  }

  /**
   * The record book. Each entry is a ranked list; the caller formats the
   * values according to `format`. Records with no data yet are dropped.
   */
  function records(data, n) {
    n = n || 5;
    var nights = closedNights(data);
    var table = standings(data).filter(function (r) { return r.nights > 0; });
    var out = [];

    function add(key, title, sub, rows, dir) {
      var top = topN(rows.filter(function (r) { return r.value !== null && isFinite(r.value); }), n, dir);
      if (top.length) out.push({ key: key, title: title, sub: sub, rows: top });
    }

    /* per-night player records */
    var perNightRows = [];
    var buyInNightRows = [];
    nights.forEach(function (night) {
      Object.keys(night.entries || {}).forEach(function (pid) {
        perNightRows.push(row(nameOf(data, pid), pid, net(night, pid), night.date, "money"));
        buyInNightRows.push(row(nameOf(data, pid), pid, num(night.entries[pid].buyIns), night.date, "int"));
      });
    });

    add("bigwin", "Biggest single night", "Most won in one sitting", perNightRows, "desc");
    add("bigloss", "Worst single night", "Most dropped in one sitting", perNightRows, "asc");
    add("rebuys1", "Most buy-ins in one night", "The deepest hole dug in an evening", buyInNightRows, "desc");

    /* all-time player records */
    add("totalpnl", "All-time profit", "Cumulative, across every closed night",
      table.map(function (r) { return row(r.name, r.id, r.pnl, r.nights + " night" + (r.nights === 1 ? "" : "s"), "money"); }), "desc");

    add("rebuysAll", "Most buy-ins all time", "Total times back in the pocket",
      table.map(function (r) { return row(r.name, r.id, r.buyIns, r.nights + " night" + (r.nights === 1 ? "" : "s"), "int"); }), "desc");

    add("attend", "Most nights played", "Turns up, whatever happens",
      table.map(function (r) { return row(r.name, r.id, r.nights, "", "int"); }), "desc");

    var regulars = table.filter(function (r) { return r.nights >= 3; });
    add("pernight", "Best average night", "Profit per night, three nights minimum",
      regulars.map(function (r) { return row(r.name, r.id, r.perNight, r.nights + " nights", "money"); }), "desc");

    add("winrate", "Best hit rate", "Share of nights finished up, three minimum",
      regulars.map(function (r) { return row(r.name, r.id, r.winRate, Math.round(r.winRate * r.nights) + " of " + r.nights, "pct"); }), "desc");

    add("streak", "Longest hot streak", "Consecutive nights in profit",
      table.map(function (r) { return row(r.name, r.id, winStreak(data, r.id), "", "int"); }).filter(function (r) { return r.value > 1; }), "desc");

    add("loyal", "Longest attendance run", "Consecutive nights without missing one",
      table.map(function (r) { return row(r.name, r.id, attendanceStreak(data, r.id), "", "int"); }).filter(function (r) { return r.value > 1; }), "desc");

    /* night records — the holder is an evening, not a person */
    add("bignight", "Biggest night", "Most money on the table",
      nights.map(function (night) {
        var t = nightTotals(night);
        return row(t.players + " players", null, t.pot, night.date, "amount");
      }), "desc");

    /* notable single pots, logged by hand */
    var pots = [];
    nights.forEach(function (night) {
      (night.pots || []).forEach(function (p) {
        pots.push(row(p.winner ? nameOf(data, p.winner) : (p.note || "Unclaimed"), p.winner || null, num(p.amount), night.date, "amount"));
      });
    });
    add("bigpot", "Biggest pot", "Single hands, logged as they happened", pots, "desc");

    return out;
  }

  return {
    chronological: chronological,
    closedNights: closedNights,
    openNight: openNight,
    playerById: playerById,
    nameOf: nameOf,
    net: net,
    moneyIn: moneyIn,
    hasCashOut: hasCashOut,
    nightTotals: nightTotals,
    standings: standings,
    cumulative: cumulative,
    attendance: attendance,
    attendanceStreak: attendanceStreak,
    winStreak: winStreak,
    records: records
  };
})();
