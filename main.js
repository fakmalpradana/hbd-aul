/* ===========================
   Elite WebGL Gesture Particles
   Main JavaScript
   =========================== */

// ── GLSL: Main particle shaders ───────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */ `
    uniform float uMorph;
    uniform float uFist;
    uniform float uExplode;
    uniform float uTime;      // for warp-speed black hole animation

    attribute vec3  targetPos;
    attribute vec3  color;
    attribute float size;

    varying vec3  vColor;
    varying float vWarp; // > 0 when in warp-speed mode (used for streak tinting)

    void main() {
        vColor = color;
        vWarp  = 0.0;
        vec3 pos = mix(position, targetPos, uMorph);

        if (uExplode > 0.1) pos += normalize(pos) * uExplode * 5.0;

        if (uFist > 0.1) {
            // ── WARP-SPEED BLACK HOLE ────────────────────────────────────
            // 1. Spiral rotation that accelerates with fist strength
            float spiralSpeed = uFist * 3.5;
            float ang = uTime * spiralSpeed;
            float cs  = cos(ang), sn = sin(ang);
            pos.xz    = mat2(cs, -sn, sn, cs) * pos.xz;

            // 2. Pulsing inward rush — depth-varying so closer particles
            //    rush faster, creating a tunnel / warp-speed sense of depth
            float dist     = length(pos);
            float rushPhase = uTime * 5.0 - dist * 0.8;
            float rushPull  = uFist * (0.80 + 0.20 * sin(rushPhase));
            pos = mix(pos, vec3(0.0), rushPull);

            // 3. Stretch size for "light streak" feel (handled via vWarp)
            vWarp = uFist;
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        // Particles grow larger during warp (streak effect)
        float warpSize = size * (1.0 + uExplode * 0.5 + vWarp * 3.0);
        gl_PointSize = (warpSize * 3.0) / -mvPosition.z;
        gl_Position  = projectionMatrix * mvPosition;
    }
`;

// Star-glow: exponential halo + bright white core; warp-speed tints blue-white
const FRAGMENT_SHADER = /* glsl */ `
    varying vec3  vColor;
    varying float vWarp;
    void main() {
        float d    = distance(gl_PointCoord, vec2(0.5));
        if (d > 0.5) discard;
        float glow = exp(-d * d * 18.0);
        float core = pow(max(0.0, 1.0 - d * 5.0), 1.5);
        // During warp, bias colour toward cyan-blue (Doppler shift illusion)
        vec3  warpTint = vec3(0.4, 0.8, 1.0);
        vec3  col  = mix(vColor, vec3(1.0), core * core * 0.7);
              col  = mix(col, warpTint, vWarp * 0.6);
        gl_FragColor = vec4(col, glow * 0.8 + core * 1.2);
    }
`;

// ── GLSL: Ambient sparkle shaders ─────────────────────────────────────────────

const AMBIENT_VERTEX_SHADER = /* glsl */ `
    uniform float uTime;
    attribute float size;
    attribute vec3  color;
    varying vec3  vColor;
    varying float vBright;
    varying float vDist;   // distance from origin — used for halo scaling in fragment

    void main() {
        vColor = color;

        // Unique per-star phase derived from position
        float phase = position.x * 13.7 + position.y * 7.3 + position.z * 5.1;

        // Slow orbital drift — each star drifts at its own speed
        float driftRate = 0.04 + 0.03 * abs(sin(phase * 0.5));
        float orbit = uTime * driftRate;
        vec3 pos = position;
        pos.x += sin(orbit * 1.3  + phase)       * 0.45;
        pos.y += cos(orbit * 0.9  + phase * 1.2) * 0.45;
        pos.z += sin(orbit * 1.1  + phase * 0.7) * 0.40;

        // Dual-frequency glow:
        //   breathe = slow cosmic pulse  (period ~7 s)
        //   sparkle = fast flicker      (period ~1-2 s, unique per star)
        float freqSpark = 1.8 + 3.2 * fract(phase * 0.17); // 1.8–5.0 Hz varies per star
        float breathe   = 0.5 + 0.5 * sin(uTime * 0.90 + phase);
        float sparkle   = 0.5 + 0.5 * sin(uTime * freqSpark + phase * 2.3);
        // Blend: mostly breathe, occasionally sparkle peaks through
        float bright    = breathe * 0.65 + sparkle * 0.35;
        // Smooth the result so nothing harshly flickers — pow eases low values
        vBright = 0.15 + 0.85 * pow(bright, 1.4);

        vDist = length(position); // store original radius for per-star glow size

        vec4 mvp = modelViewMatrix * vec4(pos, 1.0);
        // Point size also breathes with brightness — size expands as it glows up
        gl_PointSize = (size * (0.6 + vBright * 0.9) * 2.2) / -mvp.z;
        gl_Position  = projectionMatrix * mvp;
    }
`;

const AMBIENT_FRAGMENT_SHADER = /* glsl */ `
    varying vec3  vColor;
    varying float vBright;
    varying float vDist;

    void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        if (d > 0.5) discard;

        // Wide soft glow halo — exponential with tighter falloff for close stars
        float haloSharp = mix(5.0, 12.0, clamp(vDist / 20.0, 0.0, 1.0));
        float halo  = exp(-d * d * haloSharp) * vBright;

        // Bright core — tiny pinpoint in centre
        float core  = pow(max(0.0, 1.0 - d * 7.0), 2.0) * vBright;

        // Whiten core so it looks like a hot stellar centre
        vec3  col   = mix(vColor, vec3(1.0, 1.0, 1.0), core * 0.75);

        // Alpha: halo contributes a wide glow, core adds the pinpoint
        float alpha = halo * 1.4 + core * 1.0;
        gl_FragColor = vec4(col, alpha);
    }
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const COUNT = 100000;
const AMBIENT_COUNT = 20000; // inner + outer stars — denser field

// ── State ─────────────────────────────────────────────────────────────────────

let scene, camera, renderer, particles, geometry, ambientMesh;
let colors = new Float32Array(COUNT * 3);
let sizes = new Float32Array(COUNT);
let morphValue = { val: 0 };
let fistStrength = 0;
let explodeStrength = 0;
let prevPalmX = null;
let prevPalmY = null;
let handRotating = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');
const statusText = document.getElementById('status-text');
const colorPicker = document.getElementById('baseColor');

// ── Shape cycle list ─────────────────────────────────────────────────────────

const SHAPE_DATA = [
    { id: 'sphere', label: 'Sphere' },
    { id: 'heart', label: 'Heart' },
    { id: 'galaxy', label: 'Galaxy' },
    { id: 'saturn', label: 'Saturn' },
    { id: 'nailong', label: 'Nailong' },
    { id: 'birthday', label: 'HBD AULL!!' },
];
let currentShapeIndex = 0;
let nextShapeCooldown = 0; // frames before two-hand gesture can trigger again

/** Reveal label of active button; mask all others as ??? */
function updateButtonLabels() {
    SHAPE_DATA.forEach((s, i) => {
        const btn = document.querySelector(`[data-shape="${s.id}"]`);
        if (!btn) return;
        btn.textContent = (i === currentShapeIndex) ? s.label : '???';
        btn.classList.toggle('shape-active', i === currentShapeIndex);
    });
}

/** Select shape by id (also called from button onclick) */
function selectShape(id) {
    currentShapeIndex = Math.max(0, SHAPE_DATA.findIndex(s => s.id === id));
    setShape(id);
    updateButtonLabels();
}

/** Advance to the next shape in the cycle */
function nextShape() {
    currentShapeIndex = (currentShapeIndex + 1) % SHAPE_DATA.length;
    const s = SHAPE_DATA[currentShapeIndex];
    setShape(s.id);
    updateButtonLabels();
    statusText.innerText = `➡️ Next: ${s.label}`;
    nextShapeCooldown = 90; // ~3 s at 30 fps — prevent accidental repeat
}

window.selectShape = selectShape;
window.nextShape = nextShape;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hsl(h, s, l) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);

/** Uniform point inside an axis-aligned ellipsoid centered at (cx,cy,cz). */
function sampleEllipsoid(cx, cy, cz, rx, ry, rz) {
    const r = Math.cbrt(Math.random());
    const theta = rnd(0, Math.PI * 2);
    const phi = Math.acos(rnd(-1, 1));
    return [
        cx + r * rx * Math.sin(phi) * Math.cos(theta),
        cy + r * ry * Math.sin(phi) * Math.sin(theta),
        cz + r * rz * Math.cos(phi),
    ];
}

// ── Shape-specific colour palettes ───────────────────────────────────────────

function generateColors(type) {
    const arr = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
        let col;
        const t = Math.random();
        switch (type) {
            case 'sphere':
                col = t < 0.5 ? [rnd(.3, .6), rnd(.5, .8), 1.0] : [.9, .95, 1.0];
                break;
            case 'heart':
                col = t < 0.4
                    ? [1.0, rnd(.05, .3), rnd(.3, .6)]
                    : t < 0.75
                        ? [1.0, rnd(.3, .6), rnd(.5, .8)]
                        : [1.0, rnd(.6, .9), rnd(.7, 1.0)];
                break;
            case 'galaxy': {
                // Center bulge (first 20%) = hot white/yellow; arms = star spectrum
                const gFrac = i / COUNT;
                if (gFrac < 0.20) {
                    col = t < 0.6 ? [1.0, 0.97, rnd(0.7, 1.0)] : [1.0, rnd(0.75, 0.92), 0.35]; // warm white/gold
                } else {
                    if (t < .28) col = [rnd(.5, .8), rnd(.7, .9), 1.0];        // blue giants
                    else if (t < .58) col = [1.0, 1.0, rnd(.85, 1.0)];            // white/yellow
                    else if (t < .78) col = [1.0, rnd(.6, .8), rnd(.1, .3)];       // orange
                    else col = [1.0, rnd(.2, .4), 0.1];               // red
                }
                break;
            }
            case 'saturn':
                col = i < COUNT * .6
                    ? [rnd(.7, 1.0), rnd(.8, 1.0), 1.0]
                    : [1.0, rnd(.55, .8), rnd(.05, .25)];
                break;
            case 'nailong': {
                // Part-indexed: colours match exact particle-index ranges in generateNailong()
                const frac = i / COUNT;
                if (frac < 0.20) {
                    col = [rnd(0.88, 0.98), rnd(0.72, 0.85), rnd(0.10, 0.22)]; // body: deep golden-yellow
                } else if (frac < 0.70) {
                    col = [rnd(0.96, 1.00), rnd(0.85, 0.95), rnd(0.18, 0.32)]; // head: bright warm yellow
                } else if (frac < 0.80) {
                    // Eyes (iris): vivid green, darker ring toward edge
                    col = t < 0.55
                        ? [rnd(0.00, 0.12), rnd(0.62, 0.85), rnd(0.18, 0.38)] // bright green
                        : [rnd(0.00, 0.08), rnd(0.38, 0.58), rnd(0.10, 0.22)]; // deep green rim
                } else if (frac < 0.84) {
                    col = [rnd(0.00, 0.04), rnd(0.03, 0.12), rnd(0.01, 0.06)]; // pupils: near-black
                } else if (frac < 0.85) {
                    col = [rnd(0.52, 0.68), rnd(0.36, 0.50), rnd(0.22, 0.36)]; // mouth: warm gray
                } else if (frac < 0.87) {
                    col = [rnd(0.92, 1.00), rnd(0.97, 1.00), 1.00];           // sparkle: pure white
                } else {
                    col = [rnd(0.94, 1.00), rnd(0.85, 0.94), rnd(0.20, 0.34)]; // extra head: yellow
                }
                break;
            }
            case 'birthday':
                col = hsl(i / COUNT, 1.0, 0.65);
                break;
            default:
                col = [Math.random(), Math.random(), Math.random()];
        }
        arr[i * 3] = col[0]; arr[i * 3 + 1] = col[1]; arr[i * 3 + 2] = col[2];
    }
    return arr;
}

// ── Shape generators ──────────────────────────────────────────────────────────

function generateSphere() {
    const arr = new Float32Array(COUNT * 3);
    const r = 5;
    for (let i = 0; i < COUNT; i++) {
        const theta = Math.acos(1 - 2 * (i / COUNT));
        const phi = Math.sqrt(COUNT * Math.PI) * theta;
        arr[i * 3] = r * Math.sin(theta) * Math.cos(phi);
        arr[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
        arr[i * 3 + 2] = r * Math.cos(theta);
    }
    return arr;
}

/** Volumetric 3D heart — 100% interior fill, no surface outline.
 *  Taubin implicit: (x²+9z²/4+y²-1)³ - x²y³ - (9/80)z²y³ ≤ 0 */
function generateHeart() {
    const arr = new Float32Array(COUNT * 3);
    const scale = 2.8;
    let idx = 0;
    // Pure volumetric fill only — no surface outline ring
    while (idx < COUNT) {
        const x = rnd(-1.5, 1.5);
        const y = rnd(-1.5, 1.5);
        const z = rnd(-1.5, 1.5);
        const v = Math.pow(x * x + (9 / 4) * z * z + y * y - 1, 3)
            - x * x * Math.pow(y, 3)
            - (9 / 80) * z * z * Math.pow(y, 3);
        if (v <= 0) {
            arr[idx * 3] = x * scale;
            arr[idx * 3 + 1] = y * scale;
            arr[idx * 3 + 2] = z * scale;
            idx++;
        }
    }
    return arr;
}

/** Three-arm logarithmic spiral galaxy with dense glowing center bulge.
 *  First 20% of particles = central bulge (bright, compact);
 *  rest = spiral arms spread over radius 0.5–8. */
function generateGalaxy() {
    const arr = new Float32Array(COUNT * 3);
    const ARMS = 3;
    for (let i = 0; i < COUNT; i++) {
        if (i < COUNT * 0.20) {
            // Central bulge — tight ellipsoid
            const [x, y, z] = sampleEllipsoid(0, 0, 0, 1.2, 0.35, 1.2);
            arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
        } else {
            // Logarithmic spiral arm
            const arm = i % ARMS;
            const offset = (arm / ARMS) * Math.PI * 2;
            const t = Math.pow(Math.random(), 0.5); // bias toward center
            const r = 0.6 + t * 7.2;
            const turns = 1.8; // spiral tightness
            const armAng = offset + t * Math.PI * 2 * turns;
            const spread = (0.25 + t * 0.55) * 0.9; // wider at edges
            const angle = armAng + rnd(-spread, spread);
            const thick = rnd(-0.25, 0.25) * (1 - t * 0.6);
            arr[i * 3] = r * Math.cos(angle);
            arr[i * 3 + 1] = thick;
            arr[i * 3 + 2] = r * Math.sin(angle);
        }
    }
    return arr;
}

function generateSaturn() {
    const arr = new Float32Array(COUNT * 3);
    const cut = COUNT * .6;
    for (let i = 0; i < COUNT; i++) {
        if (i < cut) {
            const r = 3, th = Math.acos(1 - 2 * (i / cut)), ph = Math.sqrt(cut * Math.PI) * th;
            arr[i * 3] = r * Math.sin(th) * Math.cos(ph); arr[i * 3 + 1] = r * Math.sin(th) * Math.sin(ph); arr[i * 3 + 2] = r * Math.cos(th);
        } else {
            const r = 5 + rnd(0, 3), a = rnd(0, Math.PI * 2);
            arr[i * 3] = r * Math.cos(a); arr[i * 3 + 1] = rnd(-.2, .2); arr[i * 3 + 2] = r * Math.sin(a);
        }
    }
    return arr;
}

/** Nailong — reference-accurate face.
 *  Head dominates (≈2.2r sphere). Eyes: green iris discs on front face surface,
 *  dark pupils inside, anime white-sparkle highlight. Gentle parabolic smile.
 *  PARTICLE ORDER must match index fractions in generateColors('nailong'). */
function generateNailong() {
    const arr = new Float32Array(COUNT * 3);
    let idx = 0;

    // Fills [frac * COUNT] particles uniformly inside an ellipsoid
    const fill = (frac, cx, cy, cz, rx, ry, rz) => {
        const end = Math.min(idx + Math.floor(COUNT * frac), COUNT);
        while (idx < end) {
            const [x, y, z] = sampleEllipsoid(cx, cy, cz, rx, ry, rz);
            arr[idx * 3] = x; arr[idx * 3 + 1] = y; arr[idx * 3 + 2] = z; idx++;
        }
    };

    // ─── 0.00–0.20  Body: small round belly, mostly below/behind the giant head ───
    fill(0.20, 0.0, -0.6, -0.4, 1.9, 2.1, 1.8);

    // ─── 0.20–0.70  Head: very large perfectly round — the dominant feature ───────
    fill(0.50, 0.0, 2.5, 0.0, 2.3, 2.3, 2.3);

    // ─── 0.70–0.75  Left eye iris (green disc on head surface) ───────────────────
    // Head front surface at (-0.88, 3.1): z ≈ √(2.3²-0.88²-0.6²) ≈ 1.97 from head ctr
    fill(0.05, -0.90, 3.10, 1.92, 0.58, 0.58, 0.32);

    // ─── 0.75–0.80  Right eye iris (symmetric) ──────────────────────────────────
    fill(0.05, 0.90, 3.10, 1.92, 0.58, 0.58, 0.32);

    // ─── 0.80–0.82  Left pupil (dark oval, sits in front of iris) ────────────────
    fill(0.02, -0.90, 3.08, 2.16, 0.27, 0.27, 0.16);

    // ─── 0.82–0.84  Right pupil ──────────────────────────────────────────────────
    fill(0.02, 0.90, 3.08, 2.16, 0.27, 0.27, 0.16);

    // ─── 0.84–0.85  Smile: parabolic arc ⌣  (opens upward = happy curve) ─────────
    {
        const n = Math.floor(COUNT * 0.01), end = Math.min(idx + n, COUNT);
        while (idx < end) {
            const t = rnd(-1, 1);
            const x = t * 0.52;
            const y = 2.18 + 0.22 * t * t + rnd(-0.05, 0.05); // corners lift up
            const z = 2.08 + rnd(0.00, 0.10);
            arr[idx * 3] = x; arr[idx * 3 + 1] = y; arr[idx * 3 + 2] = z; idx++;
        }
    }

    // ─── 0.85–0.86  Left eye sparkle (top-inner corner, anime style) ─────────────
    fill(0.01, -1.08, 3.50, 2.18, 0.11, 0.11, 0.07);

    // ─── 0.86–0.87  Right eye sparkle ────────────────────────────────────────────
    fill(0.01, 0.68, 3.50, 2.18, 0.11, 0.11, 0.07);

    // ─── 0.87–1.00  Extra head volume (cheeks, chin, forehead) ───────────────────
    while (idx < COUNT) {
        const [x, y, z] = sampleEllipsoid(0, 2.5, 0, 2.3, 2.3, 2.3);
        arr[idx * 3] = x; arr[idx * 3 + 1] = y; arr[idx * 3 + 2] = z; idx++;
    }
    return arr;
}

/** Render "HBD\nAULL!!" to an offscreen canvas and sample particle positions from text pixels. */
function generateBirthday() {
    const tc = document.createElement('canvas');
    tc.width = 600; tc.height = 200;
    const ctx2 = tc.getContext('2d');

    ctx2.fillStyle = 'white';
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';

    ctx2.font = 'bold 92px Arial, sans-serif';
    ctx2.fillText('HBD', 300, 62);

    ctx2.font = 'bold 72px Arial, sans-serif';
    ctx2.fillText('AULL!!', 300, 148);

    const { data } = ctx2.getImageData(0, 0, tc.width, tc.height);
    const valid = [];
    for (let py = 0; py < tc.height; py++)
        for (let px = 0; px < tc.width; px++)
            if (data[(py * tc.width + px) * 4 + 3] > 80)
                valid.push([px, py]);

    const arr = new Float32Array(COUNT * 3);
    if (!valid.length) {
        // Fallback
        for (let i = 0; i < COUNT; i++) { arr[i * 3] = rnd(-10, 10); arr[i * 3 + 1] = rnd(-5, 5); arr[i * 3 + 2] = 0; }
        return arr;
    }

    for (let i = 0; i < COUNT; i++) {
        const [px, py] = valid[Math.floor(Math.random() * valid.length)];
        arr[i * 3] = (px / tc.width - 0.5) * 30;
        arr[i * 3 + 1] = -(py / tc.height - 0.5) * 10;
        arr[i * 3 + 2] = rnd(-0.6, 0.6);
    }
    return arr;
}

// ── Shape switcher ────────────────────────────────────────────────────────────

function setShape(type) {
    const generators = {
        sphere: generateSphere,
        heart: generateHeart,
        galaxy: generateGalaxy,
        saturn: generateSaturn,
        nailong: generateNailong,
        birthday: generateBirthday,
    };
    const newPoints = (generators[type] ?? generateSphere)();
    const newColors = generateColors(type);

    geometry.attributes.position.array.set(geometry.attributes.targetPos.array);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.targetPos.array.set(newPoints);
    geometry.attributes.targetPos.needsUpdate = true;
    geometry.attributes.color.array.set(newColors);
    geometry.attributes.color.needsUpdate = true;

    morphValue.val = 0;
    gsap.to(morphValue, { val: 1, duration: 1.5, ease: 'power2.inOut' });
}
window.setShape = setShape;

// ── Ambient sparkles (inside & outside the model) ────────────────────────────

function initAmbient() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(AMBIENT_COUNT * 3);
    const ambSizes = new Float32Array(AMBIENT_COUNT);
    const ambColors = new Float32Array(AMBIENT_COUNT * 3);

    for (let i = 0; i < AMBIENT_COUNT; i++) {
        // Three zones for fullness: inner fill, mid-shell, deep outer
        const zone = Math.random();
        const r = zone < 0.25 ? rnd(0.2, 5.5)   // inner — fills model interior
            : zone < 0.65 ? rnd(5.5, 14.0)  // mid-shell
                : rnd(14.0, 25.0);  // deep outer — wide starfield
        const theta = Math.acos(rnd(-1, 1));
        const phi = rnd(0, Math.PI * 2);
        pos[i * 3] = r * Math.sin(theta) * Math.cos(phi);
        pos[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
        pos[i * 3 + 2] = r * Math.cos(theta);

        // Size: tiny inside, moderate mid, larger far stars
        ambSizes[i] = r < 5.5 ? rnd(0.8, 2.5)
            : r < 14 ? rnd(2.0, 7.0)
                : rnd(1.5, 9.0);

        // Star colour: mostly blue-white; 20% warm yellow/orange
        const warm = Math.random() < 0.2;
        const b = rnd(0.45, 1.0);
        ambColors[i * 3] = warm ? b : b * rnd(0.4, 0.7);
        ambColors[i * 3 + 1] = warm ? b * rnd(.5, .8) : b * rnd(0.6, 0.9);
        ambColors[i * 3 + 2] = warm ? b * 0.2 : b;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(ambSizes, 1));
    geo.setAttribute('color', new THREE.BufferAttribute(ambColors, 3));

    ambientMesh = new THREE.Points(geo, new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        vertexShader: AMBIENT_VERTEX_SHADER,
        fragmentShader: AMBIENT_FRAGMENT_SHADER,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    }));
    scene.add(ambientMesh);
}

// ── Three.js scene ────────────────────────────────────────────────────────────

function init() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 15;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.body.appendChild(renderer.domElement);

    geometry = new THREE.BufferGeometry();
    const initialPos = generateSphere();
    for (let i = 0; i < COUNT; i++) sizes[i] = 4 + Math.pow(Math.random(), 2) * 14;
    const initColors = generateColors('sphere');
    for (let i = 0; i < COUNT * 3; i++) colors[i] = initColors[i];

    geometry.setAttribute('position', new THREE.BufferAttribute(initialPos, 3));
    geometry.setAttribute('targetPos', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    particles = new THREE.Points(geometry, new THREE.ShaderMaterial({
        uniforms: { uMorph: { value: 0 }, uFist: { value: 0 }, uExplode: { value: 0 }, uTime: { value: 0 } },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    }));
    scene.add(particles);

    initAmbient();
    window.addEventListener('resize', onWindowResize);
    animate();
    setShape('sphere');
    updateButtonLabels(); // show "Sphere" on first btn, "???" for rest
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (!handRotating) particles.rotation.y += 0.003;
    if (ambientMesh) ambientMesh.material.uniforms.uTime.value += 0.01;

    const u = particles.material.uniforms;
    u.uTime.value += 0.01;          // drives warp-speed black hole spiral
    u.uMorph.value = morphValue.val;
    u.uFist.value = fistStrength;
    u.uExplode.value = explodeStrength;
    renderer.render(scene, camera);
}

// ── MediaPipe Hand tracking ───────────────────────────────────────────────────

const hands = new Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
});
hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: .5, minTrackingConfidence: .5 });

hands.onResults((results) => {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    // ── Cooldown tick (runs every frame regardless of hand detection) ──────────────
    if (nextShapeCooldown > 0) nextShapeCooldown--;

    const hands2 = results.multiHandLandmarks;

    if (hands2?.length > 0) {
        const lm = hands2[0];
        const palm = lm[9];

        drawConnectors(canvasCtx, lm, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 4 });
        drawLandmarks(canvasCtx, lm, { color: '#FF0000', lineWidth: 2 });
        if (hands2.length > 1) {
            drawConnectors(canvasCtx, hands2[1], HAND_CONNECTIONS, { color: '#00FFFF', lineWidth: 4 });
            drawLandmarks(canvasCtx, hands2[1], { color: '#FF00FF', lineWidth: 2 });
        }

        // ── Two-hand open gesture → next shape ────────────────────────────────────
        if (hands2.length >= 2 && nextShapeCooldown === 0) {
            const bothOpen = hands2.every(h => {
                const up = [h[8].y < h[6].y, h[12].y < h[10].y, h[16].y < h[14].y, h[20].y < h[18].y]
                    .filter(Boolean).length;
                return up >= 4;
            });
            if (bothOpen) { nextShape(); canvasCtx.restore(); return; }
        }

        // ── Single-hand gestures (use first hand) ─────────────────────────────────
        const upCount = [lm[8].y < lm[6].y, lm[12].y < lm[10].y, lm[16].y < lm[14].y, lm[20].y < lm[18].y]
            .filter(Boolean).length;

        if (upCount === 0) {
            statusText.innerText = 'Fist: Black Hole';
            fistStrength = Math.min(fistStrength + 0.05, 1.0); explodeStrength = 0;
            handRotating = false; prevPalmX = prevPalmY = null;

        } else if (upCount >= 4) {
            statusText.innerText = hands2.length < 2
                ? 'Open Hand: Exploding  │  👐👐 Both Hands = Next Shape'
                : 'Open Hand: Exploding';
            explodeStrength = Math.min(explodeStrength + 0.1, 2.0); fistStrength = 0;
            handRotating = false; prevPalmX = prevPalmY = null;

        } else {
            statusText.innerText = 'Move Hand: Rotating';
            fistStrength *= 0.85; explodeStrength *= 0.85; handRotating = true;
            if (prevPalmX !== null && particles) {
                particles.rotation.y -= (palm.x - prevPalmX) * 8;
                particles.rotation.x -= (palm.y - prevPalmY) * 5;
            }
            prevPalmX = palm.x; prevPalmY = palm.y;
        }
    } else {
        statusText.innerText = 'Udahh,, coba gerakin tanganmu';
        fistStrength *= 0.9; explodeStrength *= 0.9;
        handRotating = false; prevPalmX = prevPalmY = null;
    }
    canvasCtx.restore();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.getElementById('start-btn').addEventListener('click', async () => {
    document.getElementById('start-overlay').style.display = 'none';
    canvasElement.width = 640;
    canvasElement.height = 480;
    init();
    const mpCamera = new Camera(videoElement, {
        onFrame: async () => { await hands.send({ image: videoElement }); },
        width: 640, height: 480,
    });
    mpCamera.start();
});

colorPicker.addEventListener('input', (e) => {
    if (!geometry) return;
    const c = new THREE.Color(e.target.value);
    const a = geometry.attributes.color.array;
    for (let i = 0; i < COUNT * 3; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    geometry.attributes.color.needsUpdate = true;
});
