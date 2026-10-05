"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LatLngTuple } from "leaflet";
import MiniChart, { type Point } from "@/components/MiniChart";
import {
  ageLabel,
  batteryAlerts,
  clockLabel,
  DB_CONFIGURED,
  DEVICES,
  dhtFailed,
  downloadCSV,
  exportFilename,
  fetchCurrent,
  fetchForExport,
  fetchHistory,
  hasFix,
  hasRealTime,
  LIMITS,
  SENSOR_PRESENT_V,
  STALE_AFTER_S,
  toCSV,
  type BatteryReading,
  type DeviceKey,
  type GpsReading,
} from "@/lib/telemetry";

// Leaflet touches `window`, so the map is only rendered in the browser.
const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => <div className="leaflet-box map-loading">Loading map…</div>,
});

const POLL_MS = 3000;

const COLORS = {
  voltage: "#38bdf8",
  soc: "#4ade80",
  current: "#fbbf24",
  power: "#a78bfa",
  energy: "#2dd4bf",
  temp: "#fb923c",
  humidity: "#60a5fa",
  vibration: "#f472b6",
  speed: "#38bdf8",
};

const num = (v: unknown, d = 1) =>
  v === null || v === undefined || isNaN(Number(v)) ? "--" : Number(v).toFixed(d);

const clamp = (v: number) => Math.max(0, Math.min(100, v));

type Status = "unconfigured" | "connecting" | "live" | "stale" | "nodata" | "error" | "noclock";

interface DeviceState<T> {
  current: T | null;
  history: T[];
  error: string | null;
  loaded: boolean;
}

const empty = <T,>(): DeviceState<T> => ({ current: null, history: [], error: null, loaded: false });

function deviceStatus<T extends { timestamp: number }>(s: DeviceState<T>, nowS: number): Status {
  if (!DB_CONFIGURED) return "unconfigured";
  if (!s.loaded) return "connecting";
  if (s.error) return "error";
  if (!s.current) return "nodata";
  if (!hasRealTime(s.current.timestamp)) return "noclock";
  return nowS - s.current.timestamp <= STALE_AFTER_S ? "live" : "stale";
}

function statusText<T extends { timestamp: number }>(st: Status, s: DeviceState<T>, nowS: number) {
  switch (st) {
    case "unconfigured":
      return "not configured";
    case "connecting":
      return "connecting…";
    case "error":
      return "connection error";
    case "nodata":
      return "waiting for first reading";
    case "noclock":
      return "receiving (device clock not synced)";
    case "live":
      return `live · ${ageLabel(nowS - s.current!.timestamp)}`;
    case "stale":
      return `no new data · last ${ageLabel(nowS - s.current!.timestamp)}`;
  }
}

export default function Dashboard() {
  const [bat, setBat] = useState<DeviceState<BatteryReading>>(empty);
  const [gps, setGps] = useState<DeviceState<GpsReading>>(empty);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  const [follow, setFollow] = useState(true);

  // CSV export state
  const [exportDevice, setExportDevice] = useState<DeviceKey>("battery");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  /* ---------------- polling ---------------- */

  const tick = useCallback(async () => {
    if (!DB_CONFIGURED) return;
    // Each device is fetched on its own, so one failing never blanks the other.
    const [bc, bh, gc, gh] = await Promise.allSettled([
      fetchCurrent("battery"),
      fetchHistory("battery"),
      fetchCurrent("gps"),
      fetchHistory("gps"),
    ]);

    const errOf = (...rs: PromiseSettledResult<unknown>[]) => {
      const bad = rs.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      return bad ? (bad.reason instanceof Error ? bad.reason.message : String(bad.reason)) : null;
    };

    setBat((prev) => ({
      current: bc.status === "fulfilled" ? bc.value : prev.current,
      history: bh.status === "fulfilled" ? bh.value : prev.history,
      error: errOf(bc, bh),
      loaded: true,
    }));
    setGps((prev) => ({
      current: gc.status === "fulfilled" ? gc.value : prev.current,
      history: gh.status === "fulfilled" ? gh.value : prev.history,
      error: errOf(gc, gh),
      loaded: true,
    }));
  }, []);

  useEffect(() => {
    tick();
    const poll = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [tick]);

  /* ---------------- export ---------------- */

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportMsg(null);
    try {
      const from = fromDate || undefined;
      const to = toDate || undefined;
      const rows =
        exportDevice === "battery"
          ? await fetchForExport("battery", from, to)
          : await fetchForExport("gps", from, to);

      if (rows.length === 0) {
        setExportMsg("No device readings found for that range (test rows are always excluded).");
        return;
      }
      const csv =
        exportDevice === "battery"
          ? toCSV("battery", rows as BatteryReading[])
          : toCSV("gps", rows as GpsReading[]);
      downloadCSV(csv, exportFilename(exportDevice, from, to));
      setExportMsg(`Exported ${rows.length} reading${rows.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setExportMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }, [exportDevice, fromDate, toDate]);

  /* ---------------- derived values ---------------- */

  const b = bat.current;
  const g = gps.current;
  const batStatus = deviceStatus(bat, nowS);
  const gpsStatus = deviceStatus(gps, nowS);
  const alerts = batteryAlerts(b);
  const sensorPresent = !!b && Number(b.battery_voltage) > SENSOR_PRESENT_V;
  const soc = Number(b?.battery_soc ?? 0);
  const vib = Number(b?.vibration ?? 0);
  const dhtBad = dhtFailed(b);
  const fix = hasFix(g);
  const batDim = batStatus === "stale" ? " is-stale" : "";
  const gpsDim = gpsStatus === "stale" ? " is-stale" : "";

  const series = useMemo(() => {
    const pick = <T extends { timestamp: number }>(rows: T[], f: (r: T) => number): Point[] =>
      rows.map((r) => ({ t: r.timestamp, v: isNaN(Number(f(r))) ? null : Number(f(r)) }));
    const h = bat.history;
    return {
      voltage: pick(h, (r) => r.battery_voltage),
      soc: pick(h, (r) => r.battery_soc),
      current: pick(h, (r) => r.current),
      power: pick(h, (r) => r.power),
      energy: pick(h, (r) => r.energy),
      // DHT11 failures arrive as 0 / 0 - leave them out instead of plotting a dive to zero
      temp: pick(
        h.filter((r) => !dhtFailed(r)),
        (r) => r.temperature
      ),
      humidity: pick(
        h.filter((r) => !dhtFailed(r)),
        (r) => r.humidity
      ),
      vibration: pick(h, (r) => r.vibration),
      speed: pick(gps.history, (r) => r.speed),
    };
  }, [bat.history, gps.history]);

  const trail = useMemo<LatLngTuple[]>(
    () =>
      gps.history
        .filter((r) => hasFix(r))
        .map((r) => [Number(r.latitude), Number(r.longitude)] as LatLngTuple),
    [gps.history]
  );
  const position: LatLngTuple | null = fix ? [Number(g!.latitude), Number(g!.longitude)] : null;

  // Break chart lines when readings are > 3 publish intervals apart (or 30 s minimum)
  const batGap = Math.max(30, DEVICES.battery.publishEveryS * 3);
  const gpsGap = Math.max(30, DEVICES.gps.publishEveryS * 3);

  const lastBattery = clockLabel(b?.timestamp);
  const lastGps = clockLabel(g?.timestamp);

  /* ---------------- render ---------------- */

  return (
    <main>
      <header>
        <div>
          <h1>EV Battery Telemetry</h1>
          <div className="sub">
            Performance and degradation of EV battery systems under field driving and charging
            conditions &middot; live telemetry
          </div>
        </div>
        <div className="status-stack">
          <StatusRow label={`${DEVICES.battery.name} · battery`} status={batStatus}>
            {statusText(batStatus, bat, nowS)}
          </StatusRow>
          <StatusRow label={`${DEVICES.gps.name} · GPS`} status={gpsStatus}>
            {statusText(gpsStatus, gps, nowS)}
          </StatusRow>
        </div>
      </header>

      {!DB_CONFIGURED && (
        <div className="notice">
          Firebase is not configured yet. Put your database URL in{" "}
          <code>NEXT_PUBLIC_FIREBASE_DB_URL</code> inside <code>.env.local</code>, then restart{" "}
          <code>npm run dev</code>.
        </div>
      )}

      {alerts.length > 0 && (
        <div className="alert" role="alert">
          <div className="alert-title">
            ALERT{alerts.length > 1 ? "S" : ""}
            {batStatus === "stale" && b && (
              <span className="alert-age"> &middot; from the last reading, {ageLabel(nowS - b.timestamp)}</span>
            )}
          </div>
          <ul>
            {alerts.map((a) => (
              <li key={a.key}>{a.text}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="export-bar">
        <span className="export-label">Export readings</span>

        <label className="date-field">
          Device
          <select value={exportDevice} onChange={(e) => setExportDevice(e.target.value as DeviceKey)}>
            <option value="battery">Battery (EV Telemetry)</option>
            <option value="gps">GPS (EV Telemetry 2)</option>
          </select>
        </label>

        <label className="date-field">
          From
          <input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>

        <label className="date-field">
          To
          <input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
          />
        </label>

        <button
          className="export-btn"
          onClick={handleExport}
          disabled={exporting || !DB_CONFIGURED}
        >
          {exporting ? "Exporting…" : "Export CSV"}
        </button>

        {(fromDate || toDate) && (
          <button
            className="clear-btn"
            onClick={() => {
              setFromDate("");
              setToDate("");
              setExportMsg(null);
            }}
          >
            Clear dates
          </button>
        )}

        <span className="export-hint">
          {exportMsg ?? "Leave dates blank to export everything recorded."}
        </span>
      </div>

      {/* ------------------------------------------------ BATTERY & POWER */}
      <h3 className="section">
        Battery &amp; power <span>{lastBattery && `reading at ${lastBattery}`}</span>
      </h3>
      <div className={`grid${batDim}`}>
        <div className={`card${alerts.some((a) => a.key === "voltage") ? " card-alert" : ""}`}>
          <div className="label">Battery Voltage</div>
          <div className="value">
            <span>{num(b?.battery_voltage, 2)}</span>
            <span className="unit">V</span>
          </div>
          <div className="foot">
            {b && !sensorPresent ? "sensor not connected?" : `low-voltage alert below ${LIMITS.lowVoltage} V`}
          </div>
        </div>

        <div className={`card${alerts.some((a) => a.key === "soc") ? " card-alert" : ""}`}>
          <div className="label">State of Charge</div>
          <div className="value">
            <span>{num(b?.battery_soc, 0)}</span>
            <span className="unit">%</span>
          </div>
          <div className="bar">
            <span
              style={{
                width: `${clamp(soc)}%`,
                background: soc > 60 ? "var(--green)" : soc > LIMITS.lowSoc ? "var(--amber)" : "var(--red)",
              }}
            />
          </div>
          <div className="foot">60 V = 0 % &middot; 84 V = 100 %</div>
        </div>

        <div className="card">
          <div className="label">Current</div>
          <div className="value">
            <span>
              {b && Number(b.current) > 0 ? "+" : ""}
              {num(b?.current, 2)}
            </span>
            <span className="unit">A</span>
          </div>
          <div className="foot">ACS712-30A</div>
        </div>

        <div className="card">
          <div className="label">Power</div>
          <div className="value">
            <span>{num(b?.power, 1)}</span>
            <span className="unit">W</span>
          </div>
          <div className="foot">voltage &times; |current|</div>
        </div>

        <div className="card">
          <div className="label">Energy</div>
          <div className="value">
            <span>{num(b?.energy, 2)}</span>
            <span className="unit">Wh</span>
          </div>
          <div className="foot">running total since the device last restarted</div>
        </div>
      </div>

      {/* ------------------------------------------------ ENVIRONMENT & RIDE */}
      <h3 className="section">Environment &amp; ride</h3>
      <div className={`grid${batDim}`}>
        <div className={`card${alerts.some((a) => a.key === "temp") ? " card-alert" : ""}`}>
          <div className="label">Temperature</div>
          <div className="value">
            <span>{dhtBad ? "--" : num(b?.temperature, 1)}</span>
            <span className="unit">&deg;C</span>
          </div>
          <div className="foot">
            {dhtBad ? "DHT11 read failed" : `alert above ${LIMITS.highTemp} °C`}
          </div>
        </div>

        <div className="card">
          <div className="label">Humidity</div>
          <div className="value">
            <span>{dhtBad ? "--" : num(b?.humidity, 1)}</span>
            <span className="unit">%</span>
          </div>
          <div className="foot">{dhtBad ? "DHT11 read failed" : "DHT11"}</div>
        </div>

        <div className={`card${alerts.some((a) => a.key === "vibration") ? " card-alert" : ""}`}>
          <div className="label">Vibration</div>
          <div className="value">
            <span>{num(b?.vibration, 0)}</span>
            <span className="unit">%</span>
          </div>
          <div className="bar">
            <span
              style={{
                width: `${clamp(vib)}%`,
                background: vib > LIMITS.highVibration ? "var(--red)" : "var(--violet)",
              }}
            />
          </div>
          <div className="foot">100 % = 0.30 g deviation (MPU6050)</div>
        </div>
      </div>

      {/* ------------------------------------------------ LOCATION */}
      <h3 className="section">
        Location <span>{lastGps && `fix at ${lastGps}`}</span>
      </h3>
      <div className="loc-grid">
        <div className="map-card">
          <div className="map-head">
            <span>
              {fix
                ? `Route · last ${trail.length} position${trail.length === 1 ? "" : "s"}`
                : "No GPS fix yet"}
            </span>
            <label className="follow">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              Follow vehicle
            </label>
          </div>
          <RouteMap trail={trail} position={position} follow={follow} />
        </div>

        <div className={`loc-side${gpsDim}`}>
          <div className="card">
            <div className="label">Speed</div>
            <div className="value">
              <span>{num(g?.speed, 1)}</span>
              <span className="unit">km/h</span>
            </div>
            <div className="foot">from the GPS module (TinyGPS++)</div>
          </div>

          <div className="card">
            <div className="label">Position</div>
            {fix ? (
              <>
                <div className="coords">
                  <div>
                    <span>Lat</span> {Number(g!.latitude).toFixed(6)}
                  </div>
                  <div>
                    <span>Lng</span> {Number(g!.longitude).toFixed(6)}
                  </div>
                </div>
                <a
                  className="maps-link"
                  href={`https://www.google.com/maps?q=${g!.latitude},${g!.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Google Maps &rarr;
                </a>
              </>
            ) : (
              <div className="value">--</div>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ HISTORY */}
      <h3 className="section">
        History{" "}
        <span>
          last {bat.history.length} battery readings &middot; last {gps.history.length} GPS readings
        </span>
      </h3>
      <div className="charts">
        <MiniChart
          title="Battery voltage"
          unit="V"
          decimals={2}
          color={COLORS.voltage}
          data={series.voltage}
          gapS={batGap}
          limit={{ y: LIMITS.lowVoltage, label: `below ${LIMITS.lowVoltage} V` }}
        />
        <MiniChart
          title="State of charge"
          unit="%"
          decimals={0}
          color={COLORS.soc}
          data={series.soc}
          gapS={batGap}
          domain={[0, 100]}
          limit={{ y: LIMITS.lowSoc, label: `below ${LIMITS.lowSoc} %` }}
        />
        <MiniChart
          title="Current"
          unit="A"
          decimals={2}
          color={COLORS.current}
          data={series.current}
          gapS={batGap}
        />
        <MiniChart
          title="Power"
          unit="W"
          decimals={1}
          color={COLORS.power}
          data={series.power}
          gapS={batGap}
        />
        <MiniChart
          title="Energy"
          hint="drops to 0 when the device restarts"
          unit="Wh"
          decimals={2}
          color={COLORS.energy}
          data={series.energy}
          gapS={batGap}
        />
        <MiniChart
          title="Temperature"
          unit="°C"
          decimals={1}
          color={COLORS.temp}
          data={series.temp}
          gapS={batGap}
          limit={{ y: LIMITS.highTemp, label: `above ${LIMITS.highTemp} °C` }}
        />
        <MiniChart
          title="Humidity"
          unit="%"
          decimals={1}
          color={COLORS.humidity}
          data={series.humidity}
          gapS={batGap}
          domain={[0, 100]}
        />
        <MiniChart
          title="Vibration"
          unit="%"
          decimals={0}
          color={COLORS.vibration}
          data={series.vibration}
          gapS={batGap}
          domain={[0, 100]}
          limit={{ y: LIMITS.highVibration, label: `above ${LIMITS.highVibration} %` }}
        />
        <MiniChart
          title="Speed"
          unit="km/h"
          decimals={1}
          color={COLORS.speed}
          data={series.speed}
          gapS={gpsGap}
          domain={[0, "auto"]}
        />
      </div>

      <footer>
        {bat.error || gps.error ? (
          <span className="err">
            Could not reach Firebase: {bat.error ?? gps.error}. Check NEXT_PUBLIC_FIREBASE_DB_URL and
            that your security rules allow read access.
          </span>
        ) : (
          <>
            Polling every {POLL_MS / 1000} s &nbsp;|&nbsp; source: Firebase Realtime Database
            &nbsp;|&nbsp; gaps in a line mean the device sent nothing for that period
          </>
        )}
      </footer>
    </main>
  );
}

function StatusRow({
  label,
  status,
  children,
}: {
  label: string;
  status: Status;
  children: React.ReactNode;
}) {
  const dot =
    status === "live" || status === "noclock"
      ? "live"
      : status === "stale" || status === "error"
        ? "stale"
        : "";
  return (
    <div className="status">
      <span className={`dot ${dot}`} />
      <span className="status-label">{label}</span>
      <span>{children}</span>
    </div>
  );
}
