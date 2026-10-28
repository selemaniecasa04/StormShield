# StormShield risk model

All numbers below live in `RISK_CONFIG` in `public/js/risk.js`, so they can be tuned without touching the logic. `npm test` checks the key safety properties.

## 1. Score each hazard on its own

Each hazard gets a **severity** between 0 and 1 from step thresholds. Hazards expected within 6 hours but not happening now are multiplied by 0.85.

| Hazard | Input | Thresholds → severity |
|---|---|---|
| Thunderstorm | Weather code 95–99 now (0.72) or within 6 h (0.6 × 0.85); otherwise CAPE when rain chance ≥ 40% | CAPE ≥ 1000 J/kg → 0.2, ≥ 2500 → 0.35 |
| Hail | Weather code 96/99 now (0.7) or within 6 h | — |
| Rain / flash flood | Rain rate now | 2.5 mm/h → 0.15, 7.6 → 0.4, 20 → 0.65, 50 → 0.88 |
| | Rain over next 6 h | 20 mm → 0.25, 40 → 0.45, 70 → 0.7, 110 → 0.88 |
| | River peak ÷ 180-day median (GloFAS) | 2× → 0.3, 4× → 0.55, 8× → 0.8 |
| Wind | Peak gust now or within 6 h | 50 km/h → 0.15, 62 → 0.3, 75 → 0.48, 90 → 0.68, 110 → 0.88 |
| Heat | Highest feels-like temperature in 12 h | 32 °C → 0.2, 38 → 0.4, 41 → 0.6, 46 → 0.8, 54 → 0.95 |
| Cold | Lowest feels-like temperature in 12 h | −10 °C → 0.3, −25 → 0.6, −40 → 0.85 |
| UV | Daytime UV index | 8 → 0.2, 11 → 0.35 |
| Air quality | US AQI now or within 12 h | 101 → 0.2, 151 → 0.45, 201 → 0.65, 301 → 0.88 |
| Visibility | Current visibility | ≤ 1000 m → 0.3, ≤ 200 m → 0.6 |
| Official warning | Issuer's own CAP severity | Extreme 0.95, Severe 0.75, Moderate 0.45, Minor 0.2, Unknown 0.4 (× 0.6 if not geo-matched) |

Community reports within 5 km raise the matching hazard to a minimum (flooded road 0.45, lightning 0.5, hail 0.45, wind damage 0.3). They never lower it.

## 2. Adjust for exposure

* **Activity** (chosen in Settings, or inferred from GPS speed: > 7 m/s = road travel, > 0.8 m/s = outdoors) multiplies each hazard. For example indoors: wind × 0.7, heat × 0.65; road travel: flood × 1.3, visibility × 1.3.
* **Flooding** × 1.25 within 200 m of a mapped waterway, × 1.15 if your location is more than 15 m lower than the surrounding forecast grid, × 1.1 at night.

## 3. Combine without averaging

Hazards are sorted by severity and combined with a probabilistic OR, where secondary hazards count at half weight:

```
combined = 1 − (1 − s₁) × Π (1 − sᵢ × 0.5)   for i > 1
score    = round(100 × (1 − combined))        100 = no threat found
```

The worst hazard always sets the floor, and extra hazards make things worse rather than diluting them.

## 4. Levels and severity floors

| Score | Level |
|---|---|
| 75–100 | SAFE |
| 50–74 | WATCH |
| 25–49 | WARNING |
| 0–24 | EMERGENCY |

Floors then override the score: any single hazard ≥ 0.85 forces **EMERGENCY**, ≥ 0.6 forces at least **WARNING**, ≥ 0.3 at least **WATCH**. A geo-matched official *Extreme* warning forces EMERGENCY, *Severe* forces at least WARNING.

## 5. Confidence

Starts at **high** and drops when: weather data is over 1.5 h old (medium) or 3 h old (low); no official warnings feed covers the location (medium); air quality or river data is missing (medium); GPS accuracy is worse than 5 km (low). The reasons are shown under *Coverage and limits*.

If weather data is unavailable the level is **UNKNOWN** with no score. StormShield never shows SAFE without data.

## 6. Change explanations

Each new assessment is compared to the previous one. New hazards, removed hazards and level changes are listed in plain language on the Overview and in Alerts → Recent changes.

## 7. Journey ratings

Each route is sampled at 3–10 points. The forecast is read for the hour you would reach each point. Route rating uses the worst sample: < 0.3 LOW, < 0.55 MODERATE, < 0.8 HIGH, otherwise DANGEROUS. Mapped fords count as 0.3, or 0.75 when heavy rain is expected on the route. Flooded-road reports within 300 m count as 0.6 (0.85 when verified). The recommended route has the lowest worst-case severity, with travel time as the tie-breaker.

## Known limits

* Forecast models have ~2–13 km resolution. Small, fast storms may be missed.
* GloFAS models large rivers on a ~5 km grid. Small streams and urban stormwater flooding are not covered; heavy-rain thresholds stand in for them.
* No lightning-strike, hail-size or road-closure feeds are connected.
* Thresholds are general. Regional calibration with a national weather service is recommended before real use.
