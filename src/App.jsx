import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const COLORS = {
  sky: new THREE.Color("#56b4e9"),
  blue: new THREE.Color("#0072b2"),
  green: new THREE.Color("#009e73"),
  orange: new THREE.Color("#e69f00"),
  red: new THREE.Color("#d55e00"),
  purple: new THREE.Color("#cc79a7"),
  dim: new THREE.Color("#364152"),
  white: new THREE.Color("#f3f4f6"),
};
const fmt = new Intl.NumberFormat("en-US");
// Radius of the globe mesh. Airports sit just above it (see latLonVector
// calls), and hover picking uses it to cull the occluded far hemisphere.
const GLOBE_RADIUS = 1;
// Airports that fail the country/degree filters stay on screen as geographic
// context rather than vanishing. This has to clear the point shader's
// `a < .015` discard by enough to survive the sprite's edge falloff —
// too low and whole regions of the map read as empty, which is what a
// hemisphere of low-degree airports looks like under a hub-degree filter.
const DIMMED_ALPHA = 0.25;
const reducedMotion =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
const idle =
  typeof window !== "undefined" && window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : (fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 0);
const cancelIdle =
  typeof window !== "undefined" && window.cancelIdleCallback
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout;

function validCode(v) {
  return v && v !== "\\N";
}
function parseData(airportsText, routesText) {
  const rawAirports = d3.csvParseRows(airportsText);
  const byNumericId = new Map(),
    byCode = new Map();
  for (const r of rawAirports) {
    if (r.length < 8) continue;
    const lat = +r[6],
      lon = +r[7];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const airport = {
      numericId: r[0],
      name: r[1],
      city: r[2],
      country: r[3],
      iata: validCode(r[4]) ? r[4] : null,
      icao: validCode(r[5]) ? r[5] : null,
      lat,
      lon,
      degree: 0,
      routeCount: 0,
      international: 0,
      domestic: 0,
      neighbors: new Set(),
      index: -1,
      topology: null,
    };
    airport.id = airport.iata || airport.icao || `ID-${airport.numericId}`;
    byNumericId.set(airport.numericId, airport);
    if (airport.iata) byCode.set(airport.iata, airport);
    if (airport.icao) byCode.set(airport.icao, airport);
  }
  const linkMap = new Map();
  let rawRouteCount = 0,
    skipped = 0;
  for (const r of d3.csvParseRows(routesText)) {
    if (r.length < 6) continue;
    const source =
      (validCode(r[3]) && byNumericId.get(r[3])) ||
      (validCode(r[2]) && byCode.get(r[2]));
    const target =
      (validCode(r[5]) && byNumericId.get(r[5])) ||
      (validCode(r[4]) && byCode.get(r[4]));
    if (!source || !target || source === target) {
      skipped++;
      continue;
    }
    rawRouteCount++;
    const ordered =
      source.numericId < target.numericId ? [source, target] : [target, source];
    const key = `${ordered[0].numericId}|${ordered[1].numericId}`;
    let link = linkMap.get(key);
    if (!link) {
      link = {
        source: ordered[0],
        target: ordered[1],
        weight: 0,
        carriers: new Set(),
        international: ordered[0].country !== ordered[1].country,
      };
      linkMap.set(key, link);
    }
    link.weight++;
    if (r[0]) link.carriers.add(r[0]);
  }
  const links = [...linkMap.values()];
  const used = new Set();
  for (const l of links) {
    used.add(l.source);
    used.add(l.target);
    l.source.neighbors.add(l.target.numericId);
    l.target.neighbors.add(l.source.numericId);
    l.source.routeCount += l.weight;
    l.target.routeCount += l.weight;
    if (l.international) {
      l.source.international += l.weight;
      l.target.international += l.weight;
    } else {
      l.source.domestic += l.weight;
      l.target.domestic += l.weight;
    }
  }
  const nodes = [...used];
  nodes.forEach((n, i) => {
    n.index = i;
    n.degree = n.neighbors.size;
  });
  links.forEach((l, i) => {
    l.index = i;
    l.score = l.weight * 20 + Math.sqrt(l.source.degree * l.target.degree);
  });
  links.sort((a, b) => b.score - a.score);
  const countries = d3
    .rollups(
      nodes,
      (v) => v.length,
      (d) => d.country,
    )
    .sort((a, b) => d3.descending(a[1], b[1]));
  return { nodes, links, countries, rawRouteCount, skipped };
}

function latLonVector(lat, lon, radius = 1) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  ).multiplyScalar(radius);
}
function slerpArc(a, b, t, altitude) {
  const ua = a.clone().normalize(),
    ub = b.clone().normalize();
  const omega = Math.acos(THREE.MathUtils.clamp(ua.dot(ub), -1, 1));
  let p;
  if (omega < 0.0001) p = ua.clone().lerp(ub, t).normalize();
  else {
    const so = Math.sin(omega);
    p = ua
      .multiplyScalar(Math.sin((1 - t) * omega) / so)
      .add(ub.multiplyScalar(Math.sin(t * omega) / so));
  }
  return p.multiplyScalar(1.012 + Math.sin(Math.PI * t) * altitude);
}

// Shared color/size rule for a node, used both by the bulk point-sprite
// buffer and by the single "hero" mesh so the two stay visually consistent.
function nodeStyle(n, selectedNode) {
  const isSelected = n === selectedNode;
  const connected = !!(selectedNode && selectedNode.neighbors.has(n.numericId));
  const color = isSelected
    ? COLORS.orange
    : connected
      ? COLORS.purple
      : n.degree > 45
        ? COLORS.orange
        : n.degree > 15
          ? COLORS.sky
          : COLORS.white;
  const pixelSize =
    (4.2 + Math.min(8, Math.sqrt(n.degree) * 0.72)) *
    (isSelected ? 1.65 : connected ? 1.2 : 1);
  return { color, pixelSize, isSelected, connected };
}

// The point-sprite shader gets a node's on-screen size "for free" by scaling
// gl_PointSize with 1/-viewZ. A real mesh has no such trick — its apparent
// size depends on world-space radius and camera distance — so this inverts
// the perspective-projection math to pick a radius that reads at roughly the
// same pixel size the sprite would have used, at a given reference distance.
function pixelSizeToWorldRadius(pixelSize, camera, viewportHeightPx, distance) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const worldHeightAtDist = 2 * Math.tan(vFov / 2) * distance;
  const pxPerWorldUnit = viewportHeightPx / worldHeightAtDist;
  return pixelSize / (2 * pxPerWorldUnit);
}

function useGraphLayout(data, onReady) {
  useEffect(() => {
    if (!data) return;
    let cancelled = false,
      idleId;
    const nodes = data.nodes.map((n) => ({
      id: n.numericId,
      x: n.lon * 2.1,
      y: -n.lat * 2.1,
      ref: n,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links.map((l) => ({
      source: l.source.numericId,
      target: l.target.numericId,
      weight: l.weight,
    }));
    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance((l) => 18 + 22 / Math.sqrt(l.weight))
          .strength(0.045),
      )
      .force("charge", d3.forceManyBody().strength(-17).distanceMax(190))
      .force("center", d3.forceCenter(0, 0))
      .force("x", d3.forceX(0).strength(0.012))
      .force("y", d3.forceY(0).strength(0.012))
      .stop();
    let ticks = 0;
    const work = (deadline) => {
      while (!cancelled && ticks < 85 && deadline.timeRemaining() > 1) {
        simulation.tick();
        ticks++;
      }
      if (cancelled) return;
      if (ticks < 85) idleId = idle(work);
      else {
        const ex = d3.extent(nodes, (d) => d.x),
          ey = d3.extent(nodes, (d) => d.y);
        const sx = d3.scaleLinear().domain(ex).range([-1.5, 1.5]);
        const sy = d3.scaleLinear().domain(ey).range([1.1, -1.1]);
        for (const n of nodes)
          n.ref.topology = new THREE.Vector3(
            sx(n.x),
            sy(n.y),
            0.08 * Math.log1p(n.ref.degree),
          );
        onReady();
      }
    };
    idleId = idle(work);
    return () => {
      cancelled = true;
      cancelIdle(idleId);
      simulation.stop();
    };
  }, [data, onReady]);
}

function Stat({ value, label }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function LinkedInIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.39v-1.2h-2.5v8.37h2.5v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.5M6.88 8.56a1.68 1.68 0 1 1 0-3.36 1.68 1.68 0 0 1 0 3.36m-1.2 10.12h2.5V9.9h-2.5v8.78z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.868-.013-1.703-2.782.603-3.369-1.343-3.369-1.343-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.891 1.529 2.341 1.544 2.914 1.182.092-.92.349-1.544.636-1.9-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.139 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  );
}

function LoadScreen({ onLoaded, loading, error }) {
  const inputRef = useRef();
  const processFiles = async (files) => {
    const list = [...files];
    const airports = list.find((f) => /airport/i.test(f.name));
    const routes = list.find((f) => /route/i.test(f.name));
    if (!airports || !routes)
      return onLoaded(null, null, "Select both airports.dat and routes.dat.");
    onLoaded(await airports.text(), await routes.text());
  };
  return (
    <div
      className="load-screen"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        processFiles(e.dataTransfer.files);
      }}
    >
      <div className="load-card">
        <div className="eyebrow">OpenFlights data loader</div>
        <h2>Load the global aviation network</h2>
        <p>
          The dashboard first looks for <b>airports.dat</b> and{" "}
          <b>routes.dat</b> beside this HTML file. If your browser blocks local
          file requests, select or drop both supplied files here.
        </p>
        <div className="drop-zone">
          <div>
            <button
              className="primary-btn"
              onClick={() => inputRef.current.click()}
              disabled={loading}
            >
              {loading ? "Building network…" : "Choose both data files"}
            </button>
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              multiple
              accept=".txt,.dat,text/plain"
              onChange={(e) => processFiles(e.target.files)}
            />
            <div className="file-note">
              You can also drag and drop both files onto this panel.
            </div>
          </div>
        </div>
        {loading && (
          <div className="loading-bar" aria-label="Loading data"></div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function Tooltip({ node, pinned, point }) {
  if (!node || !point) return null;
  const tooltipWidth = 295;
  const offsetX = 18;
  const rightPosition = point.x + offsetX;
  const fitsRight = rightPosition + tooltipWidth <= innerWidth;
  const left = fitsRight
    ? rightPosition
    : Math.max(0, point.x - tooltipWidth - offsetX);
  const top = Math.max(12, Math.min(point.y - 20, innerHeight - 190));
  return (
    <div
      className={`tooltip ${pinned ? "pinned" : ""}`}
      style={{ left, top }}
      role={pinned ? "dialog" : "status"}
      aria-label={`${node.name} airport details`}
    >
      <div className="tooltip-top">
        <div className="airport-code">{node.iata || node.icao || "—"}</div>
        <div>
          <h2>{node.name}</h2>
          <div className="tooltip-sub">
            {node.city}, {node.country}
          </div>
        </div>
      </div>
      <div className="tooltip-grid">
        <div className="tooltip-metric">
          <b>{fmt.format(node.degree)}</b>
          <span>Connections</span>
        </div>
        <div className="tooltip-metric">
          <b>{fmt.format(node.routeCount)}</b>
          <span>Route records</span>
        </div>
        <div className="tooltip-metric">
          <b>
            {node.lat.toFixed(1)}°, {node.lon.toFixed(1)}°
          </b>
          <span>Coordinates</span>
        </div>
      </div>
      <div className="tooltip-note">
        {pinned
          ? "Pinned — click empty space or press Escape to close."
          : "Click to pin this airport."}
      </div>
    </div>
  );
}

function Sidebar({
  data,
  options,
  setOptions,
  query,
  setQuery,
  selected,
  selectNode,
  clearSelection,
  open,
}) {
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return data.nodes
      .filter((n) =>
        `${n.id} ${n.name} ${n.city} ${n.country}`.toLowerCase().includes(q),
      )
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 8);
  }, [data, query]);
  return (
    <aside
      id="controls"
      className={`sidebar ${open ? "open" : ""}`}
      aria-label="Network controls"
    >
      <section className="section">
        <div className="section-title">
          <span>Find an airport</span>
          <span className="value-pill">{fmt.format(data.nodes.length)}</span>
        </div>
        <div className="search-wrap">
          <input
            id="airport-search"
            className="search"
            value={query}
            onInput={(e) => setQuery(e.target.value)}
            placeholder="Code, city, airport…"
            aria-label="Search airports"
            autoComplete="off"
          />
          <span className="search-icon">⌕</span>
        </div>
        {results.length > 0 && (
          <div className="results" role="listbox">
            {results.map((n) => (
              <button
                key={n.id}
                className="result-btn"
                role="option"
                onClick={() => {
                  selectNode(n);
                  setQuery("");
                }}
              >
                <span className="result-name">{n.name}</span>
                <span className="result-code">{n.iata || n.icao}</span>
              </button>
            ))}
          </div>
        )}
        {selected && (
          <div className="selected-chip">
            <div>
              <strong>{selected.name}</strong>
              <span>
                {selected.city}, {selected.country}
              </span>
            </div>
            <button
              className="clear-btn"
              onClick={clearSelection}
              aria-label="Clear selected airport"
            >
              ×
            </button>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-title">
          <span>View</span>
        </div>
        <div className="segmented" role="group" aria-label="Visualization mode">
          <button
            className={`seg-btn ${options.view === "globe" ? "active" : ""}`}
            aria-pressed={options.view === "globe"}
            onClick={() => setOptions((o) => ({ ...o, view: "globe" }))}
          >
            3D globe
          </button>
          <button
            className={`seg-btn ${options.view === "topology" ? "active" : ""}`}
            aria-pressed={options.view === "topology"}
            onClick={() => setOptions((o) => ({ ...o, view: "topology" }))}
          >
            Topology
          </button>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={options.autoRotate}
            onChange={(e) =>
              setOptions((o) => ({ ...o, autoRotate: e.target.checked }))
            }
          />
          Auto-rotate globe
        </label>
      </section>

      <section className="section">
        <div className="section-title">
          <span>Route filters</span>
          <span className="value-pill">{options.density}%</span>
        </div>
        <div className="control-row">
          <div className="control-label">
            <span>Route density</span>
            <span>{options.density}%</span>
          </div>
          <input
            type="range"
            min="5"
            max="100"
            step="5"
            value={options.density}
            aria-label="Route density: adjust from 5% to 100%"
            onInput={(e) =>
              setOptions((o) => ({ ...o, density: +e.target.value }))
            }
          />
        </div>
        <div className="control-row">
          <div className="control-label">
            <span>Minimum hub degree</span>
            <span>{options.minDegree}</span>
          </div>
          <input
            type="range"
            min="0"
            max="80"
            step="1"
            value={options.minDegree}
            aria-label="Minimum hub degree: adjust from 0 to 80 connections"
            onInput={(e) =>
              setOptions((o) => ({ ...o, minDegree: +e.target.value }))
            }
          />
        </div>
        <div className="control-row">
          <label className="control-label" htmlFor="scope">
            <span>Route scope</span>
          </label>
          <select
            id="scope"
            value={options.scope}
            onChange={(e) =>
              setOptions((o) => ({ ...o, scope: e.target.value }))
            }
          >
            <option value="all">All routes</option>
            <option value="international">International only</option>
            <option value="domestic">Domestic only</option>
          </select>
        </div>
        <div className="control-row">
          <label className="control-label" htmlFor="country">
            <span>Country focus</span>
          </label>
          <select
            id="country"
            value={options.country}
            onChange={(e) =>
              setOptions((o) => ({ ...o, country: e.target.value }))
            }
          >
            <option value="">All countries</option>
            {data.countries.map(([c, n]) => (
              <option key={c} value={c}>
                {c} ({n})
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="section">
        <div className="section-title">
          <span>Legend</span>
        </div>
        <div className="legend">
          <div className="legend-row">
            <span className="swatch" style={{ background: "#56b4e9" }}></span>
            <span>International connection</span>
          </div>
          <div className="legend-row">
            <span className="swatch" style={{ background: "#009e73" }}></span>
            <span>Domestic connection</span>
          </div>
          <div className="legend-row">
            <span className="swatch" style={{ background: "#e69f00" }}></span>
            <span>Selected-airport connection</span>
          </div>
        </div>
      </section>

      <section className="section help">
        Drag to orbit · scroll to zoom · click an airport to pin.
        <br />
        <br />
        <kbd>/</kbd> Search &nbsp; <kbd>Esc</kbd> Clear selection &nbsp;
        <kbd>R</kbd> Reset camera
      </section>

      <footer className="sidebar-footer">
        <div className="social-links">
          <a
            href="https://www.linkedin.com/in/jeremiahjking/"
            className="social-btn"
            target="_blank"
            rel="noreferrer"
            aria-label="LinkedIn"
          >
            <LinkedInIcon />
          </a>
          <a
            href="https://github.com/unguisdraconis"
            className="social-btn"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
          >
            <GitHubIcon />
          </a>
        </div>
        <p className="data-source">© 2026 Jeremiah King</p>
        <p className="data-source">
          Data from{""}
          <a href="https://openflights.org" target="_blank" rel="noreferrer">
            OpenFlights.org
          </a>
        </p>
      </footer>
    </aside>
  );
}

function GlobeScene({
  data,
  options,
  selected,
  onHover,
  onSelect,
  onClear,
  focusRequest,
  topologyVersion,
}) {
  const hostRef = useRef();
  const apiRef = useRef();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !data) return;
    let disposed = false,
      raf = 0,
      lastFrame = performance.now(),
      frameSamples = [],
      pointerFrame = 0;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0b0d12, 0.055);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    camera.position.set(0, 0.3, 3.55);
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute(
      "aria-label",
      `Interactive 3D flight network with ${fmt.format(data.nodes.length)} airports and ${fmt.format(data.links.length)} connections`,
    );
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.enablePan = false;
    controls.minDistance = 1.55;
    controls.maxDistance = 8;
    controls.autoRotateSpeed = 0.32;

    scene.add(new THREE.HemisphereLight(0x9acff2, 0x0a1020, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 2, 4);
    scene.add(sun);

    const globeGroup = new THREE.Group();
    scene.add(globeGroup);
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48),
      new THREE.MeshPhongMaterial({
        color: 0x101a26,
        emissive: 0x07101a,
        specular: 0x29445c,
        shininess: 22,
        // The globe must stay opaque. As a transparent material it joined the
        // transparency queue, where it is blended and ordered against the node
        // sprites instead of being laid down first as a depth-writing occluder
        // — which let it paint over the sprites inside its own silhouette,
        // leaving only the ring where they project past the limb.
        transparent: false,
      }),
    );
    globeGroup.add(globe);
    const grid = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(1.003, 36, 18)),
      new THREE.LineBasicMaterial({
        color: 0x355068,
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
      }),
    );
    globeGroup.add(grid);
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.045, 48, 32),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: `varying vec3 vN; varying vec3 vW; void main(){vN=normalize(normalMatrix*normal); vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`,
        fragmentShader: `varying vec3 vN; varying vec3 vW; void main(){vec3 V=normalize(cameraPosition-vW);float rim=pow(1.0-max(dot(vN,V),0.0),2.4);gl_FragColor=vec4(0.22,0.62,0.92,rim*.26);}`,
      }),
    );
    globeGroup.add(atmosphere);

    const starsGeo = new THREE.BufferGeometry();
    const stars = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const r = 7 + Math.random() * 8,
        u = Math.random() * 2 - 1,
        t = Math.random() * Math.PI * 2,
        q = Math.sqrt(1 - u * u);
      stars[i * 3] = r * q * Math.cos(t);
      stars[i * 3 + 1] = r * u;
      stars[i * 3 + 2] = r * q * Math.sin(t);
    }
    starsGeo.setAttribute("position", new THREE.BufferAttribute(stars, 3));
    const starsObj = new THREE.Points(
      starsGeo,
      new THREE.PointsMaterial({
        color: 0x7d9bb7,
        size: 0.012,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      }),
    );
    scene.add(starsObj);

    const nodePositions = new Float32Array(data.nodes.length * 3);
    const nodeColors = new Float32Array(data.nodes.length * 3);
    const nodeSizes = new Float32Array(data.nodes.length);
    const nodeAlpha = new Float32Array(data.nodes.length);
    data.nodes.forEach((n, i) => {
      n.geo = latLonVector(n.lat, n.lon, 1.014);
      nodePositions.set(n.geo.toArray(), i * 3);
      const c =
        n.degree > 45
          ? COLORS.orange
          : n.degree > 15
            ? COLORS.sky
            : COLORS.white;
      nodeColors.set(c.toArray(), i * 3);
      nodeSizes[i] = 4.2 + Math.min(8, Math.sqrt(n.degree) * 0.72);
      nodeAlpha[i] = 0.88;
    });
    const nodesGeo = new THREE.BufferGeometry();
    nodesGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(nodePositions, 3),
    );
    nodesGeo.setAttribute("color", new THREE.BufferAttribute(nodeColors, 3));
    nodesGeo.setAttribute("aSize", new THREE.BufferAttribute(nodeSizes, 1));
    nodesGeo.setAttribute("aAlpha", new THREE.BufferAttribute(nodeAlpha, 1));
    const nodesMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { uPixelRatio: { value: renderer.getPixelRatio() } },
      vertexShader: `attribute float aSize;attribute float aAlpha;varying vec3 vColor;varying float vAlpha;void main(){vColor=color;vAlpha=aAlpha;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(aSize*(260.0/-mv.z),2.0,18.0);gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `varying vec3 vColor;varying float vAlpha;void main(){float d=length(gl_PointCoord-.5);float a=smoothstep(.5,.25,d)*vAlpha;if(a<.015)discard;gl_FragColor=vec4(vColor,a);}`,
    });
    const nodePoints = new THREE.Points(nodesGeo, nodesMat);
    scene.add(nodePoints);

    // The selected node (or, absent a selection, the highest-degree hub)
    // renders as a real lit sphere instead of a point sprite. It's one
    // extra draw call, so the cost is negligible, but it buys real geometry,
    // lighting off the existing scene lights, and correct depth occlusion
    // for the single node that most deserves the emphasis.
    const topHubNode = data.nodes.reduce(
      (best, n) => (n.degree > best.degree ? n : best),
      data.nodes[0],
    );
    const heroGeo = new THREE.SphereGeometry(1, 24, 16);
    const heroMat = new THREE.MeshStandardMaterial({
      roughness: 0.32,
      metalness: 0.2,
    });
    const heroMesh = new THREE.Mesh(heroGeo, heroMat);
    heroMesh.visible = false;
    scene.add(heroMesh);
    let heroPixelSize = 0,
      heroDistance = 3.55;
    const updateHero = (opts, selectedNode, heroNode) => {
      if (!heroNode) {
        heroMesh.visible = false;
        return;
      }
      const { color, pixelSize } = nodeStyle(heroNode, selectedNode);
      const pos =
        opts.view === "globe"
          ? heroNode.geo
          : heroNode.topology || heroNode.geo;
      heroMesh.position.copy(pos);
      heroMat.color.copy(color);
      heroMat.emissive.copy(color).multiplyScalar(0.32);
      heroPixelSize = pixelSize;
      heroDistance = opts.view === "globe" ? 3.55 : 4.2;
      heroMesh.scale.setScalar(
        pixelSizeToWorldRadius(
          heroPixelSize,
          camera,
          host.clientHeight || 800,
          heroDistance,
        ),
      );
      heroMesh.visible = true;
    };

    let linksObj = null,
      visibleNodeIndices = data.nodes.map((_, i) => i),
      currentView = "globe";
    const makeLinks = (opts, selectedNode) => {
      if (linksObj) {
        scene.remove(linksObj);
        linksObj.geometry.dispose();
        linksObj.material.dispose();
      }
      const maxLinks = Math.ceil((data.links.length * opts.density) / 100);
      const eligible = [];
      for (const l of data.links) {
        if (eligible.length >= maxLinks) break;
        if (opts.scope === "international" && !l.international) continue;
        if (opts.scope === "domestic" && l.international) continue;
        if (
          opts.country &&
          l.source.country !== opts.country &&
          l.target.country !== opts.country
        )
          continue;
        if (
          l.source.degree < opts.minDegree ||
          l.target.degree < opts.minDegree
        )
          continue;
        eligible.push(l);
      }
      let segmentCount = 0;
      for (const l of eligible)
        segmentCount +=
          opts.view === "globe"
            ? l.source.geo.angleTo(l.target.geo) > 1.25
              ? 11
              : 7
            : 1;
      const pos = new Float32Array(segmentCount * 2 * 3),
        col = new Float32Array(segmentCount * 2 * 3);
      let p = 0;
      for (const l of eligible) {
        const selectedLink =
          selectedNode &&
          (l.source === selectedNode || l.target === selectedNode);
        const c = selectedLink
          ? COLORS.orange
          : l.international
            ? COLORS.sky
            : COLORS.green;
        if (opts.view === "globe") {
          const angle = l.source.geo.angleTo(l.target.geo),
            seg = angle > 1.25 ? 11 : 7,
            alt = 0.025 + Math.min(0.34, angle * 0.18);
          let prev = slerpArc(l.source.geo, l.target.geo, 0, alt);
          for (let s = 1; s <= seg; s++) {
            const next = slerpArc(l.source.geo, l.target.geo, s / seg, alt);
            pos.set(prev.toArray(), p);
            col.set(c.toArray(), p);
            p += 3;
            pos.set(next.toArray(), p);
            col.set(c.toArray(), p);
            p += 3;
            prev = next;
          }
        } else {
          const a = l.source.topology || l.source.geo,
            b = l.target.topology || l.target.geo;
          pos.set(a.toArray(), p);
          col.set(c.toArray(), p);
          p += 3;
          pos.set(b.toArray(), p);
          col.set(c.toArray(), p);
          p += 3;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      linksObj = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: opts.view === "globe" ? 0.29 : 0.2,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      linksObj.renderOrder = 1;
      scene.add(linksObj);
    };
    const updateNodes = (opts, selectedNode, heroNode) => {
      currentView = opts.view;
      visibleNodeIndices = [];
      data.nodes.forEach((n, i) => {
        const v = opts.view === "globe" ? n.geo : n.topology || n.geo;
        nodePositions.set(v.toArray(), i * 3);
        const passesCountry = !opts.country || n.country === opts.country;
        const passesDegree = n.degree >= opts.minDegree;
        const passesFilters = passesCountry && passesDegree;
        const { color, pixelSize, isSelected, connected } = nodeStyle(
          n,
          selectedNode,
        );
        let alpha = isSelected
          ? 1
          : passesFilters
            ? 0.9
            : connected
              ? 0.75
              : DIMMED_ALPHA;
        const isHero = n === heroNode;
        if (isHero) alpha = 0; // hero node is drawn as a mesh, not a sprite
        nodeColors.set(color.toArray(), i * 3);
        nodeAlpha[i] = alpha;
        nodeSizes[i] = pixelSize;
        // Dimmed nodes are context, not hover targets, so picking keys off the
        // filters themselves rather than off an alpha threshold — otherwise
        // brightening DIMMED_ALPHA would silently make them pickable. The hero
        // node stays pickable even though its sprite is hidden: it's drawn as a
        // mesh, and its position in the shared buffer is still updated above,
        // so hover/click resolve to the same airport.
        if (isSelected || connected || passesFilters || isHero)
          visibleNodeIndices.push(i);
      });
      nodesGeo.attributes.position.needsUpdate = true;
      nodesGeo.attributes.color.needsUpdate = true;
      nodesGeo.attributes.aAlpha.needsUpdate = true;
      nodesGeo.attributes.aSize.needsUpdate = true;
      globeGroup.visible = opts.view === "globe";
      controls.enablePan = opts.view === "topology";
      controls.minDistance = opts.view === "globe" ? 1.55 : 1.2;
      controls.maxDistance = opts.view === "globe" ? 8 : 10;
    };

    let projected = [],
      quadtree = null,
      projectionDirty = true,
      lastProjection = 0;
    const rebuildQuadtree = () => {
      projected = [];
      const rect = renderer.domElement.getBoundingClientRect(),
        attr = nodesGeo.attributes.position;
      const world = new THREE.Vector3();
      for (const i of visibleNodeIndices) {
        world.set(attr.getX(i), attr.getY(i), attr.getZ(i));
        // In globe view the sphere occludes the far hemisphere, but projecting
        // to screen space doesn't know that: back-side airports land on top of
        // the visible disc and steal the hover/click. Cull them with the
        // horizon-plane test — for a sphere of radius R at the origin, a point
        // is on the camera-facing side iff dot(p, cameraPosition) >= R².
        if (
          currentView === "globe" &&
          world.dot(camera.position) < GLOBE_RADIUS * GLOBE_RADIUS
        )
          continue;
        const v = world.project(camera); // safe to mutate: reset each iteration
        if (v.z < -1 || v.z > 1) continue;
        const x = (v.x * 0.5 + 0.5) * rect.width,
          y = (-v.y * 0.5 + 0.5) * rect.height;
        if (
          x >= -20 &&
          x <= rect.width + 20 &&
          y >= -20 &&
          y <= rect.height + 20
        )
          projected.push({ x, y, i });
      }
      quadtree = d3
        .quadtree()
        .x((d) => d.x)
        .y((d) => d.y)
        .addAll(projected);
      projectionDirty = false;
      lastProjection = performance.now();
    };
    controls.addEventListener("change", () => {
      projectionDirty = true;
    });
    let hoverIndex = null,
      pointerDown = null,
      dragged = false;
    const pointerMove = (e) => {
      if (pointerFrame) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        if (selectedRef.current) return;
        if (projectionDirty || performance.now() - lastProjection > 160)
          rebuildQuadtree();
        const r = renderer.domElement.getBoundingClientRect(),
          x = e.clientX - r.left,
          y = e.clientY - r.top;
        const hit = quadtree?.find(x, y, 17);
        hoverIndex = hit ? hit.i : null;
        renderer.domElement.style.cursor = hit ? "pointer" : "grab";
        onHover(
          hit ? data.nodes[hit.i] : null,
          hit ? { x: e.clientX, y: e.clientY } : null,
        );
      });
    };
    const pointerDownFn = (e) => {
      pointerDown = { x: e.clientX, y: e.clientY };
      dragged = false;
    };
    const pointerUpFn = (e) => {
      if (!pointerDown) return;
      const dx = e.clientX - pointerDown.x,
        dy = e.clientY - pointerDown.y;
      dragged = dx * dx + dy * dy > 36;
      pointerDown = null;
      if (dragged) return;
      if (projectionDirty) rebuildQuadtree();
      const r = renderer.domElement.getBoundingClientRect(),
        hit = quadtree?.find(e.clientX - r.left, e.clientY - r.top, 18);
      if (hit) onSelect(data.nodes[hit.i], { x: e.clientX, y: e.clientY });
      else onClear();
    };
    renderer.domElement.addEventListener("pointermove", pointerMove, {
      passive: true,
    });
    renderer.domElement.addEventListener("pointerdown", pointerDownFn);
    renderer.domElement.addEventListener("pointerup", pointerUpFn);
    renderer.domElement.addEventListener("pointerleave", () => {
      if (pointerFrame) {
        cancelAnimationFrame(pointerFrame);
        pointerFrame = 0;
      }
      hoverIndex = null;
      if (!selectedRef.current) onHover(null, null);
    });

    const resetCamera = (view = currentView) => {
      controls.target.set(0, 0, 0);
      camera.position.set(0, 0.3, view === "globe" ? 3.55 : 4.2);
      controls.update();
      projectionDirty = true;
    };
    const focusNode = (node) => {
      const v = (
        currentView === "globe" ? node.geo : node.topology || node.geo
      ).clone();
      if (currentView === "globe") {
        const end = v.clone().normalize().multiplyScalar(2.35),
          start = camera.position.clone(),
          targetStart = controls.target.clone(),
          t0 = performance.now(),
          dur = reducedMotion ? 1 : 650;
        const fly = (now) => {
          const t = Math.min(1, (now - t0) / dur),
            q = 1 - Math.pow(1 - t, 3);
          camera.position.lerpVectors(start, end, q);
          controls.target.lerpVectors(
            targetStart,
            v.clone().multiplyScalar(0.18),
            q,
          );
          controls.update();
          projectionDirty = true;
          if (t < 1) requestAnimationFrame(fly);
        };
        requestAnimationFrame(fly);
      } else {
        controls.target.copy(v);
        camera.position.set(v.x, v.y, v.z + 2.4);
        controls.update();
        projectionDirty = true;
      }
    };
    const update = (opts, selectedNode) => {
      controls.autoRotate =
        opts.autoRotate && !reducedMotion && opts.view === "globe";
      const heroNode = selectedNode || topHubNode;
      updateNodes(opts, selectedNode, heroNode);
      updateHero(opts, selectedNode, heroNode);
      makeLinks(opts, selectedNode);
      projectionDirty = true;
    };
    apiRef.current = { update, focusNode, resetCamera };
    update(options, selected);

    const resize = () => {
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      if (heroMesh.visible)
        heroMesh.scale.setScalar(
          pixelSizeToWorldRadius(heroPixelSize, camera, h, heroDistance),
        );
      projectionDirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const animate = (now) => {
      if (disposed) return;
      const dt = now - lastFrame;
      lastFrame = now;
      frameSamples.push(dt);
      if (frameSamples.length > 90) frameSamples.shift();
      if (
        frameSamples.length === 90 &&
        renderer.getPixelRatio() > 1 &&
        d3.mean(frameSamples) > 24
      ) {
        renderer.setPixelRatio(1);
        nodesMat.uniforms.uPixelRatio.value = 1;
        resize();
        frameSamples = [];
      }
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    const key = (e) => {
      if (
        e.key.toLowerCase() === "r" &&
        document.activeElement?.tagName !== "INPUT"
      )
        resetCamera();
    };
    window.addEventListener("keydown", key);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (pointerFrame) cancelAnimationFrame(pointerFrame);
      ro.disconnect();
      window.removeEventListener("keydown", key);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerdown", pointerDownFn);
      renderer.domElement.removeEventListener("pointerup", pointerUpFn);
      controls.dispose();
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
      apiRef.current = null;
    };
  }, [data]);

  useEffect(() => {
    apiRef.current?.update(options, selected);
  }, [options, selected, topologyVersion]);
  useEffect(() => {
    if (focusRequest?.node) apiRef.current?.focusNode(focusRequest.node);
  }, [focusRequest]);
  return <div ref={hostRef} className="canvas-host"></div>;
}

function App() {
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [options, setOptions] = useState({
    view: "globe",
    density: 55,
    minDegree: 0,
    scope: "all",
    country: "",
    autoRotate: false,
  });
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(null),
    [hover, setHover] = useState(null),
    [tipPoint, setTipPoint] = useState(null),
    [focusRequest, setFocusRequest] = useState(null),
    [menuOpen, setMenuOpen] = useState(false),
    [topologyVersion, setTopologyVersion] = useState(0);
  const graphReady = useCallback(() => setTopologyVersion((v) => v + 1), []);
  useGraphLayout(data, graphReady);
  const load = useCallback((airportsText, routesText, customError) => {
    if (customError) {
      setError(customError);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setTimeout(() => {
      try {
        const parsed = parseData(airportsText, routesText);
        if (!parsed.nodes.length || !parsed.links.length)
          throw new Error("No usable airport-route pairs were found.");
        setData(parsed);
      } catch (e) {
        setError(`Could not parse the files: ${e.message}`);
      } finally {
        setLoading(false);
      }
    }, 30);
  }, []);
  useEffect(() => {
    Promise.all([
      fetch("./airports.dat").then((r) => {
        if (!r.ok) throw Error();
        return r.text();
      }),
      fetch("./routes.dat").then((r) => {
        if (!r.ok) throw Error();
        return r.text();
      }),
    ])
      .then(([a, r]) => load(a, r))
      .catch(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    const key = (e) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        document.getElementById("airport-search")?.focus();
      }
      if (e.key === "Escape") {
        setSelected(null);
        setHover(null);
        setTipPoint(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const selectNode = (node, point) => {
    setSelected(node);
    setHover(null);
    setTipPoint(point || { x: innerWidth * 0.56, y: innerHeight * 0.3 });
    setFocusRequest({ node, id: performance.now() });
    setMenuOpen(false);
  };
  const clearSelection = () => {
    setSelected(null);
    setHover(null);
    setTipPoint(null);
  };
  const tooltipNode = selected || hover;
  const filteredCount = useMemo(
    () =>
      data
        ? data.links.filter(
            (l) =>
              (options.scope === "all" ||
                (options.scope === "international") === l.international) &&
              (!options.country ||
                l.source.country === options.country ||
                l.target.country === options.country) &&
              l.source.degree >= options.minDegree &&
              l.target.degree >= options.minDegree,
          ).length
        : 0,
    [data, options.scope, options.country, options.minDegree],
  );
  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-btn mobile-menu-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Toggle controls"
          aria-expanded={menuOpen}
        >
          ☰
        </button>
        <div className="brand">
          <div className="eyebrow">Global aviation intelligence</div>
          <h1>OpenFlights Network</h1>
        </div>
        {data && (
          <div className="stats" aria-label="Network summary">
            <Stat value={fmt.format(data.nodes.length)} label="Airports" />
            <Stat value={fmt.format(data.links.length)} label="Connections" />
            <Stat value={fmt.format(filteredCount)} label="Visible pool" />
            <Stat value={fmt.format(data.countries.length)} label="Countries" />
          </div>
        )}
        <div className="top-actions">
          <button
            className="icon-btn desktop-only"
            onClick={() =>
              setOptions((o) => ({ ...o, autoRotate: !o.autoRotate }))
            }
            aria-label="Toggle automatic rotation"
            aria-pressed={options.autoRotate}
          >
            ◌
          </button>
        </div>
      </header>
      <main className="main">
        {data && (
          <Sidebar
            data={data}
            options={options}
            setOptions={setOptions}
            query={query}
            setQuery={setQuery}
            selected={selected}
            selectNode={selectNode}
            clearSelection={clearSelection}
            open={menuOpen}
          />
        )}
        <section className="stage" aria-label="3D flight visualization">
          {data && (
            <GlobeScene
              data={data}
              options={options}
              selected={selected}
              topologyVersion={topologyVersion}
              focusRequest={focusRequest}
              onHover={(n, p) => {
                setHover(n);
                setTipPoint(p);
              }}
              onSelect={selectNode}
              onClear={clearSelection}
            />
          )}
          {data && (
            <div className="stage-badge">
              <span className="dot"></span>
              <span>
                {options.view === "globe"
                  ? "GEOGRAPHIC GLOBE"
                  : "FORCE-DIRECTED TOPOLOGY"}{" "}
                · {options.density}% ROUTES
              </span>
            </div>
          )}
          <Tooltip node={tooltipNode} pinned={!!selected} point={tipPoint} />
          {!data && (
            <LoadScreen onLoaded={load} loading={loading} error={error} />
          )}
          <div className="sr-only" aria-live="polite">
            {tooltipNode
              ? `${tooltipNode.name}, ${tooltipNode.city}, ${tooltipNode.country}. ${tooltipNode.degree} direct connections.`
              : ""}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
