/**
* Config
**/

function Config() {
  this.data = {
    url: 'output', // path to location where data lives
    spread: { // scale for positioning items on x,y axes
      x: 4000,
      y: 4000,
      z: 1,
    },
  };
  this.size = {
    cell: 32,
    lodCell: 128,
    atlas: 2048,
    texture: webgl.limits.textureSize,
    lodTexture: 4096,
  }
  this.lod = {
    minZ: 250,
    radius: 2,
    framesBetweenUpdates: 40,
    gridSpacing: 0.01,
  },
  this.layout = {
    preferences: ['grid', 'umap_2d', 'tsne_3d', 'tsne_2d'], // most to least preferable
  };
  this.transitions = {
    duration: 3.5, // in seconds
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
* Data
**/

function Data() {
  this.file = 'plot_data.json';
  this.atlasCount = null;
  this.positions = null;
  this.images = [];
  this.textures = [];
  this.cells = [];
  this.textureProgress = {};
  this.textureCount = null;
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

// Get an array of the position data to pass to the texture at idx `texIdx`
Data.prototype.getTextureCellIndices = function(texIdx) {
  var cellsPerTex = config.cellsPerAtlas * config.atlasesPerTex;
  return {
    start: cellsPerTex * texIdx,
    end: Math.min(cellsPerTex * (texIdx + 1), self.cellCount),
  }
}

// When a texture's progress updates, update the aggregate progress
Data.prototype.onTextureProgress = function(texIdx, progress) {
  this.textureProgress[texIdx] = progress / this.textures[texIdx].atlasCount;
  welcome.updateProgress();
}

// When a texture loads, draw plot if all have loaded
Data.prototype.onTextureLoad = function(texIdx) {
  this.loadedTextures += 1;
  welcome.updateProgress();
}

// Get the number of atlases to include in texture at index `idx`
Data.prototype.getAtlasCount = function(texIdx) {
  return this.atlasCount / config.atlasesPerTex > (texIdx + 1)
    ? config.atlasesPerTex
    : this.atlasCount % config.atlasesPerTex;
}

// Load json data with chart element positions
Data.prototype.load = function() {
  var self = this;
  get(config.data.url + '/' + self.file, function(json) {
    self.cellData = json.cells.data; // maps layout key to position array
    layout.setOptions(json.cells.layouts); // set available layouts
    self.cellCount = self.cellData.length;
    self.atlasCount = json.atlas_counts['32px'];
    self.textureCount = Math.ceil(self.atlasCount / config.atlasesPerTex);
    self.gridSideCells = Math.ceil(Math.pow(self.cellCount, 0.5));
    // load each texture for this data set
    for (var i=0; i<self.textureCount; i++) {
      self.textures.push(new Texture({
        idx: i,
        cellIndices: self.getTextureCellIndices.bind(self),
        onProgress: self.onTextureProgress.bind(self),
        onLoad: self.onTextureLoad.bind(self),
        atlasCount: self.getAtlasCount(i),
      }));
    };
  })
}

/**
* Texture
**/

function Texture(obj) {
  this.idx = obj.idx;
  this.cellIndices = obj.cellIndices;
  this.atlasProgress = {};
  this.atlases = [];
  this.atlasCount = obj.atlasCount;
  this.onProgress = obj.onProgress;
  this.onLoad = obj.onLoad;
  this.loadedAtlases = 0;
  this.canvas = null;
  this.ctx = null;
  this.offscreen = false;
  this.load();
}

Texture.prototype.setCanvas = function() {
  this.canvas = getElem('canvas', {
    width: config.size.texture,
    height: config.size.texture,
    id: 'texture-' + this.idx,
  })
  if ('OffscreenCanvas' in window) this.offscreen = true;
  this.ctx = this.canvas.getContext('2d');
}

Texture.prototype.load = function() {
  this.setCanvas();
  for (var i=0; i<this.atlasCount; i++) {
    this.atlases.push(new Atlas({
      idx: (config.atlasesPerTex * this.idx) + i,
      cellIndices: this.getAtlasCellIndices(i),
      size: config.size.atlas,
      texIdx: this.idx,
      onProgress: this.onAtlasProgress.bind(this),
      onLoad: this.onAtlasLoad.bind(this),
    }))
  }
}

// Set the indices of cells within data.cellData for the atlas at position `idx`
Texture.prototype.getAtlasCellIndices = function(atlasIdx) {
  return {
    start: config.cellsPerAtlas * atlasIdx,
    end: Math.min(config.cellsPerAtlas * (atlasIdx + 1), data.cellCount),
  }
}

// Log the load progress of each atlas file
Texture.prototype.onAtlasProgress = function(idx, progress) {
  this.atlasProgress[idx] = progress;
  var textureProgress = valueSum(this.atlasProgress);
  this.onProgress(this.idx, textureProgress);
}

// Add each cell from the loaded atlas to the texture's canvas
Texture.prototype.onAtlasLoad = function(atlas) {
  // Add the loaded atlas file the texture's canvas
  var atlasSize = config.size.atlas,
      textureSize = config.size.texture,
      idx = atlas.idx % config.atlasesPerTex;
  // Get x and y offsets of this atlas within the canvas texture
  var atlasX = (idx * atlasSize) % textureSize,
      atlasY = Math.floor((idx * atlasSize) / textureSize) * atlasSize;
  // draw the atlas on the canvas
  var dx = atlasX,
      dy = atlasY,
      dw = config.size.atlas,
      dh = config.size.atlas;
  this.ctx.drawImage(atlas.image, dx, dy, dw, dh);
  // If all atlases are loaded, build the texture
  if (++this.loadedAtlases == this.atlasCount) this.onLoad(this.idx);
}

/**
* Atlas
**/

function Atlas(obj) {
  this.texIdx = obj.texIdx;
  this.idx = obj.idx;
  this.idxInTex = obj.idx % config.atlasesPerTex;
  this.cellIndices = obj.cellIndices;
  this.size = obj.size;
  this.onLoad = obj.onLoad;
  this.onProgress = obj.onProgress;
  this.image = null;
  this.progress = 0;
  this.url = config.data.url + '/atlas_files/32px/atlas-' + this.idx + '.jpg';
  this.cells = [];
  this.posInTex = {
    x: (this.idxInTex % Math.pow(config.atlasesPerTex, 0.5)) * config.size.atlas,
    y: Math.floor(this.idxInTex / Math.pow(config.atlasesPerTex, 0.5)) * config.size.atlas,
  }
  this.setCells();
  this.load();
}

Atlas.prototype.load = function() {
  var self = this;
  self.image = new Image;
  self.image.onload = function() { self.onLoad(self); }
  var xhr = new XMLHttpRequest();
  xhr.onprogress = function(e) {
    var progress = parseInt((e.loaded / e.total) * 100);
    self.onProgress(self.idx, progress);
  };
  xhr.onload = function(e) {
    self.image.src = window.URL.createObjectURL(this.response);
  };
  xhr.open('GET', self.url, true);
  xhr.responseType = 'blob';
  xhr.send();
}

Atlas.prototype.setCells = function() {
  var self = this;
  // find the index position of the first cell among all cells
  for (var i=self.cellIndices.start; i<self.cellIndices.end; i++) {
    self.cells.push(new Cell({
      idx: i,
      atlasPosInTex: self.posInTex,
      texIdx: self.texIdx,
    }))
  }
}

/**
* Cell
**/

function Cell(obj) {
  var d = Object.assign([], data.cellData[obj.idx]);
  this.idx = obj.idx; // index among all cells
  this.atlasPosInTex = obj.atlasPosInTex;
  this.texIdx = obj.texIdx;
  this.name = d[0]; // name for image (for searching on page load)
  this.w = d[1];
  this.h = d[2];
  this.gridCoords = {}; // x, y pos of the cell in the lod grid (set by lod)
  this.idxInAtlas = this.idx % config.cellsPerAtlas; // index of cell in atlas
  this.idxInDrawCall = this.idx % config.cellsPerDrawCall; // index in draw call
  this.drawCallIdx = Math.floor(this.idx / config.cellsPerDrawCall); // draw call index
  this.posInAtlas = this.getPosInAtlas(); // position of cell in atlas
  this.layouts = this.getLayouts();
  this.default = this.getDefaultState();
  this.state = Object.assign({}, this.default);
  this.updateParentBoundingBox();
  data.cells[this.idx] = this; // augment window.data.cells
}

Cell.prototype.getPosInAtlas = function() {
  return {
    x: (this.idxInAtlas % Math.pow(config.cellsPerAtlas, 0.5)) * config.size.cell,
    y: Math.floor(this.idxInAtlas / Math.pow(config.cellsPerAtlas, 0.5)) * config.size.cell,
  }
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
        z: pos.length > 2 ? (pos[2] + Math.random()) * config.data.spread.z : this.idx % 50,
      }
    };
  }.bind(this))
  // compute grid position of cell
  var perSide = data.gridSideCells, // n cells per row/col of grid layout
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
    texIdx: this.texIdx,
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
  return {
    x: this.posInAtlas.x + this.atlasPosInTex.x,
    y: this.posInAtlas.y + this.atlasPosInTex.y,
  }
}

Cell.prototype.updateParentBoundingBox = function() {
  var self = this;
  ['x', 'y'].forEach(function(dim) {
    if (self.state.position[dim] > data.boundingBox[dim].max) {
      data.boundingBox[dim].max = self.state.position[dim];
    } else if (self.state.position[dim] < data.boundingBox[dim].min) {
      data.boundingBox[dim].min = self.state.position[dim];
    }
  })
}

/**
* Cell activation / deactivation
**/

// make the cell active in LOD by mutating its state
Cell.prototype.activate = function() {
  var self = this;
  self.state = Object.assign({}, self.state, {
    isLarge: true,
    texIdx: -1,
    posInTex: {
      x: lod.state.cellIdxToCoords[self.idx].x,
      y: lod.state.cellIdxToCoords[self.idx].y,
    },
    size: {
      w: config.size.lodCell,
      h: config.size.lodCell,
      topPad: self.state.size.topPad * lod.cellSizeScalar,
      leftPad: self.state.size.leftPad * lod.cellSizeScalar,
      inTexture: config.size.lodCell / config.size.lodTexture,
      fullCell: config.size.lodCell,
    },
  })
  // mutate the cell buffer attributes
  var attrs = ['textureIndex', 'textureOffset', 'size'];
  for (var i=0; i<attrs.length; i++) {
    self.mutateBuffer(attrs[i]);
  }
}

// deactivate the cell in LOD by mutating its state
Cell.prototype.deactivate = function() {
  var self = this;
  // pass in the current position and target in case they've changed
  var lastState = Object.assign({}, self.state);
  self.state = Object.assign({}, self.default, {
    position: lastState.position,
    target: lastState.target,
  });
  // mutate the cell buffer attributes
  var attrs = ['textureIndex', 'textureOffset', 'size'];
  for (var i=0; i<attrs.length; i++) {
    self.mutateBuffer(attrs[i]);
  }
}

Cell.prototype.mutateBuffer = function(attr) {
  var self = this;
  // find the buffer attributes that describe this cell to the GPU
  var group = world.scene.children[0],
      attrs = group.children[self.drawCallIdx].geometry.attributes;

  switch(attr) {
    case 'textureIndex':
      // set the texIdx to -1 to read from the uniforms.lodTexture
      attrs.textureIndex.array[self.idxInDrawCall] = self.state.texIdx;
      return;

    case 'textureOffset':
      // find cell's position in the LOD texture then set x, y tex offsets
      var x = self.state.posInTex.x / self.state.size.fullCell,
          y = self.state.posInTex.y / self.state.size.fullCell;
      // set the x then y texture offsets for this cell
      attrs.textureOffset.array[(self.idxInDrawCall * 2)] = x;
      attrs.textureOffset.array[(self.idxInDrawCall * 2) + 1] = y;
      return;

    case 'size':
      // set the updated lod cell size
      attrs.size.array[self.idxInDrawCall] = self.state.size.inTexture;
      return;

    case 'translation':
      // set the cell's translation
      attrs.translation.array[(self.idxInDrawCall * 3)] = self.state.position.x;
      attrs.translation.array[(self.idxInDrawCall * 3) + 1] = self.state.position.y;
      attrs.translation.array[(self.idxInDrawCall * 3) + 2] = self.state.position.z;
      return;

    case 'target':
      // set the cell's target translation
      attrs.target.array[(self.idxInDrawCall * 3)] = self.state.target.x;
      attrs.target.array[(self.idxInDrawCall * 3) + 1] = self.state.target.y;
      attrs.target.array[(self.idxInDrawCall * 3) + 2] = self.state.target.z;
      return;
  }
}

/**
* Create a controller for different layouts
**/

function Layout() {
  var self = this;
  self.elem = null;
  self.selected = null;
  self.options = [];
}

/**
* @param [str] options: an array of layout strings; each should
*   be an attribute in data.cells[ithCell].layouts
**/

Layout.prototype.setOptions = function(options) {
  this.options = Object.assign([], options).concat('grid'),
      preferences = config.layout.preferences;
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
  })
  // update the positional attribute and time uniform on the mesh
  attr.needsUpdate = true;
  obj.mesh.material.uniforms.transitionPercent = {
    type: 'f',
    value: 0,
  };
  world.state.transitioning = false;
  // reindex cells in LOD and clear LOD state
  lod.clear();
  lod.indexCells();
}

/**
* Create the Three.js scene
**/

function World() {
  var self = this;
  self.scene = null;
  self.camera = null;
  self.renderer = null;
  self.controls = null;
  self.stats = null;
  self.color = new THREE.Color();
  self.center = {};
  self.state = {
    flying: false,
    transitioning: false,
    displayed: false,
  }

  /**
  * Return a scene object with a background color
  **/

  self.getScene = function() {
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

  self.getCamera = function() {
    var windowSize = getCanvasSize();
    var aspectRatio = windowSize.w / windowSize.h;
    return new THREE.PerspectiveCamera(75, aspectRatio, 0.1, 100000);
  }

  /**
  * Generate the renderer to be used in the scene
  **/

  self.getRenderer = function() {
    var renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(window.devicePixelRatio); // support retina displays
    var windowSize = getCanvasSize(); // determine the size of the window
    renderer.setSize(windowSize.w, windowSize.h); // set the renderer size
    renderer.domElement.id = 'pixplot-canvas'; // give the canvas a unique id
    document.querySelector('#canvas-target').appendChild(renderer.domElement);
    return renderer;
  }

  /**
  * Generate the controls to be used in the scene
  * @param {obj} camera: the three.js camera for the scene
  * @param {obj} renderer: the three.js renderer for the scene
  **/

  self.getControls = function() {
    var controls = new THREE.TrackballControls(self.camera, self.renderer.domElement);
    controls.zoomSpeed = 0.4;
    controls.panSpeed = 0.4;
    return controls;
  }

  /**
  * Add event listeners, e.g. to resize canvas on window resize
  **/

  self.addEventListeners = function() {
    self.addResizeListener();
    self.addLostContextListener();
  }

  /**
  * Resize event listeners
  **/

  self.addResizeListener = function() {
    window.addEventListener('resize', function() {
      if (self.resizeTimeout) window.clearTimeout(self.resizeTimeout);
      self.resizeTimeout = window.setTimeout(self.handleResize, 300);
    }, false);
  }

  self.handleResize = function() {
    var windowSize = getCanvasSize();
    self.camera.aspect = windowSize.w / windowSize.h;
    self.camera.updateProjectionMatrix();
    self.renderer.setSize(windowSize.w, windowSize.h);
    selector.tex.setSize(windowSize.w, windowSize.h);
    self.controls.handleResize();
    self.setPointScalar();
    delete self.resizeTimeout;
  }

  // set the point size scalar as a uniform on all meshes
  self.setPointScalar = function() {
    // handle case of drag before scene renders
    if (!self.scene || !self.scene.children.length) return;
    var scalar = self.getPointScale();
    var meshes = self.scene.children[0].children;
    for (var i=0; i<meshes.length; i++) {
      meshes[i].material.uniforms.pointScale.value = scalar;
    }
  }

  /**
  * Lost context event listener
  **/

  // listen for loss of webgl context; to manually lose context:
  // world.renderer.context.getExtension('WEBGL_lose_context').loseContext();
  self.addLostContextListener = function() {
    var canvas = self.renderer.domElement;
    canvas.addEventListener('webglcontextlost', function(e) {
      e.preventDefault();
      window.location.reload();
    });
  }

  /**
  * Set the center point of the scene
  **/

  self.setCenter = function() {
    self.center = {
      x: (data.boundingBox.x.min + data.boundingBox.x.max) / 2,
      y: (data.boundingBox.y.min + data.boundingBox.y.max) / 2,
    }
  }

  /**
  * Focus the camera and controls on a particular region of space
  **/

  self.setControls = function(obj) {
    // position the camera in the plot's center
    self.camera.position.set(obj.x, obj.y, obj.z);
    self.camera.lookAt(obj.x, obj.y, 0);
    // position the controls in the plot's center - should be beyond cam.pos.z
    self.controls.target = new THREE.Vector3(obj.x, obj.y, 0);
  }

  /**
  * Draw each of the vertices
  **/

  self.plot = function() {
    var group = new THREE.Group();
    var cells = data.cells;
    var drawCalls = Math.ceil(data.cellCount / config.cellsPerDrawCall);
    for (var i=0; i<drawCalls; i++) {
      var start = i * config.cellsPerDrawCall;
      var end = (i+1) * config.cellsPerDrawCall;
      var groupCells = cells.slice(start, end);
      var attrs = self.getGroupAttributes(groupCells);
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
      var material = self.getShaderMaterial({
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
    self.scene.add(group);
  }

  // Return attribute data for the initial draw call of a mesh
  self.getGroupAttributes = function(cells) {
    var it = self.getCellIterators(cells.length);
    var texIndices = self.getTexIndices(cells);
    for (var i=0; i<cells.length; i++) {
      var cell = cells[i].state;
      var rgb = self.color.setHex(cells[i].idx + 1); // use 1-based ids for colors
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
      textures: self.getTextures({
        startIdx: texIndices.first,
        endIdx: texIndices.last,
      }),
      texStartIdx: texIndices.first,
      texEndIdx: texIndices.last
    }
  }

  // Get the iterators required to store attribute data for `n` cells
  self.getCellIterators = function(n) {
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
  self.getTexIndices = function(cells) {
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
  self.getTextures = function(obj) {
    var textures = [];
    for (var i=obj.startIdx; i<=obj.endIdx; i++) {
      var tex = self.getTexture(data.textures[i].canvas);
      textures.push(tex);
    }
    return textures;
  }

  // Transform a canvas object into a THREE texture
  self.getTexture = function(canvas) {
    var tex = new THREE.Texture(canvas);
    tex.needsUpdate = true;
    tex.flipY = false;
    return tex;
  }

  // Return an int specifying the scalar uniform for points
  self.getPointScale = function() {
    return window.devicePixelRatio * window.innerHeight * 24;
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

  self.getShaderMaterial = function(obj) {
    var vertex = find('#vertex-shader').textContent;
    var fragment = self.getFragmentShader(obj);
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
          value: self.getPointScale(),
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

  self.getFragmentShader = function(obj) {
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
      var tree = self.getFragLeaf(0, 'textures[0]', true);
      for (var i=firstTex; i<firstTex + textures.length-1; i++) {
        tree += ' else ' + self.getFragLeaf(i, 'textures[' + i + ']', true);
      }
      // add the conditional for the lod texture
      tree += ' else ' + self.getFragLeaf(i, 'lodTexture', false);
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

  self.getFragLeaf = function(texIdx, texture, includeIf) {
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

  self.attrsNeedUpdate = function(attrs) {
    self.scene.children[0].children.forEach(function(mesh) {
      attrs.forEach(function(attr) {
        mesh.geometry.attributes[attr].needsUpdate = true;
      })
    })
  }

  /**
  * Conditionally display render stats
  **/

  self.getStats = function() {
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

  self.flyTo = function(obj) {
    if (self.state.flying) return;
    self.state.flying = true;
    // get a new camera to reset .up and .quaternion on self.camera
    var camera = self.getCamera(),
        controls = new THREE.TrackballControls(camera);
    camera.position.set(obj.x, obj.y, obj.z);
    controls.target.set(obj.x, obj.y, obj.z);
    controls.update();
    // prepare scope globals to transition camera
    var time = 0,
        q0 = self.camera.quaternion.clone();
    TweenLite.to(self.camera.position, config.transitions.duration, {
      x: obj.x,
      y: obj.y,
      z: obj.z,
      onUpdate: function() {
        time++;
        var deg = time / (config.transitions.duration * 60); // scale time 0:1
        THREE.Quaternion.slerp(q0, camera.quaternion, self.camera.quaternion, deg);
      },
      onComplete: function() {
        var q = camera.quaternion,
            p = camera.position,
            u = camera.up,
            c = controls.target;
        self.camera.position.set(p.x, p.y, p.z);
        self.camera.up.set(u.x, u.y, u.z);
        self.camera.quaternion.set(q.x, q.y, q.z, q.w);
        self.controls.target = new THREE.Vector3(c.x, c.y, 0);
        self.controls.update();
        self.state.flying = false;
      },
      ease: obj.ease || Power4.easeInOut,
    });
  }

  /**
  * Get the initial camera location
  **/

  self.getInitialLocation = function() {
    return {
      x: self.center.x,
      y: self.center.y,
      z: 5000,
    }
  }

  /**
  * Initialize the render loop
  **/

  self.render = function() {
    requestAnimationFrame(self.render);
    self.renderer.render(self.scene, self.camera);
    self.controls.update();
    selector.select();
    if (self.stats) self.stats.update();
    lod.update();
  }

  /**
  * Initialize the plotting
  **/

  self.init = function() {
    self.setCenter();
    self.setControls(self.getInitialLocation());
    self.plot();
    self.render();
  }

  self.scene = self.getScene();
  self.camera = self.getCamera();
  self.renderer = self.getRenderer();
  self.controls = self.getControls();
  self.stats = self.getStats();
  self.addEventListeners();
}

/**
* Create mouse event handler using gpu picking
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
  var windowSize = getCanvasSize();
  var tex = new THREE.WebGLRenderTarget(windowSize.w, windowSize.h);
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

// called via self.onClick; shows the full-size selected image
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
  get(config.data.url + '/metadata/' + filename, function(data) {
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
    if (!data.src) data.src = config.data.url + '/originals/' + data.filename;
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
      mouse = new THREE.Vector2();
  mouse.x = (this.mouse.x / window.innerWidth) * 2 - 1;
  mouse.y = (this.mouse.y /  window.innerHeight) * 2 + 1;
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
// nb: don't mutate loadQueue, as that deletes items from self.grid.coords
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
    image.src = config.data.url + '/thumbs/128px/' + data.cells[cellIdx].name;
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
    setTimeout(function() {
      document.querySelector('#loader-scene').classList += 'hidden';
      world.state.displayed = true;
    }, 50);
  })
}

/**
* Configure filters
**/

function Filters() {
  var self = this;
  self.filters = [];
  self.loadFilters();
}

Filters.prototype.loadFilters = function() {
  var self = this;
  var url = config.data.url + '/filters/filters.json';
  get(url, function(data) {
    for (var i=0; i<data.length; i++) {
      var filter = new Filter(data[i]);
      self.filters.push(filter);
    }
  })
}

function Filter(obj) {
  var self = this;
  self.values = obj.filter_values || [];
  self.name = obj.filter_name || '';
  if (self.values.length > 1) self.createSelect();
}

Filter.prototype.createSelect = function() {
  var self = this,
      select = document.createElement('select'),
      option = document.createElement('option');
  option.textContent = 'All Values';
  select.appendChild(option);

  for (var i=0; i<self.values.length; i++) {
    var option = document.createElement('option');
    option.textContent = self.values[i];
    select.appendChild(option);
  }
  select.onchange = self.onChange.bind(self);
  find('#filters').appendChild(select);
}

Filter.prototype.onChange = function(e) {
  var self = this,
      val = e.target.value;
  // case where user selected the 'All Values' option
  if (val === 'All Values') {
    self.filterCells( data.cells.reduce(function(arr, cell) {
      arr.push(cell.name); return arr;
    }, []) )
  // case where user selected a specific option
  } else {
    // each {{ level-name }}.json file should use hyphens instead of whitespace
    var filename = val.replace(/\//g, '-').replace(/ /g, '-') + '.json',
        url = config.data.url + '/filters/option_values/' + filename;
    get(url, self.filterCells);
  }
}

// mutate the opacity of each cell to activate / deactivate
Filter.prototype.filterCells = function(names) {
  names = names.reduce(function(obj, n) {
    obj[n] = true; return obj;
  }, {}); // facilitate O(1) lookups

  data.cells.forEach(function(cell, idx) {
    var opacity = cell.name in names ? 1 : 0.1;
    // find the buffer attributes that describe this cell to the GPU
    var group = world.scene.children[0],
        attrs = group.children[cell.drawCallIdx].geometry.attributes;
    attrs.opacity.array[cell.idxInDrawCall] = opacity;
  })

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
  get(config.data.url + '/centroids.json', function(json) {
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
    textureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),
    textureCount: this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS),
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
