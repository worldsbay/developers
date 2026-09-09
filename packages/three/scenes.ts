import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { World } from '../core/contract.js';
import { defaultDefinition, hubPortals, type WorldDefinition } from '../wire/world.js';
import { createGraphicsQuality } from './quality.js';

const material = (color: string, emissive = false) =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    ...(emissive ? { emissive: color, emissiveIntensity: 0.85 } : {}),
  });
const materialSets = new WeakMap<THREE.Object3D, Map<string, THREE.MeshStandardMaterial>>();
function mesh(
  geometry: THREE.BufferGeometry,
  color: string,
  position: number[],
  parent: THREE.Object3D,
  emissive = false,
) {
  let root = parent;
  while (root.parent) root = root.parent;
  let materials = materialSets.get(root);
  if (!materials) materialSets.set(root, (materials = new Map()));
  const key = `${color}:${emissive}`;
  let surface = materials.get(key);
  if (!surface) materials.set(key, (surface = material(color, emissive)));
  const object = new THREE.Mesh(geometry, surface);
  object.position.fromArray(position);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

type Placement = {
  position: number[];
  scale?: number[];
  rotation?: number[];
  color?: string;
};
function instances(
  geometry: THREE.BufferGeometry,
  color: string,
  placements: Placement[],
  parent: THREE.Object3D,
) {
  const batch = new THREE.InstancedMesh(geometry, material(color), placements.length);
  const transform = new THREE.Object3D();
  placements.forEach((placement, i) => {
    transform.position.fromArray(placement.position);
    transform.scale.fromArray(placement.scale ?? [1, 1, 1]);
    transform.rotation.set(...((placement.rotation ?? [0, 0, 0]) as [number, number, number]));
    transform.updateMatrix();
    batch.setMatrixAt(i, transform.matrix);
    if (placement.color) batch.setColorAt(i, new THREE.Color(placement.color));
  });
  batch.castShadow = true;
  batch.receiveShadow = true;
  parent.add(batch);
  return batch;
}

/** Closed, softly bevelled pieces used for masonry and bent timber, rather than torus stand-ins. */
function arcSlab(
  inner: number,
  outer: number,
  height: number,
  from = 0,
  length = Math.PI * 2,
  bevel = 0.012,
) {
  const start = from - Math.PI / 2,
    end = start + length;
  const shape = new THREE.Shape();
  shape.moveTo(Math.cos(start) * outer, Math.sin(start) * outer);
  shape.absarc(0, 0, outer, start, end, false);
  if (length >= Math.PI * 2 - 0.0001) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  } else {
    shape.lineTo(Math.cos(end) * inner, Math.sin(end) * inner);
    shape.absarc(0, 0, inner, end, start, true);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: Math.max(3, Math.ceil(length * 8)),
    steps: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function taperedBranch(points: number[][], base: number, tip: number) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3().fromArray(point)));
  const segments = 14,
    sides = 7;
  const geometry = new THREE.TubeGeometry(curve, segments, base, sides, false);
  const vertices = geometry.getAttribute('position') as THREE.BufferAttribute;
  const vertex = new THREE.Vector3();
  for (let ring = 0; ring <= segments; ring++) {
    const t = ring / segments,
      center = curve.getPointAt(t);
    const taper = THREE.MathUtils.lerp(base, tip, t) / base;
    for (let side = 0; side <= sides; side++) {
      const index = ring * (sides + 1) + side;
      vertex.fromBufferAttribute(vertices, index).sub(center).multiplyScalar(taper).add(center);
      vertices.setXYZ(index, vertex.x, vertex.y, vertex.z);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

function leafGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0, 0, -0.7, -0.14, 0.03, -0.35, -0.21, 0.02, 0.05, -0.13, -0.01, 0.4, 0, -0.09, 0.72, 0.13, -0.01,
        0.4, 0.21, 0.02, 0.05, 0.14, 0.03, -0.35, 0, 0.1, 0,
      ],
      3,
    ),
  );
  const indices = [];
  for (let i = 0; i < 8; i++) indices.push(8, i, (i + 1) % 8);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function foliageGeometry() {
  const geometry = new THREE.SphereGeometry(1, 10, 6);
  const vertices = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i),
      y = vertices.getY(i),
      z = vertices.getZ(i);
    const angle = Math.atan2(z, x),
      ripple = 1 + Math.sin(angle * 5 + y * 3) * 0.12;
    vertices.setXYZ(i, x * ripple, y * 0.45 + Math.sin(x * 4 + z * 2) * 0.06, z * ripple);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function garden(
  scene: THREE.Scene,
  radius: number,
  definition: WorldDefinition | undefined,
  updates: ((time: number) => void)[],
) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(85, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color('#8eaeb9') },
        horizon: { value: new THREE.Color('#f4c1a7') },
        nadir: { value: new THREE.Color('#82a9a3') },
      },
      vertexShader: `varying vec3 direction;
        void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 nadir; varying vec3 direction;
        void main() {
          float height = normalize(direction).y;
          vec3 sky = mix(horizon, zenith, smoothstep(0.0, 0.7, height));
          sky = mix(sky, nadir, smoothstep(0.0, 0.5, -height));
          gl_FragColor = vec4(sky, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.name = 'Apricot evening sky';
  scene.add(sky);
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(4.8, 32, 20),
    new THREE.MeshBasicMaterial({ color: '#ffe4b9', fog: false }),
  );
  sun.position.set(-25, 12, -44);
  scene.add(sun);

  // Grouted concentric stone courses define a courtyard without filling the gathering space.
  mesh(new THREE.CylinderGeometry(4.9, 5, 0.07, 80), '#a8a491', [0, 0.025, 2], scene);
  mesh(arcSlab(4.68, 4.96, 0.07), '#b9baa5', [0, 0.035, 2], scene);
  for (let course = 0; course < 5; course++) {
    const inner = 0.6 + course * 0.8,
      outer = inner + 0.77;
    const count = 24,
      angle = (Math.PI * 2) / count;
    const pavers: Placement[] = [];
    for (let i = 0; i < count; i++) {
      pavers.push({
        position: [0, 0.075, 2],
        rotation: [0, i * angle, 0],
        color: ['#d8ccb5', '#ded2bc', '#d3c6af'][(i + course) % 3],
      });
    }
    const paving = instances(
      arcSlab(inner, outer, 0.025, 0, angle - 0.02 / inner, 0.004),
      '#ffffff',
      pavers,
      scene,
    );
    paving.name = 'Courtyard stone courses';
    paving.castShadow = false;
  }
  mesh(new THREE.CylinderGeometry(0.57, 0.59, 0.025, 8), '#94a894', [0, 0.09, 2], scene);
  const compass: Placement[] = [];
  for (let i = 0; i < 8; i++)
    compass.push({
      position: [Math.sin((i * Math.PI) / 4) * 0.31, 0.112, 2 + Math.cos((i * Math.PI) / 4) * 0.31],
      rotation: [0, (i * Math.PI) / 4, 0],
    });
  instances(new THREE.BoxGeometry(0.028, 0.012, 0.25), '#e5d6b4', compass, scene).castShadow = false;
  mesh(arcSlab(radius - 0.56, radius - 0.18, 0.11), '#b4b3a0', [0, -0.02, 0], scene);

  const gardens = [
    [-8.4, 7.2, 2.5],
    [8.4, 7.2, 2.5],
    [-10.5, -0.1, 2.1],
    [10.5, -0.1, 2.1],
    [-10, -8.5, 2.4],
    [10, -8.5, 2.4],
  ];
  const branches: THREE.BufferGeometry[] = [],
    crowns: Placement[] = [],
    canopyLeaves: Placement[] = [],
    rocks: Placement[] = [],
    rosettes: Placement[] = [],
    curbStones: Placement[] = [],
    grasses: Placement[] = [],
    flowers: Placement[] = [];
  gardens.forEach(([x, z, size], index) => {
    const bed = mesh(
      new THREE.CylinderGeometry(size, size + 0.12, 0.18, 48),
      '#a6aa95',
      [x, 0.085, z],
      scene,
    );
    bed.scale.z = 0.85;
    const grass = mesh(
      new THREE.CylinderGeometry(size - 0.12, size - 0.12, 0.045, 48),
      '#6e856b',
      [x, 0.185, z],
      scene,
    );
    grass.scale.z = 0.85;
    const height = index < 2 ? 3.2 : 3.7,
      lean = index % 2 ? -1 : 1;
    branches.push(
      taperedBranch(
        [
          [x, 0.18, z],
          [x - lean * 0.18, 0.95, z + 0.1],
          [x + lean * 0.17, height * 0.65, z - 0.14],
          [x + lean * 0.38, height, z + 0.06],
        ],
        0.24,
        0.06,
      ),
    );
    for (let branch = 0; branch < 4; branch++) {
      const a = branch * 2.27 + index * 0.8;
      const reach = 1 + (branch % 2) * 0.45;
      const end = [x + Math.sin(a) * reach, height - 0.55 + branch * 0.25, z + Math.cos(a) * reach];
      branches.push(
        taperedBranch(
          [
            [x + lean * 0.12, height * 0.56, z - 0.06],
            [x + Math.sin(a) * 0.5, height * 0.76, z + Math.cos(a) * 0.5],
            end,
          ],
          0.115,
          0.025,
        ),
      );
      for (let layer = 0; layer < 3; layer++) {
        const cx = end[0] + Math.sin(a + layer * 1.8) * 0.45;
        const cy = end[1] + layer * 0.26;
        const cz = end[2] + Math.cos(a + layer * 1.8) * 0.38;
        const size = 0.72 + (layer % 2) * 0.2;
        const palette = index === 4 ? ['#bd9075', '#c6a186', '#ad826e'] : ['#4d7761', '#709477', '#879d78'];
        crowns.push({
          position: [cx, cy, cz],
          scale: [size * 1.2, 0.9, size],
          rotation: [Math.sin(a + layer) * 0.23, a + layer, Math.cos(a - layer) * 0.17],
          color: palette[layer],
        });
        for (let leaf = 0; leaf < 12; leaf++) {
          const angle = leaf * 2.399963 + layer;
          const r = size * 0.8 * Math.sqrt((leaf + 1) / 12);
          canopyLeaves.push({
            position: [
              cx + Math.sin(angle) * r,
              cy + 0.23 + Math.sin(angle * 2) * 0.06,
              cz + Math.cos(angle) * r,
            ],
            scale: [0.58, 0.65, 0.34],
            rotation: [-0.16 + (leaf % 3) * 0.12, angle, 0.14],
            color: palette[(leaf + layer) % 3],
          });
        }
      }
    }
    for (let stone = 0; stone < 26; stone++) {
      const a = (stone / 26) * Math.PI * 2;
      curbStones.push({
        position: [x + Math.sin(a) * (size - 0.02), 0.17, z + Math.cos(a) * (size - 0.02) * 0.85],
        scale: [0.34, 0.15 + (stone % 2) * 0.035, 0.28],
        rotation: [0.08, a, 0.08],
        color: stone % 3 ? '#b9b9a4' : '#cdcab3',
      });
    }
    for (let bush = 0; bush < 5; bush++) {
      const a = bush * 1.65 + index;
      const px = x + Math.sin(a) * 1.55,
        pz = z + Math.cos(a) * 1.25;
      rocks.push({
        position: [px, 0.37, pz],
        scale: [0.4 + (bush % 2) * 0.13, 0.29, 0.35],
        rotation: [0.25, a, 0.3],
        color: bush % 2 ? '#89988c' : '#b6b9a2',
      });
      for (let leaf = 0; leaf < 7; leaf++) {
        const angle = (leaf * Math.PI * 2) / 7 + a;
        rosettes.push({
          position: [px + 0.35 + Math.sin(angle) * 0.13, 0.42, pz + Math.cos(angle) * 0.13],
          scale: [0.8, 2.4, 0.55],
          rotation: [-0.55, angle, 0],
          color: leaf % 2 ? '#90a890' : '#4e8069',
        });
      }
    }
    for (let blade = 0; blade < 36; blade++) {
      const a = blade * 2.399963 + index;
      const r = 0.8 + (((blade * 7) % 17) / 17) * (size - 1);
      const px = x + Math.sin(a) * r,
        pz = z + Math.cos(a) * r * 0.8;
      grasses.push({
        position: [px, 0.48, pz],
        scale: [0.8, 0.6 + (blade % 5) * 0.14, 0.8],
        rotation: [0.12, a, 0.1],
        color: blade % 2 ? '#afba8c' : '#567e64',
      });
      if (blade % 3 === 0)
        flowers.push({ position: [px, 0.68, pz], color: blade % 2 ? '#f1cc99' : '#e6b4a8' });
    }
  });
  const treeWood = mergeGeometries(branches);
  for (const branch of branches) branch.dispose();
  mesh(treeWood, '#826e55', [0, 0, 0], scene).name = 'Bending garden tree branches';
  instances(foliageGeometry(), '#ffffff', crowns, scene).name = 'Layered tree canopies';
  instances(new THREE.IcosahedronGeometry(1, 0), '#ffffff', rocks, scene).name = 'Garden stones';
  instances(new THREE.IcosahedronGeometry(1, 1), '#ffffff', curbStones, scene).castShadow = false;
  const lowPlants = instances(leafGeometry(), '#ffffff', rosettes, scene);
  (lowPlants.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  const planting = new THREE.Group();
  planting.name = 'Fine garden planting';
  planting.userData.minQuality = 'medium';
  scene.add(planting);
  const leaves = instances(leafGeometry(), '#ffffff', canopyLeaves, planting);
  leaves.name = 'Olive and cedar foliage';
  leaves.castShadow = false;
  (leaves.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  instances(new THREE.ConeGeometry(0.12, 0.6, 4), '#ffffff', grasses, planting).castShadow = false;
  instances(new THREE.IcosahedronGeometry(0.09, 0), '#ffffff', flowers, planting).castShadow = false;

  // Bent rails and individually formed timber slats make open, inward-facing conversation seats.
  for (const side of [-1, 1]) {
    const lounge = new THREE.Group();
    lounge.name = 'Garden lounge';
    lounge.position.set(side * 5.6, 0, 5.1);
    lounge.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    scene.add(lounge);
    mesh(new THREE.CylinderGeometry(2.22, 2.29, 0.055, 48), '#b3b6a1', [0, 0.04, 0], lounge);
    const terraceStones: Placement[] = [];
    for (let stone = 0; stone < 24; stone++)
      terraceStones.push({
        position: [0, 0.07, 0],
        rotation: [0, (stone * Math.PI) / 12, 0],
        color: stone % 3 ? '#d3c7ae' : '#bdbaa2',
      });
    instances(
      arcSlab(1.99, 2.22, 0.025, 0, Math.PI / 12 - 0.014),
      '#ffffff',
      terraceStones,
      lounge,
    ).castShadow = false;
    mesh(arcSlab(1.43, 1.53, 0.055, -1.1, 2.2), '#486458', [0, 0.4, 0], lounge);
    mesh(arcSlab(1.89, 2.01, 0.055, -1.1, 2.2), '#486458', [0, 0.4, 0], lounge);
    mesh(arcSlab(1.96, 2.06, 0.055, -1.1, 2.2), '#bd9a70', [0, 1.05, 0], lounge);
    const slats: Placement[] = [],
      supports: Placement[] = [],
      cushions: Placement[] = [];
    for (let slat = 0; slat < 31; slat++) {
      const angle = -1.05 + slat * 0.07;
      const color = ['#a48057', '#c29b6c', '#b08c61', '#d0aa7d'][slat % 4];
      slats.push({
        position: [Math.sin(angle) * 1.71, 0.51, Math.cos(angle) * 1.71],
        scale: [0.108, 0.085, 0.66],
        rotation: [0, angle, 0],
        color,
      });
      slats.push({
        position: [Math.sin(angle) * 2, 0.83, Math.cos(angle) * 2],
        scale: [0.107, 0.46, 0.075],
        rotation: [0.13, angle, 0],
        color,
      });
    }
    for (const angle of [-0.95, 0, 0.95]) {
      for (const radius of [1.5, 1.94])
        supports.push({
          position: [Math.sin(angle) * radius, 0.26, Math.cos(angle) * radius],
          scale: [0.09, 0.35, 0.1],
          rotation: [0, angle, 0],
        });
    }
    for (const angle of [-0.68, 0.63])
      cushions.push({
        position: [Math.sin(angle) * 1.71, 0.59, Math.cos(angle) * 1.71],
        rotation: [0, angle, 0],
        color: side < 0 ? '#c28b74' : '#7e9e88',
      });
    instances(new RoundedBoxGeometry(1, 1, 1, 2, 0.09), '#ffffff', slats, lounge).name =
      'Formed timber slats';
    instances(new THREE.BoxGeometry(1, 1, 1), '#456052', supports, lounge);
    instances(new RoundedBoxGeometry(0.54, 0.085, 0.5, 3, 0.035), '#ffffff', cushions, lounge);
    const tableProfile = [
      [0, 0.45],
      [0.49, 0.45],
      [0.57, 0.48],
      [0.59, 0.52],
      [0.57, 0.56],
      [0, 0.56],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(tableProfile, 40), '#e1cfb0', [0, 0, 0], lounge);
    const pedestal = [
      [0.3, 0.1],
      [0.23, 0.14],
      [0.12, 0.29],
      [0.17, 0.44],
      [0.3, 0.45],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(pedestal, 24), '#a38960', [0, 0, 0], lounge);
    mesh(new THREE.CylinderGeometry(0.115, 0.085, 0.16, 12), '#ba8b73', [0, 0.65, 0], lounge);
    const sprig: Placement[] = [];
    for (let i = 0; i < 7; i++)
      sprig.push({
        position: [0, 0.76, 0],
        scale: [0.28, 1, 0.27],
        rotation: [-0.7, i * 2.399963, 0],
        color: i % 2 ? '#66866d' : '#92a783',
      });
    const plant = instances(leafGeometry(), '#ffffff', sprig, lounge);
    (plant.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  }

  const lamps: Placement[] = [],
    lanterns: Placement[] = [],
    caps: Placement[] = [],
    lanternFrames: Placement[] = [];
  for (const [x, z] of [
    [-3.4, -5.5],
    [3.4, -5.5],
    [-9, 3.5],
    [9, 3.5],
    [-2.8, 7.8],
    [2.8, 7.8],
  ]) {
    lamps.push({ position: [x, 0.04, z] });
    lanterns.push({ position: [x, 2.23, z] });
    caps.push({ position: [x, 2.46, z], rotation: [0, Math.PI / 4, 0] });
    for (const dx of [-0.1, 0.1])
      for (const dz of [-0.1, 0.1])
        lanternFrames.push({ position: [x + dx, 2.23, z + dz], scale: [0.018, 0.38, 0.018] });
    for (const y of [2.04, 2.42]) lanternFrames.push({ position: [x, y, z], scale: [0.235, 0.045, 0.235] });
  }
  const column = [
    [0.11, 0],
    [0.11, 0.07],
    [0.065, 0.1],
    [0.046, 0.21],
    [0.032, 1.83],
    [0.057, 1.9],
    [0.06, 1.98],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  instances(new THREE.LatheGeometry(column, 10), '#4d675f', lamps, scene).name = 'Slender garden lanterns';
  const glow = instances(new THREE.BoxGeometry(0.13, 0.29, 0.13), '#ffe4ab', lanterns, scene);
  (glow.material as THREE.MeshStandardMaterial).emissive.set('#ffc977');
  (glow.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.25;
  glow.castShadow = false;
  instances(new THREE.CylinderGeometry(0.045, 0.2, 0.13, 4), '#8a805e', caps, scene);
  instances(new THREE.BoxGeometry(1, 1, 1), '#526a59', lanternFrames, scene);

  // Render the actual collision planter at its authoritative position.
  const planter = definition?.collisions.find((box) => box.id === 'planter');
  if (planter) {
    const x = (planter.minX + planter.maxX) / 2,
      z = (planter.minZ + planter.maxZ) / 2;
    mesh(
      new THREE.BoxGeometry(planter.maxX - planter.minX, planter.height, planter.maxZ - planter.minZ),
      '#bc9b80',
      [x, planter.height / 2, z],
      scene,
    );
    const trim: Placement[] = [];
    const width = planter.maxX - planter.minX,
      depth = planter.maxZ - planter.minZ;
    for (const side of [-1, 1]) {
      trim.push({
        position: [x + side * width * 0.45, planter.height + 0.025, z],
        scale: [0.11, 0.09, depth],
      });
      trim.push({
        position: [x, planter.height + 0.025, z + side * depth * 0.45],
        scale: [width, 0.09, 0.11],
      });
    }
    instances(new THREE.BoxGeometry(1, 1, 1), '#d1b99a', trim, scene);
    const foliage: Placement[] = [];
    for (let i = 0; i < 18; i++) {
      const a = i * 2.399963;
      foliage.push({
        position: [x + Math.sin(a) * 0.14, planter.height + 0.18 + (i % 3) * 0.1, z + Math.cos(a) * 0.14],
        scale: [1.2, 1.8, 0.7],
        rotation: [-0.45 + (i % 3) * 0.15, a, 0.15],
        color: i % 2 ? '#6c9279' : '#93a986',
      });
    }
    const fern = instances(leafGeometry(), '#ffffff', foliage, scene);
    (fern.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  }

  // An arched garden gateway gives the moving showroom leaf a permanent architectural home.
  const doorway = definition?.collisions.find((box) => box.id === 'showroom-door');
  if (doorway) {
    const frame = new THREE.Group();
    frame.name = 'Showroom garden gateway';
    frame.position.set((doorway.minX + doorway.maxX) / 2, 0, (doorway.minZ + doorway.maxZ) / 2);
    scene.add(frame);
    const halfWidth = (doorway.maxZ - doorway.minZ) / 2 + 0.14;
    const height = doorway.height + 0.12;
    const depth = doorway.maxX - doorway.minX + 0.24;
    for (const side of [-1, 1]) {
      mesh(new THREE.BoxGeometry(depth, height, 0.14), '#526f62', [0, height / 2, side * halfWidth], frame);
      mesh(new THREE.BoxGeometry(depth + 0.1, 0.14, 0.25), '#d2b894', [0, 0.12, side * halfWidth], frame);
      mesh(
        new THREE.BoxGeometry(depth + 0.035, 0.065, 0.18),
        '#d2b894',
        [0, height - 0.1, side * halfWidth],
        frame,
      );
    }
    for (const offset of [-depth / 2, depth / 2]) {
      const arch = mesh(
        new THREE.TorusGeometry(1, 0.047, 8, 40, Math.PI),
        '#c8ab7c',
        [offset, height, 0],
        frame,
      );
      arch.scale.set(halfWidth, 0.46, 1);
      arch.rotation.y = Math.PI / 2;
    }
    for (let rib = -2; rib <= 2; rib++) {
      const z = rib * halfWidth * 0.38;
      const y = height + Math.sqrt(1 - (z / halfWidth) ** 2) * 0.46;
      mesh(new THREE.BoxGeometry(depth + 0.24, 0.065, 0.065), '#7d9073', [0, y, z], frame);
    }
    const crest = mesh(new THREE.OctahedronGeometry(0.13, 0), '#ffe4b3', [0, height + 0.62, 0], frame, true);
    crest.scale.set(0.5, 1, 1);
    const vine = new THREE.Group();
    vine.userData.minQuality = 'medium';
    frame.add(vine);
    const leaves: Placement[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        leaves.push({
          position: [Math.sin(i * 1.8) * depth * 0.5, height - 0.7 + i * 0.2, side * (halfWidth + 0.09)],
          scale: [0.23, 0.11, 0.18],
          rotation: [0.2, i, side * 0.3],
          color: i % 2 ? '#9bb591' : '#658c74',
        });
      }
    }
    instances(new THREE.IcosahedronGeometry(1, 1), '#ffffff', leaves, vine);
  }

  const interaction = definition?.interactions.find((entry) => entry.kind === 'switch');
  if (interaction) {
    const beacon = new THREE.Group();
    beacon.name = 'Garden welcome beacon';
    beacon.position.copy(interaction.position);
    scene.add(beacon);
    mesh(new THREE.CylinderGeometry(0.53, 0.61, 0.13, 32), '#e0c9aa', [0, 0.09, 0], beacon);
    const baseRing = mesh(new THREE.TorusGeometry(0.46, 0.018, 6, 40), '#a38153', [0, 0.163, 0], beacon);
    baseRing.rotation.x = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.08, 24), '#637f6d', [0, 0.88, 0], beacon);
    mesh(new THREE.CylinderGeometry(0.18, 0.28, 0.12, 16), '#bd9e65', [0, 0.97, 0], beacon);
    const jewel = mesh(new THREE.IcosahedronGeometry(0.24, 0), '#c8f0ce', [0, 1.2, 0], beacon, true);
    jewel.scale.y = 1.2;
    const orbit = mesh(new THREE.TorusGeometry(0.32, 0.015, 6, 40), '#ddbe82', [0, 1.2, 0], beacon);
    orbit.rotation.x = Math.PI / 2.6;
    updates.push((time) => {
      jewel.rotation.y = time * 0.35;
      jewel.position.y = 1.2 + Math.sin(time * 1.1) * 0.025;
    });
  }

  const motePositions: number[] = [];
  for (let i = 0; i < 110; i++) {
    const a = i * 2.399963,
      r = 3 + (i % 19) * 0.52;
    motePositions.push(Math.sin(a) * r, 0.7 + (i % 11) * 0.42, Math.cos(a) * r);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(motePositions, 3));
  const motes = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: '#ffe4b1',
      size: 0.045,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    }),
  );
  motes.name = 'Evening fireflies';
  motes.userData.minQuality = 'medium';
  scene.add(motes);
  updates.push((time) => {
    if (motes.visible) {
      motes.rotation.y = Math.sin(time * 0.05) * 0.06;
      motes.position.y = Math.sin(time * 0.3) * 0.15;
    }
  });

  const distant = new THREE.Group();
  distant.name = 'Distant floating gardens';
  distant.userData.minQuality = 'high';
  scene.add(distant);
  for (let i = 0; i < 6; i++) {
    const angle = i * 1.3 + 0.5,
      distance = radius + 12 + (i % 2) * 6;
    const x = Math.sin(angle) * distance,
      z = Math.cos(angle) * distance,
      y = -2 - (i % 3) * 1.4;
    mesh(new THREE.CylinderGeometry(3.2, 1.2, 2.2, 7), '#a7b3a2', [x, y, z], distant);
    mesh(new THREE.CylinderGeometry(3.15, 3.3, 0.25, 24), '#8ea997', [x, y + 1.2, z], distant);
    mesh(new THREE.CylinderGeometry(0.12, 0.19, 2.4, 7), '#957f67', [x, y + 2.5, z], distant);
    mesh(new THREE.IcosahedronGeometry(1.65, 1), '#89a89a', [x, y + 4, z], distant);
  }
}
export function buildWorld(id: string, definition?: WorldDefinition, destinations: World[] = []) {
  const night = id === 'world-b',
    scene = new THREE.Scene();
  const updates: ((time: number) => void)[] = [];
  scene.background = new THREE.Color(night ? '#10152f' : '#e9c4ac');
  scene.fog = new THREE.FogExp2(night ? '#10152f' : '#d5c7b6', night ? 0.023 : 0.012);
  scene.add(
    new THREE.HemisphereLight(night ? '#b9c6ff' : '#fff0d7', night ? '#3e2b60' : '#789b8e', night ? 2 : 2.3),
  );
  const sun = new THREE.DirectionalLight(night ? '#cfbaff' : '#ffdab3', night ? 3 : 3.2);
  sun.position.set(night ? 8 : -12, 16, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15 });
  sun.shadow.bias = -0.001;
  sun.shadow.normalBias = 0.025;
  scene.add(sun);
  const radius = definition
    ? Math.max(13, Math.hypot(definition.bounds.maxX, definition.bounds.maxZ) + 1)
    : 15;
  const platform = mesh(
    new THREE.CylinderGeometry(radius, radius + 1, 1, 64),
    night ? '#29344e' : '#a8927a',
    [0, -0.5, 0],
    scene,
  );
  platform.receiveShadow = true;
  mesh(
    new THREE.CylinderGeometry(radius - 1, radius - 1, 0.035, 64),
    night ? '#35415d' : '#819681',
    [0, 0.02, 0],
    scene,
  );
  // Paths are functional scene geometry leading from spawn to the portal.
  if (night)
    for (let z = -7; z <= 6; z += 1.15)
      for (let x = -1; x <= 1; x++)
        mesh(
          new THREE.BoxGeometry(0.94, 0.025, 0.98),
          night ? '#56617a' : '#f1edd7',
          [x * 1.03, 0.055, z],
          scene,
        );
  if (!night) garden(scene, radius, definition, updates);
  else {
    // Side terraces keep the promenade and checkpoint course clear.
    for (const radius of [5.8, 10.5]) {
      mesh(new THREE.TorusGeometry(radius, 0.025, 6, 96), '#ba9e68', [0, 0.05, 0], scene).rotation.x =
        Math.PI / 2;
    }
    mesh(new THREE.CylinderGeometry(2.7, 2.9, 0.24, 32), '#56617c', [6.6, 0.12, -4], scene);
    const telescope = new THREE.Group();
    telescope.name = 'Brass telescope';
    telescope.position.set(6.6, 0.24, -4);
    scene.add(telescope);
    mesh(new THREE.CylinderGeometry(0.32, 0.55, 1.6, 16), '#b49a67', [0, 0.8, 0], telescope);
    const tube = new THREE.Group();
    tube.position.set(0, 1.9, 0);
    tube.rotation.x = Math.PI / 3;
    tube.rotation.z = -0.35;
    telescope.add(tube);
    mesh(new THREE.CylinderGeometry(0.4, 0.32, 2.8, 24), '#c7ad73', [0, 0.4, 0], tube);
    for (const y of [-0.85, 1.65])
      mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.16, 24), '#e4d0a0', [0, y, 0], tube);
    mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.025, 24), '#709ed2', [0, 1.74, 0], tube, true);
    mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 12), '#344357', [0, -1.15, 0], tube);
    for (const z of [-5.5, -2.5]) {
      mesh(new THREE.BoxGeometry(2.8, 0.3, 0.8), '#514965', [-7, 0.6, z], scene);
      mesh(new THREE.BoxGeometry(2.8, 0.6, 0.18), '#78708d', [-7, 0.95, z - 0.35], scene);
    }
    for (let i = 0; i < 20; i++) {
      const angle = (i * Math.PI * 2) / 20;
      const x = Math.sin(angle) * 11.5,
        z = Math.cos(angle) * 11.5;
      mesh(new THREE.CylinderGeometry(0.11, 0.16, 1.15, 8), '#756584', [x, 0.58, z], scene);
      mesh(new THREE.SphereGeometry(0.17, 8, 6), '#ffe1aa', [x, 1.24, z], scene, true);
      const rail = mesh(
        new THREE.BoxGeometry(3.4, 0.07, 0.08),
        '#a796ad',
        [Math.sin(angle + Math.PI / 20) * 11.35, 0.95, Math.cos(angle + Math.PI / 20) * 11.35],
        scene,
      );
      rail.rotation.y = angle + Math.PI / 20;
    }
    for (const [x, z, height] of [
      [-9, -7, 2.2],
      [9, -7, 2.2],
      [-9, 3, 1.4],
      [9, 3, 1.4],
    ]) {
      mesh(new THREE.CylinderGeometry(0.65, 0.85, height, 6), '#4a5374', [x, height / 2, z], scene);
      mesh(new THREE.IcosahedronGeometry(0.55, 0), '#ae9bff', [x, height + 0.4, z], scene, true);
      const light = new THREE.PointLight('#957dff', 10, 8);
      light.position.set(x, height, z);
      scene.add(light);
    }
    const stars = new THREE.BufferGeometry(),
      positions = [];
    for (let i = 0; i < 350; i++) {
      const a = i * 2.399963,
        h = 8 + (i % 31) * 0.9,
        r = 25 + (i % 17);
      positions.push(Math.sin(a) * r, h, Math.cos(a) * r);
    }
    stars.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: '#d4dcff', size: 0.075 })));
    const moon = mesh(new THREE.SphereGeometry(2.2, 24, 16), '#d4d4ef', [-12, 15, -22], scene, true);
    moon.castShadow = false;
    mesh(new THREE.TorusGeometry(3, 0.04, 6, 48), '#8a84b7', [-12, 15, -22], scene).rotation.x = 0.8;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      mesh(new THREE.OctahedronGeometry(0.3, 0), '#7689b4', [Math.sin(a) * 9, 0.5, Math.cos(a) * 9], scene);
    }
  }
  const placements = definition?.portals ?? [
    { target: destinations[0]?.id ?? '', position: { x: 0, y: 0, z: -7.5 } },
  ];
  const pathPavers: Placement[] = [],
    pathEdges: Placement[] = [];
  const portals = placements.map((placement) => {
    const color =
      destinations.find((w) => w.id === placement.target)?.accent ?? (night ? '#abedb5' : '#9681f2');
    const portal = new THREE.Group();
    portal.name = `Portal: ${placement.target}`;
    portal.position.set(0, 1.65, -7.5);
    scene.add(portal);
    const frame = mesh(
      new THREE.TorusGeometry(1.5, 0.16, 12, 64),
      night ? '#d6c3ff' : '#45695f',
      [0, 0, 0],
      portal,
    );
    frame.material.metalness = 0.36;
    frame.material.roughness = 0.38;
    mesh(new THREE.TorusGeometry(1.64, 0.028, 6, 64), night ? '#9986c0' : '#c6aa7a', [0, 0, 0], portal);
    const innerRing = mesh(new THREE.TorusGeometry(1.3, 0.027, 6, 64), color, [0, 0, 0.06], portal, true);
    mesh(
      new THREE.CylinderGeometry(2.02, 2.2, 0.16, 48),
      night ? '#655a87' : '#c2ad90',
      [0, -1.56, 0],
      portal,
    );
    mesh(
      new THREE.CylinderGeometry(1.87, 1.9, 0.035, 48),
      night ? '#847298' : '#e6d2b2',
      [0, -1.46, 0],
      portal,
    );
    const threshold = mesh(new THREE.TorusGeometry(1.72, 0.018, 5, 64), color, [0, -1.43, 0], portal, true);
    threshold.rotation.x = Math.PI / 2;
    const masonry: Placement[] = [],
      seams: Placement[] = [];
    for (let i = 0; i < 12; i++) {
      masonry.push({
        position: [0, -1.46, 0],
        rotation: [0, (i * Math.PI) / 6, 0],
        color: night ? (i % 2 ? '#857499' : '#9586a5') : i % 2 ? '#cfbb98' : '#e0cba9',
      });
      if (i % 2 === 0) {
        const angle = (i * Math.PI) / 6;
        seams.push({ position: [Math.sin(angle) * 1.5, Math.cos(angle) * 1.5, 0], rotation: [0, 0, -angle] });
      }
    }
    instances(arcSlab(1.91, 2.13, 0.025, 0, Math.PI / 6 - 0.025), '#ffffff', masonry, portal).castShadow =
      false;
    instances(
      new RoundedBoxGeometry(0.055, 0.31, 0.36, 1, 0.02),
      night ? '#c0adcc' : '#c3a474',
      seams,
      portal,
    );
    const veil = new THREE.Mesh(
      new THREE.CircleGeometry(1.27, 48),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: { color: { value: new THREE.Color(color) }, time: { value: 0 } },
        vertexShader: `varying vec2 coord;
          void main() { coord = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 color; uniform float time; varying vec2 coord;
          void main() {
            float r = length(coord);
            float edge = smoothstep(0.55, 1.0, r);
            float wave = sin(r * 19.0 - time * 0.9 + sin(coord.y * 5.0 + time * 0.3)) * 0.5 + 0.5;
            float horizon = smoothstep(-0.5, 0.7, coord.y);
            vec3 shade = mix(color * 0.38, color + vec3(0.23), horizon);
            shade += wave * edge * 0.12;
            gl_FragColor = vec4(shade, (0.26 + edge * 0.4 + wave * 0.05) * (1.0 - smoothstep(0.97, 1.0, r)));
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    veil.position.z = 0.025;
    portal.add(veil);
    const orbit = new THREE.Group();
    orbit.userData.minQuality = 'medium';
    portal.add(orbit);
    const orbitPlacements: Placement[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      orbitPlacements.push({
        position: [Math.sin(a) * 1.34, Math.cos(a) * 1.34, 0.12],
        rotation: [0, 0, -a],
        scale: [0.7, i % 4 === 0 ? 1.8 : 0.7, 0.7],
      });
    }
    const motes = instances(new THREE.OctahedronGeometry(0.055, 0), '#fff3d6', orbitPlacements, orbit);
    (motes.material as THREE.MeshStandardMaterial).emissive.set(color);
    (motes.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1;
    motes.castShadow = false;
    portal.position.set(placement.position.x, placement.position.y + 1.65, placement.position.z);
    if (id === 'world-a') {
      const end = new THREE.Vector3(placement.position.x, 0.055, placement.position.z);
      const start = new THREE.Vector3(0, 0.055, 1);
      const path = mesh(
        new THREE.BoxGeometry(2.05, 0.028, start.distanceTo(end)),
        '#eddbbd',
        start.clone().lerp(end, 0.5).toArray(),
        scene,
      );
      path.rotation.y = Math.atan2(end.x - start.x, end.z - start.z);
      const length = start.distanceTo(end),
        angle = path.rotation.y;
      const direction = end.clone().sub(start).normalize();
      const across = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
      const steps = Math.max(1, Math.ceil(length / 0.78));
      for (let row = 0; row < steps; row++) {
        const center = start.clone().lerp(end, (row + 0.5) / steps);
        // The shared courtyard has its own stone courses; start paths at its outer edge.
        if (Math.hypot(center.x, center.z - 2) < 4.62) continue;
        for (let column = -1; column <= 1; column++) {
          const position = center.clone().addScaledVector(across, column * 0.66);
          pathPavers.push({
            position: [position.x, 0.076, position.z],
            scale: [0.635, 0.028, length / steps - 0.035],
            rotation: [0, angle, 0],
            color: ['#d5c5a9', '#e6d7bb', '#cbbda4'][(row + column + 3) % 3],
          });
        }
        for (const side of [-1, 1]) {
          const position = center
            .clone()
            .addScaledVector(across, side * 1.1)
            .addScaledVector(direction, 0.005);
          pathEdges.push({
            position: [position.x, 0.07, position.z],
            scale: [0.13, 0.075, length / steps - 0.022],
            rotation: [0, angle, 0],
          });
        }
      }
    }
    updates.push((time: number) => {
      innerRing.rotation.z = time * 0.2;
      if (orbit.visible) orbit.rotation.z = time * 0.08;
      veil.material.uniforms.time.value = time;
    });
    return portal;
  });
  if (pathPavers.length) {
    instances(new THREE.BoxGeometry(1, 1, 1), '#ffffff', pathPavers, scene).castShadow = false;
    instances(new THREE.BoxGeometry(1, 1, 1), '#a4ab93', pathEdges, scene).castShadow = false;
  }
  const motionPreference =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  return {
    scene,
    portal: portals[0] ?? new THREE.Group(),
    portalPosition: new THREE.Vector3().copy(placements[0]?.position ?? { x: 0, y: 0, z: 0 }),
    update(time: number) {
      updates.forEach((update) => update(motionPreference?.matches ? 0 : time));
    },
  };
}
export function rendererFor(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.append(renderer.domElement);
  return renderer;
}
export function worldPreview(container: HTMLElement, id: string, destinations: World[] = []) {
  const definition = defaultDefinition(
    id,
    id,
    destinations.length ? destinations.map((w) => w.id) : [id === 'world-a' ? 'world-b' : 'world-a'],
  );
  if (id === 'world-a' && destinations.length) definition.portals = hubPortals(destinations.map((w) => w.id));
  const world = buildWorld(id, definition, destinations),
    renderer = rendererFor(container),
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  const quality = createGraphicsQuality(renderer, world.scene, container);
  camera.position.set(15, 13, 18);
  camera.lookAt(0, 0, -1);
  const resize = new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.render(world.scene, camera);
  });
  resize.observe(container);
  return () => {
    quality.dispose();
    resize.disconnect();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    world.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) {
        const m = o as THREE.Mesh;
        geometries.add(m.geometry);
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat);
      }
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      if ((o as THREE.Light).isLight) (o as THREE.Light & { shadow?: { dispose(): void } }).shadow?.dispose();
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    world.scene.clear();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
