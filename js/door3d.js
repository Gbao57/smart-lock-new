let scene, camera, renderer, doorGroup;
let isDoor3DOpen = false;
let is3DInitialized = false;

window.addEventListener('load', () => {
  init3DScene();
});

function init3DScene() {
  const canvas = document.getElementById('doorCanvas');
  if (!canvas) return;

  // Khi khung appContainer đang ẩn (display: none), clientWidth = 0 -> Dùng kích thước chuẩn dự phòng
  const width = canvas.clientWidth > 0 ? canvas.clientWidth : 410;
  const height = canvas.clientHeight > 0 ? canvas.clientHeight : 210;

  if (!is3DInitialized) {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 0, 7.5);

    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);

    // Ánh sáng
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // Khung bao cửa
    const frameGeo = new THREE.BoxGeometry(3.3, 5.2, 0.22);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    scene.add(frame);

    // Nhóm cánh cửa xoay quanh bản lề trái
    doorGroup = new THREE.Group();
    doorGroup.position.set(-1.4, 0, 0.02);

    const doorGeo = new THREE.BoxGeometry(2.8, 4.8, 0.16);
    const doorMat = new THREE.MeshStandardMaterial({
      color: 0x2563eb,
      metalness: 0.25,
      roughness: 0.45
    });
    const doorMesh = new THREE.Mesh(doorGeo, doorMat);
    doorMesh.position.set(1.4, 0, 0);
    doorGroup.add(doorMesh);

    // Tay nắm cửa màu vàng kim
    const handleGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.65, 16);
    const handleMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      metalness: 0.85,
      roughness: 0.2
    });
    const handle = new THREE.Mesh(handleGeo, handleMat);
    handle.position.set(2.4, 0, 0.16);
    doorGroup.add(handle);

    scene.add(doorGroup);
    is3DInitialized = true;
    animate3D();
  } else {
    resize3DCanvas();
  }
}

function resize3DCanvas() {
  const canvas = document.getElementById('doorCanvas');
  if (!canvas || !renderer || !camera) return;
  const width = canvas.clientWidth > 0 ? canvas.clientWidth : 410;
  const height = canvas.clientHeight > 0 ? canvas.clientHeight : 210;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function animate3D() {
  requestAnimationFrame(animate3D);
  if (doorGroup) {
    const targetAngle = isDoor3DOpen ? -Math.PI / 2.4 : 0;
    doorGroup.rotation.y += (targetAngle - doorGroup.rotation.y) * 0.1;
  }
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function update3DDoorState(locked) {
  isDoor3DOpen = !locked;
}

window.addEventListener('resize', resize3DCanvas);