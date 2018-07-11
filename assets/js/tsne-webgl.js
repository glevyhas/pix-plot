/**
* Globals
**/

// Check the user agent's WebGL settings
var gl = document.createElement('canvas').getContext('webgl');
if (!gl) webglNotAvailable();
var limits = getBrowserLimits();

// Initialize global data stores for image data
var imageData = {}; // map from image id to rendering attributes
var imageDataKeys = []; // array of distinct image id values
var atlasImages = {}; // map from atlas index to images in atlas

// Identify data endpoint
var dataUrl = 'output/';

// Store size of image, atlas, atlas row, atlas column
var sizes = {
  image: 32,
  atlas: 2048,
  row: 2048 / 32,
  col: 2048 / 32,
}

// Count of images per atlas
var imagesPerAtlas = sizes.row * sizes.col;

// Count of 32px and 64px atlas files to fetch
var atlasCounts = { '32px': null, '64px': null }

// Store the load progress: {atlas0: percentLoaded, atlas1: percentLoaded}
var loadProgress = {};

// Store of the total initial load progress {0:1}
var progress = 0;

// Create a store for the 32px and 64 px atlas textures
var textures = { 32: [], 64: [] };

// Create a store for the 32px and 64px loaded canvases
var canvases = { 32: [], 64: [] };

// Texture loader for XHR requests
var textureLoader = new AjaxTextureLoader();

// Determine how many images we can pack into each mesh / draw call
var imagesPerMesh = getImagesPerMesh();

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
* Handle the case that the user can't create a WebGL context
**/

function webglNotAvailable() {
  document.querySelector('#webgl-not-available').style.display = 'block';
}

/**
* Identify the limits of vertices, textures, etc per
* draw call for the user agent's GPU system
**/

function getBrowserLimits() {
  return {
    textureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    textureCount: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
  }
}

/**
* Determine how many images can fit in each mesh
**/

function getImagesPerMesh() {
  // Many graphics cards only support 2**16 vertices per mesh, and
  // each image/quad requires:
  //   6 vertices in a two-triangle quad without indexing
  //   4 vertices in a two-triangle quad with indexing (reused vertices)
  //   1 vertex in a point primitive
  // The number of images per mesh can be limited by several factors,
  // including the number of vertices per draw call in the current GPU card,
  // and the number of textures per draw call in the current GPU card.
  // verticesPerObject depends on the primitive used for each quad.
  var verticesPerObject = 1;
  // Determine how many images fit in each draw call if we're vertex-bound.
  var vertexBound = 2**16 / verticesPerObject;
  // Determine how many images fit in each draw call if we're texture-bound.
  var textureBound = limits.textureCount * imagesPerAtlas;
  // Set the images per mesh by the limiting factor
  return Math.min(vertexBound, textureBound);
}

/**
* Generate  scene object with a background color
**/

function getScene() {
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
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
  var camera = new THREE.PerspectiveCamera(75, aspectRatio, 0.1, 12000);
  camera.position.set(0, -1000, 7000);
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
    xOffset: (sizes.image - img[3])/2,
    yOffset: (sizes.image - img[4])/2,
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
    x: img.x * 10, // 10 is just a scalar to set the point spread
    y: img.y * 6,  // 6 is just a scalar to set the point spread
    z: 2000 + ((idx/100) % 100), // TODO: replace with heightmap
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
    idx: Math.floor(idx / imagesPerAtlas),
    row: Math.floor(indexInAtlas / sizes.row),
    col: indexInAtlas % sizes.col,
  }
}

/**
* Identify the following uv attributes for an image:
*   w: the relative width of this image within its atlas {0:1}
*   h: the relative height of this image within its atlas {0:1}
*   x: the left offset of this image within its atlas {0:1}
*   y: the top offset of this image within its atlas {0:1}
*
* @param {obj} img: an image object with `width`, `height`,
*   `xOffset`, `yOffset` properties
* @param {int} idx: the index position of an image among
*   all images
* @returns {obj} an object detailing the image's uv parameters
**/

function getImageUvData(img, idx, atlas) {
  // Store the relative width and height of each cell in an atlas
  var cellWidth = sizes.image / sizes.atlas;
  var cellHeight = sizes.image / sizes.atlas;
  return {
    w: img.width / sizes.atlas,
    h: img.height / sizes.atlas,
    x: atlas.col * cellWidth,
    y: 1 - (atlas.row * cellHeight) - cellHeight, // y + h = top of image
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
    idx: Math.floor( (idx % imagesPerMesh) / imagesPerAtlas )
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

  // create one group to which all meshes / draw calls will be added
  var group = new THREE.Group();

  // pull out the keys for all images to be rendered
  var instances = _.keys(imageData);

  // total number of draw calls to make
  var meshCount = Math.ceil(instances.length / imagesPerMesh);

  // fit the maximum number of vertices in each draw call
  for (var i=0; i<meshCount; i++) {

    // find start and end indices of images in this mesh
    var imageStart = i * imagesPerMesh;
    var imageEnd = Math.min( (i+1) * imagesPerMesh, instances.length );
    var imageCount = imageEnd - imageStart;

    // initialize instance attribute buffers
    var translation = new Float32Array( imageCount * 3 );
    var uv = new Float32Array( imageCount * 2 );
    var textureIndex = new Float32Array( imageCount );

    // initialize counter variables for each attribute
    var translationIterator = 0;
    var uvIterator = 0;
    var textureIterator = 0;

    // add the instance attributes
    for (var j=imageStart; j<imageEnd; j++) {
      var img = imageData[instances[j]];
      translation[ translationIterator++ ] = img.pos.x; // set translation x
      translation[ translationIterator++ ] = img.pos.y; // set translation y
      translation[ translationIterator++ ] = img.pos.z; // set translation z
      uv[ uvIterator++ ] = img.uv.x; // set uv offset x
      uv[ uvIterator++ ] = img.uv.y; // set uv offset y
      textureIndex[ textureIterator++ ] = img.texture.idx; // set texture index
    }

    var geometry  = new THREE.InstancedBufferGeometry();

    // add blueprint attributes shared by all instances
    geometry.addAttribute( 'position',
      new THREE.BufferAttribute( new Float32Array( [ 0, 0, 0, ] ), 3));
    geometry.addAttribute( 'uv',
      new THREE.BufferAttribute( new Float32Array( [ 0, 0, ] ), 2));

    // add instance-specific attributes
    geometry.addAttribute( 'translation',
      new THREE.InstancedBufferAttribute( translation, 3, 1 ) );
    geometry.addAttribute( 'textureIndex',
      new THREE.InstancedBufferAttribute( textureIndex, 1, 1 ) );
    geometry.addAttribute( 'textureOffset',
      new THREE.InstancedBufferAttribute( uv, 2, 1 ) );

    // get the first and last indices of materials to include in this mesh
    var startMaterialIdx = Math.floor((imagesPerMesh * i) / imagesPerAtlas);
    var endMaterialIdx = Math.floor((imagesPerMesh * (i+1)) / imagesPerAtlas) - 1;
    // do not request materials beyond the final material index
    var maxMaterialIdx = textures[sizes.image].length-1;
    endMaterial = Math.min(endMaterialIdx, maxMaterialIdx);
    var material = getShaderMaterial(startMaterialIdx, endMaterialIdx);

    // build a mesh and prevent the mesh from being clipped on drag
    var mesh = new THREE.Points(geometry, material);
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  scene.add(group);

  requestAnimationFrame(animate);

  // TODO: re-enable start sequence
  //removeLoaderScene();
  //loadLargeAtlasFiles();
}

/**
* Build a shader material. NB, a full list of uniform types is available:
*   https://github.com/mrdoob/three.js/wiki/Uniforms-types
**/

function getShaderMaterial(start, end) {
  return new THREE.RawShaderMaterial({
    uniforms: {
      // array of sampler2D values
      textures: {
        type: 'tv',
        value: textures[sizes.image].slice(start, end + 1),
      },
      // specify size of each image in image atlas
      cellSize: {
        type: 'v2',
        value: [
          sizes.image / sizes.atlas,
          sizes.image / sizes.atlas,
        ],
      }
    },
    vertexShader: document.getElementById('vertex-shader').textContent,
    fragmentShader: getFragmentShader(end - start + 1),
  });
}

/**
* Build a fragment shader that supports nTextures
* @params {int} nTextures: the number of textures that this shader
*   will support
* @returns {str} the string content for a fragment shader
**/

function getFragmentShader(nTextures) {
  var tree = 'if (textureIndex == 0) {' + getFrag(0) + '}\n ';
  for (var i=1; i<nTextures-1; i++) {
    tree += 'else if (textureIndex == ' + i + ') { ' + getFrag(i) + ' }\n ';
  }

  var raw = document.getElementById('fragment-shader').textContent;
  raw = raw.replace('TEXTURE_LOOKUP_TREE', tree);
  raw = raw.replace('N_TEXTURES', nTextures);
  return raw;
}

/**
* Helper function for getFragmentShader. Generates fragment shader
* code that returns a texture at a given index position. If the alpha
* value at the requested position is 0, we discard the pixel. NB:
* texture2D returns a vec4
*
* @param {int} idx: the index position of a texture
* @returns {str} shader code that sets the gl_FragColor of a
*   quad pixel using the offsets in uv and the texture data in textures[idx]
**/

function getFrag(idx) {
  return 'vec4 color = texture2D(textures[' + idx + '], scaledUv );\n ' +
    'if (color.a < 0.5) { discard; }\n ' +
    'gl_FragColor = color;\n ';
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

  var atlas = document.createElement('img');
  atlas.src = url;
  atlas.width = 2048;
  atlas.height = 2048;
  atlas.onload = function() {

    var canvas = document.createElement('canvas');
    canvas.width = sizes.atlas;
    canvas.height = sizes.atlas;

    // get the canvas in a context
    var ctx = canvas.getContext('2d');

    // draw only the regions of the atlas that are filled
    _.keys(atlasImages[idx]).forEach(function(key) {
      var img = atlasImages[idx][key];

      // find the image's px coordinates in its atlas (top-left == 0,0)
      var x = img.uv.x * sizes.atlas;
      var y = sizes.atlas - (img.uv.y * sizes.atlas) - sizes.image;
      var w = img.uv.w * sizes.atlas;
      var h = img.uv.h * sizes.atlas;

      // find the padding on the top + left of the current image
      var left = (sizes.image - w) / 2;
      var top = (sizes.image - h) / 2;

      x += left;
      y += top;

      // image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight
      ctx.drawImage(atlas, x, y, w, h, x, y, w, h);
    })

    // store the composed canvas and texture
    canvases[sizes.image][idx] = canvas;
    textures[sizes.image][idx] = new THREE.Texture(canvas);
    textures[sizes.image][idx].needsUpdate = true;

    // start the display if all assets are loaded
    startIfReady();
  }
}

/**
* TODO: All Below
**/

/**
* Set the size config variables to the larger atlas size
* and initialize the chain of requests for larger atlas files
**/

function loadLargeAtlasFiles() {
  sizes = {
    image: 64,
    atlas: 2048,
    row: 2048 / 64,
    col: 2048 / 64,
  }

  imagesPerAtlas = sizes.atlas * sizes.atlas;
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