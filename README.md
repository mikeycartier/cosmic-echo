# Cosmic Echo

Explore how the infrared sky changes across real observations from NASA's
SPHEREx mission. Search by sky coordinates or choose a challenge target, then
step through a short timeline of FITS cutouts in an interactive Aladin Lite map.

## Features

- Search by ICRS right ascension and declination, with an adjustable field of view.
- Presets for Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, and R Draconis.
- Query SPHEREx DR1 and Quick Release 3 observations from NASA/IPAC IRSA.
- Browse representative observations by date, detector, and release.
- Play back frames while preserving the map's pan and zoom.
- Share a search using its coordinate and field-of-view URL parameters.

Cosmic Echo is a human-guided exploration tool. It helps people inspect
possible motion or brightness changes; it does not automatically detect or
classify objects.

## Getting started

### Requirements

- Node.js 20.9 or later
- npm

### Install and run

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Project checks

```bash
npm run lint
npm run typecheck
npm run build
```

## How it works

1. `/api/observations` queries IRSA's Simple Image Access service for SPHEREx
   DR1 and QR3 observations near the requested coordinates and parses the
   returned VOTable metadata.
2. `/api/cutout` retrieves an allowed SPHEREx FITS product from IRSA, validates
   its science `IMAGE` HDU, and prepares its local WCS for display.
3. Aladin Lite displays each cutout as the map's image layer.
4. The timeline sorts results by observation time and samples up to five
   representative weekly frames. With "All arrays" selected, it uses the
   detector with the most coverage; an individual detector search stays on that
   detector.

Playback preloads upcoming frames two at a time, waits one second after a frame
loads before advancing, and skips frames that fail. The currently displayed
image remains visible while another frame loads. The archive can return partial
results or time out; this is reported rather than treated as a successful search.

## Data and tools

- **SPHEREx observations:** [NASA/IPAC Infrared Science Archive (IRSA)](https://irsa.ipac.caltech.edu/Missions/spherex.html)
- **Sky map:** [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) by the Centre de Données astronomiques de Strasbourg (CDS)
- **Application:** Next.js, React, TypeScript, and `fast-xml-parser`

## Known limitations

- The timeline shows up to five representative frames, not every archive result.
- Detector arrays (D1–D6) are not the mission's 102 spectral bands. This version
  does not include a band selector, on-the-fly spectra, image subtraction or
  co-addition, Gaia/WISE overlays, or contamination flags.
- Coverage and response times depend on the live IRSA archive. Try another
  detector or field size if a query has no usable images.

## AI-use disclosure

AI assistance was used for code implementation, debugging, and documentation.
The project team reviewed and tested the resulting changes. The displayed
astronomical observations are retrieved from IRSA; they are not AI-generated.

## Deployment

The app is a standard Next.js project and can be deployed to a Next.js hosting
provider such as Vercel. No application secrets or environment variables are
required.

## License

This project is available under the MIT License. See [LICENSE](./LICENSE).
