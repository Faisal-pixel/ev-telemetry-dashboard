"use client";

/**
 * Live map of the vehicle. Loaded with next/dynamic and ssr:false because
 * Leaflet needs `window`, which does not exist during server rendering.
 *
 * Tiles: CARTO "dark matter" basemap built on OpenStreetMap data. Free, no
 * API key. The attribution line is required by both and must stay visible.
 */

import { useEffect, useRef } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { LatLngTuple } from "leaflet";

interface Props {
  /** Recent route, oldest first. */
  trail: LatLngTuple[];
  /** Latest position, or null when there is no GPS fix. */
  position: LatLngTuple | null;
  follow: boolean;
}

// University of Lagos - only used until the first fix arrives.
const FALLBACK_CENTER: LatLngTuple = [6.5158, 3.3896];

function Follow({ position, follow }: { position: LatLngTuple | null; follow: boolean }) {
  const map = useMap();
  const first = useRef(true);

  useEffect(() => {
    if (!position) return;
    if (first.current) {
      map.setView(position, 16);
      first.current = false;
    } else if (follow) {
      map.panTo(position, { animate: true });
    }
  }, [map, position, follow]);

  return null;
}

export default function RouteMap({ trail, position, follow }: Props) {
  return (
    <MapContainer
      center={position ?? FALLBACK_CENTER}
      zoom={position ? 16 : 14}
      scrollWheelZoom
      className="leaflet-box"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={20}
      />

      {trail.length > 1 && (
        <Polyline positions={trail} pathOptions={{ color: "#38bdf8", weight: 3, opacity: 0.8 }} />
      )}

      {position && (
        <CircleMarker
          center={position}
          radius={8}
          pathOptions={{ color: "#0f172a", weight: 3, fillColor: "#38bdf8", fillOpacity: 1 }}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            {position[0].toFixed(6)}, {position[1].toFixed(6)}
          </Tooltip>
        </CircleMarker>
      )}

      <Follow position={position} follow={follow} />
    </MapContainer>
  );
}
