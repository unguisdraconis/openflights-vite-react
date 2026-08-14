# OpenFlights 3D Network

A Vite + React dashboard using Three.js for the interactive globe and D3 for data processing, force simulation, and spatial lookup.

## Start the app

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

The OpenFlights assets are served from:

- `public/airports.dat`
- `public/routes.dat`

The app fetches them as `/airports.dat` and `/routes.dat`.
