/* ==========================================================================
   app.js — views, events, wiring
   ========================================================================== */

(function () {
  "use strict";

  var Store = PL.Store;
  var Stats = PL.Stats;
  var Charts = PL.Charts;

  var ICONS = {
    tonight: '<path d="M12 2 4 12l8 10 8-10z"></path>',
    standings: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"></path>',
    records: '<circle cx="12" cy="9" r="6"></circle><path d="M8.5 14.5 7 22l5-2.5L17 22l-1.5-7.5"></path>',
    history: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3.5 2"></path>',
    players: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"></path><circle cx="9.5" cy="7" r="3.5"></circle><path d="M17 4.5a3.5 3.5 0 0 1 0 6.8M21 20v-1.5a4 4 0 0 0-3-3.8"></path>'
  };

  var TABS = [
    { id: "tonight", label: "Tonight" },
    { id: "standings", label: "Standings" },
    { id: "records", label: "Records" },
    { id: "history", label: "History" },
    { id: "players", label: "Players" },
    { id: "settings", label: "Settings", hideFromNav: true }
  ];

  var ui = {
    tab: "tonight",
    player: null,
    sort: { key: "pnl", dir: "desc" },
    openNights: {},
    charts: [],
    bumped: null,
    lastPot: null
  };

  var view, tabsEl, navRow, noticesEl, footnote, eyebrow, gametitle, saveChip, tooltip;

  /* ---------------------------------------------------------------- utils */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function D() { return Store.state.data; }
  function cfg() { return D().config; }
  function canEdit() { return Store.canEdit(); }

  function money(v, short) {
    var n = Number(v) || 0;
    try {
      return new Intl.NumberFormat(cfg().locale || "hr-HR", {
        style: "currency",
        currency: cfg().currency || "EUR",
        minimumFractionDigits: short || Number.isInteger(n) ? 0 : 2,
        maximumFractionDigits: short ? 0 : 2
      }).format(n);
    } catch (e) { return n.toFixed(short ? 0 : 2); }
  }

  function signed(v) {
    var n = Number(v) || 0;
    return (n > 0 ? "+" : "") + money(n);
  }

  function signClass(v) {
    var n = Number(v) || 0;
    return n > 0 ? "pos" : n < 0 ? "neg" : "zero";
  }

  function fmtRecord(value, format) {
    if (format === "int") return String(Math.round(value));
    if (format === "pct") return Math.round(value * 100) + "%";
    if (format === "amount") return money(value);
    if (format === "duration") return hm(value);
    if (format === "rate") return fmtRate(value);
    return signed(value);
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function yesterdayISO() {
    var d = new Date(); d.setDate(d.getDate() - 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function nowHM() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  /** Minutes as "4 h 15 min" or "45 min"; long totals round to whole hours. */
  function hm(mins) {
    if (mins === null || mins === undefined || !isFinite(mins)) return "—";
    mins = Math.round(mins);
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h >= 10) return Math.round(mins / 60) + " h";
    if (!h) return m + " min";
    return h + " h" + (m ? " " + m + " min" : "");
  }

  function fmtRate(v) { return v === null || v === undefined ? "—" : signed(Math.round(v * 100) / 100) + "/h"; }

  /** How long a night has run: its recorded length once it has a finish
   *  time, otherwise start-to-now while it is still tonight's game. */
  function elapsed(night) {
    if (night.end) return Stats.duration(night);
    var a = Stats.clock(night.start), b = Stats.clock(nowHM());
    if (a === null) return null;
    if (night.date === todayISO()) return b >= a ? b - a : null;
    if (night.date === yesterdayISO()) return (b - a + 24 * 60) % (24 * 60);
    return null;
  }

  function prettyDate(iso) { return Charts.fullDate(iso); }

  function weekday(iso) {
    var p = String(iso || "").split("-");
    if (p.length !== 3) return "";
    try { return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString("en-GB", { weekday: "short" }); }
    catch (e) { return ""; }
  }

  function slug(name) {
    var base = String(name).toLowerCase().normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return base || "p";
  }

  function uniqueId(base, taken) {
    var id = base, n = 2;
    while (taken.indexOf(id) !== -1) { id = base + "-" + n; n++; }
    return id;
  }

  function numOrNull(raw) {
    var s = String(raw).trim().replace(",", ".");
    if (s === "") return null;
    var v = Number(s);
    return isFinite(v) ? v : null;
  }

  /* ------------------------------------------------------------ identity */

  /* A player's colour is reinforcement, never the encoding: every badge
     carries their initials and sits beside their name. That is why eight
     hues are safe here when only four would be defensible as data colour. */

  var PALETTE_SIZE = 8;

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function colourIndex(pid) {
    var players = D().players;
    for (var i = 0; i < players.length; i++) {
      if (players[i].id !== pid) continue;
      if (typeof players[i].colour === "number") return players[i].colour % PALETTE_SIZE;
      return i % PALETTE_SIZE;
    }
    // Someone who played but is no longer on the roster: stable hash instead.
    var h = 0;
    for (var k = 0; k < pid.length; k++) h = (h * 31 + pid.charCodeAt(k)) | 0;
    return Math.abs(h) % PALETTE_SIZE;
  }

  function avatar(pid, size) {
    var p = Stats.playerById(D(), pid);
    var cls = "av" + (size ? " " + size : "") + " pc" + colourIndex(pid) + (p && p.active === false ? " away" : "");
    return '<span class="' + cls + '" aria-hidden="true">' + esc(initials(Stats.nameOf(D(), pid))) + "</span>";
  }

  /* ---------------------------------------------------------------- mutate */

  function addPlayer(name) {
    name = String(name || "").trim();
    if (!name || !canEdit()) return;
    var id = uniqueId(slug(name), D().players.map(function (p) { return p.id; }));
    Store.commit(function (d) {
      d.players.push({ id: id, name: name, active: true, joined: todayISO() });
    }, "Add player " + name);
  }

  function updatePlayer(id, patch, label) {
    if (!canEdit()) return;
    Store.commit(function (d) {
      d.players.forEach(function (p) { if (p.id === id) Object.assign(p, patch); });
    }, label || "Update player");
  }

  function deletePlayer(id) {
    if (!canEdit()) return;
    var played = D().nights.some(function (n) { return (n.entries || {})[id]; });
    if (played) {
      alert(Stats.nameOf(D(), id) + " has results on record, so removing them would break past nights. Set them to Away instead.");
      return;
    }
    if (!confirm("Remove " + Stats.nameOf(D(), id) + " from the roster?")) return;
    Store.commit(function (d) {
      d.players = d.players.filter(function (p) { return p.id !== id; });
    }, "Remove player");
  }

  function startNight(date, buyIn, ids, start) {
    if (!canEdit()) return;
    var id = uniqueId(date, D().nights.map(function (n) { return n.id; }));
    Store.commit(function (d) {
      var entries = {};
      ids.forEach(function (pid) { entries[pid] = { buyIns: 1, cashOut: null }; });
      d.nights.push({
        id: id, date: date, buyIn: buyIn, status: "open",
        start: Stats.clock(start) === null ? "" : start, end: "",
        entries: entries, pots: [], notes: "", createdAt: new Date().toISOString()
      });
      d.config.buyIn = buyIn;
    }, "Start night " + date);
    ui.tab = "tonight";
    render();
  }

  function withNight(sid, fn, label) {
    if (!canEdit()) return;
    Store.commit(function (d) {
      d.nights.forEach(function (n) { if (n.id === sid) fn(n); });
    }, label);
  }

  /* ---------------------------------------------------------------- chrome */

  function renderChrome() {
    var live = Stats.openNight(D());
    var closed = Stats.closedNights(D()).length;

    eyebrow.textContent = cfg().gameName ? cfg().gameName : "Home game ledger";
    gametitle.textContent = "Poker Night Ledger";
    document.title = (cfg().gameName ? cfg().gameName + " — " : "") + "Poker Night Ledger";

    tabsEl.innerHTML = TABS.filter(function (t) { return t.id !== "settings"; }).map(function (t) {
      var cnt = t.id === "history" ? (closed || "") :
        t.id === "players" ? (D().players.length || "") :
        t.id === "tonight" && live ? "•" : "";
      return '<button class="tab" role="tab" data-tab="' + t.id + '" aria-selected="' + (ui.tab === t.id) + '">' +
        esc(t.label) + (cnt ? '<span class="cnt">' + esc(cnt) + "</span>" : "") + "</button>";
    }).join("");

    navRow.innerHTML = TABS.filter(function (t) { return !t.hideFromNav; }).map(function (t) {
      return '<button class="navbtn" data-tab="' + t.id + '" aria-selected="' + (ui.tab === t.id) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        ICONS[t.id] + "</svg><span>" + esc(t.label) + "</span></button>";
    }).join("");

    var st = Store.state;
    var label = st.status === "saving" ? "Saving" :
      st.status === "saved" ? "Saved" :
      st.status === "offline" ? "Offline" :
      st.status === "error" ? "Not saved" :
      st.dirty && canEdit() ? "Unsaved" : "";
    saveChip.textContent = label;
    saveChip.setAttribute("data-state", st.status);
  }

  function renderNotices() {
    var out = "";
    var st = Store.state;

    if (st.message) {
      out += '<div class="banner banner-warn"><span>' + esc(st.message) + "</span></div>";
    }
    if (!st.repo && canEditIntent()) {
      out += '<div class="banner"><span>This copy isn\'t linked to a GitHub repo, so changes stay on this device. ' +
        'Set the repo in Settings to sync it.</span></div>';
    }
    noticesEl.innerHTML = out;
  }

  function canEditIntent() { return !!Store.getToken(); }

  /* ---------------------------------------------------------------- tonight */

  function viewTonight() {
    var live = Stats.openNight(D());
    if (!live) return tonightIdle();

    var t = Stats.nightTotals(live);
    var e = live.entries || {};
    var ids = Object.keys(e).sort(function (a, b) {
      return Stats.nameOf(D(), a).localeCompare(Stats.nameOf(D(), b));
    });
    var editable = canEdit();

    var h = '<div class="panel" style="margin-top:20px">';
    h += '<div class="tiles">' +
      tile("In the pot", money(t.moneyIn), t.buyIns + " buy-in" + (t.buyIns === 1 ? "" : "s") + " × " + money(live.buyIn), "", "hero") +
      tile("Cashed out", money(t.moneyOut), t.counted + " of " + t.players + " counted") +
      (t.complete
        ? tile("Balance", t.balance === 0 ? money(0) : signed(t.balance),
            t.balance === 0 ? "Chips and cash agree" : (t.balance > 0 ? "More cash out than went in" : "Short of the pot"),
            t.balance === 0 ? "zero" : "neg")
        : tile("Balance", "—", "Waiting on " + (t.players - t.counted) + " cash-out" + (t.players - t.counted === 1 ? "" : "s"), "zero")) +
      "</div>";

    h += clockRow(live, editable);

    h += '<div class="playerrows">';
    ids.forEach(function (pid) {
      var row = e[pid] || {};
      var b = Number(row.buyIns) || 0;
      var has = Stats.hasCashOut(row);
      var n = has ? (Number(row.cashOut) || 0) - b * live.buyIn : null;
      h += '<div class="prow">' +
        '<div class="a-name">' + avatar(pid) + '<div style="min-width:0">' +
          '<div class="prow-name">' + esc(Stats.nameOf(D(), pid)) + "</div>" +
          '<div class="prow-in">' + money(b * live.buyIn) + " in</div></div></div>";

      if (editable) {
        h += '<div class="a-step"><span class="field-label">Buy-ins</span><div class="stepper">' +
          '<button type="button" data-act="buyins" data-pid="' + esc(pid) + '" data-n="' + (b - 1) + '"' + (b <= 0 ? " disabled" : "") +
            ' aria-label="One fewer buy-in for ' + esc(Stats.nameOf(D(), pid)) + '">&minus;</button>' +
          '<span class="val' + (ui.bumped === pid ? " bump" : "") + '">' + b + "</span>" +
          '<button type="button" data-act="buyins" data-pid="' + esc(pid) + '" data-n="' + (b + 1) + '"' +
            ' aria-label="Another buy-in for ' + esc(Stats.nameOf(D(), pid)) + '">+</button>' +
          "</div></div>" +
          '<div class="a-cash"><label class="field-label" for="co-' + esc(pid) + '">Cash-out</label>' +
          '<input class="input input-num" id="co-' + esc(pid) + '" data-act="cashout" data-pid="' + esc(pid) +
            '" inputmode="decimal" placeholder="—" value="' + (has ? esc(row.cashOut) : "") + '"></div>';
      } else {
        h += '<div class="a-step"><span class="field-label">Buy-ins</span><span class="mono" style="font-weight:600">' + b + "</span></div>" +
          '<div class="a-cash"><span class="field-label">Cash-out</span><span class="mono">' + (has ? money(row.cashOut) : "—") + "</span></div>";
      }

      h += '<div class="a-net prow-net ' + (n === null ? "zero" : signClass(n)) + '"><span class="field-label">Net</span>' +
        (n === null ? "—" : signed(n)) + "</div>" +
        (editable ? '<div class="a-del"><button class="btn btn-sm btn-quiet" data-act="drop" data-pid="' + esc(pid) + '">Drop</button></div>' : '<div class="a-del"></div>') +
        "</div>";
    });
    h += "</div>";

    if (editable) {
      var absent = D().players.filter(function (p) { return !e[p.id]; });
      if (absent.length) {
        h += '<div class="addrow"><span class="field-label" style="margin:0 4px 0 0">Seat someone</span>' +
          absent.map(function (p) {
            return '<button class="chip" data-act="seat" data-pid="' + esc(p.id) + '">' +
              avatar(p.id, "av-sm") + esc(p.name) + "</button>";
          }).join("") + "</div>";
      }

      h += '<div class="addrow"><span class="field-label" style="margin:0 4px 0 0">Log a big pot</span>' +
        '<input class="input input-num" id="pot-amount" inputmode="decimal" placeholder="Amount" style="width:110px">' +
        '<select class="input" id="pot-winner" style="width:auto"><option value="">Won by…</option>' +
        ids.map(function (pid) { return '<option value="' + esc(pid) + '">' + esc(Stats.nameOf(D(), pid)) + "</option>"; }).join("") +
        "</select>" +
        '<input class="input" id="pot-note" placeholder="Note (optional)" style="width:auto;flex:1 1 140px">' +
        '<button class="btn btn-sm" data-act="addpot">Add</button></div>';

      if ((live.pots || []).length) {
        h += '<div class="addrow" style="border-top:0;padding-top:0">' +
          live.pots.map(function (p, i) {
            return '<span class="pill pill-accent pill-text">' + esc(money(p.amount)) +
              (p.winner ? " · " + esc(Stats.nameOf(D(), p.winner)) : "") +
              (p.note ? " · " + esc(p.note) : "") +
              ' <button class="btn btn-sm btn-quiet" style="padding:0 4px;border:0;background:none" data-act="delpot" data-i="' + i + '" aria-label="Remove pot">×</button></span>';
          }).join("") + "</div>";
      }

      h += '<div class="rowfoot">' +
        '<div class="sec-note">' + (t.complete
          ? (t.balance === 0
              ? "Everything balances. Closing locks tonight into the standings."
              : "Cash-outs are " + signed(t.balance) + " off the pot — you can still close, but check the chip count first.")
          : "Enter a cash-out for every player to close the night.") + "</div>" +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-sm btn-danger" data-act="delnight" data-sid="' + esc(live.id) + '">Discard</button>' +
          '<button class="btn btn-primary" data-act="close" data-sid="' + esc(live.id) + '"' + (t.complete ? "" : " disabled") + ">Close the night</button>" +
        "</div></div>";
    }

    h += "</div>";
    return h;
  }

  /* Start and finish times. Local clock times, so a finish before the start
     reads as past midnight. Finish fills itself in at close if left blank. */
  function clockRow(n, editable) {
    var run = elapsed(n);
    var runLabel = n.end ? "Ran for" : "Running";
    var runVal = '<span class="mono clock-run" data-elapsed>' + esc(hm(run)) + "</span>";
    if (!editable) {
      if (!n.start) return "";
      return '<div class="clockrow">' +
        '<span class="clk"><span class="field-label">Started</span><span class="mono">' + esc(n.start) + "</span></span>" +
        (n.end ? '<span class="clk"><span class="field-label">Finished</span><span class="mono">' + esc(n.end) + "</span></span>" : "") +
        '<span class="clk"><span class="field-label">' + runLabel + "</span>" + runVal + "</span></div>";
    }
    return '<div class="clockrow">' +
      '<span class="clk"><label class="field-label" for="t-start">Started</label>' +
        '<input class="input input-time" type="time" id="t-start" data-act="setstart" value="' + esc(n.start || "") + '"></span>' +
      '<span class="clk"><label class="field-label" for="t-end">Finished</label>' +
        '<input class="input input-time" type="time" id="t-end" data-act="setend" value="' + esc(n.end || "") + '"></span>' +
      '<span class="clk"><span class="field-label">' + runLabel + "</span>" + runVal + "</span>" +
      "</div>";
  }

  function tile(label, value, sub, cls, tileCls) {
    return '<div class="tile' + (tileCls ? " " + tileCls : "") + '"><span class="tile-label">' + esc(label) + "</span>" +
      '<span class="tile-value ' + (cls || "") + '">' + esc(value) + "</span>" +
      '<span class="tile-sub">' + esc(sub || "") + "</span></div>";
  }

  function tonightIdle() {
    if (!canEdit()) {
      var last = Stats.closedNights(D()).slice(-1)[0];
      if (!last && !D().players.length) {
        // First run: nobody has set this up yet, so point the owner at the door.
        return '<div class="panel" style="margin-top:20px"><div class="empty">' +
          "<h3>Nothing here yet</h3>" +
          "<p>This ledger is empty. If it's yours, unlock editing with your GitHub token and add the players — " +
          "everyone else just gets to watch.</p>" +
          '<button class="btn btn-primary" data-tab="settings">Set up the ledger</button>' +
          "</div></div>";
      }
      return '<div class="panel" style="margin-top:20px"><div class="empty"><h3>No night in progress</h3>' +
        "<p>" + (last ? "The last one was " + esc(prettyDate(last.date)) + ". Standings and records are up to date."
                      : "Nothing has been played yet.") + "</p></div></div>";
    }
    if (!D().players.length) {
      return '<div class="panel" style="margin-top:20px"><div class="empty">' +
        "<h3>Start with the regulars</h3>" +
        "<p>Add everyone who shows up. You only do this once — from then on you just tick who is at the table.</p></div>" +
        rosterForm() + "</div>";
    }
    var actives = D().players.filter(function (p) { return p.active !== false; });
    return '<div class="panel" style="margin-top:20px">' +
      '<div class="empty"><h3>No night in progress</h3>' +
      "<p>Pick who is playing, confirm the buy-in, and the ledger tracks rebuys from there.</p></div>" +
      '<div class="formgrid" style="border-top:1px solid var(--line)">' +
        '<div class="fld" style="flex:1 1 150px"><label class="field-label" for="new-date">Date</label>' +
          '<input class="input" type="date" id="new-date" value="' + todayISO() + '"></div>' +
        '<div class="fld" style="flex:0 1 130px"><label class="field-label" for="new-buyin">Buy-in</label>' +
          '<input class="input input-num" id="new-buyin" inputmode="decimal" value="' + esc(cfg().buyIn) + '"></div>' +
        '<div class="fld" style="flex:0 1 130px"><label class="field-label" for="new-start">Start time</label>' +
          '<input class="input input-time" type="time" id="new-start" value="' + nowHM() + '"></div>' +
      "</div>" +
      '<div class="addrow" style="border-top:0"><span class="field-label" style="margin:0 4px 0 0">At the table</span>' +
        actives.map(function (p) {
          return '<label class="chip"><input type="checkbox" class="seatpick" value="' + esc(p.id) + '" checked>' +
            avatar(p.id, "av-sm") + esc(p.name) + "</label>";
        }).join("") + "</div>" +
      '<div class="rowfoot"><div class="sec-note">Everyone starts on one buy-in.</div>' +
        '<button class="btn btn-primary" data-act="startnight">Start the night</button></div>' +
      "</div>";
  }

  /* -------------------------------------------------------------- standings */

  function viewStandings() {
    var rows = Stats.standings(D()).filter(function (r) { return r.nights > 0 || r.active; });
    if (!rows.length) {
      return '<div class="panel" style="margin-top:20px"><div class="empty"><h3>Nothing on the books yet</h3>' +
        "<p>Standings fill in as soon as the first night is closed.</p></div></div>";
    }

    var key = ui.sort.key, dir = ui.sort.dir === "asc" ? 1 : -1;
    rows.sort(function (a, b) {
      if (key === "name") return a.name.localeCompare(b.name) * dir;
      return ((a[key] || 0) - (b[key] || 0)) * dir || a.name.localeCompare(b.name);
    });
    var maxAbs = rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.pnl)); }, 0) || 1;
    var timed = rows.some(function (r) { return r.minutes > 0; });

    var cols = [
      { k: "name", label: "Player", cls: "name" },
      { k: "nights", label: "Nights", cls: "num" },
      { k: "buyIns", label: "Buy-ins", cls: "num" },
      { k: "moneyIn", label: "In", cls: "num" },
      { k: "moneyOut", label: "Out", cls: "num" },
      { k: "pnl", label: "P&L", cls: "num" },
      { k: "perNight", label: "Per night", cls: "num" }
    ];
    if (timed) cols.push({ k: "perHour", label: "Per hour", cls: "num" });

    var h = '<div class="sec-head"><h2>All-time standings</h2>' +
      '<p class="sec-note">Closed nights only. Tap a row for that player.</p></div>';
    h += '<div class="panel"><div class="tablescroll"><table><thead><tr><th class="rank"></th>' +
      cols.map(function (c) {
        return '<th class="' + c.cls + " sortable" + (key === c.k ? " sorted" : "") + '" data-sort="' + c.k + '">' +
          esc(c.label) + (key === c.k ? (ui.sort.dir === "asc" ? " ↑" : " ↓") : "") + "</th>";
      }).join("") + '<th><span class="field-label" style="margin:0">P&amp;L</span></th></tr></thead><tbody>';

    rows.forEach(function (r, i) {
      var lp = r.pnl < 0 ? (Math.abs(r.pnl) / maxAbs) * 100 : 0;
      var rp = r.pnl > 0 ? (r.pnl / maxAbs) * 100 : 0;
      h += '<tr class="clickable" data-act="openplayer" data-pid="' + esc(r.id) + '">' +
        '<td class="rank">' + (i + 1) + "</td>" +
        '<td class="name"><span class="namecell">' + avatar(r.id, "av-sm") + "<span>" + esc(r.name) +
          (r.active === false ? ' <span class="pill">Away</span>' : "") + "</span></span></td>" +
        '<td class="num">' + r.nights + "</td>" +
        '<td class="num">' + r.buyIns + "</td>" +
        '<td class="num">' + money(r.moneyIn) + "</td>" +
        '<td class="num">' + money(r.moneyOut) + "</td>" +
        '<td class="num ' + signClass(r.pnl) + '" style="font-weight:600">' + signed(r.pnl) + "</td>" +
        '<td class="num ' + signClass(r.perNight) + '">' + (r.nights ? signed(r.perNight) : "—") + "</td>" +
        (timed ? '<td class="num ' + (r.perHour === null ? "zero" : signClass(r.perHour)) + '">' + esc(fmtRate(r.perHour)) + "</td>" : "") +
        '<td><div class="pnlbar"><div class="half l"><i style="width:' + lp.toFixed(1) + '%"></i></div>' +
          '<div class="axis"></div><div class="half r"><i style="width:' + rp.toFixed(1) + '%"></i></div></div></td>' +
        "</tr>";
    });

    var tot = rows.reduce(function (a, r) {
      a.buyIns += r.buyIns; a.moneyIn += r.moneyIn; a.moneyOut += r.moneyOut; a.pnl += r.pnl; return a;
    }, { buyIns: 0, moneyIn: 0, moneyOut: 0, pnl: 0 });

    h += '</tbody><tfoot><tr><td class="rank"></td><td>Table</td>' +
      '<td class="num">' + Stats.closedNights(D()).length + "</td>" +
      '<td class="num">' + tot.buyIns + "</td>" +
      '<td class="num">' + money(tot.moneyIn) + "</td>" +
      '<td class="num">' + money(tot.moneyOut) + "</td>" +
      '<td class="num ' + signClass(tot.pnl) + '">' + (Math.abs(tot.pnl) < 0.005 ? money(0) : signed(tot.pnl)) + "</td>" +
      "<td></td>" + (timed ? "<td></td>" : "") + "<td></td></tr></tfoot></table></div></div>";

    h += '<div class="legend"><span class="key"><span class="sw" style="background:var(--pos)"></span>Up over all time</span>' +
      '<span class="key"><span class="sw" style="background:var(--neg)"></span>Down over all time</span></div>';

    if (Math.abs(tot.pnl) > 0.005) {
      h += '<div class="banner banner-warn"><span><b>These should add up to zero.</b> They come to ' + esc(signed(tot.pnl)) +
        ", which means a cash-out on one of the nights is wrong. The History tab flags the night that doesn't balance.</span></div>";
    }
    return h;
  }

  /* ---------------------------------------------------------------- records */

  function viewRecords() {
    var recs = Stats.records(D(), 5);
    if (!recs.length) {
      return '<div class="panel" style="margin-top:20px"><div class="empty"><h3>No records yet</h3>' +
        "<p>The record book writes itself once nights start closing.</p></div></div>";
    }
    var h = '<div class="sec-head"><h2>The record book</h2><p class="sec-note">Every list recomputed from the nights</p></div>';
    h += '<div class="recgrid">';
    recs.forEach(function (rec) {
      h += '<div class="reccard"><h3>' + esc(rec.title) + "</h3>" +
        '<p class="sub">' + esc(rec.sub) + "</p>";
      rec.rows.forEach(function (r, i) {
        h += '<div class="recrow' + (i === 0 ? " lead" : "") + '"' +
          (r.whoId ? ' data-act="openplayer" data-pid="' + esc(r.whoId) + '" style="cursor:pointer"' : "") + ">" +
          '<span class="pos-n">' + (i + 1) + "</span>" +
          (r.whoId ? avatar(r.whoId, "av-sm") : "") +
          '<span class="who">' + esc(r.who) + "</span>" +
          (r.when ? '<span class="when">' + esc(/^\d{4}-\d{2}-\d{2}$/.test(r.when) ? Charts.shortDate(r.when) : r.when) + "</span>" : "") +
          '<span class="val ' + (r.format === "money" || r.format === "rate" ? signClass(r.value) : "") + '">' + esc(fmtRecord(r.value, r.format)) + "</span>" +
          "</div>";
      });
      h += "</div>";
    });
    h += "</div>";
    return h;
  }

  /* ---------------------------------------------------------------- history */

  function viewHistory() {
    var closed = Stats.closedNights(D());
    if (!closed.length) {
      return '<div class="panel" style="margin-top:20px"><div class="empty"><h3>No nights on record</h3>' +
        "<p>Closed nights land here — the money on the table, who turned up, and every result.</p></div></div>";
    }

    var totalMins = closed.reduce(function (a, n) { return a + (Stats.duration(n) || 0); }, 0);
    var h = '<div class="sec-head"><h2>History</h2><p class="sec-note">' + closed.length + " night" + (closed.length === 1 ? "" : "s") + " played" +
      (totalMins ? " · " + esc(hm(totalMins)) + " at the table" : "") + "</p></div>";

    h += '<div class="panel"><div class="chartbox">' +
      '<p class="chart-title">Money on the table</p>' +
      '<p class="chart-sub">Total buy-ins per night</p>' +
      '<div data-chart="potbars"></div></div></div>';

    var att = Stats.attendance(D(), 24);
    if (att.players.length) {
      h += '<div class="sec-head"><h2>Who turned up</h2><p class="sec-note">Last ' + att.nights.length + " night" + (att.nights.length === 1 ? "" : "s") + ", coloured by result</p></div>";
      h += '<div class="panel"><div class="chartbox"><div class="attend"><table><thead><tr><th class="rowhead"></th>' +
        att.nights.map(function (n) { return '<th class="colhead">' + esc(Charts.shortDate(n.date)) + "</th>"; }).join("") +
        "</tr></thead><tbody>";
      att.players.forEach(function (p) {
        h += '<tr><th class="rowhead"><span class="namecell">' + avatar(p.id, "av-sm") + "<span>" + esc(p.name) + "</span></span></th>";
        att.nights.forEach(function (n) {
          var present = !!(n.entries || {})[p.id];
          if (!present) {
            h += '<td><span class="cell absent" data-tip="' + esc(Charts.tip(prettyDate(n.date), [["", "Did not play"]])) + '"></span></td>';
          } else {
            var net = Stats.net(n, p.id);
            var bg = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--mid)";
            var op = net === 0 ? 1 : 0.35 + 0.65 * Math.min(1, Math.abs(net) / (n.buyIn * 3 || 1));
            h += '<td><span class="cell" style="background:' + bg + ';opacity:' + op.toFixed(2) + '" data-tip="' +
              esc(Charts.tip(p.name + " · " + prettyDate(n.date), [
                ["Result", signed(net)],
                ["Buy-ins", String((n.entries[p.id] || {}).buyIns || 0)]
              ])) + '"></span></td>';
          }
        });
        h += "</tr>";
      });
      h += "</tbody></table></div>" +
        '<div class="legend"><span class="key"><span class="sw" style="background:var(--pos)"></span>Finished up</span>' +
        '<span class="key"><span class="sw" style="background:var(--neg)"></span>Finished down</span>' +
        '<span class="key"><span class="sw" style="background:transparent;box-shadow:inset 0 0 0 1px var(--line-strong)"></span>Didn\'t play</span>' +
        '<span class="key">Stronger colour means a bigger swing</span></div></div></div>';
    }

    h += '<div class="sec-head"><h2>Every night</h2></div><div class="panel">';
    closed.slice().reverse().forEach(function (n) {
      var t = Stats.nightTotals(n);
      var open = !!ui.openNights[n.id];
      h += '<div class="night">' +
        '<button class="night-head" data-act="togglenight" data-sid="' + esc(n.id) + '" aria-expanded="' + open + '">' +
          '<span class="caret">' + (open ? "▾" : "▸") + "</span>" +
          '<span class="night-date">' + esc(weekday(n.date) + " " + Charts.fullDate(n.date)) + "</span>" +
          '<span class="night-meta">' + t.players + " players · " + t.buyIns + " buy-ins · " + money(t.pot) +
            (Stats.duration(n) !== null ? " · " + esc(hm(Stats.duration(n))) : "") + "</span>" +
          (Math.abs(t.balance) > 0.005 ? '<span class="pill pill-warn">' + esc(signed(t.balance)) + " off</span>" : "") +
        "</button>";
      if (open) h += nightBody(n);
      h += "</div>";
    });
    h += "</div>";
    return h;
  }

  function nightBody(n) {
    var e = n.entries || {};
    var ids = Object.keys(e).sort(function (a, b) { return Stats.net(n, b) - Stats.net(n, a); });
    var h = '<div class="night-body"><div class="tablescroll subtable"><table><thead><tr>' +
      '<th>Player</th><th class="num">Buy-ins</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th>' +
      "</tr></thead><tbody>";
    ids.forEach(function (pid) {
      var row = e[pid] || {};
      var b = Number(row.buyIns) || 0;
      var net = Stats.net(n, pid);
      h += '<tr class="clickable" data-act="openplayer" data-pid="' + esc(pid) + '">' +
        '<td class="name"><span class="namecell">' + avatar(pid, "av-sm") + "<span>" + esc(Stats.nameOf(D(), pid)) + "</span></span></td>" +
        '<td class="num">' + b + "</td>" +
        '<td class="num">' + money(b * n.buyIn) + "</td>" +
        '<td class="num">' + money(Number(row.cashOut) || 0) + "</td>" +
        '<td class="num ' + signClass(net) + '">' + signed(net) + "</td></tr>";
    });
    h += "</tbody></table></div>";
    if (n.start) {
      h += '<p class="sec-note" style="margin:10px 0 0">Started ' + esc(n.start) +
        (n.end ? ", finished " + esc(n.end) + " · " + esc(hm(Stats.duration(n))) : ", no finish time") + "</p>";
    }
    if ((n.pots || []).length) {
      h += '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' +
        n.pots.map(function (p) {
          return '<span class="pill pill-accent pill-text">' + esc(money(p.amount)) +
            (p.winner ? " · " + esc(Stats.nameOf(D(), p.winner)) : "") +
            (p.note ? " · " + esc(p.note) : "") + "</span>";
        }).join("") + "</div>";
    }
    if (canEdit()) {
      h += '<div class="rowactions">' +
        '<button class="btn btn-sm" data-act="reopen" data-sid="' + esc(n.id) + '">Reopen to edit</button>' +
        '<button class="btn btn-sm btn-danger" data-act="delnight" data-sid="' + esc(n.id) + '">Delete</button></div>';
    }
    return h + "</div>";
  }

  /* ---------------------------------------------------------------- players */

  function rosterForm() {
    if (!canEdit()) return "";
    return '<div class="formgrid" style="border-top:1px solid var(--line)">' +
      '<div class="fld" style="flex:1 1 200px"><label class="field-label" for="new-player">Name</label>' +
        '<input class="input" id="new-player" placeholder="e.g. Ivan" autocomplete="off"></div>' +
      '<button class="btn btn-primary" data-act="addplayer">Add player</button></div>';
  }

  function viewPlayers() {
    if (ui.player) return viewPlayerDetail(ui.player);

    var st = {};
    Stats.standings(D()).forEach(function (r) { st[r.id] = r; });
    var roster = D().players.slice().sort(function (a, b) {
      var ra = st[a.id] || { pnl: 0 }, rb = st[b.id] || { pnl: 0 };
      return (rb.pnl || 0) - (ra.pnl || 0);
    });

    var h = '<div class="sec-head"><h2>Players</h2><p class="sec-note">Everyone who has ever sat down</p></div>';

    if (roster.length) {
      h += '<div class="panel"><div class="sparkgrid">';
      roster.forEach(function (p) {
        var r = st[p.id] || { nights: 0, pnl: 0, buyIns: 0 };
        h += '<button class="sparkcard" data-act="openplayer" data-pid="' + esc(p.id) + '">' +
          '<div class="sc-top">' + avatar(p.id, "av-sm") + '<span class="sc-name">' + esc(p.name) + "</span>" +
          '<span class="sc-pnl ' + signClass(r.pnl) + '">' + (r.nights ? signed(r.pnl) : "—") + "</span></div>" +
          '<div class="sc-meta">' + r.nights + " night" + (r.nights === 1 ? "" : "s") + " · " + r.buyIns + " buy-ins" +
            (p.active === false ? " · away" : "") + "</div>" +
          '<div data-chart="spark" data-pid="' + esc(p.id) + '"></div>' +
          "</button>";
      });
      h += "</div></div>";
    }

    if (canEdit()) {
      h += '<div class="sec-head"><h2>Roster</h2></div><div class="panel"><div class="tablescroll"><table><thead><tr>' +
        '<th class="name">Name</th><th>Status</th><th></th></tr></thead><tbody>';
      D().players.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (p) {
        h += "<tr>" +
          '<td class="name"><span class="namecell">' + avatar(p.id, "av-sm") +
            '<input class="input" id="pn-' + esc(p.id) + '" data-act="rename" data-pid="' + esc(p.id) +
            '" value="' + esc(p.name) + '" style="border-color:transparent;background:transparent;padding:4px 6px;font-weight:600"></span></td>' +
          "<td>" + (p.active !== false ? '<span class="pill pill-accent">Regular</span>' : '<span class="pill">Away</span>') + "</td>" +
          '<td style="text-align:right;white-space:nowrap">' +
            '<button class="btn btn-sm" data-act="toggleactive" data-pid="' + esc(p.id) + '">' +
              (p.active !== false ? "Set away" : "Bring back") + "</button> " +
            '<button class="btn btn-sm btn-danger" data-act="delplayer" data-pid="' + esc(p.id) + '">Remove</button></td>' +
          "</tr>";
      });
      h += "</tbody></table></div>" + rosterForm() + "</div>";
    }

    if (!roster.length && !canEdit()) {
      h += '<div class="panel"><div class="empty"><h3>No players yet</h3><p>The roster is empty.</p></div></div>';
    }
    return h;
  }

  function viewPlayerDetail(pid) {
    var r = Stats.standings(D()).filter(function (x) { return x.id === pid; })[0];
    var name = Stats.nameOf(D(), pid);
    var series = Stats.cumulative(D(), pid);

    var h = '<button class="backlink" data-act="closeplayer">← All players</button>';
    h += '<div class="playerhead">' + avatar(pid, "av-xl") +
      '<div class="who"><h2>' + esc(name) + "</h2>" +
      '<div class="meta">' + (r && r.nights ? r.nights + " night" + (r.nights === 1 ? "" : "s") + " played" : "No nights yet") +
      (r && r.active === false ? " · away" : "") + "</div></div></div>";

    if (!r || !r.nights) {
      return h + '<div class="panel"><div class="empty"><h3>No nights yet</h3><p>' + esc(name) +
        " hasn't finished a night at the table.</p></div></div>";
    }

    h += '<div class="panel"><div class="tiles">' +
      tile("All-time", signed(r.pnl), r.nights + " night" + (r.nights === 1 ? "" : "s") + " played", signClass(r.pnl), "hero") +
      tile("Per night", signed(r.perNight), "Average result", signClass(r.perNight)) +
      tile("Buy-ins", String(r.buyIns), r.avgBuyIns.toFixed(1) + " a night") +
      "</div></div>";

    h += '<div class="panel"><div class="chartbox">' +
      '<p class="chart-title">Running profit</p>' +
      '<p class="chart-sub">Where ' + esc(name) + " stands after each night</p>" +
      '<div data-chart="cumulative" data-pid="' + esc(pid) + '"></div></div></div>';

    h += '<div class="panel"><div class="chartbox">' +
      '<p class="chart-title">Night by night</p>' +
      '<p class="chart-sub">Result on each night played</p>' +
      '<div data-chart="netbars" data-pid="' + esc(pid) + '"></div>' +
      '<div class="legend"><span class="key"><span class="sw" style="background:var(--pos)"></span>Up on the night</span>' +
      '<span class="key"><span class="sw" style="background:var(--neg)"></span>Down on the night</span></div>' +
      "</div></div>";

    h += '<div class="sec-head"><h2>Personal bests</h2></div><div class="panel"><div class="tablescroll"><table><tbody>' +
      statRow("Best night", signed(r.best), prettyDate(r.bestNight), signClass(r.best)) +
      statRow("Worst night", signed(r.worst), prettyDate(r.worstNight), signClass(r.worst)) +
      statRow("Most buy-ins in a night", String(r.mostBuyIns), prettyDate(r.mostBuyInsNight), "") +
      statRow("Nights finished up", r.winning + " of " + r.nights, Math.round(r.winRate * 100) + "%", "") +
      statRow("Longest hot streak", Stats.winStreak(D(), pid) + " night" + (Stats.winStreak(D(), pid) === 1 ? "" : "s"), "", "") +
      statRow("Longest attendance run", Stats.attendanceStreak(D(), pid) + " night" + (Stats.attendanceStreak(D(), pid) === 1 ? "" : "s"), "", "") +
      (r.minutes
        ? statRow("Time at the table", hm(r.minutes), r.timedNights + " night" + (r.timedNights === 1 ? "" : "s"), "") +
          statRow("Per hour", fmtRate(r.perHour), "", signClass(r.perHour)) +
          statRow("Longest night", hm(r.longest), prettyDate(r.longestNight), "")
        : "") +
      statRow("Total put in", money(r.moneyIn), "", "") +
      statRow("Total taken out", money(r.moneyOut), "", "") +
      "</tbody></table></div></div>";

    h += '<div class="sec-head"><h2>Every night played</h2></div><div class="panel"><div class="tablescroll"><table><thead><tr>' +
      '<th>Night</th><th class="num">Buy-ins</th><th class="num">Result</th><th class="num">Running</th>' +
      "</tr></thead><tbody>";
    series.slice().reverse().forEach(function (row) {
      h += "<tr><td>" + esc(prettyDate(row.date)) + "</td>" +
        '<td class="num">' + row.buyIns + "</td>" +
        '<td class="num ' + signClass(row.net) + '">' + signed(row.net) + "</td>" +
        '<td class="num ' + signClass(row.cum) + '">' + signed(row.cum) + "</td></tr>";
    });
    h += "</tbody></table></div></div>";
    return h;
  }

  function statRow(label, value, sub, cls) {
    return "<tr><td>" + esc(label) + "</td>" +
      '<td class="num ' + (cls || "") + '" style="font-weight:600">' + esc(value) + "</td>" +
      '<td class="num" style="color:var(--muted);font-weight:400">' + esc(sub || "") + "</td></tr>";
  }

  /* --------------------------------------------------------------- settings */

  function viewSettings() {
    var repo = Store.state.repo;
    var signedIn = canEdit();

    var h = '<div class="sec-head"><h2>Settings</h2></div>';

    h += '<div class="panel">' +
      '<div class="setrow"><div><div class="lbl">' + (signedIn ? "Signed in as the scorekeeper" : "Read-only") + "</div>" +
        '<div class="hint">' + (signedIn
          ? "This device can enter results. Anyone else opening the link sees the ledger but cannot change it."
          : "You are viewing the ledger. Only the scorekeeper's token can write to it.") + "</div></div>" +
        (signedIn
          ? '<button class="btn btn-sm btn-danger" data-act="signout">Sign out</button>'
          : "") + "</div>";

    if (!signedIn) {
      h += '<div class="setbody">' +
        "<p>If this is your ledger, paste your GitHub token to unlock editing on this device. It is stored on this device only and never leaves it except to talk to GitHub.</p>" +
        '<div class="formgrid" style="padding:0">' +
          '<div class="fld" style="flex:1 1 220px"><label class="field-label" for="tok">GitHub token</label>' +
            '<input class="input" id="tok" type="password" placeholder="github_pat_…" autocomplete="off"></div>' +
          '<button class="btn btn-primary" data-act="signin">Unlock editing</button></div>' +
        "<p style='margin-top:10px'>Need one? Create a <b>fine-grained personal access token</b> in GitHub under Settings → Developer settings, scoped to this one repository, with <b>Contents: Read and write</b>. Set an expiry you're happy with — you can always issue a new one.</p>" +
        "</div>";
    }
    h += "</div>";

    h += '<div class="sec-head"><h2>The game</h2></div><div class="panel">' +
      setRow("Standard buy-in", "What one buy-in costs. Each night keeps the amount it was played at, so changing this never rewrites history.",
        '<input class="input input-num ctl" id="set-buyin" inputmode="decimal" data-act="setbuyin" value="' + esc(cfg().buyIn) + '"' + (signedIn ? "" : " disabled") + ">") +
      setRow("Currency", "Three-letter code, used everywhere in the app.",
        '<input class="input ctl" id="set-currency" data-act="setcurrency" value="' + esc(cfg().currency) + '" maxlength="3" style="text-transform:uppercase;width:90px"' + (signedIn ? "" : " disabled") + ">") +
      setRow("Number format", "Locale used to lay out amounts. hr-HR gives 20,00 €.",
        '<input class="input ctl" id="set-locale" data-act="setlocale" value="' + esc(cfg().locale || "hr-HR") + '" style="width:110px"' + (signedIn ? "" : " disabled") + ">") +
      setRow("Game name", "Shown above the title.",
        '<input class="input ctl" id="set-name" data-act="setname" value="' + esc(cfg().gameName) + '" placeholder="Home game ledger" style="width:170px"' + (signedIn ? "" : " disabled") + ">") +
      "</div>";

    h += '<div class="sec-head"><h2>Storage</h2></div><div class="panel">' +
      '<div class="setbody"><p>' + (repo
        ? "Saving to <code>" + esc(repo.owner + "/" + repo.repo) + "</code>, file <code>" + esc(repo.path) + "</code> on branch <code>" + esc(repo.branch) + "</code>. Every change is a commit, so GitHub keeps the full history and you can undo anything from there."
        : "No repository detected. If you are running this somewhere other than GitHub Pages, set it here.") + "</p>" +
      '<div class="formgrid" style="padding:0">' +
        '<div class="fld"><label class="field-label" for="rp-owner">Owner</label><input class="input" id="rp-owner" value="' + esc(repo ? repo.owner : "") + '"></div>' +
        '<div class="fld"><label class="field-label" for="rp-repo">Repository</label><input class="input" id="rp-repo" value="' + esc(repo ? repo.repo : "") + '"></div>' +
        '<div class="fld" style="flex:0 1 110px"><label class="field-label" for="rp-branch">Branch</label><input class="input" id="rp-branch" value="' + esc(repo ? repo.branch : "main") + '"></div>' +
        '<button class="btn" data-act="setrepo">Save</button>' +
      "</div></div></div>";

    h += '<div class="sec-head"><h2>Adding to this</h2></div><div class="panel"><div class="setbody">' +
      "<p>No total is stored anywhere. A night records only who played, how many buy-ins they took and what they cashed out; profit, attendance, buy-in counts and every record are recomputed from that each time the app opens. Correcting one cash-out corrects every figure that depends on it.</p>" +
      "<p>That also means a new statistic is a function in <code>stats.js</code>, not a change to the data. Knockouts, who hosted, a settle-up tracker — each slots onto the nights already recorded.</p>" +
      "</div></div>";

    return h;
  }

  function setRow(label, hint, control) {
    return '<div class="setrow"><div><div class="lbl">' + esc(label) + "</div>" +
      '<div class="hint">' + esc(hint) + "</div></div>" + control + "</div>";
  }

  /* ---------------------------------------------------------------- render */

  function snapshotFocus() {
    var el = document.activeElement;
    if (!el || !el.id || (el.tagName !== "INPUT" && el.tagName !== "SELECT")) return null;
    return { id: el.id, start: el.selectionStart, end: el.selectionEnd };
  }

  function restoreFocus(f) {
    if (!f) return;
    var el = document.getElementById(f.id);
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
      if (f.start != null && el.setSelectionRange && el.type !== "number" && el.type !== "date") {
        el.setSelectionRange(f.start, f.end);
      }
    } catch (e) { /* ignore */ }
  }

  function render() {
    var f = snapshotFocus();
    renderChrome();
    renderNotices();

    var html;
    if (ui.tab === "tonight") html = viewTonight();
    else if (ui.tab === "standings") html = viewStandings();
    else if (ui.tab === "records") html = viewRecords();
    else if (ui.tab === "history") html = viewHistory();
    else if (ui.tab === "players") html = viewPlayers();
    else html = viewSettings();

    view.innerHTML = html;
    mountCharts();

    var live = Stats.openNight(D());
    footnote.textContent = canEdit()
      ? (live ? "Tonight is still open, so it isn't in the standings yet." : "")
      : "This is a read-only view. Only the scorekeeper can change the ledger.";

    animatePot();
    ui.bumped = null;

    restoreFocus(f);
  }

  /* The pot is the number people watch, so let it move when it changes
     rather than teleporting. Everything else stays still. */
  function animatePot() {
    var el = view.querySelector(".tile.hero .tile-value");
    var live = Stats.openNight(D());
    if (!el || !live) { ui.lastPot = null; return; }
    var to = Stats.nightTotals(live).moneyIn;
    var from = ui.lastPot;
    ui.lastPot = to;
    if (from === null || from === to) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var start = performance.now(), dur = 420;
    (function step(now) {
      var k = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - k, 3);
      el.textContent = money(from + (to - from) * eased);
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = money(to);
    })(start);
  }

  function mountCharts() {
    Charts.clear();
    Array.prototype.forEach.call(view.querySelectorAll("[data-chart]"), function (el) {
      var type = el.getAttribute("data-chart");
      var pid = el.getAttribute("data-pid");
      if (type === "potbars") {
        Charts.mount(el, {
          type: "potbars", fmt: money, height: 180,
          data: Stats.closedNights(D()).map(function (n) {
            var t = Stats.nightTotals(n);
            return { date: n.date, value: t.pot, players: t.players, buyIns: t.buyIns };
          })
        });
      } else if (type === "cumulative") {
        Charts.mount(el, { type: "cumulative", fmt: money, height: 220, data: Stats.cumulative(D(), pid) });
      } else if (type === "netbars") {
        Charts.mount(el, { type: "netbars", fmt: money, height: 180, data: Stats.cumulative(D(), pid) });
      } else if (type === "spark") {
        Charts.mount(el, { type: "spark", height: 40, data: Stats.cumulative(D(), pid) });
      }
    });
  }

  /* ---------------------------------------------------------------- events */

  function go(tab) {
    if (ui.tab === tab && tab !== "players") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    ui.tab = tab;
    if (tab !== "players") ui.player = null;
    window.scrollTo(0, 0);
    render();
  }

  function bind() {
    document.getElementById("btn-settings").addEventListener("click", function () { go("settings"); });

    document.addEventListener("click", function (ev) {
      var nav = ev.target.closest("[data-tab]");
      if (nav) { go(nav.getAttribute("data-tab")); return; }

      var sortEl = ev.target.closest("[data-sort]");
      if (sortEl) {
        var k = sortEl.getAttribute("data-sort");
        if (ui.sort.key === k) ui.sort.dir = ui.sort.dir === "asc" ? "desc" : "asc";
        else { ui.sort.key = k; ui.sort.dir = k === "name" ? "asc" : "desc"; }
        render();
        return;
      }

      var el = ev.target.closest("[data-act]");
      if (!el) return;
      var act = el.getAttribute("data-act");
      var pid = el.getAttribute("data-pid");
      var sid = el.getAttribute("data-sid");
      var live = Stats.openNight(D());

      switch (act) {
        case "openplayer":
          ui.player = pid; ui.tab = "players"; window.scrollTo(0, 0); render(); break;
        case "closeplayer":
          ui.player = null; render(); break;

        case "buyins":
          ui.bumped = pid;
          if (live) withNight(live.id, function (n) {
            n.entries[pid] = Object.assign({}, n.entries[pid], { buyIns: Math.max(0, Number(el.getAttribute("data-n")) || 0) });
          }, "Buy-in for " + Stats.nameOf(D(), pid));
          render(); break;

        case "drop":
          if (live) withNight(live.id, function (n) { delete n.entries[pid]; }, "Remove from night");
          render(); break;

        case "seat":
          if (live) withNight(live.id, function (n) { n.entries[pid] = { buyIns: 1, cashOut: null }; }, "Seat " + Stats.nameOf(D(), pid));
          render(); break;

        case "addpot": {
          var amt = numOrNull((document.getElementById("pot-amount") || {}).value);
          if (amt === null || amt <= 0) { alert("Enter the size of the pot."); return; }
          var winner = (document.getElementById("pot-winner") || {}).value || "";
          var note = ((document.getElementById("pot-note") || {}).value || "").trim();
          if (live) withNight(live.id, function (n) {
            n.pots = n.pots || [];
            n.pots.push({ amount: amt, winner: winner, note: note });
          }, "Log a pot");
          render(); break;
        }

        case "delpot": {
          var idx = Number(el.getAttribute("data-i"));
          if (live) withNight(live.id, function (n) { (n.pots || []).splice(idx, 1); }, "Remove pot");
          render(); break;
        }

        case "close":
          withNight(sid, function (n) {
            // Closing at the table stamps the finish time; closing a night
            // entered after the fact leaves it for you to fill in.
            if (n.start && !n.end && elapsed(n) !== null) n.end = nowHM();
            n.status = "closed";
            n.closedAt = new Date().toISOString();
          }, "Close night");
          Store.flush();
          render(); break;

        case "reopen":
          withNight(sid, function (n) { n.status = "open"; n.closedAt = ""; }, "Reopen night");
          ui.tab = "tonight"; render(); break;

        case "delnight":
          if (!confirm("Delete this night and everything recorded on it? This cannot be undone.")) return;
          if (canEdit()) Store.commit(function (d) {
            d.nights = d.nights.filter(function (n) { return n.id !== sid; });
          }, "Delete night");
          render(); break;

        case "togglenight":
          ui.openNights[sid] = !ui.openNights[sid]; render(); break;

        case "startnight": {
          var date = (document.getElementById("new-date") || {}).value || todayISO();
          var buyIn = numOrNull((document.getElementById("new-buyin") || {}).value);
          var picks = Array.prototype.map.call(document.querySelectorAll(".seatpick:checked"), function (c) { return c.value; });
          if (!picks.length) { alert("Pick at least one player for tonight."); return; }
          if (buyIn === null || buyIn <= 0) { alert("Set a buy-in above zero."); return; }
          startNight(date, buyIn, picks, (document.getElementById("new-start") || {}).value || "");
          break;
        }

        case "addplayer": {
          var inp = document.getElementById("new-player");
          if (inp && inp.value.trim()) { addPlayer(inp.value); inp.value = ""; render(); document.getElementById("new-player") && document.getElementById("new-player").focus(); }
          break;
        }

        case "toggleactive": {
          var p = Stats.playerById(D(), pid);
          if (p) { updatePlayer(pid, { active: p.active === false }, "Update player"); render(); }
          break;
        }

        case "delplayer": deletePlayer(pid); render(); break;

        case "signin": {
          var t = (document.getElementById("tok") || {}).value || "";
          if (!t.trim()) return;
          Store.setToken(t.trim());
          Store.load().then(render);
          render();
          break;
        }

        case "signout":
          if (!confirm("Sign out of editing on this device?")) return;
          Store.setToken("");
          render(); break;

        case "setrepo": {
          var owner = (document.getElementById("rp-owner") || {}).value.trim();
          var name = (document.getElementById("rp-repo") || {}).value.trim();
          var branch = (document.getElementById("rp-branch") || {}).value.trim() || "main";
          if (!owner || !name) { alert("Owner and repository are both needed."); return; }
          Store.setRepo({ owner: owner, repo: name, branch: branch, path: "data.json" });
          Store.load().then(render);
          break;
        }
      }
    });

    document.addEventListener("change", function (ev) {
      var el = ev.target;
      var act = el.getAttribute && el.getAttribute("data-act");
      if (!act) return;
      var live = Stats.openNight(D());
      var pid = el.getAttribute("data-pid");

      if (act === "cashout" && live) {
        withNight(live.id, function (n) {
          n.entries[pid] = Object.assign({}, n.entries[pid], { cashOut: numOrNull(el.value) });
        }, "Cash-out for " + Stats.nameOf(D(), pid));
        render();
      } else if ((act === "setstart" || act === "setend") && live) {
        var field = act === "setstart" ? "start" : "end";
        var hhmm = Stats.clock(el.value) === null ? "" : el.value;
        withNight(live.id, function (n) { n[field] = hhmm; }, field === "start" ? "Set start time" : "Set finish time");
        render();
      } else if (act === "rename") {
        updatePlayer(pid, { name: el.value.trim() || Stats.nameOf(D(), pid) }, "Rename player");
      } else if (act === "setbuyin") {
        var v = numOrNull(el.value);
        if (v !== null && v > 0) { Store.commit(function (d) { d.config.buyIn = v; }, "Change buy-in"); render(); }
      } else if (act === "setcurrency") {
        Store.commit(function (d) { d.config.currency = (el.value || "EUR").toUpperCase().slice(0, 3); }, "Change currency");
        render();
      } else if (act === "setlocale") {
        Store.commit(function (d) { d.config.locale = el.value.trim() || "hr-HR"; }, "Change number format");
        render();
      } else if (act === "setname") {
        Store.commit(function (d) { d.config.gameName = el.value.trim(); }, "Rename the game");
        render();
      }
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      var el = ev.target;
      if (el && el.id === "new-player") { addPlayer(el.value); el.value = ""; render(); }
      else if (el && el.id === "tok") { document.querySelector('[data-act="signin"]').click(); }
      else if (el && el.getAttribute && el.getAttribute("data-act") === "cashout") el.blur();
    });

    // tooltips — shared element, follows the pointer
    var tipTarget = null;
    document.addEventListener("pointerover", function (ev) {
      var el = ev.target.closest ? ev.target.closest("[data-tip]") : null;
      if (!el) { if (tipTarget) { tooltip.hidden = true; tipTarget = null; } return; }
      if (el === tipTarget) return;
      tipTarget = el;
      tooltip.innerHTML = el.getAttribute("data-tip");
      tooltip.hidden = false;
      place(ev);
    });
    document.addEventListener("pointermove", function (ev) { if (!tooltip.hidden) place(ev); });
    document.addEventListener("pointerdown", function () { tooltip.hidden = true; tipTarget = null; });
    window.addEventListener("scroll", function () { tooltip.hidden = true; tipTarget = null; }, { passive: true });

    function place(ev) {
      var pad = 12;
      var r = tooltip.getBoundingClientRect();
      var x = Math.min(ev.clientX + pad, window.innerWidth - r.width - 8);
      var y = ev.clientY - r.height - pad;
      if (y < 8) y = ev.clientY + pad + 8;
      tooltip.style.left = Math.max(8, x) + "px";
      tooltip.style.top = y + "px";
    }

    window.addEventListener("beforeunload", function () { if (Store.state.dirty) Store.flush(); });
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    view = document.getElementById("view");
    tabsEl = document.getElementById("tabs");
    navRow = document.getElementById("navrow");
    noticesEl = document.getElementById("notices");
    footnote = document.getElementById("footnote");
    eyebrow = document.getElementById("eyebrow");
    gametitle = document.getElementById("gametitle");
    saveChip = document.getElementById("savechip");
    tooltip = document.getElementById("tooltip");

    bind();
    Store.on(function () { renderChrome(); renderNotices(); });
    render();
    Store.init().then(render);

    setInterval(function () {
      var el = view.querySelector("[data-elapsed]");
      var live = Stats.openNight(D());
      if (el && live && !live.end) el.textContent = hm(elapsed(live));
    }, 30000);

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () { /* fine without it */ });
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
