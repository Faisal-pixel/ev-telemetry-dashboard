#!/usr/bin/env node
/**
 * Sends FAKE readings to Firebase so you can check the dashboard without the
 * devices. Every row it writes is tagged "_test": true. The dashboard shows
 * them, but CSV export always leaves them out, and --remove deletes them.
 *
 * It uses exactly the same URLs and JSON the firmware uses, so if this works,
 * the database side is ready for the real devices.
 *
 *   node scripts/send-test-data.mjs            10 min of history + a current reading
 *   node scripts/send-test-data.mjs --live     ...then keep sending (Ctrl+C to stop)
 *   node scripts/send-test-data.mjs --alerts   make every alert fire
 *   node scripts/send-test-data.mjs --remove   delete all test rows again
 *
 * The database URL is read from .env.local (NEXT_PUBLIC_FIREBASE_DB_URL), or
 * pass it with --url https://....firebaseio.com
 *
 * Needs Node 18 or newer (for the built-in fetch).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

function dbUrl() {
  const i = args.indexOf("--url");
  if (i !== -1 && args[i + 1]) return args[i + 1].replace(/\/$/, "");
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const env = readFileSync(join(here, "..", ".env.local"), "utf8");
    const m = env.match(/^NEXT_PUBLIC_FIREBASE_DB_URL=(.+)$/m);
    if (m) return m[1].trim().replace(/\/$/, "");
  } catch {
    /* fall through */
  }
  return "";
}

const DB = dbUrl();
if (!DB || DB.includes("YOUR-PROJECT-ID")) {
  console.error("Set NEXT_PUBLIC_FIREBASE_DB_URL in .env.local first (or pass --url).");
  process.exit(1);
}

async function send(method, path, body) {
  const res = await fetch(`${DB}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/* ------------------------------------------------------------------ fake data */

const ALERTS = flag("--alerts");
const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const jitter = (amp) => (Math.random() - 0.5) * 2 * amp;

let energy = 0;

function battery(ts, i) {
  // slow discharge from ~79 V, with load-dependent sag
  const load = 6 + 4 * Math.sin(i / 7) + jitter(1.5); // A
  let v = 79 - i * 0.03 - load * 0.12 + jitter(0.15);
  if (ALERTS) v = 63.5 + jitter(0.2);
  const current = -load; // negative = discharging in this simulation
  const power = v * Math.abs(current);
  energy += power * (10 / 3600);
  const soc = Math.max(0, Math.min(100, ((v - 60) / (84 - 60)) * 100));
  return {
    battery_voltage: r2(v),
    battery_soc: r2(soc, 1),
    temperature: r2(ALERTS ? 47.5 + jitter(0.5) : 31 + i * 0.02 + jitter(0.3), 1),
    humidity: r2(62 + jitter(2), 1),
    current: r2(current),
    power: r2(power),
    energy: r2(energy, 3),
    vibration: r2(ALERTS ? 82 + jitter(5) : Math.max(0, 25 + 20 * Math.sin(i / 3) + jitter(8)), 1),
    timestamp: ts,
    _test: true,
  };
}

// a loop of about 800 m around the University of Lagos
const CENTER = [6.5158, 3.3896];
function gps(ts, i) {
  const a = i / 40;
  const speed = Math.max(0, 22 + 10 * Math.sin(i / 9) + jitter(2));
  return {
    latitude: r2(CENTER[0] + 0.0035 * Math.sin(a), 6),
    longitude: r2(CENTER[1] + 0.0045 * Math.cos(a), 6),
    speed: r2(speed, 1),
    timestamp: ts,
    _test: true,
  };
}

/* ------------------------------------------------------------------ actions */

async function removeTestRows() {
  for (const dev of ["ev_telemetry", "ev_telemetry2"]) {
    const hist = (await send("GET", `/${dev}/history.json`)) ?? {};
    const doomed = Object.entries(hist).filter(([, r]) => r && r._test === true);
    if (doomed.length) {
      const patch = Object.fromEntries(doomed.map(([k]) => [k, null]));
      await send("PATCH", `/${dev}/history.json`, patch);
    }
    const cur = await send("GET", `/${dev}/current.json`);
    if (cur && cur._test === true) await send("DELETE", `/${dev}/current.json`);
    console.log(`${dev}: removed ${doomed.length} test history rows${cur?._test ? " and the test current reading" : ""}`);
  }
}

async function backfill() {
  const now = Math.floor(Date.now() / 1000);
  // battery every 10 s for 10 min, GPS every 5 s for 10 min
  // The newest row of each is also the "current" reading, exactly like the
  // firmware, which sends the same JSON to current.json and history.json.
  const bRows = {};
  let bLast;
  for (let i = 0; i < 60; i++) {
    const ts = now - (59 - i) * 10;
    bLast = battery(ts, i);
    bRows[`test_b_${ts}`] = bLast;
  }
  const gRows = {};
  let gLast;
  for (let i = 0; i < 120; i++) {
    const ts = now - (119 - i) * 5;
    gLast = gps(ts, i);
    gRows[`test_g_${ts}`] = gLast;
  }

  // One PATCH per device writes all history rows at once
  await send("PATCH", "/ev_telemetry/history.json", bRows);
  await send("PATCH", "/ev_telemetry2/history.json", gRows);
  await send("PUT", "/ev_telemetry/current.json", bLast);
  await send("PUT", "/ev_telemetry2/current.json", gLast);
  console.log(`Sent 60 battery + 120 GPS history rows and both current readings to ${DB}`);
}

async function live() {
  console.log("Live mode: battery every 10 s, GPS every 5 s. Ctrl+C to stop.");
  let i = 60;
  let j = 120; // continue the same simulated drive
  const tickGps = async () => {
    const r = gps(Math.floor(Date.now() / 1000), j++);
    // exactly what the ESP8266 sends
    await send("PUT", "/ev_telemetry2/current.json", r);
    await send("POST", "/ev_telemetry2/history.json", r);
    console.log(`gps     ${r.latitude}, ${r.longitude}  ${r.speed} km/h`);
  };
  const tickBat = async () => {
    const r = battery(Math.floor(Date.now() / 1000), i++);
    // exactly what the ESP32 sends
    await send("PUT", "/ev_telemetry/current.json", r);
    await send("POST", "/ev_telemetry/history.json", r);
    console.log(`battery ${r.battery_voltage} V  ${r.battery_soc} %  ${r.power} W`);
  };
  setInterval(() => tickGps().catch((e) => console.error(e.message)), 5000);
  setInterval(() => tickBat().catch((e) => console.error(e.message)), 10000);
}

try {
  if (flag("--remove")) {
    await removeTestRows();
  } else {
    await backfill();
    if (flag("--live")) await live();
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
