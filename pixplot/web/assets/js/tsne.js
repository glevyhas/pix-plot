/**
*
* General structure of this viewer
*
* The code below creates a webgl scene that visualizes many images. To do so,
* it loads a series of "atlas" images (.jpg files that contain lots of smaller
* image "cells", where each cell depicts a single input image in a small size).
* Those atlases are combined into "textures", where each texture is just a 2D
* canvas with image data from one or more atlas images. Those textures are fed
* to the GPU to control the content that each individual image in the scene
* will display.
*
* The positions of each cell are controlled by the data in plot_data.json,
* which is created by utils/process_images.py. As users move through the scene,
* higher detail images are requested for the images that are proximate to the
* user's camera position. Those higher resolution images are loaded by the LOD()
* "class" below.
*
**/

/**
* Config: The master config for this visualization.
*   Contains the following attributes:
*
* data:
*   url: name of the directory where input data lives
*   file: name of the file with positional data
*   spread: spread of data along each axis
* size:
*   cell: height & width of each image (in px) within the small atlas
*   lodCell: height & width of each image (in px) within the larger atlas
*   atlas: height & width of each small atlas (in px)
*   texture: height & width of each texture (in px)
*   lodTexture: height & width of the large (detail) texture
* lod:
*   minZ: the minimum z dimension value for which we'll load detailed images
*   radius: distance from user's cursor that we'll search in the level of
*     detail (LOD) grid for images that need higher resolution textures loaded
*   framesBetweenUpdates: number of frames to wait between LOD updates
*   gridSpacing: the size of each unit in the LOD grid. Bigger means that more
*     distant images will be loaded when a user is near a particular location
* transition:
*   duration: number of seconds each layout transition should take
*   ease: TweenLite ease config values for transitions
* atlasesPerTex: number of atlases to include in each texture
**/

function Config() {
  this.data = {
    dir: 'data',
    file: 'manifest.json',
    spread: 4000,
    pointScalar: 12,
  }
  this.size = {
    cell: 32, // height of each cell in atlas
    lodCell: 128, // height of each cell in LOD
    atlas: 2048, // height of each atlas
    texture: webgl.limits.textureSize,
    lodTexture: 2048,
  }
  this.lod = {
    minZ: 250,
    radius: 2,
    framesBetweenUpdates: 40,
    gridSpacing: 100,
  }
  this.transitions = {
    duration: 1.5,
    ease: {
      value: 1,
      ease: Power2.easeInOut,
    }
  }
  this.atlasesPerTex = (this.size.texture / this.size.atlas)**2;
}

/**
* Data: Container for data consumed by application
*
* atlasCount: total number of atlases to load; specified in config.data.file
* textureCount: total number of textures to create
* textures: array of Texture objects to render. Each requires a draw call
* layout: string layout for the currently active layout in json.layouts
* layouts: array of layouts, each with 2 or 3D positional attributes per cell
* cells: array of images to render. Each depicts a single input image
* textureProgress: maps texture index to its loading progress (0:100)
* textureCount: total number of textures to load
* loadedTextures: number of textures loaded so far
* boundingBox: the domains for the x and y axes. Used for setting initial
*   camera position and creating the LOD grid
**/

function Data() {
  this.atlasCount = null;
  this.textureCount = null;
  this.initialLayout = 'grid'; // string label for selected layout
  this.layouts = [];
  this.cells = [];
  this.textures = [];
  this.textureProgress = {};
  this.loadedTextures = 0;
  this.boundingBox = {
    x: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, },
    y: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, },
  };
  this.load();
}

// Load json data with chart element positions
Data.prototype.load = function() {
  get(config.data.dir + '/' + config.data.file, function(json) {
    this.json = json;
    // set config vals
    config.size.cell = json.config.sizes.cell;
    config.size.atlas = json.config.sizes.atlas;
    config.size.lodCell = json.config.sizes.lod;
    // set number of atlases and textures
    this.atlasCount = json.atlas.count;
    this.textureCount = Math.ceil(json.atlas.count / config.atlasesPerTex);
    // set layout values
    this.layouts = json.layouts;
    this.initialLayout = this.initialLayout ? this.initialLayout : Object.keys(this.layouts)[0];
    this.hotspots = new Hotspots();
    layout.setOptions(Object.keys(this.layouts));
    // load the filter options if metadata present
    if (json.metadata) filters.loadFilters();
    // load each texture for this data set
    for (var i=0; i<this.textureCount; i++) {
      this.textures.push(new Texture({
        idx: i,
        onProgress: this.onTextureProgress.bind(this),
        onLoad: this.onTextureLoad.bind(this),
      }));
    };
    // add cells to the world
    get(getPath(this.layouts[this.initialLayout].positions), function(json) {
      this.addCells(json)
    }.bind(this))
  }.bind(this))
}

// When a texture's progress updates, update the aggregate progress
Data.prototype.onTextureProgress = function(texIdx, progress) {
  this.textureProgress[texIdx] = progress / this.textures[texIdx].getAtlasCount(texIdx);
  welcome.updateProgress();
}

// When a texture loads, draw plot if all have loaded
Data.prototype.onTextureLoad = function(texIdx) {
  this.loadedTextures += 1;
  welcome.updateProgress();
}

// Add all cells to the world
Data.prototype.addCells = function(positions) {
  // datastore indicating data in current draw call
  var drawcall = {
    idx: 0, // idx of draw call among all draw calls
    textures: [], // count of textures in current draw call
    vertices: 0, // count of vertices in current draw call
  }
  // create all cells
  var idx = 0; // index of cell among all cells
  for (var i=0; i<this.json.cell_sizes.length; i++) { // atlas index
    for (var j=0; j<this.json.cell_sizes[i].length; j++) { // cell index within atlas
      drawcall.vertices++;
      var texIdx = Math.floor(i/config.atlasesPerTex),
          worldPos = positions[idx], // position of cell in world -1:1
          atlasPos = this.json.atlas.positions[i][j], // idx-th cell position in atlas
          atlasOffset = getAtlasOffset(i),
          size = this.json.cell_sizes[i][j];
      this.cells.push(new Cell({
        idx: idx, // index of cell among all cells
        w:  size[0], // width of cell in lod atlas
        h:  size[1], // height of cell in lod atlas
        dx: atlasPos[0] + atlasOffset.x, // x offset of cell in atlas
        dy: atlasPos[1] + atlasOffset.y, // y offset of cell in atlas
        x:  worldPos[0], // x position of cell in world
        y:  worldPos[1], // y position of cell in world
        z:  worldPos[2] || null, // z position of cell in world
      }))
      idx++;
    }
  }
  // add the cells to a searchable LOD texture
  lod.indexCells();
}

/**
* Texture: Each texture contains one or more atlases, and each atlas contains
*   many Cells, where each cell represents a single input image.
*
* idx: index of this texture within all textures
* cellIndices: indices of the cells in this texture within data.cells
* atlasProgress: map from this textures atlas id's to their load progress (0:100)
* atlases: list of atlases used in this texture
* atlasCount: number of atlases to load for this texture
* onProgress: callback to tell Data() that this texture loaded a bit more
* onLoad: callback to tell Data() that this texture finished loading
* loadedAtlases: number of atlases loaded
* canvas: the canvas on which each atlas in this texture will be rendered
* ctx: the 2D context for drawing on this.canvas
* offscreen: boolean indicating whether this canvas can be drawn offscreen
*   (unused)
**/

function Texture(obj) {
  this.idx = obj.idx;
  this.atlases = [];
  this.atlasProgress = {};
  this.loadedAtlases = 0;
  this.onProgress = obj.onProgress;
  this.onLoad = obj.onLoad;
  this.canvas = null;
  this.ctx = null;
  this.load();
}

Texture.prototype.setCanvas = function() {
  this.canvas = getElem('canvas', {
    width: config.size.texture,
    height: config.size.texture,
    id: 'texture-' + this.idx,
  })
  this.ctx = this.canvas.getContext('2d');
}

Texture.prototype.load = function() {
  this.setCanvas();
  // load each atlas that is to be included in this texture
  for (var i=0; i<this.getAtlasCount(); i++) {
    this.atlases.push(new Atlas({
      idx: (config.atlasesPerTex * this.idx) + i, // atlas index among all atlases
      onProgress: this.onAtlasProgress.bind(this),
      onLoad: this.onAtlasLoad.bind(this),
    }))
  }
}

// Get the number of atlases to include in this texture
Texture.prototype.getAtlasCount = function() {
  return (data.atlasCount / config.atlasesPerTex) > (this.idx + 1)
    ? config.atlasesPerTex
    : data.atlasCount % config.atlasesPerTex;
}

// Store the load progress of each atlas file
Texture.prototype.onAtlasProgress = function(atlasIdx, progress) {
  this.atlasProgress[atlasIdx] = progress;
  var textureProgress = valueSum(this.atlasProgress);
  this.onProgress(this.idx, textureProgress);
}

// Draw the loaded atlas image to this texture's canvas
Texture.prototype.onAtlasLoad = function(atlas) {
  // Add the loaded atlas file the texture's canvas
  var atlasSize = config.size.atlas,
      textureSize = config.size.texture,
      // atlas index within this texture
      idx = atlas.idx % config.atlasesPerTex,
      // x and y offsets within texture
      d = getAtlasOffset(idx),
      w = config.size.atlas,
      h = config.size.atlas;
  this.ctx.drawImage(atlas.image, d.x, d.y, w, h);
  // If all atlases are loaded, build the texture
  if (++this.loadedAtlases == this.getAtlasCount()) this.onLoad(this.idx);
}

// get the offset of an atlas within its texture
function getAtlasOffset(idx) {
  var atlasSize = config.size.atlas,
      textureSize = config.size.texture;
  return {
    x: (idx * atlasSize) % textureSize,
    y: Math.floor((idx * atlasSize) / textureSize) * atlasSize,
  }
}

/**
* Atlas: Each atlas contains multiple Cells, and each Cell represents a single
*   input image.
*
* idx: index of this atlas among all atlases
* texIdx: index of this atlases texture among all textures
* cellIndices: array of the indices in data.cells to be rendered by this atlas
* size: height & width of this atlas (in px)
* progress: total load progress for this atlas's image (0-100)
* onProgress: callback to notify parent Texture that this atlas has loaded more
* onLoad: callback to notify parent Texture that this atlas has finished loading
* image: Image object with data to be rendered on this atlas
* url: path to the image for this atlas
* cells: list of the Cell objects rendered in this atlas
* posInTex: the x & y offsets of this atlas in its texture (in px) from top left
**/

function Atlas(obj) {
  this.idx = obj.idx;
  this.progress = 0;
  this.onProgress = obj.onProgress;
  this.onLoad = obj.onLoad;
  this.image = null;
  this.url = config.data.dir + '/atlases/atlas-' + this.idx + '.jpg';
  this.load();
}

Atlas.prototype.load = function() {
  this.image = new Image;
  this.image.onload = function() { this.onLoad(this); }.bind(this)
  var xhr = new XMLHttpRequest();
  xhr.onprogress = function(e) {
    var progress = parseInt((e.loaded / e.total) * 100);
    this.onProgress(this.idx, progress);
  }.bind(this);
  xhr.onload = function(e) {
    this.image.src = window.URL.createObjectURL(e.target.response);
  }.bind(this);
  xhr.open('GET', this.url, true);
  xhr.responseType = 'blob';
  xhr.send();
}

/**
* Cell: Each cell represents a single input image.
*
* idx: index of this cell among all cells
* name: the basename for this image (e.g. cats.jpg)
* w: the width of this image in pixels
* h: the height of this image in pixels
* gridCoords: x,y coordinates of this image in the LOD grid -- set by LOD()
* layouts: a map from layout name to obj with x, y, z positional values
**/

function Cell(obj) {
  this.idx = obj.idx; // idx among all cells
  this.texIdx = this.getIndexOfTexture();
  this.gridCoords = {}; // x, y pos of the cell in the lod grid (set by lod)
  this.x = obj.x * config.data.spread;
  this.y = obj.y * config.data.spread;
  this.z = obj.z || this.getZ();
  this.tx = this.x; // target x position
  this.ty = this.y; // target y position
  this.tz = this.z; // target z position
  this.dx = obj.dx;
  this.dy = obj.dy;
  this.w = obj.w; // width of lod cell
  this.h = obj.h; // heiht of lod cell
  this.updateParentBoundingBox();
}

Cell.prototype.getZ = function() {
  return layout.selected == 'umap'
    ? (this.idx % config.data.spread*0.01)
    : 0
}

Cell.prototype.updateParentBoundingBox = function() {
  var bb = data.boundingBox;
  ['x', 'y'].forEach(function(d) {
    bb[d].max = Math.max(bb[d].max, this[d]);
    bb[d].min = Math.min(bb[d].min, this[d]);
  }.bind(this))
}

// return the index of this atlas among all atlases
Cell.prototype.getIndexOfAtlas = function() {
  var i=0; // accumulate cells per atlas until we find this cell's atlas
  for (var j=0; j<data.json.atlas.positions.length; j++) {
    i += data.json.atlas.positions[j].length;
    if (i > this.idx) return j;
  }
  return j;
}

// return the index of this cell within its atlas
Cell.prototype.getIndexInAtlas = function() {
  var atlasIdx = this.getIndexOfAtlas();
  var i=0; // determine the number of cells in all atlases prior to current
  for (var j=0; j<atlasIdx; j++) {
    i += data.json.atlas.positions[j].length;
  }
  return this.idx - i;
}

// return the index of this cell's initial (non-lod) texture among all textures
Cell.prototype.getIndexOfTexture = function() {
  return Math.floor(this.getIndexOfAtlas() / config.atlasesPerTex);
}

// return the index of this cell among cells in its initial (non-lod) texture
Cell.prototype.getIndexInTexture = function() {
  var i=0; // index of starting cell in atlas within texture
  for (var j=0; j<this.getIndexOfAtlas(); j++) {
    if ((j%config.atlaesPerTex)==0) i = 0;
    i += data.json.atlas.positions[i].length;
  }
  return i + this.getIndexInAtlas();
}

// return the index of this cell's draw call among all draw calls
Cell.prototype.getIndexOfDrawCall = function() {
  return Math.floor(this.idx/webgl.limits.indexedElements);
}

// return the index of this cell within its draw call
Cell.prototype.getIndexInDrawCall = function() {
  return this.idx % webgl.limits.indexedElements;
}

/**
* Cell activation / deactivation
**/

// make the cell active in LOD
Cell.prototype.activate = function() {
  this.dx = lod.state.cellIdxToCoords[this.idx].x;
  this.dy = lod.state.cellIdxToCoords[this.idx].y;
  this.texIdx = -1;
  ['textureIndex', 'offset'].forEach(this.mutateBuffer.bind(this));
}

// deactivate the cell in LOD
Cell.prototype.deactivate = function() {
  var atlasIndex = this.getIndexOfAtlas(),
      indexInAtlas = this.getIndexInAtlas(),
      atlasOffset = getAtlasOffset(atlasIndex)
      d = data.json.atlas.positions[atlasIndex][indexInAtlas];
  this.dx = d[0] + atlasOffset.x;
  this.dy = d[1] + atlasOffset.y;
  this.texIdx = this.getIndexOfTexture();
  ['textureIndex', 'offset'].forEach(this.mutateBuffer.bind(this));
}

// update this cell's buffer values for bound attribute `attr`
Cell.prototype.mutateBuffer = function(attr) {
  // find the buffer attributes that describe this cell to the GPU
  var meshes = world.scene.children[0],
      attrs = meshes.children[this.getIndexOfDrawCall()].geometry.attributes,
      idxInDrawCall = this.getIndexInDrawCall();

  switch(attr) {
    case 'textureIndex':
      // set the texIdx to -1 to read from the uniforms.lodTexture
      attrs.textureIndex.array[idxInDrawCall] = this.texIdx;
      return;

    case 'offset':
      // find cell's position in the LOD texture then set x, y tex offsets
      var texSize = this.texIdx == -1 ? config.size.lodTexture : config.size.texture;
      // set the x then y texture offsets for this cell
      attrs.offset.array[(idxInDrawCall * 2)] = this.dx;
      attrs.offset.array[(idxInDrawCall * 2) + 1] = this.dy;
      return;

    case 'pos0':
      // set the cell's translation
      attrs.pos0.array[(idxInDrawCall * 3)] = this.x;
      attrs.pos0.array[(idxInDrawCall * 3) + 1] = this.y;
      attrs.pos0.array[(idxInDrawCall * 3) + 2] = this.z;
      return;

    case 'target':
      // set the cell's target translation
      attrs.target.array[(idxInDrawCall * 3)] = this.tx;
      attrs.target.array[(idxInDrawCall * 3) + 1] = this.ty;
      attrs.target.array[(idxInDrawCall * 3) + 2] = this.tz;
      return;
  }
}

/**
* Layout: contols the DOM element and state that identify the layout
*   to be displayed
*
* elem: DOM element for the layout selector
* selected: string identifying the currently selected layout
* options: list of strings identifying valid layout options
**/

function Layout() {
  this.elem = null;
  this.selected = null;
  this.options = [];
}

/**
* @param [str] options: an array of layout strings; each should
*   be an attribute in data.cells[ithCell].layouts
**/

Layout.prototype.setOptions = function(options) {
  this.options = options;
  this.selected = data.initialLayout;
  this.render();
}

Layout.prototype.render = function() {
  var select = document.createElement('select');
  select.id = 'layout-select';
  for (var i=0; i<this.options.length; i++) {
    var option = document.createElement('option');
    option.val = this.options[i];
    option.textContent = this.options[i];
    if (this.options[i] == this.selected) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', function(e) {
    this.set(e.target.value);
  }.bind(this))
  document.querySelector('.header-controls').appendChild(select);
  this.elem = select;
}

// Transition to a new layout; layout must be an attr on Cell.layouts
Layout.prototype.set = function(layoutKey) {
  // disallow new transitions when we're transitioning
  if (world.state.transitioning) return;
  world.state.transitioning = true;
  this.elem.disabled = true;
  // zoom the user out if they're zoomed in
  if (world.camera.position.z < 2500) {
    var delay = config.transitions.duration * 1000;
    world.flyTo(world.getInitialLocation());
  } else {
    delay = 0;
  }
  // begin the new layout transition
  setTimeout(this.transition.bind(this, layoutKey), delay);
}

Layout.prototype.transition = function(layoutKey) {
  this.selected = layoutKey;
  get(getPath(data.layouts[layoutKey].positions), function(pos) {
    // set the target locations of each point
    for (var i=0; i<data.cells.length; i++) {
      data.cells[i].tx = pos[i][0] * config.data.spread;
      data.cells[i].ty = pos[i][1] * config.data.spread;
      data.cells[i].tz = pos[i][2] || data.cells[i].getZ();
    }
    // get the draw call indices of each cell
    var drawCallToCells = world.getDrawCallToCells()
    for (var drawCall in drawCallToCells) {
      var cells = drawCallToCells[drawCall];
      var mesh = world.scene.children[0].children[drawCall];
      // transition the transitionPercent attribute on the mesh
      TweenLite.to(mesh.material.uniforms.transitionPercent,
        config.transitions.duration, config.transitions.ease);
      // update the target positional attributes on each cell
      var iter = 0;
      cells.forEach(function(cell) {
        mesh.geometry.attributes.pos1.array[iter++] = cell.tx;
        mesh.geometry.attributes.pos1.array[iter++] = cell.ty;
        mesh.geometry.attributes.pos1.array[iter++] = cell.tz;
      }.bind(this))
      mesh.geometry.attributes.pos1.needsUpdate = true;
      // set the cell's new position to enable future transitions
      setTimeout(this.onTransitionComplete.bind(this, {
        mesh: mesh,
        cells: cells,
      }), config.transitions.duration * 1000);
    }
  }.bind(this))
}

// reset the cell translation buffers, update cell state
// and reset the time uniforms after a positional transition completes
Layout.prototype.onTransitionComplete = function(obj) {
  this.elem.disabled = false;
  var iter = 0;
  obj.cells.forEach(function(cell) {
    cell.x = cell.tx;
    cell.y = cell.ty;
    cell.z = cell.tz;
    obj.mesh.geometry.attributes.pos0.array[iter++] = cell.x;
    obj.mesh.geometry.attributes.pos0.array[iter++] = cell.y;
    obj.mesh.geometry.attributes.pos0.array[iter++] = cell.z;
  }.bind(this))
  obj.mesh.geometry.attributes.pos0.needsUpdate = true;
  // update the positional attribute and time uniform on the mesh
  obj.mesh.material.uniforms.transitionPercent = { type: 'f', value: 0, };
  world.state.transitioning = false;
  world.controls.target.z = getMinCellZ();
  // reindex cells in LOD and clear LOD state
  lod.clear();
  lod.indexCells();
}

/**
* World: Container object for the THREE.js scene that renders all cells
*
* scene: a THREE.Scene() object
* camera: a THREE.PerspectiveCamera() object
* renderer: a THREE.WebGLRenderer() object
* controls: a THREE.TrackballControls() object
* stats: a Stats() object
* color: a THREE.Color() object
* center: a map identifying the midpoint of cells' positions in x,y dims
* state: a map identifying internal state of the world
**/

function World() {
  this.scene = this.getScene();
  this.camera = this.getCamera();
  this.renderer = this.getRenderer();
  this.controls = this.getControls();
  this.stats = this.getStats();
  this.color = new THREE.Color();
  this.center = {};
  this.state = {
    flying: false,
    transitioning: false,
    displayed: false,
  }
  this.addEventListeners();
}

/**
* Return a scene object with a background color
**/

World.prototype.getScene = function() {
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

World.prototype.getCamera = function() {
  var canvasSize = getCanvasSize();
  var aspectRatio = canvasSize.w /canvasSize.h;
  return new THREE.PerspectiveCamera(75, aspectRatio, 0.1, 10000);
}

/**
* Generate the renderer to be used in the scene
**/

World.prototype.getRenderer = function() {
  var config = {antialias: true}, // powerPreference breaks safari
      renderer = new THREE.WebGLRenderer(config);
  renderer.setPixelRatio(window.devicePixelRatio); // support retina displays
  var canvasSize = getCanvasSize(); // determine the size of the window
  renderer.setSize(canvasSize.w, canvasSize.h); // set the renderer size
  renderer.domElement.id = 'pixplot-canvas'; // give the canvas a unique id
  document.querySelector('#canvas-target').appendChild(renderer.domElement);
  return renderer;
}

/**
* Generate the controls to be used in the scene
* @param {obj} camera: the three.js camera for the scene
* @param {obj} renderer: the three.js renderer for the scene
**/

World.prototype.getControls = function() {
  var controls = new THREE.TrackballControls(this.camera, this.renderer.domElement);
  controls.zoomSpeed = 0.4;
  controls.panSpeed = 0.4;
  return controls;
}

/**
* Add event listeners, e.g. to resize canvas on window resize
**/

World.prototype.addEventListeners = function() {
  this.addResizeListener();
  this.addLostContextListener();
}

/**
* Resize event listeners
**/

World.prototype.addResizeListener = function() {
  window.addEventListener('resize', function() {
    if (this.resizeTimeout) window.clearTimeout(this.resizeTimeout);
    this.resizeTimeout = window.setTimeout(this.handleResize.bind(this), 300);
  }.bind(this), false);
}

World.prototype.handleResize = function() {
  var canvasSize = getCanvasSize();
  this.camera.aspect = canvasSize.w / canvasSize.h;
  this.camera.updateProjectionMatrix();
  this.renderer.setSize(canvasSize.w, canvasSize.h);
  selector.tex.setSize(canvasSize.w, canvasSize.h);
  this.controls.handleResize();
  this.setPointScalar();
  delete this.resizeTimeout;
}

// set the point size scalar as a uniform on all meshes
World.prototype.setPointScalar = function() {
  // handle case of drag before scene renders
  if (!this.scene || !this.scene.children.length) return;
  var scalar = this.getPointScale();
  var meshes = this.scene.children[0].children;
  for (var i=0; i<meshes.length; i++) {
    meshes[i].material.uniforms.pointScale.value = scalar;
  }
}

/**
* Lost context event listener
**/

// listen for loss of webgl context; to manually lose context:
// world.renderer.context.getExtension('WEBGL_lose_context').loseContext();
World.prototype.addLostContextListener = function() {
  var canvas = this.renderer.domElement;
  canvas.addEventListener('webglcontextlost', function(e) {
    e.preventDefault();
    window.location.reload();
  });
}

/**
* Set the center point of the scene
**/

World.prototype.setCenter = function() {
  this.center = {
    x: (data.boundingBox.x.min + data.boundingBox.x.max) / 2,
    y: (data.boundingBox.y.min + data.boundingBox.y.max) / 2,
  }
}

/**
* Draw each of the vertices
**/

World.prototype.plot = function() {
  // add the cells for each draw call
  var drawCallToCells = this.getDrawCallToCells();
  var group = new THREE.Group();
  for (var drawCallIdx in drawCallToCells) {
    var meshCells = drawCallToCells[drawCallIdx],
        attrs = this.getGroupAttributes(meshCells),
        geometry = new THREE.InstancedBufferGeometry();
    geometry.addAttribute('uv', attrs.uv);
    geometry.addAttribute('pos0', attrs.pos0);
    geometry.addAttribute('pos1', attrs.pos1);
    geometry.addAttribute('color', attrs.color);
    geometry.addAttribute('width', attrs.width);
    geometry.addAttribute('height', attrs.height);
    geometry.addAttribute('offset', attrs.offset);
    geometry.addAttribute('opacity', attrs.opacity);
    geometry.addAttribute('position', attrs.position);
    geometry.addAttribute('textureIndex', attrs.textureIndex);
    var material = this.getShaderMaterial({
      firstTex: attrs.texStartIdx,
      textures: attrs.textures,
      useColor: false,
    });
    material.transparent = true;
    var mesh = new THREE.Points(geometry, material);
    selector.geometries.push(geometry);
    selector.meshes.push(mesh);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  this.scene.add(group);
}

// find the index of each cell's draw call
World.prototype.getDrawCallToCells = function() {
  var drawCallToCells = {};
  for (var i=0; i<data.cells.length; i++) {
    var cell = data.cells[i],
        drawCall = cell.getIndexOfDrawCall();
    if (!(drawCall in drawCallToCells)) drawCallToCells[drawCall] = [cell]
    else drawCallToCells[drawCall].push(cell);
  }
  return drawCallToCells;
}

// Return attribute data for the initial draw call of a mesh
World.prototype.getGroupAttributes = function(cells) {
  var it = this.getCellIterators(cells.length);
  for (var i=0; i<cells.length; i++) {
    var cell = cells[i];
    var rgb = this.color.setHex(cells[i].idx + 1); // use 1-based ids for colors
    it.texIndex[it.texIndexIterator++] = cell.texIdx; // index of texture among all textures -1 means LOD texture
    it.pos0[it.pos0Iterator++] = cell.x; // current position.x
    it.pos0[it.pos0Iterator++] = cell.y; // current position.y
    it.pos0[it.pos0Iterator++] = cell.z; // current position.z
    it.pos1[it.pos1Iterator++] = cell.tx; // target position.x
    it.pos1[it.pos1Iterator++] = cell.ty; // target position.y
    it.pos1[it.pos1Iterator++] = cell.tz; // target position.z
    it.color[it.colorIterator++] = rgb.r; // could be single float
    it.color[it.colorIterator++] = rgb.g; // unique color for GPU picking
    it.color[it.colorIterator++] = rgb.b; // unique color for GPU picking
    it.opacity[it.opacityIterator++] = 1.0;
    it.width[it.widthIterator++] = cell.w; // px width of cell in lod atlas
    it.height[it.heightIterator++] = cell.h; // px height of cell in lod atlas
    it.offset[it.offsetIterator++] = cell.dx; // px offset of cell from left of tex
    it.offset[it.offsetIterator++] = cell.dy; // px offset of cell from top of tex
  }

  // format the arrays into THREE attributes
  var BA = THREE.BufferAttribute,
      IBA = THREE.InstancedBufferAttribute,
      position = new BA(new Float32Array([0, 0, 0]), 3),
      uv = new BA(new Float32Array([0, 0]), 2),
      pos0 = new IBA(it.pos0, 3, true, 1),
      pos1 = new IBA(it.pos1, 3, true, 1),
      color = new IBA(it.color, 3, true, 1),
      opacity = new IBA(it.opacity, 1, true, 1),
      texIndex = new IBA(it.texIndex, 1, true, 1),
      width = new IBA(it.width, 1, true, 1),
      height = new IBA(it.height, 1, true, 1),
      offset = new IBA(it.offset, 2, true, 1);
  uv.dynamic = false;
  position.dynamic = false;
  texIndex.dynamic = true;
  pos0.dynamic = true;
  pos1.dynamic = true;
  opacity.dynamic = true;
  offset.dynamic = true;
  var texIndices = this.getTexIndices(cells);
  return {
    uv: uv,
    pos0: pos0,
    pos1: pos1,
    color: color,
    width: width,
    height: height,
    offset: offset,
    opacity: opacity,
    position: position,
    textureIndex: texIndex,
    textures: this.getTextures({
      startIdx: texIndices.first,
      endIdx: texIndices.last,
    }),
    texStartIdx: texIndices.first,
    texEndIdx: texIndices.last
  }
}

// Get the iterators required to store attribute data for `n` cells
World.prototype.getCellIterators = function(n) {
  return {
    pos0: new Float32Array(n * 3),
    pos1: new Float32Array(n * 3),
    color: new Float32Array(n * 3),
    width: new Float32Array(n),
    height: new Float32Array(n),
    offset: new Float32Array(n * 2),
    opacity: new Float32Array(n),
    texIndex: new Float32Array(n),
    pos0Iterator: 0,
    pos1Iterator: 0,
    colorIterator: 0,
    widthIterator: 0,
    heightIterator: 0,
    offsetIterator: 0,
    opacityIterator: 0,
    texIndexIterator: 0,
  }
}

// Find the first and last non -1 tex indices from a list of cells
World.prototype.getTexIndices = function(cells) {
  // find the first non -1 tex index
  var f=0; while (cells[f].texIdx == -1) f++;
  // find the last non -1 tex index
  var l=cells.length-1; while (cells[l].texIdx == -1) l--;
  // return the first and last non -1 tex indices
  return {
    first: cells[f].texIdx,
    last: cells[l].texIdx,
  };
}

// Return textures from `obj.startIdx` to `obj.endIdx` indices
World.prototype.getTextures = function(obj) {
  var textures = [];
  for (var i=obj.startIdx; i<=obj.endIdx; i++) {
    var tex = this.getTexture(data.textures[i].canvas);
    textures.push(tex);
  }
  return textures;
}

// Transform a canvas object into a THREE texture
World.prototype.getTexture = function(canvas) {
  var tex = new THREE.Texture(canvas);
  tex.needsUpdate = true;
  tex.flipY = false;
  return tex;
}

// Return an int specifying the scalar uniform for points
World.prototype.getPointScale = function() {
  var canvasSize = getCanvasSize()
  return window.devicePixelRatio * canvasSize.h * config.data.pointScalar;
}

/**
* Build a RawShaderMaterial. For a list of all types, see:
*   https://github.com/mrdoob/three.js/wiki/Uniforms-types
*
* @params:
*   {obj}
*     textures {arr}: array of textures to use in fragment shader
*     useColor {bool}: determines whether to use color in frag shader
*     firstTex {int}: the index position of the first texture in `textures`
*       within data.textures
**/

World.prototype.getShaderMaterial = function(obj) {
  var vertex = find('#vertex-shader').textContent;
  var fragment = this.getFragmentShader(obj);
  // set the uniforms and the shaders to use
  return new THREE.RawShaderMaterial({
    uniforms: {
      textures: {
        type: 'tv',
        value: obj.textures,
      },
      lodTexture: {
        type: 't',
        value: lod.tex.texture,
      },
      transitionPercent: {
        type: 'f',
        value: 0,
      },
      pointScale: {
        type: 'f',
        value: this.getPointScale(),
      },
      useColor: {
        type: 'f',
        value: obj.useColor ? 1.0 : 0.0,
      },
      cellAtlasPxPerSide: {
        type: 'f',
        value: config.size.texture,
      },
      lodAtlasPxPerSide: {
        type: 'f',
        value: config.size.lodTexture,
      },
      cellPxHeight: {
        type: 'f',
        value: config.size.cell,
      },
      lodPxHeight: {
        type: 'f',
        value: config.size.lodCell,
      }
    },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
}

/**
* Return the color fragment shader or prepare and return
* the texture fragment shader.
*
* @params:
*   {obj}
*     textures {arr}: array of textures to use in fragment shader
*     useColor {float}: 0/1 determines whether to use color in frag shader
*     firstTex {int}: the index position of the first texture in `textures`
*       within data.textures
**/

World.prototype.getFragmentShader = function(obj) {
  var useColor = obj.useColor,
      firstTex = obj.firstTex,
      textures = obj.textures,
      fragShader = find('#fragment-shader').textContent;
  // the calling agent requested the color shader, used for selecting
  if (useColor) {
    fragShader = fragShader.replace('uniform sampler2D textures[N_TEXTURES];', '');
    fragShader = fragShader.replace('TEXTURE_LOOKUP_TREE', '');
    return fragShader;
  // the calling agent requested the textured shader
  } else {
    // get the texture lookup tree
    var tree = this.getFragLeaf(-1, 'lodTexture');
    tree += ' else ' + this.getFragLeaf(0, 'textures[0]');
    for (var i=firstTex; i<firstTex + textures.length-1; i++) {
      tree += ' else ' + this.getFragLeaf(i, 'textures[' + i + ']');
    }
    // replace the text in the fragment shader
    fragShader = fragShader.replace('#define SELECTING\n', '');
    fragShader = fragShader.replace('N_TEXTURES', textures.length);
    fragShader = fragShader.replace('TEXTURE_LOOKUP_TREE', tree);
    return fragShader;
  }
}

/**
* Get the leaf component of a texture lookup tree (whitespace is aesthetic)
**/

World.prototype.getFragLeaf = function(texIdx, tex) {
  return 'if (textureIndex == ' + texIdx + ') {\n          ' +
    'gl_FragColor = texture2D(' + tex + ', scaledUv);\n        }';
}

/**
* Set the needsUpdate flag to true on each attribute in `attrs`
**/

World.prototype.attrsNeedUpdate = function(attrs) {
  this.scene.children[0].children.forEach(function(mesh) {
    attrs.forEach(function(attr) {
      mesh.geometry.attributes[attr].needsUpdate = true;
    }.bind(this))
  }.bind(this))
}

/**
* Conditionally display render stats
**/

World.prototype.getStats = function() {
  if (!window.location.href.includes('stats=true')) return null;
  var stats = new Stats();
  stats.domElement.id = 'stats';
  stats.domElement.style.position = 'absolute';
  stats.domElement.style.top = '65px';
  stats.domElement.style.right = '5px';
  stats.domElement.style.left = 'initial';
  document.body.appendChild(stats.domElement);
  return stats;
}

/**
* Fly the camera to a set of x,y,z coords
**/

World.prototype.flyTo = function(obj) {
  if (this.state.flying) return;
  this.state.flying = true;
  // get a new camera to reset .up and .quaternion on this.camera
  var camera = this.getCamera(),
      controls = new THREE.TrackballControls(camera);
  camera.position.set(obj.x, obj.y, obj.z);
  controls.target.set(obj.x, obj.y, obj.z);
  controls.update();
  // prepare scope globals to transition camera
  var time = 0,
      q0 = this.camera.quaternion.clone();
  TweenLite.to(this.camera.position, config.transitions.duration, {
    x: obj.x,
    y: obj.y,
    z: obj.z,
    onUpdate: function() {
      time++;
      var deg = time / (config.transitions.duration * 60); // scale time 0:1
      THREE.Quaternion.slerp(q0, camera.quaternion, this.camera.quaternion, deg);
    }.bind(this),
    onComplete: function() {
      var q = camera.quaternion,
          p = camera.position,
          u = camera.up,
          c = controls.target,
          zMin = getMinCellZ();
      this.camera.position.set(p.x, p.y, p.z);
      this.camera.up.set(u.x, u.y, u.z);
      this.camera.quaternion.set(q.x, q.y, q.z, q.w);
      this.controls.target = new THREE.Vector3(c.x, c.y, zMin);
      this.controls.update();
      this.state.flying = false;
    }.bind(this),
    ease: obj.ease || Power4.easeInOut,
  });
}

/**
* Get the initial camera location
**/

World.prototype.getInitialLocation = function() {
  return {
    x: this.center.x,
    y: this.center.y,
    z: config.data.spread,
  }
}

/**
* Initialize the render loop
**/

World.prototype.render = function() {
  requestAnimationFrame(this.render.bind(this));
  this.renderer.render(this.scene, this.camera);
  this.controls.update();
  selector.select();
  if (this.stats) this.stats.update();
  lod.update();
}

/**
* Initialize the plotting
**/

World.prototype.init = function() {
  this.setCenter();
  // center the camera and position the controls
  var loc = this.getInitialLocation();
  this.camera.position.set(loc.x, loc.y, loc.z);
  this.camera.lookAt(loc.x, loc.y, loc.z);
  this.controls.target = new THREE.Vector3(loc.x, loc.y, 0);
  // draw the points and start the render loop
  this.plot();
  this.render();
}

/**
* Selector: Mouse event handler that uses gpu picking
**/

function Selector() {
  this.scene = new THREE.Scene();
  this.mouse = new THREE.Vector2();
  this.mouseDown = new THREE.Vector2();
  this.tex = this.getTexture();
  this.geometries = [];
  this.meshes = [];
  this.modal = false;
}

// get the texture on which off-screen rendering will happen
Selector.prototype.getTexture = function() {
  var canvasSize = getCanvasSize();
  var tex = new THREE.WebGLRenderTarget(canvasSize.w, canvasSize.h);
  tex.texture.minFilter = THREE.LinearFilter;
  return tex;
}


// on canvas mousedown store the coords where user moused down
Selector.prototype.onMouseDown = function(e) {
  this.mouseDown.x = e.clientX;
  this.mouseDown.y = e.clientY;
}

// on canvas click, show detailed modal with clicked image
Selector.prototype.onMouseUp = function(e) {
  var cellIdx = this.select({x: e.clientX, y: e.clientY});
  // if click hit background, close the modal
  if (e.target.className == 'modal-image-sizer' ||
      e.target.className == 'modal-content' ||
      e.target.className == 'backdrop' ||
      e.target.id == 'selected-image-container') {
    return this.closeModal();
  }
  // if mouseup isn't in the last mouse position,
  // user is dragging
  // if the click wasn't on the canvas, quit
  if (e.clientX !== this.mouseDown.x ||
      e.clientY !== this.mouseDown.y || // m.down and m.up != means user is dragging
      cellIdx == -1 || // cellIdx == -1 means the user didn't click on a cell
      e.target.id !== 'pixplot-canvas') { // whether the click hit the gl canvas
    return;
  }
  this.showModal(cellIdx);
}

// called via this.onClick; shows the full-size selected image
Selector.prototype.showModal = function(cellIdx) {
  // select elements that will be updated
  var img = find('#selected-image'),
      title = find('#image-title'),
      description = find('#image-text'),
      template = find('#tag-template'),
      tags = find('#meta-tags'),
      modal = find('#selected-image-modal'),
      meta = find('#selected-image-meta'),
      deeplink = find('#eye-icon'),
      download = find('#download-icon'),
      filename = data.json.images[cellIdx]; // filename for the clicked image

  function showModal(data) {
    // set the clicked image as the source for the modal
    var source = config.data.dir + '/originals/' + filename; // source for the image in the modal
    img.src = source;
    deeplink.href = data.permalink ? data.permalink : source;
    download.href = img.src;
    download.download = filename;
    var image = new Image();
    image.onload = function() {
      if (data) {
        var t = template.textContent,
            compiled = _.template(t)({tags: data.tags}).replace(/\s\s+/g, '');
        // set metadata attributes
        tags.innerHTML = compiled ? compiled : '';
        title.textContent = data.title ? data.title : data.filename ? data.filename : '';
        description.textContent = data.description ? data.description : '';
        if (data.tags || data.title || data.description) meta.style.display = 'block';
      }
      // display the modal
      modal.style.display = 'block';
    }
    image.src = source; // only used to ensure modal image loads
  }
  // try to fetch metadata for this image if metadata is provided
  if (data.json.metadata) {
    var path = config.data.dir + '/metadata/file/' + filename + '.json';
    get(path, showModal, function(err) { showModal({}); console.warn(err); })
  } else {
    showModal({})
  }
}

Selector.prototype.closeModal = function() {
  find('#selected-image-modal').style.display = 'none';
  find('#selected-image-meta').style.display = 'none';
}

// find the world coordinates of the last mouse position
Selector.prototype.getMouseWorldCoords = function() {
  var vector = new THREE.Vector3(),
      camera = world.camera,
      mouse = new THREE.Vector2(),
      canvasSize = getCanvasSize();
  mouse.x = (this.mouse.x / canvasSize.w) * 2 - 1;
  mouse.y = (this.mouse.y / canvasSize.h) * 2 + 1;
  vector.set(mouse.x, mouse.y, 0.5);
  vector.unproject(camera);
  var direction = vector.sub(camera.position).normalize(),
      distance = - camera.position.z / direction.z,
      scaled = direction.multiplyScalar(distance),
      coords = camera.position.clone().add(scaled);
  // coord contain the selector's location
}

// get the mesh in which to render picking elements
Selector.prototype.init = function() {
  var elem = world.renderer.domElement;
  elem.addEventListener('mousedown', this.onMouseDown.bind(this));
  document.body.addEventListener('mouseup', this.onMouseUp.bind(this));
  for (var i=0; i<this.meshes.length; i++) {
    var mesh = this.meshes[i].clone();
    var material = world.getShaderMaterial({useColor: true})
    mesh.material = material;
    this.scene.add(mesh);
  }
}

// draw an offscreen world
Selector.prototype.render = function() {
  world.renderer.render(this.scene, world.camera, this.tex);
}

Selector.prototype.select = function(obj) {
  if (!world) return;
  this.render();
  if (!obj) return;
  // read the texture color at the current mouse pixel
  var pixelBuffer = new Uint8Array(4),
      x = obj.x,
      y = this.tex.height - obj.y;
  world.renderer.readRenderTargetPixels(this.tex, x, y, 1, 1, pixelBuffer);
  var id = (pixelBuffer[0] << 16) | (pixelBuffer[1] << 8) | (pixelBuffer[2]),
      cellIdx = id-1; // ids use id+1 as the id of null selections is 0
  return cellIdx;
}

/**
* Create a level-of-detail texture mechanism
**/

function LOD() {
  this.cellIdxToImage = {}; // map from cell idx to loaded image data (cache)
  this.tex = this.getCanvas(config.size.lodTexture); // texture to which all images will be written
  this.cell = this.getCanvas(config.size.lodCell); // small canvas for drawing images to be transfered to tex
  this.gridPos = { x: null, y: null }; // grid coords of current camera position
  this.cellSizeScalar = config.size.lodCell / config.size.cell;
  this.state = {
    loadQueue: [],
    neighborsRequested: false,
    openCoords: this.getOpenTexCoords(),
    gridPosToCoords: {},
    cellIdxToCoords: {},
    cellsToActivate: [],
    frame: 0,
    run: true,
  };
  this.grid = {
    coords: {}, // set by LOD.indexCells();
    size: {
      x: config.data.spread / config.lod.gridSpacing,
      y: config.data.spread / config.lod.gridSpacing,
    },
  }
}

LOD.prototype.getCanvas = function(size) {
  var canvas = getElem('canvas', { width: size, height: size, id: 'lod-canvas', }),
      texture = world.getTexture(canvas);
  return {
    canvas: canvas,
    ctx: canvas.getContext('2d'),
    texture: texture,
  }
}

// initialize the array of LOD tex coordinates available for writing
LOD.prototype.getOpenTexCoords = function() {
  var perDimension = config.size.lodTexture / config.size.lodCell,
      openCoords = [],
      s = config.size.lodCell;
  for (var y=0; y<perDimension; y++) {
    for (var x=0; x<perDimension; x++) {
      openCoords.push({ x: x*s, y: y*s, });
    }
  }
  return openCoords;
}

// add all cells to a quantized LOD grid
LOD.prototype.indexCells = function() {
  var coords = {};
  data.cells.forEach(function(cell) {
    cell.gridCoords = this.toGridCoords(cell);
    var x = cell.gridCoords.x,
        y = cell.gridCoords.y;
    if (!coords[x]) coords[x] = {};
    if (!coords[x][y]) coords[x][y] = [];
    coords[x][y].push(cell.idx);
  }.bind(this))
  this.grid.coords = coords;
}

// given an object with {x, y, z} attributes, return the object's coords in grid
LOD.prototype.toGridCoords = function(obj) {
  return {
    x: Math.floor(obj.x / lod.grid.size.x),
    y: Math.floor(obj.y / lod.grid.size.y),
  }
}

// load high-res images nearest the camera; called every frame by world.render
LOD.prototype.update = function() {
  if (!this.state.run || world.state.flying) return;
  this.updateGridPosition();
  this.loadNextImage();
  this.tick();
}

LOD.prototype.updateGridPosition = function() {
  // determine the current grid position of the user / camera
  var camPos = this.toGridCoords(world.camera.position);
  // user is in a new grid position; unload old images and load new
  if (this.gridPos.x !== camPos.x || this.gridPos.y !== camPos.y) {
    this.gridPos = camPos;
    this.state.neighborsRequested = false;
    this.unload();
    if (world.camera.position.z < config.lod.minZ) {
      this.state.loadQueue = getNested(this.grid.coords, [camPos.x, camPos.y], []);
    }
  }
}

// if there's a loadQueue, load the next image, else load neighbors
// nb: don't mutate loadQueue, as that deletes items from this.grid.coords
LOD.prototype.loadNextImage = function() {
  var cellIdx = this.state.loadQueue[0];
  this.state.loadQueue = this.state.loadQueue.slice(1);
  if (Number.isInteger(cellIdx)) this.loadImage(cellIdx);
  else if (!this.state.neighborsRequested) this.loadGridNeighbors();
}

// update the frame number and conditionally activate loaded images
LOD.prototype.tick = function() {
  if (++this.state.frame % config.lod.framesBetweenUpdates != 0) return;
  world.camera.position.z < config.lod.minZ
    ? this.addCellsToLodTexture()
    : this.unload();
}

// load a high-res image for cell at index `cellIdx`
LOD.prototype.loadImage = function(cellIdx) {
  if (this.cellIdxToImage[cellIdx]) {
    if (!this.state.cellIdxToCoords[cellIdx]) {
      this.state.cellsToActivate = this.state.cellsToActivate.concat(cellIdx);
    }
  } else {
    var image = new Image;
    image.onload = function(cellIdx) {
      this.cellIdxToImage[cellIdx] = image;
      if (!this.state.cellIdxToCoords[cellIdx]) {
        this.state.cellsToActivate = this.state.cellsToActivate.concat(cellIdx);
      }
    }.bind(this, cellIdx);
    image.src = config.data.dir + '/thumbs/' + data.json.images[cellIdx];
  }
}

// add each cell in cellsToActivate to the LOD texture
LOD.prototype.addCellsToLodTexture = function(cell) {
  var textureNeedsUpdate = false;
  // find and store the coords where each img will be stored in lod texture
  this.state.cellsToActivate.forEach(function(cellIdx) {
    // check to ensure cell is sufficiently close to camera
    var cell = data.cells[cellIdx],
        xDelta = Math.abs(cell.gridCoords.x - this.gridPos.x),
        yDelta = Math.abs(cell.gridCoords.y - this.gridPos.y);
    // don't load the cell if it's already been loaded
    if (this.state.cellIdxToCoords[cellIdx]) return;
    // don't load the cell if it's too far from the camera
    if ((xDelta > config.lod.radius * 2) || (yDelta > config.lod.radius)) return;
    // return if there are no open coordinates in the LOD texture
    var coords = this.state.openCoords.shift();
    // if (!cords), the LOD texture is full
    textureNeedsUpdate = true;
    this.addCellToLodTexture(cell, coords);
  }.bind(this))
  // indicate we've loaded all cells
  this.state.cellsToActivate = [];
  // only update the texture and attributes if the lod tex changed
  if (textureNeedsUpdate) {
    this.tex.texture.needsUpdate = true;
    world.attrsNeedUpdate(['textureIndex', 'offset']);
  }
}

// add a new cell to the LOD texture at position `coords`
LOD.prototype.addCellToLodTexture = function(cell, coords) {
  var gridKey = cell.gridCoords.x + '.' + cell.gridCoords.y,
      gridStore = this.state.gridPosToCoords;
  // initialize this grid key in the grid position to coords map
  if (!gridStore[gridKey]) gridStore[gridKey] = [];
  // store the cell's index with its coords data
  coords.cellIdx = cell.idx;
  // add the cell data to the data stores
  this.state.gridPosToCoords[gridKey].push(coords);
  this.state.cellIdxToCoords[cell.idx] = coords;
  // draw the cell's image in a new canvas
  this.tex.ctx.clearRect(coords.x, coords.y, config.size.lodCell, config.size.lodCell);
  this.tex.ctx.drawImage(this.cellIdxToImage[cell.idx], coords.x, coords.y);
  cell.activate();
}

// load the next nearest grid of cell images
LOD.prototype.loadGridNeighbors = function() {
  this.state.neighborsRequested = true;
  for (var x=-config.lod.radius*2; x<=config.lod.radius*2; x++) {
    for (var y=-config.lod.radius; y<=config.lod.radius; y++) {
      var coords = [
        this.gridPos.x + x,
        this.gridPos.y + y,
      ];
      var cellIndices = getNested(this.grid.coords, coords, []);
      if (cellIndices) {
        var cellIndices = cellIndices.filter(function(cellIdx) {
          return !this.state.cellIdxToCoords[cellIdx];
        }.bind(this))
        this.state.loadQueue = this.state.loadQueue.concat(cellIndices);
      }
    }
  }
}

// free up the high-res textures for images now distant from the camera
LOD.prototype.unload = function() {
  Object.keys(this.state.gridPosToCoords).forEach(function(gridPos) {
    var split = gridPos.split('.'),
        x = parseInt(split[0]),
        y = parseInt(split[1]),
        xDelta = Math.abs(this.gridPos.x - x),
        yDelta = Math.abs(this.gridPos.y - y);
    if ((xDelta + yDelta) > config.lod.radius) this.unloadGridPos(gridPos)
  }.bind(this));
}

LOD.prototype.unloadGridPos = function(gridPos) {
  // cache the texture coords for the grid key to be deleted
  var toUnload = this.state.gridPosToCoords[gridPos];
  // delete unloaded cell keys in the cellIdxToCoords map
  toUnload.forEach(function(coords) {
    try {
      data.cells[coords.cellIdx].deactivate();
      delete this.state.cellIdxToCoords[coords.cellIdx];
    } catch(err) {}
  }.bind(this))
  // remove the old grid position from the list of active grid positions
  delete this.state.gridPosToCoords[gridPos];
  // free all cells previously assigned to the deleted grid position
  this.state.openCoords = this.state.openCoords.concat(toUnload);
}

// clear the LOD state entirely
LOD.prototype.clear = function() {
  Object.keys(this.state.gridPosToCoords).forEach(this.unloadGridPos.bind(this));
  this.gridPos = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  world.attrsNeedUpdate(['offset', 'textureIndex']);
}

/**
* Handle load progress and welcome scene events
**/

function Welcome() {
  this.progressElem = find('#progress');
  this.loaderTextElem = find('#loader-text');
  this.loaderSceneElem = find('#loader-scene');
  this.buttonElem = find('#enter-button');
  this.buttonElem.addEventListener('click', this.onButtonClick.bind(this));
}

Welcome.prototype.onButtonClick = function(e) {
  if (e.target.className.indexOf('active') > -1) {
    requestAnimationFrame(this.removeLoader.bind(this));
  }
}

Welcome.prototype.removeLoader = function() {
  var blocks = document.querySelectorAll('.block');
  for (var i=0; i<blocks.length; i++) {
    setTimeout(function(i) {
      blocks[i].style.animation = 'exit 300s';
      setTimeout(function(i) {
        blocks[i].parentNode.removeChild(blocks[i]);
        if (i == blocks.length-1) this.startWorld();
      }.bind(this, i), 1000)
    }.bind(this, i), i*100)
  }
  document.querySelector('#progress').style.opacity = 0;
  console.log('todo: fly to coords in window.location.href if present');
}

Welcome.prototype.updateProgress = function() {
  var progress = valueSum(data.textureProgress) / data.textureCount;
  // remove the decimal value from the load progress
  progress = progress.toString();
  var index = progress.indexOf('.');
  if (index > -1) progress = progress.substring(0, index);
  // display the load progress
  this.progressElem.textContent = progress + '%';
  if (progress == 100 && data.loadedTextures == data.textureCount) {
    this.buttonElem.className += ' active';
  }
}

Welcome.prototype.startWorld = function() {
  requestAnimationFrame(function() {
    world.init();
    selector.init();
    setTimeout(function() {
      document.querySelector('#loader-scene').classList += 'hidden';
      world.state.displayed = true;
    }.bind(this), 50);
  }.bind(this))
}

/**
* Configure filters
**/

function Filters() {
  this.filters = [];
}

Filters.prototype.loadFilters = function() {
  var url = config.data.dir + '/metadata/filters/filters.json';
  get(url, function(data) {
    for (var i=0; i<data.length; i++) this.filters.push(new Filter(data[i]));
  }.bind(this))
}

function Filter(obj) {
  this.values = obj.filter_values || [];
  this.name = obj.filter_name || '';
  if (this.values.length > 1) this.createSelect();
}

Filter.prototype.createSelect = function() {
  var select = document.createElement('select'),
      option = document.createElement('option');
  option.textContent = 'All Values';
  select.appendChild(option);

  for (var i=0; i<this.values.length; i++) {
    var option = document.createElement('option');
    option.textContent = this.values[i].replace(/__/g, ' ');
    select.appendChild(option);
  }
  select.onchange = this.onChange.bind(this);
  find('#filters').appendChild(select);
}

Filter.prototype.onChange = function(e) {
  var val = e.target.value;
  // case where user selected the 'All Values' option
  if (val === 'All Values') {
    this.filterCells(data.cells.reduce(function(arr, cell, cellIdx) {
      arr.push(data.json.images[cellIdx]); return arr;
    }.bind(this), []))
  // case where user selected a specific option
  } else {
    // each {{ level-name }}.json file should use double underscore instead of whitespace
    var level = val.replace(/\//g, '-').replace(/ /g, '__') + '.json',
        url = config.data.dir + '/metadata/options/' + level;
    get(url, this.filterCells);
  }
}

// mutate the opacity of each cell to activate / deactivate
Filter.prototype.filterCells = function(names) {
  names = names.reduce(function(obj, n) {
    obj[n] = true; return obj;
  }, {}); // facilitate O(1) lookups

  data.cells.forEach(function(cell, idx) {
    // update the buffer attributes that describe this cell to the GPU
    var meshes = world.scene.children[0],
        attrs = meshes.children[cell.getIndexOfDrawCall()].geometry.attributes,
        opacity = data.json.images[idx] in names ? 1 : 0.1;
    attrs.opacity.array[cell.getIndexInDrawCall()] = opacity;
  }.bind(this))
  world.attrsNeedUpdate(['opacity']);
}

/**
* Hotspots
**/

function Hotspots() {
  this.template = find('#hotspot-template');
  this.target = find('#hotspots');
  this.init();
}

Hotspots.prototype.init = function() {
  get(getPath(data.json.layouts[data.initialLayout].centroids), function(json) {
    this.json = json;
    this.target.innerHTML = _.template(this.template.innerHTML)({
      hotspots: this.json,
    });
    var hotspots = findAll('.hotspot');
    for (var i=0; i<hotspots.length; i++) {
      hotspots[i].addEventListener('click', function(idx) {
        var cell = data.cells[data.hotspots.json[idx].idx];
        world.flyTo({
          x: cell.x,
          y: cell.y,
          z: cell.z + 100,
        })
      }.bind(this, i))
    }
  }.bind(this))
}

/**
* Assess WebGL parameters
**/

function Webgl() {
  this.gl = this.getGl();
  this.limits = this.getLimits();
}

/**
* Get a WebGL context, or display an error if WebGL is not available
**/

Webgl.prototype.getGl = function() {
  var gl = getElem('canvas').getContext('webgl');
  if (!gl) find('#webgl-not-available').style.display = 'block';
  return gl;
}

/**
* Get the limits of the user's WebGL context
**/

Webgl.prototype.getLimits = function() {
  // fetch all browser extensions as a map for O(1) lookups
  var extensions = this.gl.getSupportedExtensions().reduce(function(obj, i) {
    obj[i] = true; return obj;
  }, {})
  // assess support for 32-bit indices in gl.drawElements calls
  var maxIndex = 2**16 - 1;
  ['', 'MOZ_', 'WEBKIT_'].forEach(function(ext) {
    if (extensions[ext + 'OES_element_index_uint']) maxIndex = 2**32 - 1;
  })
  // for stats see e.g. https://webglstats.com/webgl/parameter/MAX_TEXTURE_SIZE
  return {
    // max h,w of textures in px
    textureSize: Math.min(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE), 2**13),
    // max textures that can be used in fragment shader
    textureCount: this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS),
    // max textures that can be used in vertex shader
    vShaderTextures: this.gl.getParameter(this.gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    // max number of indexed elements
    indexedElements: maxIndex,
  }
}

/**
* Make an XHR get request for data
*
* @param {str} url: the url of the data to fetch
* @param {func} handleSuccess: onSuccess callback function
* @param {func} handleErr: onError callback function
**/

function get(url, handleSuccess, handleErr) {
  handleSuccess = handleSuccess || function() {};
  handleErr = handleErr || function() {};
  var xmlhttp = new XMLHttpRequest();
  xmlhttp.onreadystatechange = function() {
    if (xmlhttp.readyState == XMLHttpRequest.DONE) {
      xmlhttp.status === 200
        ? handleSuccess(JSON.parse(xmlhttp.responseText))
        : handleErr(xmlhttp)
    };
  };
  xmlhttp.open('GET', url, true);
  xmlhttp.send();
};

/**
* Find the smallest z value among all cells
**/

function getMinCellZ() {
  return Math.min.apply(Math, data.cells.map(function(d) {return d.z;}))
}

/**
* Create an element
*
* @param {obj} obj
*   tag: specifies the tag to use for the element
*   obj: a set of k/v attributes to be applied to the element
**/

function getElem(tag, obj) {
  var obj = obj || {};
  var elem = document.createElement(tag);
  Object.keys(obj).forEach(function(attr) {
    elem[attr] = obj[attr];
  })
  return elem;
}

/**
* Create a general element selector
**/

function find(selector) {
  return document.querySelector(selector);
}

function findAll(selector) {
  return document.querySelectorAll(selector);
}

/**
* Find the sum of values in an object
**/

function valueSum(obj) {
  return Object.keys(obj).reduce(function(a, b) {
    a += obj[b]; return a;
  }, 0)
}

/**
* Get the value assigned to a nested key in a dict
**/

function getNested(obj, keyArr, ifEmpty) {
  var result = keyArr.reduce(function(o, key) {
    return o[key] ? o[key] : {};
  }, obj);
  return result.length ? result : ifEmpty;
}

/**
* Get the H,W of the canvas to use for rendering
**/

function getCanvasSize() {
  var elem = document.querySelector('#canvas-target');
  return {
    w: elem.clientWidth,
    h: elem.clientHeight,
  }
}

/**
* Get the user's current url route
**/

function getPath(path) {
  var base = window.location.origin;
  base += window.location.pathname.replace('index.html', '');
  base += path.replace('/output/', '');
  return base;
}

/**
* Scale each dimension of an array -1:1
**/

function scale(arr) {
  var max = Number.POSITIVE_INFINITY,
      min = Number.NEGATIVE_INFINITY,
      domX = {min: max, max: min},
      domY = {min: max, max: min},
      domZ = {min: max, max: min};
  // find the min, max of each dimension
  for (var i=0; i<arr.length; i++) {
    var x = arr[i][0],
        y = arr[i][1],
        z = arr[i][2] || 0;
    if (x < domX.min) domX.min = x;
    if (x > domX.max) domX.max = x;
    if (y < domY.min) domY.min = y;
    if (y > domY.max) domY.max = y;
    if (z < domZ.min) domZ.min = z;
    if (z > domZ.max) domZ.max = z;
  }
  var centered = [];
  for (var i=0; i<arr.length; i++) {
    var cx = (((arr[i][0]-domX.min)/(domX.max-domX.min))*2)-1,
        cy = (((arr[i][1]-domY.min)/(domY.max-domY.min))*2)-1,
        cz = (((arr[i][2]-domZ.min)/(domZ.max-domZ.min))*2)-1 || null;
    if (arr[i].length == 3) centered.push([cx, cy, cz]);
    else centered.push([cx, cy]);
  }
  return centered;
}

/**
* Main
**/

var welcome = new Welcome();
var webgl = new Webgl();
var config = new Config();
var filters = new Filters();
var selector = new Selector();
var layout = new Layout();
var world = new World();
var lod = new LOD();
var data = new Data();
