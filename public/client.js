import { startWorld, buildWorld, THREE } from '/client/runtime/three.js';
await startWorld({
  createScene(definition) {
    const world = buildWorld(definition.id);
    world.scene.background = new THREE.Color('#9fc9d2');
    const beacon = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.8),
      new THREE.MeshStandardMaterial({ color: '#67dfd0', roughness: 0.85 }),
    );
    beacon.position.set(-3, 2, 0);
    world.scene.add(beacon);
    const update = world.update;
    world.update = (time) => {
      update(time);
      beacon.rotation.y = time * 0.35;
    };
    return world;
  },
});
