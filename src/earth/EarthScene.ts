import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SunLightingState } from './SunLighting';

// ============================================================
// SHADERS
// ============================================================

const earthVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const earthFragmentShader = /* glsl */ `
  uniform sampler2D uDayTexture;
  uniform sampler2D uNightTexture;
  uniform sampler2D uCloudTexture;
  uniform vec3 uSunDirection;
  uniform float uOceanSpecular;
  uniform float uNightIntensity;
  uniform float uSoftFill;
  uniform float uCloudShadowStrength;
  uniform float uCloudUVOffset;
  uniform float uDebugMode;   // 0 normal, 1 normals, 2 sun ramp, 3 white sphere

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 sunDir = normalize(uSunDirection);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);

    // Hemisphere illumination: the Sun is infinitely distant, so lighting is
    // purely dot(surfaceNormal, sunDir) — parallel directional rays. A smooth
    // terminator band replaces the mathematically hard line. This calculation
    // does not depend on clouds, atmosphere or anything else.
    float sunDot = dot(normal, sunDir);
    float dayFactor = smoothstep(-0.03, 0.28, sunDot);

    // ---- Debug isolation modes ----
    // Mode 3 = PURE WHITE SPHERE validation: ignores every texture and renders
    // white * NdotL with the exact production Sun calculation. A correct setup
    // shows one clean lit hemisphere, one dark hemisphere, a smooth terminator,
    // and NO fixed dark patch tied to geography — the Sun sweep moves the lit
    // hemisphere freely over the entire sphere.
    //
    // Debug isolation modes write straight into gl_FragColor instead of
    // returning early: an early return would skip the tone-mapping and
    // color-space includes at the end of main(), leaving the validation views
    // in a different color space than the render they exist to validate.
    if (uDebugMode > 2.5) {
      gl_FragColor = vec4(vec3(max(dot(normal, sunDir), 0.0)), 1.0);
    } else if (uDebugMode > 1.5) {
      vec3 ramp = mix(vec3(0.08, 0.14, 0.55), vec3(1.0, 0.85, 0.35),
                      smoothstep(-0.12, 0.12, sunDot));
      gl_FragColor = vec4(ramp, 1.0);
    } else if (uDebugMode > 0.5) {
      gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
    } else {
      // ---- Day side ----
      // uDayTexture is an unlit, evenly illuminated albedo map (no baked
      // directional lighting, no composite night imagery) — safe to multiply by
      // the shader's own directional Sun light without double shading.
      vec3 raw = texture2D(uDayTexture, vUv).rgb;
      float lum = dot(raw, vec3(0.299, 0.587, 0.114));
      // Ocean mask (used only for the specular sheen): open ocean in this albedo
      // map is strongly blue-dominant with low luminance; land is not.
      float oceanMask = smoothstep(0.28, 0.04, lum)
                      * smoothstep(0.8, 1.2, raw.b / max(raw.r, 0.001));
      vec3 dayColor = raw;

      vec3 nightColor = texture2D(uNightTexture, vUv).rgb;
      nightColor = pow(nightColor, vec3(0.9)) * uNightIntensity;

      // Gentle sub-solar falloff: brightest near the sub-solar point, easing to
      // the terminator. Broad and smooth — never a hotspot or a spotlight.
      float sunFacing = clamp(sunDot, 0.0, 1.0);
      // Soft Daylight (optional studio fill): lifts ONLY the shadowed day-side
      // band (1 - sunFacing), leaving the sub-solar point untouched — a subtle
      // rim-lift that keeps the spherical shading, never a flat wash.
      float dayShade = 0.85 + 0.15 * sunFacing + uSoftFill * (1.0 - sunFacing);
      vec3 dayLit = dayColor * dayShade;

      vec3 color = mix(nightColor, dayLit, dayFactor);

      // Broad, soft ocean glint (wide lobe, low intensity — reads as a sheen)
      vec3 halfDir = normalize(sunDir + viewDir);
      float spec = pow(max(dot(normal, halfDir), 0.0), 36.0);
      color += spec * oceanMask * dayFactor * uOceanSpecular * vec3(0.75, 0.87, 1.0);

      // Subtle cloud shadows: sample the *same* cloud coverage that the cloud
      // layer renders, at the cloud layer's current UV. Cloud drift is a pure
      // Y-axis rotation, which maps exactly to a u-offset in equirectangular
      // space, so the shadow tracks the clouds. Zeroed when clouds are hidden.
      if (uCloudShadowStrength > 0.0) {
        float cloudDensity = texture2D(uCloudTexture,
          vec2(fract(vUv.x - uCloudUVOffset), vUv.y)).a;
        color *= 1.0 - uCloudShadowStrength * smoothstep(0.2, 0.85, cloudDensity) * dayFactor;
      }

      // Gentle limb darkening (thin atmosphere at the edge)
      float fresnel = 1.0 - max(dot(normal, viewDir), 0.0);
      color *= 1.0 - fresnel * 0.12;

      // Warm glow at the terminator (sunrise / sunset band)
      float terminator = (1.0 - smoothstep(0.0, 0.30, abs(sunDot))) * dayFactor;
      vec3 sunsetColor = vec3(0.82, 0.44, 0.16);
      color += sunsetColor * terminator * 0.10;

      gl_FragColor = vec4(color, 1.0);
    }

    // Tone-mapping + output color-space conversion. Custom ShaderMaterials do
    // NOT get these injected automatically — without them the linear output is
    // written verbatim into an sRGB-expecting framebuffer and the renderer's
    // toneMapping/toneMappingExposure settings are silently ignored.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const cloudVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const cloudFragmentShader = /* glsl */ `
  uniform sampler2D uCloudTexture;
  uniform vec3 uSunDirection;
  uniform float uOpacity;
  uniform float uSoftFill;
  uniform float uDebugMode;   // 0 normal, 1 normals, 2 sun ramp, 3 white sphere

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 sunDir = normalize(uSunDirection);
    float sunDot = dot(normal, sunDir);
    float dayFactor = smoothstep(-0.03, 0.28, sunDot);

    // Order must match the earth shader (highest threshold first) so the
    // white-sphere validation branch is reachable.
    // Debug isolation modes write straight into gl_FragColor instead of
    // returning early: an early return would skip the tone-mapping and
    // color-space includes at the end of main(), leaving the validation views
    // in a different color space than the render they exist to validate.
    if (uDebugMode > 2.5) {
      // Pure white sphere validation: exact same Sun calc as the surface.
      gl_FragColor = vec4(vec3(max(sunDot, 0.0)), 1.0);
    } else if (uDebugMode > 1.5) {
      vec3 ramp = mix(vec3(0.08, 0.14, 0.55), vec3(1.0, 0.85, 0.35),
                      smoothstep(-0.12, 0.12, sunDot));
      gl_FragColor = vec4(ramp, 1.0);
    } else if (uDebugMode > 0.5) {
      gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
    } else {
      // The satellite cloud map is white-with-alpha: the alpha channel IS the
      // cloud density from the satellite image. Use it directly — no procedural
      // noise modulation (that was producing uniform "cotton ball" coverage).
      float d = texture2D(uCloudTexture, vUv).a;

      // Density remap: suppress faint speckle below ~10% coverage, keep the
      // wispy mid-range values (smoothstep gives a soft knee, not a hard
      // threshold), and never clamp most of the disk to full white.
      float density = smoothstep(0.10, 0.85, d);
      if (density < 0.02) discard;

      // Thin veils are slightly blue-grey; thick cumulus reads near-white.
      // Off-white overall — clouds are not pure emissive white.
      vec3 thin = vec3(0.78, 0.82, 0.88);
      vec3 thick = vec3(0.96, 0.97, 1.0);
      vec3 alb = mix(thin, thick, smoothstep(0.3, 0.95, d));

      // Subtle sunlight response: brightness follows the same hemisphere
      // illumination as the surface (same shared Sun direction).
      float daylight = max(sunDot, 0.0);
      // Same subtle Soft Daylight fill as the surface: lifts the day-side band
      // away from the sub-solar point only, keeping cloud depth and shading.
      vec3 dayCol = alb * (0.5 + 0.5 * daylight + uSoftFill * 0.5 * (1.0 - daylight));

      // Night side: very dark, faint cool ambient only — no self-glow.
      vec3 nightCol = alb * vec3(0.02, 0.025, 0.04);
      vec3 col = mix(nightCol, dayCol, dayFactor);

      // Warm terminator tint (sunrise/sunset on cloud tops), kept subtle.
      float term = (1.0 - smoothstep(0.0, 0.35, abs(sunDot))) * dayFactor;
      col += vec3(0.28, 0.13, 0.04) * term * 0.4;

      // Thin clouds stay semi-transparent; night-side clouds dim but remain
      // faintly visible against city lights.
      float alpha = density * uOpacity * mix(0.35, 1.0, dayFactor);
      gl_FragColor = vec4(col, alpha);
    }

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmosphereVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const atmosphereFragmentShader = /* glsl */ `
  uniform vec3 uSunDirection;
  uniform float uIntensity;

  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 sunDir = normalize(uSunDirection);

    float ndv = max(dot(normal, viewDir), 0.0);
    float fresnel = pow(1.0 - ndv, 2.2);   // limb emphasis (0 at center, 1 at limb)
    float sunDot = dot(normal, sunDir);

    // Day-side blue Rayleigh scattering (only on the lit side)
    float day = smoothstep(-0.05, 0.65, sunDot);
    vec3 dayColor = vec3(0.30, 0.55, 1.0);

    // Warm scattering around the terminator (sunrise / sunset band)
    float term = (1.0 - smoothstep(0.0, 0.35, abs(sunDot))) * max(day, 0.15);
    vec3 warmColor = vec3(0.90, 0.50, 0.30);

    // Backlit rim: bright blue crescent when the Sun is behind the planet
    float back = smoothstep(-0.1, -0.9, sunDot);
    vec3 backColor = vec3(0.45, 0.70, 1.0);

    vec3 color = dayColor * day * 0.7
               + warmColor * term * 0.55
               + backColor * back * 1.25;

    // Everything scales with the limb factor so it never glows uniformly
    // across the whole disk — it concentrates at the atmosphere edge.
    float intensity = fresnel * uIntensity;
    gl_FragColor = vec4(color * intensity, intensity);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const starVertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aBrightness;
  varying float vBrightness;

  void main() {
    vBrightness = aBrightness;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const starFragmentShader = /* glsl */ `
  varying float vBrightness;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, dist) * vBrightness;
    gl_FragColor = vec4(vec3(0.9, 0.92, 1.0), alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ============================================================
// SUN DIRECTION MODEL
// ============================================================
// The authoritative Sun state lives in `SunLightingState` (SunLighting.ts) —
// one normalized direction vector shared by the Earth surface, city lights,
// clouds, atmosphere and ocean specular. Azimuth/elevation semantics:
// az=+90 => toward the default camera at +Z, az=-90 => away => backlit.
// Elevation is the angle above the equatorial (XZ) plane.

// Initial composition: ~76% of the visible hemisphere lit, terminator near one
// edge, city lights beginning on the dark limb.
const INITIAL_SUN_AZIMUTH = 150;   // degrees, -180..180
const INITIAL_SUN_ELEVATION = 18;  // degrees, -90..90

function wrapAzimuth(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

// ============================================================
// EARTH SCENE CLASS
// ============================================================

export class EarthScene {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private earthMesh: THREE.Mesh | null = null;
  private cloudMesh: THREE.Mesh | null = null;
  private atmosphereMesh: THREE.Mesh | null = null;
  private starField: THREE.Points | null = null;
  private earthMaterial: THREE.ShaderMaterial | null = null;
  private cloudMaterial: THREE.ShaderMaterial | null = null;
  private sunRay: THREE.ArrowHelper | null = null;

  // Single authoritative Sun state. `sun.direction` is one normalized
  // world-space vector shared by reference with the Earth surface, cloud and
  // atmosphere uSunDirection uniforms — moving the Sun updates every lighting
  // system at once, so the layers can never visually disagree.
  private sun = new SunLightingState(INITIAL_SUN_AZIMUTH, INITIAL_SUN_ELEVATION);
  // Full Daylight: the user's manual Sun, remembered while the Sun follows
  // the camera and restored exactly when the mode is switched off.
  private savedManualSun = { azimuth: INITIAL_SUN_AZIMUTH, elevation: INITIAL_SUN_ELEVATION };
  /** Scratch vector for the per-frame Full Daylight computation. */
  private _sunTmp = new THREE.Vector3();
  private sunPad: HTMLElement | null = null;
  private padHalf = 60;
  /** Cached Sun-panel DOM refs — resolved once, so the per-frame update
   *  never re-queries the document. */
  private sunUI: {
    azSlider: HTMLInputElement;
    elSlider: HTMLInputElement;
    azVal: HTMLElement;
    elVal: HTMLElement;
    knob: HTMLElement;
  } | null = null;
  /** Last values written to the Sun panel — skip DOM writes when unchanged. */
  private lastAzShown: number | null = null;
  private lastElShown: number | null = null;
  private lastKnobTransform: string | null = null;
  private clock: THREE.Clock;

  private isInteracting = false;
  private interactionTimeout: ReturnType<typeof setTimeout> | null = null;

  private initialCameraPosition = new THREE.Vector3(0, 0.5, 3.2);
  private initialTarget = new THREE.Vector3(0, 0, 0);

  private animationId: number | null = null;
  /** Handle for the in-flight reset-view transition (at most one at a time). */
  private resetAnimId: number | null = null;

  private state = { autoRotate: true, atmosphere: true, clouds: true, stars: true, autoSun: false, fullDaylight: false };

  // Textures created in loadEarth — material.dispose() does NOT dispose them.
  private textures: THREE.Texture[] = [];

  private showSunRay = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.clock = new THREE.Clock();
    this.renderer = this.createRenderer();
    this.scene = new THREE.Scene();
    this.camera = this.createCamera();
    this.controls = this.createControls();
  }

  init(): void {
    this.applyURLParams();
    this.loadEarth().catch((err) => {
      console.error('Failed to load Earth:', err);
      // Stop the render loop and release GPU resources before showing the
      // overlay — otherwise animate() would keep running requestAnimationFrame
      // forever against a detached canvas.
      this.dispose();
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
        'justify-content:center;color:#fff;font:16px/1.4 system-ui,sans-serif;' +
        'background:rgba(0,0,0,0.92)';
      overlay.textContent = 'Failed to load Earth textures.';
      document.body.appendChild(overlay);
    });
    this.setupUI();
    this.setupSunUI();
    if (this.debugEnabled) this.setupDebugPanel();
    this.animate();
  }

  // ------------------------------------------------------------
  // URL PARAMETERS (deterministic scenes for debugging / QA)
  // ------------------------------------------------------------
  // Supported: ?debug  ?clouds=0|1  ?atmosphere=0|1  ?stars=0|1
  //            ?rotate=0|1  ?sun=az,el  ?mode=1|2|3  ?sunray=1
  private debugEnabled = false;
  private pendingDebugMode: number | null = null;
  private pendingSunRay = false;
  private pendingFrontlight = false;
  private pendingSoftfill = false;

  private applyURLParams(): void {
    const params = new URLSearchParams(window.location.search);
    if (params.has('debug')) this.debugEnabled = true;
    if (params.get('clouds') === '0') this.state.clouds = false;
    if (params.get('atmosphere') === '0') this.state.atmosphere = false;
    if (params.get('stars') === '0') this.state.stars = false;
    if (params.get('rotate') === '0') this.state.autoRotate = false;
    const modeParam = params.get('mode');
    if (modeParam === '1' || modeParam === '2' || modeParam === '3') {
      this.pendingDebugMode = Number(modeParam);
    }
    if (params.get('sunray') === '1') this.pendingSunRay = true;
    if (params.get('frontlight') === '1') this.pendingFrontlight = true;
    if (params.get('softfill') === '1') this.pendingSoftfill = true;
    const sunParam = params.get('sun');
    if (sunParam) {
      const [az, el] = sunParam.split(',').map((s) => parseFloat(s));
      if (Number.isFinite(az) && Number.isFinite(el)) {
        // Clamp to valid ranges so ?sun=0,500 cannot yield a nonsense direction.
        this.sun.set(
          THREE.MathUtils.clamp(az, -180, 180),
          THREE.MathUtils.clamp(el, -90, 90),
        );
      }
    }
  }

  // ------------------------------------------------------------
  // RENDERER
  // ------------------------------------------------------------
  private createRenderer(): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Retuned 2026-09 (code-review follow-up #1): the original 1.1 pre-dated the
    // ACES + sRGB pipeline and now over-brightens the image, since both the tone
    // map and the sRGB encode act on the shader output. 1.0 is the neutral
    // compensation for the +10% lift it added.
    // FLAG: verify against the signed-off look — this is a visual-tuning value.
    renderer.toneMappingExposure = 1.0;
    this.container.appendChild(renderer.domElement);
    window.addEventListener('resize', this.onResize);
    return renderer;
  }

  private createCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
    camera.position.copy(this.initialCameraPosition);
    return camera;
  }

  private createControls(): OrbitControls {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1.3;
    controls.maxDistance = 8;
    controls.enablePan = false;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.8;

    controls.addEventListener('start', () => {
      this.isInteracting = true;
      // User grabbed the camera: bail on any in-flight reset transition so it
      // cannot fight the user's drag.
      if (this.resetAnimId != null) {
        cancelAnimationFrame(this.resetAnimId);
        this.resetAnimId = null;
      }
      if (this.interactionTimeout) clearTimeout(this.interactionTimeout);
    });

    controls.addEventListener('end', () => {
      if (this.interactionTimeout) clearTimeout(this.interactionTimeout);
      this.interactionTimeout = setTimeout(() => { this.isInteracting = false; }, 2000);
    });

    return controls;
  }

  // ------------------------------------------------------------
  // LOAD EARTH TEXTURES & MESHES
  // ------------------------------------------------------------
  private async loadEarth(): Promise<void> {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    const [dayTexture, nightTexture, cloudTexture] = await Promise.all([
      loader.loadAsync('/assets/earth/earth-day-albedo.jpg'),
      loader.loadAsync('/assets/earth/earth-night.jpg'),
      loader.loadAsync('/assets/earth/earth-clouds.png'),
    ]);

    dayTexture.colorSpace = THREE.SRGBColorSpace;
    nightTexture.colorSpace = THREE.SRGBColorSpace;
    cloudTexture.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(dayTexture, nightTexture, cloudTexture);

    // Earth mesh with custom shader.
    // The surface independently renders a correct day/night hemisphere from
    // (texture + geometry + shared Sun direction) — no dependence on clouds,
    // atmosphere or post-processing.
    const earthGeometry = new THREE.SphereGeometry(1, 128, 64);
    const earthMaterial = new THREE.ShaderMaterial({
      vertexShader: earthVertexShader,
      fragmentShader: earthFragmentShader,
      uniforms: {
        uDayTexture: { value: dayTexture },
        uNightTexture: { value: nightTexture },
        uCloudTexture: { value: cloudTexture },
        uSunDirection: { value: this.sun.direction },
        uOceanSpecular: { value: 0.45 },
        // Retuned 2026-09 (code-review follow-up #1): 2.5 was set to make city
        // lights read under the old no-encode pipeline; with ACES + sRGB live it
        // now blows out. 1.6 is a conservative compensation.
        // FLAG: verify against the signed-off look — this is a visual-tuning value.
        uNightIntensity: { value: 1.6 },
        uCloudShadowStrength: { value: this.state.clouds ? 0.2 : 0.0 },
        uCloudUVOffset: { value: 0.0 },
        uSoftFill: { value: 0 },
        uDebugMode: { value: 0.0 },
      },
    });
    this.earthMaterial = earthMaterial;
    this.earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);
    // Initial rotation to show North America / Atlantic toward camera
    this.earthMesh.rotation.y = -Math.PI * 0.25;
    this.earthMesh.renderOrder = 0;
    this.scene.add(this.earthMesh);

    // Cloud layer (slightly larger) — a satellite cloud map (white with an
    // alpha density channel) rendered as a semi-transparent shell with the
    // same hemisphere lighting model as the surface.
    const cloudGeometry = new THREE.SphereGeometry(1.01, 96, 48);
    const cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      uniforms: {
        uCloudTexture: { value: cloudTexture },
        uSunDirection: { value: this.sun.direction },
        uOpacity: { value: 0.9 },
        uSoftFill: { value: 0 },
        uDebugMode: { value: 0.0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.cloudMaterial = cloudMaterial;
    this.cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
    this.cloudMesh.rotation.y = -Math.PI * 0.25;
    this.cloudMesh.visible = this.state.clouds;
    this.cloudMesh.renderOrder = 1; // explicit transparent order: surface < clouds < atmosphere
    this.scene.add(this.cloudMesh);

    // ?mode=1|2|3 — apply the requested debug render mode once materials exist
    if (this.pendingDebugMode != null) {
      earthMaterial.uniforms.uDebugMode.value = this.pendingDebugMode;
      cloudMaterial.uniforms.uDebugMode.value = this.pendingDebugMode;
      // White-sphere test = bare sphere: keep the cloud shell out of the way.
      if (this.pendingDebugMode === 3) this.cloudMesh.visible = false;
    }

    // Atmosphere glow (largest sphere)
    const atmoGeometry = new THREE.SphereGeometry(1.08, 64, 32);
    const atmoMaterial = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        uSunDirection: { value: this.sun.direction },
        uIntensity: { value: 1.0 },
      },
      transparent: true,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.atmosphereMesh = new THREE.Mesh(atmoGeometry, atmoMaterial);
    this.atmosphereMesh.visible = this.state.atmosphere;
    this.atmosphereMesh.renderOrder = 2;
    this.scene.add(this.atmosphereMesh);

    // Star background
    this.starField = this.createStarField();
    this.starField.visible = this.state.stars;

    // Debug: Sun direction ray (hidden unless toggled). The Sun is infinitely
    // distant, so it is drawn as a ray from the planet center along the shared
    // Sun direction.
    this.sunRay = new THREE.ArrowHelper(
      this.sun.direction.clone(),
      new THREE.Vector3(0, 0, 0),
      1.8, 0xffcc44, 0.35, 0.18,
    );
    this.sunRay.visible = this.pendingSunRay;
    this.showSunRay = this.pendingSunRay;
    this.scene.add(this.sunRay);

    // QA URL params that need the materials to exist before applying.
    if (this.pendingSoftfill) this.setSoftDaylight(true);
    if (this.pendingFrontlight) this.setFullDaylight(true);

    // Fade out hint
    setTimeout(() => {
      const hint = document.getElementById('hint');
      if (hint) hint.style.opacity = '0';
    }, 5000);
  }

  // ------------------------------------------------------------
  // STAR FIELD
  // ------------------------------------------------------------
  private createStarField(): THREE.Points {
    const starCount = 12000;
    const positions = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const brightness = new Float32Array(starCount);

    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 40 + Math.random() * 30;
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
      sizes[i] = 0.5 + Math.random() * 1.5;
      brightness[i] = 0.3 + Math.random() * 0.7;
    }

    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    starGeometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));

    const starMaterial = new THREE.ShaderMaterial({
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const starField = new THREE.Points(starGeometry, starMaterial);
    starField.renderOrder = 0; // explicit transparent order: stars < clouds < atmosphere
    this.scene.add(starField);
    return starField;
  }

  // ------------------------------------------------------------
  // UI
  // ------------------------------------------------------------
  private setupUI(): void {
    const controlsEl = document.getElementById('ui-controls');
    if (!controlsEl) return;

    controlsEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.ui-btn') as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.action;

      switch (action) {
        case 'reset': this.resetView(); break;
        case 'auto-rotate':
          this.state.autoRotate = !this.state.autoRotate;
          btn.classList.toggle('active', this.state.autoRotate);
          break;
        case 'atmosphere':
          this.state.atmosphere = !this.state.atmosphere;
          btn.classList.toggle('active', this.state.atmosphere);
          if (this.atmosphereMesh) this.atmosphereMesh.visible = this.state.atmosphere;
          break;
        case 'clouds':
          this.state.clouds = !this.state.clouds;
          btn.classList.toggle('active', this.state.clouds);
          if (this.cloudMesh) this.cloudMesh.visible = this.state.clouds;
          // Cloud visibility is a pure layer toggle: it never changes the Sun,
          // the surface lighting or the terminator. Only the surface cloud
          // shadows (part of the cloud layer) switch with it.
          if (this.earthMaterial) {
            this.earthMaterial.uniforms.uCloudShadowStrength.value =
              this.state.clouds ? 0.2 : 0.0;
          }
          break;
        case 'fullscreen': this.toggleFullscreen(); break;
      }
    });

    // Initial sync pass: URL params (?clouds=0, ?atmosphere=0, ?rotate=0) may
    // have changed the state before this ran — reflect it in the button
    // "active" classes so the buttons can't read inverted from the scene.
    this.syncUIButtons();
  }

  /**
   * Reflect `this.state` into the main UI toggle buttons. Every code path
   * that flips clouds/atmosphere/auto-rotate (main UI, debug panel, URL
   * params) must end here so the buttons never desync from the scene.
   */
  private syncUIButtons(): void {
    const controlsEl = document.getElementById('ui-controls');
    if (!controlsEl) return;
    const sync = (action: string, on: boolean): void => {
      const btn = controlsEl.querySelector(`[data-action="${action}"]`) as HTMLElement | null;
      if (btn) btn.classList.toggle('active', on);
    };
    sync('auto-rotate', this.state.autoRotate);
    sync('atmosphere', this.state.atmosphere);
    sync('clouds', this.state.clouds);
  }

  /**
   * Smoothly return the camera to the initial view. Driven by wall-clock
   * time so the duration is frame-rate independent, and guarded by a single
   * stored animation handle so rapid re-clicks can't stack competing
   * transition chains. Cancels if the user grabs the camera mid-flight.
   */
  private resetView(): void {
    if (this.resetAnimId != null) cancelAnimationFrame(this.resetAnimId);
    const durationMs = 600;
    const startPos = this.camera.position.clone();
    const endPos = this.initialCameraPosition.clone();
    const startTarget = this.controls.target.clone();
    const endTarget = this.initialTarget.clone();
    const t0 = performance.now();

    const step = (now: number): void => {
      const t = Math.min((now - t0) / durationMs, 1);
      const ease = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(startPos, endPos, ease);
      this.controls.target.lerpVectors(startTarget, endTarget, ease);
      this.controls.update();
      this.resetAnimId = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.resetAnimId = requestAnimationFrame(step);
  }

  private toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // ------------------------------------------------------------
  // SUN LIGHTING CONTROL
  // ------------------------------------------------------------
  // There are two mutually exclusive Sun modes, both driven through the one
  // shared `SunLightingState.direction` Vector3 (referenced by the Earth,
  // cloud and atmosphere `uSunDirection` uniforms):
  //   1. MANUAL — the user's azimuth/elevation, fixed in world space.
  //   2. FULL DAYLIGHT — the direction is recomputed every frame from the
  //      camera, so the Sun sits behind the viewer and the visible hemisphere
  //      stays lit while orbiting.
  // updateSun() is the single write path for MANUAL mode. It stores the
  // azimuth/elevation and updates the shared SunLightingState. It never
  // touches the camera or the Earth rotation, so camera and Sun stay fully
  // independent in both modes.
  private updateSun(azimuth: number, elevation: number): void {
    this.sun.set(azimuth, elevation);
    // setDirection derives a quaternion from the vector and retains no
    // reference to it — no clone needed.
    if (this.sunRay) this.sunRay.setDirection(this.sun.direction);
    this.updateSunUI();
  }

  // ------------------------------------------------------------
  // FULL DAYLIGHT (camera-following Sun)
  // ------------------------------------------------------------
  // The shader convention is: uSunDirection = the world-space direction the
  // Sun lies in (lit hemisphere faces it). Placing the Sun behind the viewer
  // therefore means direction = normalize(cameraPosition - earthCenter),
  // where the Earth center is the orbit target. That vector is written IN
  // PLACE into the one shared Vector3 every uSunDirection uniform references,
  // so the surface day/night blend, city lights, ocean specular, clouds and
  // atmosphere all follow the camera together — no layer invents its own
  // light, and no ambient/emissive cheat flattens the shading.
  private updateFullDaylightSun(): void {
    this._sunTmp.copy(this.camera.position).sub(this.controls.target);
    if (this._sunTmp.lengthSq() < 1e-12) return; // degenerate: camera on center
    this._sunTmp.normalize();
    this.sun.direction.copy(this._sunTmp);
    // Sync azimuth/elevation from the vector so the panel readout, knob and
    // sliders reflect the live Sun, and manual-mode restore has sane state.
    const RAD2DEG = 180 / Math.PI;
    this.sun.elevation =
      Math.asin(THREE.MathUtils.clamp(this._sunTmp.y, -1, 1)) * RAD2DEG;
    this.sun.azimuth =
      wrapAzimuth(Math.atan2(this._sunTmp.z, this._sunTmp.x) * RAD2DEG);
    if (this.sunRay) this.sunRay.setDirection(this.sun.direction);
    this.updateSunUI();
  }

  private setFullDaylight(on: boolean): void {
    if (on === this.state.fullDaylight) return;
    if (on) {
      // Remember the user's manual Sun exactly, so disabling Full Daylight
      // restores it instead of resetting arbitrarily.
      this.savedManualSun = {
        azimuth: this.sun.azimuth,
        elevation: this.sun.elevation,
      };
      this.setAutoSun(false);
      this.updateFullDaylightSun();
    } else {
      this.updateSun(this.savedManualSun.azimuth, this.savedManualSun.elevation);
    }
    this.state.fullDaylight = on;
    this.updateSunPanelState();
  }

  /** Soft Daylight: subtle optional studio fill (see uSoftFill in shaders). */
  private setSoftDaylight(on: boolean): void {
    // Deliberately low: it only lifts the day-side shadow band, never the
    // night side, so Full Daylight works perfectly well without it.
    const value = on ? 0.2 : 0.0;
    if (this.earthMaterial) this.earthMaterial.uniforms.uSoftFill.value = value;
    if (this.cloudMaterial) this.cloudMaterial.uniforms.uSoftFill.value = value;
    const cb = document.getElementById('sun-softfill') as HTMLInputElement | null;
    if (cb) cb.checked = on;
  }

  /** Visual state of the Sun panel: which mode is active, what's overridden. */
  private updateSunPanelState(): void {
    const panel = document.getElementById('sun-panel');
    if (panel) panel.classList.toggle('full-daylight', this.state.fullDaylight);
    const fdBtn = panel?.querySelector(
      '[data-preset="full-daylight"]',
    ) as HTMLElement | null;
    if (fdBtn) fdBtn.classList.toggle('active', this.state.fullDaylight);
  }

  private resetSun(): void {
    if (this.state.fullDaylight) this.setFullDaylight(false);
    this.setAutoSun(false);
    this.updateSun(INITIAL_SUN_AZIMUTH, INITIAL_SUN_ELEVATION);
  }

  private applySunPreset(preset: string): void {
    if (preset === 'full-daylight') {
      this.setFullDaylight(!this.state.fullDaylight);
      return;
    }
    // Fixed presets are mutually exclusive with Full Daylight — exit the
    // camera-following mode (which restores the saved manual Sun) before the
    // preset direction replaces it, so no conflicting lighting state lingers.
    if (this.state.fullDaylight) this.setFullDaylight(false);
    this.setAutoSun(false);
    switch (preset) {
      case 'day': this.updateSun(90, 0); break;      // Sun toward camera: fully lit
      case 'sunset': this.updateSun(0, 8); break;    // Sun to the side: warm half-lit
      case 'night': this.updateSun(-90, 0); break;   // Sun behind: night side + city lights
      case 'backlit': this.updateSun(-90, -12); break; // Low Sun behind: strong blue rim
      default: break;
    }
  }

  private setAutoSun(on: boolean): void {
    if (on && this.state.fullDaylight) this.setFullDaylight(false);
    this.state.autoSun = on;
    const autoBtn = document.querySelector('[data-action="auto-sun"]') as HTMLElement | null;
    if (autoBtn) autoBtn.classList.toggle('active', on);
  }

  private setupSunUI(): void {
    const panel = document.getElementById('sun-panel');
    const pad = document.getElementById('sun-pad') as HTMLElement | null;
    const knob = document.getElementById('sun-knob') as HTMLElement | null;
    const azSlider = document.getElementById('sun-az') as HTMLInputElement | null;
    const elSlider = document.getElementById('sun-el') as HTMLInputElement | null;
    const azVal = document.getElementById('sun-az-val');
    const elVal = document.getElementById('sun-el-val');
    if (!panel || !pad || !knob || !azSlider || !elSlider || !azVal || !elVal) return;

    this.sunPad = pad;
    this.sunUI = { azSlider, elSlider, azVal, elVal, knob };
    const measure = (): void => {
      const r = pad.getBoundingClientRect();
      if (r.width > 0) this.padHalf = Math.min(r.width, r.height) / 2;
    };
    measure();

    // Sliders -> Sun (full -180..180 / -90..90 range). Guarded so manual
    // input can never fight Full Daylight (the CSS also disables these).
    azSlider.addEventListener('input', () => {
      if (this.state.fullDaylight) return;
      this.setAutoSun(false);
      this.updateSun(parseFloat(azSlider.value), this.sun.elevation);
    });
    elSlider.addEventListener('input', () => {
      if (this.state.fullDaylight) return;
      this.setAutoSun(false);
      this.updateSun(this.sun.azimuth, parseFloat(elSlider.value));
    });

    // Circular pad: left/right = azimuth, up/down = elevation
    let dragging = false;
    const setFromPointer = (clientX: number, clientY: number): void => {
      const rect = pad.getBoundingClientRect();
      if (rect.width <= 0) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const half = Math.min(rect.width, rect.height) / 2;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > half) { dx *= half / len; dy *= half / len; }
      this.updateSun((dx / half) * 180, (-dy / half) * 90);
    };
    const onDown = (e: PointerEvent): void => {
      // Guard first: never leave `dragging` stuck true in Full Daylight.
      if (this.state.fullDaylight) return;
      dragging = true;
      this.setAutoSun(false);
      pad.setPointerCapture(e.pointerId);
      setFromPointer(e.clientX, e.clientY);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      setFromPointer(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent): void => {
      dragging = false;
      if (pad.hasPointerCapture(e.pointerId)) pad.releasePointerCapture(e.pointerId);
    };
    pad.addEventListener('pointerdown', onDown);
    pad.addEventListener('pointermove', onMove);
    pad.addEventListener('pointerup', onUp);
    pad.addEventListener('pointercancel', onUp);

    // Presets (only change the Sun)
    panel.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => this.applySunPreset((btn as HTMLElement).dataset.preset!));
    });

    // Reset Sun
    const resetBtn = panel.querySelector('[data-action="reset-sun"]');
    resetBtn?.addEventListener('click', () => this.resetSun());

    // Auto Sun toggle
    const autoBtn = panel.querySelector('[data-action="auto-sun"]') as HTMLElement | null;
    autoBtn?.addEventListener('click', () => this.setAutoSun(!this.state.autoSun));

    // Soft Daylight fill toggle (optional subtle studio fill)
    const softFill = document.getElementById('sun-softfill') as HTMLInputElement | null;
    softFill?.addEventListener('change', () => this.setSoftDaylight(softFill.checked));

    this.updateSunPanelState();
    this.updateSunUI();

    // Collapse / expand
    const collapseBtn = panel.querySelector('[data-action="collapse-sun"]') as HTMLElement | null;
    const body = panel.querySelector('.sun-body') as HTMLElement | null;
    collapseBtn?.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      if (body) body.classList.toggle('hidden', collapsed);
      collapseBtn.textContent = collapsed ? '+' : '\u2212';
    });
  }

  /**
   * Per-frame Sun-panel readout. All element refs are cached in setupSunUI
   * and every write is skipped when its value has not changed, so Auto Sun /
   * Full Daylight modes do minimal DOM work each frame.
   */
  private updateSunUI(): void {
    const ui = this.sunUI;
    if (!ui) return;
    const az = Math.round(this.sun.azimuth);
    const el = Math.round(this.sun.elevation);
    if (this.lastAzShown !== az) {
      ui.azSlider.value = String(az);
      ui.azVal.textContent = String(az);
      this.lastAzShown = az;
    }
    if (this.lastElShown !== el) {
      ui.elSlider.value = String(el);
      ui.elVal.textContent = String(el);
      this.lastElShown = el;
    }
    if (this.padHalf > 0) {
      let dx = (this.sun.azimuth / 180) * this.padHalf;
      let dy = (-this.sun.elevation / 90) * this.padHalf;
      const len = Math.hypot(dx, dy);
      if (len > this.padHalf) { dx *= this.padHalf / len; dy *= this.padHalf / len; }
      const transform = `translate(${dx}px, ${dy}px)`;
      if (this.lastKnobTransform !== transform) {
        ui.knob.style.transform = transform;
        this.lastKnobTransform = transform;
      }
    }
  }

  // ------------------------------------------------------------
  // DEBUG PANEL (enabled via ?debug — not shown in normal UI)
  // ------------------------------------------------------------
  // Layer-isolation tools for diagnosing rendering defects: per-layer
  // visibility (surface / clouds / atmosphere / stars), a surface-normal view,
  // a "sun ramp" view that visualizes the exact dot(normal, sunDir) footprint,
  // and the Sun direction ray. There is no post-processing in this app (no
  // composer — final output is each shader's tone-mapping/color-space
  // includes + the renderer's tone-mapping settings), so there is nothing
  // extra to disable here.
  private setupDebugPanel(): void {
    const panel = document.createElement('div');
    panel.className = 'debug-panel';

    const title = document.createElement('div');
    title.className = 'debug-title';
    title.textContent = 'Debug isolation — ?debug';
    panel.appendChild(title);

    const makeToggle = (label: string, isActive: boolean): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.className = 'debug-btn' + (isActive ? ' active' : '');
      btn.textContent = label;
      panel.appendChild(btn);
      return btn;
    };

    const surfaceBtn = makeToggle('Surface', true);
    surfaceBtn.addEventListener('click', () => {
      if (this.earthMesh) {
        this.earthMesh.visible = !this.earthMesh.visible;
        surfaceBtn.classList.toggle('active', this.earthMesh.visible);
      }
    });

    const cloudBtn = makeToggle('Clouds', this.state.clouds);
    cloudBtn.addEventListener('click', () => {
      this.state.clouds = !this.state.clouds;
      if (this.cloudMesh) this.cloudMesh.visible = this.state.clouds;
      if (this.earthMaterial) {
        this.earthMaterial.uniforms.uCloudShadowStrength.value =
          this.state.clouds ? 0.2 : 0.0;
      }
      cloudBtn.classList.toggle('active', this.state.clouds);
      this.syncUIButtons(); // keep the main UI button in lockstep
    });

    const atmoBtn = makeToggle('Atmosphere', this.state.atmosphere);
    atmoBtn.addEventListener('click', () => {
      this.state.atmosphere = !this.state.atmosphere;
      if (this.atmosphereMesh) this.atmosphereMesh.visible = this.state.atmosphere;
      atmoBtn.classList.toggle('active', this.state.atmosphere);
      this.syncUIButtons(); // keep the main UI button in lockstep
    });

    const starsBtn = makeToggle('Stars', this.state.stars);
    starsBtn.addEventListener('click', () => {
      this.state.stars = !this.state.stars;
      if (this.starField) this.starField.visible = this.state.stars;
      starsBtn.classList.toggle('active', this.state.stars);
    });

    // Exclusive render modes: 0 normal, 1 normals, 2 sun ramp, 3 white sphere
    const modes: Array<[string, number]> = [
      ['Normal', 0],
      ['Normals', 1],
      ['Sun ramp', 2],
      ['White sphere', 3],
    ];
    const modeBtns: HTMLButtonElement[] = [];
    const applyDebugMode = (mode: number): void => {
      if (this.earthMaterial) this.earthMaterial.uniforms.uDebugMode.value = mode;
      if (this.cloudMaterial) this.cloudMaterial.uniforms.uDebugMode.value = mode;
      // The white-sphere test must render a BARE sphere — hide the cloud
      // shell in mode 3 so it cannot occlude the surface under validation.
      if (this.cloudMesh) {
        this.cloudMesh.visible = mode !== 3 && this.state.clouds;
      }
      modeBtns.forEach((b, i) => b.classList.toggle('active', i === mode));
    };
    modes.forEach(([label, mode], i) => {
      const btn = makeToggle(label, mode === 0);
      modeBtns.push(btn);
      btn.addEventListener('click', () => applyDebugMode(mode));
    });

    const rayBtn = makeToggle('Sun ray', false);
    rayBtn.addEventListener('click', () => {
      this.showSunRay = !this.showSunRay;
      if (this.sunRay) this.sunRay.visible = this.showSunRay;
      rayBtn.classList.toggle('active', this.showSunRay);
    });

    document.body.appendChild(panel);
  }

  // ------------------------------------------------------------
  // RESIZE
  // ------------------------------------------------------------
  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.sunPad) {
      const r = this.sunPad.getBoundingClientRect();
      if (r.width > 0) this.padHalf = Math.min(r.width, r.height) / 2;
      this.updateSunUI();
    }
  };

  // ------------------------------------------------------------
  // ANIMATION LOOP
  // ------------------------------------------------------------
  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();

    if (this.state.autoRotate && !this.isInteracting) {
      if (this.earthMesh) this.earthMesh.rotation.y += 0.0001;
      // Clouds drift very slightly faster than the surface — a slow relative
      // motion, never visibly racing the planet.
      if (this.cloudMesh) this.cloudMesh.rotation.y += 0.00015;
    }

    // Keep surface cloud shadows tracking the cloud layer: cloud drift is a
    // pure Y-rotation, which is exactly a u-offset in equirectangular UV space.
    if (this.earthMaterial && this.cloudMesh && this.earthMesh) {
      const offset =
        (this.cloudMesh.rotation.y - this.earthMesh.rotation.y) / (Math.PI * 2);
      this.earthMaterial.uniforms.uCloudUVOffset.value = offset;
    }

    // Full Daylight: recompute the Sun direction from the camera every frame
    // (Sun sits behind the viewer) so the visible hemisphere stays sunlit
    // while the user orbits. Mutually exclusive with Auto Sun — it wins.
    if (this.state.fullDaylight) {
      this.updateFullDaylightSun();
    } else if (this.state.autoSun) {
      // Auto Sun: slowly sweep the Sun around Earth (a live day/night cycle).
      // Independent of the camera and of Earth's own auto-rotation.
      const nextAz = wrapAzimuth(this.sun.azimuth + dt * 10);
      this.updateSun(nextAz, this.sun.elevation);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ------------------------------------------------------------
  // LIFECYCLE
  // ------------------------------------------------------------
  dispose(): void {
    if (this.animationId != null) cancelAnimationFrame(this.animationId);
    this.animationId = null;
    if (this.resetAnimId != null) cancelAnimationFrame(this.resetAnimId);
    this.resetAnimId = null;
    if (this.interactionTimeout != null) {
      clearTimeout(this.interactionTimeout);
      this.interactionTimeout = null;
    }
    window.removeEventListener('resize', this.onResize);
    // Cover Mesh, Points and Line (the sun-ray ArrowHelper contains a Line
    // whose geometry/material were previously skipped).
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Line) {
        (obj as THREE.Mesh).geometry.dispose();
        const mat = (obj as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else (mat as THREE.Material).dispose();
      }
    });
    // material.dispose() does not dispose textures — free them explicitly
    // (the cloud texture alone is several MB of GPU memory).
    this.textures.forEach((t) => t.dispose());
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

