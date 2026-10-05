import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "EV Battery Telemetry",
  description:
    "Live telemetry dashboard for an electric vehicle battery monitor (voltage, SOC, current, power, energy, temperature, humidity, vibration) and GPS tracker",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
