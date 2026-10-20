/* ==========================================================================
   crypto.js — the ledger's lock

   data.json can be stored encrypted. The ledger is locked with one random
   256-bit data key, and that key is stored twice inside the file, each copy
   locked by a password:

     slots.weekly  — the weekly password everyone uses. A GitHub job swaps
                     this copy for a new password every Monday at 08:00.
     slots.keeper  — the scorekeeper's own password. Set once, never
                     changes, always opens the ledger.

   The data key itself never changes, so changing a password only re-locks
   one small copy of the key — never the ledger. The weekly password is also
   kept inside the file, locked by the data key, so whoever is unlocked
   (the scorekeeper above all) can see it and pass it on.

   Encrypted file:
     { enc: 1, note, kdf: { name, hash, iterations },
       eyebrow,                 the game's name, shown on the lock screen
       slots: { keeper: { salt, iv, key },
                weekly: { salt, iv, key, week, changed } },
       pw: { iv, ct },          weekly password, locked by the data key
       iv, ct }                 the ledger JSON, locked by the data key

   AES-256-GCM throughout; passwords go through PBKDF2-SHA256 at 600,000
   rounds, so each guess at a password costs real time. Everything is the
   browser's own Web Crypto — no library. The same format is read by
   .github/scripts/rotate.mjs on GitHub.
   ========================================================================== */

window.PL = window.PL || {};

PL.Crypt = (function () {
  "use strict";

  var ITERATIONS = 600000;
  var subtle = window.crypto && window.crypto.subtle;

  function available() { return !!subtle; }

  /* ---------------- bytes ---------------- */

  function toB64(bytes) {
    bytes = new Uint8Array(bytes);
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function fromB64(b64) {
    var bin = atob(String(b64 || "").replace(/\s/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function random(n) { return window.crypto.getRandomValues(new Uint8Array(n)); }

  /** Phones capitalise the first letter and people type spaces between
   *  words, so both are forgiven: case, spacing and dashes don't matter. */
  function normalise(pw) {
    return String(pw || "").normalize("NFC").trim().toLowerCase().replace(/[\s\-_.]+/g, "-");
  }

  /* ---------------- keys ---------------- */

  function passwordKey(pw, salt, iterations) {
    return subtle.importKey("raw", new TextEncoder().encode(normalise(pw)), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return subtle.deriveKey(
          { name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iterations || ITERATIONS },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }

  function dataKey(raw) {
    return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  /** Lock the data key with a password → one slot. */
  function makeSlot(raw, pw) {
    var salt = random(16), iv = random(12);
    return passwordKey(pw, salt).then(function (k) {
      return subtle.encrypt({ name: "AES-GCM", iv: iv }, k, raw);
    }).then(function (ct) {
      return { salt: toB64(salt), iv: toB64(iv), key: toB64(ct) };
    });
  }

  /** Try a password on one slot → the raw data key, or null if it's wrong. */
  function openSlot(slot, pw, iterations) {
    if (!slot || !slot.salt) return Promise.resolve(null);
    return passwordKey(pw, fromB64(slot.salt), iterations).then(function (k) {
      return subtle.decrypt({ name: "AES-GCM", iv: fromB64(slot.iv) }, k, fromB64(slot.key));
    }).then(function (raw) { return new Uint8Array(raw); }, function () { return null; });
  }

  /* ---------------- payloads ---------------- */

  function seal(raw, text) {
    var iv = random(12);
    return dataKey(raw).then(function (k) {
      return subtle.encrypt({ name: "AES-GCM", iv: iv }, k, new TextEncoder().encode(text));
    }).then(function (ct) { return { iv: toB64(iv), ct: toB64(ct) }; });
  }

  function unseal(raw, box) {
    return dataKey(raw).then(function (k) {
      return subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, k, fromB64(box.ct));
    }).then(function (buf) { return new TextDecoder().decode(buf); });
  }

  /* ---------------- the file ---------------- */

  function isLocked(j) { return !!j && typeof j === "object" && j.enc === 1 && !!j.slots && !!j.ct; }

  /** The file's lock without its contents — what stays the same between saves. */
  function header(j) {
    return { enc: 1, note: j.note, eyebrow: j.eyebrow || "", kdf: j.kdf, slots: j.slots, pw: j.pw };
  }

  /** Which slot a password opens: "weekly", "keeper", or null. */
  function unlock(env, pw) {
    var it = env.kdf && env.kdf.iterations;
    return openSlot(env.slots.weekly, pw, it).then(function (raw) {
      if (raw) return { raw: raw, slot: "weekly" };
      return openSlot(env.slots.keeper, pw, it).then(function (raw2) {
        return raw2 ? { raw: raw2, slot: "keeper" } : null;
      });
    });
  }

  function open(raw, env) {
    return unseal(raw, env).then(function (text) { return JSON.parse(text); });
  }

  /** A full file: the current lock with the ledger sealed inside it. */
  function close(raw, head, ledger) {
    return seal(raw, JSON.stringify(ledger)).then(function (box) {
      var out = header(head);
      out.iv = box.iv;
      out.ct = box.ct;
      return out;
    });
  }

  function weeklyPassword(raw, env) {
    return env.pw ? unseal(raw, env.pw) : Promise.resolve("");
  }

  /* ---------------- passwords ---------------- */

  /** Four random words from the EFF short list (~41 bits). */
  function generatePassword(words, n) {
    var out = [];
    var limit = Math.floor(65536 / words.length) * words.length;   // no modulo bias
    while (out.length < (n || 4)) {
      var v = window.crypto.getRandomValues(new Uint16Array(1))[0];
      if (v < limit) out.push(words[v % words.length]);
    }
    return out.join("-");
  }

  /** Monday of the current week in Zagreb, as YYYY-MM-DD. */
  function weekOf(date) {
    var d = date || new Date();
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
      .formatToParts(d).reduce(function (a, p) { a[p.type] = p.value; return a; }, {});
    var local = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
    var dow = (local.getUTCDay() + 6) % 7;            // Monday = 0
    local.setUTCDate(local.getUTCDate() - dow);
    return local.toISOString().slice(0, 10);
  }

  /** First-time lock: a new data key, both slots, the first weekly password. */
  function create(keeperPw, weeklyPw) {
    var raw = random(32);
    return Promise.all([makeSlot(raw, keeperPw), makeSlot(raw, weeklyPw), seal(raw, weeklyPw)])
      .then(function (r) {
        var weekly = r[1];
        weekly.week = weekOf();
        weekly.changed = new Date().toISOString();
        return {
          raw: raw,
          head: {
            enc: 1,
            note: "This ledger is encrypted. Open it in the Poker Night Ledger app.",
            kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS },
            slots: { keeper: r[0], weekly: weekly },
            pw: r[2]
          }
        };
      });
  }

  /** Swap the weekly password (scorekeeper, from Settings). */
  function rotate(raw, head, newPw) {
    return Promise.all([makeSlot(raw, newPw), seal(raw, newPw)]).then(function (r) {
      var h = header(head);
      h.slots = { keeper: head.slots.keeper, weekly: r[0] };
      h.slots.weekly.week = weekOf();
      h.slots.weekly.changed = new Date().toISOString();
      h.pw = r[1];
      return h;
    });
  }

  return {
    available: available,
    isLocked: isLocked,
    header: header,
    unlock: unlock,
    open: open,
    close: close,
    create: create,
    rotate: rotate,
    weeklyPassword: weeklyPassword,
    generatePassword: generatePassword,
    weekOf: weekOf,
    normalise: normalise,
    toB64: toB64,
    fromB64: fromB64
  };
})();
