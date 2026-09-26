# Microgrid Orchestrator

**One interface for every energy asset — including the buildings.**

Interactive demo for **Granite Fellows · ST Engineering Challenge Statement 2**.
Live at https://angyuqian.github.io/granite-fellows/

Solar, storage, a genset, the utility tie, buildings and an EV fleet publish themselves
to one dispatcher as the same object. Shown on a 3D model of the NUS Kent Ridge campus
with the campus weather-station network. All dispatch results are pre-computed; the page
is static and makes no external requests.

## What is real, and what isn't

- **Real:** campus geometry (OpenStreetMap); 2025 weather from the NUS campus station
  network; the NUS rooftop-PV programme totals; documented public EV chargers.
- **Documented / assumed:** 11 PV roofs are named in NUS sources; the rest are assumed
  sites sized to match the published 9.2 MWp.
- **Synthetic:** building loads, precinct boundaries, the managed EV fleet.
- **Hypothetical:** the precinct batteries, gensets and islandable grid ties. NUS is
  grid-connected and is not a microgrid.

## Credits

- Building footprints, roads and land use © OpenStreetMap contributors, ODbL.
- Weather: NUS campus weather station network, 2025.
- three.js © three.js authors, MIT (licence header in `vendor/three.module.js`).
- IBM Plex Sans and Kode Mono, SIL Open Font License 1.1 (`fonts/OFL-*.txt`).
- Granite Asia wordmark © Granite Asia.
