/**
* Config
**/

function Config() {
  var self = this;
  self.dataUrl = 'output/'; // path to location where data lives
  self.thumbsUrl = self.dataUrl + 'thumbs/128px/'
  self.spread = {
    x: 1,
    y: 1,
    z: 1,
  }; // scale for positioning items on x,y axes
  self.cellSize = 32;
  self.lodCellSize = 128;
  self.atlasSize = 2048;
  self.textureSize = webgl.limits.textureSize;
  self.lodTextureSize = 2048;
  self.atlasesPerTex = Math.pow((self.textureSize / self.atlasSize), 2);
  self.atlasesPerTexSide = Math.pow(self.atlasesPerTex, 0.5);
  self.cellsPerAtlas = Math.pow((self.atlasSize / self.cellSize), 2);
  self.cellsPerAtlasSide = Math.pow(self.cellsPerAtlas, 0.5);
  self.cellsPerTex = self.cellsPerAtlas * self.atlasesPerTex;
  self.cellsPerDrawCall = null;

  self.getCellsPerDrawCall = function() {
    // case where vertices per draw call is limiting factor
    var vertexLimited = webgl.limits.indexedElements;
    // case where textures are limiting factor (-1 to fit high res tex in calls)
    var textureLimited = (webgl.limits.textureCount - 1) * self.cellsPerTex;
    return Math.min(vertexLimited, textureLimited);
  }

  self.cellsPerDrawCall = self.getCellsPerDrawCall();
}

/**
* Data
**/

function Data() {
  var self = this;
  self.root = config.dataUrl;
  self.file = 'plot_data.json';
  self.atlasCount = null;
  self.centroids = null;
  self.positions = null;
  self.images = [];
  self.atlases = [];
  self.textures = [];
  self.cells = [];
  self.textureProgress = {};
  self.textureCount = null;
  self.loadedTextures = 0;

  // Load the initial JSON data with cell information
  self.load = function() {
    get(self.root + self.file, function(data) {
      var json = JSON.parse(data);
      self.centroids = json.centroids;
      self.positions = json.positions;
      self.atlasCount = json.atlas_counts['32px'];
      self.textureCount = Math.ceil(self.atlasCount / config.atlasesPerTex);
      // load each texture for this data set
      for (var i=0; i<self.textureCount; i++) {
        self.textures.push(new Texture({
          data: self,
          idx: i,
          positions: self.getTexturePositions(i),
          onProgress: self.onTextureProgress,
          onLoad: self.onTextureLoad,
          atlasCount: self.getAtlasCount(i),
        }))
      }
    })
  }

  // Get an array of the position data to pass to the texture at idx `idx`
  self.getTexturePositions = function(texIdx) {
    var chunk = config.cellsPerAtlas * config.atlasesPerTex;
    var start = chunk * texIdx;
    var end = chunk * (texIdx + 1);
    return self.positions.slice(start, end);
  }

  // When a texture's progress updates, update the aggregate progress
  self.onTextureProgress = function(texIdx, progress) {
    self.textureProgress[texIdx] = progress;
    var progressSum = valueSum(self.textureProgress);
    var completeSum = self.textureCount * 100 * config.atlasesPerTex;
  }

  // When a texture loads, draw plot if all have loaded
  self.onTextureLoad = function(texIdx) {
    self.loadedTextures += 1;
    if (self.loadedTextures == self.textureCount) {
      world.plot();
    }
  }

  // Get the number of atlases to include in texture at index `idx`
  self.getAtlasCount = function(texIdx) {
    return self.atlasCount / config.atlasesPerTex > (texIdx + 1)
      ? config.atlasesPerTex
      : self.atlasCount % config.atlasesPerTex;
  }

  // main
  self.load();
}

/**
* Texture
**/

function Texture(obj) {
  var self = this;
  self.idx = obj.idx;
  self.atlasProgress = {};
  self.atlases = [];
  self.atlasCount = obj.atlasCount;
  self.positions = obj.positions;
  self.onProgress = obj.onProgress;
  self.onLoad = obj.onLoad;
  self.loadedAtlases = 0;
  self.canvas = null;
  self.ctx = null;

  self.setCanvas = function() {
    self.canvas = getElem('canvas', {
      width: config.textureSize,
      height: config.textureSize,
      id: 'texture-' + self.idx,
    })
    self.ctx = self.canvas.getContext('2d');
  }

  self.load = function() {
    self.setCanvas();
    for (var i=0; i<self.atlasCount; i++) {
      self.atlases.push(new Atlas({
        data: obj.data,
        idx: (config.atlasesPerTex * self.idx) + i,
        positions: self.getAtlasPositions(i),
        size: config.atlasSize,
        texIdx: self.idx,
        onProgress: self.onAtlasProgress,
        onLoad: self.onAtlasLoad,
      }))
    }
  }

  // Get an array of the position data for the atlas at position `idx`
  self.getAtlasPositions = function(atlasIdx) {
    var start = config.cellsPerAtlas * atlasIdx;
    var end = config.cellsPerAtlas * (atlasIdx + 1);
    return self.positions.slice(start, end);
  }

  // Log the load progress of each atlas file
  self.onAtlasProgress = function(idx, progress) {
    self.atlasProgress[idx] = progress;
    var textureProgress = valueSum(self.atlasProgress);
    self.onProgress(self.idx, textureProgress);
  }

  // When an atlas loads, check to see if we can build a texture
  self.onAtlasLoad = function(atlas) {
    // Add the loaded atlas file the texture's canvas
    var texSize = config.textureSize;
    var idx = atlas.idx % config.atlasesPerTex;
    var x = (idx * config.atlasSize) % texSize;
    var y = Math.floor((idx * config.atlasSize) / texSize) * config.atlasSize;
    self.ctx.drawImage(atlas.image, x, y, config.atlasSize, config.atlasSize);
    self.loadedAtlases += 1;
    if (self.loadedAtlases == self.atlasCount) {
      self.onLoad(self.idx);
    }
  }

  self.load();
}

/**
* Atlas
**/

function Atlas(obj) {
  var self = this;
  self.texIdx = obj.texIdx;
  self.idx = obj.idx;
  self.idxInTex = obj.idx % config.atlasesPerTex;
  self.size = obj.size;
  self.onLoad = obj.onLoad;
  self.onProgress = obj.onProgress;
  self.positions = obj.positions;
  self.image = null;
  self.progress = 0;
  self.url = config.dataUrl + 'atlas_files/32px/atlas-' + self.idx + '.jpg';
  self.cells = [];
  self.posInTex = {
    x: (self.idxInTex % config.atlasesPerTexSide) * config.atlasSize,
    y: Math.floor(self.idxInTex / config.atlasesPerTexSide) * config.atlasSize,
  }

  self.load = function() {
    self.image = new Image;
    self.image.onload = function(url) { self.onLoad(self); }
    var xhr = new XMLHttpRequest();
    xhr.onprogress = function(e) {
      var progress = parseInt((e.loaded / e.total) * 100);
      self.onProgress(self.idx, progress);
    };
    xhr.onload = function(e) { self.image.src = self.url; };
    xhr.open('GET', self.url, true);
    xhr.responseType = 'arraybuffer';
    xhr.send();
  }

  self.setCells = function() {
    // find the index position of the first cell among all cells
    var start = (self.texIdx * config.cellsPerTex) +
                (self.idx * config.cellsPerAtlas);
    for (var i=0; i<self.positions.length; i++) {
      var cellData = self.positions[i];
      self.cells.push(new Cell({
        data: obj.data,
        idx: start + i,
        name: cellData[0],
        x: cellData[1] * config.spread.x,
        y: cellData[2] * config.spread.y,
        w: cellData[3],
        h: cellData[4],
        atlasPosInTex: self.posInTex,
        texIdx: self.texIdx,
      }))
    }
  }

  self.setCells();
  self.load();
}

/**
* Cell
**/

function Cell(obj) {
  var self = this;
  self.idx = obj.idx;   // constant index among all cells
  self.name = obj.name; // constant name for image (for searching on page load)
  self.posInAtlas = {}; // constant position of cell in atlas
  self.idxInAtlas = self.idx % config.cellsPerAtlas; // constant index of cell in atlas
  self.default = {
    position: {}, // position of cell in the plot
    size: {},     // size of the cell in its atlas
    posInTex: {}, // position of the cell in its texture
    texIdx: null, // texture index to use when drawing cell
    isLarge: false, // set to true when high-res image is loaded
  }
  self.state = {
    position: null,
    size: null,
    posInTex: null,
    texIdx: null,
    isLarge: null,
  }

  self.getPosition = function() {
    return {
      x: obj.x,
      y: obj.y,
      z: 1,
    }
  }

  self.getSize = function() {
    return {
      w: obj.w,
      h: obj.h,
      topPad: (config.cellSize - obj.w) / 2,
      leftPad: (config.cellSize - obj.h) / 2,
      fullCell: config.cellSize,
      inTexture: config.cellSize / config.textureSize,
    }
  }

  self.getPosInAtlas = function() {
    var perSide = config.cellsPerAtlasSide;
    return {
      x: (self.idxInAtlas % perSide) * config.cellSize,
      y: Math.floor(self.idxInAtlas / perSide) * config.cellSize,
    }
  }

  self.getPosInTex = function() {
    return {
      x: self.posInAtlas.x + obj.atlasPosInTex.x,
      y: self.posInAtlas.y + obj.atlasPosInTex.y,
    }
  }

  self.getGridCoords = function() {
    return {
      x: Math.floor(self.state.position.x / lod.grid.size.x),
      y: Math.floor(self.state.position.y / lod.grid.size.y),
    }
  }

  self.indexInLOD = function() {
    var gridCoords = self.getGridCoords(self);
    var gridX = gridCoords.x;
    var gridY = gridCoords.y;
    lod.grid.coords[gridX] = lod.grid.coords[gridX]
      ? lod.grid.coords[gridX]
      : {};
    lod.grid.coords[gridX][gridY] = lod.grid.coords[gridX][gridY]
      ? lod.grid.coords[gridX][gridY]
      : [];
    lod.grid.coords[gridX][gridY].push(self.idx);
    obj.data.cells[self.idx] = self; // add this cell to window.data.cells
  }

  self.posInAtlas = self.getPosInAtlas();
  self.default = {
    position: self.getPosition(),
    size: self.getSize(),
    texIdx: obj.texIdx,
    posInTex: self.getPosInTex(),
    isLarge: false,
  }
  self.state = Object.assign({}, self.default);
  self.indexInLOD();
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
  self.raycaster = new THREE.Raycaster();
  self.mouse = new THREE.Vector2();
  self.lastMouse = new THREE.Vector2();

  /**
  * Return a scene object with a background color
  **/

  self.getScene = function() {
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x777777);
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
    var windowSize = self.getWindowSize();
    var aspectRatio = windowSize.w / windowSize.h;
    var camera = new THREE.PerspectiveCamera(75, aspectRatio, 0.1, 100000);
    camera.position.set(0, 1, -6000);
    return camera;
  }

  /**
  * Generate the renderer to be used in the scene
  **/

  self.getRenderer = function() {
    var renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(window.devicePixelRatio); // support retina displays
    var windowSize = self.getWindowSize();
    renderer.setSize(windowSize.w, windowSize.h); // set the renderer size
    document.body.appendChild(renderer.domElement); // appends canvas to DOM
    return renderer;
  }

  /**
  * Get the H,W to use for rendering
  **/

  self.getWindowSize = function() {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
    }
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
  }

  self.addResizeListener = function() {
    window.addEventListener('resize', function() {
      var windowSize = self.getWindowSize();
      self.camera.aspect = windowSize.w / windowSize.h;
      self.camera.updateProjectionMatrix();
      self.renderer.setSize(windowSize.w, windowSize.h);
      self.controls.handleResize();
    });
  }

  /**
  * Draw each of the vertices
  **/

  self.plot = function() {
    var group = new THREE.Group();
    var cells = self.getCells();
    var drawCalls = Math.ceil(data.positions.length / config.cellsPerDrawCall);
    for (var i=0; i<drawCalls; i++) {
      var start = i * config.cellsPerDrawCall;
      var end = (i+1) * config.cellsPerDrawCall;
      var groupCells = cells.slice(start, end);
      var attrs = self.getGroupAttributes(groupCells);
      var geometry = new THREE.InstancedBufferGeometry();
      self.setFragmentShader(attrs.texStartIdx, attrs.textures.length);
      geometry.addAttribute('uv', attrs.uv);
      geometry.addAttribute('position', attrs.position);
      geometry.addAttribute('size', attrs.size);
      geometry.addAttribute('textureIndex', attrs.textureIndex);
      geometry.addAttribute('textureOffset', attrs.textureOffset);
      geometry.addAttribute('translation', attrs.translation);
      var material = self.getShaderMaterial(attrs.textures);
      var mesh = new THREE.Points(geometry, material);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    self.scene.add(group);
    self.render();
  }

  // Get all cells for plot as an array of items
  self.getCells = function() {
    return data.cells;
  }

  // Return attribute data for the initial draw call of a mesh
  self.getGroupAttributes = function(cells) {
    var it = self.getCellIterators(cells.length);
    var texIndices = self.getTexIndices(cells);
    for (var i=0; i<cells.length; i++) {
      var cell = cells[i].state;
      it.texIndices[it.texIndexIterator++] = cell.texIdx;
      it.sizes[it.sizesIterator++] = cell.size.inTexture;
      it.texOffsets[it.texOffsetIterator++] = cell.posInTex.x / cell.size.fullCell;
      it.texOffsets[it.texOffsetIterator++] = cell.posInTex.y / cell.size.fullCell;
      it.translations[it.translationIterator++] = cell.position.x;
      it.translations[it.translationIterator++] = cell.position.y;
      it.translations[it.translationIterator++] = cell.position.z;
    }
    // format the arrays into THREE attributes
    var BA = THREE.BufferAttribute;
    var IBA = THREE.InstancedBufferAttribute;
    var uvAttr = new BA(new Float32Array([0, 0]), 2);
    var positionAttr = new BA(new Float32Array([0, 0, 0]), 3);
    var sizeAttr = new IBA(it.sizes, 1, 1);
    var texIndexAttr = new IBA(it.texIndices, 1, 1);
    var texOffsetAttr = new IBA(it.texOffsets, 2, 1);
    var translationAttr = new IBA(it.translations, 3, 1);
    uvAttr.dynamic = true;
    positionAttr.dynamic = true;
    sizeAttr.dynamic = true;
    texIndexAttr.dynamic = true;
    texOffsetAttr.dynamic = true;
    translationAttr.dynamic = true;
    return {
      uv: uvAttr,
      size: sizeAttr,
      position: positionAttr,
      textureIndex: texIndexAttr,
      textureOffset: texOffsetAttr,
      translation: translationAttr,
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
      texOffsets: new Float32Array(n * 2),
      translations: new Float32Array(n * 3),
      sizesIterator: 0,
      texIndexIterator: 0,
      texOffsetIterator: 0,
      translationIterator: 0,
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

  /**
  * Build a RawShaderMaterial. For a list of all types, see:
  *   https://github.com/mrdoob/three.js/wiki/Uniforms-types
  **/

  self.getShaderMaterial = function(textures) {
    return new THREE.RawShaderMaterial({
      uniforms: {
        // array of sampler2D values
        textures: {
          type: 'tv',
          value: textures,
        },
        lodTexture: {
          type: 't',
          value: lod.tex.texture,
        }
      },
      vertexShader: find('#vertex-shader').textContent,
      fragmentShader: find('#fragment-shader').textContent,
    });
  }

  /**
  * Set the interior content of the fragment shader
  **/

  self.setFragmentShader = function(startTexIdx, textureCount) {
    // get the texture lookup tree
    var tree = self.getFragShaderTex(0, 'textures[0]', true);
    for (var i=startTexIdx; i<startTexIdx + textureCount-1; i++) {
      tree += ' else ' + self.getFragShaderTex(i, 'textures[' + i + ']', true);
    }
    // add the conditional for the lod texture
    tree += ' else ' + self.getFragShaderTex(i, 'lodTexture', false);
    // replace the text in the fragment shader
    var fragShader = find('#fragment-shader').textContent;
    fragShader = fragShader.replace('N_TEXTURES', textureCount);
    fragShader = fragShader.replace('TEXTURE_LOOKUP_TREE', tree);
    window.fragShader = fragShader;
    find('#fragment-shader').textContent = fragShader;
  }

  /**
  * Get the leaf component of a texture lookup tree
  **/

  self.getFragShaderTex = function(texIdx, texture, includeIf) {
    var ws = '        '; // whitespace (purely aesthetic)
    var start = includeIf
      ? 'if (textureIndex == ' + texIdx + ') {\n'
      : '{\n';
    return start +
      ws + 'vec4 color = texture2D(' + texture + ', scaledUv);\n' +
      ws + 'if (color.a < 0.5) { discard; }\n' +
      ws + 'gl_FragColor = color;\n ' +
      ws.substring(3) + '}'
  }

  /**
  * Conditionally display render stats
  **/

  self.getStats = function() {
    if (!window.location.href.includes('stats=true')) return null;
    var stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '65px';
    stats.domElement.style.right = '5px';
    stats.domElement.style.left = 'initial';
    document.body.appendChild(stats.domElement);
    return stats;
  }

  /**
  * Initialize the render loop
  **/

  self.render = function() {
    requestAnimationFrame(self.render);
    self.raycaster.setFromCamera(self.mouse, self.camera);
    self.renderer.render(self.scene, self.camera);
    self.controls.update();
    if (self.stats) self.stats.update();
    TWEEN.update();
    lod.update();
  }

  self.scene = self.getScene();
  self.camera = self.getCamera();
  self.renderer = self.getRenderer();
  self.controls = self.getControls();
  self.stats = self.getStats();
  self.addEventListeners();
}

/**
* Assess WebGL parameters
**/

function Webgl() {
  var self = this;
  self.gl = null;
  self.limits = null;

  /**
  * Get a WebGL context, or display an error if WebGL is not available
  **/

  self.setGl = function() {
    self.gl = getElem('canvas').getContext('webgl');
    if (!self.gl) find('#webgl-not-available').style.display = 'block';
  }

  /**
  * Get the limits of the user's WebGL context
  **/

  self.setLimits = function() {
    // fetch all browser extensions as a map for O(1) lookups
    var extensions = self.gl.getSupportedExtensions().reduce(function(obj, i) {
      obj[i] = true; return obj;
    }, {})
    // assess support for 32-bit indices in gl.drawElements calls
    var maxIndex = 2**16 - 1;
    ['', 'MOZ_', 'WEBKIT_'].forEach(function(ext) {
      if (extensions[ext + 'OES_element_index_uint']) maxIndex = 2**32 - 1;
    })
    self.limits = {
      textureSize: self.gl.getParameter(self.gl.MAX_TEXTURE_SIZE),
      textureCount: self.gl.getParameter(self.gl.MAX_TEXTURE_IMAGE_UNITS),
      vShaderTextures: self.gl.getParameter(self.gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      indexedElements: maxIndex,
    }
  }

  self.setGl();
  self.setLimits();
}

/**
* Create a level-of-detail texture mechanism
**/

function LOD() {
  var self = this;
  self.gridPos = {x: null, y: null};
  self.cellIdxToImage = {};
  self.maxRadius = 5; // max radius for neighboring block search
  self.cellSizeScalar = config.lodCellSize / config.cellSize;
  self.framesBetweenUpdates = 60; // frames that elapse between texture updates
  self.tex = {
    canvas: null,
    ctx: null,
    texture: null,
  };
  self.state = {
    loadQueue: [],
    neighborsRequested: false,
    openCoords: [],
    gridPosToCoords: {},
    cellIdxToCoords: {},
    cellsToActivate: [],
    frame: 0,
  };
  self.grid = {
    coords: {}, // set by data constructor
    size: {
      x: config.spread.x * 30,
      y: config.spread.y * 30,
    },
  };

  // set the canvas on which loaded images will be drawn
  self.setCanvas = function() {
    self.tex.canvas = getElem('canvas', {
      width: config.lodTextureSize,
      height: config.lodTextureSize,
      id: 'lod-canvas',
    })
    self.tex.ctx = self.tex.canvas.getContext('2d');
    self.tex.texture = world.getTexture(self.tex.canvas);
  }

  // initialize the array of tex coordinates available for writing
  self.setOpenTexCoords = function() {
    var perDimension = config.lodTextureSize / config.lodCellSize;
    var openCoords = [];
    for (var x=0; x<perDimension; x++) {
      for (var y=0; y<perDimension; y++) {
        openCoords.push({
          x: x * config.lodCellSize,
          y: y * config.lodCellSize,
        });
      }
    }
    self.state.openCoords = openCoords;
  }

  // load high-res images nearest the camera; called every frame by world.render
  self.update = function() {
    self.updateGridPosition();
    self.loadNextImage();
    self.tick();
  }

  self.updateGridPosition = function() {
    // determine the user's current grid position
    var gridPos = {
      x: Math.floor(world.camera.position.x / self.grid.size.x),
      y: Math.floor(world.camera.position.y / self.grid.size.y),
    }
    // user is in a new grid position; unload old images and load new
    if (gridPos.x !== self.gridPos.x || gridPos.y !== self.gridPos.y) {
      self.gridPos = gridPos;
      self.state.neighborsRequested = false;
      self.unloadGridNeighbors();
      var pos = [self.gridPos.x, self.gridPos.y];
      self.state.loadQueue = getNested(self.grid.coords, pos, []);
    }
  }

  // if there's a loadQueue, load the next image, else load neighbors
  self.loadNextImage = function() {
    var cellIdx = self.state.loadQueue.shift();
    if (!Number.isInteger(cellIdx)) {
      if (!self.state.neighborsRequested) self.loadGridNeighbors();
      return;
    }
    self.loadImage(cellIdx);
  }

  // update the frame number and conditionally activate loaded images
  self.tick = function() {
    self.state.frame += 1;
    if (self.state.frame % self.framesBetweenUpdates == 0 &&
        world.camera.position.z > -450 &&
        self.state.cellsToActivate.length) {
      var toActivate = self.state.cellsToActivate;
      self.state.cellsToActivate = [];
      self.activateCells(toActivate);
    }
  }

  // load a high-res image for cell at index `cellIdx`
  self.loadImage = function(cellIdx) {
    if (self.cellIdxToImage[cellIdx]) {
      self.preactivateImage(cellIdx);
    } else {
      var image = new Image;
      image.onload = function(cellIdx) {
        self.cellIdxToImage[cellIdx] = image;
        self.preactivateImage(cellIdx);
      }.bind(null, cellIdx)
      image.src = config.thumbsUrl + data.cells[cellIdx].name + '.jpg';
    }
  }

  // add an image to the list of images ready to be activated
  self.preactivateImage = function(cellIdx) {
    self.state.cellsToActivate = self.state.cellsToActivate.concat(cellIdx);
  }

  // activate all cells within a list of cell indices
  self.activateCells = function(cellIndices) {
    // find and store the coords where each img will be stored in lod texture
    cellIndices.forEach(function(cellIdx) {
      var coords = self.state.openCoords.shift();
      if (!coords) { console.warn('TODO: lod texture full'); return; }
      coords.cellIdx = cellIdx;
      // parse out the cell's grid coordinates and
      var cell = data.cells[cellIdx];
      var gridCoords = cell.getGridCoords();
      var gridKey = gridCoords.x + '.' + gridCoords.y;
      var gridStore = self.state.gridPosToCoords;
      gridStore[gridKey] = gridStore[gridKey] ? gridStore[gridKey] : [];
      gridStore[gridKey].push(coords);
      self.state.cellIdxToCoords[cellIdx] = coords;
      // draw the cell's image in the lod texture
      self.tex.ctx.drawImage(self.cellIdxToImage[cellIdx],
        0, 0, config.lodCellSize, config.lodCellSize,
        coords.x, coords.y, config.lodCellSize, config.lodCellSize);
      // mutate the individual cell's attribute buffers
      self.activateCell(cell);
    })
    // invalidate the lod texture and the geometry's mutated attribute buffers
    self.tex.texture.needsUpdate = true;
    var attrs = world.scene.children[0].children[0].geometry.attributes;
    attrs.textureOffset.needsUpdate = true;
    attrs.textureIndex.needsUpdate = true;
    attrs.size.needsUpdate = true;
  }

  // mutate the cell's state and attribute buffers to load lod detail
  self.activateCell = function(cell) {
    cell.state = Object.assign({}, cell.state, {
      isLarge: true,
      texIdx: -1,
      posInTex: {
        x: self.state.cellIdxToCoords[cell.idx].x,
        y: self.state.cellIdxToCoords[cell.idx].y,
      },
      size: {
        w: config.lodCellSize,
        h: config.lodCellSize,
        topPad: cell.state.size.topPad * self.cellSizeScalar,
        leftPad: cell.state.size.leftPad * self.cellSizeScalar,
        inTexture: config.lodCellSize / config.lodTextureSize,
        fullCell: config.lodCellSize,
      },
    })
    self.mutateCellBuffers(cell);
  }

  // use a cell's state to mutate its attribute buffers
  self.mutateCellBuffers = function(cell) {
    var attrs = world.scene.children[0].children[0].geometry.attributes;
    var posInTex = {
      x: cell.state.posInTex.x / cell.state.size.fullCell,
      y: cell.state.posInTex.y / cell.state.size.fullCell,
    }
    // set the texIdx to -1 so we read from the uniforms.lodTexture
    attrs.textureIndex.array[cell.idx] = cell.state.texIdx;
    // set the x then y texture offsets for this cell
    attrs.textureOffset.array[(cell.idx * 2)] = posInTex.x;
    attrs.textureOffset.array[(cell.idx * 2) + 1] = posInTex.y;
    // set the updated lod cell size
    attrs.size.array[cell.idx] = cell.state.size.inTexture;
  }

  // restore a cell's buffer attributes to the default attributes
  self.deactivateCell = function(cell) {
    cell.state = Object.assign({}, cell.state, cell.default);
    self.mutateCellBuffers(cell);
  }

  // load the next nearest grid of cell images
  self.loadGridNeighbors = function() {
    self.state.neighborsRequested = true;
    for (var x=-self.maxRadius*2; x<=self.maxRadius*2; x++) {
      for (var y=-self.maxRadius; y<=self.maxRadius; y++) {
        if (!(x==0 && y==0)) {
          var blockToLoad = Object.assign({}, self.gridPos);
          blockToLoad.x += x;
          blockToLoad.y += y;
          var coords = [blockToLoad.x, blockToLoad.y];
          var cellIndicesToLoad = getNested(self.grid.coords, coords, []);
          if (cellIndicesToLoad) {
            self.state.loadQueue = self.state.loadQueue.concat(cellIndicesToLoad);
          }
        }
      }
    }
  }

  // free up the grid positions of images now distant from the camera
  self.unloadGridNeighbors = function() {
    Object.keys(self.state.gridPosToCoords).forEach(function(pos) {
      var split = pos.split('.'),
          x = parseInt(split[0]),
          y = parseInt(split[1]),
          xDelta = Math.abs(self.gridPos.x - x),
          yDelta = Math.abs(self.gridPos.y - y);
      if ((xDelta + yDelta)/2 > self.maxRadius) {
        // cache the texture coords for the grid key to be deleted
        var toUnload = self.state.gridPosToCoords[pos];
        // free all cells previously assigned to the deleted grid position
        self.state.openCoords = self.state.openCoords.concat(toUnload);
        // delete unloaded cell keys in the cellIdxToCoords map
        toUnload.forEach(function(coords) {
          delete self.state.cellIdxToCoords[coords.cellIdx];
          self.deactivateCell(data.cells[coords.cellIdx]);
        })
        // remove the old grid position from the list of active grid positions
        delete self.state.gridPosToCoords[pos];
      }
    });
  }

  self.setCanvas();
  self.setOpenTexCoords();
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
        ? handleSuccess(xmlhttp.responseText)
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
* Main
**/

var webgl = new Webgl();
var config = new Config();
var world = new World();
var lod = new LOD();
var data = new Data();