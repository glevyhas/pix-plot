/**
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
**/

/**
* Config: The master config for this visualization.
*   Contains the following attributes:
*
* data:
*   url: name of the directory where input data lives
*   file: name of the file with positional data
*   spread:
*     x: spread of data along the x axis -- higher moves points apart
*     y: spread of data along the x axis -- higher moves points apart
*     z: spread of data along the x axis -- higher moves points apart
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
* layout:
*   preferences: list of strings, each denoting a possible layout. Controls
*     the order of the layout options in the layout select within the nav.
* transition:
*   duration: number of seconds each layout transition should take
*   ease: TweenLite ease config values for transitions
* atlasesPerTex: number of atlases to include in each texture
* cellsPerAtlas: number of cells to include in each atlas
* cellsPerDrawCall: number of GL_POINT primitives to include in each draw call
**/

function Config() {
  this.data = {
    dir: 'output',
    file: 'plot_data.json',
    spread: {
      x: 4000,
      y: 4000,
      z: 4000,
    },
  }
  this.size = {
    cell: 32,
    lodCell: 128,
    atlas: 2048,
    texture: webgl.limits.textureSize,
    lodTexture: 4096,
  }
  this.lod = {
    minZ: 250, // todo - factor into distance function
    radius: 2,
    framesBetweenUpdates: 40,
    gridSpacing: 0.01,
  }
  this.layout = {
    preferences: ['grid', 'umap_2d', 'tsne_3d', 'tsne_2d'],
  }
  this.transitions = {
    duration: 1.5,
    ease: {
      value: 1,
      ease: Power2.easeInOut,
    }
  }
  this.atlasesPerTex = Math.pow((this.size.texture / this.size.atlas), 2);
  this.cellsPerAtlas = Math.pow((this.size.atlas / this.size.cell), 2);
  this.cellsPerTex = this.cellsPerAtlas * this.atlasesPerTex;
  this.cellsPerDrawCall = Math.min(
    // case where elements per draw call is limiting factor
    webgl.limits.indexedElements,
    // case where textures are limiting factor (-1 to fit high res tex in calls)
    (webgl.limits.textureCount - 1) * this.cellsPerTex,
  );
}

/**
* Data: Container for data consumed by application
*
* cellCount: total number of cells / images to render; specified in config.data.file
* atlasCount: total number of atlases to load; specified in config.data.file
* textureCount: total number of textures to create
* textures: array of Texture objects to render. Each requires a draw call
* cells: array of images to render. Each depicts a single input image
* textureProgress: maps texture index to its loading progress (0:100)
* textureCount: total number of textures to load
* loadedTextures: number of textures loaded so far
* boundingBox: the domains for the x and y axes. Used for setting initial
*   camera position and creating the LOD grid
**/

function Data() {
  this.cellCount = null;
  this.atlasCount = null;
  this.textureCount = null;
  this.cells = [];
  this.textures = [];
  this.textureProgress = {};
  this.loadedTextures = 0;
  this.boundingBox = {
    x: {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    },
    y: {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    },
  };
  this.load();
}

// Load json data with chart element positions
Data.prototype.load = function() {
  get(config.data.dir + '/' + config.data.file, function(json) {
    this.cellData = json.cells.data;
    layout.setOptions(json.cells.layouts); // set available layouts
    this.cellCount = this.cellData.length;
    this.atlasCount = json.atlas_counts['32px'];
    this.textureCount = Math.ceil(this.atlasCount / config.atlasesPerTex);;
    // load each texture for this data set
    for (var i=0; i<this.textureCount; i++) {
      this.textures.push(new Texture({
        idx: i,
        onProgress: this.onTextureProgress.bind(this),
        onLoad: this.onTextureLoad.bind(this),
      }));
    };
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
  for (var i=0; i<this.getAtlasCount(this.idx); i++) {
    this.atlases.push(new Atlas({
      idx: (config.atlasesPerTex * this.idx) + i, // atlas index among all atlases
      onProgress: this.onAtlasProgress.bind(this),
      onLoad: this.onAtlasLoad.bind(this),
    }))
  }
}

// Get the number of atlases to include in this texture
Texture.prototype.getAtlasCount = function(texIdx) {
  return data.atlasCount / config.atlasesPerTex > (texIdx + 1)
    ? config.atlasesPerTex
    : data.atlasCount % config.atlasesPerTex;
}

// Store the load progress of each atlas file
Texture.prototype.onAtlasProgress = function(atlasIdx, progress) {
  this.atlasProgress[atlasIdx] = progress;
  var textureProgress = valueSum(this.atlasProgress);
  this.onProgress(this.idx, textureProgress);
}

// Add each cell from the loaded atlas to the texture's canvas
Texture.prototype.onAtlasLoad = function(atlas) {
  // Add the loaded atlas file the texture's canvas
  var atlasSize = config.size.atlas,
      textureSize = config.size.texture,
      // atlas index within this texture
      idx = atlas.idx % config.atlasesPerTex,
      // x and y offsets within texture
      dx = (idx * atlasSize) % textureSize,
      dy = Math.floor((idx * atlasSize) / textureSize) * atlasSize,
      dw = config.size.atlas,
      dh = config.size.atlas;
  this.ctx.drawImage(atlas.image, dx, dy, dw, dh);
  // If all atlases are loaded, build the texture
  if (++this.loadedAtlases == this.getAtlasCount()) this.onLoad(this.idx);
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
  this.url = config.data.dir + '/atlas_files/32px/atlas-' + this.idx + '.jpg';
  this.cells = [];
  this.setCells();
  this.load();
}

Atlas.prototype.setCells = function() {
  var cellIndices = this.getAtlasCellIndices();
  // find the index position of the first cell among all cells
  for (var i=cellIndices.start; i<cellIndices.end; i++) {
    this.cells.push(new Cell({idx: i})) // cell's index among all cells
  }
}

// Return the start + end indices of the cells to be included in this atlas
Atlas.prototype.getAtlasCellIndices = function() {
  return {
    start: config.cellsPerAtlas * this.idx,
    end: Math.min(config.cellsPerAtlas * (this.idx + 1), data.cellCount),
  }
}

Atlas.prototype.load = function() {
  this.image = new Image;
  this.image.onload = function() {
    this.onLoad(this);
  }.bind(this)
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
* state: the current state for this image
**/

function Cell(obj) {
  var d = Object.assign([], data.cellData[obj.idx]);
  this.idx = obj.idx;
  this.name = d[0]; // name for image (for searching on page load)
  this.w = d[1];
  this.h = d[2];
  this.gridCoords = {}; // x, y pos of the cell in the lod grid (set by lod)
  this.layouts = this.getLayouts();
  this.state = Object.assign({}, this.getDefaultState());
  this.updateParentBoundingBox();
  data.cells[this.idx] = this; // augment window.data.cells
}

Cell.prototype.getLayouts = function() {
  // build up the positional vals for this cell
  var options = {},
      d = Object.assign([], data.cellData[this.idx]),
      positions = d[3]; // cell position arrays
  layout.options.forEach(function(i, idx) {
    if (i != 'grid') { //skip grid key as it doesn't come from server
      var pos = positions[idx];
      options[i] = {
        x: pos[0] * config.data.spread.x,
        y: pos[1] * config.data.spread.y,
        z: pos.length > 2 ? pos[2] * config.data.spread.z : this.idx % 50,
      }
    };
  }.bind(this))
  // compute grid position of cell
  var perSide = Math.ceil(Math.pow(data.cellCount, 0.5)), // n cells per row/col of grid layout
      scalar = config.size.cell * 0.7,
      center = (scalar * perSide)/2;
  // add the grid position of the cell to the positional options for cell
  options.grid = {
    x: (this.idx % perSide * scalar) - center,
    y: (Math.floor(this.idx / perSide) * scalar) - center,
    z: 0,
  }
  return options;
}

Cell.prototype.getDefaultState = function() {
  return {
    position: this.layouts[layout.selected],
    target: this.layouts[layout.selected],
    size: this.getSize(),
    texIdx: this.getTextureIndex(),
    posInTex: this.getPosInTex(),
    isLarge: false,
  };
}

Cell.prototype.getSize = function() {
  if (this.w == this.h) {
    var topPad = 0,
        leftPad = 0,
        w = config.size.cell,
        h = config.size.cell;
  } else if (this.w > this.h) {
    var topPad = Math.ceil(((this.w - this.h)/(this.w)) * config.size.cell / 2),
        leftPad = 0,
        w = config.size.cell,
        h = this.h/this.w*config.size.cell;
  } else if (this.h > this.w) {
    var topPad = 0,
        leftPad = Math.ceil(((this.h - this.w)/(this.h)) * config.size.cell / 2),
        w = this.w/this.h*config.size.cell,
        h = config.size.cell;
  }
  return {
    w: w,
    h: h,
    topPad: topPad,
    leftPad: leftPad,
    fullCell: config.size.cell,
    inTexture: config.size.cell / config.size.texture,
  }
}

Cell.prototype.getPosInTex = function() {
  var atlasIndex = this.getAtlasIndex(),
      atlasPosInTex = this.getAtlasPosInTex(atlasIndex),
      posInAtlas = this.getPosInAtlas();
  return {
    x: atlasPosInTex.x + posInAtlas.x,
    y: atlasPosInTex.y + posInAtlas.y,
  }
}

Cell.prototype.getAtlasPosInTex = function(atlasIdx) {
  // atlas index in its texture
  var idxInTex = this.getIndexInTexture();
  return {
    x: (idxInTex % Math.pow(config.atlasesPerTex, 0.5)) * config.size.atlas,
    y: Math.floor(idxInTex / Math.pow(config.atlasesPerTex, 0.5)) * config.size.atlas,
  }
}

Cell.prototype.getPosInAtlas = function() {
  var idxInAtlas = this.getIndexInAtlas();
  return {
    x: (idxInAtlas % Math.pow(config.cellsPerAtlas, 0.5)) * config.size.cell,
    y: Math.floor(idxInAtlas / Math.pow(config.cellsPerAtlas, 0.5)) * config.size.cell,
  }
}

// get the index position of this cell's texture among all textures
Cell.prototype.getTextureIndex = function() {
  return Math.floor(this.idx / config.cellsPerTex);
}

// get the index position of this cell's atlas among all atlases
Cell.prototype.getAtlasIndex = function() {
  return Math.floor(this.idx / config.cellsPerAtlas);
}

// get the index position of this cell within its texture
Cell.prototype.getIndexInTexture = function() {
  return this.getAtlasIndex() % config.atlasesPerTex;
}

// get the index position of this cell within its atlas
Cell.prototype.getIndexInAtlas = function() {
  return this.idx % config.cellsPerAtlas;
}

// get the index position of this cell within its draw call
Cell.prototype.getIndexInDrawCall = function() {
  return this.idx % config.cellsPerDrawCall;
}

// get the index position of this cell's draw call within all draw calls
Cell.prototype.getIndexOfDrawCall = function() {
  return Math.floor(this.idx / config.cellsPerDrawCall);
}

Cell.prototype.updateParentBoundingBox = function() {
  ['x', 'y'].forEach(function(dim) {
    if (this.state.position[dim] > data.boundingBox[dim].max) {
      data.boundingBox[dim].max = this.state.position[dim];
    } else if (this.state.position[dim] < data.boundingBox[dim].min) {
      data.boundingBox[dim].min = this.state.position[dim];
    }
  }.bind(this))
}

/**
* Cell activation / deactivation
**/

// make the cell active in LOD by mutating its state
Cell.prototype.activate = function() {
  this.state = Object.assign({}, this.state, {
    isLarge: true,
    texIdx: -1,
    posInTex: {
      x: lod.state.cellIdxToCoords[this.idx].x,
      y: lod.state.cellIdxToCoords[this.idx].y,
    },
    size: {
      w: config.size.lodCell,
      h: config.size.lodCell,
      topPad: this.state.size.topPad * lod.cellSizeScalar,
      leftPad: this.state.size.leftPad * lod.cellSizeScalar,
      inTexture: config.size.lodCell / config.size.lodTexture,
      fullCell: config.size.lodCell,
    },
  })
  // mutate the cell buffer attributes
  var attrs = ['textureIndex', 'textureOffset', 'size'];
  for (var i=0; i<attrs.length; i++) {
    this.mutateBuffer(attrs[i]);
  }
}

// deactivate the cell in LOD by mutating its state
Cell.prototype.deactivate = function() {
  // pass in the current position and target in case they've changed
  var lastState = Object.assign({}, this.state);
  this.state = Object.assign({}, this.getDefaultState(), {
    position: lastState.position,
    target: lastState.target,
  });
  // mutate the cell buffer attributes
  var attrs = ['textureIndex', 'textureOffset', 'size'];
  for (var i=0; i<attrs.length; i++) {
    this.mutateBuffer(attrs[i]);
  }
}

// update this cell's buffer values for bound attribute `attr`
Cell.prototype.mutateBuffer = function(attr) {
  // find the buffer attributes that describe this cell to the GPU
  var group = world.scene.children[0],
      attrs = group.children[this.getIndexOfDrawCall()].geometry.attributes,
      idxInDrawCall = this.getIndexInDrawCall();

  switch(attr) {
    case 'textureIndex':
      // set the texIdx to -1 to read from the uniforms.lodTexture
      attrs.textureIndex.array[idxInDrawCall] = this.state.texIdx;
      return;

    case 'textureOffset':
      // find cell's position in the LOD texture then set x, y tex offsets
      var x = this.state.posInTex.x / this.state.size.fullCell,
          y = this.state.posInTex.y / this.state.size.fullCell;
      // set the x then y texture offsets for this cell
      attrs.textureOffset.array[(idxInDrawCall * 2)] = x;
      attrs.textureOffset.array[(idxInDrawCall * 2) + 1] = y;
      return;

    case 'size':
      // set the updated lod cell size
      attrs.size.array[idxInDrawCall] = this.state.size.inTexture;
      return;

    case 'translation':
      // set the cell's translation
      attrs.translation.array[(idxInDrawCall * 3)] = this.state.position.x;
      attrs.translation.array[(idxInDrawCall * 3) + 1] = this.state.position.y;
      attrs.translation.array[(idxInDrawCall * 3) + 2] = this.state.position.z;
      return;

    case 'target':
      // set the cell's target translation
      attrs.target.array[(idxInDrawCall * 3)] = this.state.target.x;
      attrs.target.array[(idxInDrawCall * 3) + 1] = this.state.target.y;
      attrs.target.array[(idxInDrawCall * 3) + 2] = this.state.target.z;
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
  this.options = Object.assign([], options).concat('grid');
  var preferences = config.layout.preferences;
  // set the initial layout - try to set the highest preference layout
  for (var i=0; i<preferences.length; i++) {
    if (this.options.indexOf(preferences[i]) > -1 && !this.selected) {
      this.selected = preferences[i];
    }
  }
  if (!this.selected) this.selected = this.options[0];
  if (this.options.length > 1) this.render();
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
  // set the target locations of each point
  data.cells.forEach(function(cell) {
    cell.state.target = Object.assign({}, cell.layouts[this.selected]);
  }.bind(this))
  // iterate over each mesh to be updated
  var meshes = world.scene.children[0].children;
  for (var i=0; i<meshes.length; i++) {
    // transition the transitionPercent attribute on the mesh
    TweenLite.to(meshes[i].material.uniforms.transitionPercent,
      config.transitions.duration, config.transitions.ease);
    // update the target positional attribute
    var iter = 0,
        start = i*config.cellsPerDrawCall, // start and end cells
        end = (i+1)*config.cellsPerDrawCall;
    data.cells.slice(start, end).forEach(function(cell) {
      meshes[i].geometry.attributes.target.array[iter++] = cell.state.target.x;
      meshes[i].geometry.attributes.target.array[iter++] = cell.state.target.y;
      meshes[i].geometry.attributes.target.array[iter++] = cell.state.target.z;
    })
    meshes[i].geometry.attributes.target.needsUpdate = true;
    // set the cell's new position to enable future transitions
    setTimeout(this.onTransitionComplete.bind(this, {
      mesh: meshes[i],
      cells: data.cells.slice(start, end),
    }), config.transitions.duration * 1000);
  }
}

// reset the cell translation buffers, update cell state
// and reset the time uniforms after a positional transition completes
Layout.prototype.onTransitionComplete = function(obj) {
  this.elem.disabled = false;
  var attr = obj.mesh.geometry.attributes.translation,
      iter = 0;
  obj.cells.forEach(function(cell) {
    cell.state.position = {
      x: cell.state.target.x,
      y: cell.state.target.y,
      z: cell.state.target.z,
    }
    attr.array[iter++] = cell.state.position.x;
    attr.array[iter++] = cell.state.position.y;
    attr.array[iter++] = cell.state.position.z;
  }.bind(this))
  // update the positional attribute and time uniform on the mesh
  attr.needsUpdate = true;
  obj.mesh.material.uniforms.transitionPercent = {
    type: 'f',
    value: 0,
  };
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
  scene.background = new THREE.Color(0x222222);
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
  var config = {antialias: true, powerPreference: 'high-performance'},
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
  var group = new THREE.Group();
  var cells = data.cells;
  var drawCalls = Math.ceil(data.cellCount / config.cellsPerDrawCall);
  for (var i=0; i<drawCalls; i++) {
    var start = i * config.cellsPerDrawCall;
    var end = (i+1) * config.cellsPerDrawCall;
    var groupCells = cells.slice(start, end);
    var attrs = this.getGroupAttributes(groupCells);
    var geometry = new THREE.InstancedBufferGeometry();
    geometry.addAttribute('uv', attrs.uv);
    geometry.addAttribute('position', attrs.position);
    geometry.addAttribute('size', attrs.size);
    geometry.addAttribute('textureIndex', attrs.textureIndex);
    geometry.addAttribute('textureSize', attrs.textureSize);
    geometry.addAttribute('textureOffset', attrs.textureOffset);
    geometry.addAttribute('translation', attrs.translation);
    geometry.addAttribute('target', attrs.target);
    geometry.addAttribute('color', attrs.color);
    geometry.addAttribute('opacity', attrs.opacity);
    var material = this.getShaderMaterial({
      firstTex: attrs.texStartIdx,
      textures: attrs.textures,
      useColor: 0.0,
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

// Return attribute data for the initial draw call of a mesh
World.prototype.getGroupAttributes = function(cells) {
  var it = this.getCellIterators(cells.length);
  var texIndices = this.getTexIndices(cells);
  for (var i=0; i<cells.length; i++) {
    var cell = cells[i].state;
    var rgb = this.color.setHex(cells[i].idx + 1); // use 1-based ids for colors
    it.sizes[it.sizesIterator++] = cell.size.inTexture;
    it.texIndices[it.texIndexIterator++] = cell.texIdx;
    it.texSizes[it.texSizeIterator++] = cell.size.w / cell.size.fullCell;
    it.texSizes[it.texSizeIterator++] = cell.size.h / cell.size.fullCell;
    it.texOffsets[it.texOffsetIterator++] = cell.posInTex.x / cell.size.fullCell;
    it.texOffsets[it.texOffsetIterator++] = cell.posInTex.y / cell.size.fullCell;
    it.translations[it.translationIterator++] = cell.position.x;
    it.translations[it.translationIterator++] = cell.position.y;
    it.translations[it.translationIterator++] = cell.position.z;
    it.targets[it.targetIterator++] = cell.target.x;
    it.targets[it.targetIterator++] = cell.target.y;
    it.targets[it.targetIterator++] = cell.target.z;
    it.colors[it.colorIterator++] = rgb.r;
    it.colors[it.colorIterator++] = rgb.g;
    it.colors[it.colorIterator++] = rgb.b;
    it.opacities[it.opacityIterator++] = 1.0;
  }
  // format the arrays into THREE attributes
  var BA = THREE.BufferAttribute,
      IBA = THREE.InstancedBufferAttribute,
      uvAttr = new BA(new Float32Array([0, 0]), 2),
      positionAttr = new BA(new Float32Array([0, 0, 0]), 3),
      sizeAttr = new IBA(it.sizes, 1, true, 1),
      texIndexAttr = new IBA(it.texIndices, 1, true, 1),
      texSizeAttr = new IBA(it.texSizes, 2, true, 1),
      texOffsetAttr = new IBA(it.texOffsets, 2, true, 1),
      translationAttr = new IBA(it.translations, 3, true, 1),
      targetAttr = new IBA(it.targets, 3, true, 1),
      colorAttr = new IBA(it.colors, 3, true, 1),
      opacityAttr = new IBA(it.opacities, 1, true, 1);
  uvAttr.dynamic = true;
  positionAttr.dynamic = true;
  texIndexAttr.dynamic = true;
  texSizeAttr.dynamic = true;
  texOffsetAttr.dynamic = true;
  translationAttr.dynamic = true;
  targetAttr.dynamic = true;
  opacityAttr.dynamic = true;
  return {
    uv: uvAttr,
    size: sizeAttr,
    position: positionAttr,
    textureSize: texSizeAttr,
    textureIndex: texIndexAttr,
    textureOffset: texOffsetAttr,
    translation: translationAttr,
    target: targetAttr,
    color: colorAttr,
    opacity: opacityAttr,
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
    sizes: new Float32Array(n),
    texIndices: new Float32Array(n),
    texSizes: new Float32Array(n * 2),
    texOffsets: new Float32Array(n * 2),
    translations: new Float32Array(n * 3),
    targets: new Float32Array(n * 3),
    colors: new Float32Array(n * 3),
    opacities: new Float32Array(n),
    sizesIterator: 0,
    texSizeIterator: 0,
    texIndexIterator: 0,
    texOffsetIterator: 0,
    translationIterator: 0,
    targetIterator: 0,
    colorIterator: 0,
    opacityIterator: 0,
  }
}

// Find the first and last non -1 tex indices from a list of cells
World.prototype.getTexIndices = function(cells) {
  // find the first non -1 tex index
  var f=0;
  while (cells[f].state.texIdx == -1) f++;
  // find the last non -1 tex index
  var l=cells.length-1;
  while (cells[l].state.texIdx == -1) l--;
  // return the first and last non -1 tex indices
  return {
    first: cells[f].state.texIdx,
    last: cells[l].state.texIdx,
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
  return window.devicePixelRatio * canvasSize.h * 12;
}

/**
* Build a RawShaderMaterial. For a list of all types, see:
*   https://github.com/mrdoob/three.js/wiki/Uniforms-types
*
* @params:
*   {obj}
*     textures {arr}: array of textures to use in fragment shader
*     useColor {float}: 0/1 determines whether to use color in frag shader
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
        value: obj.useColor,
      },
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
  if (useColor == 1.0) {
    fragShader = fragShader.replace('uniform sampler2D textures[N_TEXTURES];', '');
    fragShader = fragShader.replace('TEXTURE_LOOKUP_TREE', '');
    return fragShader;
  // the calling agent requested the textured shader
  } else {
    // get the texture lookup tree
    var tree = this.getFragLeaf(0, 'textures[0]', true);
    for (var i=firstTex; i<firstTex + textures.length-1; i++) {
      tree += ' else ' + this.getFragLeaf(i, 'textures[' + i + ']', true);
    }
    // add the conditional for the lod texture
    tree += ' else ' + this.getFragLeaf(i, 'lodTexture', false);
    // replace the text in the fragment shader
    fragShader = fragShader.replace('#define SELECTING\n', '');
    fragShader = fragShader.replace('N_TEXTURES', textures.length);
    fragShader = fragShader.replace('TEXTURE_LOOKUP_TREE', tree);
    return fragShader;
  }
}

/**
* Get the leaf component of a texture lookup tree
**/

World.prototype.getFragLeaf = function(texIdx, texture, includeIf) {
  var ws = '        '; // whitespace (purely aesthetic)
  var start = includeIf
    ? 'if (textureIndex == ' + texIdx + ') {\n'
    : '{\n';
  return start +
    ws + 'gl_FragColor = texture2D(' + texture + ', scaledUv);\n' +
    ws + 'gl_FragColor.a = vOpacity;\n ' +
    ws.substring(3) + '}'
}

/**
* Set the needsUpdate flag to true on each attribute in `attrs`
**/

World.prototype.attrsNeedUpdate = function(attrs) {
  this.scene.children[0].children.forEach(function(mesh) {
    attrs.forEach(function(attr) {
      mesh.geometry.attributes[attr].needsUpdate = true;
    })
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
    z: config.data.spread.z,
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
  var selected = this.select({x: e.clientX, y: e.clientY});
  // if click hit background, close the modal
  if (e.target.className == 'modal-image-sizer' ||
      e.target.className == 'modal-content' ||
      e.target.className == 'backdrop') {
    this.closeModal();
    return;
  }
  // if mouseup isn't in the last mouse position,
  // user is dragging
  // if the click wasn't on the canvas, quit
  if (e.clientX !== this.mouseDown.x ||
      e.clientY !== this.mouseDown.y || // m.down and m.up != means user is dragging
      selected == -1 || // selected == -1 means the user didn't click on a cell
      e.target.id !== 'pixplot-canvas') { // whether the click hit the gl canvas
    return;
  }
  this.showModal(selected);
}

// called via this.onClick; shows the full-size selected image
Selector.prototype.showModal = function(selected) {

  // select elements that will be updated
  var img = find('#selected-image'),
      title = find('#image-title'),
      description = find('#image-text'),
      template = find('#tag-template'),
      tags = find('#meta-tags'),
      modal = find('#selected-image-modal'),
      meta = find('#selected-image-meta'),
      deeplink = find('#eye-icon'),
      download = find('#download-icon');
  // fetch data for the selected record
  var filename = data.cells[selected].name + '.json';
  get(config.data.dir + '/metadata/' + filename, function(data) {
    var image = new Image();
    image.onload = function() {
      // compile the template and remove whitespace for FF formatting
      var compiled = _.template(template.textContent)({tags: data.tags});
      compiled = compiled.replace(/\s\s+/g, '');
      // set metadata attributes
      img.src = data.src ? data.src : '';
      title.textContent = data.title ? data.title : data.filename ? data.filename : '';
      description.textContent = data.description ? data.description : '';
      tags.innerHTML = compiled ? compiled : '';
      // update action buttons
      deeplink.href = data.permalink ? data.permalink : '#';
      download.href = img.src;
      download.download = data.filename ? data.filename : Math.random();
      // show/hide the modal
      if (data.src) modal.style.display = 'block';
      if (data.title || data.description || data.tags) meta.style.display = 'block';
    }
    // set or get the image src and load the image
    if (!data.src) data.src = config.data.dir + '/originals/' + data.filename;
    image.src = data.src;
  });
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
  console.log(' * selector location:', coords);
}

// get the mesh in which to render picking elements
Selector.prototype.init = function() {
  var elem = world.renderer.domElement;
  elem.addEventListener('mousedown', this.onMouseDown.bind(this));
  document.body.addEventListener('mouseup', this.onMouseUp.bind(this));
  for (var i=0; i<this.meshes.length; i++) {
    var mesh = this.meshes[i].clone();
    var material = world.getShaderMaterial({ useColor: 1.0, })
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
      selected = id-1; // ids use id+1 as the id of null selections is 0
  return selected;
}

/**
* Create a level-of-detail texture mechanism
**/

function LOD() {
  this.gridPos = { x: null, y: null }; // grid coords of current camera position
  this.cellIdxToImage = {};
  this.cellSizeScalar = config.size.lodCell / config.size.cell;
  this.framesBetweenUpdates = config.lod.framesBetweenUpdates; // frames that elapse between texture updates
  this.minZ = config.lod.minZ; // minimum camera.z to trigger texture updates
  this.radius = config.lod.radius;
  this.tex = this.getTexture();
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
      x: config.data.spread.x * config.lod.gridSpacing,
      y: config.data.spread.y * config.lod.gridSpacing,
    },
  };
};

LOD.prototype.getTexture = function() {
  var canvas = getElem('canvas', {
    width: config.size.lodTexture,
    height: config.size.lodTexture,
    id: 'lod-canvas',
  })
  return {
    canvas: canvas,
    ctx: canvas.getContext('2d'),
    texture: world.getTexture(canvas),
  }
}

// initialize the array of tex coordinates available for writing
LOD.prototype.getOpenTexCoords = function() {
  var perDimension = config.size.lodTexture / config.size.lodCell,
      openCoords = [];
  for (var y=0; y<perDimension; y++) {
    for (var x=0; x<perDimension; x++) {
      openCoords.push({
        x: x * config.size.lodCell,
        y: y * config.size.lodCell,
      });
    }
  }
  return openCoords;
}

// add all cells to a quantized LOD grid
LOD.prototype.indexCells = function() {
  var coords = {};
  data.cells.forEach(function(cell) {
    cell.gridCoords = this.toGridCoords(cell.state.position);
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
  if (!this.state.run || world.state.flying || !world.state.displayed) return;
  this.updateGridPosition();
  this.loadNextImage();
  this.tick();
}

LOD.prototype.updateGridPosition = function() {
  // determine the current grid position of the user / camera
  var pos = this.toGridCoords(world.camera.position);
  // user is in a new grid position; unload old images and load new
  if (this.gridPos.x !== pos.x || this.gridPos.y !== pos.y) {
    this.gridPos = pos;
    this.state.neighborsRequested = false;
    this.unload();
    if (world.camera.position.z < this.minZ) {
      this.state.loadQueue = getNested(this.grid.coords, [pos.x, pos.y], []);
    }
  }
}

// if there's a loadQueue, load the next image, else load neighbors
// nb: don't mutate loadQueue, as that deletes items from this.grid.coords
LOD.prototype.loadNextImage = function() {
  var cellIdx = this.state.loadQueue[0];
  this.state.loadQueue = this.state.loadQueue.slice(1);
  if (Number.isInteger(cellIdx)) {
    this.loadImage(cellIdx);
  } else if (!this.state.neighborsRequested) {
    this.loadGridNeighbors();
  }
}

// update the frame number and conditionally activate loaded images
LOD.prototype.tick = function() {
  this.state.frame += 1;
  var isDrawFrame = this.state.frame % this.framesBetweenUpdates == 0;
  if (!isDrawFrame) return;
  world.camera.position.z < this.minZ
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
    image.src = config.data.dir + '/thumbs/128px/' + data.cells[cellIdx].name;
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
    if (this.state.cellIdxToCoords[cell.idx]) return;
    // don't load the cell if it's too far from the camera
    if ((xDelta > this.radius * 2) || (yDelta > this.radius)) return;
    // return if there are no open coordinates in the LOD texture
    var coords = this.state.openCoords.shift();
    if (!coords) { console.log('TODO: lod texture full'); return; }
    textureNeedsUpdate = true;
    this.addCellToLodTexture(cell, coords);
  }.bind(this))
  // indicate we've loaded all cells
  this.state.cellsToActivate = [];
  // only update the texture and attributes if the lod tex changed
  if (textureNeedsUpdate) {
    this.tex.texture.needsUpdate = true;
    world.attrsNeedUpdate(['textureOffset', 'textureIndex', 'size']);
  }
}

// add a new cell to the LOD texture at position `coords`
LOD.prototype.addCellToLodTexture = function(cell, coords) {
  var gridKey = cell.gridCoords.x + '.' + cell.gridCoords.y,
      gridStore = this.state.gridPosToCoords;
  // store the cell's index with its coords data
  coords.cellIdx = cell.idx;
  // initialize this grid key in the grid position to coords map
  if (!gridStore[gridKey]) gridStore[gridKey] = [];
  // add the cell data to the data stores
  this.state.gridPosToCoords[gridKey].push(coords);
  this.state.cellIdxToCoords[cell.idx] = coords;
  // draw the cell's image in the lod texture
  var img = this.cellIdxToImage[cell.idx],
      cellSize = Object.assign({}, cell.state.size),
      topPad = cellSize.topPad * this.cellSizeScalar,
      leftPad = cellSize.leftPad * this.cellSizeScalar,
      // rectangle to clear for this cell in LOD texture
      x = coords.x,
      y = coords.y,
      // cell to draw: source and target coordinates
      sX = 0,
      sY = 0,
      sW = config.size.lodCell - (2*leftPad),
      sH = config.size.lodCell - (2*topPad),
      dX = x + leftPad,
      dY = y + topPad,
      dW = sW,
      dH = sH;
  this.tex.ctx.clearRect(x, y, config.size.lodCell, config.size.lodCell);
  this.tex.ctx.drawImage(img, sX, sY, sW, sH, dX, dY, dW, dH);
  cell.activate();
}

// load the next nearest grid of cell images
LOD.prototype.loadGridNeighbors = function() {
  this.state.neighborsRequested = true;
  for (var x=-this.radius*2; x<=this.radius*2; x++) {
    for (var y=-this.radius; y<=this.radius; y++) {
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
    if ((xDelta + yDelta) > this.radius) this.unloadGridPos(gridPos)
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
    } catch(err) {console.warn(coords.cellIdx + ' cleared')}
  }.bind(this))
  // remove the old grid position from the list of active grid positions
  delete this.state.gridPosToCoords[gridPos];
  // free all cells previously assigned to the deleted grid position
  this.state.openCoords = this.state.openCoords.concat(toUnload);
}

// clear the LOD state entirely
LOD.prototype.clear = function() {
  Object.keys(this.state.gridPosToCoords).forEach(this.unloadGridPos.bind(this));
  var inf = Number.POSITIVE_INFINITY;
  this.gridPos = { x: inf, y: inf };
  world.attrsNeedUpdate(['textureOffset', 'textureIndex', 'size']);
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
  lod.indexCells();
  requestAnimationFrame(function() {
    world.init();
    selector.init();
    delete data.cellData; // clear up memory
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
  this.loadFilters();
}

Filters.prototype.loadFilters = function() {
  var url = config.data.dir + '/filters/filters.json';
  get(url, function(data) {
    for (var i=0; i<data.length; i++) {
      var filter = new Filter(data[i]);
      this.filters.push(filter);
    }
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
    option.textContent = this.values[i];
    select.appendChild(option);
  }
  select.onchange = this.onChange.bind(this);
  find('#filters').appendChild(select);
}

Filter.prototype.onChange = function(e) {
  var val = e.target.value;
  // case where user selected the 'All Values' option
  if (val === 'All Values') {
    this.filterCells(data.cells.reduce(function(arr, cell) {
      arr.push(cell.name); return arr;
    }.bind(this), []))
  // case where user selected a specific option
  } else {
    // each {{ level-name }}.json file should use hyphens instead of whitespace
    var filename = val.replace(/\//g, '-').replace(/ /g, '-') + '.json',
        url = config.data.dir + '/filters/option_values/' + filename;
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
    var group = world.scene.children[0],
        attrs = group.children[cell.getIndexOfDrawCall()].geometry.attributes,
        opacity = cell.name in names ? 1 : 0.1;
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
  this.centroids = null;
  this.init();
}

Hotspots.prototype.init = function() {
  get(config.data.dir + '/centroids.json', function(json) {
    this.centroids = json;
    this.target.innerHTML = _.template(this.template.innerHTML)({
      hotspots: json,
    });
    var hotspots = findAll('.hotspot');
    for (var i=0; i<hotspots.length; i++) {
      hotspots[i].addEventListener('click', function(idx) {
        var position = data.cells[this.centroids[idx].idx].state.position;
        world.flyTo({
          x: position.x,
          y: position.y,
          z: position.z + 100,
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
  return {
    textureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) / 2,
    textureCount: this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS) / 2,
    vShaderTextures: this.gl.getParameter(this.gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
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
  return Math.min.apply(Math, data.cells.map(function(d) {
    return d.state.position.z;
  }))
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
var hotspots = new Hotspots();
var data = new Data();
