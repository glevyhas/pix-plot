// version: VERSION_NUMBER

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
*   gzipped: boolean indicating whether the JSON data is gzipped
* size:
*   cell: height & width of each image (in px) within the small atlas
*   lodCell: height & width of each image (in px) within the larger atlas
*   atlas: height & width of each small atlas (in px)
*   texture: height & width of each texture (in px)
*   lodTexture: height & width of the large (detail) texture
* transitions:
*   duration: number of seconds each layout transition should take
*   ease: TweenLite ease config values for transitions
* atlasesPerTex: number of atlases to include in each texture
**/

function Config() {
  this.data = {
    dir: 'data',
    file: 'manifest.json',
    gzipped: false,
  }
  this.size = {
    cell: 32, // height of each cell in atlas
    lodCell: 128, // height of each cell in LOD
    atlas: 2048, // height of each atlas
    texture: webgl.limits.textureSize,
    lodTexture: 2**13,
    points: {
      min: 0, // min point size
      max: 0, // max point size
      initial: 0, // initial point size
      grid: 0, // initial point size for grid layouts
      scatter: 0, // initial point size for scatter layouts
      date: 0, // initial point size for date layouts
    },
  }
  this.transitions = {
    duration: 2.0,
    delay: 0.0,
    ease: {
      value: 1,
    ease: Power1.easeOut,
    }
  }
  this.pickerMaxZ = 0.4; // max z value of camera to trigger picker modal
  this.atlasesPerTex = (this.size.texture/this.size.atlas)**2;
  this.isLocalhost = window.location.hostname.includes('localhost') ||
    window.location.hostname.includes('127.0.0.1') ||
    window.location.hostname.includes('0.0.0.0') ||
    window.location.hostname.includes('[::]');
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
  this.layouts = [];
  this.cells = [];
  this.textures = [];
  this.textureProgress = {};
  this.loadedTextures = 0;
  this.boundingBox = {
    x: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, },
    y: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, },
  };
  world.getHeightMap(this.load.bind(this));
  globe.load();
}

// Load json data with chart element positions
Data.prototype.load = function() {
  get(getPath(config.data.dir + '/' + config.data.file),
    function(json) {
      get(getPath(json.imagelist), function(data) {
        this.parseManifest(Object.assign({}, json, data));
      }.bind(this))
    }.bind(this),
    function(err) {
      if (!config.data.gzipped) {
        config.data.gzipped = true;
        config.data.file = config.data.file + '.gz';
        this.load()
      } else {
        console.warn('ERROR: could not load manifest.json')
      }
    }.bind(this)
  )
}

Data.prototype.parseManifest = function(json) {
  this.json = json;
  // set sizes of cells, atlases, and points
  config.size.cell = json.config.sizes.cell;
  config.size.atlas = json.config.sizes.atlas;
  config.size.lodCell = json.config.sizes.lod;
  config.size.points = json.point_sizes;
  // update the point size DOM element
  world.elems.pointSize.min = 0;
  world.elems.pointSize.max = config.size.points.max;
  world.elems.pointSize.value = config.size.points.initial;
  // set number of atlases and textures
  this.atlasCount = json.atlas.count;
  this.textureCount = Math.ceil(json.atlas.count / config.atlasesPerTex);
  this.layouts = json.layouts;
  this.hotspots = new Hotspots();
  layout.init(Object.keys(this.layouts));
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
  get(getPath(this.layouts[layout.selected].layout), function(data) {
    this.addCells(data);
    this.hotspots.initialize();
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
        x:  worldPos[0], // x position of cell in world
        y:  worldPos[1], // y position of cell in world
        z:  worldPos[2] || null, // z position of cell in world
        dx: atlasPos[0] + atlasOffset.x, // x offset of cell in atlas
        dy: atlasPos[1] + atlasOffset.y, // y offset of cell in atlas
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

// given idx of atlas among all atlases, return offsets of atlas in texture
function getAtlasOffset(idx) {
  var atlasSize = config.size.atlas,
      textureSize = config.size.texture;
  return {
    x: (idx * atlasSize) % textureSize,
    y: (Math.floor((idx * atlasSize) / textureSize) * atlasSize) % textureSize,
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
  this.url = getPath(data.json.atlas_dir + '/atlas-' + this.idx + '.jpg');
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
  this.x = obj.x;
  this.y = obj.y;
  this.z = obj.z || this.getZ(obj.x, obj.y);
  this.tx = this.x; // target x position
  this.ty = this.y; // target y position
  this.tz = this.z; // target z position
  this.dx = obj.dx;
  this.dy = obj.dy;
  this.w = obj.w; // width of lod cell
  this.h = obj.h; // heiht of lod cell
  this.updateParentBoundingBox();
}

Cell.prototype.getZ = function(x, y) {
  return world.getHeightAt(x, y) || 0;
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
  ['textureIndex', 'offset'].forEach(this.setBuffer.bind(this));
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
  ['textureIndex', 'offset'].forEach(this.setBuffer.bind(this));
}

// update this cell's buffer values for bound attribute `attr`
Cell.prototype.setBuffer = function(attr) {
  // find the buffer attributes that describe this cell to the GPU
  var meshes = world.group,
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

    case 'position':
      // set the cell's translation
      attrs.position.array[(idxInDrawCall * 3)] = this.x;
      attrs.position.array[(idxInDrawCall * 3) + 1] = this.y;
      attrs.position.array[(idxInDrawCall * 3) + 2] = this.z;
      return;

    case 'targetPosition':
      // set the cell's translation
      attrs.targetPosition.array[(idxInDrawCall * 3)] = this.tx;
      attrs.targetPosition.array[(idxInDrawCall * 3) + 1] = this.ty;
      attrs.targetPosition.array[(idxInDrawCall * 3) + 2] = this.tz;
      return;
  }
}

/**
* Layout: contols the DOM element and state that identify the layout
*   to be displayed
*
* elem: DOM element for the layout selector
* jitterElem: DOM element for the jitter selector
* selected: currently selected layout option
* options: list of strings identifying valid layout options
**/

function Layout() {
  this.jitterElem = null;
  this.selected = null;
  this.options = [];
}

/**
* @param [str] options: an array of layout strings; each should
*   be an attribute in data.cells[ithCell].layouts
**/

Layout.prototype.init = function(options) {
  this.options = options;
  this.selected = data.json.initial_layout || Object.keys(options)[0];
  this.elems = {
    input: document.querySelector('#jitter-input'),
    jitter: document.querySelector('#jitter-container'),
    icons: document.querySelector('#icons'),
    layoutCategorical: document.querySelector('#layout-categorical'),
    layoutDate: document.querySelector('#layout-date'),
    layoutPose: document.querySelector('#layout-pose'),
    layoutGeographic: document.querySelector('#layout-geographic'),
  }
  this.showHideIcons();
  this.addEventListeners();
  this.selectActiveIcon();
  data.hotspots.showHide();
  this.showHideJitter();
}

Layout.prototype.showHideIcons = function() {
  if (data.layouts.categorical) {
    this.elems.layoutCategorical.style.display = 'inline-block';
  }
  if (data.layouts.date) {
    this.elems.layoutDate.style.display = 'inline-block';
  }
  if (data.layouts.pose) {
    this.elems.layoutPose.style.display = 'inline-block';
  }
  if (data.layouts.geographic) {
    this.elems.layoutGeographic.style.display = 'inline-block';
  }
}

Layout.prototype.selectActiveIcon = function() {
  // remove the active class from all icons
  var icons = this.elems.icons.querySelectorAll('.layout-icon');
  for (var i=0; i<icons.length; i++) {
    icons[i].classList.remove('active');
  }
  // add the active class to selected icon
  try {
    document.querySelector('#layout-' + this.selected).classList.add('active');
  } catch (err) {
    console.warn(' * the requested layout has no icon:', this.selected)
  }
}

Layout.prototype.addEventListeners = function() {
  // add icon click listeners
  this.elems.icons.addEventListener('click', function(e) {
    if (!e.target || !e.target.id || e.target.id == 'icons') return;
    this.set(e.target.id.replace('layout-', ''), true);
  }.bind(this));
  // allow clicks on jitter container to update jitter state
  this.elems.jitter.addEventListener('click', function(e) {
    if (e.target.tagName != 'INPUT') {
      if (this.elems.input.checked) {
        this.elems.input.checked = false;
        this.elems.jitter.classList.remove('visible');
      } else {
        this.elems.input.checked = true;
        this.elems.jitter.classList.add('visible');
      }
    }
    this.set(this.selected, false);
  }.bind(this));
}

// Transition to a new layout; layout must be an attr on Cell.layouts
Layout.prototype.set = function(layout, enableDelay) {
  // disallow new transitions when we're transitioning
  if (world.state.transitioning) return;
  if (!(layout in data.json.layouts)) return;
  world.state.transitioning = true;
  // set the selected layout
  this.selected = layout;
  // set the world mode back to pan
  world.setMode('pan');
  // select the active tab
  this.selectActiveIcon();
  // set the point size given the selected layout
  this.setPointScalar();
  // add any labels to the plot
  this.setText();
  // show or hide any contextual elements (e.g. geographic shapes)
  this.showHideContext();
  // zoom the user out if they're zoomed in
  var delay = world.recenterCamera(enableDelay);
  // enable the jitter button if this layout has a jittered option
  var jitter = this.showHideJitter();
  // determine the path to the json to display
  var layoutType = jitter ? 'jittered' : 'layout'
  // hide the create hotspot button
  data.hotspots.setCreateHotspotVisibility(false);
  // begin the new layout transition
  setTimeout(function() {
    get(getPath(data.layouts[layout][layoutType]), function(pos) {
      // clear the LOD mechanism
      lod.clear();
      // set the target locations of each point
      for (var i=0; i<data.cells.length; i++) {
        data.cells[i].tx = pos[i][0];
        data.cells[i].ty = pos[i][1];
        data.cells[i].tz = pos[i][2] || data.cells[i].getZ(pos[i][0], pos[i][1]);
        data.cells[i].setBuffer('targetPosition');
      }
      // set the target locations of lines
      if (lines.mesh) {
        var lineAttributes = lines.getAttributes('targetPosition');
        lines.mesh.geometry.attributes.targetPosition.array = lineAttributes.positions.array.slice(0);
        lines.mesh.geometry.attributes.targetPosition.needsUpdate = true;
        lines.mesh.geometry.attributes.targetMidpoint.array = lineAttributes.midpoints.array;
        lines.mesh.geometry.attributes.targetMidpoint.needsUpdate = true;
        // begin accumulating a list of elements to animate
        var animatable = [lines.mesh.material.uniforms.transitionPercent];
      } else {
        var animatable = [];
      }
      // update the transition uniforms and targetPosition buffers on each mesh
      for (var i=0; i<world.group.children.length; i++) {
        world.group.children[i].geometry.attributes.targetPosition.needsUpdate = true;
        animatable.push(world.group.children[i].material.uniforms.transitionPercent);
      }
      // begin the animation
      TweenMax.to(
        animatable,
        config.transitions.duration,
        config.transitions.ease,
      );
      // prepare to update all the cell buffers once transition completes
      setTimeout(this.onTransitionComplete.bind(this), config.transitions.duration * 1000);
    }.bind(this))
  }.bind(this), delay);
}

// set the point size as a function of the current layout
Layout.prototype.setPointScalar = function() {
  var size = false, // size for points
      l = this.selected; // selected layout
  if (l == 'tsne' || l == 'umap' || l == 'pose') size = config.size.points.scatter;
  if (l == 'alphabetic' || l == 'grid') size = config.size.points.grid;
  if (l == 'categorical') size = config.size.points.categorical;
  if (l == 'geographic') size = config.size.points.geographic;
  if (l == 'date') size = config.size.points.date;
  if (size) {
    world.elems.pointSize.value = size;
    var scale = world.getPointScale();
    world.setUniform('targetScale', scale);
    if (lines.mesh) lines.mesh.material.uniforms.targetScale.value = scale;
  }
}

// show/hide the jitter and return a bool whether to jitter the new layout
Layout.prototype.showHideJitter = function() {
  var jitterable = 'jittered' in data.layouts[this.selected];
  jitterable
    ? world.state.transitioning
      ? this.elems.jitter.classList.add('visible', 'disabled')
      : this.elems.jitter.classList.add('visible')
    : this.elems.jitter.classList.remove('visible')
  return jitterable && this.elems.input.checked;
}

// show/hide any contextual elements given the new layout
Layout.prototype.showHideContext = function() {
  this.selected == 'geographic'
    ? globe.show()
    : globe.hide();
}

// add any required text to the scene
Layout.prototype.setText = function() {
  if (!text.mesh) return;
  var path = data.json.layouts[this.selected].labels;
  if (path && text.mesh) {
    get(getPath(path), text.formatText.bind(text));
    text.mesh.material.uniforms.render.value = 1.0;
  } else {
    text.mesh.material.uniforms.render.value = 0.0;
  }
}

// reset cell state, mesh buffers, and transition uniforms
Layout.prototype.onTransitionComplete = function() {
  // re-enable interactions with the jitter button
  this.elems.jitter.classList.remove('disabled');
  // show/hide the hotspots
  data.hotspots.showHide();
  // update the state and buffers for each cell
  data.cells.forEach(function(cell) {
    cell.x = cell.tx;
    cell.y = cell.ty;
    cell.z = cell.tz;
    cell.setBuffer('position');
  });
  // update the buffers for the lines
  if (lines.mesh) {
    lines.mesh.geometry.attributes.position.array = lines.mesh.geometry.attributes.targetPosition.array.slice(0);
    lines.mesh.geometry.attributes.midpoint.array = lines.mesh.geometry.attributes.targetMidpoint.array.slice(0);
    lines.mesh.geometry.attributes.position.needsUpdate = true;
    lines.mesh.geometry.attributes.midpoint.needsUpdate = true;
    lines.mesh.material.uniforms.transitionPercent = {type: 'f', value: 0};
  }
  // pass each updated position buffer to the gpu
  for (var i=0; i<world.group.children.length; i++) {
    world.group.children[i].geometry.attributes.position.needsUpdate = true;
    world.group.children[i].material.uniforms.transitionPercent = {type: 'f', value: 0};
  }
  // indicate the world is no longer transitioning
  world.state.transitioning = false;
  // set the current point scale value
  world.setScaleUniforms();
  // reindex cells in LOD given new positions
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
* group: the group of meshes used to render cells
* state: a map identifying internal state of the world
**/

function World() {
  this.canvas = document.querySelector('#pixplot-canvas');
  this.scene = this.getScene();
  this.camera = this.getCamera();
  this.renderer = this.getRenderer();
  this.controls = this.getControls();
  this.stats = this.getStats();
  this.color = new THREE.Color();
  this.clock = new THREE.Clock();
  this.time = 0;
  this.center = {};
  this.group = {};
  this.state = {
    flying: false,
    transitioning: false,
    displayed: false,
    mode: 'pan', // 'pan' || 'select'
  };
  this.elems = {
    pointSize: document.querySelector('#pointsize-range-input'),
    selectTooltip: document.querySelector('#select-tooltip'),
    selectTooltipButton: document.querySelector('#select-tooltip-button'),
  };
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
  return new THREE.PerspectiveCamera(75, aspectRatio, 0.001, 10);
}

/**
* Generate the renderer to be used in the scene
**/

World.prototype.getRenderer = function() {
  var renderer = new THREE.WebGLRenderer({
    antialias: true,
    canvas: this.canvas,
  });
  renderer.autoClear = false;
  renderer.toneMapping = THREE.ReinhardToneMapping;
  return renderer;
}

/**
* Generate the controls to be used in the scene
* @param {obj} camera: the three.js camera for the scene
* @param {obj} renderer: the three.js renderer for the scene
**/

World.prototype.getControls = function() {
  var controls = new THREE.TrackballControls(this.camera, this.canvas);
  controls.zoomSpeed = 0.4;
  controls.panSpeed = 0.4;
  controls.noRotate = true;
  return controls;
}

/**
* Heightmap functions
**/

// load the heightmap
World.prototype.getHeightMap = function(callback) {
  // load an image for setting 3d vertex positions
  var img = new Image();
  img.crossOrigin = 'Anonymous';
  img.onload = function() {
    var canvas = document.createElement('canvas'),
        ctx = canvas.getContext('2d');
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    this.heightmap = ctx.getImageData(0,0, img.width, img.height);
    callback();
  }.bind(this);
  img.src = this.heightmap || 'assets/images/heightmap.jpg';
}

// determine the height of the heightmap at coordinates x,y
World.prototype.getHeightAt = function(x, y) {
  var x = (x+1)/2, // rescale x,y axes from -1:1 to 0:1
      y = (y+1)/2,
      row = Math.floor(y * (this.heightmap.height-1)),
      col = Math.floor(x * (this.heightmap.width-1)),
      idx = (row * this.heightmap.width * 4) + (col * 4),
      z = this.heightmap.data[idx] * (this.heightmapScalar/1000 || 0.0);
  return z;
}

/**
* Add event listeners, e.g. to resize canvas on window resize
**/

World.prototype.addEventListeners = function() {
  this.addResizeListener();
  this.addLostContextListener();
  this.addScalarChangeListener();
  this.addTabChangeListeners();
  this.addModeChangeListeners();
}

/**
* Resize event listeners
**/

World.prototype.addResizeListener = function() {
  window.addEventListener('resize', this.handleResize.bind(this), false);
}

World.prototype.handleResize = function() {
  var canvasSize = getCanvasSize(),
      w = canvasSize.w * window.devicePixelRatio,
      h = canvasSize.h * window.devicePixelRatio;
  this.camera.aspect = w / h;
  this.camera.updateProjectionMatrix();
  this.renderer.setSize(w, h, false);
  this.controls.handleResize();
  picker.tex.setSize(w, h);
  this.setScaleUniforms();
}

World.prototype.setScaleUniforms = function() {
    // handle case of drag before scene renders
  if (!this.state.displayed) return;
  var scale = world.getPointScale();
  world.setUniform('scale', scale);
  if (lines.mesh) lines.mesh.material.uniforms.scale.value = scale;
}

/**
* Update the point size when the user changes the input slider
**/

World.prototype.addScalarChangeListener = function() {
  this.elems.pointSize.addEventListener('change', this.setScaleUniforms.bind(this));
  this.elems.pointSize.addEventListener('input', this.setScaleUniforms.bind(this));
}

/**
* Refrain from drawing scene when user isn't looking at page
**/

World.prototype.addTabChangeListeners = function() {
  // change the canvas size to handle Chromium bug 1034019
  window.addEventListener('visibilitychange', function() {
    this.canvas.width = this.canvas.width + 1;
    setTimeout(function() {
      this.canvas.width = this.canvas.width - 1;
    }.bind(this), 50);
  }.bind(this))
}

/**
* listen for loss of webgl context; to manually lose context:
* world.renderer.context.getExtension('WEBGL_lose_context').loseContext();
**/

World.prototype.addLostContextListener = function() {
  this.canvas.addEventListener('webglcontextlost', function(e) {
    e.preventDefault();
    window.location.reload();
  });
}

/**
* Listen for changes in world.mode
**/

World.prototype.addModeChangeListeners = function() {
  document.querySelector('#pan').addEventListener('click', this.handleModeIconClick.bind(this));
  document.querySelector('#select').addEventListener('click', this.handleModeIconClick.bind(this));
  document.querySelector('#select').addEventListener('mouseenter', this.showSelectTooltip.bind(this));
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
* Recenter the camera
**/

// return the camera to its starting position
World.prototype.recenterCamera = function(enableDelay) {
  var initialCameraPosition = this.getInitialLocation();
  if ((this.camera.position.z < initialCameraPosition.z) && enableDelay) {
    this.flyTo(initialCameraPosition);
    return config.transitions.duration * 1000;
  }
  return 0;
}

/**
* Draw each of the vertices
**/

World.prototype.plotPoints = function() {
  // add the cells for each draw call
  var drawCallToCells = this.getDrawCallToCells();
  this.group = new THREE.Group();
  for (var drawCallIdx in drawCallToCells) {
    var meshCells = drawCallToCells[drawCallIdx],
        attrs = this.getGroupAttributes(meshCells),
        geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', attrs.position);
    geometry.setAttribute('targetPosition', attrs.targetPosition);
    geometry.setAttribute('color', attrs.color);
    geometry.setAttribute('width', attrs.width);
    geometry.setAttribute('height', attrs.height);
    geometry.setAttribute('offset', attrs.offset);
    geometry.setAttribute('opacity', attrs.opacity);
    geometry.setAttribute('selected', attrs.selected);
    geometry.setAttribute('clusterSelected', attrs.clusterSelected);
    geometry.setAttribute('textureIndex', attrs.textureIndex);
    geometry.setDrawRange(0, meshCells.length); // points not rendered unless draw range is specified
    var material = this.getShaderMaterial({
      firstTex: attrs.texStartIdx,
      textures: attrs.textures,
      useColor: false,
    });
    material.transparent = true;
    var mesh = new THREE.Points(geometry, material);
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }
  this.scene.add(this.group);
}

/**
* Find the index of each cell's draw call
**/

World.prototype.getDrawCallToCells = function() {
  var drawCallToCells = {};
  for (var i=0; i<data.cells.length; i++) {
    var cell = data.cells[i],
        drawCall = cell.getIndexOfDrawCall();
    if (!(drawCall in drawCallToCells)) drawCallToCells[drawCall] = [cell];
    else drawCallToCells[drawCall].push(cell);
  }
  return drawCallToCells;
}

/**
* Return attribute data for the initial draw call of a mesh
**/

World.prototype.getGroupAttributes = function(cells) {
  var it = this.getCellIterators(cells.length);
  for (var i=0; i<cells.length; i++) {
    var cell = cells[i];
    var rgb = this.color.setHex(cells[i].idx + 1); // use 1-based ids for colors
    it.texIndex[it.texIndexIterator++] = cell.texIdx; // index of texture among all textures -1 means LOD texture
    it.position[it.positionIterator++] = cell.x; // current position.x
    it.position[it.positionIterator++] = cell.y; // current position.y
    it.position[it.positionIterator++] = cell.z; // current position.z
    it.targetPosition[it.targetPositionIterator++] = cell.tx; // target position.x
    it.targetPosition[it.targetPositionIterator++] = cell.ty; // target position.y
    it.targetPosition[it.targetPositionIterator++] = cell.tz; // target position.z
    it.color[it.colorIterator++] = rgb.r; // could be single float
    it.color[it.colorIterator++] = rgb.g; // unique color for GPU picking
    it.color[it.colorIterator++] = rgb.b; // unique color for GPU picking
    it.opacity[it.opacityIterator++] = 1.0; // cell opacity value
    it.selected[it.selectedIterator++] = 0.0; // 1.0 if cell is selected, else 0.0
    it.clusterSelected[it.clusterSelectedIterator++] = 0.0; // 1.0 if cell's cluster is selected, else 0.0
    it.width[it.widthIterator++] = cell.w; // px width of cell in lod atlas
    it.height[it.heightIterator++] = cell.h; // px height of cell in lod atlas
    it.offset[it.offsetIterator++] = cell.dx; // px offset of cell from left of tex
    it.offset[it.offsetIterator++] = cell.dy; // px offset of cell from top of tex
  }

  // format the arrays into THREE attributes
  var position = new THREE.BufferAttribute(it.position, 3, true, 1),
      targetPosition = new THREE.BufferAttribute(it.targetPosition, 3, true, 1),
      color = new THREE.BufferAttribute(it.color, 3, true, 1),
      opacity = new THREE.BufferAttribute(it.opacity, 1, true, 1),
      selected = new THREE.Uint8BufferAttribute(it.selected, 1, false, 1),
      clusterSelected = new THREE.Uint8BufferAttribute(it.clusterSelected, 1, false, 1),
      texIndex = new THREE.Int8BufferAttribute(it.texIndex, 1, false, 1),
      width = new THREE.Uint8BufferAttribute(it.width, 1, false, 1),
      height = new THREE.Uint8BufferAttribute(it.height, 1, false, 1),
      offset = new THREE.Uint16BufferAttribute(it.offset, 2, false, 1);
  texIndex.usage = THREE.DynamicDrawUsage;
  position.usage = THREE.DynamicDrawUsage;
  targetPosition.usage = THREE.DynamicDrawUsage;
  opacity.usage = THREE.DynamicDrawUsage;
  selected.usage = THREE.DynamicDrawUsage;
  clusterSelected.usage = THREE.DynamicDrawUsage;
  offset.usage = THREE.DynamicDrawUsage;
  var texIndices = this.getTexIndices(cells);
  return {
    position: position,
    targetPosition: targetPosition,
    color: color,
    width: width,
    height: height,
    offset: offset,
    opacity: opacity,
    selected: selected,
    clusterSelected: clusterSelected,
    textureIndex: texIndex,
    textures: this.getTextures({
      startIdx: texIndices.first,
      endIdx: texIndices.last,
    }),
    texStartIdx: texIndices.first,
    texEndIdx: texIndices.last
  }
}

/**
* Get the iterators required to store attribute data for `n` cells
**/

World.prototype.getCellIterators = function(n) {
  return {
    position: new Float32Array(n * 3),
    targetPosition: new Float32Array(n * 3),
    color: new Float32Array(n * 3),
    width: new Uint8Array(n),
    height: new Uint8Array(n),
    offset: new Uint16Array(n * 2),
    opacity: new Float32Array(n),
    selected: new Uint8Array(n),
    clusterSelected: new Uint8Array(n),
    texIndex: new Int8Array(n),
    positionIterator: 0,
    targetPositionIterator: 0,
    colorIterator: 0,
    widthIterator: 0,
    heightIterator: 0,
    offsetIterator: 0,
    opacityIterator: 0,
    selectedIterator: 0,
    clusterSelectedIterator: 0,
    texIndexIterator: 0,
  }
}

/**
* Find the first and last non -1 tex indices from a list of cells
**/

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

/**
* Return textures from `obj.startIdx` to `obj.endIdx` indices
**/

World.prototype.getTextures = function(obj) {
  var textures = [];
  for (var i=obj.startIdx; i<=obj.endIdx; i++) {
    var tex = this.getTexture(data.textures[i].canvas);
    textures.push(tex);
  }
  return textures;
}

/**
* Transform a canvas object into a THREE texture
**/

World.prototype.getTexture = function(canvas) {
  var tex = new THREE.Texture(canvas);
  tex.needsUpdate = true;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

/**
* Return an int specifying the scalar uniform for points
**/

World.prototype.getPointScale = function() {
  var scalar = parseFloat(this.elems.pointSize.value),
      canvasSize = getCanvasSize();
  return scalar * window.devicePixelRatio * canvasSize.h;
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
  var vertex = document.querySelector('#vertex-shader').textContent;
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
      scale: {
        type: 'f',
        value: this.getPointScale(),
      },
      targetScale: {
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
      },
      borderWidth: {
        type: 'f',
        value: 0.15,
      },
      borderColor: {
        type: 'vec3',
        value: new Float32Array([234/255, 183/255, 85/255]),
      },
      display: {
        type: 'f',
        value: 1.0,
      },
      time: {
        type: 'f',
        value: 0.0,
      },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
}

// helper function to set uniforms on all meshes
World.prototype.setUniform = function(key, val) {
  var meshes = this.group.children.concat(picker.scene.children[0].children);
  for (var i=0; i<meshes.length; i++) {
    meshes[i].material.uniforms[key].value = val;
  }
}

// helper function to distribute an array with length data.cells over draw calls
World.prototype.setBuffer = function(key, arr) {
  var drawCallToCells = world.getDrawCallToCells();
  for (var i in drawCallToCells) {
    var attr = world.group.children[i].geometry.attributes[key];
    var cells = drawCallToCells[i];
    attr.array = arr.slice(cells[0].idx, cells[cells.length-1].idx+1);
    attr.needsUpdate = true;
  }
}

/**
* Helpers that mutate entire buffers
**/

World.prototype.setBorderedImages = function(indices) {
  var vals = new Uint8Array(data.cells.length);
  for (var i=0; i<indices.length; i++) vals[indices[i]] = 1;
  this.setBuffer('selected', vals);
}

World.prototype.setOpaqueImages = function(indices) {
  var vals = new Float32Array(data.cells.length);
  for (var i=0; i<vals.length; i++) vals[i] = 0.35;
  for (var i=0; i<indices.length; i++) vals[indices[i]] = 1;
  this.setBuffer('opacity', vals);
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
      fragShader = document.querySelector('#fragment-shader').textContent;
  // return shader for selecing clicked images (colorizes cells distinctly)
  if (useColor) {
    fragShader = fragShader.replace('uniform sampler2D textures[N_TEXTURES];', '');
    fragShader = fragShader.replace('TEXTURE_LOOKUP_TREE', '');
    return fragShader;
  // the calling agent requested the textured shader
  } else {
    // get the texture lookup tree
    var tree = this.getFragLeaf(-1, 'lodTexture');
    for (var i=firstTex; i<firstTex + textures.length; i++) {
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
  this.group.children.forEach(function(mesh) {
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

// fly to the cell at index position `idx`
World.prototype.flyToCellIdx = function(idx) {
  var cell = data.cells[idx];
  world.flyTo({
    x: cell.x,
    y: cell.y,
    z: Math.min(
      config.pickerMaxZ-0.0001,
      cell.z + (this.getPointScale() / 100)
    ),
  })
}

// fly to the cell at index position `idx`
World.prototype.flyToCellImage = function(img) {
  var idx = null;
  for (var i=0; i<data.json.images.length; i++) {
    if (data.json.images[i] == img) idx = i;
  }
  if (!idx) return console.warn('The requested image could not be found');
  var cell = data.cells[idx];
  this.flyToCellIdx(idx);
}

/**
* Get the initial camera location
**/

World.prototype.getInitialLocation = function() {
  return {
    x: 0, //this.center.x,
    y: 0, //this.center.y,
    z: 2.0,
  }
}

/**
* Initialize the render loop
**/

World.prototype.render = function() {
  requestAnimationFrame(this.render.bind(this));
  if (!this.state.displayed) return;
  this.renderer.render(this.scene, this.camera);
  // update the controls
  this.controls.update();
  // update the stats
  if (this.stats) this.stats.update();
  // update the level of detail mechanism
  lod.update();
  // update the dragged lasso
  lasso.update();
  // update the time uniform
  this.time += this.clock.getDelta() / 10;
  this.setUniform('time', this.time);
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
  // draw points and start the render loop
  this.plotPoints();
  // draw lines
  lines.plot();
  //resize the canvas and scale rendered assets
  this.handleResize();
  // initialize the first frame
  this.render();
  // set the mode
  this.setMode('pan');
  // set the display boolean
  world.state.displayed = true;
}

/**
* Handle clicks that request a new mode
**/

World.prototype.handleModeIconClick = function(e) {
  this.setMode(e.target.id);
  // hide the create hotspot button
  data.hotspots.setCreateHotspotVisibility(false);
}

/**
* Show the user the tooltip explaining the select mode
**/

World.prototype.showSelectTooltip = function() {
  if (!localStorage.getItem('select-tooltip-cleared') ||
       localStorage.getItem('select-tooltip-cleared') == 'false') {
    this.elems.selectTooltip.style.display = 'inline-block';
  }
  this.elems.selectTooltipButton.addEventListener('click', function() {
    this.hideSelectTooltip();
  }.bind(this))
}

World.prototype.hideSelectTooltip = function() {
  localStorage.setItem('select-tooltip-cleared', true);
  this.elems.selectTooltip.style.display = 'none';
}

/**
* Toggle the current world 'mode':
*   'pan' means we're panning through x, y coords
*   'select' means we're selecting cells to analyze
**/

World.prototype.setMode = function(mode) {
  this.mode = mode;
  // update the ui buttons to match the selected mode
  var elems = document.querySelectorAll('#selection-icons img');
  for (var i=0; i<elems.length; i++) {
    elems[i].className = elems[i].id == mode ? 'active' : '';
  }
  // update internal state to reflect selected mode
  if (this.mode == 'pan') {
    this.controls.noPan = false;
    this.canvas.classList.remove('select');
    this.canvas.classList.add('pan');
    lasso.removeMesh();
    lasso.setFrozen(true);
    lasso.setEnabled(false);
  } else if (this.mode == 'select') {
    this.controls.noPan = true;
    this.canvas.classList.remove('pan');
    this.canvas.classList.add('select');
    lasso.setEnabled(true);
  }
}

/**
* Lasso: polyline user-selections
**/

function Lasso() {
  this.clock = new THREE.Clock(); // clock for animating polyline
  this.time = 0; // time counter for animating polyline
  this.points = []; // array of {x: y: } point objects tracing user polyline
  this.enabled = false; // boolean indicating if any actions on the lasso are permitted
  this.capturing = false; // boolean indicating if we're recording mousemoves
  this.frozen = false; // boolean indicating whether to listen to mouse events
  this.mesh = null; // the rendered polyline outlining user selection
  this.downloadFiletype = 'csv'; // filetype to use when downloading selection
  this.selected = {}; // d[cell idx] = bool indicating if selected
  this.displayed = false; // bool indicating whether the modal is displayed
  this.mousedownCoords = {}; // obj storing x, y, z coords of mousedown
  this.elems = {
    viewSelectedContainer: document.querySelector('#view-selected-container'),
    viewSelected: document.querySelector('#view-selected'),

    selectedImagesCount: document.querySelector('#selected-images-count'),
    countTarget: document.querySelector('#count-target'),
    xIcon: document.querySelector('#selected-images-x'),

    modalTarget: document.querySelector('#selected-images-target'),
    modalContainer: document.querySelector('#selected-images-modal'),
    modalTemplate: document.querySelector('#selected-images-template'),

    filetypeButtons: document.querySelectorAll('.filetype'),
    downloadLink: document.querySelector('#download-link'),
    downloadInput: document.querySelector('#download-filename'),
  }
  this.addMouseEventListeners();
  this.addModalEventListeners();
}

Lasso.prototype.addMouseEventListeners = function() {
  window.addEventListener('mousedown', function(e) {
    if (!this.enabled) return;
    if (!e.target.id || e.target.id != 'pixplot-canvas') return;
    if (!keyboard.shiftPressed() && !keyboard.commandPressed()) {
      this.points = [];
    }
    this.mousedownCoords = {x: e.clientX, y: e.clientY};
    this.setCapturing(true);
    this.setFrozen(false);
  }.bind(this));

  window.addEventListener('mousemove', function(e) {
    if (!this.capturing || this.frozen) return;
    if (!e.target.id || e.target.id != 'pixplot-canvas') return;
    this.points.push(getEventWorldCoords(e));
    this.draw();
  }.bind(this));

  window.addEventListener('mouseup', function(e) {
    if (!this.enabled) return;
    // prevent the lasso points from changing
    this.setFrozen(true);
    // if the user registered a click, clear the lasso
    if (e.clientX == this.mousedownCoords.x &&
        e.clientY == this.mousedownCoords.y &&
        !keyboard.shiftPressed() &&
        !keyboard.commandPressed()) {
      this.clear();
    }
    // do not turn off capturing if the user is clicking the lasso symbol
    if (!e.target.id || e.target.id == 'select') return;
    // prevent the lasso from updating its points boundary
    this.setCapturing(false);
  }.bind(this));
}

Lasso.prototype.addModalEventListeners = function() {

  // close the modal on click of wrapper
  this.elems.modalContainer.addEventListener('click', function(e) {
    if (e.target.className == 'modal-top') {
      this.elems.modalContainer.style.display = 'none';
      this.displayed = false;
    }
    if (e.target.className == 'background-image') {
      var index = e.target.getAttribute('data-index');
      var indices = [];
      Object.keys(this.selected).forEach(function(i, idx) {
        if (this.selected[i]) indices.push(idx);
      }.bind(this))
      modal.showCells(indices, index);
    }
  }.bind(this))

  // show the list of images the user selected
  this.elems.viewSelected.addEventListener('click', function(e) {
    var images = Object.keys(this.selected).filter(function(k) {
      return this.selected[k];
    }.bind(this))
    var template = _.template(this.elems.modalTemplate.textContent)
    this.elems.modalTarget.innerHTML = template({ images: images });
    this.elems.modalContainer.style.display = 'block';
    this.displayed = true;
  }.bind(this))

  // toggle the inclusion of a cell in the selection
  this.elems.modalContainer.addEventListener('click', function(e) {
    if (e.target.className.includes('toggle-selection')) {
      e.preventDefault();
      var sibling = e.target.parentNode.querySelector('.background-image'),
          image = sibling.getAttribute('data-image');
      sibling.classList.contains('unselected')
        ? sibling.classList.remove('unselected')
        : sibling.classList.add('unselected');
      for (var i=0; i<data.json.images.length; i++) {
        if (data.json.images[i] == image) {
          this.toggleSelection(i);
          break;
        }
      }
    }
  }.bind(this))

  // let users set the download filetype
  for (var i=0; i<this.elems.filetypeButtons.length; i++) {
    this.elems.filetypeButtons[i].addEventListener('click', function(e) {
      for (var j=0; j<this.elems.filetypeButtons.length; j++) {
        this.elems.filetypeButtons[j].classList.remove('active');
      }
      e.target.classList.add('active');
      this.downloadFiletype = e.target.id;
    }.bind(this))
  }

  // let users trigger the download
  this.elems.downloadLink.addEventListener('click', this.downloadSelected.bind(this))

  // allow users to clear the selected images
  this.elems.xIcon.addEventListener('click', this.clear.bind(this))
}

Lasso.prototype.update = function() {
  if (!this.enabled) return;
  if (this.mesh) {
    this.time += this.clock.getDelta() / 10;
    this.mesh.material.uniforms.time.value = this.time;
  }
}

Lasso.prototype.setEnabled = function(bool) {
  this.enabled = bool;
}

Lasso.prototype.setCapturing = function(bool) {
  this.capturing = bool;
}

Lasso.prototype.setFrozen = function(bool) {
  this.frozen = bool;
}

Lasso.prototype.clear = function() {
  world.setBorderedImages([]);
  this.removeMesh();
  this.elems.viewSelectedContainer.style.display = 'none';
  data.hotspots.setCreateHotspotVisibility(false);
  this.setCapturing(false);
  this.points = [];
}

Lasso.prototype.removeMesh = function() {
  if (this.mesh) world.scene.remove(this.mesh);
}

Lasso.prototype.draw = function() {
  if (this.points.length <4) return;
  this.points = this.getHull();
  // remove the old mesh
  this.removeMesh();
  // get the indices of images that are inside the polygon
  this.selected = this.getSelectedMap();
  var indices = [],
      keys = Object.keys(this.selected);
  for (var i=0; i<keys.length; i++) {
    if (this.selected[keys[i]]) indices.push(i)
  }
  if (indices.length) {
    // hide the modal describing the lasso behavior
    world.hideSelectTooltip();
    // allow users to see the selected images if desired
    this.elems.viewSelectedContainer.style.display = 'block';
    this.elems.countTarget.textContent = indices.length;
    // if we're in the umap layout, allow cluster persistence
    if (layout.selected == 'umap') {
      data.hotspots.setCreateHotspotVisibility(true);
    }
  }
  // indicate the number of cells that are selected
  this.setNSelected(indices.length);
  // illuminate the points that are inside the polyline
  world.setBorderedImages(indices);
  // obtain and store a mesh, then add the mesh to the scene
  this.mesh = this.getMesh();
  world.scene.add(this.mesh);
}

// get a mesh that shows the polyline of selected points
Lasso.prototype.getMesh = function() {
  // create a list of 3d points to draw - the last point closes the loop
  var points = [];
  for (var i=0; i<this.points.length; i++) {
    var p = this.points[i];
    points.push(new THREE.Vector3(p.x, p.y, 0));
  }
  points.push(points[0]);
  // transform those points to a polyline
  var lengths = getCumulativeLengths(points);
  var geometry = new THREE.BufferGeometry().setFromPoints(points);
  var lengthAttr = new THREE.BufferAttribute(new Float32Array(lengths), 1);
  geometry.setAttribute('length', lengthAttr);
  var material = new THREE.RawShaderMaterial({
    uniforms: {
      time: { type: 'float', value: 0 },
      render: { type: 'bool', value: true },
    },
    vertexShader: document.querySelector('#dashed-vertex-shader').textContent,
    fragmentShader: document.querySelector('#dashed-fragment-shader').textContent,
  });
  var mesh = new THREE.Line(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

// get the convex hull of this.points
Lasso.prototype.getHull = function() {
  var l = new ConvexHullGrahamScan();
  for (var i=0; i<this.points.length; i++) {
    l.addPoint(this.points[i].x, this.points[i].y);
  }
  var hull = l.getHull();
  return hull;
}

// pass a 2d array of metadata values for selected images to `callback`
Lasso.prototype.getSelectedMetadata = function(callback) {
  var images = this.getSelectedFilenames();
  // conditionally fetch the metadata for each selected image
  var rows = [];
  if (data.json.metadata) {
    for (var i=0; i<images.length; i++) {
      var metadata = {};
      get(config.data.dir + '/metadata/file/' + images[i] + '.json', function(data) {
        metadata[data.filename] = data;
        // if all metadata has loaded prepare data download
        if (Object.keys(metadata).length == images.length) {
          var keys = Object.keys(metadata);
          for (var i=0; i<keys.length; i++) {
            var m = metadata[keys[i]];
            rows.push([
              m.filename || '',
              (m.tags || []).join('|'),
              m.description,
              m.permalink,
            ])
          }
          callback(rows);
        }
      }.bind(this));
    }
  } else {
    for (var i=0; i<images.length; i++) rows.push([images[i]]);
    callback(rows);
  }
}

Lasso.prototype.downloadSelected = function() {
  // format the filename to use for download
  var filetype = this.downloadFiletype;
  var filename = this.elems.downloadInput.value || Date.now().toString();
  if (!filename.endsWith('.' + filetype)) filename += '.' + filetype;
  // fetch the metadata associated with user-selected images
  this.getSelectedMetadata(function(arr) {
    if (filetype == 'csv' || filetype == 'json') downloadFile(arr, filename);
    else if (filetype == 'zip') {
      // initialize zip archive with metadata and images subdirectory
      var zip = new JSZip();
      zip.file('metadata.csv', Papa.unparse(arr));
      var subfolder = zip.folder('images');
      // add the selected images to the zip archive
      var images = this.getSelectedFilenames();
      var nAdded = 0;
      for (var i=0; i<images.length; i++) {
        var imagePath = getPath('data/originals/' + images[i]);
        imageToDataUrl(imagePath, function(result) {
          var imageFilename = result.src.split('originals/')[1];
          var base64 = result.dataUrl.split(';base64,')[1];
          subfolder.file(imageFilename, base64, {base64: true});
          if (++nAdded == images.length) {
            zip.generateAsync({type: 'blob'}).then(function(blob) {
              downloadBlob(blob, filename)
            });
          }
        })
      }
    }
  }.bind(this));
}

// return list of selected filenames; [filename, filename, ...]
Lasso.prototype.getSelectedFilenames = function() {
  return Object.keys(this.selected).filter(function(k) {
    return this.selected[k]
  }.bind(this));
}

// return d[filename] = bool indicating selected
Lasso.prototype.getSelectedMap = function() {
  var polygon = this.points.map(function(i) {
    return [i.x, i.y]
  });
  var selected = {};
  for (var i=0; i<data.json.images.length; i++) {
    var p = [data.cells[i].x, data.cells[i].y];
    selected[data.json.images[i]] = pointInPolygon(p, polygon);
  }
  return selected;
}

Lasso.prototype.toggleSelection = function(idx) {
  var image = data.json.images[idx];
  this.selected[image] = !this.selected[image];
  this.setNSelected();
}

Lasso.prototype.setNSelected = function(n) {
  var elem = document.querySelector('#n-images-selected');
  if (!elem) return;
  if (!Number.isInteger(n)) {
    var n = 0;
    var keys = Object.keys(this.selected);
    for (var i=0; i<keys.length; i++) {
      if (this.selected[keys[i]]) n++;
    }
  }
  elem.textContent = n;
}

/**
* 2D convex hull via https://github.com/brian3kb/graham_scan_js
**/

function ConvexHullGrahamScan() {
  this.anchorPoint = undefined;
  this.reverse = false;
  this.points = [];
}

ConvexHullGrahamScan.prototype = {
  constructor: ConvexHullGrahamScan,

  Point: function (x, y) {
    this.x = x;
    this.y = y;
  },

  _findPolarAngle: function (a, b) {
    var ONE_RADIAN = 57.295779513082;
    var deltaX, deltaY;
    // if the points are undefined, return a zero difference angle.
    if (!a || !b) return 0;
    deltaX = (b.x - a.x);
    deltaY = (b.y - a.y);
    if (deltaX == 0 && deltaY == 0) return 0;
    var angle = Math.atan2(deltaY, deltaX) * ONE_RADIAN;
    if (this.reverse) {
      if (angle <= 0) angle += 360;
    } else {
      if (angle >= 0) angle += 360;
    }
    return angle;
  },

  addPoint: function (x, y) {
    // check for a new anchor
    var newAnchor =
      ( this.anchorPoint === undefined ) ||
      ( this.anchorPoint.y > y ) ||
      ( this.anchorPoint.y === y && this.anchorPoint.x > x );
    if ( newAnchor ) {
      if ( this.anchorPoint !== undefined ) {
        this.points.push(new this.Point(this.anchorPoint.x, this.anchorPoint.y));
      }
      this.anchorPoint = new this.Point(x, y);
    } else {
      this.points.push(new this.Point(x, y));
    }
  },

  _sortPoints: function () {
    var self = this;
    return this.points.sort(function (a, b) {
      var polarA = self._findPolarAngle(self.anchorPoint, a);
      var polarB = self._findPolarAngle(self.anchorPoint, b);
      if (polarA < polarB) return -1;
      if (polarA > polarB) return 1;
      return 0;
    });
  },

  _checkPoints: function (p0, p1, p2) {
    var difAngle;
    var cwAngle = this._findPolarAngle(p0, p1);
    var ccwAngle = this._findPolarAngle(p0, p2);
    if (cwAngle > ccwAngle) {
      difAngle = cwAngle - ccwAngle;
      return !(difAngle > 180);
    } else if (cwAngle < ccwAngle) {
      difAngle = ccwAngle - cwAngle;
      return (difAngle > 180);
    }
    return true;
  },

  getHull: function () {
    var hullPoints = [],
        points,
        pointsLength;
    this.reverse = this.points.every(function(point) {
      return (point.x < 0 && point.y < 0);
    });
    points = this._sortPoints();
    pointsLength = points.length;
    // if there are less than 3 points, joining these points creates a correct hull.
    if (pointsLength < 3) {
      points.unshift(this.anchorPoint);
      return points;
    }
    // move first two points to output array
    hullPoints.push(points.shift(), points.shift());
    // scan is repeated until no concave points are present.
    while (true) {
      var p0,
          p1,
          p2;
      hullPoints.push(points.shift());
      p0 = hullPoints[hullPoints.length - 3];
      p1 = hullPoints[hullPoints.length - 2];
      p2 = hullPoints[hullPoints.length - 1];
      if (this._checkPoints(p0, p1, p2)) {
        hullPoints.splice(hullPoints.length - 2, 1);
      }
      if (points.length == 0) {
        if (pointsLength == hullPoints.length) {
          // check for duplicate anchorPoint edge-case, if not found, add the anchorpoint as the first item.
          var ap = this.anchorPoint;
          // remove any udefined elements in the hullPoints array.
          hullPoints = hullPoints.filter(function(p) { return !!p; });
          if (!hullPoints.some(function(p) {
              return (p.x == ap.x && p.y == ap.y);
            })) {
            hullPoints.unshift(this.anchorPoint);
          }
          return hullPoints;
        }
        points = hullPoints;
        pointsLength = points.length;
        hullPoints = [];
        hullPoints.push(points.shift(), points.shift());
      }
    }
  }
};

/**
* Picker: Mouse event handler that uses gpu picking
**/

function Picker() {
  this.scene = new THREE.Scene();
  this.scene.background = new THREE.Color(0x000000);
  this.mouseDown = new THREE.Vector2();
  this.tex = this.getTexture();
}

// get the texture on which off-screen rendering will happen
Picker.prototype.getTexture = function() {
  var canvasSize = getCanvasSize();
  var tex = new THREE.WebGLRenderTarget(canvasSize.w, canvasSize.h);
  tex.texture.minFilter = THREE.LinearFilter;
  return tex;
}

// on canvas mousedown store the coords where user moused down
Picker.prototype.onMouseDown = function(e) {
  var click = this.getClickOffsets(e);
  this.mouseDown.x = click.x;
  this.mouseDown.y = click.y;
}

// get the x, y offsets of a click within the canvas
Picker.prototype.getClickOffsets = function(e) {
  var rect = e.target.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  }
}

// on canvas click, show detailed modal with clicked image
Picker.prototype.onMouseUp = function(e) {
  // if click hit background, close the modal
  if (e.target.className == 'modal-top' ||
      e.target.className == 'modal-x') {
    return modal.close();
  }
  // find the offset of the click event within the canvas
  var click = this.getClickOffsets(e);
  // if mouseup isn't in the last mouse position, user is dragging
  // if the click wasn't on the canvas, quit
  var cellIdx = this.select({x: click.x, y: click.y});
  if (click.x !== this.mouseDown.x ||
      click.y !== this.mouseDown.y || // m.down and m.up != means user is dragging
      cellIdx == -1 || // cellIdx == -1 means the user didn't click on a cell
      e.target.id !== 'pixplot-canvas') { // whether the click hit the gl canvas
    return;
  }
  // if we're in select mode, conditionally un/select the clicked cell
  if (world.mode == 'select') {
    if (keyboard.shiftPressed() || keyboard.commandPressed()) {
      return lasso.toggleSelection(cellIdx);
    }
  }
  // else we're in pan mode; zoom in if the camera is far away, else show the modal
  else if (world.mode == 'pan') {
    return world.camera.position.z > config.pickerMaxZ
      ? world.flyToCellIdx(cellIdx)
      : modal.showCells([cellIdx]);
  }
}

// get the mesh in which to render picking elements
Picker.prototype.init = function() {
  world.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
  document.body.addEventListener('mouseup', this.onMouseUp.bind(this));
  var group = new THREE.Group();
  for (var i=0; i<world.group.children.length; i++) {
    var mesh = world.group.children[i].clone();
    mesh.material = world.getShaderMaterial({useColor: true});
    group.add(mesh);
  }
  this.scene.add(group);
}

// draw an offscreen world then reset the render target so world can update
Picker.prototype.render = function() {
  world.renderer.setRenderTarget(this.tex);
  world.renderer.render(this.scene, world.camera);
  world.renderer.setRenderTarget(null);
}

Picker.prototype.select = function(obj) {
  if (!world || !obj) return;
  this.render();
  // read the texture color at the current mouse pixel
  var pixelBuffer = new Uint8Array(4),
      x = obj.x * window.devicePixelRatio,
      y = this.tex.height - obj.y * window.devicePixelRatio;
  world.renderer.readRenderTargetPixels(this.tex, x, y, 1, 1, pixelBuffer);
  var id = (pixelBuffer[0] << 16) | (pixelBuffer[1] << 8) | (pixelBuffer[2]),
      cellIdx = id-1; // ids use id+1 as the id of null selections is 0
  return cellIdx;
}

/**
* Add date based layout and filtering
**/

function Dates() {}

Dates.prototype.init = function() {
  // set elems used below
  this.elems = {
    container: document.querySelector('#date-container'),
    slider: document.querySelector('#date-slider'),
  }
  // remove the dom element if there is no date data
  if (!data.json.layouts.date) return;
  this.elems.container.style.display = 'inline-block';
  // dates domain, selected range, and filename to date map
  this.state = {
    data: {},
    min: null,
    max: null,
    selected: [null, null],
  }
  // add the dates object to the filters for joint filtering
  filters.filters.push(this);
  // function for filtering images
  this.imageSelected = function(image) {
    return true;
  };
  // init
  this.load();
}

Dates.prototype.load = function() {
  get(getPath(config.data.dir + '/metadata/dates.json'), function(json) {
    // set range slider domain
    this.state.min = json.domain.min;
    this.state.max = json.domain.max;
    // store a map from image name to year
    var keys = Object.keys(json.dates);
    keys.forEach(function(k) {
      try {
        var _k = parseInt(k);
      } catch(err) {
        var _k = k;
      }
      json.dates[k].forEach(function(img) {
        this.state.data[img] = _k;
      }.bind(this))
      this.imageSelected = function(image) {
        var year = this.state.data[image];
        // if the selected years are the starting domain, select all images
        if (this.state.selected[0] == this.state.min &&
            this.state.selected[1] == this.state.max) return true;
        if (!year || !Number.isInteger(year)) return false;
        return year >= this.state.selected[0] && year <= this.state.selected[1];
      }
    }.bind(this))
    // add the filter now that the dates have loaded
    this.addFilter();
  }.bind(this))
}

Dates.prototype.addFilter = function() {
  this.slider = noUiSlider.create(this.elems.slider, {
    start: [this.state.min, this.state.max],
    tooltips: [true, true],
    step: 1,
    behaviour: 'drag',
    connect: true,
    range: {
      'min': this.state.min,
      'max': this.state.max,
    },
    format: {
      to: function (value) { return parseInt(value) },
      from: function (value) { return parseInt(value) },
    },
  });
  this.slider.on('update', function(values) {
    this.state.selected = values;
    filters.filterImages();
  }.bind(this))
}

/**
* Draw text into the scene
**/

function Text() {}

Text.prototype.init = function() {
  if (!data.json.layouts.date) return;
  this.count = 1000; // max number of characters to represent
  this.point = 128.0; // px of each letter in atlas texture
  this.scale = 0; // 8 so 'no date' fits in one grid space
  this.kerning = 0; // scalar specifying y axis letter spacing
  this.canvas = null; // px of each size in the canvas
  this.texture = this.getTexture(); // map = {letter: px offsets}, tex = texture
  this.json = {}; // will store the label and layout data
  this.createMesh();
  this.addEventListeners();
}

Text.prototype.addEventListeners = function() {
  window.addEventListener('resize', function() {
    if (!this.mesh) return;
    this.mesh.material.uniforms.scale.value = world.getPointScale();
  }.bind(this))
}

// create a basic ascii texture with cells for each letter
Text.prototype.getTexture = function() {
  var canvas = document.createElement('canvas'),
      ctx = canvas.getContext('2d'),
      characterMap = {},
      xOffset = 0.2, // offset to draw letters in center of grid position
      yOffset = 0.2, // offset to draw full letters w/ baselines...
      charFirst = 48, // ord of the first character in the map
      charLast = 122, // ord of the last character in the map
      skips = ':;<=>?@[\\]^_`', // any characters to skip in the map
      chars = charLast - charFirst - skips.length + 1; // n characters to include in map
  this.canvas = this.point * Math.ceil(chars**(1/2))
  canvas.width = this.canvas; //
  canvas.height = this.canvas;
  canvas.id = 'character-canvas';
  ctx.font = this.point + 'px Monospace';
  // give the canvas a black background for pixel discarding
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  // draw the letters on the canvas
  var x = 0,
      y = 0;
  for (var i=charFirst; i<charLast+1; i++) {
    var char = String.fromCharCode(i);
    if (skips.includes(char)) continue;
    characterMap[char] = {x: x, y: y};
    ctx.fillText(char, x+(xOffset*this.point), y+this.point-(yOffset*this.point));
    x += this.point;
    if (x > canvas.width - this.point) {
      x = 0;
      y += this.point;
    }
  }
  // build a three texture with the canvas
  var tex = new THREE.Texture(canvas);
  tex.flipY = false;
  tex.needsUpdate = true;
  return {map: characterMap, tex: tex};
}

// initialize the text mesh
Text.prototype.createMesh = function() {
  // set mesh sizing attributes based on number of columns in each bar group
  this.scale = config.size.points.date;
  this.kerning = this.scale * 0.8;
  // create the mesh
  var geometry = new THREE.BufferGeometry(),
      positions = new THREE.BufferAttribute(new Float32Array(this.count*3), 3),
      offsets = new THREE.BufferAttribute(new Uint16Array(this.count*2), 2);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('offset', offsets);
  var material = new THREE.RawShaderMaterial({
    uniforms: {
      point: {
        type: 'f',
        value: this.point,
      },
      canvas: {
        type: 'f',
        value: this.canvas,
      },
      scale: {
        type: 'f',
        value: this.getPointScale(),
      },
      texture: {
        type: 't',
        value: this.texture.tex,
      },
      render: {
        type: 'f',
        value: 0, // 0=false; 1=true
      },
    },
    vertexShader: document.querySelector('#text-vertex-shader').textContent,
    fragmentShader: document.querySelector('#text-fragment-shader').textContent,
  });
  this.mesh = new THREE.Points(geometry, material);
  this.mesh.frustumCulled = false;
  world.scene.add(this.mesh);
}

// arr = [{word: x: y: z: }, ...]
Text.prototype.setWords = function(arr) {
  var offsets = new Uint16Array(this.count*2),
      positions = new Float32Array(this.count*3),
      offsetIdx = 0,
      positionIdx = 0;
  arr.forEach(function(i, idx) {
    for (var c=0; c<i.word.length; c++) {
      var offset = i.word[c] in this.texture.map
        ? this.texture.map[i.word[c]]
        : {
            x: this.canvas-this.point, // fallback for letters not in canvas
            y: this.canvas-this.point,
          }
      offsets[offsetIdx++] = offset.x;
      offsets[offsetIdx++] = offset.y;
      positions[positionIdx++] = i.x + this.kerning*c;
      positions[positionIdx++] = i.y;
      positions[positionIdx++] = i.z || 0;
    }
    this.mesh.geometry.attributes.position.array = positions;
    this.mesh.geometry.attributes.offset.array = offsets;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.offset.needsUpdate = true;
  }.bind(this));
}

Text.prototype.getPointScale = function() {
  return window.devicePixelRatio * window.innerHeight * this.scale;
}

// use JSON data with labels and positions attributes to set current text
Text.prototype.formatText = function(json) {
  var l = [];
  json.labels.forEach(function(word, idx) {
    l.push({
      word: word,
      x: json.positions[idx][0],
      y: json.positions[idx][1],
    })
  })
  this.setWords(l);
}

/**
* Draw lines to represent poses
**/

function Lines() {
  this.elems = {
    container: document.querySelector('#pose-display-container'),
    select: document.querySelector('#pose-display-select'),
  }
}

Lines.prototype.plot = function() {
  if (!data.layouts.pose) return;
  // json is a 3d array [[[x, y, score]]]
  get(getPath('data/image-vectors/openpose/vectors.json'), function(json) {
    this.json = json;
    // draw lines
    var material = new THREE.RawShaderMaterial({
      vertexShader: document.querySelector('#line-vertex-shader').textContent,
      fragmentShader: document.querySelector('#line-fragment-shader').textContent,
      uniforms: {
        transitionPercent: {type: 'f', value: 0.0},
        display: {type: 'f', value: 0.0},
        scale: {type: 'f', value: 0.0},
        targetScale: {type: 'f', value: 0.0},
      },
    })
    var geometry = new THREE.BufferGeometry();
    var attributes = this.getAttributes('position');
    geometry.setAttribute('position', attributes.positions);
    geometry.setAttribute('targetPosition', attributes.positions.clone());
    geometry.setAttribute('midpoint', attributes.midpoints);
    geometry.setAttribute('targetMidpoint', attributes.midpoints.clone());
    this.mesh = new THREE.LineSegments(geometry, material);
    world.scene.add(this.mesh);
    // make the poses displayable
    this.elems.container.style.display = 'inline-block';
    this.elems.select.addEventListener('change', this.toggleLineDisplay.bind(this));
  }.bind(this))
}

Lines.prototype.getAttributes = function(vertexType) {
  var threshold = 0.1, // confidence threshold needed to render vertex
      positions = [],
      midpoints = [],
      positionsIdx = 0,
      midpointsIdx = 0,
      pairs = [
    [10, 9], // right leg
    [9, 8],
    [11, 12], // left leg
    [12, 13],
    [2, 3], // right arm
    [3, 4],
    [5, 6], // left arm
    [6, 7],
    [11, 5], // torso
    [5, 2],
    [2, 8],
    [8, 11],
  ];
  this.json.forEach(function(body, bodyIdx) {
    // find the domain of vertices for height normalization
    var domains = {
      x: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      y: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      score: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    };
    // set the domain and sum of x, y, and score for this body
    body.forEach(function(vert) {
      if (vert[0] < domains.x[0]) domains.x[0] = vert[0];
      if (vert[0] > domains.x[1]) domains.x[1] = vert[0];
      if (vert[1] < domains.y[0]) domains.y[0] = vert[1];
      if (vert[1] > domains.y[1]) domains.y[1] = vert[1];
      if (vert[2] < domains.score[0]) domains.score[0] = vert[2];
      if (vert[2] > domains.score[1]) domains.score[1] = vert[2];
    });
    // get midpoint position along each axis
    var midpoint = {
      x: (domains.x[0] + domains.x[1])/2,
      y: 1 - ((domains.y[0] + domains.y[1])/2),
    };
    // set the size scalar
    var scalar = (0.005 / (domains.y[1] - domains.y[0]));
    // identify the body vertices
    var vertices = [];
    body.forEach(function(vert, vertIdx) {
      var x = vert[0];
      var y = 1-vert[1];
      var keys = vertexType == 'position'
        ? {x: 'x', y: 'y'}
        : {x: 'tx', y: 'ty'}
      vertices.push({
        x: data.cells[bodyIdx][keys.x] + (scalar * (x-midpoint.x)),
        y: data.cells[bodyIdx][keys.y] + (scalar * (y-midpoint.y)),
        score: vert[2],
      })
    })
    // find the mean of all vertices in each dimension
    var sums = {
      x: 0,
      y: 0,
    };
    vertices.forEach(function(vertex) {
      if (vertex.score >= threshold) {
        sums.x += vertex.x;
        sums.y += vertex.y;
      }
    })
    // determine the number of retained vertices
    var n = vertices.filter(function(v) { return v.score >= threshold }).length;
    // add the lines between the vertices
    for (var i=0; i<pairs.length; i++) {
      var a = vertices[pairs[i][0]];
      var b = vertices[pairs[i][1]];
      if (a.score < threshold || b.score < threshold) continue;
      positions[positionsIdx++] = a.x;
      positions[positionsIdx++] = a.y;
      positions[positionsIdx++] = 0;
      positions[positionsIdx++] = b.x;
      positions[positionsIdx++] = b.y;
      positions[positionsIdx++] = 0;
      // todo: reconfigure body as instanced buffer geometry
      midpoints[midpointsIdx++] = sums.x / n;
      midpoints[midpointsIdx++] = sums.y / n;
      midpoints[midpointsIdx++] = sums.x / n;
      midpoints[midpointsIdx++] = sums.y / n;
    }
  })
  return {
    positions: new THREE.BufferAttribute(new Float32Array(positions), 3),
    midpoints: new THREE.BufferAttribute(new Float32Array(midpoints), 2),
  }
}

Lines.prototype.toggleLineDisplay = function() {
  this.setDisplay(this.elems.select.value);
}

// selected must be 'lines' or 'images'
Lines.prototype.setDisplay = function(selected) {
  if (selected == 'poses') {
    for (var i=0; i<world.group.children.length; i++) {
      world.group.children[i].material.uniforms.display.value = 0.0;
    }
    lines.mesh.material.uniforms.display.value = 1.0;
  } else {
    for (var i=0; i<world.group.children.length; i++) {
      world.group.children[i].material.uniforms.display.value = 1.0;
    }
    lines.mesh.material.uniforms.display.value = 0.0;
  }
}

/**
* Create a modal for larger image viewing
**/

function Modal() {
  this.cellIdx = null;
  this.cellIndices = [];
  this.addEventListeners();
  this.state = {
    highlightPose: false,
  }
}

Modal.prototype.showCells = function(cellIndices, cellIdx) {
  var self = this;
  self.displayed = true;
  self.cellIndices = Object.assign([], cellIndices);
  self.cellIdx = !isNaN(parseInt(cellIdx)) ? parseInt(cellIdx) : 0;
  // parse data attributes
  var filename = data.json.images[self.cellIndices[self.cellIdx]];
  // conditionalize the path to the image
  var src = data.json.images_cropped
    ? config.data.dir + '/uncropped/' + trimFilenameSuffix(filename)
    : config.data.dir + '/originals/' + filename;
  // define function to show the modal
  function showModal(json) {
    var json = json || {};
    var template = document.querySelector('#selected-image-template').textContent;
    var target = document.querySelector('#selected-image-target');
    var hasPose = 'pose' in data.json.layouts && data.json.layouts['pose'];
    var templateData = {
      hasPose: hasPose,
      multiImage: self.cellIndices.length > 1,
      meta: Object.assign({}, json || {}, {
        src: src,
        filename: json.filename || filename,
      })
    }
    target.innerHTML = _.template(template)(templateData);
    target.style.display = 'block';
    // add the image to the svg
    document.querySelector('#svg-image-filtered').setAttribute('href', json.image.src);
    document.querySelector('#svg-image-unfiltered').setAttribute('href', json.image.src);
    // add the click listener to the pose icon if relevant
    if (hasPose) {
      document.querySelector('#pose-highlight-icon').addEventListener('click', self.togglePoseHighlight.bind(self))
      window.addEventListener('resize', self.resizePoseHighlight.bind(self));
    }
    // inject the loaded image into the DOM
    document.querySelector('#selected-image-parent').appendChild(json.image);
  }
  // prepare the modal
  var image = new Image();
  image.id = 'selected-image';
  image.onload = function() {
    showModal({image: image})
    get(config.data.dir + '/metadata/file/' + filename + '.json', function(json) {
      showModal(Object.assign({}, json, {image: image}));
    });
  }
  image.src = src;
}

Modal.prototype.close = function() {
  window.location.href = '#';
  document.querySelector('#selected-image-target').style.display = 'none';
  window.removeEventListener('resize', self.resizePoseHighlight);
  this.cellIndices = [];
  this.cellIdx = null;
  this.displayed = false;
}

Modal.prototype.addEventListeners = function() {
  window.addEventListener('keydown', this.handleKeydown.bind(this))
}

Modal.prototype.handleKeydown = function(e) {
  if (e.keyCode == 37) this.showPreviousCell();
  if (e.keyCode == 39) this.showNextCell();
}

Modal.prototype.showPreviousCell = function() {
  if (!this.displayed) return;
  var cellIdx = this.cellIdx > 0
    ? this.cellIdx - 1
    : this.cellIndices.length-1;
  this.showCells(this.cellIndices, cellIdx);
}

Modal.prototype.showNextCell = function() {
  if (!this.displayed) return;
  var cellIdx = this.cellIdx < this.cellIndices.length-1
    ? this.cellIdx + 1
    : 0;
  this.showCells(this.cellIndices, cellIdx);
}

Modal.prototype.togglePoseHighlight = function() {
  var highlightPose = !this.state.highlightPose;
  if (highlightPose) {
    document.querySelector('#pose-highlight-icon').classList.add('active');
    this.applyGaussianFilter();
  } else {
    document.querySelector('#pose-highlight-icon').classList.remove('active');
    this.removeGaussianFilter();
  }
  this.state.highlightPose = highlightPose;
}

Modal.prototype.applyGaussianFilter = function() {
  // remove the extant ellipse if any
  var elem = document.querySelector('#blur-ellipse');
  if (elem) elem.parentNode.removeChild(elem);
  // identify the svg to which the ellipse will be added
  var elem = document.querySelector('#selected-image-svg');
  var box = elem.getBoundingClientRect();
  // get the padding of the svg / image elements
  var padding = {};
  ['top', 'right', 'bottom', 'left'].forEach(function(i) {
    var s = getComputedStyle(elem, null).getPropertyValue('padding-' + i);
    padding[i] = parseInt(s.replace('px', ''));
  })
  // w,h of the svg / image elements
  var w = box.width - padding.left - padding.right;
  var h = box.height - padding.top - padding.bottom;
  // get the vertex data
  var threshold = 0.1;
  var lineData = lines.json[modal.cellIndices[modal.cellIdx]];
  var vertices = [];
  for (var i=0; i<lineData.length; i++) {
    var score = lineData[i][2];
    if (score >= threshold) {
      vertices.push({
        x: lineData[i][0] * w,
        y: lineData[i][1] * h,
        score: score,
      })
    }
  }
  var sums = {
    x: 0,
    y: 0,
  };
  var domains = {
    x: [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
    y: [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  }
  vertices.forEach(function(v) {
    sums.x += v.x;
    sums.y += v.y;
    if (v.x < domains.x[0]) domains.x[0] = v.x;
    if (v.x > domains.x[1]) domains.x[1] = v.x;
    if (v.y < domains.y[0]) domains.y[0] = v.y;
    if (v.y > domains.y[1]) domains.y[1] = v.y;
  })
  // raw pixel position of ellipse for current screen size
  var raw = {
    'cx': sums.x / vertices.length,
    'cy': (sums.y * 1.1) / vertices.length,
    'rx': (domains.x[1] - domains.x[0]) * 0.7,
    'ry': (domains.y[1] - domains.y[0]) * 0.7,
  }
  var normalized = {
    'cx': (raw.cx / w) * 100 + '%',
    'cy': (raw.cy / h) * 100 + '%',
    'rx': (raw.rx / w) * 100 + '%',
    'ry': (raw.ry / h) * 100 + '%',
  }
  var ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
  ellipse.setAttribute('cx', raw.cx);
  ellipse.setAttribute('cy', raw.cy);
  ellipse.setAttribute('rx', raw.rx);
  ellipse.setAttribute('ry', raw.ry);
  ellipse.setAttribute('fill', '#ffffff');
  ellipse.setAttribute('filter', 'url(#blur-filter)');
  ellipse.setAttribute('id', 'blur-ellipse');
  document.querySelector('#blur-mask').appendChild(ellipse);
  // hide the original image
  document.querySelector('#selected-image').style.opacity = 0;
  document.querySelector('#svg-image-filtered').style.opacity = 0.25;
}

Modal.prototype.removeGaussianFilter = function() {
  document.querySelector('#svg-image-filtered').style.opacity = 1;
}

Modal.prototype.resizePoseHighlight = function() {
  if (this.state.highlightPose) this.applyGaussianFilter();
}

/**
* Create a level-of-detail texture mechanism
**/

function LOD() {
  var r = 1; // radius of grid to search for cells to activate
  this.tex = this.getCanvas(config.size.lodTexture); // lod high res texture
  this.cell = this.getCanvas(config.size.lodCell);
  this.cellIdxToImage = {}; // image cache mapping cell idx to loaded image data
  this.grid = {}; // set by this.indexCells()
  this.minZ = 0.8; // minimum zoom level to update textures
  this.initialRadius = r; // starting radius for LOD
  this.state = {
    openCoords: this.getAllTexCoords(), // array of unused x,y lod tex offsets
    camPos: { x: null, y: null }, // grid coords of current camera position
    neighborsRequested: 0,
    gridPosToCoords: {}, // map from a x.y grid position to cell indices and tex offsets at that grid position
    cellIdxToCoords: {}, // map from a cell idx to that cell's x, y offsets in lod texture
    cellsToActivate: [], // list of cells cached in this.cellIdxToImage and ready to be added to lod texture
    fetchQueue: [], // list of images that need to be fetched and cached
    radius: r, // current radius for LOD
    run: true, // bool indicating whether to use the lod mechanism
  };
}

/**
* LOD Static Methods
**/

LOD.prototype.getCanvas = function(size) {
  var canvas = getElem('canvas', {width: size, height: size, id: 'lod-canvas'});
  return {
    canvas: canvas,
    ctx: canvas.getContext('2d'),
    texture: world.getTexture(canvas),
  }
}

// create array of x,y texture offsets in lod texture open for writing
LOD.prototype.getAllTexCoords = function() {
  var coords = [];
  for (var y=0; y<config.size.lodTexture/config.size.lodCell; y++) {
    for (var x=0; x<config.size.lodTexture/config.size.lodCell; x++) {
      coords.push({x: x*config.size.lodCell, y: y*config.size.lodCell});
    }
  }
  return coords;
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
  this.grid = coords;
}

// given an object with {x, y, z} attributes, return the object's coords in grid
LOD.prototype.toGridCoords = function(pos) {
  var domain = data.boundingBox;
  // determine point's position as percent of each axis size 0:1
  var percent = {
    x: (pos.x-domain.x.min)/(domain.x.max-domain.x.min),
    y: (pos.y-domain.y.min)/(domain.y.max-domain.y.min),
  };
  // cut each axis into n buckets per axis and determine point's bucket indices
  var bucketSize = {
    x: 1/Math.max(100, Math.ceil(data.json.images.length/100)),
    y: 1/Math.max(100, Math.ceil(data.json.images.length/100)),
  };
  return {
    x: Math.floor(percent.x / bucketSize.x),
    y: Math.floor(percent.y / bucketSize.y),
  };
}

/**
* LOD Dynamic Methods
**/

// load high-res images nearest the camera; called every frame by world.render
LOD.prototype.update = function() {
  if (!this.state.run || world.state.flying || world.state.transitioning) return;
  this.updateGridPosition();
  this.fetchNextImage();
  world.camera.position.z < this.minZ
    ? this.addCellsToLodTexture()
    : this.clear();
}

LOD.prototype.updateGridPosition = function() {
  // determine the current grid position of the user / camera
  var camPos = this.toGridCoords(world.camera.position);
  // if the user is in a new grid position unload old images and load new
  if (this.state.camPos.x !== camPos.x || this.state.camPos.y !== camPos.y) {
    if (this.state.radius > 1) {
      this.state.radius = Math.ceil(this.state.radius*0.6);
    }
    this.state.camPos = camPos;
    this.state.neighborsRequested = 0;
    this.unload();
    if (world.camera.position.z < this.minZ) {
      this.state.fetchQueue = getNested(this.grid, [camPos.x, camPos.y], []);
    }
  }
}

// if there's a fetchQueue, fetch the next image, else fetch neighbors
// nb: don't mutate fetchQueue, as that deletes items from this.grid
LOD.prototype.fetchNextImage = function() {
  // if the selection modal is displayed don't fetch additional images
  if (lasso.displayed) return;
  // identfiy the next image to be loaded
  var cellIdx = this.state.fetchQueue[0];
  this.state.fetchQueue = this.state.fetchQueue.slice(1);
  // if there was a cell index in the load queue, load that next image
  if (Number.isInteger(cellIdx)) {
    // if this image is in the cache
    if (this.cellIdxToImage[cellIdx]) {
      // if this image isn't already activated, add it to the list to activate
      if (!this.state.cellIdxToCoords[cellIdx]) {
        this.state.cellsToActivate = this.state.cellsToActivate.concat(cellIdx);
      }
    // this image isn't in the cache, so load and cache it
    } else {
      var image = new Image;
      image.onload = function(cellIdx) {
        this.cellIdxToImage[cellIdx] = image;
        if (!this.state.cellIdxToCoords[cellIdx]) {
          this.state.cellsToActivate = this.state.cellsToActivate.concat(cellIdx);
        }
      }.bind(this, cellIdx);
      image.src = config.data.dir + '/thumbs/' + data.json.images[cellIdx];
    };
  // there was no image to fetch, so add neighbors to fetch queue if possible
  } else if (this.state.neighborsRequested < this.state.radius) {
    this.state.neighborsRequested = this.state.radius;
    for (var x=Math.floor(-this.state.radius*1.5); x<=Math.ceil(this.state.radius*1.5); x++) {
      for (var y=-this.state.radius; y<=this.state.radius; y++) {
        var coords = [this.state.camPos.x+x, this.state.camPos.y+y],
            cellIndices = getNested(this.grid, coords, []).filter(function(cellIdx) {
            return !this.state.cellIdxToCoords[cellIdx];
          }.bind(this))
        this.state.fetchQueue = this.state.fetchQueue.concat(cellIndices);
      }
    }
    if (this.state.openCoords && this.state.radius < 30) {
      this.state.radius++;
    }
  }
}

/**
* Add cells to LOD
**/

// add each cell in cellsToActivate to the LOD texture
LOD.prototype.addCellsToLodTexture = function() {
  var textureNeedsUpdate = false;
  // find and store the coords where each img will be stored in lod texture
  for (var i=0; i<this.state.cellsToActivate.length; i++) {
    var cellIdx = this.state.cellsToActivate[0],
        cell = data.cells[cellIdx];
    this.state.cellsToActivate = this.state.cellsToActivate.slice(1);
    // if cell is already loaded or is too far from camera quit
    if (this.state.cellIdxToCoords[cellIdx] || !this.inRadius(cell.gridCoords)) continue;
    // return if there are no open coordinates in the LOD texture
    var coords = this.state.openCoords[0];
    this.state.openCoords = this.state.openCoords.slice(1);
    // if (!coords), the LOD texture is full
    if (coords) {
      textureNeedsUpdate = true;
      // gridKey is a combination of the cell's x and y positions in the grid
      var gridKey = cell.gridCoords.x + '.' + cell.gridCoords.y;
      // initialize this grid key in the grid position to coords map
      if (!this.state.gridPosToCoords[gridKey]) this.state.gridPosToCoords[gridKey] = [];
      // add the cell data to the data stores
      this.state.gridPosToCoords[gridKey].push(Object.assign({}, coords, {cellIdx: cell.idx}));
      this.state.cellIdxToCoords[cell.idx] = coords;
      // draw the cell's image in a new canvas
      this.cell.ctx.clearRect(0, 0, config.size.lodCell, config.size.lodCell);
      this.cell.ctx.drawImage(this.cellIdxToImage[cell.idx], 0, 0);
      var tex = world.getTexture(this.cell.canvas);
      world.renderer.copyTextureToTexture(coords, tex, this.tex.texture);
      // activate the cell to update tex index and offsets
      cell.activate();
    }
  }
  // only update the texture and attributes if the lod tex changed
  if (textureNeedsUpdate) {
    world.attrsNeedUpdate(['textureIndex', 'offset']);
  }
}


LOD.prototype.inRadius = function(obj) {
  var xDelta = Math.floor(Math.abs(obj.x - this.state.camPos.x)),
      yDelta = Math.ceil(Math.abs(obj.y - this.state.camPos.y));
  // don't load the cell if it's too far from the camera
  return (xDelta <= (this.state.radius * 1.5)) && (yDelta < this.state.radius);
}

/**
* Remove cells from LOD
**/

// free up the high-res textures for images now distant from the camera
LOD.prototype.unload = function() {
  Object.keys(this.state.gridPosToCoords).forEach(function(gridPos) {
    var split = gridPos.split('.');
    if (!this.inRadius({ x: parseInt(split[0]),  y: parseInt(split[1]) })) {
      this.unloadGridPos(gridPos);
    }
  }.bind(this));
}

LOD.prototype.unloadGridPos = function(gridPos) {
  // cache the texture coords for the grid key to be deleted
  var toUnload = this.state.gridPosToCoords[gridPos];
  // delete unloaded cell keys in the cellIdxToCoords map
  toUnload.forEach(function(coords) {
    try {
      // deactivate the cell to update buffers and free this cell's spot
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
  this.state.camPos = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  world.attrsNeedUpdate(['offset', 'textureIndex']);
  this.state.radius = this.initialRadius;
}

/**
* Configure filters
**/

function Filters() {
  this.filters = [];
  self.values = [];
}

Filters.prototype.loadFilters = function() {
  var url = config.data.dir + '/metadata/filters/filters.json';
  get(getPath(url), function(data) {
    for (var i=0; i<data.length; i++) {
      this.filters.push(new Filter(data[i]));
    }
  }.bind(this))
}

// determine which images to keep in the current selection
Filters.prototype.filterImages = function() {
  var indices = [];
  for (var i=0; i<data.json.images.length; i++) {
    var keep = true;
    for (var j=0; j<this.filters.length; j++) {
      if (this.filters[j].imageSelected &&
          !this.filters[j].imageSelected(data.json.images[i])) {
        keep = false;
        break;
      }
    }
    if (keep) indices.push(i);
  }
  world.setOpaqueImages(indices);
}

function Filter(obj) {
  this.values = obj.filter_values || [];
  if (this.values.length <= 1) return;
  this.selected = null;
  this.name = obj.filter_name || '';
  this.elem = document.createElement('div');
  this.elem.addEventListener('mouseenter', this.show.bind(this));
  this.elem.addEventListener('mouseleave', this.hide.bind(this));
  // create the filter's select
  this.elem.className = 'filter';
  var label = document.createElement('div');
  label.className = 'settings-label filter-label';
  label.textContent = 'Category';
  this.elem.appendChild(label);
  // format all filter options
  var children = document.createElement('div');
  children.className = 'filter-options';
  for (var i=0; i<this.values.length; i++) {
    var child = document.createElement('div');
    child.setAttribute('data-label', this.values[i]);
    child.addEventListener('click', this.onChange.bind(this));
    child.className = 'filter-option no-highlight';
    var input = document.createElement('input');
    var label = document.createElement('div');
    input.setAttribute('type', 'checkbox');
    label.textContent = this.values[i].replace(/__/g, ' ');
    child.appendChild(input);
    child.appendChild(label);
    children.appendChild(child);
  }
  this.elem.appendChild(children);
  // add the select to the DOM
  document.querySelector('#filters').appendChild(this.elem);
  // allow canvas clicks to close the filter options
  document.querySelector('#pixplot-canvas').addEventListener('click', this.hide.bind(this));
}

Filter.prototype.showHide = function(e) {
  this.elem.classList.toggle('open');
}

Filter.prototype.show = function() {
  this.elem.classList.add('open');
}

Filter.prototype.hide = function() {
  this.elem.classList.remove('open');
}

Filter.prototype.onChange = function(e) {
  // find the filter
  var elem = e.target;
  while (!elem.classList.contains('filter-option')) elem = elem.parentNode;
  // toggle the classlist
  elem.classList.toggle('active');
  // update the ui given the state of this element
  if (elem.classList.contains('active')) {
    // uncheck all of the other options
    var elems = this.elem.querySelectorAll('.filter-option');
    for (var i=0; i<elems.length; i++) {
      elems[i].classList.remove('active');
      elems[i].querySelector('input').checked = false;
    }
    // update state
    elem.classList.add('active');
    elem.querySelector('input').checked = true;
    this.selected = elem.getAttribute('data-label');
    this.elem.classList.add('has-selection');
  } else {
    // update state
    elem.classList.remove('active');
    elem.querySelector('input').checked = false;
    this.selected = null;
    this.elem.classList.remove('has-selection');
  }
  if (!this.selected) {
    // function that indicates whether to include an image in a selection
    this.imageSelected = function(image) {
      return true;
    }
    filters.filterImages();
  } else {
    var filename = this.selected.replace(/\//g, '-').replace(/ /g, '__') + '.json',
        path = getPath(config.data.dir + '/metadata/options/' + filename);
    get(path, function(json) {
      var vals = json.reduce(function(obj, i) {
        obj[i] = true;
        return obj;
      }, {})
      this.imageSelected = function(image) {
        return data.json.images_cropped
          ? trimFilenameSuffix(image) in vals
          : image in vals
      }
      filters.filterImages();
    }.bind(this))
  }
}

/**
* Settings
**/

function Settings() {
  this.elems = {
    tray: document.querySelector('#header-controls-bottom'),
    icon: document.querySelector('#settings-icon'),
  }
  this.state = {
    open: false,
  }
  this.elems.icon.addEventListener('click', this.toggleOpen.bind(this));
}

Settings.prototype.open = function() {
  this.state.open = true;
  this.elems.tray.classList.add('open');
  this.elems.icon.classList.add('no-tooltip');
  this.elems.icon.classList.add('active');
  tooltip.hide();
}

Settings.prototype.close = function() {
  this.state.open = false;
  this.elems.tray.classList.remove('open');
  this.elems.icon.classList.remove('no-tooltip');
  this.elems.icon.classList.remove('active');
}

Settings.prototype.toggleOpen = function() {
  if (this.state.open) this.close();
  else this.open();
}

/**
* Search
**/

function Search() {

}

/**
* Hotspots
**/

function Hotspots() {
  this.json = {};
  this.mesh = null;
  this.edited = false;
  this.nUserClusters = 0;
  this.elems = {
    createHotspot: document.querySelector('#create-hotspot'),
    saveHotspots: document.querySelector('#save-hotspots'),
    navInner: document.querySelector('#nav-inner'),
    template: document.querySelector('#hotspot-template'),
    hotspots: document.querySelector('#hotspots'),
    nav: document.querySelector('nav'),
    tooltip: document.querySelector('#hotspots-tooltip'),
    clearTooltip: document.querySelector('#hotspots-tooltip-button'),
  }
  this.addEventListeners();
}

Hotspots.prototype.initialize = function() {
  get(getPath(data.json.custom_hotspots), this.handleJson.bind(this),
    function(err) {
      get(getPath(data.json.default_hotspots), this.handleJson.bind(this))
    }.bind(this)
  );
}

Hotspots.prototype.handleJson = function(json) {
  if (json.length == 0) this.elems.nav.style.display = 'none';
  this.json = json;
  this.render();
}

Hotspots.prototype.addEventListeners = function() {
  // add create hotspot event listener
  this.elems.createHotspot.addEventListener('click', function() {
    // find the indices of the cells selected
    var indices = [];
    for (var i=0; i<data.cells.length; i++) {
      if (lasso.selected[ data.json.images[i] ]) indices.push(i);
    }
    // flatten the user's selection to a 2D array
    var hull = [];
    for (var i=0; i<lasso.points.length; i++) {
      hull.push([lasso.points[i].x, lasso.points[i].y])
    }
    // augment the hotspots data
    this.json.push({
      convex_hull: hull,
      label: data.hotspots.getUserClusterName(),
      img: data.json.images[choose(indices)],
      images: indices,
    })
    this.setCreateHotspotVisibility(false);
    this.setEdited(true);
    // render the hotspots
    this.render();
    // scroll to the bottom of the hotspots
    setTimeout(this.scrollToBottom.bind(this), 100);
  }.bind(this))
  // add save hotspots event listener
  this.elems.saveHotspots.addEventListener('click', function() {
    downloadFile(this.json, 'user_hotspots.json');
    this.setEdited(false);
  }.bind(this))
  // add drag to reorder event listeners
  this.elems.navInner.addEventListener('dragover', function(e) {
    e.preventDefault()
  })
  this.elems.navInner.addEventListener('drop', function(e) {
    // get the vertical offset of the event
    var y = e.pageY;
    // determine where to place the dragged element
    var hotspots = document.querySelectorAll('.hotspot');
    var nodeToInsertId = e.dataTransfer.getData('text');
    var nodeToInsert = document.getElementById(nodeToInsertId);
    var inserted = false;
    for (var i=0; i<hotspots.length; i++) {
      var elem = hotspots[i];
      var rect = elem.getBoundingClientRect();
      if (!inserted && y <= rect.top + (rect.height/2)) {
        nodeToInsert.classList.remove('dragging');
        elem.parentNode.insertBefore(nodeToInsert, elem);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.elems.hotspots.appendChild(nodeToInsert);
    }
    // rearrange the data in this.json
    var idxA = parseInt(nodeToInsertId.split('-')[1]);
    var idxB = i;
    this.json.splice(idxB, 0, this.json.splice(idxA, 1)[0]);
    this.render();
    // if the dragged item changed positions, allow user to save data
    if (idxA != idxB) this.setEdited(true);
  }.bind(this))
  // add tooltip event listener
  this.elems.nav.addEventListener('mouseenter', function(e) {
    if (localStorage.getItem('hotspots-tooltip-cleared')) return;
    this.elems.tooltip.style.display = 'block';
  }.bind(this))
  // add tooltip clearing event listener
  this.elems.clearTooltip.addEventListener('click', function(e) {
    localStorage.setItem('hotspots-tooltip-cleared', true);
    this.elems.tooltip.style.display = 'none';
  }.bind(this))
}

Hotspots.prototype.render = function() {
  // remove any polygon meshes
  if (this.mesh) world.scene.remove(this.mesh);
  // render the new data
  this.elems.hotspots.innerHTML = _.template(this.elems.template.innerHTML)({
    hotspots: this.json,
    isLocalhost: config.isLocalhost,
    edited: this.edited,
  });
  // render the hotspots
  var hotspots = document.querySelectorAll('.hotspot');
  for (var i=0; i<hotspots.length; i++) {
    // show the number of cells in this hotspot's convex hull
    var polygon = this.json[i].convex_hull;
    var n = 0;
    for (var j=0; j<data.json.images.length; j++) {
      var p = [data.cells[j].x, data.cells[j].y];
      if (pointInPolygon(p, polygon)) n++;
    }
    hotspots[i].querySelector('.hotspot-bar-inner').style.width = (n*100 / data.cells.length) + '%';
    // add hotspot event listeners each time they are re-rendered
    hotspots[i].querySelector('.hotspot-image').addEventListener('click', function(idx) {
      world.flyToCellImage(this.json[idx].img);
    }.bind(this, i));
    // show the convex hull of a cluster on mouse enter
    hotspots[i].addEventListener('mouseenter', function(idx) {
      // update the hover cell buffer
      this.setHotspotHoverBuffer(this.json[idx].images);
      // draw the convex hull around the cells in this cluster
      var h = this.json[idx].convex_hull;
      if (!h) return;
      var shape = new THREE.Shape();
      shape.moveTo(h[0][0], h[0][1]);
      for (var i=1; i<h.length; i++) shape.lineTo(h[i][0], h[i][1]);
      var geometry = new THREE.ShapeBufferGeometry(shape);
      var material = new THREE.MeshBasicMaterial({ color: 0xffffff });
      material.transparent = true;
      material.opacity = 0.25;
      var mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = -0.01;
      //world.scene.add(mesh);
      this.mesh = mesh;
    }.bind(this, i))
    // remove the convex hull shape on mouseout
    hotspots[i].addEventListener('mouseleave', function(e) {
      // update the hover cell buffer
      this.setHotspotHoverBuffer([]);
      // remove the mesh
      world.scene.remove(this.mesh);
    }.bind(this))
    // allow users on localhost to delete hotspots
    var elem = hotspots[i].querySelector('.remove-hotspot-x');
    if (elem) {
      elem.addEventListener('click', function(i, e) {
        // prevent the zoom to image event
        e.preventDefault();
        e.stopPropagation();
        // remove this point from the list of points
        this.json.splice(i, 1);
        this.setEdited(true);
        this.render();
      }.bind(this, i))
    }
    // allow users to select new "diplomat" images for the cluster
    var elem = hotspots[i].querySelector('.refresh-hotspot');
    if (elem) {
      elem.addEventListener('click', function(i, e) {
        // prevent the zoom to image event
        e.preventDefault();
        e.stopPropagation();
        // find the points inside this cluster's convex hull
        var polygon = this.json[i].convex_hull;
        var inside = [];
        for (var j=0; j<data.json.images.length; j++) {
          var p = [data.cells[j].x, data.cells[j].y];
          if (pointInPolygon(p, polygon)) {
            inside.push(j);
          }
        }
        // select a random image from those in this cluster
        var selected = Math.floor(Math.random() * inside.length);
        this.json[i].img = data.json.images[inside[selected]];
        // make the change saveable
        this.setEdited(true);
        this.render();
      }.bind(this, i))
    }
    // prevent newlines when retitling
    hotspots[i].querySelector('.hotspot-label').addEventListener('keydown', function(i, e) {
      if (e.keyCode == 13) {
        e.stopPropagation();
        e.preventDefault();
        hotspots[i].querySelector('.hotspot-label').blur()
      }
    }.bind(this, i))
    // allow users to retitle hotspots
    hotspots[i].querySelector('.hotspot-label').addEventListener('input', function(i, e) {
      this.setEdited(true);
      this.json[i].label = this.formatLabel(hotspots[i].querySelector('.hotspot-label').textContent);
    }.bind(this, i))
    // allow users to reorder hotspots
    hotspots[i].addEventListener('dragstart', function(e) {
      var elem = elem = e.target;
      var id = elem.id || null;
      while (!id) {
        elem = elem.parentNode;
        id = elem.id;
      }
      elem.classList.add('dragging');
      e.dataTransfer.setData('text', id);
    })
  }
}

// encode unicode entities for proper display
Hotspots.prototype.formatLabel = function(s) {
  return s.replace(/[\u00A0-\u9999<>\&]/g, function(i) {
     return '&#'+i.charCodeAt(0)+';';
  });
}

Hotspots.prototype.setEdited = function(bool) {
  this.edited = bool;
  // show / hide the save hotspots button
  this.elems.saveHotspots.style.display = bool ? 'inline-block' : 'none';
}

Hotspots.prototype.showHide = function() {
  this.elems.nav.className = ['umap'].indexOf(layout.selected) > -1
    ? ''
    : 'disabled'
}

Hotspots.prototype.scrollToBottom = function() {
  this.elems.navInner.scrollTo({
    top: this.elems.navInner.scrollHeight,
    behavior: 'smooth',
  });
}

Hotspots.prototype.getUserClusterName = function() {
  // find the names already used
  var usedNames = [];
  for (var i=0; i<data.hotspots.json.length; i++) {
    usedNames.push(data.hotspots.json[i].label);
  }
  // find the next unused name
  var alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var name = 'Cluster ' + alpha[this.nUserClusters++];
  if (this.nUserClusters.length >= alpha.length) this.nUserClusters = 0;
  while (usedNames.indexOf(name) > -1) {
    var name = 'Cluster ' + alpha[this.nUserClusters++];
    if (this.nUserClusters.length >= alpha.length) this.nUserClusters = 0;
  }
  return name;
}

Hotspots.prototype.setCreateHotspotVisibility = function(bool) {
  if (!config.isLocalhost) return;
  this.elems.createHotspot.style.display = bool ? 'inline-block' : 'none';
}

Hotspots.prototype.setSaveHotspotsVisibility = function(bool) {
  this.elems.saveHotspots.style.display = bool ? 'inline-block' : 'none';
}

Hotspots.prototype.setHotspotHoverBuffer = function(arr) {
  // arr contains an array of indices of cells currently selected - create dict for fast lookups
  var d = arr.reduce(function(obj, i) {
    obj[i] = true;
    return obj;
  }, {})
  // create the buffer to be assigned
  var arr = new Uint8Array(data.cells.length);
  for (var i=0; i<arr.length; i++) {
    arr[i] = d[i] ? 1 : 0;
  }
  world.setBuffer('clusterSelected', arr);
}

/**
* Globe: for displaying country shapes
**/

function Globe() {
  this.globeGeometry = new THREE.Geometry();
  this.globeMesh = null;
  this.featureGeometry = new THREE.Geometry();
  this.featureMesh = null;
}

Globe.prototype.load = function() {
  var self = this;

  this.xScale = d3.scaleLinear()
    .domain([-180, 180])
    .range([-1, 1])

  this.yScale = d3.scaleLinear()
    .domain([-90, 90])
    .range([-0.5, 0.5])

  function addShape(parentGeometry, i) {
    // 6 points required for shape to generate faces
    if (!i || i.length < 6) return;
    var shape = new THREE.Shape();
    shape.moveTo(self.xScale(i[0][0]), self.yScale(i[0][1]))
    i.map(j => {
      shape.lineTo(
        self.xScale(j[0]),
        self.yScale(j[1]),
      );
    })
    shape.lineTo(self.xScale(i[0][0]), self.yScale(i[0][1]))
    var geometry = new THREE.ShapeGeometry(shape);
    var mesh = new THREE.Mesh(geometry);
    parentGeometry.merge(mesh.geometry, mesh.matrix);
  }

  get(getPath('assets/json/flat-continents.json'), function(json) {
    json.forEach(addShape.bind(this, self.globeGeometry));
    var material = new THREE.MeshBasicMaterial({
      color: 0x333333,
      side: THREE.DoubleSide,
    })
    self.globeMesh = new THREE.Mesh(self.globeGeometry, material);
  })

  get(getPath('assets/json/geographic-features.json'), function(json) {
    json.forEach(addShape.bind(this, self.featureGeometry));
    var material = new THREE.MeshBasicMaterial({
      color: 0x222222,
      side: THREE.DoubleSide,
    })
    self.featureMesh = new THREE.Mesh(self.featureGeometry, material);
  })
}

Globe.prototype.show = function() {
  world.scene.add(this.globeMesh);
  if (this.featureMesh) {
    world.scene.add(this.featureMesh);
  }
}

Globe.prototype.hide = function() {
  world.scene.remove(this.globeMesh);
  if (this.featureMesh) {
    world.scene.remove(this.featureMesh);
  }
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
  if (!gl) document.querySelector('#webgl-not-available').style.display = 'block';
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
* Keyboard
**/

function Keyboard() {
  this.pressed = {};
  window.addEventListener('keydown', function(e) {
    this.pressed[e.keyCode] = true;
  }.bind(this))
  window.addEventListener('keyup', function(e) {
    this.pressed[e.keyCode] = false;
  }.bind(this))
}

Keyboard.prototype.shiftPressed = function() {
  return this.pressed[16];
}

Keyboard.prototype.commandPressed = function() {
  return this.pressed[91];
}

/**
* Show/hide tooltips for user-facing controls
**/

function Tooltip() {
  this.elem = document.querySelector('#tooltip');
  this.targets = [
    {
      elem: document.querySelector('#layout-alphabetic'),
      text: 'Order images alphabetically by filename',
    },
    {
      elem: document.querySelector('#layout-umap'),
      text: 'Cluster images via UMAP dimensionality reduction',
    },
    {
      elem: document.querySelector('#layout-grid'),
      text: 'Represent UMAP clusters on a grid',
    },
    {
      elem: document.querySelector('#layout-date'),
      text: 'Order images by date',
    },
    {
      elem: document.querySelector('#layout-categorical'),
      text: 'Arrange images into metadata groups',
    },
    {
      elem: document.querySelector('#layout-pose'),
      text: 'Cluster poses via UMAP dimensionality reduction',
    },
    {
      elem: document.querySelector('#layout-geographic'),
      text: 'Arrange images using lat/lng coordinates',
    },
    {
      elem: document.querySelector('#settings-icon'),
      text: 'Configure plot settings',
    },
  ];
  this.targets.forEach(function(i) {
    i.elem.addEventListener('mouseenter', function(e) {
      if (e.target.classList.contains('no-tooltip')) return;
      var offsets = i.elem.getBoundingClientRect();
      this.elem.textContent = i.text;
      this.elem.style.position = 'absolute';
      this.elem.style.left = (offsets.left + i.elem.clientWidth - this.elem.clientWidth + 9) + 'px';
      this.elem.style.top = (offsets.top + i.elem.clientHeight + 16) + 'px';
    }.bind(this));
    i.elem.addEventListener('mouseleave', this.hide.bind(this))
  }.bind(this));
}

Tooltip.prototype.hide = function() {
  this.elem.style.top = '-10000px';
}

/**
* Handle load progress and welcome scene events
**/

function Welcome() {
  this.progressElem = document.querySelector('#progress');
  this.loaderTextElem = document.querySelector('#loader-text');
  this.loaderSceneElem = document.querySelector('#loader-scene');
  this.buttonElem = document.querySelector('#enter-button');
  this.buttonElem.addEventListener('click', this.onButtonClick.bind(this));
}

Welcome.prototype.onButtonClick = function(e) {
  if (e.target.className.indexOf('active') > -1) {
    requestAnimationFrame(function() {
      this.removeLoader(function() {
        this.startWorld();
      }.bind(this));
    }.bind(this));
  }
}

Welcome.prototype.removeLoader = function(onSuccess) {
  var blocks = document.querySelectorAll('.block');
  for (var i=0; i<blocks.length; i++) {
    setTimeout(function(i) {
      blocks[i].style.animation = 'exit 300s';
      setTimeout(function(i) {
        blocks[i].parentNode.removeChild(blocks[i]);
        if (i == blocks.length-1) onSuccess();
      }.bind(this, i), 1000)
    }.bind(this, i), i*100)
  }
  document.querySelector('#progress').style.opacity = 0;
}

Welcome.prototype.updateProgress = function() {
  var progress = valueSum(data.textureProgress) / data.textureCount;
  // remove the decimal value from the load progress
  progress = progress.toString();
  var index = progress.indexOf('.');
  if (index > -1) progress = progress.substring(0, index);
  // display the load progress
  this.progressElem.textContent = progress + '%';
  if (progress == 100 &&
      data.loadedTextures == data.textureCount &&
      world.heightmap) {
    this.buttonElem.className += ' active';
  }
}

Welcome.prototype.startWorld = function() {
  requestAnimationFrame(function() {
    world.init();
    picker.init();
    text.init();
    dates.init();
    setTimeout(function() {
      requestAnimationFrame(function() {
        document.querySelector('#loader-scene').classList += 'hidden';
        document.querySelector('#header-controls').style.opacity = 1;
      })
    }, 1500)
  }.bind(this))
}

/**
* Make an XHR get request for data
*
* @param {str} url: the url of the data to fetch
* @param {func} onSuccess: onSuccess callback function
* @param {func} onErr: onError callback function
**/

function get(url, onSuccess, onErr) {
  onSuccess = onSuccess || function() {};
  onErr = onErr || function() {};
  var xhr = new XMLHttpRequest();
  xhr.overrideMimeType('text\/plain; charset=x-user-defined');
  xhr.onreadystatechange = function() {
    if (xhr.readyState == XMLHttpRequest.DONE) {
      if (xhr.status === 200) {
        var data = xhr.responseText;
        // unzip the data if necessary
        if (url.substring(url.length-3) == '.gz') {
          data = gunzip(data);
          url = url.substring(0, url.length-3);
        }
        // determine if data can be JSON parsed
        url.substring(url.length-5) == '.json'
          ? onSuccess(JSON.parse(data))
          : onSuccess(data);
      } else {
        onErr(xhr)
      }
    };
  };
  xhr.open('GET', url, true);
  xhr.send();
};

// extract content from gzipped bytes
function gunzip(data) {
  var bytes = [];
  for (var i=0; i<data.length; i++) {
    bytes.push(data.charCodeAt(i) & 0xff);
  }
  var gunzip = new Zlib.Gunzip(bytes);
  var plain = gunzip.decompress();
  // Create ascii string from byte sequence
  var asciistring = '';
  for (var i=0; i<plain.length; i++) {
    asciistring += String.fromCharCode(plain[i]);
  }
  return asciistring;
}

/**
* Download a file to user's downloads
**/

function downloadFile(data, filename) {
  var filenameParts = filename.split('.');
  var filetype = filenameParts[filenameParts.length-1]; // 'csv' || 'json'
  var blob = filetype == 'json'
    ? new Blob([JSON.stringify(data)], {type: 'octet/stream'})
    : new Blob([Papa.unparse(data)], {type: 'text/plain'});
  var a = document.createElement('a');
  document.body.appendChild(a);
  a.download = filename;
  a.href = window.URL.createObjectURL(blob);
  a.click();
  a.parentNode.removeChild(a);
}

function downloadBlob(blob, filename) {
  var a = document.createElement('a');
  document.body.appendChild(a);
  a.download = filename;
  a.href = window.URL.createObjectURL(blob);
  a.click();
  a.parentNode.removeChild(a);
}

// pass the dataUrl for image at location `src` to `callback`
function imageToDataUrl(src, callback, mimetype) {
  mimetype = mimetype || 'image/png';
  var img = new Image();
  img.crossOrigin = 'Anonymous';
  img.onload = function() {
    var canvas = document.createElement('CANVAS');
    var ctx = canvas.getContext('2d');
    canvas.height = this.naturalHeight;
    canvas.width = this.naturalWidth;
    ctx.drawImage(this, 0, 0);
    var dataUrl = canvas.toDataURL(mimetype);
    callback({src: src, dataUrl: dataUrl});
  };
  img.src = src;
  if (img.complete || img.complete === undefined) {
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    img.src = src;
  }
}

/**
* Find the smallest z value among all cells
**/

function getMinCellZ() {
  var min = Number.POSITIVE_INFINITY;
  for (var i=0; i<data.cells.length; i++) {
    min = Math.min(data.cells[i].z, min);
  }
  return min;
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
* Choose an element from an array
**/

function choose(arr) {
  return arr[ Math.floor(Math.random() * arr.length) ];
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
  var elem = document.querySelector('#pixplot-canvas');
  return {
    w: elem.clientWidth,
    h: elem.clientHeight,
  }
}

/**
* Filename and path helpers
**/

function getPath(path) {
  var base = window.location.origin;
  base += window.location.pathname.replace('index.html', '');
  base += path.replace('\\','/').replace('output/', '');
  return base;
}

function trimFilenameSuffix(filename) {
  var suffix = filename.split('.')[ filename.split('.').length - 1 ];
  var split = filename.split('-');
  return split.slice(0, split.length-1).join('-') + '.' + suffix;
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
* Geometry helpers
**/

// convert a flat object to a 1D array
function arrayify(obj) {
  var keys = Object.keys(obj);
  var l = [];
  for (var i=0; i<keys.length; i++) {
    l.push(obj[keys[i]]);
  }
  return l;
}

// compute the magnitude of a vector
function magnitude(vec) {
  var v = 0;
  if (Array.isArray(vec)) {
    for (var i=0; i<vec.length; i++) {
      v += vec[i]**2;
    }
    return v**(1/2);
  } else if (typeof vec == 'object') {
    return magnitude(arrayify(vec));
  } else {
    throw Error('magnitude requires an array or object')
  }
}

// compute the dot product of two vectors
function dotProduct(a, b) {
  if (typeof a == 'object' && !Array.isArray(a)) a = arrayify(a);
  if (typeof b == 'object' && !Array.isArray(b)) b = arrayify(b);
  if (a.length !== b.length) throw Error('dotProduct requires vecs of same length');
  var s = 0;
  for (var i=0; i<a.length; i++) s += a[i] * b[i];
  return s;
}

function rad2deg(radians) {
  return radians * (180/Math.PI);
}

// compute the theta between two points
function theta(a, b) {
  var num = dotProduct(a, b);
  var denom = magnitude(a) * magnitude(b);
  var radians = denom == 0
    ? 0
    : Math.acos(num/denom);
  return radians
    ? rad2deg(radians)
    : 0;
}

// get the geometric mean of `points`
function getCentroid(points) {
  if (!points) points = this.getHull();
  var center = {x: 0, y: 0};
  for (var i=0; i<points.length; i++) {
    center.x += points[i].x;
    center.y += points[i].y;
  }
  return {
    x: center.x / points.length,
    y: center.y / points.length,
  }
}

// find the cumulative length of the line up to each point
function getCumulativeLengths(points) {
  var lengths = [];
  var sum = 0;
  for (var i=0; i<points.length; i++) {
    if (i>0) sum += points[i].distanceTo(points[i - 1]);
    lengths[i] = sum;
  };
  return lengths;
}

// via https://github.com/substack/point-in-polygon
function pointInPolygon(point, polygon) {
  var x = point[0], y = point[1];
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var xi = polygon[i][0], yi = polygon[i][1];
    var xj = polygon[j][0], yj = polygon[j][1];
    var intersect = ((yi > y) != (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
* Coordinate conversions
**/

function getEventWorldCoords(e) {
  var rect = e.target.getBoundingClientRect(),
      dx = e.clientX - rect.left,
      dy = e.clientY - rect.top;
  return screenToWorldCoords({x: dx, y: dy});
}

function screenToWorldCoords(pos) {
  var vector = new THREE.Vector3(),
      camera = world.camera,
      mouse = new THREE.Vector2(),
      canvasSize = getCanvasSize(),
      // convert from screen to clip space
      x = (pos.x / canvasSize.w) * 2 - 1,
      y = -(pos.y / canvasSize.h) * 2 + 1;
  // project the screen location into world coords
  vector.set(x, y, 0.5);
  vector.unproject(camera);
  var direction = vector.sub(camera.position).normalize(),
      distance = - camera.position.z / direction.z,
      scaled = direction.multiplyScalar(distance),
      coords = camera.position.clone().add(scaled);
  return coords;
}

function worldToScreenCoords(pos) {
  var s = getCanvasSize(),
      w = s.w / 2,
      h = s.h / 2,
      vec = new THREE.Vector3(pos.x, pos.y, pos.z || 0),
      canvas = document.querySelector('#pixplot-canvas');
  vec.project(world.camera);
  vec.x =  (vec.x * w) + w;
  vec.y = -(vec.y * h) + h;
  // add offsets that account for the negative margins in the canvas position
  var rect = world.canvas.getBoundingClientRect();
  return {
    x: vec.x + rect.left,
    y: vec.y + rect.top
  };
}

/**
* Main
**/

window.location.href = '#';
window.devicePixelRatio = Math.min(window.devicePixelRatio, 2);
var welcome = new Welcome();
var webgl = new Webgl();
var config = new Config();
var filters = new Filters();
var picker = new Picker();
var modal = new Modal();
var keyboard = new Keyboard();
var lasso = new Lasso();
var layout = new Layout();
var world = new World();
var text = new Text();
var dates = new Dates();
var lines = new Lines();
var lod = new LOD();
var settings = new Settings();
var tooltip = new Tooltip();
var globe = new Globe();
var data = new Data();