/**
 * Data access layer for the two EV devices in Firebase Realtime Database.
 *
 * Each device writes into its own folder on every publish cycle:
 *
 *   ev_telemetry/   (ESP32  - battery, environment, vibration, every 10 s)
 *   ev_telemetry2/  (ESP8266 - GPS, every 5 s while it has a fix)
 *
 *   PUT  /<folder>/current.json   -> latest reading (overwritten each time)
 *   POST /<folder>/history.json   -> append-only log (Firebase generates the key)
 *
 * "timestamp" is Unix SECONDS set by the device from NTP. 0 means the
 * device clock was not synced; those rows are left out of charts and exports.
 */

/* ==========================================================================
 * TYPES
 * ========================================================================== */

interface Common {
  /** Unix seconds from the device clock (0 = clock not synced). */
  timestamp: number;
  /** 1 when the reading was buffered in flash and uploaded later. */
  stored?: number;
  /** Set only by scripts/send-test-data.mjs. Never exported. */
  _test?: boolean;
}

export interface BatteryReading extends Common {
  battery_voltage: number; // V
  battery_soc: number; // %
  temperature: number; // °C
  humidity: number; // %
  current: number; // A
  power: number; // W
  energy: number; // Wh, since the last device restart
  vibration: number; // %
}

export interface GpsReading extends Common {
  speed: number; // km/h
  latitude: number;
  longitude: number;
}

export interface ReadingByDevice {
  battery: BatteryReading;
  gps: GpsReading;
}

export type DeviceKey = keyof ReadingByDevice;

export const DEVICES: Record<
  DeviceKey,
  { path: string; name: string; board: string; publishEveryS: number }
> = {
  battery: {
    path: "ev_telemetry",
    name: "EV Telemetry",
    board: "ESP32",
    publishEveryS: 10,
  },
  gps: {
    path: "ev_telemetry2",
    name: "EV Telemetry 2",
    board: "ESP8266",
    publishEveryS: 5,
  },
};

/* ==========================================================================
 * CONFIG (all from .env.local - one place only)
 * ========================================================================== */

const DB_URL = (process.env.NEXT_PUBLIC_FIREBASE_DB_URL ?? "").replace(/\/$/, "");

const envNum = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v === undefined || v === "" || isNaN(n) ? fallback : n;
};

export const LIMITS = {
  /** Must match LOW_VOLTAGE_ALERT in EV_Telemetry_Firebase.ino */
  lowVoltage: envNum(process.env.NEXT_PUBLIC_LOW_VOLTAGE_V, 65),
  lowSoc: envNum(process.env.NEXT_PUBLIC_LOW_SOC_PCT, 20),
  highTemp: envNum(process.env.NEXT_PUBLIC_HIGH_TEMP_C, 45),
  highVibration: envNum(process.env.NEXT_PUBLIC_HIGH_VIBRATION_PCT, 70),
};

export const STALE_AFTER_S = envNum(process.env.NEXT_PUBLIC_STALE_AFTER_S, 30);

/** Readings loaded for the charts (battery: 20 min, GPS: 10 min at full rate). */
export const HISTORY_POINTS = 120;

/**
 * Below this the voltage sensor is treated as disconnected. Same guard the
 * firmware uses before sounding the buzzer (inputVoltage > 10.0).
 */
export const SENSOR_PRESENT_V = 10;

export const DB_CONFIGURED =
  DB_URL !== "" && !DB_URL.includes("YOUR-PROJECT-ID");

function assertConfigured() {
  if (!DB_CONFIGURED) {
    throw new Error(
      "NEXT_PUBLIC_FIREBASE_DB_URL is not set. Add your database URL to .env.local (and to your Vercel project settings)."
    );
  }
}

/* ==========================================================================
 * FETCHING
 * ========================================================================== */

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error ? ` (${body.error})` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`Firebase responded ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

/** Latest reading for a device, or null if it has never published. */
export async function fetchCurrent<K extends DeviceKey>(
  device: K
): Promise<ReadingByDevice[K] | null> {
  assertConfigured();
  return getJson<ReadingByDevice[K] | null>(
    `${DB_URL}/${DEVICES[device].path}/current.json?ts=${Date.now()}`
  );
}

function sortRows<T extends Common>(raw: Record<string, T> | null): T[] {
  if (!raw) return [];
  return Object.values(raw)
    .filter((r) => r && Number(r.timestamp) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Most recent readings with a real timestamp, oldest first. */
export async function fetchHistory<K extends DeviceKey>(
  device: K,
  limit: number = HISTORY_POINTS
): Promise<ReadingByDevice[K][]> {
  assertConfigured();
  const params = new URLSearchParams({
    orderBy: '"timestamp"',
    startAt: "1", // skip rows with timestamp 0 (clock never synced)
    limitToLast: String(limit),
    ts: String(Date.now()),
  });
  const raw = await getJson<Record<string, ReadingByDevice[K]> | null>(
    `${DB_URL}/${DEVICES[device].path}/history.json?${params}`
  );
  return sortRows(raw);
}

/* ==========================================================================
 * TIME HELPERS
 * ========================================================================== */

/** True when the device clock had synced (anything after Nov 2023). */
export const hasRealTime = (ts?: number) => !!ts && ts > 1_700_000_000;

/** HH:MM:SS for a Unix-seconds timestamp, or "" if the clock never synced. */
export function clockLabel(ts?: number): string {
  if (!hasRealTime(ts)) return "";
  return new Date(ts! * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "12 s ago", "4 min ago", "3 h ago". */
export function ageLabel(seconds: number): string {
  if (seconds < 0) seconds = 0;
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

/* ==========================================================================
 * ALERTS
 * ========================================================================== */

export interface Alert {
  key: "voltage" | "soc" | "temp" | "vibration";
  text: string;
}

export function batteryAlerts(r: BatteryReading | null): Alert[] {
  if (!r) return [];
  const out: Alert[] = [];
  const v = Number(r.battery_voltage);
  const sensorPresent = v > SENSOR_PRESENT_V;

  if (sensorPresent && v < LIMITS.lowVoltage) {
    out.push({
      key: "voltage",
      text: `Low battery voltage: ${v.toFixed(2)} V (limit ${LIMITS.lowVoltage} V)`,
    });
  }
  if (sensorPresent && Number(r.battery_soc) < LIMITS.lowSoc) {
    out.push({
      key: "soc",
      text: `Low state of charge: ${Number(r.battery_soc).toFixed(0)} % (limit ${LIMITS.lowSoc} %)`,
    });
  }
  if (Number(r.temperature) > LIMITS.highTemp) {
    out.push({
      key: "temp",
      text: `High temperature: ${Number(r.temperature).toFixed(1)} °C (limit ${LIMITS.highTemp} °C)`,
    });
  }
  if (Number(r.vibration) > LIMITS.highVibration) {
    out.push({
      key: "vibration",
      text: `High vibration: ${Number(r.vibration).toFixed(0)} % (limit ${LIMITS.highVibration} %)`,
    });
  }
  return out;
}

/** The firmware sends 0 for BOTH temperature and humidity when the DHT11 read fails. */
export const dhtFailed = (r: BatteryReading | null) =>
  !!r && Number(r.temperature) === 0 && Number(r.humidity) === 0;

/** A GPS reading at exactly 0,0 means "no position", not the Gulf of Guinea. */
export const hasFix = (r: GpsReading | null) =>
  !!r &&
  isFinite(Number(r.latitude)) &&
  isFinite(Number(r.longitude)) &&
  !(Number(r.latitude) === 0 && Number(r.longitude) === 0);

/* ==========================================================================
 * CSV EXPORT
 * ========================================================================== */

/**
 * Fetches a device's readings for export, optionally restricted to a date range.
 * `from` / `to` are "YYYY-MM-DD" strings from <input type="date">; the range
 * is inclusive (`to` runs to 23:59:59). Filtering happens in Firebase via
 * orderBy/startAt/endAt, which needs ".indexOn": "timestamp" in the rules.
 * Rows from the test-data script are always excluded.
 */
export async function fetchForExport<K extends DeviceKey>(
  device: K,
  from?: string,
  to?: string
): Promise<ReadingByDevice[K][]> {
  assertConfigured();
  const params = new URLSearchParams();
  params.set("orderBy", '"timestamp"');
  params.set(
    "startAt",
    from ? String(Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000)) : "1"
  );
  if (to) {
    params.set("endAt", String(Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000)));
  }
  params.set("ts", String(Date.now()));

  const raw = await getJson<Record<string, ReadingByDevice[K]> | null>(
    `${DB_URL}/${DEVICES[device].path}/history.json?${params}`
  );
  return sortRows(raw).filter((r) => r._test !== true);
}

type Column<T> = { label: string; get: (r: T) => unknown };

const commonStart = <T extends Common>(): Column<T>[] => [
  { label: "timestamp_unix", get: (r) => r.timestamp },
  { label: "datetime_utc", get: (r) => new Date(r.timestamp * 1000).toISOString() },
];

const CSV_COLUMNS: { [K in DeviceKey]: Column<ReadingByDevice[K]>[] } = {
  battery: [
    ...commonStart<BatteryReading>(),
    { label: "battery_voltage_v", get: (r) => r.battery_voltage },
    { label: "battery_soc_pct", get: (r) => r.battery_soc },
    { label: "current_a", get: (r) => r.current },
    { label: "power_w", get: (r) => r.power },
    { label: "energy_wh", get: (r) => r.energy },
    { label: "temperature_c", get: (r) => r.temperature },
    { label: "humidity_pct", get: (r) => r.humidity },
    { label: "vibration_pct", get: (r) => r.vibration },
    { label: "uploaded_late", get: (r) => (r.stored ? 1 : 0) },
  ],
  gps: [
    ...commonStart<GpsReading>(),
    { label: "latitude", get: (r) => r.latitude },
    { label: "longitude", get: (r) => r.longitude },
    { label: "speed_kmh", get: (r) => r.speed },
    { label: "uploaded_late", get: (r) => (r.stored ? 1 : 0) },
  ],
};

/** Wraps a value in quotes only when it needs it. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV<K extends DeviceKey>(device: K, rows: ReadingByDevice[K][]): string {
  const cols = CSV_COLUMNS[device] as Column<ReadingByDevice[K]>[];
  const lines = [cols.map((c) => c.label).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c.get(r))).join(","));
  return lines.join("\n");
}

/** Triggers a browser download of `csv` as `filename`. */
export function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportFilename(device: DeviceKey, from?: string, to?: string): string {
  const base = device === "battery" ? "ev-battery-readings" : "ev-gps-readings";
  if (from && to) return `${base}_${from}_to_${to}.csv`;
  if (from) return `${base}_from_${from}.csv`;
  if (to) return `${base}_up_to_${to}.csv`;
  return `${base}_all.csv`;
}
