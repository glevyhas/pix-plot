/**
* Globals
**/

// Initialize global data stores for image data
var imageData = {};
var imageDataKeys = [];

// Identify data endpoint
var dataUrl = 'http://localhost:5000/output/';

// Create global stores for image and atlas sizes
var sizes = {
  image: {
    width: 32,
    height: 32
  },
  atlas: {
    width: 2048,
    height: 2048,
    cols: 2048 / 32,
    rows: 2048 / 32
  }
}

// Create a store for the load progress. Data structure:
// {atlas0: percentLoaded, atlas1: percentLoaded}
var loadProgress = {};

// Create a store for the 32px and 64px atlas materials
var materials = {
  32: [],
  64: []
}

// Count of 32px and 64px atlas files to fetch
var atlasCount = 7;
var largeAtlasCount = atlasCount * 4;

// Create a store for meshes
var meshes = [];

// Many graphics cards only support 2**16 vertices per mesh,
// and each image requires 4 distinct vertices
var imagesPerMesh = 2**14;

/**
* Scene
**/

var scene = new THREE.Scene();
scene.background = new THREE.Color( 0x111111 );

/**
* Camera
**/

// Specify the portion of the scene visiable at any time (in degrees)
var fieldOfView = 75;

// Specify the camera's aspect ratio
var aspectRatio = window.innerWidth / window.innerHeight;

/*
Specify the near and far clipping planes. Only objects
between those planes will be rendered in the scene
(these values help control the number of items rendered
at any given time); see https://threejs.org/docs/#api/math/Frustum
*/
var nearPlane = 100;
var farPlane = 50000;

// Use the values specified above to create a camera
var camera = new THREE.PerspectiveCamera(
  fieldOfView, aspectRatio, nearPlane, farPlane
);

// Finally, set the camera's position {x, y, z}
camera.position.set(0, -1000, 12000);

/**
* Lights
**/

// Add a point light with #fff color, .7 intensity, and 0 distance
var light = new THREE.PointLight( 0xffffff, 1, 0 );

// Specify the light's position
light.position.set( 1, 1, 100 );

// Add the light to the scene
scene.add( light )

/**
* Renderer
**/

// Create the canvas with a renderer
var renderer = new THREE.WebGLRenderer({ antialias: true });

// Add support for retina displays
renderer.setPixelRatio( window.devicePixelRatio );

// Specify the size of the canvas
renderer.setSize( window.innerWidth, window.innerHeight );

// Add the canvas to the DOM
document.body.appendChild( renderer.domElement );

/**
* Load Image Position Data
**/

// Load the image position JSON file
var fileLoader = new THREE.FileLoader();
var url = dataUrl + 'tsne_image_positions.json';
fileLoader.load(url, function(data) {
  setImageData( JSON.parse(data) );
  maybeBuildGeometries()
})

/**
* Pluck out the image data for each image in the incoming JSON then call
* helper functions to build the global data structures that store each
* image's data
**/

function setImageData(json) {
  json.forEach(function(img, idx) {
    var img = parseImage(img);
    // Store a sorted list of the imageData keys
    imageDataKeys.push(img.name);
    // Update the global data store with this image's data
    imageData[img.name] = getImageData(img, idx);
  })
}

/**
* Generate all data for each image. Specifically, set:
*   idx: the image index position in the list of all images
*   width: the image's width within a 32px cell
*   height: the image's height within a 32px cell
*   xOffset: the image's left offset within a 32px cell
*   yOffset: the image's top offset within a 32px cell
*   pos:
*     x: the x position of the image in the chart space
*     y: the y position of the image in the chart space
*     z: the z position of the image in the chart space
*   atlas:
*     idx: the index position of the image in its atlas
*     row: the row in which the image occurs in its atlas
*     col: the col in which the image occurs in its atlas
*   uv:
*     w: the relative width of the image within its atlas {0:1}
*     h: the relative height of the image within its atlas {0:1}
*     x: the relative left offset of the image within its atlas {0:1}
*     y: the relative top offset of the image within its atlas {0:1}
*     face: the face in which these uv coords should be stored in the mesh
*   material:
*     idx: the index position of this image's material within the image's mesh
*   mesh:
*     idx: the index position of this image's mesh among all meshes
**/

function getImageData(img, idx) {
  // Get image position information
  var position = getImagePositionData(img, idx);
  // Get atlas information for this image
  var atlas = getImageAtlasData(idx);
  // Get image uv position for this image
  var uv = getImageUvData(img, idx, atlas);
  // Get the index position of the material within this image's mesh
  var material = getImageMaterialData(idx);
  // Get the index position of this image's mesh among all meshes
  var mesh = getImageMeshData(idx);
  // Return the image data to the parent function
  return {
    idx: idx,
    width: img.width,
    height: img.height,
    xOffset: img.xOffset,
    yOffset: img.yOffset,
    atlas: atlas,
    pos: position,
    uv: uv,
    material: material,
    mesh: mesh,
  }
}

/**
* Identify the following attributes for the image:
*   name: the image's name without extension
*   x: the image's unscaled X dimension position in chart coordinates
*   y: the image's unscaled Y dimension position in chart coordinates
*   width: the width of the image within its cell in the current atlas size
*   height: the height of the image within its cell in the current atlas size
*   xOffset: the image's left offset from its cell boundaries
*   yOffest: the image's top offset from its cell boundaries
**/

function parseImage(img) {
  return {
    name: img[0],
    x: img[1],
    y: img[2],
    width: img[3],
    height: img[4],
    xOffset: (sizes.image.width - img[3])/2,
    yOffset: (sizes.image.height - img[4])/2
  }
}

/**
* Identify the following image position attributes for an image:
*   x: the image's scaled X position within the chart space
*   y: the image's scaled Y position within the chart space
*   z: the image's scaled Z position within the chart space
**/

function getImagePositionData(img, idx) {
  return {
    x: img.x * 15,
    y: img.y * 12,
    z: 2000 + (idx/100),
  }
}

/**
* Identify the following atlas attributes for an image:
*   index: the index position of the atlas in which the image appears
*   row: the row within the atlas where the image appears
*   col: the col within the atlas where the image appears
**/

function getImageAtlasData(imageIndex) {
  var imageIndexInAtlas = imageIndex % (sizes.atlas.rows * sizes.atlas.cols);
  return {
    index: Math.floor(imageIndex / (sizes.atlas.rows * sizes.atlas.cols)),
    row: Math.floor(imageIndexInAtlas / sizes.atlas.rows),
    col: imageIndexInAtlas % sizes.atlas.cols,
  }
}

/**
* Identify the following uv attributes for an image:
*   w: the relative width of this image within its atlas {0:1}
*   h: the relative height of this image within its atlas {0:1}
*   x: the left offset of this image within its atlas {0:1}
*   y: the top offset of this image within its atlas {0:1}
*   face: the index position of this image's face within its mesh
**/

function getImageUvData(img, idx, atlas) {
  // Store the relative width and height of each cell in an atlas
  var cellWidth = sizes.image.width / sizes.atlas.width;
  var cellHeight = sizes.image.height / sizes.atlas.height;
  return {
    w: img.width / sizes.atlas.width,
    h: img.height / sizes.atlas.height,
    x: ((atlas.col) * cellWidth) + (img.xOffset / sizes.atlas.width),
    y: (1 - (atlas.row * cellHeight) - cellHeight) + (img.yOffset / sizes.atlas.height),
    face: (idx % imagesPerMesh) * 2,
  }
}

/**
* Identify the following material attributes for an image:
*   idx: the index position of the image's material within the list of materials
*     assigned to the image's mesh
**/

function getImageMaterialData(idx) {
  return {
    idx: Math.floor( (idx % imagesPerMesh) / (sizes.atlas.rows * sizes.atlas.cols) )
  }
}

/**
* Identify the following mesh attributes for an image:
*   idx: the index position of the image's mesh among all meshes
**/

function getImageMeshData(idx) {
  return {
    idx: Math.floor(idx / imagesPerMesh)
  }
}

/**
* Load Atlas Textures
**/

// Create a texture loader so we can load our image files
var textureLoader = new AjaxTextureLoader();

function loadAtlasFiles() {
  for (var i=0; i<atlasCount; i++) {
    textureLoader.load(dataUrl + 'atlas_files/32px/atlas-' + i + '.jpg',
      handleTexture.bind(null, i), onProgress.bind(null, i))
  }
}

function onProgress(atlasIndex, xhr) {
  loadProgress[atlasIndex] = xhr.loaded / xhr.total;
  // Sum the total load progress among all atlas files
  var sum = Object.keys(loadProgress).reduce(function (sum, key) {
    return sum + loadProgress[key];
  }, 0);
  // Update or hide the loader
  var loader = document.querySelector('#loader');
  var progress = sum / atlasCount;
  progress < 1
    ? loader.innerHTML = parseInt(progress * 100) + '%'
    : loader.style.display = 'none';
}

// Create a material from the new texture and call
// the geometry builder if all textures have loaded 
function handleTexture(textureIndex, texture) {
  var material = new THREE.MeshBasicMaterial({ map: texture });
  materials['32'][textureIndex] = material;
  maybeBuildGeometries(textureIndex);
}

// If the textures and the mapping from image index
// to image position are loaded, create the geometries
function maybeBuildGeometries(textureIndex) {
  if (Object.keys(materials['32']).length === atlasCount && imageData) {
    buildGeometry();
  }
}

/**
* Build Image Geometry
**/

// Iterate over the textures in the current texture set
// and for each, add a new mesh to the scene
function buildGeometry() {
  var meshCount = Math.ceil( imageDataKeys.length / imagesPerMesh );
  for (var i=0; i<meshCount; i++) {
    var geometry = new THREE.Geometry();
    var meshImages = imageDataKeys.slice(i*imagesPerMesh, (i+1)*imagesPerMesh);
    for (var j=0; j<meshImages.length; j++) {
      var datum = imageData[ meshImages[j] ];
      geometry = updateVertices(geometry, datum);
      geometry = updateFaces(geometry);
      geometry = updateFaceVertexUvs(geometry, datum);
    }
    var startMaterial = imageData[ meshImages[0] ].atlas.index;
    var endMaterial = imageData[ meshImages[j-1] ].atlas.index;
    buildMesh(geometry, materials['32'].slice(startMaterial, endMaterial + 1));
  }
  loadLargeAtlasFiles();
}

/**
* Add one vertex for each corner of the image, using the 
* following order: lower left, lower right, upper right, upper left
**/

function updateVertices(geometry, img) {
  geometry.vertices.push(
    new THREE.Vector3(
      img.pos.x,
      img.pos.y,
      img.pos.z
    ),
    new THREE.Vector3(
      img.pos.x + (img.width * 2),
      img.pos.y,
      img.pos.z
    ),
    new THREE.Vector3(
      img.pos.x + (img.width * 2),
      img.pos.y + (img.height * 2),
      img.pos.z
    ),
    new THREE.Vector3(
      img.pos.x,
      img.pos.y + (img.height * 2),
      img.pos.z
    )
  );
  return geometry;
}

/**
* Add two new faces to the geometry per subimage
**/

function updateFaces(geometry) {
  geometry.faces.push(
    // Add the first face (the lower-right triangle)
    new THREE.Face3(
      geometry.vertices.length-4,
      geometry.vertices.length-3,
      geometry.vertices.length-2
    ),
    // Add the second face (the upper-left triangle)
    new THREE.Face3(
      geometry.vertices.length-4,
      geometry.vertices.length-2,
      geometry.vertices.length-1
    )
  )
  return geometry;
}

/**
* Specify the face vertext uvs for each face of the image
**/

function updateFaceVertexUvs(geometry, img) {
  var uv = img.uv;
  // Use .set() if the given faceVertex is already defined; see:
  // https://github.com/mrdoob/three.js/issues/7179
  if (geometry.faceVertexUvs[0][uv.face]) {
    geometry.faceVertexUvs[0][uv.face][0].set(uv.x, uv.y)
    geometry.faceVertexUvs[0][uv.face][1].set(uv.x + uv.w, uv.y)
    geometry.faceVertexUvs[0][uv.face][2].set(uv.x + uv.w, uv.y + uv.h)
  } else {
    geometry.faceVertexUvs[0][uv.face] = [
      new THREE.Vector2(uv.x, uv.y),
      new THREE.Vector2(uv.x + uv.w, uv.y),
      new THREE.Vector2(uv.x + uv.w, uv.y + uv.h)
    ]
  }
  // Map the region of the image described by the lower-left, 
  // upper-right, and upper-left vertices to `faceTwo`
  if (geometry.faceVertexUvs[0][uv.face + 1]) {
    geometry.faceVertexUvs[0][uv.face + 1][0].set(uv.x, uv.y)
    geometry.faceVertexUvs[0][uv.face + 1][1].set(uv.x + uv.w, uv.y + uv.h)
    geometry.faceVertexUvs[0][uv.face + 1][2].set(uv.x, uv.y + uv.h)
  } else {
    geometry.faceVertexUvs[0][uv.face + 1] = [
      new THREE.Vector2(uv.x, uv.y),
      new THREE.Vector2(uv.x + uv.w, uv.y + uv.h),
      new THREE.Vector2(uv.x, uv.y + uv.h)
    ]
  }
  // Set the material index for the new faces
  geometry.faces[uv.face].materialIndex = img.material.idx;
  geometry.faces[uv.face + 1].materialIndex = img.material.idx;
  return geometry;
}

/**
* Add a new mesh to the scene
**/

function buildMesh(geometry, materials) {
  // Combine the image geometry and material list into a mesh
  var mesh = new THREE.Mesh(geometry, materials);
  // Store the index position of the image and the mesh
  mesh.userData.meshIndex = meshes.length;
  // Set the position of the image mesh in the x,y,z dimensions
  mesh.position.set(0,0,0)
  // Add the image to the scene
  scene.add(mesh);
  // Save this mesh
  meshes.push(mesh);
}

/**
* Functions to load large atlas files
**/

function loadLargeAtlasFiles() {
  // Update the global sizes object
  sizes.image = {
    width: 64,
    height: 64
  }
  sizes.atlas = {
    width: 2048,
    height: 2048,
    cols: 2048 / 64,
    rows: 2048 / 64
  }
  for (var i=0; i<largeAtlasCount; i++) {
    var url = dataUrl + 'atlas_files/64px/atlas-' + i + '.jpg';
    textureLoader.load(url, handleLargeTexture.bind(null, i))
  }
}

function handleLargeTexture(atlasIndex, texture) {
  var material = new THREE.MeshBasicMaterial({ map: texture });
  materials['64'][atlasIndex] = material;
  updateImages(atlasIndex)
}

function updateImages(atlasIndex) {
  // Identify the number of images within a larger atlas file
  var imagesPerAtlas = sizes.atlas.cols * sizes.atlas.rows;
  // Identify the number of larger atlas files per mesh
  var atlasFilesPerMesh = imagesPerMesh / imagesPerAtlas;
  // Identify the mesh to which this atlas should be added
  var meshIndex = Math.floor( atlasIndex / atlasFilesPerMesh );
  // Identify the index position for the new atlas file
  var materialIndex = meshes[meshIndex].material.length;
  // Add the new atlas to its mesh
  meshes[meshIndex].material.push( materials['64'][atlasIndex] )
  // Request an update for this material
  meshes[meshIndex].material[materialIndex].needsUpdate = true;
  // Grab the geometry to which we added the new atlas
  var geometry = meshes[meshIndex].geometry;
  // Retrieve an object that describes the images in the new atlas
  getAtlasImages(atlasIndex, materialIndex).forEach(function(img) {
    // Update the faceVertexUvs for each image to be updated
    geometry = updateFaceVertexUvs(geometry, img);
  })
  meshes[meshIndex].geometry = geometry;
  meshes[meshIndex].geometry.uvsNeedUpdate = true;
  meshes[meshIndex].geometry.groupsNeedUpdate = true;
  meshes[meshIndex].geometry.verticesNeedUpdate = true;
}

/**
* Find all images in a larger image atlas and update their properties
**/

function getAtlasImages(atlasIdx, materialIdx) {
  // Compute the number of images in each larger atlas
  var imgsPerAtlas = sizes.atlas.rows * sizes.atlas.cols;
  // Find the index positions of the first and last images in this atlas
  var startImage = atlasIdx * imgsPerAtlas;
  var endImage = (atlasIdx + 1) * imgsPerAtlas;
  // Return a list of images in this atlas after updating the attributes of each
  var images = [];
  imageDataKeys.slice(startImage, endImage).forEach(function(d) {
    // Fetch this image from the global image store & copy to avoid mutations
    var img = Object.assign({}, imageData[d]);
    // Update the height, width, and x,y offsets for the image
    img.width *= 2;
    img.height *= 2;
    img.xOffset *= 2;
    img.yOffset *= 2;
    // Get atlas information for this image
    var atlas = getImageAtlasData(img.idx);
    // Get image uv position for this image
    var uv = getImageUvData(img, img.idx, atlas);
    // Get the index position of the material within this image's mesh
    var material = {idx: materialIdx}
    // Update the image's data attributes
    img.atlas = atlas;
    img.uv = uv;
    img.material = material;
    images.push(img);
    imageData[ imageDataKeys[img.idx] ] = img;
  })
  return images;
}

/**
* Functions to load individual image files (unused)
**/

function loadImage(imageIndex) {
  if (!imagePositions[imageIndex]) return;
  var image = imagePositions[imageIndex].img;
  var url = dataUrl + '/64-thumbs/' + image + '.jpg';
  textureLoader.load(url, handleImage.bind(null, imageIndex))
}

function handleImage(imageIndex, image) {
  var material = new THREE.MeshBasicMaterial({ map: image });
  materials.image[imageIndex] = material;
  updateImageGeometry(imageIndex);
  loadImage(imageIndex+1);
}

function updateImageGeometry(imageIndex) {
  var atlasIndex = Math.floor(imageIndex / (sizes.atlas.rows * sizes.atlas.cols));
  var offsetIndex = Math.floor(imageIndex % (sizes.atlas.rows * sizes.atlas.cols));
  var faceIndex = offsetIndex * 2;
  // Update the material for this image
  meshes[atlasIndex].material[offsetIndex] = materials.image[imageIndex];
  meshes[atlasIndex].material[offsetIndex].needsUpdate = true;
  meshes[atlasIndex].material.needsUpdate = true;
  // Update the faceVertexUvs for the faces of this image
  meshes[atlasIndex].geometry.faceVertexUvs[0][faceIndex][0].set(0, 0)
  meshes[atlasIndex].geometry.faceVertexUvs[0][faceIndex][1].set(1, 0)
  meshes[atlasIndex].geometry.faceVertexUvs[0][faceIndex][2].set(1, 1)
  meshes[atlasIndex].geometry.faceVertexUvs[0][faceIndex + 1][0].set(0, 0)
  meshes[atlasIndex].geometry.faceVertexUvs[0][faceIndex + 1][1].set(1, 1)
  meshes[atlasIndex].geometry.faceVertexUvs[0][faceIndex + 1][2].set(0, 1)
  meshes[atlasIndex].geometry.faces[faceIndex].materialIndex = offsetIndex;
  meshes[atlasIndex].geometry.faces[faceIndex + 1].materialIndex = offsetIndex;
  meshes[atlasIndex].geometry.uvsNeedUpdate = true;
  meshes[atlasIndex].geometry.groupsNeedUpdate = true;
  meshes[atlasIndex].geometry.verticesNeedUpdate = true;
}

/**
* Add Controls
**/

var controls = new THREE.TrackballControls(camera, renderer.domElement);

/**
* Add Raycaster
**/

var raycaster = new THREE.Raycaster();
var mouse = new THREE.Vector2();
var lastMouse = new THREE.Vector2();
var selected = null;

function onMousemove(event) {
  // Calculate mouse position in normalized device coordinates
  // (-1 to +1) for the x and y axes
  mouse.x = ( event.clientX / window.innerWidth ) * 2 - 1;
  mouse.y = - ( event.clientY / window.innerHeight ) * 2 + 1;
  if (event.clientX < 100) {
    document.querySelector('nav').className = 'visible';
  }
}

// Capture the mousedown point so on mouseup we can determine
// whether user clicked or is dragging
function onMousedown(event) {
  lastMouse.copy( mouse );
}

function onMouseup(event) {
  // Determine which image is selected (if any)
  selected = raycaster.intersectObjects( scene.children );
  // Return if the user hasn't clicked anything or is dragging
  if (!selected.length || !(mouse.equals(lastMouse))) return;
  // The 0th member is closest to the camera
  selected = selected[0];
  // Identify the selected item's face within its parent mesh
  var faceIndex = selected.faceIndex;
  // Identify the selected item's mesh index
  var meshIndex = selected.object.userData.meshIndex;
  // rows * cols images per mesh, 2 faces per image
  var imageIndex = (meshIndex * (sizes.atlas.rows * sizes.atlas.cols)) + Math.floor(faceIndex / 2);
  // Store the image name in the url hash for reference
  window.location.hash = imageDataKeys[imageIndex];
  flyTo(
    selected.point.x,
    selected.point.y,
    selected.point.z
  );
}

// Move the camera to focus on the designated x, y, z location
function flyTo(x, y, z) {
  // x, y, z are the coordinates on which we'll focus the camera;
  // Specify the *location* to which we'll move the camera
  var target = {
    x: x,
    y: y,
    z: z + 800
  }
  // Save the initial camera quaternion so it can be used
  // as a starting point for the slerp
  var startQuaternion = camera.quaternion.clone();
  // Apply the tracking controls to a cloned dummy camera
  // so that the final quaternion can be computed
  var dummyCamera = camera.clone();
  dummyCamera.position.set(target.x, target.y, target.z);
  var dummyControls = new THREE.TrackballControls(dummyCamera);
  dummyControls.target.set(x, y, z);
  dummyControls.update();
  // Initialize the tween to animate from the current camera quaternion
  // to the final camera quaternion
  new TWEEN.Tween(camera.position)
    .to(target, 1000)
    .onUpdate(function(timestamp) {
      // Slerp the camera quaternion for smooth transition.
      // `timestamp` is the eased time value from the tween.
      THREE.Quaternion.slerp(startQuaternion, dummyCamera.quaternion, camera.quaternion, timestamp);
    })
    .onComplete(function() {
      controls.target = new THREE.Vector3(x, y, z)
    }).start();
}

var canvas = document.querySelector('canvas');
canvas.addEventListener('mousemove', onMousemove, false)
canvas.addEventListener('mousedown', onMousedown, false)
canvas.addEventListener('mouseup', onMouseup, false)

/**
* Add Click Listener to Images in Nav
**/

var nav = document.querySelector('nav');
var navImages = nav.querySelectorAll('.hotspot');
for (var i=0; i<navImages.length; i++) {
  navImages[i].addEventListener('click', onNavImageClick)
}

function onNavImageClick(event) {
  // Determine the mesh in which the clicked image occurs
  // Find the vertices of this image and zoom to them
  var attr = event.target.style.backgroundImage;
  var img = attr.substring(5, attr.length-2);
  var file = img.split('/')[ img.split('/').length - 1 ];
  var name = file.substring(0, file.lastIndexOf('.'));
  var coords = imageData[name].pos;
  document.querySelector('nav').className = 'hidden';
  setTimeout(function() {
    flyTo(coords.x, coords.y, coords.z);
  }, 500)
}

/**
* Handle window resizes
**/

window.addEventListener('resize', function() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize( window.innerWidth, window.innerHeight );
  controls.handleResize();
});

/**
* Render!
**/

// The main animation function that re-renders the scene each animation frame
function animate() {
requestAnimationFrame( animate );
  TWEEN.update();
  raycaster.setFromCamera( mouse, camera );
  renderer.render( scene, camera );
  controls.update();
}
animate();

/**
* Main
**/

// Initialize the requests that bootstrap the application
loadAtlasFiles()