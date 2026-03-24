/* ===========================
   Elite WebGL Gesture Particles
   Main JavaScript
   =========================== */

// ── GLSL Shaders ──────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */ `
    uniform float uTime;
    uniform float uMorph;
    uniform float uFist;
    uniform float uExplode;
    uniform vec3  uPointer;
    uniform float uPointerActive;

    attribute vec3 targetPos;
    attribute vec3 color;

    varying vec3  vColor;
    varying float vAlpha;

    void main() {
        vColor = color;

        // Morph between current and target shape
        vec3 pos = mix(position, targetPos, uMorph);

        // Continuous Y-axis rotation
        float angle = uTime * 0.2;
        float s = sin(angle);
        float c = cos(angle);
        pos.xz *= mat2(c, -s, s, c);

        // Gesture: Explode (Open Hand)
        if (uExplode > 0.1) {
            pos += normalize(pos) * uExplode * 5.0;
        }

        // Gesture: Black Hole (Fist)
        if (uFist > 0.1) {
            pos = mix(pos, vec3(0.0), uFist * 0.95);
        }

        // Gesture: Pointer Follow (Index finger)
        if (uPointerActive > 0.5) {
            float d = distance(pos, uPointer);
            if (d < 5.0) {
                pos = mix(pos, uPointer, (1.0 - d / 5.0) * 0.2);
            }
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = 15.0 / -mvPosition.z;
        gl_Position  = projectionMatrix * mvPosition;
    }
`;

const FRAGMENT_SHADER = /* glsl */ `
    varying vec3 vColor;

    void main() {
        float dist     = distance(gl_PointCoord, vec2(0.5));
        if (dist > 0.5) discard;
        float strength = 1.0 - dist * 2.0;
        gl_FragColor   = vec4(vColor, strength);
    }
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const COUNT = 25000;

// ── State ─────────────────────────────────────────────────────────────────────

let scene, camera, renderer, particles, geometry;
let colors       = new Float32Array(COUNT * 3);
let morphValue   = { val: 0 };
let pointerPos   = new THREE.Vector3();
let pointerActive = 0;
let fistStrength  = 0;
let explodeStrength = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx    = canvasElement.getContext('2d');
const statusText   = document.getElementById('status-text');
const colorPicker  = document.getElementById('baseColor');

// ── Shape generators ──────────────────────────────────────────────────────────

function generateSphere() {
    const arr = new Float32Array(COUNT * 3);
    const r   = 5;
    for (let i = 0; i < COUNT; i++) {
        const theta = Math.acos(1 - 2 * (i / COUNT));
        const phi   = Math.sqrt(COUNT * Math.PI) * theta;
        arr[i * 3]     = r * Math.sin(theta) * Math.cos(phi);
        arr[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
        arr[i * 3 + 2] = r * Math.cos(theta);
    }
    return arr;
}

function generateHeart() {
    const arr = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
        const t = Math.random() * Math.PI * 2;
        const x = 16 * Math.pow(Math.sin(t), 3);
        const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        const depth = (Math.random() - 0.5) * 5;
        arr[i * 3]     = x * 0.3;
        arr[i * 3 + 1] = y * 0.3;
        arr[i * 3 + 2] = depth * 0.2;
    }
    return arr;
}

function generateGalaxy() {
    const arr = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
        const angle = 0.1 * i;
        const r     = 0.05 * i + Math.random() * 2;
        arr[i * 3]     = r * Math.cos(angle);
        arr[i * 3 + 1] = (Math.random() - 0.5) * 2;
        arr[i * 3 + 2] = r * Math.sin(angle);
    }
    return arr;
}

function generateTorus() {
    const arr = new Float32Array(COUNT * 3);
    const R = 6, r = 2;
    for (let i = 0; i < COUNT; i++) {
        const u = Math.random() * Math.PI * 2;
        const v = Math.random() * Math.PI * 2;
        arr[i * 3]     = (R + r * Math.cos(v)) * Math.cos(u);
        arr[i * 3 + 1] = (R + r * Math.cos(v)) * Math.sin(u);
        arr[i * 3 + 2] = r * Math.sin(v);
    }
    return arr;
}

function generateSaturn() {
    const arr     = new Float32Array(COUNT * 3);
    const bodyCut = COUNT * 0.6;
    for (let i = 0; i < COUNT; i++) {
        if (i < bodyCut) {
            // Sphere core
            const r     = 3;
            const theta = Math.acos(1 - 2 * (i / bodyCut));
            const phi   = Math.sqrt(bodyCut * Math.PI) * theta;
            arr[i * 3]     = r * Math.sin(theta) * Math.cos(phi);
            arr[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
            arr[i * 3 + 2] = r * Math.cos(theta);
        } else {
            // Ring
            const r = 5 + Math.random() * 3;
            const a = Math.random() * Math.PI * 2;
            arr[i * 3]     = r * Math.cos(a);
            arr[i * 3 + 1] = (Math.random() - 0.5) * 0.2;
            arr[i * 3 + 2] = r * Math.sin(a);
        }
    }
    return arr;
}

function generateNailong() {
    const arr = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
        let x, y, z;
        if (i < COUNT * 0.7) {
            // Body
            const t = Math.acos(1 - 2 * Math.random());
            const p = Math.random() * Math.PI * 2;
            const r = 3 + Math.sin(t * 2);
            x = r * Math.sin(t) * Math.cos(p);
            y = r * Math.cos(t) * 1.5 - 1.0;
            z = r * Math.sin(t) * Math.sin(p);
        } else {
            // Head
            const t = Math.acos(1 - 2 * Math.random());
            const p = Math.random() * Math.PI * 2;
            x = Math.sin(t) * Math.cos(p) * 2;
            y = Math.cos(t) * 2 + 3.0;
            z = Math.sin(t) * Math.sin(p) * 2;
        }
        arr[i * 3]     = x;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = z;
    }
    return arr;
}

function generateBirthday() {
    const arr = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
        arr[i * 3]     = (Math.random() - 0.5) * 20;
        arr[i * 3 + 1] = (Math.random() - 0.5) * 10;
        arr[i * 3 + 2] = (Math.random() - 0.5) * 2;
    }
    return arr;
}

// ── Shape switcher ────────────────────────────────────────────────────────────

function setShape(type) {
    const generators = {
        sphere:   generateSphere,
        heart:    generateHeart,
        galaxy:   generateGalaxy,
        torus:    generateTorus,
        saturn:   generateSaturn,
        nailong:  generateNailong,
        birthday: generateBirthday,
    };

    const newPoints = (generators[type] ?? generateSphere)();

    // Swap: current target → position, new target → targetPos
    geometry.attributes.position.array.set(geometry.attributes.targetPos.array);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.targetPos.array.set(newPoints);
    geometry.attributes.targetPos.needsUpdate = true;

    morphValue.val = 0;
    gsap.to(morphValue, { val: 1, duration: 1.5, ease: 'power2.inOut' });
}

// Make setShape available to inline onclick handlers
window.setShape = setShape;

// ── Three.js init ─────────────────────────────────────────────────────────────

function init() {
    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 15;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.body.appendChild(renderer.domElement);

    geometry = new THREE.BufferGeometry();
    const initialPos = generateSphere();
    const targetPos  = new Float32Array(COUNT * 3);

    for (let i = 0; i < COUNT * 3; i++) {
        colors[i] = Math.random();
    }

    geometry.setAttribute('position',  new THREE.BufferAttribute(initialPos, 3));
    geometry.setAttribute('targetPos', new THREE.BufferAttribute(targetPos, 3));
    geometry.setAttribute('color',     new THREE.BufferAttribute(colors, 3));

    const material = new THREE.ShaderMaterial({
        uniforms: {
            uTime:         { value: 0 },
            uMorph:        { value: 0 },
            uFist:         { value: 0 },
            uExplode:      { value: 0 },
            uPointer:      { value: new THREE.Vector3() },
            uPointerActive:{ value: 0 },
        },
        vertexShader:   VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent:    true,
        blending:       THREE.AdditiveBlending,
        depthWrite:     false,
    });

    particles = new THREE.Points(geometry, material);
    scene.add(particles);

    window.addEventListener('resize', onWindowResize);
    animate();
    setShape('sphere');
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    const u = particles.material.uniforms;
    u.uTime.value          += 0.01;
    u.uMorph.value          = morphValue.val;
    u.uFist.value           = fistStrength;
    u.uExplode.value        = explodeStrength;
    u.uPointer.value.copy(pointerPos);
    u.uPointerActive.value  = pointerActive;
    renderer.render(scene, camera);
}

// ── MediaPipe Hand tracking ───────────────────────────────────────────────────

const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});

hands.setOptions({
    maxNumHands:           1,
    modelComplexity:       1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence:  0.5,
});

hands.onResults((results) => {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];

        drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 5 });
        drawLandmarks(canvasCtx, landmarks, { color: '#FF0000', lineWidth: 2 });

        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];

        // Map index-finger tip to 3-D world space
        pointerPos.x = (0.5 - indexTip.x) * 30;
        pointerPos.y = (0.5 - indexTip.y) * 20;
        pointerPos.z = 0;

        // Pinch → randomise colour
        const pinchDist = Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y);
        if (pinchDist < 0.05) {
            statusText.innerText = 'Pinch: Randomizing Color';
            const [r, g, b] = [Math.random(), Math.random(), Math.random()];
            const attr = geometry.attributes.color.array;
            for (let i = 0; i < COUNT * 3; i += 3) {
                attr[i] = r; attr[i + 1] = g; attr[i + 2] = b;
            }
            geometry.attributes.color.needsUpdate = true;
        }

        // Extended-finger counts (excludes thumb)
        const isIndexUp  = indexTip.y         < landmarks[6].y;
        const isMiddleUp = landmarks[12].y    < landmarks[10].y;
        const isRingUp   = landmarks[16].y    < landmarks[14].y;
        const isPinkyUp  = landmarks[20].y    < landmarks[18].y;
        const upCount    = [isIndexUp, isMiddleUp, isRingUp, isPinkyUp].filter(Boolean).length;

        if (upCount === 0) {
            // Fist
            statusText.innerText = 'Fist: Attracting';
            fistStrength    = Math.min(fistStrength + 0.05, 1.0);
            explodeStrength = 0;
        } else if (upCount >= 4) {
            // Open hand
            statusText.innerText = 'Open Hand: Repelling';
            explodeStrength = Math.min(explodeStrength + 0.1, 2.0);
            fistStrength    = 0;
        } else {
            statusText.innerText = isIndexUp ? 'Pointing: Follow Me' : 'Gesture Active';
            fistStrength    *= 0.8;
            explodeStrength *= 0.8;
            pointerActive    = isIndexUp ? 1 : 0;

            if (upCount === 2) setShape('heart');
            if (upCount === 3) setShape('galaxy');
        }
    } else {
        statusText.innerText = 'No hand detected';
        fistStrength    *= 0.8;
        explodeStrength *= 0.8;
        pointerActive    = 0;
    }

    canvasCtx.restore();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.getElementById('start-btn').addEventListener('click', async () => {
    document.getElementById('start-overlay').style.display = 'none';

    // NOTE: variable named `camera` here shadows the Three.js camera intentionally —
    // MediaPipe Camera is a separate API object.
    const mpCamera = new Camera(videoElement, {
        onFrame: async () => { await hands.send({ image: videoElement }); },
        width:  640,
        height: 480,
    });
    mpCamera.start();
    init();
});

colorPicker.addEventListener('input', (e) => {
    const color = new THREE.Color(e.target.value);
    const attr  = geometry.attributes.color.array;
    for (let i = 0; i < COUNT * 3; i += 3) {
        attr[i] = color.r; attr[i + 1] = color.g; attr[i + 2] = color.b;
    }
    geometry.attributes.color.needsUpdate = true;
});
