/* ==========================================================================
   store.js — persistence

   The ledger is a single JSON file (data.json) committed to a GitHub repo.
   Anyone can read it, because the repo is public. Only someone holding a
   token with write access to that repo can change it, which is how "only
   Marin can enter data" is enforced — by GitHub, not by hidden buttons.

   Reads:  GitHub Contents API (fresh), falling back to the deployed
           data.json if the API rate-limits an anonymous visitor.
   Writes: Contents API PUT, debounced so a burst of rebuy taps becomes
           one commit.
   Local:  a copy in localStorage, so the app opens instantly and keeps
           working with no signal. Unsaved changes are retried when the
           connection comes back.
   ========================================================================== */

window.PL = window.PL || {};

PL.Store = (function () {
  "use strict";

  var LS_DATA = "pl:data";
  var LS_SHA = "pl:sha";
  var LS_DIRTY = "pl:dirty";
  var LS_TOKEN = "pl:token";
  var LS_REPO = "pl:repo";

  var SAVE_DELAY = 2000;

  var listeners = [];
  var saveTimer = null;
  var savingNow = false;

  var S = {
    data: emptyLedger(),
    sha: null,
    token: null,
    repo: null,
    dirty: false,
    /** idle | loading | saving | saved | error | offline | readonly */
    status: "idle",
    message: "",
    loadedRemote: false
  };

  function emptyLedger() {
    return {
      version: 1,
      config: { gameName: "", buyIn: 20, currency: "EUR", locale: "hr-HR" },
      players: [],
      nights: []
    };
  }

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

  /** Work out which repo we are being served from, so there is nothing to
   *  configure in the normal GitHub Pages case. */
  function detectRepo() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_REPO) || "null"); } catch (e) { /* ignore */ }
    if (saved && saved.owner && saved.repo) return saved;

    var host = location.hostname;
    var m = host.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (m) {
      var owner = m[1];
      var seg = location.pathname.split("/").filter(Boolean);
      // user.github.io/<repo>/...  vs  user.github.io/  (the root pages repo)
      var repo = seg.length ? seg[0] : host;
      return { owner: owner, repo: repo, branch: "main", path: "data.json" };
    }
    return null;
  }

  function setRepo(cfg) {
    S.repo = cfg;
    try { localStorage.setItem(LS_REPO, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  function apiUrl() {
    if (!S.repo) return null;
    return "https://api.github.com/repos/" + encodeURIComponent(S.repo.owner) +
      "/" + encodeURIComponent(S.repo.repo) + "/contents/" + S.repo.path;
  }

  /* ---------------- local cache ---------------- */

  function readLocal() {
    try {
      var raw = localStorage.getItem(LS_DATA);
      if (!raw) return false;
      S.data = migrate(JSON.parse(raw));
      S.sha = localStorage.getItem(LS_SHA) || null;
      S.dirty = localStorage.getItem(LS_DIRTY) === "1";
      return true;
    } catch (e) { return false; }
  }

  function writeLocal() {
    try {
      localStorage.setItem(LS_DATA, JSON.stringify(S.data));
      if (S.sha) localStorage.setItem(LS_SHA, S.sha);
      localStorage.setItem(LS_DIRTY, S.dirty ? "1" : "0");
    } catch (e) { /* quota — not fatal */ }
  }

  function migrate(d) {
    var base = emptyLedger();
    if (!d || typeof d !== "object") return base;
    d.version = d.version || 1;
    d.config = Object.assign({}, base.config, d.config || {});
    d.players = Array.isArray(d.players) ? d.players : [];
    d.nights = Array.isArray(d.nights) ? d.nights : [];
    d.nights.forEach(function (n) {
      n.entries = n.entries || {};
      n.pots = Array.isArray(n.pots) ? n.pots : [];
      if (n.status !== "open" && n.status !== "closed") n.status = "closed";
    });
    return d;
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

  /* ---------------- load ---------------- */

  function load() {
    var url = apiUrl();
    if (!url) {
      // No repo configured (local dev, custom domain). Fall back to the file.
      return fetch("data.json?ts=" + Date.now(), { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (j && !S.dirty) { S.data = migrate(j); writeLocal(); }
          setStatus(S.dirty ? "error" : "idle", S.dirty ? "Not connected to a repo — changes are local only." : "");
        })
        .catch(function () { setStatus("offline"); });
    }

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
        var remote = migrate(JSON.parse(b64ToUtf8(j.content)));
        S.sha = j.sha;
        if (S.dirty) {
          // Our local edits have not landed yet — keep them and push.
          writeLocal();
          setStatus("idle");
          return flush();
        }
        S.data = remote;
        writeLocal();
      }
      setStatus("idle");
    }).catch(function (err) {
      if (String(err.message) === "ratelimit") {
        // Anonymous visitors get 60 API calls an hour per address. Fall back
        // to the deployed copy, which is a few minutes behind at worst.
        return fetch("data.json?ts=" + Date.now(), { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && !S.dirty) { S.data = migrate(j); writeLocal(); }
            setStatus("idle");
          })
          .catch(function () { setStatus("offline"); });
      }
      setStatus(navigator.onLine ? "error" : "offline",
        navigator.onLine ? "Couldn't reach GitHub." : "");
    });
  }

  /* ---------------- save ---------------- */

  /** Record a change: update local state now, commit shortly. */
  function commit(mutator, label) {
    mutator(S.data);
    S.dirty = true;
    writeLocal();
    emit();
    if (!canEdit()) return;
    S.pendingLabel = label || S.pendingLabel || "Update ledger";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  /** Push the current ledger now. Safe to call at any time. */
  function flush() {
    clearTimeout(saveTimer);
    if (!S.dirty || !canEdit() || savingNow) return Promise.resolve();

    savingNow = true;
    setStatus("saving");

    var body = {
      message: S.pendingLabel || "Update ledger",
      content: utf8ToB64(JSON.stringify(S.data, null, 2) + "\n"),
      branch: S.repo.branch
    };
    if (S.sha) body.sha = S.sha;

    return fetch(apiUrl(), {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, headers(true)),
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 409 || res.status === 422) {
        // Someone (or another device) committed since we last read. Re-read
        // the sha and push ours on top — there is only one writer, so ours
        // is the intended state.
        return fetch(apiUrl() + "?ref=" + encodeURIComponent(S.repo.branch) + "&ts=" + Date.now(), {
          headers: headers(true), cache: "no-store"
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            savingNow = false;
            if (j && j.sha) { S.sha = j.sha; return flush(); }
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

  /* ---------------- boot ---------------- */

  function init() {
    S.repo = detectRepo();
    getToken();
    readLocal();
    emit();

    window.addEventListener("online", function () { if (S.dirty) flush(); else load(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !S.dirty) load();
      if (document.visibilityState === "hidden" && S.dirty) flush();
    });

    return load();
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
    emptyLedger: emptyLedger
  };
})();
