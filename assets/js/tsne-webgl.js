/**
* Globals
**/

// Initialize global data stores for image data
var imageData = {};
var imageDataKeys = [];
var atlasImages = {}; // map from atlas index to images in atlas

// Identify data endpoint
var dataUrl = 'output/';

// Create global stores for image and atlas sizes
var sizes = {
  image: {
    width: 32,
    height: 32,
  },
  atlas: {
    width: 2048,
    height: 2048,
    cols: 2048 / 32,
    rows: 2048 / 32,
  }
}

// Count of images per atlas
var imagesPerAtlas = sizes.atlas.rows * sizes.atlas.cols;

// Count of 32px and 64px atlas files to fetch
var atlasCounts = { '32px': null, '64px': null }

// Create a store for the load progress. Data structure:
// {atlas0: percentLoaded, atlas1: percentLoaded}
var loadProgress = {};

// Store of the total initial load progress {0:1}
var progress = 0;

// Create a store for the 32px and 64 px atlas textures
var textures = { 32: [], 64: [] };

// Create a store for the 32px and 64px loaded canvases
var canvases = { 32: [], 64: [] };

// Texture loader for XHR requests
var textureLoader = new AjaxTextureLoader();

// Many graphics cards only support 2**16 vertices per mesh, and
// each image requires 4 distinct vertices in an 'indexed' geometry
// and 6 distinct vertices in a non-indexed geometry
var imagesPerMesh = 2**16 / 6;

// Create a store for meshes
var meshes = [];

// Object that tracks mouse position
var raycaster = new THREE.Raycaster();

// Store of current mouse coordinates
var mouse = new THREE.Vector2();

// Store of previous mouse coordinates
var lastMouse = new THREE.Vector2();

// Store of the currently selected image
var selected = null;

/**
* Generate  scene object with a background color
**/

function getScene() {
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xaaaaaa);
  return scene;
}

/**
* Generate the camera to be used in the scene. Camera args:
*   [0] field of view: identifies the portion of the scene
*     visible at any time (in degrees)
*   [1] aspect ratio: identifies the aspect ratio of the
*     scene in width/height
*   [2] near clipping plane: objects closer than the near
*     clipping plane are culled from the scene
*   [3] far clipping plane: objects farther than the far
*     clipping plane are culled from the scene
**/

function getCamera() {
  var aspectRatio = window.innerWidth / window.innerHeight;
  var camera = new THREE.PerspectiveCamera(75, aspectRatio, 10, 50000);
  camera.position.set(0, -1000, 5000);
  return camera;
}

/**
* Generate the renderer to be used in the scene
**/

function getRenderer() {
  // Create the canvas with a renderer
  var renderer = new THREE.WebGLRenderer({antialias: true});
  // Add support for retina displays
  renderer.setPixelRatio(window.devicePixelRatio);
  // Specify the size of the canvas
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Add the canvas to the DOM
  document.body.appendChild(renderer.domElement);
  return renderer;
}

/**
* Generate the controls to be used in the scene
* @param {obj} camera: the three.js camera for the scene
* @param {obj} renderer: the three.js renderer for the scene
**/

function getControls(camera, renderer) {
  var controls = new THREE.TrackballControls(camera, renderer.domElement);
  controls.zoomSpeed = 0.4;
  controls.panSpeed = 0.4;
  return controls;
}

/**
* Make an XHR get reqeust for data
*
* @param {str} url: the url of the data to fetch
* @param {func} handleSuccess: onSuccess callback function
**/

function get(url, handleSuccess, handleErr) {
  var xmlhttp = new XMLHttpRequest();
  xmlhttp.onreadystatechange = function() {
    if (xmlhttp.readyState == XMLHttpRequest.DONE) {
      if (xmlhttp.status === 200) {
        if (handleSuccess) handleSuccess(xmlhttp.responseText)
      } else {
        if (handleErr) handleErr(xmlhttp)
      }
    };
  };
  xmlhttp.open('GET', url, true);
  xmlhttp.send();
};

/**
* Load image positional data, and once it arrives parse
* the image data, render the hotspots and conditionally
* build the 32px geometries
**/

function loadData() {
  get(dataUrl + 'plot_data.json', function(data) {
    var data = JSON.parse(data);
    // Set the atlas counts
    atlasCounts = data.atlas_counts;
    // Load the atlas files
    loadAtlasFiles()
    // Process the image positions
    setImageData(data.positions);
    // Render the hotspots
    renderHotspots(data.centroids);
    // Create the geometries if all data has loaded
    startIfReady();
  })
}

/**
* Add positional data for each image in `json` to
* `imageData` and `imageDataKeys`
*
* @param {arr} json: a list of objects, each of which
* describes positional information for an image
**/

function setImageData(json) {
  json.forEach(function(img, idx) {
    var img = parseImage(img);
    // Store a sorted list of the imageData keys
    imageDataKeys.push(img.name);
    // Update the global data store with this image's data
    imageData[img.name] = getImageData(img, idx);
    // Add this image to the list of images for the atlas to which it belongs
    var data = imageData[img.name];
    atlasImages[data.atlas.idx] = atlasImages[data.atlas.idx] || {};
    atlasImages[data.atlas.idx][img.name] = data;
  })
}

/**
* Identify the following attributes for an image:
*   name: the image's name without extension
*   x: the image's unscaled X dimension position in chart coordinates
*   y: the image's unscaled Y dimension position in chart coordinates
*   width: the width of the image within its cell in the current atlas size
*   height: the height of the image within its cell in the current atlas size
*   xOffset: the image's left offset from its cell boundaries
*   yOffest: the image's top offset from its cell boundaries
*
* @param {obj} img: an image object returned from parseImage()
* @returns: {obj} an object detailing the positional information
*   of an image expressed within `imageData`
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
*
* @param {obj} img: an image object returned from parseImage()
* @param {int} idx: the index position of an image among
*   all images
* @returns: {obj} an object detailing all positional information of
*   an image
**/

function getImageData(img, idx) {
  // Get atlas information for this image
  var atlas = getImageAtlasData(idx);
  // Get image position information
  var position = getImagePositionData(img, idx);
  // Get image uv position for this image
  var uv = getImageUvData(img, idx, atlas);
  // Get the index position of the texture within this image's mesh
  var texture = getImageTextureData(idx);
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
    texture: texture,
    mesh: mesh,
  }
}

/**
* Identify the following image position attributes for an image:
*   x: the image's scaled X position within the chart space
*   y: the image's scaled Y position within the chart space
*   z: the image's scaled Z position within the chart space
*
* @param {obj} img: an image object with `x`, `y` properties
* @param {int} idx: the index position of an image among
*   all images
* @returns: {obj} an object detailing the x,y,z position
*   of the image expressed in chart coordinates
**/

function getImagePositionData(img, idx) {
  return {
    x: img.x * 1.5,
    y: img.y * 1.2,
    z: 2000 + ((idx/100) % 100),
  }
}

/**
* Identify the following atlas attributes for an image:
*   index: the index position of the atlas in which the image appears
*   row: the row within the atlas where the image appears
*   col: the col within the atlas where the image appears
*
* @param {int} idx: the index position of an image among all images
* @returns {obj}: an object identifying the image's atlas data
**/

function getImageAtlasData(idx) {
  var indexInAtlas = idx % (imagesPerAtlas);
  return {
    idx: Math.floor(idx / (imagesPerAtlas)),
    row: Math.floor(indexInAtlas / sizes.atlas.rows),
    col: indexInAtlas % sizes.atlas.cols,
  }
}

/**
* Identify the following uv attributes for an image:
*   w: the relative width of this image within its atlas {0:1}
*   h: the relative height of this image within its atlas {0:1}
*   x: the left offset of this image within its atlas {0:1}
*   y: the top offset of this image within its atlas {0:1}
*   face: the index position of this image's face within its mesh
*
* @param {obj} img: an image object with `width`, `height`,
*   `xOffset`, `yOffset` properties
* @param {int} idx: the index position of an image among
*   all images
* @returns {obj} an object detailing the image's uv parameters
**/

function getImageUvData(img, idx, atlas) {
  // Store the relative width and height of each cell in an atlas
  var cellWidth = sizes.image.width / sizes.atlas.width;
  var cellHeight = sizes.image.height / sizes.atlas.height;
  return {
    w: img.width / sizes.atlas.width,
    h: img.height / sizes.atlas.height,
    x: ((atlas.col) * cellWidth) + (img.xOffset / sizes.atlas.width),
    y: (1 - (atlas.row * cellHeight) - cellHeight),
    face: (idx % imagesPerMesh) * 2,
  }
}

/**
* Identify the following texture attributes for an image:
*   idx: the index position of the image's texture within the list of textures
*     assigned to the image's mesh
*
* @param {int} idx: the index position of an image among
*   all images
* @returns {obj} an object detailing the image's texture index within
*   the image's mesh
**/

function getImageTextureData(idx) {
  return {
    idx: Math.floor( (idx % imagesPerMesh) / (imagesPerAtlas) )
  }
}

/**
* Identify the following mesh attributes for an image:
*   idx: the index position of the image's mesh among all meshes
*
* @param {int} idx: the index position of an image among
*   all images
* @returns {obj} an object detailing the image's mesh index
**/

function getImageMeshData(idx) {
  return {
    idx: Math.floor(idx / imagesPerMesh)
  }
}

/**
* Load the 32px texture files
**/

function loadAtlasFiles() {
  for (var i=0; i<atlasCounts['32px']; i++) {
    var url = dataUrl + 'atlas_files/32px/atlas-' + i + '.jpg';
    loadAtlasImage(i, url);
  }
}

/**
* XHR progress callback that updates the load progress meter
*
* @param {int} atlasIndex: the index of a 32px texture that
*   received the progress event
* @param {obj} xhr: an XHR object from the texture's loader
**/

function onProgress(atlasIndex, xhr) {
  loadProgress[atlasIndex] = xhr.loaded / xhr.total;
  // Sum the total load progress among all atlas files
  var sum = _.keys(loadProgress).reduce(function (sum, key) {
    return sum + loadProgress[key];
  }, 0);
  // Update the progress marker
  var loader = document.querySelector('#progress');
  progress = sum / atlasCounts['32px'];
  loader.innerHTML = parseInt(progress * 100) + '%';
  if (progress === 1) {
    startIfReady()
  }
}

/**
* Create a material from a new texture and check if the
* geometry is ready to be rendered
*
* @param {int} textureIndex: the index of a 32px texture
*   among all 32px textures
* @param {obj} texture: a three.js Texture
**/

function handleTexture(textureIndex, texture) {
  textures['32'][textureIndex] = texture;
  startIfReady();
}

/**
* Create 32px geometries if textures and img data loaded
**/

function startIfReady() {
  if (textures['32'].filter(String).length === atlasCounts['32px'] &&
      _.keys(imageData).length > 0 /*&& progress === 1*/) {
    // Use setTimeout to wait for the next available loop
    var button = document.querySelector('#enter');
    button.style.opacity = 1;

    buildGeometry()
    /*
    button.addEventListener('click', function() {
      buildGeometry()
      setTimeout(removeLoader, 1100)
    })
    */
  }
}

/**
* For each of the 32px textures, find the images in that
* texture, add that image's vertices, faces, and uv positions
* to the current geometry, and if we hit the maximum vertices
* per geometry, add the geometry to the scene and continue.
* Once all geometries are loaded, remove the load scene, animate
* the picture plot, and start loading large atlas files
**/

function buildGeometry() {

  // this geometry builds a blueprint and many copies of the blueprint
  var geometry  = new THREE.InstancedBufferGeometry();

  // add vertices for the blueprint. These vertices define a single square
  var vertices = [
    0, 0, 0,   // lower right triangle
  ];

  // add uv coordinates for the blueprint; these coords define a single square
  var w = 32 / sizes.atlas.width,
      h = 32 / sizes.atlas.height;

  var uvs = [
    0, 0,
  ];

  // Build the blueprint by assigning vertices + uvs as regular attributes.
  // All instances of the blueprint will share this data
  geometry.addAttribute( 'position',
    new THREE.BufferAttribute( new Float32Array( vertices ), 3));
  geometry.addAttribute( 'uv',
    new THREE.BufferAttribute( new Float32Array( uvs ), 2));

  // identify the key for each instance to make
  var instances = _.keys(imageData);

  // initialize instance attribute buffers
  var translation = new Float32Array( instances.length * 3 );
  var textureIndex = new Float32Array( instances.length );
  var uv = new Float32Array( instances.length * 2 );

  // initialize counter variables for each attribute
  var translationIterator = 0;
  var textureIterator = 0;
  var uvIterator = 0;

  // build each instance
  for (var i=0; i<instances.length; i++) {
    var img = imageData[instances[i]];

    // add the translation attribute parameters
    translation[ translationIterator++ ] = img.pos.x;
    translation[ translationIterator++ ] = img.pos.y;
    translation[ translationIterator++ ] = img.pos.z;

    // add the uv attribute parameters
    uv[ uvIterator++ ] = img.uv.x;
    uv[ uvIterator++ ] = img.uv.y;

    // set the texture index of the instance
    textureIndex[ textureIterator++ ] = img.texture.idx;
  }

  // set the attributes for each instance
  geometry.addAttribute( 'translation',
    new THREE.InstancedBufferAttribute( translation, 3, 1 ) );
  geometry.addAttribute( 'texture',
    new THREE.InstancedBufferAttribute( textureIndex, 1, 1 ) );
  geometry.addAttribute( 'textureOffset',
    new THREE.InstancedBufferAttribute( uv, 2, 1 ) );

  // build the material and mesh and render
  var material = getShaderMaterial();
  var mesh = new THREE.Points(geometry, material);

  // prevent the mesh from being clipped on drag
  mesh.frustumCulled = false;

  scene.add(mesh);
  meshes.push(mesh);

  requestAnimationFrame(animate);

  //removeLoaderScene();
  //loadLargeAtlasFiles();
}

/**
* Build a shader material
**/

function getShaderMaterial() {

  var w = 32 / sizes.atlas.width,
      h = 32 / sizes.atlas.height;

  // Uniform types: https://github.com/mrdoob/three.js/wiki/Uniforms-types
  return new THREE.RawShaderMaterial({
    uniforms: {
      // array of sampler2D values
      textures: {
        type: 'tv',
        value: textures['32'],
      },
      // specify size of each image in image atlas
      cellSize: {
        type: 'v2',
        value: [w, h],
      }
    },
    vertexShader: document.getElementById('vertex-shader').textContent,
    fragmentShader: getFragmentShader(textures['32'].length),
  });
}

/**
* Build a fragment shader that supports nTextures
* @params {int} nTextures: the number of textures that this shader
*   will support
* @returns {str} the string content for a fragment shader
**/

function getFragmentShader(nTextures) {
  var tree = 'if (textureIndex == 0) {' + getFrag(0) + '} ';
  for (var i=1; i<nTextures; i++) {
    tree += 'else if (textureIndex == ' + i + ') { ' + getFrag(i) + ' } \n';
  }

  var raw = document.getElementById('fragment-shader').textContent;
  raw = raw.replace('TEXTURE_LOOKUP_TREE', tree);
  raw = raw.replace('N_TEXTURES', nTextures);
  return raw;
}

/**
* Helper function for getFragmentShader. Generates fragment shader
* code that returns a texture at a given index position. If the alpha
* value at the requested position is 0, we discard the pixel.
* @param {int} idx: the index position of a texture
* @returns {str} shader code that returns the texture at idx `idx`
**/

function getFrag(idx) {
  return 'vec4 color = texture2D(textures[' + idx + '], uv * cellSize + vTextureOffset ); ' +
    'if (color.a < 0.5) { discard; } ' +
    'gl_FragColor = color; ';
}

/**
* Load an atlas image from disk
* @param {int} idx: the index position of the atlas file among all atlas files
* @param {str} url: the url to the image to be loaded
**/

function loadAtlasImage(idx, url) {
  var img = new Image;
  img.onload = function() {
    handleImage(idx, url, this);
  }
  img.load(url, function(progress) {
    console.log('progress', progress);
  })
}

/**
* Callback for a loaded image file
* @param {int} idx: the index position of the loaded image file
* @param {str} url: the url to the loaded image
* @param {img} img: an image file
**/

function handleImage(idx, url, img) {
  /* TODO: debug canvas
  var atlas = document.createElement('img');
  atlas.src = url;

  var canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 2048;

  // get the canvas in a context
  var ctx = canvas.getContext('2d');

  // draw only the regions of the atlas that are filled
  _.keys(atlasImages[idx]).forEach(function(key) {
    var img = atlasImages[idx][key];

    // find the coordinates for this image in the atlas
    var x = (img.uv.x * 2048);
    var y = (img.uv.y * 2048) + img.yOffset;
    var w = (img.uv.w * 2048);
    var h = (img.uv.h * 2048);
    // image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight
    ctx.drawImage(atlas, x, y, w, h, x, y, w, h);
  })
  */

  // store the composed canvas and texture
  //canvases[32][idx] = canvas;
  textures[32][idx] = new THREE.Texture(img);
  textures[32][idx].needsUpdate = true;

  // start the display if all assets are loaded
  startIfReady();
}





/**
* TODO: All Below
**/

/**
* Set the size config variables to the larger atlas size
* and initialize the chain of requests for larger atlas files
**/

function loadLargeAtlasFiles() {
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
  imagesPerAtlas = sizes.atlas.cols * sizes.atlas.rows;
  for (var i=0; i<atlasCounts['64px']; i++) {
    var url = dataUrl + 'atlas_files/64px/atlas-' + i + '.jpg';
    textureLoader.load(url, handleLargeTexture.bind(null, i))
  }
}

/**
* Add a newly arrived texture to the large materials object
* then update all images in that texture
*
* @param {int} atlasIndex: The index position of an atlas
*   file among all larger atlas files
* @param {obj} texture: A three.js Texture object
**/

function handleLargeTexture(atlasIndex, texture) {
  var material = new THREE.MeshBasicMaterial({ map: texture });
  materials['64'][atlasIndex] = material;
  updateImages(atlasIndex)
}

/**
* Find all images from a larger atlas file in the scene and
* update their uv properties to display higher-res texture
*
* @param {int} atlasIdx: a loaded atlas file's index position
*   among all larger atlas files
**/

function updateImages(atlasIndex) {
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
* Update properties of all images in a larger image atlas
*
* @param {int} atlasIdx: a loaded atlas file's index position
*   among all larger atlas files
* @param {int} materialIdx: a loaded material's index position
*   among all materials in a given mesh
**/

function getAtlasImages(atlasIdx, materialIdx) {
  // Find the index positions of the first and last images in this atlas
  var startImage = atlasIdx * imagesPerAtlas;
  var endImage = (atlasIdx + 1) * imagesPerAtlas;
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
* Transition from loading scene to plot scene
**/

function removeLoader() {
  var blocks = document.querySelectorAll('.block');
  for (var i=0; i<blocks.length; i++) {
    setTimeout(slideBlock.bind(null, blocks[i]), i*100);
  }
  document.querySelector('#progress').style.opacity = 0;

  // Fly to location if one is specified
  var hash = window.location.href.split('/#')[1];
  if (hash) {
    var coords = imageData[hash].pos;
    flyTo(coords.x, coords.y, coords.z);
  }
}

/**
* Animate an elem out of the scene
* @param {Element} elem - a DOM element
**/

function slideBlock(elem) {
  elem.style.animation = 'exit 300s';
  setTimeout(removeElem.bind(null, elem), 1000)
}

/**
* Remove an element from the DOM
* @param {Element} elem - a DOM element
**/

function removeElem(elem) {
  try { elem.parentNode.removeChild(elem) } catch (err) {}
}

/**
* Animate the loader scene out of frame
**/

function removeLoaderScene() {
  var loaderScene = document.querySelector('.loader-scene');
  loaderScene.style.transform = 'translateY(-500vh)';
}

/**
* Bind canvas event listeners
**/

function addCanvasEventListeners() {
  var canvas = document.querySelector('canvas');
  canvas.addEventListener('mousemove', onMousemove, false)
  canvas.addEventListener('mousedown', onMousedown, false)
  canvas.addEventListener('mouseup', onMouseup, false)
}

/**
* Set the current mouse coordinates {-1:1}
* @param {Event} event - triggered on canvas mouse move
**/

function onMousemove(event) {
  mouse.x = ( event.clientX / window.innerWidth ) * 2 - 1;
  mouse.y = - ( event.clientY / window.innerHeight ) * 2 + 1;
}

/**
* Store the previous mouse position so that when the next
* click event registers we can tell whether the user
* is clicking or dragging.
* @param {Event} event - triggered on canvas mousedown
**/

function onMousedown(event) {
  lastMouse.copy( mouse );
}

/**
* Callback for mouseup events on the window. If the user
* clicked an image, zoom to that image.
* @param {Event} event - triggered on canvas mouseup
**/

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
  var imageIndex = (meshIndex * imagesPerMesh) + Math.floor(faceIndex / 2);
  // Store the image name in the url hash for reference
  window.location.hash = imageDataKeys[imageIndex];
  flyTo(
    selected.point.x,
    selected.point.y,
    selected.point.z
  );
}

/**
* Fly to a spot and focus the camera on that spot
* @param {int} x - x coordinate on which to focus
* @param {int} y - y coordinate on which to focus
* @param {int} z - z coordinate on which to focus
**/

function flyTo(x, y, z) {
  // Specify the location to which we'll move the camera
  var target = { x: x, y: y, z: z + 700 }
  // Use initial camera quaternion as the slerp starting point
  var startQuaternion = camera.quaternion.clone();
  // Use dummy camera focused on target as the slerp ending point
  var dummyCamera = camera.clone();
  dummyCamera.position.set(target.x, target.y, target.z);
  var dummyControls = new THREE.TrackballControls(dummyCamera);
  dummyControls.target.set(x, y, z);
  dummyControls.update();
  // Animate between the start and end quaternions
  new TWEEN.Tween(camera.position)
    .to(target, 1000)
    .onUpdate(function(timestamp) {
      // Slerp the camera quaternion for smooth transition.
      // `timestamp` is the eased time value from the tween.
      THREE.Quaternion.slerp(startQuaternion, dummyCamera.quaternion, camera.quaternion, timestamp);
    })
    .onComplete(function() {
      controls.target = new THREE.Vector3(x, y, z);
    }).start();
}

/**
* Create nav hotspots and bind their click listeners
* @param {arr} hotspotData - a list of objects that contain
*   `img` and `label` attributes
**/

function renderHotspots(hotspotData) {
  // Render hotspots
  var template = document.querySelector('#template').innerHTML;
  var compiled = _.template(template)({hotspots: hotspotData});
  document.querySelector('#hotspots').innerHTML = compiled;
  // Bind click listeners
  var navImages = document.querySelectorAll('.hotspot');
  for (var i=0; i<navImages.length; i++) {
    navImages[i].addEventListener('click', onNavImageClick)
  }
}

/**
* Find the vertices of a clicked image and fly to them
**/

function onNavImageClick(event) {
  var attr = event.target.style.backgroundImage;
  var img = attr.substring(5, attr.length-2);
  var file = img.split('/')[ img.split('/').length - 1 ];
  var name = file.substring(0, file.lastIndexOf('.'));
  window.location.hash = '#' + name;
}

/**
* On window resize, resize the canvas & update controls.
* On hashchange, fly to the image in the hash (if available)
**/

function addWindowEventListeners() {
  window.addEventListener('resize', function() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );
    controls.handleResize();
  });
  window.addEventListener('hashchange', function(e) {
    var hash = e.newURL.split('/#')[1];
    var coords = imageData[hash].pos;
    flyTo(coords.x, coords.y, coords.z);
  })
}

/**
* Add the stats
**/

function getStats() {
  if (!window.location.href.includes('stats=true')) return null;
  var stats = new Stats();
  stats.domElement.style.position = 'absolute';
  stats.domElement.style.top = '65px';
  stats.domElement.style.right = '5px';
  document.body.appendChild( stats.domElement );
  return stats;
}

/**
* Create the animation loop that re-renders the scene each frame
**/

function animate() {
  requestAnimationFrame(animate);
  TWEEN.update();
  raycaster.setFromCamera(mouse, camera);
  renderer.render(scene, camera);
  controls.update();
  if (stats) stats.update();
}

/**
* Main
**/

var scene = getScene();
var camera = getCamera();
var renderer = getRenderer();
var controls = getControls(camera, renderer);
var stats = getStats();
addCanvasEventListeners()
addWindowEventListeners()
loadData()