# Data providers

Every provider is wrapped in an adapter that returns a common shape, so it can be swapped without touching the risk engine or the map.

| Provider | Used for | Key | Update cadence | Called from | Adapter | Fair-use notes |
|---|---|---|---|---|---|---|
| [Open-Meteo Forecast](https://open-meteo.com/en/docs) | Current conditions, hourly forecast, area grid, route weather | None | Model runs roughly hourly; app refreshes every 10 min | Browser | `providers/openmeteo.js` | Free for non-commercial use, about 10 000 calls/day. Commercial use needs a paid plan. |
| [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) (Copernicus CAMS) | AQI, PM2.5, dust | None | Hourly; app refreshes every 20 min | Browser | `providers/openmeteo.js` | As above |
| [Open-Meteo Flood](https://open-meteo.com/en/docs/flood-api) (GloFAS) | River discharge forecast | None | Daily | Browser | `providers/openmeteo.js` | As above |
| [RainViewer](https://www.rainviewer.com/api.html) | Radar tiles | None | ~10 min | Browser | `providers/external.js` | Public API with zoom limits; tiles are shown up to zoom 7 and scaled beyond. |
| [Nominatim](https://nominatim.org/release-docs/latest/api/Overview/) | Place search, reverse geocoding | None | — | Browser | `providers/osm.js` | Max 1 request/second, no bulk use. Self-host or use a commercial geocoder in production. |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | Facilities, waterways, fords | None | Cached 30 min – 6 h | Browser | `providers/osm.js` | Shared public servers; two are tried in turn. |
| [OSRM demo server](https://project-osrm.org/) | Driving routes and alternatives | None | — | Browser | `providers/external.js` | Demo only, not for production. Use GraphHopper, Valhalla or your own OSRM. |
| [CARTO basemaps](https://carto.com/basemaps) | Light and dark map tiles | None | — | Browser | `map.js` | Free for limited, non-commercial use. |
| [US NWS](https://www.weather.gov/documentation/services-web-api) | Official warnings, USA | None (User-Agent contact) | Cached 5 min | Server | `server/warnings.js` | Set `NWS_USER_AGENT`. |
| [OpenWeather One Call 3.0](https://openweathermap.org/api/one-call-3) | Government alerts, many countries | `OPENWEATHER_API_KEY` | Cached 5 min | Server | `server/warnings.js` | Paid per call above a free tier. |
| CAP 1.2 feeds | Official warnings from any issuer that publishes CAP | Feed URL in `CAP_FEEDS` | Cached 5 min | Server | `server/warnings.js` | Find feeds via the WMO Alert Hub or your national service. |

## Normalised shapes

* **Weather** (`openmeteo.forecast`): `{ provider, kind, elevation, current: { time, temp, apparent, humidity, isDay, precip, code, cloud, wind, gust, windDir, cape, uv, visibility, precipProb }, hourly: [...], daily: [...], updatedAt }`
* **Warning** (`server/warnings.js`): `{ id, source, sourceName, event, headline, description, instruction, severity, urgency, certainty, onset, expires, areaDesc, url, geometry, geoMatched, fetchedAt }` – original CAP wording and severity are kept.
* **Facility** (`osm.emergencyResources`): `{ id, type, label, name, lat, lon, distance, address, phone, website, openingHours, osmUrl, source, verification: 'mapped' }`

To add a provider, write an adapter returning one of these shapes and call it from `loadAll()` in `app.js` (browser) or `getWarnings()` in `server/warnings.js` (server, for anything needing a secret key).

## Content Security Policy

`server/server.js` sends a CSP that only allows the hosts above. If you add a provider that the browser calls directly, add its host to `connect-src` (or `img-src` for tiles).
