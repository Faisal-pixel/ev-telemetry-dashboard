# EV Battery Telemetry — Dashboard

Live dashboard for two devices:

| Device | Board | Sends | Every |
| --- | --- | --- | --- |
| **EV Telemetry** (`EV_Telemetry_Firebase.ino`) | ESP32 | battery voltage, SOC, current, power, energy, temperature, humidity, vibration | 10 s |
| **EV Telemetry 2** (`EV_Telemetry_2_Firebase.ino`) | ESP8266 | speed, latitude, longitude | 5 s, **only while the GPS has a fix** |

Next.js 14 (App Router) + TypeScript + Recharts + Leaflet. Reads directly from
Firebase Realtime Database over its REST API. No backend server, no Firebase SDK.
Same setup as the water-level dashboard.

---

## How data gets in (the URLs for the devices)

Each device writes into its own folder. Every publish cycle it makes two HTTPS
requests with the same JSON body:

```
EV Telemetry (ESP32)
  PUT  https://<your-database-url>/ev_telemetry/current.json     latest reading (overwritten)
  POST https://<your-database-url>/ev_telemetry/history.json     appended to the log

EV Telemetry 2 (ESP8266)
  PUT  https://<your-database-url>/ev_telemetry2/current.json
  POST https://<your-database-url>/ev_telemetry2/history.json
```

**Battery body (ESP32):**

```json
{
  "battery_voltage": 76.42, "battery_soc": 68.4, "temperature": 31.0, "humidity": 62.0,
  "current": -8.15, "power": 622.8, "energy": 41.27, "vibration": 22.5,
  "timestamp": 1791200460
}
```

**GPS body (ESP8266):**

```json
{ "latitude": 6.515812, "longitude": 3.389631, "speed": 24.3, "timestamp": 1791200460 }
```

- `timestamp` is **Unix seconds** from NTP, set by the device. That means readings
  uploaded late from flash still appear at the time they were measured.
- Readings uploaded late also carry `"stored": 1`. The CSV export shows this as
  `uploaded_late`.
- Rows with `timestamp: 0` (device clock never synced) are left out of charts and exports.

---

## 1. Create the Firebase database (one time)

1. Go to <https://console.firebase.google.com> → **Create a project**. Name it
   (e.g. `ev-telemetry`). You can switch Google Analytics off.
2. In the left menu: **Build → Realtime Database → Create Database**.
3. Pick a location. **europe-west1 (Belgium)** is the closest to Nigeria.
4. Choose **Start in locked mode** → **Enable**.
5. Open the **Rules** tab. Delete what is there, paste the contents of
   `firebase-database-rules.json` from this folder, then click **Publish**.
6. Open the **Data** tab. The URL at the top is your database URL. Copy it exactly.
   - US location: `https://ev-telemetry-xxxxx-default-rtdb.firebaseio.com`
   - Belgium location: `https://ev-telemetry-xxxxx-default-rtdb.europe-west1.firebasedatabase.app`

## 2. Create `.env.local`, then put the URL in three places

The settings file ships as `.env.example`. Make your own copy once:

```bash
cd "Truths Projects/ev-telemetry-dashboard"
cp .env.example .env.local
```

`.env.local` is gitignored, so your URL is never pushed to GitHub. `.env.example`
stays as the template.

The same URL, with no trailing slash, goes into:

| File | Line |
| --- | --- |
| `ev-telemetry-dashboard/.env.local` | `NEXT_PUBLIC_FIREBASE_DB_URL=...` |
| `EV_Telemetry_Firebase/EV_Telemetry_Firebase.ino` | `const char* FIREBASE_HOST = "...";` |
| `EV_Telemetry_2_Firebase/EV_Telemetry_2_Firebase.ino` | `const char* FIREBASE_HOST = "...";` |

## 3. Check the database works before touching hardware

Paste this into Terminal (replace the URL). It sends one fake battery reading:

```bash
curl -X PUT -d '{"battery_voltage":75,"battery_soc":62.5,"temperature":30,"humidity":60,"current":-5,"power":375,"energy":10,"vibration":20,"timestamp":'$(date +%s)'}' \
  "https://YOUR-DATABASE-URL/ev_telemetry/current.json"
```

It should print the JSON back. If it prints `"Permission denied"`, the rules from
step 1.5 were not published.

Read it back the way the dashboard does:

```bash
curl "https://YOUR-DATABASE-URL/ev_telemetry/current.json"
```

Or fill the dashboard with 10 minutes of fake data for both devices:

```bash
cd ev-telemetry-dashboard
npm install                 # first time only
npm run test-data           # 10 min of history + current readings
npm run test-data -- --live     # keep sending like the real devices (Ctrl+C to stop)
npm run test-data -- --alerts   # values that trigger every alert
npm run test-data -- --remove   # delete all fake rows again
```

Fake rows are tagged `_test` and are **never** included in a CSV export.
Run `--remove` before the real devices go live.

## 4. Run the dashboard

```bash
cd "Truths Projects/ev-telemetry-dashboard"
npm install
npm run dev
```

Open <http://localhost:3000>.

> If `node_modules` was copied from another machine, delete it first
> (`rm -rf node_modules`), because native binaries are platform-specific.

After changing `.env.local`, stop `npm run dev` (Ctrl+C) and start it again.

## 5. Flash the devices

Open each `.ino` in the Arduino IDE. Each one is in a folder with the same name,
which the IDE requires.

Libraries (Sketch → Include Library → Manage Libraries):

| Sketch | Libraries |
| --- | --- |
| ESP32 | ArduinoJson, UniversalTelegramBot, DHT sensor library, Adafruit MPU6050, Adafruit Unified Sensor, LiquidCrystal I2C. *(PubSubClient is no longer needed.)* |
| ESP8266 | ArduinoJson, UniversalTelegramBot, TinyGPSPlus. *(PubSubClient is no longer needed.)* |

`HTTPClient` / `ESP8266HTTPClient`, `WiFiClientSecure` and `LittleFS` come with the
board packages.

Open the Serial Monitor at 115200 baud. Each cycle should show
`Firebase PUT ok - HTTP 200` and `Firebase POST ok - HTTP 200`, and the status
line should end in `Clock: SYNCED`.

---

## Configuration

`.env.local` (copied from `.env.example`) holds the alert limits. It is the only place the dashboard keeps them:

```
NEXT_PUBLIC_LOW_VOLTAGE_V=65          # must match LOW_VOLTAGE_ALERT in EV_Telemetry_Firebase.ino
NEXT_PUBLIC_LOW_SOC_PCT=20
NEXT_PUBLIC_HIGH_TEMP_C=45
NEXT_PUBLIC_HIGH_VIBRATION_PCT=70
NEXT_PUBLIC_STALE_AFTER_S=30          # "no new data" after this many seconds
```

SOC is **not** recalculated here. The dashboard shows the `battery_soc` the
ESP32 computes (60 V = 0 %, 84 V = 100 %), so the two cannot disagree.

---

## Deploying to Vercel

1. Push this `ev-telemetry-dashboard/` folder to a GitHub repo.
2. On vercel.com: **Add New → Project**, import the repo.
3. If the repo root is the parent folder, set **Root Directory** to `ev-telemetry-dashboard`.
4. Under **Environment Variables**, add **every** variable from `.env.local`.
   `.env.local` is gitignored, so Vercel will not see it otherwise.
   **This is the step most likely to be forgotten.**
5. Deploy.

---

## Troubleshooting: check the database first, not the page

Before debugging the dashboard, look at what Firebase actually holds:

```bash
curl "https://YOUR-DATABASE-URL/ev_telemetry/current.json"
curl "https://YOUR-DATABASE-URL/ev_telemetry2/current.json"
```

Compare the `timestamp` with `date +%s`. If the database is old, the problem is
the device. If the database is fresh but the page is not, the problem is the dashboard.

| What you see | Likely cause |
| --- | --- |
| Yellow "Firebase is not configured" box | `.env.local` still has `YOUR-PROJECT-ID`, or `npm run dev` was not restarted. |
| "connection error" | Wrong URL, or the rules deny reads. Open the `current.json` URL in a browser: it should show JSON or `null`, not `"Permission denied"`. |
| "waiting for first reading" | The device has never written to that folder. Check the Serial Monitor. |
| GPS "no new data" while the battery is live | Normal when the GPS has no fix. The ESP8266 only publishes with a fix. Check for `Waiting for fix...` in its Serial Monitor. |
| "receiving (device clock not synced)" | The device cannot reach `pool.ntp.org`. Readings still show, but stay out of the charts until the clock syncs. |
| Serial shows `HTTP 401` / `Permission denied` | Rules not published, or the device's folder name does not match the rules. |
| Serial shows `HTTP -1` on the ESP8266 | Usually low memory during TLS. The free heap is printed on the same line. |
| Energy chart suddenly drops to 0 | The ESP32 restarted. Energy is a running total kept in RAM. |
| Temperature/Humidity show "--" and "DHT11 read failed" | The firmware sends 0 / 0 when the DHT11 read fails. Those points are left out of the charts. |

---

## Security (read before sharing the link)

- The rules allow **anyone** to read and write `ev_telemetry` and `ev_telemetry2`.
  That is fine for a prototype demo, same as the water-level project. Tighten the
  rules or delete the database after the defence.
- The `.ino` files contain the WiFi password and the Telegram bot token in plain
  text. Do not push the firmware to a public GitHub repo as it is.

## Files

```
ev-telemetry-dashboard/
├── app/
│   ├── layout.tsx            page shell, loads Leaflet's CSS
│   ├── page.tsx              the dashboard
│   ├── globals.css           dark theme (same as the water-level dashboard)
│   └── icon.svg              browser-tab icon
├── components/
│   ├── MiniChart.tsx         one small chart per measurement
│   └── RouteMap.tsx          live map (OpenStreetMap / CARTO tiles, no API key)
├── lib/
│   └── telemetry.ts          Firebase fetching, alerts, CSV export
├── scripts/
│   └── send-test-data.mjs    fake data for testing
├── firebase-database-rules.json
├── .env.example              template - copy to .env.local (database URL + alert limits)
└── package.json
```
