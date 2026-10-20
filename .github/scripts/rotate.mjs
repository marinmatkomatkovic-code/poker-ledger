/* Weekly password change for Poker Night Ledger.

   Runs on GitHub every Monday morning (see ../workflows/weekly-password.yml).
   Once per week, after 08:00 Zagreb time, it gives the ledger a new weekly
   password: a fresh copy of the data key locked by four new random words,
   plus the words themselves locked by the data key so the scorekeeper sees
   them in the app. The ledger inside (iv/ct) and the scorekeeper's slot are
   never touched. The new password is never printed — it only goes into the
   file, encrypted.

   Needs the repository secret LEDGER_KEY (Settings → Password lock → Key for
   the Monday change in the app). Same format as crypto.js. */

import { readFileSync, writeFileSync } from "node:fs";

const { subtle } = globalThis.crypto;
const getRandomValues = (a) => globalThis.crypto.getRandomValues(a);
const ITERATIONS = 600000;
const FILE = "data.json";
const force = process.env.FORCE === "true";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ""), "base64"));
const normalise = (pw) => String(pw).normalize("NFC").trim().toLowerCase().replace(/[\s\-_.]+/g, "-");
const random = (n) => getRandomValues(new Uint8Array(n));

function zagreb(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zagreb", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short"
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  const dow = (day.getUTCDay() + 6) % 7;                 // Monday = 0
  const monday = new Date(day); monday.setUTCDate(day.getUTCDate() - dow);
  return { dow, hour: +p.hour, week: monday.toISOString().slice(0, 10) };
}

async function passwordKey(pw, salt, iterations) {
  const base = await subtle.importKey("raw", new TextEncoder().encode(normalise(pw)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const dataKey = (raw) => subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

function generatePassword(words, n = 4) {
  const out = [];
  const limit = Math.floor(65536 / words.length) * words.length;   // no modulo bias
  while (out.length < n) {
    const v = getRandomValues(new Uint16Array(1))[0];
    if (v < limit) out.push(words[v % words.length]);
  }
  return out.join("-");
}

const fail = (msg) => { console.error("::error::" + msg); process.exit(1); };

const file = JSON.parse(readFileSync(FILE, "utf8"));
if (file.enc !== 1 || !file.slots || !file.ct) {
  console.log("The ledger isn't locked yet — nothing to change. Lock it from Settings in the app first.");
  process.exit(0);
}

const now = zagreb(new Date());
const current = file.slots.weekly || {};
if (!force) {
  if (current.week === now.week) { console.log(`Password already changed for the week of ${now.week}.`); process.exit(0); }
  if (now.dow === 0 && now.hour < 8) { console.log("Not 08:00 in Zagreb yet."); process.exit(0); }
}

if (!process.env.LEDGER_KEY) fail("The LEDGER_KEY secret is missing. Copy the key from Settings → Password lock in the app and add it under Settings → Secrets and variables → Actions.");
const raw = unb64(process.env.LEDGER_KEY);
if (raw.length !== 32) fail("LEDGER_KEY doesn't look like the key from the app (it should be 44 characters ending in =).");

// The key must open this ledger — otherwise a wrong secret would lock everyone out.
try {
  await subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, await dataKey(raw), unb64(file.ct));
} catch {
  fail("LEDGER_KEY doesn't open this ledger. Copy the key again from Settings → Password lock in the app.");
}

const words = JSON.parse(readFileSync("words.json", "utf8"));
const pw = generatePassword(words);

const salt = random(16), iv = random(12), iv2 = random(12);
const wrapped = await subtle.encrypt({ name: "AES-GCM", iv }, await passwordKey(pw, salt, (file.kdf && file.kdf.iterations) || ITERATIONS), raw);
const sealedPw = await subtle.encrypt({ name: "AES-GCM", iv: iv2 }, await dataKey(raw), new TextEncoder().encode(pw));

file.slots.weekly = { salt: b64(salt), iv: b64(iv), key: b64(new Uint8Array(wrapped)), week: now.week, changed: new Date().toISOString() };
file.pw = { iv: b64(iv2), ct: b64(new Uint8Array(sealedPw)) };

writeFileSync(FILE, JSON.stringify(file, null, 2) + "\n");
console.log(`New weekly password set for the week of ${now.week}. Open the app as scorekeeper to share it.`);
