/* ===========================
   Elite WebGL Gesture Particles
   Main JavaScript
   =========================== */

// ── GLSL: Main particle shaders ───────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */ `
    uniform float uMorph;
    uniform float uFist;
    uniform float uExplode;

    attribute vec3  targetPos;
    attribute vec3  color;
    attribute float size;

    varying vec3 vColor;

    void main() {
        vColor = color;
        vec3 pos = mix(position, targetPos, uMorph);

        if (uExplode > 0.1) pos += normalize(pos) * uExplode * 5.0;
        if (uFist    > 0.1) pos  = mix(pos, vec3(0.0), uFist * 0.95);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = (size * (1.0 + uExplode * 0.5) * 3.0) / -mvPosition.z;
        gl_Position  = projectionMatrix * mvPosition;
    }
`;

// Star-glow: exponential halo + bright white core
const FRAGMENT_SHADER = /* glsl */ `
    varying vec3 vColor;
    void main() {
        float d    = distance(gl_PointCoord, vec2(0.5));
        if (d > 0.5) discard;
        float glow = exp(-d * d * 18.0);
        float core = pow(max(0.0, 1.0 - d * 5.0), 1.5);
        vec3  col  = mix(vColor, vec3(1.0), core * core * 0.7);
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
    void main() {
        vColor = color;
        float phase = position.x*13.7 + position.y*7.3 + position.z*5.1;
        vec3 pos = position;
        pos.x += sin(uTime*0.18 + phase)      * 0.35;
        pos.y += cos(uTime*0.13 + phase*1.4)  * 0.35;
        pos.z += sin(uTime*0.21 + phase*0.6)  * 0.35;
        float twinkle = 0.3 + 0.7 * abs(sin(uTime*2.0 + phase));
        vBright = twinkle;
        vec4 mvp = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = (size * twinkle * 1.8) / -mvp.z;
        gl_Position  = projectionMatrix * mvp;
    }
`;

const AMBIENT_FRAGMENT_SHADER = /* glsl */ `
    varying vec3  vColor;
    varying float vBright;
    void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        if (d > 0.5) discard;
        float g = exp(-d*d*14.0) * vBright;
        float c = max(0.0, 1.0 - d*6.0);
        gl_FragColor = vec4(mix(vColor, vec3(1.0), c*0.6), g + c*vBright);
    }
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const COUNT         = 100000;
const AMBIENT_COUNT =  12000; // inner + outer stars combined

// ── State ─────────────────────────────────────────────────────────────────────

let scene, camera, renderer, particles, geometry, ambientMesh;
let colors          = new Float32Array(COUNT * 3);
let sizes           = new Float32Array(COUNT);
let morphValue      = { val: 0 };
let fistStrength    = 0;
let explodeStrength = 0;
let prevPalmX       = null;
let prevPalmY       = null;
let handRotating    = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const videoElement  = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx     = canvasElement.getContext('2d');
const statusText    = document.getElementById('status-text');
const colorPicker   = document.getElementById('baseColor');

// ── Helpers ───────────────────────────────────────────────────────────────────

function hsl(h, s, l) {
    const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
    const f = (t) => {
        if (t<0) t+=1; if (t>1) t-=1;
        return t<1/6 ? p+(q-p)*6*t : t<1/2 ? q : t<2/3 ? p+(q-p)*(2/3-t)*6 : p;
    };
    return [f(h+1/3), f(h), f(h-1/3)];
}

const rnd = (a=0, b=1) => a + Math.random()*(b-a);

/** Uniform point inside an axis-aligned ellipsoid centered at (cx,cy,cz). */
function sampleEllipsoid(cx, cy, cz, rx, ry, rz) {
    const r     = Math.cbrt(Math.random());
    const theta = rnd(0, Math.PI * 2);
    const phi   = Math.acos(rnd(-1, 1));
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
                col = t < 0.5 ? [rnd(.3,.6), rnd(.5,.8), 1.0] : [.9,.95,1.0];
                break;
            case 'heart':
                col = t < 0.4
                    ? [1.0, rnd(.05,.3), rnd(.3,.6)]
                    : t < 0.75
                        ? [1.0, rnd(.3,.6), rnd(.5,.8)]
                        : [1.0, rnd(.6,.9), rnd(.7,1.0)];
                break;
            case 'galaxy':
                if      (t<.30) col = [rnd(.5,.8), rnd(.7,.9), 1.0];
                else if (t<.60) col = [1.0, 1.0, rnd(.85,1.0)];
                else if (t<.80) col = [1.0, rnd(.6,.8), rnd(.1,.3)];
                else            col = [1.0, rnd(.2,.4), .1];
                break;
            case 'saturn':
                col = i < COUNT*.6
                    ? [rnd(.7,1.0), rnd(.8,1.0), 1.0]
                    : [1.0, rnd(.55,.8), rnd(.05,.25)];
                break;
            case 'nailong':
                col = t < .4
                    ? [rnd(.8,1.0), rnd(.85,1.0), rnd(.9,1.0)]  // body: off-white/cream
                    : t < .7
                        ? [rnd(.9,1.0), rnd(.5,.7), rnd(.1,.3)]  // accent: orange/red
                        : [rnd(.2,.5), rnd(.6,.9), rnd(.8,1.0)]; // detail: teal
                break;
            case 'birthday':
                col = hsl(i/COUNT, 1.0, 0.65);
                break;
            default:
                col = [Math.random(), Math.random(), Math.random()];
        }
        arr[i*3]=col[0]; arr[i*3+1]=col[1]; arr[i*3+2]=col[2];
    }
    return arr;
}

// ── Shape generators ──────────────────────────────────────────────────────────

function generateSphere() {
    const arr = new Float32Array(COUNT * 3);
    const r = 5;
    for (let i = 0; i < COUNT; i++) {
        const theta = Math.acos(1 - 2*(i/COUNT));
        const phi   = Math.sqrt(COUNT*Math.PI)*theta;
        arr[i*3]=r*Math.sin(theta)*Math.cos(phi);
        arr[i*3+1]=r*Math.sin(theta)*Math.sin(phi);
        arr[i*3+2]=r*Math.cos(theta);
    }
    return arr;
}

/** Volumetric 3D heart using Taubin's implicit surface with rejection sampling.
 *  f(x,y,z) = (x²+9z²/4+y²-1)³ - x²y³ - (9/80)z²y³ ≤ 0  */
function generateHeart() {
    const arr   = new Float32Array(COUNT * 3);
    const scale = 2.8;
    let   idx   = 0;
    // Fill surface + volume — surface ring adds sharpness
    const surfaceQuota = Math.floor(COUNT * 0.25);

    while (idx < surfaceQuota) {
        // Parametric surface sample
        const u = rnd(0, Math.PI*2);
        const v = rnd(0, Math.PI);
        const x = 4*Math.pow(Math.sin(v),3)*Math.cos(2*u);
        const y = (13*Math.cos(v)-5*Math.cos(2*v)-2*Math.cos(3*v)-Math.cos(4*v))*0.4;
        const z = ((Math.random()-0.5))*0.8;
        arr[idx*3]=x*0.35*scale; arr[idx*3+1]=y*0.28*scale; arr[idx*3+2]=z;
        idx++;
    }

    // Volumetric fill: rejection sample Taubin's implicit heart
    while (idx < COUNT) {
        const x = rnd(-1.5, 1.5);
        const y = rnd(-1.5, 1.5);
        const z = rnd(-1.5, 1.5);
        const v = Math.pow(x*x + (9/4)*z*z + y*y - 1, 3)
                  - x*x * Math.pow(y,3)
                  - (9/80) * z*z * Math.pow(y,3);
        if (v <= 0) {
            arr[idx*3]   = x * scale;
            arr[idx*3+1] = y * scale;
            arr[idx*3+2] = z * scale;
            idx++;
        }
    }
    return arr;
}

function generateGalaxy() {
    const arr = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
        const angle = 0.1*i;
        const r = 0.05*i + rnd(0,2);
        arr[i*3]=r*Math.cos(angle); arr[i*3+1]=rnd(-.8,.8); arr[i*3+2]=r*Math.sin(angle);
    }
    return arr;
}

function generateSaturn() {
    const arr = new Float32Array(COUNT*3);
    const cut = COUNT*.6;
    for (let i=0; i<COUNT; i++) {
        if (i<cut) {
            const r=3, th=Math.acos(1-2*(i/cut)), ph=Math.sqrt(cut*Math.PI)*th;
            arr[i*3]=r*Math.sin(th)*Math.cos(ph); arr[i*3+1]=r*Math.sin(th)*Math.sin(ph); arr[i*3+2]=r*Math.cos(th);
        } else {
            const r=5+rnd(0,3), a=rnd(0,Math.PI*2);
            arr[i*3]=r*Math.cos(a); arr[i*3+1]=rnd(-.2,.2); arr[i*3+2]=r*Math.sin(a);
        }
    }
    return arr;
}

/** Cute Nailong dragon — chubby body, large round head, raised right arm, stubby tail.
 *  Parts: body | head | neck | arm-R (up/waving) | arm-L | leg-R | leg-L | tail */
function generateNailong() {
    const arr = new Float32Array(COUNT * 3);
    let idx = 0;

    const fill = (count, cx, cy, cz, rx, ry, rz) => {
        const end = Math.min(idx + count, COUNT);
        while (idx < end) {
            const [x,y,z] = sampleEllipsoid(cx,cy,cz,rx,ry,rz);
            arr[idx*3]=x; arr[idx*3+1]=y; arr[idx*3+2]=z;
            idx++;
        }
    };

    fill(Math.floor(COUNT*.38),  0.0, -0.8,  0.0, 2.4, 2.0, 1.9); // body
    fill(Math.floor(COUNT*.24),  0.4,  3.0,  0.5, 1.9, 1.9, 1.8); // head (large + round)
    fill(Math.floor(COUNT*.05),  0.2,  1.1,  0.2, 0.7, 0.7, 0.7); // neck
    // Right arm raised diagonally (waving pose)
    fill(Math.floor(COUNT*.07),  2.8,  1.8,  0.0, 0.7, 1.3, 0.6); // upper-R arm
    fill(Math.floor(COUNT*.04),  3.5,  2.9,  0.2, 0.5, 0.7, 0.5); // fore-R arm (up)
    // Left arm relaxed downward
    fill(Math.floor(COUNT*.06), -2.7, -0.6,  0.0, 0.7, 1.2, 0.6); // upper-L arm
    fill(Math.floor(COUNT*.03), -3.2, -1.6,  0.1, 0.5, 0.7, 0.5); // fore-L arm
    // Stubby legs
    fill(Math.floor(COUNT*.05),  0.9, -3.0,  0.0, 0.8, 0.9, 0.8); // leg-R
    fill(Math.floor(COUNT*.05), -0.9, -3.0,  0.0, 0.8, 0.9, 0.8); // leg-L
    // Tail curving behind/right
    fill(Math.floor(COUNT*.03),  1.5, -2.3, -1.8, 0.5, 0.5, 1.4); // tail-root
    fill(Math.floor(COUNT*.02),  2.6, -3.0, -2.8, 0.4, 0.4, 0.8); // tail-tip

    // Fill any remaining with body
    while (idx < COUNT) {
        const [x,y,z] = sampleEllipsoid(0,-0.8,0, 2.4,2.0,1.9);
        arr[idx*3]=x; arr[idx*3+1]=y; arr[idx*3+2]=z; idx++;
    }
    return arr;
}

/** Render "HBD\nAULL!!" to an offscreen canvas and sample particle positions from text pixels. */
function generateBirthday() {
    const tc   = document.createElement('canvas');
    tc.width   = 600; tc.height = 200;
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
        for (let i=0;i<COUNT;i++) { arr[i*3]=rnd(-10,10); arr[i*3+1]=rnd(-5,5); arr[i*3+2]=0; }
        return arr;
    }

    for (let i = 0; i < COUNT; i++) {
        const [px, py] = valid[Math.floor(Math.random() * valid.length)];
        arr[i*3]   = (px/tc.width  - 0.5) * 22;
        arr[i*3+1] = -(py/tc.height - 0.5) * 7.5;
        arr[i*3+2] = rnd(-0.6, 0.6);
    }
    return arr;
}

// ── Shape switcher ────────────────────────────────────────────────────────────

function setShape(type) {
    const generators = {
        sphere:   generateSphere,
        heart:    generateHeart,
        galaxy:   generateGalaxy,
        saturn:   generateSaturn,
        nailong:  generateNailong,
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
    const geo      = new THREE.BufferGeometry();
    const pos      = new Float32Array(AMBIENT_COUNT * 3);
    const ambSizes = new Float32Array(AMBIENT_COUNT);
    const ambColors= new Float32Array(AMBIENT_COUNT * 3);

    for (let i = 0; i < AMBIENT_COUNT; i++) {
        // Two zones: inner (fills inside model) and outer (deep-space shell)
        const inner  = Math.random() < 0.35; // 35% inner
        const r      = inner ? rnd(0.2, 5.5) : rnd(5.5, 18);
        const theta  = Math.acos(rnd(-1, 1));
        const phi    = rnd(0, Math.PI * 2);
        pos[i*3]     = r * Math.sin(theta) * Math.cos(phi);
        pos[i*3+1]   = r * Math.sin(theta) * Math.sin(phi);
        pos[i*3+2]   = r * Math.cos(theta);

        // Inner stars are tiny, outer stars larger
        ambSizes[i] = inner ? rnd(1, 3) : rnd(2, 8);

        // Mostly blue-white star field, occasional warm star
        const warm  = Math.random() < 0.2;
        const b     = rnd(0.5, 1.0);
        ambColors[i*3]   = warm ? b : b * rnd(0.4, 0.7);
        ambColors[i*3+1] = warm ? b * rnd(0.5, 0.8) : b * rnd(0.6, 0.9);
        ambColors[i*3+2] = warm ? b * 0.2 : b;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size',     new THREE.BufferAttribute(ambSizes, 1));
    geo.setAttribute('color',    new THREE.BufferAttribute(ambColors, 3));

    ambientMesh = new THREE.Points(geo, new THREE.ShaderMaterial({
        uniforms:       { uTime: { value: 0 } },
        vertexShader:   AMBIENT_VERTEX_SHADER,
        fragmentShader: AMBIENT_FRAGMENT_SHADER,
        transparent:    true,
        blending:       THREE.AdditiveBlending,
        depthWrite:     false,
    }));
    scene.add(ambientMesh);
}

// ── Three.js scene ────────────────────────────────────────────────────────────

function init() {
    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    camera.position.z = 15;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.body.appendChild(renderer.domElement);

    geometry = new THREE.BufferGeometry();
    const initialPos = generateSphere();
    for (let i=0;i<COUNT;i++) sizes[i] = 4 + Math.pow(Math.random(),2)*14;
    const initColors = generateColors('sphere');
    for (let i=0;i<COUNT*3;i++) colors[i] = initColors[i];

    geometry.setAttribute('position',  new THREE.BufferAttribute(initialPos, 3));
    geometry.setAttribute('targetPos', new THREE.BufferAttribute(new Float32Array(COUNT*3), 3));
    geometry.setAttribute('color',     new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size',      new THREE.BufferAttribute(sizes, 1));

    particles = new THREE.Points(geometry, new THREE.ShaderMaterial({
        uniforms:       { uMorph:{value:0}, uFist:{value:0}, uExplode:{value:0} },
        vertexShader:   VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent:    true,
        blending:       THREE.AdditiveBlending,
        depthWrite:     false,
    }));
    scene.add(particles);

    initAmbient();
    window.addEventListener('resize', onWindowResize);
    animate();
    setShape('sphere');
}

function onWindowResize() {
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (!handRotating) particles.rotation.y += 0.003;
    if (ambientMesh)   ambientMesh.material.uniforms.uTime.value += 0.01;

    const u = particles.material.uniforms;
    u.uMorph.value   = morphValue.val;
    u.uFist.value    = fistStrength;
    u.uExplode.value = explodeStrength;
    renderer.render(scene, camera);
}

// ── MediaPipe Hand tracking ───────────────────────────────────────────────────

const hands = new Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
});
hands.setOptions({ maxNumHands:1, modelComplexity:1, minDetectionConfidence:.5, minTrackingConfidence:.5 });

hands.onResults((results) => {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    if (results.multiHandLandmarks?.length > 0) {
        const lm   = results.multiHandLandmarks[0];
        const palm = lm[9]; // middle-finger MCP — stable palm centre

        drawConnectors(canvasCtx, lm, HAND_CONNECTIONS, {color:'#00FF00',lineWidth:4});
        drawLandmarks(canvasCtx, lm, {color:'#FF0000',lineWidth:2});

        const upCount = [lm[8].y<lm[6].y, lm[12].y<lm[10].y, lm[16].y<lm[14].y, lm[20].y<lm[18].y]
                          .filter(Boolean).length;

        if (upCount === 0) {
            statusText.innerText = 'Fist: Black Hole';
            fistStrength = Math.min(fistStrength+0.05, 1.0); explodeStrength = 0;
            handRotating = false; prevPalmX = prevPalmY = null;

        } else if (upCount >= 4) {
            statusText.innerText = 'Open Hand: Exploding';
            explodeStrength = Math.min(explodeStrength+0.1, 2.0); fistStrength = 0;
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
        statusText.innerText = 'No hand detected';
        fistStrength *= 0.9; explodeStrength *= 0.9;
        handRotating = false; prevPalmX = prevPalmY = null;
    }
    canvasCtx.restore();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.getElementById('start-btn').addEventListener('click', async () => {
    document.getElementById('start-overlay').style.display = 'none';
    canvasElement.width  = 640;
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
    for (let i=0; i<COUNT*3; i+=3) { a[i]=c.r; a[i+1]=c.g; a[i+2]=c.b; }
    geometry.attributes.color.needsUpdate = true;
});
