# OpenFlights 3D Network

A Vite + React dashboard using Three.js for the interactive globe and D3 for data processing, force simulation, and spatial lookup.

Data loading. On mount, App fetches airports.dat and routes.dat (with a drag-and-drop LoadScreen fallback for when fetch can't reach local files). parseData parses both as CSV, indexes airports by numeric ID and IATA/ICAO code, and folds routes into deduplicated undirected links with weight/carrier/international counts. Airports with zero links are dropped, degree is computed from the surviving link set, and links are scored (weight*20 + sqrt(degree*degree)) and sorted so the density slider can just take a prefix to keep the most significant routes.

Layout math. latLonVector projects lat/lon onto a unit sphere for the globe view. For the topology view, useGraphLayout runs a d3-force simulation manually in requestIdleCallback batches (up to 85 ticks) so it never blocks the main thread, then rescales the converged x/y extents into a fixed viewport box, with a small z-offset from log1p(degree) for hub prominence. slerpArc spherically interpolates between two globe points with a sine-shaped altitude bump, producing the arced flight paths.

The Three.js scene (GlobeScene) is built once per dataset in a single useEffect, entirely outside React's render cycle after that. All airports are one THREE.Points object with custom vertex/fragment shaders (distance-attenuated point size, soft circular sprite) and per-node attribute buffers (aSize, aAlpha, color) that get mutated in place rather than recreated. All routes are one LineSegments object rebuilt into fresh buffers whenever filters/selection change. A shader-based atmosphere rim light, a starfield, and OrbitControls round out the scene.

Interaction. Hover/click picking skips raycasting entirely — node positions are projected to screen space and indexed in a d3.quadtree, rebuilt only when a projectionDirty flag is set (camera moved, resized, filtered) rather than every frame, with pointer-move throttled to one requestAnimationFrame at a time. Selecting an airport flies the camera toward it (cubic ease-out lerp) and drives the tooltip/sidebar via React state.

Performance and accessibility run through all of the above rather than being separate: the render loop samples frame times and drops pixel ratio if the rolling average goes sub-40fps; prefers-reduced-motion disables camera-fly easing and auto-rotate at both the JS and CSS level; single shared buffer geometries avoid per-node object churn; everything gets disposed (geometries, materials, listeners, rAF/idle callbacks) on unmount. On the accessibility side: a skip-link, role="img"/descriptive aria-label on the canvas, an aria-live region announcing the selected node for screen readers, keyboard shortcuts (/, Esc, R) that respect input focus, aria-pressed/aria-expanded on toggles, labelled form controls, and the colorblind-safe Okabe–Ito palette used consistently for nodes, links, and the legend.

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
