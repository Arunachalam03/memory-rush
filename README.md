# Memory Rush

A free memory game for phones and desktops. Watch the pattern, repeat it, beat your score.
Optionally (with each player's consent) it sends **anonymous play data** (rounds, score, accuracy, reaction times) to a **Google Sheet** you own, so you can analyse how people behave.

- Players: tap a link, play. No install, no login, free.
- You: free hosting (GitHub Pages) + free storage (Google Sheets). No servers to run.

## 1. Run and test locally (Node 18+)

```bash
cd memory-rush
npm test        # 65 tests: game logic, collector, backend validation, end-to-end, wiring
npm start       # play at http://localhost:3000
```

With no endpoint configured (the default), the game works normally, **no consent screen appears and nothing is collected**.

## 2. Turn on data collection (Google Sheets, about 5 minutes)

1. Go to https://sheets.new and name the sheet e.g. `Memory Rush Data`.
2. **Extensions -> Apps Script**. Delete the sample code, paste the entire contents of `apps-script/Code.gs`, press **Save**.
3. **Deploy -> New deployment -> (gear) Select type -> Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then **Authorize access** (for your own script, Google shows "Advanced -> Go to project": this is normal).
4. Copy the **Web app URL** (ends in `/exec`).
5. Check it: open that URL in a browser. You should see `{"ok":true,"service":"memory-rush-collector"}`.
6. Put it in the game:
   ```bash
   npm run set-endpoint -- "https://script.google.com/macros/s/XXXXXXXX/exec"
   ```
   (the command refuses anything that is not a Web app URL)
7. Publish (section 3). Play one game on the live link and finish it: a row appears in the **Responses** tab.

Changing `Code.gs` later: **Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy**. The URL stays the same.

## 3. Publish a free shareable link (GitHub Pages)

```bash
git init -b main
git add .
git commit -m "Memory Rush"
git remote add origin https://github.com/<YOUR_USERNAME>/memory-rush.git   # empty PUBLIC repo
git push -u origin main
```

Then on GitHub: **Settings -> Pages -> Source: GitHub Actions**. The workflow runs all tests and deploys (about 1 minute). Link:

```
https://<YOUR_USERNAME>.github.io/memory-rush/
```

Every later `git push` redeploys, but only if the tests pass. Only the site files are published; tests and `apps-script/` are not.

### WhatsApp and QR code
- Paste the link in any chat: WhatsApp shows a preview card (title, description, image). The preview image address is filled in automatically at deploy time.
- WhatsApp caches previews. If you change the image, share the link with `?v=2` on the end.
- The in-game **Share with friends** button opens the phone's share sheet with the player's best score.
- QR code: `URL="https://<YOUR_USERNAME>.github.io/memory-rush/" npm run qr`, or paste the link into any free QR generator.

## 4. How the data collection works

| Step | What happens |
|---|---|
| First visit | A consent screen explains what is collected. **I agree** or **No thanks** (the game is playable either way). |
| Agree | A random anonymous ID (UUID) is created on the device. |
| Game over | The result is added to a queue stored on the device, then uploaded automatically. |
| Offline or error | The result stays in the queue and is retried when the connection returns, when the page is reopened, and after each game. Nothing is lost. |
| Retry safety | Every result has a unique id. If an upload succeeded but the reply was lost, the retry is recognised as a duplicate, so no double rows. |
| Withdraw | **Privacy & data -> Stop sharing** deletes the queue and the anonymous ID from the device and stops all sending. |
| Delete past data | Player sends you their anonymous ID (shown in **Privacy & data**); delete matching rows in the sheet (filter the `playerId` column). |

**Columns in the `Responses` sheet:** `receivedAt, id, playerId, playedAt, rounds, score, presses, accuracy, avgReactionMs, fastestMs, appVersion`.
No names, emails, phone numbers, IP addresses or locations are collected or stored.

### Security: what this does and does not protect
- **Write-only endpoint:** the script only appends rows. No request can read the sheet. The sheet itself stays private to your Google account (never share it publicly; share view access only with people who should analyse it).
- **Strict validation:** every field has a fixed format and range, scores must be consistent with rounds, timestamps must be recent. No free text is stored, which also blocks spreadsheet formula injection.
- **Rate limit:** 120 records per anonymous ID per hour.
- **Honest limit:** the endpoint URL is public (it has to be, for a browser game), so a determined person could submit fake but well-formed rows by generating new IDs. That is fine for a friendly study. Look for outliers when analysing (for example identical timestamps or perfect scores) and use `appVersion` to filter.
- Apps Script has daily quotas. That is plenty for a friends-and-family study; check Google's current quota page before a large public launch.
- If you collect data from people outside your own circle, check local privacy rules (for example GDPR) and tell players who you are on the consent text in `index.html`.

## 5. Analysing the data

In Google Sheets: **Data -> Create a pivot table** (rows: `playerId`, values: `AVERAGE of score`, `AVERAGE of avgReactionMs`, `COUNTA of id`), or sort by `playedAt` per player to see learning curves.

In Python:

```python
import pandas as pd
df = pd.read_csv("Responses.csv", parse_dates=["playedAt"])   # File -> Download -> CSV
print(df.groupby("playerId").agg(games=("id", "count"), best=("score", "max"),
                                 avg_rt=("avgReactionMs", "mean"), acc=("accuracy", "mean")))
```

## 6. Tests

```bash
npm test
```

| File | Covers |
|---|---|
| `test/game.test.js` | game rules, scoring, stats, speed curve, high score |
| `test/collector.test.js` | consent gating, anonymous ID, queue, batching, offline, retries, duplicates, throttling, timeouts, corrupted or blocked storage, UUID generation |
| `test/appsscript.test.js` | every validation rule, duplicates, mixed batches, header row, locking, rate limit, error handling (runs the real `Code.gs` against fake Google services) |
| `test/e2e.test.js` | real HTTP: games played, offline, lost reply, recovery, no duplicates, decline and withdraw send nothing |
| `test/smoke.test.js` | files served, script order, element ids, consent text, config validity, link preview tags, deploy workflow, `set-endpoint` safety |

These tests run the real code but use a simulated Google Sheet. The only thing they cannot prove is Google's own deployment, so do step 2.7 once on the live site.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | UI, consent and privacy dialogs |
| `game.js` | Pure game logic |
| `collector.js` | Consent, anonymous ID, offline queue, upload |
| `app.js` | Browser glue |
| `config.js` | Endpoint URL (empty = collection off) |
| `apps-script/Code.gs` | Google Sheets backend |
| `scripts/set-endpoint.js` | Safe way to set the endpoint |
| `.github/workflows/deploy.yml` | Test, then deploy to GitHub Pages |

## Troubleshooting

- **No consent screen:** `config.js` endpoint is empty (collection is off) or the player already answered. Clear site data to see it again.
- **No rows appear:** open the Web app URL; if it shows `{"ok":true,...}` the deployment works. Check that access is **Anyone** and you deployed a **new version** after editing the script. The in-game result line says "Saved on your device... retry" when an upload failed.
- **Page 404 after deploy:** Pages source must be **GitHub Actions** and the workflow green.
- **No sound on iPhone:** turn off silent mode; audio starts after the first tap.
- **Port 3000 busy:** `npx serve . -l 4000`.
