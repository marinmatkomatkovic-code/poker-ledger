/* ==========================================================================
   store.js — persistence and recovery

   The ledger is a single JSON file (data.json) committed to a GitHub repo.
   Anyone can read it, because the repo is public. Only someone holding a
   token with write access to that repo can change it, which is how "only
   the scorekeeper enters data" is enforced — by GitHub, not by hidden
   buttons.

   Nothing here is one-way. There are four layers of recovery, shallowest
   first:

     1. Undo/redo   — every change snapshots the whole ledger first, so any
                      action, not just a deletion, can be stepped back.
     2. Trash       — deleted nights and players are moved aside inside the
                      ledger rather than destroyed, and survive reloads and
                      other devices.
     3. Versions    — every save is a git commit, so any earlier state of
                      the ledger can be fetched back and restored.
     4. Backup file — the whole ledger exports to a file and imports again.

   Reads:  GitHub Contents API (fresh), falling back to the deployed
           data.json if the API rate-limits an anonymous visitor.
   Writes: Contents API PUT, debounced so a burst of rebuy taps becomes
           one commit.
   Local:  a copy in localStorage, so the app opens instantly and keeps
           working with no signal. Unsaved changes retry when the
           connection returns.

   Lock:   once the scorekeeper locks the ledger (crypto.js), data.json and
           the local copy are only ever written encrypted. The app opens to
           a password screen until a weekly or scorekeeper password unlocks
           the data key; the password is remembered on that phone, and a
           phone whose weekly password has since changed is asked again.
   ========================================================================== */

window.PL = window.PL || {};

PL.Store = (function () {
  "use strict";

  var LS_DATA = "pl:data";
  var LS_SHA = "pl:sha";
  var LS_DIRTY = "pl:dirty";
  var LS_TOKEN = "pl:token";
  var LS_REPO = "pl:repo";
  var LS_PASS = "pl:pass";
  var Crypt = PL.Crypt;

  var SAVE_DELAY = 2000;
  var UNDO_DEPTH = 40;

  var listeners = [];
  var saveTimer = null;
  var savingNow = false;

  var undoStack = [];
  var redoStack = [];

  var S = {
    data: emptyLedger(),
    sha: null,
    token: null,
    repo: null,
    dirty: false,
    /** idle | loading | saving | saved | error | offline */
    status: "idle",
    message: "",
    loadedRemote: false,
    pendingLabel: null,
    /* lock */
    env: null,        // the file's lock (crypto header) once the ledger is encrypted
    sealed: null,     // the newest encrypted file seen, waiting for a password
    raw: null,        // the data key, once unlocked (memory only)
    slot: null,       // which password opened it: "weekly" | "keeper"
    slotSig: "",      // that slot exactly — if GitHub's copy differs, the password changed
    locked: false
  };

  function emptyLedger() {
    return {
      version: 1,
      config: { gameName: "", buyIn: 20, currency: "EUR", locale: "hr-HR" },
      players: [],
      nights: [],
      trash: []
    };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- encoding ---------------- */

  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------------- repo coordinates ---------------- */

  function detectRepo() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_REPO) || "null"); } catch (e) { /* ignore */ }
    if (saved && saved.owner && saved.repo) return saved;

    var m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (m) {
      var seg = location.pathname.split("/").filter(Boolean);
      return { owner: m[1], repo: seg.length ? seg[0] : location.hostname, branch: "main", path: "data.json" };
    }
    return null;
  }

  function setRepo(cfg) {
    S.repo = cfg;
    try { localStorage.setItem(LS_REPO, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  function apiBase() {
    if (!S.repo) return null;
    return "https://api.github.com/repos/" + encodeURIComponent(S.repo.owner) + "/" + encodeURIComponent(S.repo.repo);
  }

  function apiUrl() {
    var b = apiBase();
    return b ? b + "/contents/" + S.repo.path : null;
  }

  /* ---------------- local cache ---------------- */

  function readLocal() {
    try {
      var raw = localStorage.getItem(LS_DATA);
      if (!raw) return false;
      var j = JSON.parse(raw);
      if (Crypt.isLocked(j)) {
        S.sealed = j;
        S.env = Crypt.header(j);
        S.locked = true;
        S.data = emptyLedger();
      } else {
        S.data = migrate(j);
      }
      S.sha = localStorage.getItem(LS_SHA) || null;
      S.dirty = localStorage.getItem(LS_DIRTY) === "1";
      return true;
    } catch (e) { return false; }
  }

  /* Once encrypted, the phone's copy is encrypted too — a phone whose
     password has changed holds nothing readable. Writes are queued so an
     older copy never lands after a newer one. */
  var localQueue = Promise.resolve();
  function writeLocal() {
    var meta = function () {
      if (S.sha) localStorage.setItem(LS_SHA, S.sha);
      localStorage.setItem(LS_DIRTY, S.dirty ? "1" : "0");
    };
    if (S.env) {
      if (!S.raw) {   // locked: keep whatever sealed copy we have
        try { if (S.sealed) localStorage.setItem(LS_DATA, JSON.stringify(S.sealed)); meta(); } catch (e) { /* quota */ }
        return;
      }
      var snapshot = clone(S.data), raw = S.raw, head = S.env;
      localQueue = localQueue.then(function () {
        return Crypt.close(raw, head, snapshot).then(function (file) {
          S.sealed = file;
          try { localStorage.setItem(LS_DATA, JSON.stringify(file)); meta(); } catch (e) { /* quota */ }
        });
      }).catch(function () { /* never break the chain */ });
      return;
    }
    try {
      localStorage.setItem(LS_DATA, JSON.stringify(S.data));
      meta();
    } catch (e) { /* quota — not fatal */ }
  }

  function migrate(d) {
    var base = emptyLedger();
    if (!d || typeof d !== "object") return base;
    d.version = d.version || 1;
    d.config = Object.assign({}, base.config, d.config || {});
    d.players = Array.isArray(d.players) ? d.players : [];
    d.nights = Array.isArray(d.nights) ? d.nights : [];
    d.trash = Array.isArray(d.trash) ? d.trash : [];
    d.nights.forEach(function (n) {
      n.entries = n.entries || {};
      n.pots = Array.isArray(n.pots) ? n.pots : [];
      if (n.status !== "open" && n.status !== "closed") n.status = "closed";
    });
    return d;
  }

  /** A ledger is only worth adopting if it looks like one. */
  function looksValid(d) {
    return !!d && typeof d === "object" && Array.isArray(d.players) && Array.isArray(d.nights);
  }

  /* ---------------- events ---------------- */

  function on(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(function (f) { try { f(S); } catch (e) { /* ignore */ } }); }

  function setStatus(status, message) {
    S.status = status;
    S.message = message || "";
    emit();
  }

  /* ---------------- token ---------------- */

  function getToken() {
    if (S.token !== null) return S.token;
    try { S.token = localStorage.getItem(LS_TOKEN) || ""; } catch (e) { S.token = ""; }
    return S.token;
  }

  function setToken(t) {
    S.token = String(t || "").trim();
    try {
      if (S.token) localStorage.setItem(LS_TOKEN, S.token);
      else localStorage.removeItem(LS_TOKEN);
    } catch (e) { /* ignore */ }
    emit();
  }

  function canEdit() { return !!getToken() && !!S.repo; }

  function headers(auth) {
    var h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (auth && getToken()) h["Authorization"] = "Bearer " + getToken();
    return h;
  }

  /* ---------------- lock ---------------- */

  function remembered() { try { return localStorage.getItem(LS_PASS) || ""; } catch (e) { return ""; } }
  function remember(pw) { try { localStorage.setItem(LS_PASS, pw); } catch (e) { /* ignore */ } }

  function isEncrypted() { return !!S.env; }
  function isLocked() { return S.locked; }

  /** Take in a file from GitHub (or the deployed copy). Encrypted files are
   *  opened with the key in hand, or the phone's remembered password. */
  function adopt(file) {
    if (!Crypt.isLocked(file)) {
      S.env = null; S.sealed = null; S.raw = null; S.slot = null; S.locked = false;
      S.data = migrate(file);
      writeLocal();
      return Promise.resolve();
    }
    S.env = Crypt.header(file);
    S.sealed = file;
    // The password this phone used has been changed (Monday): ask it again,
    // even though the key is already in memory from the phone's own copy.
    if (S.raw && S.slot && JSON.stringify(file.slots[S.slot] || null) !== S.slotSig) {
      S.raw = null;
      return tryRemembered();
    }
    if (S.raw) {
      return Crypt.open(S.raw, file).then(function (d) {
        S.data = migrate(d); S.locked = false; writeLocal();
      }, function () { S.raw = null; return tryRemembered(); });
    }
    return tryRemembered();
  }

  function tryRemembered() {
    var pw = remembered();
    if (!pw) { lockUp(); return Promise.resolve(); }
    return unlock(pw, true).then(function (ok) { if (!ok) lockUp(); });
  }

  function lockUp() {
    S.raw = null; S.slot = null; S.slotSig = ""; S.locked = true;
    S.data = emptyLedger();
    emit();
  }

  /** Try a password. Resolves true if it opens the ledger. */
  function unlock(pw, quiet) {
    if (!S.sealed || !Crypt.available()) return Promise.resolve(false);
    var sealed = S.sealed;
    var heads = [S.env, Crypt.header(sealed)].filter(function (h, i, a) {
      return h && (i === 0 || JSON.stringify(h.slots) !== JSON.stringify(a[0].slots));
    });
    var attempt = function (i) {
      if (i >= heads.length) return Promise.resolve(null);
      return Crypt.unlock(heads[i], pw).then(function (hit) {
        if (hit) { hit.sig = JSON.stringify(heads[i].slots[hit.slot]); return hit; }
        return attempt(i + 1);
      });
    };
    return attempt(0).then(function (hit) {
      if (!hit) return false;
      return Crypt.open(hit.raw, sealed).then(function (d) {
        S.raw = hit.raw;
        S.slot = hit.slot;
        S.slotSig = hit.sig;
        S.data = migrate(d);
        S.locked = false;
        remember(pw);
        writeLocal();
        if (!quiet) emit();
        if (S.dirty && canEdit()) flush();
        return true;
      }, function () { return false; });
    });
  }

  /** This phone forgets the password and locks again. */
  function lockPhone() {
    try { localStorage.removeItem(LS_PASS); } catch (e) { /* ignore */ }
    if (S.env) { writeLocal(); lockUp(); }
  }

  /** Scorekeeper, once: encrypt the ledger from now on. */
  function lockLedger(keeperPw, weeklyPw) {
    if (!canEdit() || S.env || !Crypt.available()) return Promise.reject(new Error("unavailable"));
    return Crypt.create(keeperPw, weeklyPw).then(function (made) {
      S.raw = made.raw;
      S.env = made.head;
      S.slot = "keeper";
      S.slotSig = JSON.stringify(made.head.slots.keeper);
      S.locked = false;
      remember(keeperPw);
      S.dirty = true;
      S.pendingLabel = "Lock the ledger";
      writeLocal();
      emit();
      return flush().then(function () { return { weekly: weeklyPw, key: Crypt.toB64(made.raw) }; });
    });
  }

  /** Scorekeeper: a new weekly password now, without waiting for Monday. */
  function newWeeklyPassword(pw) {
    if (!canEdit() || !S.env || !S.raw) return Promise.reject(new Error("unavailable"));
    return Crypt.rotate(S.raw, S.env, pw).then(function (head) {
      S.env = head;
      if (S.slot === "weekly") S.slotSig = JSON.stringify(head.slots.weekly);
      S.dirty = true;
      S.pendingLabel = "New weekly password";
      writeLocal();
      emit();
      return flush();
    });
  }

  function weeklyPassword() {
    if (!S.env || !S.raw) return Promise.resolve("");
    return Crypt.weeklyPassword(S.raw, S.env).catch(function () { return ""; });
  }

  function weekOfPassword() { return S.env && S.env.slots.weekly ? S.env.slots.weekly.week || "" : ""; }

  /** The data key, for the GitHub secret that lets the Monday job work. */
  function dataKey() { return S.raw ? Crypt.toB64(S.raw) : ""; }

  /* ---------------- load ---------------- */

  function loadDeployedCopy() {
    return fetch("data.json?ts=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if ((Crypt.isLocked(j) || looksValid(j)) && !S.dirty) return adopt(j);
      })
      .then(function () { setStatus("idle"); })
      .catch(function () { setStatus("offline"); });
  }

  function load() {
    var url = apiUrl();
    if (!url) return loadDeployedCopy();

    setStatus("loading");
    return fetch(url + "?ref=" + encodeURIComponent(S.repo.branch) + "&ts=" + Date.now(), {
      headers: headers(true), cache: "no-store"
    }).then(function (res) {
      if (res.status === 404) { S.sha = null; S.loadedRemote = true; return null; }
      if (res.status === 403 || res.status === 429) throw new Error("ratelimit");
      if (!res.ok) throw new Error("http " + res.status);
      return res.json();
    }).then(function (j) {
      S.loadedRemote = true;
      if (j && j.content) {
        var remote = JSON.parse(b64ToUtf8(j.content));
        if (!Crypt.isLocked(remote) && !looksValid(remote)) throw new Error("malformed");
        S.sha = j.sha;
        if (S.dirty) {
          // Keep this phone's unsaved changes, but take GitHub's newest lock
          // (Monday's password change) so saving doesn't undo it.
          if (Crypt.isLocked(remote)) S.env = Crypt.header(remote);
          writeLocal(); setStatus("idle");
          return S.locked ? tryRemembered() : flush();
        }
        return adopt(remote).then(function () { setStatus("idle"); });
      }
      setStatus("idle");
    }).catch(function (err) {
      var m = String(err && err.message);
      if (m === "ratelimit") return loadDeployedCopy();
      if (m === "malformed") { setStatus("error", "The ledger file on GitHub isn't readable. Restore an earlier version in Settings."); return; }
      setStatus(navigator.onLine ? "error" : "offline", navigator.onLine ? "Couldn't reach GitHub." : "");
    });
  }

  /* ---------------- undo / redo ---------------- */

  /** Record a change. Every mutation goes through here, so every mutation
   *  is undoable — a corrected cash-out just as much as a deleted night. */
  function commit(mutator, label) {
    var before = JSON.stringify(S.data);
    mutator(S.data);
    if (JSON.stringify(S.data) === before) return;   // nothing actually changed

    undoStack.push({ snapshot: before, label: label || "Change" });
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    redoStack.length = 0;

    S.dirty = true;
    writeLocal();
    emit();
    if (!canEdit()) return;
    S.pendingLabel = label || S.pendingLabel || "Update ledger";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function applySnapshot(json, label) {
    S.data = migrate(JSON.parse(json));
    S.dirty = true;
    writeLocal();
    emit();
    if (!canEdit()) return;
    S.pendingLabel = label;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function undo() {
    if (!undoStack.length) return null;
    var entry = undoStack.pop();
    redoStack.push({ snapshot: JSON.stringify(S.data), label: entry.label });
    applySnapshot(entry.snapshot, "Undo: " + entry.label);
    return entry.label;
  }

  function redo() {
    if (!redoStack.length) return null;
    var entry = redoStack.pop();
    undoStack.push({ snapshot: JSON.stringify(S.data), label: entry.label });
    applySnapshot(entry.snapshot, "Redo: " + entry.label);
    return entry.label;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }
  function undoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : null; }
  function redoLabel() { return redoStack.length ? redoStack[redoStack.length - 1].label : null; }

  /* ---------------- save ---------------- */

  function flush() {
    clearTimeout(saveTimer);
    if (!S.dirty || !canEdit() || savingNow || S.locked) return Promise.resolve();
    if (S.env && !S.raw) return Promise.resolve();   // never save without the key

    savingNow = true;
    setStatus("saving");

    if (S.env) S.env.eyebrow = (S.data.config && S.data.config.gameName) || "";
    var payload = S.env
      ? Crypt.close(S.raw, S.env, S.data).then(function (file) { return JSON.stringify(file, null, 2) + "\n"; })
      : Promise.resolve(JSON.stringify(S.data, null, 2) + "\n");

    return payload.then(function (text) {
      var body = {
        message: S.pendingLabel || "Update ledger",
        content: utf8ToB64(text),
        branch: S.repo.branch
      };
      if (S.sha) body.sha = S.sha;
      return fetch(apiUrl(), {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, headers(true)),
        body: JSON.stringify(body)
      });
    }).then(function (res) {
      if (res.status === 409 || res.status === 422) {
        return fetch(apiUrl() + "?ref=" + encodeURIComponent(S.repo.branch) + "&ts=" + Date.now(), {
          headers: headers(true), cache: "no-store"
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            savingNow = false;
            if (j && j.sha) {
              S.sha = j.sha;
              // Someone else wrote first — usually Monday's password change.
              // Keep the ledger we're saving, but under GitHub's newest lock.
              try {
                var theirs = JSON.parse(b64ToUtf8(j.content));
                if (S.env && Crypt.isLocked(theirs)) S.env = Crypt.header(theirs);
              } catch (e) { /* keep ours */ }
              return flush();
            }
            throw new Error("conflict");
          });
      }
      if (res.status === 401 || res.status === 403) throw new Error("auth");
      if (!res.ok) throw new Error("http " + res.status);
      return res.json().then(function (j) {
        if (j && j.content && j.content.sha) S.sha = j.content.sha;
        S.dirty = false;
        savingNow = false;
        S.pendingLabel = null;
        writeLocal();
        setStatus("saved");
        setTimeout(function () { if (S.status === "saved") setStatus("idle"); }, 2200);
      });
    }).catch(function (err) {
      savingNow = false;
      var m = String(err && err.message);
      if (m === "auth") setStatus("error", "GitHub rejected the token. Check it in Settings.");
      else if (!navigator.onLine) setStatus("offline", "Saved on this device. Will sync when you're back online.");
      else setStatus("error", "Couldn't save — will retry.");
    });
  }

  /* ---------------- version history ---------------- */

  /** Recent commits that touched the ledger file. Every save is one. */
  function history(limit) {
    var b = apiBase();
    if (!b) return Promise.reject(new Error("no repo"));
    var url = b + "/commits?path=" + encodeURIComponent(S.repo.path) +
      "&sha=" + encodeURIComponent(S.repo.branch) +
      "&per_page=" + (limit || 25) + "&ts=" + Date.now();
    return fetch(url, { headers: headers(true), cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("http " + res.status);
      return res.json();
    }).then(function (list) {
      return (list || []).map(function (c) {
        return {
          sha: c.sha,
          message: (c.commit && c.commit.message) || "",
          date: (c.commit && c.commit.committer && c.commit.committer.date) || "",
          author: (c.commit && c.commit.author && c.commit.author.name) || ""
        };
      });
    });
  }

  /** The ledger exactly as it stood at a given commit. */
  function versionAt(sha) {
    var url = apiUrl();
    if (!url) return Promise.reject(new Error("no repo"));
    return fetch(url + "?ref=" + encodeURIComponent(sha) + "&ts=" + Date.now(), {
      headers: headers(true), cache: "no-store"
    }).then(function (res) {
      if (!res.ok) throw new Error("http " + res.status);
      return res.json();
    }).then(function (j) {
      var d = JSON.parse(b64ToUtf8(j.content));
      if (Crypt.isLocked(d)) {
        if (!S.raw) throw new Error("locked");
        return Crypt.open(S.raw, d).then(migrate);
      }
      if (!looksValid(d)) throw new Error("malformed");
      return migrate(d);
    });
  }

  /** Put an earlier version back as a new commit. The current state stays
   *  in history, and the restore itself is undoable. */
  function restoreVersion(sha, when) {
    return versionAt(sha).then(function (d) {
      commit(function (cur) {
        cur.config = d.config;
        cur.players = d.players;
        cur.nights = d.nights;
        cur.trash = d.trash || [];
      }, "Restore version from " + (when || sha.slice(0, 7)));
      return d;
    });
  }

  /* ---------------- boot ---------------- */

  function init() {
    S.repo = detectRepo();
    getToken();
    readLocal();
    emit();
    // Open the phone's own copy first, so the ledger shows before GitHub answers.
    var first = S.locked ? tryRemembered() : Promise.resolve();

    window.addEventListener("online", function () { if (S.dirty) flush(); else load(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !S.dirty) load();
      if (document.visibilityState === "hidden" && S.dirty) flush();
    });

    return first.then(load);
  }

  return {
    state: S,
    init: init,
    load: load,
    commit: commit,
    flush: flush,
    on: on,
    emit: emit,
    canEdit: canEdit,
    setToken: setToken,
    getToken: getToken,
    setRepo: setRepo,
    detectRepo: detectRepo,
    emptyLedger: emptyLedger,
    looksValid: looksValid,
    migrate: migrate,
    clone: clone,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    undoLabel: undoLabel,
    redoLabel: redoLabel,
    history: history,
    versionAt: versionAt,
    restoreVersion: restoreVersion,
    isEncrypted: isEncrypted,
    isLocked: isLocked,
    unlock: unlock,
    lockPhone: lockPhone,
    lockLedger: lockLedger,
    newWeeklyPassword: newWeeklyPassword,
    weeklyPassword: weeklyPassword,
    weekOfPassword: weekOfPassword,
    dataKey: dataKey
  };
})();
