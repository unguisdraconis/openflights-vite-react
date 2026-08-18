---
name: webgl-globe-network
description: >-
  Build high-performance interactive 3D globe and network-graph
  visualizations with React, Three.js (WebGL), and D3. Use when the task
  involves rendering thousands of geographic points or graph nodes on a
  canvas, drawing great-circle arc "flight paths" on a globe, a
  force-directed topology view, hover/click picking over many points,
  or wiring an imperative Three.js scene into a React component without
  fighting the render loop. Triggers: "globe", "3D map", "flight network",
  "network graph in three.js", "point cloud", "great-circle arcs",
  "force-directed layout", "instanced/points rendering", "canvas
  visualization performance", "d3 quadtree picking", "webgl in react".
---

# WebGL Globe & Network Visualization

A field guide for building an interactive 3D globe / force-directed network
on a WebGL canvas driven by React, Three.js, and D3. It encodes the specific
patterns that keep such an app fast, accessible, and maintainable. Follow the
architecture below rather than reinventing it — most of these choices exist to
avoid a specific performance or correctness trap.

## Core architectural rule: React owns state, Three.js owns the frame

Keep the 60fps render loop entirely outside React's reconciliation. React
manages UI state (filters, selection, search, tooltips) and passes it *down*
into the scene; it must never re-render on animation ticks.

- Build the whole Three.js scene **once** in a single `useEffect` keyed on the
  parsed `data`, and tear it down completely in that effect's cleanup. The
  WebGL context is expensive — do not rebuild it when options or selection
  change.
- Expose an imperative handle from the effect via a ref (e.g.
  `apiRef.current = { update, focusNode, resetCamera }`). Secondary effects
  keyed on `[options, selected, ...]` call `apiRef.current.update(...)` to push
  new state into the scene. This is the bridge between declarative React and
  imperative Three.js.
- The `requestAnimationFrame` loop only reads mutable closure variables and
  calls `controls.update()` + `renderer.render()`. It never touches React
  state setters.
- Read the latest selection inside event handlers through a
  `selectedRef.current = selected` mirror ref, so listeners registered once at
  setup always see current state without re-registering.

## Data pipeline

Parse raw CSV (OpenFlights `.dat` is headerless CSV) with `d3.csvParseRows`.
Build the graph in a pure function that returns `{ nodes, links, countries }`:

- Index entities two ways (numeric id **and** code) so cross-references resolve
  in O(1) regardless of which identifier a row uses.
- Deduplicate edges into undirected links keyed by a **sorted** pair of ids;
  accumulate a `weight` and any per-edge sets (carriers, etc.) on first
  creation.
- Drop unusable rows early (missing coords, self-loops, unresolved endpoints).
- Compute `degree` from the deduplicated neighbor sets, not the raw edge list.
- **Exclude orphan nodes** (zero links) from the node array so the graph only
  contains connected entities.
- Score links (`weight*20 + sqrt(srcDeg*tgtDeg)`) and sort descending. A
  density slider can then take a **prefix** of the sorted array to always keep
  the most significant edges rather than a random subset.

Run parsing off the initial paint (wrap in `setTimeout(..., 30)` or a worker)
and show a loader; parsing a large network blocks the main thread.

## Layout math

**Globe positions.** Convert lat/lon to a unit-sphere Vector3:
```
phi   = (90 - lat) * PI/180
theta = (lon + 180) * PI/180
v = (-sin(phi)cos(theta), cos(phi), sin(phi)sin(theta)) * radius
```

**Great-circle arcs.** Draw flight paths with spherical interpolation (slerp)
between the two endpoint vectors, lifting the midpoint outward by a
sine-shaped altitude (`1.012 + sin(PI*t) * altitude`). Scale segment count
with arc length (e.g. 7 segments normally, 11 for arcs > ~1.25 rad) so long
arcs stay smooth without over-tessellating short ones.

**Force-directed topology.** Use `d3-forceSimulation` with link + many-body +
centering + weak x/y forces, but **do not** run it on d3's timer. Call
`.stop()` and drive `simulation.tick()` manually inside `requestIdleCallback`
batches, ticking as many times as fit in each idle slice up to a cap (~85).
This keeps a CPU-heavy simulation from blocking paint or competing with the
render loop. On convergence, rescale node extents into a fixed viewport box
with `d3.scaleLinear`, and add a small z-offset from `log1p(degree)` so hubs
sit forward.

## The scene: batch everything into as few draw calls as possible

Draw-call count, not GPU fill rate, is the usual bottleneck at these node
counts. **Never create one mesh per node.**

- **All nodes = one `THREE.Points`** with a single `BufferGeometry` and custom
  shaders. Store per-node `position`, `color`, `aSize`, `aAlpha` as attribute
  buffers. On filter/selection change, mutate the typed arrays in place and set
  `attribute.needsUpdate = true` — a few typed-array writes, not object churn.
  - Vertex shader: `gl_PointSize = clamp(aSize * (260.0/-mv.z), 2.0, 18.0)` for
    free distance attenuation and min/max clamp.
  - Fragment shader: soft circular dot via `smoothstep(.5,.25,d)` on
    `gl_PointCoord`, `discard` near-transparent fragments. No texture needed.
  - `transparent: true, depthWrite: false, vertexColors: true`.
- **All edges = one `THREE.LineSegments`**, rebuilt into fresh position/color
  buffers when filters/selection change. Pre-count total segments, allocate
  `Float32Array(segments*2*3)` once, fill it, dispose the old geometry/material
  before replacing. Use `AdditiveBlending` so overlapping routes glow.
- Effects that don't need geometry (atmosphere rim light, fog) are cheap
  `ShaderMaterial` shells or built-ins, not post-processing passes.

### Hybrid "hero" mesh (optional emphasis)

A single node (the selection, or the top-degree hub as a default) can render
as a real lit `SphereGeometry` + `MeshStandardMaterial` for premium shading and
correct depth occlusion — it's **one** extra draw call, so cost is negligible.
Hide that node's point sprite (set its alpha to 0) but keep its index in the
pickable set so hover/click still resolve to it. Because a mesh has no
`gl_PointSize` trick, convert the intended pixel size to a world radius by
inverting the perspective projection at a reference camera distance, and
recompute on resize. Do **not** promote many nodes to meshes — the whole point
of the Points batch is to avoid thousands of draw calls.

## Interaction: quadtree picking, not raycasting

Raycasting against thousands of points every pointer move is wasteful. Instead:

- Project visible node world-positions to 2D screen space and index them in a
  `d3.quadtree`. Cache it; only rebuild when a `projectionDirty` flag is set
  (camera `change` event, resize, filter/selection change) — not every frame.
- Throttle `pointermove` to one `requestAnimationFrame` in flight at a time.
- Look up the nearest node with `quadtree.find(x, y, radius)`.
- Distinguish click from drag by squared pointer delta before treating a
  pointerup as a selection.

Camera focus animations (fly-to) lerp `camera.position` and `controls.target`
with a cubic ease, and collapse to instant when reduced motion is requested.

## Performance patterns (apply throughout)

- Clamp `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75))` up front.
- **Adaptive quality:** sample recent frame deltas in the animate loop; if the
  rolling mean exceeds ~24ms (sub-40fps) while pixel ratio is still >1, drop it
  to 1 and resize. A runtime fallback beats a fixed low cap.
- Use a `ResizeObserver` on the host element, not window resize, and pass
  `renderer.setSize(w, h, false)` (don't touch CSS size).
- Memoize expensive derived React values (`useMemo` for search results,
  filtered counts) and stabilize effect deps with `useCallback`.
- **Dispose everything on unmount:** cancel the rAF and any idle callback,
  disconnect the ResizeObserver, remove all DOM listeners, `scene.traverse`
  disposing every geometry/material, then `renderer.dispose()` and remove the
  canvas. WebGL buffers are not garbage-collected like JS objects — leaks here
  crash long sessions.

## Accessibility patterns (apply throughout)

- Skip-link to jump past the header into the controls.
- Give the canvas `role="img"` + a descriptive `aria-label` summarizing
  node/edge counts, and `tabindex=0` with a visible `:focus-visible` outline.
- A visually-hidden `aria-live="polite"` region announces the
  selected/hovered entity (name, location, degree) — the visual tooltip alone
  is invisible to screen readers.
- Keyboard shortcuts (`/` focus search, `Esc` clear, `R` reset camera) must
  guard against firing while an `<input>` is focused.
- Toggles use `aria-pressed` / `aria-expanded`; listboxes use
  `role="listbox"`/`role="option"`; every slider/select has a label.
- Respect `prefers-reduced-motion` at **both** layers: a JS check (via
  `matchMedia`, read once) to disable camera-fly easing and auto-rotate, and a
  CSS block flattening transitions/animations.
- Use a colorblind-safe palette (Okabe–Ito: sky `#56b4e9`, orange `#e69f00`,
  green `#009e73`, blue `#0072b2`, purple `#cc79a7`) consistently across
  rendered marks *and* the legend.

## Stack & authoring notes

- Vite + `@vitejs/plugin-react`. Pin `vite` to a range the React plugin's
  peer-deps actually list (a too-new `vite` major triggers `ERESOLVE`).
- Write real **JSX**, not htm tagged templates — it unlocks `jsx-a11y` and
  `react-hooks/exhaustive-deps` lint, better stack traces, and IDE tooling,
  with no runtime cost since both compile to the same `createElement`/`jsx`
  calls.
- Import Three.js addons from `three/addons/...` (e.g. `OrbitControls`).
- Serve large data assets from `public/` and `fetch` them at runtime; provide
  a drag-and-drop file fallback for when local `fetch` is blocked.

## Common traps

- Rebuilding the scene on every option change (keep the setup effect keyed on
  `data` only).
- One mesh per node (batch into Points/LineSegments/InstancedMesh).
- Raycasting for hover at scale (project + quadtree instead).
- Re-rendering React on animation frames (drive the loop with refs).
- Forgetting to dispose GPU resources (leaks accumulate per remount).
- Using `depthWrite: true` on additive-blended transparent lines (causes
  ordering artifacts — keep it false for the glow layers).
