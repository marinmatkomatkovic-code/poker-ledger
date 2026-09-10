# Poker Night Ledger

A small app for a home poker game: buy-ins, cash-outs, profit and loss, attendance
and a record book. It installs on a phone like an app, everyone with the link can
see it, and only you can change it.

No server, no database, no monthly free tier to worry about. The whole ledger is a
single `data.json` file in a GitHub repository. Anyone can read it because the repo
is public; only a token with write access can change it. That is what makes "only I
enter the data" real rather than a hidden button — it is enforced by GitHub.

---

## Setting it up

You need a GitHub account. It's free, and this is the only account involved.

### 1. Make the repository

On GitHub, create a **new public repository**. Call it `poker-ledger` (any name
works — the app figures out where it lives). Leave it empty: no README, no
`.gitignore`.

> It has to be public, because GitHub Pages only serves public repos on the free
> plan, and because your friends' phones need to read the file without signing in.
> See **Who can see this** below before you decide what to put in it.

### 2. Upload these files

On the repo page: **Add file → Upload files**, drag in everything from this folder,
and commit. The layout should end up as:

```
index.html
styles.css
app.js
store.js
stats.js
charts.js
sw.js
manifest.webmanifest
data.json
.nojekyll
icons/
  icon-192.png
  icon-512.png
  icon-maskable-512.png
  apple-touch-icon.png
```

`.nojekyll` matters — without it GitHub tries to run the site through Jekyll. If
your file browser hides dotfiles and it doesn't upload, create it on GitHub with
**Add file → Create new file**, name it `.nojekyll`, leave it empty, commit.

### 3. Turn on Pages

**Settings → Pages**. Under *Build and deployment*, set Source to **Deploy from a
branch**, branch **main**, folder **/ (root)**. Save.

Give it a minute, then your app is at:

```
https://<your-username>.github.io/poker-ledger/
```

Open it. You should see the ledger, empty, in read-only mode.

### 4. Make a token so you can edit

This is the bit that makes you the scorekeeper.

1. GitHub → your avatar → **Settings** → **Developer settings** (bottom of the
   sidebar) → **Personal access tokens** → **Fine-grained tokens** → **Generate new
   token**.
2. Name it something like `poker ledger`.
3. **Expiration** — pick what you're comfortable with. A year is reasonable; you can
   always issue a new one.
4. **Repository access** → *Only select repositories* → pick `poker-ledger`.
5. **Permissions** → *Repository permissions* → **Contents** → **Read and write**.
   That's the only permission it needs. Leave everything else alone.
6. Generate it and copy the token. GitHub shows it once.

Now in the app: gear icon → paste it into **GitHub token** → **Unlock editing**.
The token is stored in that browser on that device and is sent nowhere except
GitHub. Do this on your phone, and the phone becomes the scorekeeper.

### 5. Put it on your phone

Open the URL on the phone and:

- **iPhone (Safari)** — Share button → *Add to Home Screen*.
- **Android (Chrome)** — menu → *Install app* (or *Add to Home screen*).

It gets its own icon and opens without browser chrome. Send the same link to
everyone else; they add it the same way and get a read-only copy.

---

## Running a night

**Tonight** is the working screen. Start a night, tick who's at the table, and
everyone begins on one buy-in. Tap `+` each time someone rebuys. As people leave,
type what they cash out.

Two things to lean on:

- **Balance.** Cash-outs should add up to exactly what went in. The tile tells you
  the moment they don't. This is much easier to sort out at the table than a month
  later.
- **Log a big pot.** Optional. When something worth remembering happens, drop the
  amount and who won it. Those feed the *Biggest pot* record.
- **Start and finish times.** The start time is filled in when you start the night
  (change it if you're entering late); the finish time stamps itself when you close,
  if it's still blank. A finish earlier than the start means you played past
  midnight. Timed nights feed *hours at the table*, *profit per hour* and the
  *Longest night* record; untimed nights stay out of those, so old nights never
  get divided by hours nobody wrote down. To time an old night, reopen it, fill in
  both times and close it again.

Closing the night locks it into the standings. If you got something wrong, open
**History**, find the night, and *Reopen to edit* — every figure that depends on it
recalculates.

Changes save a couple of seconds after you stop tapping, as one commit. The chip in
the header says where you are: *Saving*, *Saved*, *Offline*, *Not saved*. With no
signal the app keeps working and pushes everything when you're back.

---

## If you get something wrong

Nothing in the app is one-way. There are four layers, shallowest first — reach for
the first one that fits.

**1. Undo.** Every change is undoable, not just deletions: a mistyped cash-out, a
rename, a rebuy tapped twice, a whole night discarded. The undo arrow appears in the
header the moment there is something to undo, and `Ctrl+Z` (`⌘Z` on a Mac) works too.
After a deletion a toast offers *Undo* directly. Undoing is itself undoable — the
toast then offers *Redo*.

The stack holds the last 40 changes and lives in memory, so it resets when you close
the app. That is deliberate: it is the "oops" layer, not the archive.

**2. The bin.** Deleting a night or a player moves it aside inside the ledger rather
than destroying it. It sits in *Settings → The bin* until you restore it or empty the
bin, and because it lives in `data.json` it is there on every device, not just the one
you deleted from. A player in the bin still shows their real name on old nights, so
removing someone from the roster never turns past results into a row of raw ids.

**3. Earlier versions.** Every save is a git commit, so the ledger has a complete
history. *Settings → Earlier versions* lists recent saves with what each one did
("Close night 2026-09-01", "Buy-in for Nikola") and puts the ledger back to any of
them. Restoring writes a *new* commit, so the state you restored from is still in the
history — you can always go forward again. This is the layer that covers everything
the other two don't: a bad edit three weeks ago, a corrupted file, an emptied bin.

**4. A backup file.** *Settings → Download a backup* gives you the whole ledger as a
single JSON file. Keep one somewhere before doing anything drastic. *Restore from a
backup file* loads one back, and that too is undoable.

Emptying the bin is the only action undo will not reverse — and even then the items
are still sitting in an earlier version.

You can also do all of this from GitHub directly: the repo's commit history for
`data.json` shows every change, and reverting a commit there works exactly as you'd
expect.

---

## Who can see this

The repository is public, so `data.json` is on the internet. Anyone who has the link
— or who stumbles across the repo — can read who played and how much they won or
lost. For a home game among friends that's usually fine, but decide deliberately:

- Use first names or nicknames rather than full names.
- Don't post the link anywhere public.
- If you'd rather the file weren't on GitHub in the open, host the same files on
  **Cloudflare Pages** or **Netlify** instead — both build from a *private* repo on
  their free tier. The site itself is still public, so the data is still readable by
  anyone with the URL; it just isn't sitting in a browsable repo. You'd then set the
  owner/repo by hand in Settings → Storage.

If a phone with the token on it goes missing, revoke the token on GitHub. The worst
anyone can do with it is edit poker scores in this one repo, but revoking takes ten
seconds.

---

## How the data is shaped

`data.json`:

```jsonc
{
  "version": 1,
  "config":  { "gameName": "", "buyIn": 20, "currency": "EUR", "locale": "hr-HR" },
  "players": [ { "id": "ivan", "name": "Ivan", "active": true, "joined": "2026-09-09" } ],
  "nights":  [ {
    "id": "2026-09-09",          // the date; a second night that day gets "-2"
    "date": "2026-09-09",
    "buyIn": 20,                 // snapshotted, so changing the default never rewrites history
    "status": "open",            // or "closed" — only closed nights count
    "start": "20:30",            // local clock times, optional; "" = untimed
    "end": "01:45",              // earlier than start = past midnight
    "entries": {
      "ivan": { "buyIns": 2, "cashOut": 45 }
    },
    "pots": [ { "amount": 120, "winner": "ivan", "note": "flopped a boat" } ],
    "notes": ""
  } ],
  "trash":   [ { "kind": "night", "deletedAt": "2026-09-09T21:12:00Z", "item": { } } ]
}
```

**No total is stored anywhere.** Profit and loss, buy-in counts, attendance, streaks
and every record are recomputed from those entries each time the app opens. That is
the whole design: correcting one cash-out corrects every figure that depends on it,
and a new statistic never needs a data migration.

Every change is a git commit, so GitHub keeps the full history of the ledger. If
something gets mangled you can see exactly when and revert it from the repo.

---

## Adding to it

| File | What lives there |
|---|---|
| `stats.js` | Every derived figure — the standings table, the record book, streaks. **New statistics go here.** |
| `app.js` | Screens and interactions. |
| `charts.js` | The SVG charts. No chart library. |
| `styles.css` | Design tokens at the top: colours, type, spacing. Change them in one place. |
| `store.js` | Talking to GitHub, the local cache, offline retries, undo/redo and version history. |
| `sw.js` | Offline caching. **Bump `CACHE` whenever you change a file**, or browsers keep the old one. |

Adding a record is a few lines in `records()` in `stats.js` — build a list of rows
and call `add()`. Adding a field to a night (who hosted, how long it ran, knockouts)
means writing it into `entries` or the night object and deriving from it; nights
recorded before the field existed simply don't have it, so treat missing as zero.

### Two colour systems, kept apart

**Result colour** — profit and loss — is **teal and orange-red**, not green and red.
Green/red is the conventional choice and the wrong one: the two are nearly
indistinguishable to red-green colourblind readers, around one man in twelve. The
pair here was measured against both the light and dark backgrounds. Sign is also
carried by a `+`/`−` prefix and by which side of zero a bar sits on, so colour never
works alone.

**Identity colour** — one hue per player — is a separate system. It only ever appears
as a badge with that player's initials in it, beside their name. Identity is carried
by the letters; colour just makes a roster scannable. That is why eight hues are fine
here when only four would survive as data colour. Two rules keep the systems from
colliding, and both matter if you extend the app:

- an avatar is never a bare colour dot, and never appears inside a chart's plotting area;
- a money figure is always monospaced and signed, and never sits on a coloured badge.

Colours are assigned by a player's position in the roster. To pin one, add
`"colour": 3` to that player in `data.json` (0–7, matching `--pc0`…`--pc7` in the CSS).

---

## Things that might catch you out

- **Changes not showing on someone else's phone.** They're reading a cached copy.
  Pull to refresh, or close and reopen the app. Their view is at most a few minutes
  behind.
- **"GitHub rejected the token."** It expired, was revoked, or lacks Contents:
  write. Issue a new one and paste it in.
- **You edited on two devices at once.** Last save wins, and the older one is still
  in the git history. Use one device as the scorekeeper.
- **Anonymous visitors are limited to 60 GitHub API calls an hour per address.**
  Past that the app falls back to the copy deployed with the site, which lags by a
  few minutes. You won't hit this with a normal-sized poker night.
- **You changed a file and nothing happened.** The service worker is serving the old
  one. Bump `CACHE` in `sw.js`.
