/**
* Config
**/

function Config() {
  var self = this;
  self.dataUrl = 'output/'; // path to location where data lives
  self.spread = {
    x: 1,
    y: 1,
    z: 1,
  }; // scale for positioning items on x,y axes
  self.cellSize = 32;
  self.atlasSize = 2048;
  self.atlasesPerTex = Math.pow((webgl.limits.textureSize / self.atlasSize), 2);
  self.cellsPerAtlas = Math.pow((self.atlasSize / self.cellSize), 2);
  self.cellsPerAtlasSide = Math.pow(self.cellsPerAtlas, 0.5);
}

/**
* Data
**/

function Data() {
  var self = this;
  self.root = config.dataUrl;
  self.file = 'plot_data.json';
  self.atlasCounts = null;
  self.centroids = null;
  self.positions = null;
  self.images = [];
  self.atlases = [];
  self.textures = [];
  self.textureProgress = {};

  /**
  * Make an XHR get request for data
  *
  * @param {str} url: the url of the data to fetch
  * @param {func} handleSuccess: onSuccess callback function
  * @param {func} handleErr: onError callback function
  **/

  self.get = function(url, handleSuccess, handleErr) {
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

  self.load = function() {
    self.get(self.root + self.file, function(data) {
      var json = JSON.parse(data);
      self.centroids = json.centroids;
      self.positions = json.positions;
      self.atlasCounts = json.atlas_counts;
      self.nTextures = self.atlasCounts['32px'] / config.atlasesPerTex;
      // load each texture for this data set
      for (var i=0; i<self.nTextures; i++) {
        self.textures.push(new Texture({
          idx: i,
          positions: self.getTexturePositions(i),
          onProgress: self.onTextureProgress,
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
    var completeSum = self.nTextures * 100 * config.atlasesPerTex;
    if (progressSum === completeSum) {
      world.plot();
    }
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
  self.positions = obj.positions;
  self.onProgress = obj.onProgress;
  self.onLoad = obj.onLoad;
  self.canvas = null;
  self.ctx = null;

  self.setCanvas = function() {
    self.canvas = getElem('canvas', {
      width: webgl.limits.textureSize,
      height: webgl.limits.textureSize,
      id: 'texture-' + self.idx,
    })
    self.ctx = self.canvas.getContext('2d');
  }

  self.load = function() {
    self.setCanvas();
    for (var i=0; i<config.atlasesPerTex; i++) {
      self.atlases.push(new Atlas({
        idx: i,
        positions: self.getAtlasPositions(i),
        size: config.atlasSize,
        textureIdx: self.idx,
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
    var texSize = webgl.limits.textureSize;
    var x = (atlas.idx * config.atlasSize) % texSize;
    var y = Math.floor((atlas.idx * config.atlasSize) / texSize) * config.atlasSize;
    self.ctx.drawImage(atlas.image, x, y, config.atlasSize, config.atlasSize);
  }

  self.load();
}

/**
* Atlas
**/

function Atlas(obj) {
  var self = this;
  self.textureIdx = obj.textureIdx;
  self.idx = obj.idx;
  self.size = obj.size;
  self.onLoad = obj.onLoad;
  self.onProgress = obj.onProgress;
  self.positions = obj.positions;
  self.image = null;
  self.progress = 0;
  self.url = config.dataUrl + 'atlas_files/32px/atlas-' + self.idx + '.jpg';
  self.cells = [];

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
    var start = self.textureIdx * config.atlasesPerTex * config.cellsPerAtlas;
    for (var i=0; i<self.positions.length; i++) {
      var data = self.positions[i];
      self.cells.push(new Cell({
        name: data[0],
        x: data[1] * config.spread.x,
        y: data[2] * config.spread.y,
        w: data[3],
        h: data[4],
        idx: start + i,
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
  self.name = obj.name;
  self.x = obj.x;
  self.y = obj.y;
  self.z = 1;
  self.w = obj.w;
  self.h = obj.h;
  self.idx = obj.idx;
  self.xPad = (config.cellSize - self.w) / 2;
  self.yPad = (config.cellSize - self.h) / 2;
  self.perRow = config.cellsPerAtlasSide;
  self.idxInAtlas = self.idx % config.cellsPerAtlas;
  self.xPosInAtlas = (self.idx % self.perRow) * config.cellSize;
  self.yPosInAtlas = Math.floor(self.idx / self.perRow) * config.cellSize;
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
  * Draw each of the vertices
  **/

  self.plot = function() {
    var attrs = self.getPointAttributes();
    var group = new THREE.Group();
    var BA = THREE.BufferAttribute;
    var IBA = THREE.InstancedBufferAttribute;
    var geometry = new THREE.InstancedBufferGeometry();
    geometry.addAttribute('uv', new BA(attrs.uvs, 2));
    geometry.addAttribute('position', new BA(attrs.positions, 3));
    geometry.addAttribute('textureIndex', new IBA(attrs.texIndices, 1, 1));
    geometry.addAttribute('textureOffset', new IBA(attrs.texOffsets, 2, 1));
    geometry.addAttribute('translation', new IBA(attrs.translations, 3, 1));
    var material = self.getShaderMaterial(attrs.textures);
    var mesh = new THREE.Points(geometry, material);
    mesh.frustumCulled = false;
    group.add(mesh);
    self.scene.add(group);
    self.render();
  }

  self.getPointAttributes = function() {
    var n = data.positions.length;
    var textures = [];
    var texIndices = new Float32Array(n);
    var texOffsets = new Float32Array(n * 2);
    var translations = new Float32Array(n * 3);
    var texIndexIterator = 0;
    var texOffsetIterator = 0;
    var translationIterator = 0;
    data.textures.forEach(function(texture, tidx) {
      textures.push( new THREE.Texture(texture.canvas) );
      texture.atlases.forEach(function(atlas, aidx) {
        atlas.cells.forEach(function(cell) {
          texIndices[texIndexIterator++] = cell.textureIdx;
          texOffsets[texOffsetIterator++] = cell.xPosInAtlas;
          texOffsets[texOffsetIterator++] = cell.yPosInAtlas;
          translations[translationIterator++] = cell.x;
          translations[translationIterator++] = cell.y;
          translations[translationIterator++] = cell.z;
        })
      })
    })
    return {
      uvs: new Float32Array([0, 0]),
      positions: new Float32Array([0, 0, 0]),
      texIndices: texIndices,
      texOffsets: texOffsets,
      translations: translations,
      textures: textures,
    }
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
        // specify size of each image in image atlas
        cellSize: {
          type: 'v2',
          value: [
            config.cellSize / config.atlasSize,
            config.cellSize / config.atlasSize,
          ],
        }
      },
      vertexShader: find('#vertex-shader').textContent,
      fragmentShader: find('#fragment-shader').textContent,
    });
  }

  self.render = function() {
    requestAnimationFrame(self.render);
    TWEEN.update();
    self.raycaster.setFromCamera(self.mouse, self.camera);
    self.renderer.render(self.scene, self.camera);
    self.controls.update();
    if (self.stats) self.stats.update();
  }

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

  self.scene = self.getScene();
  self.camera = self.getCamera();
  self.renderer = self.getRenderer();
  self.controls = self.getControls();
  self.stats = self.getStats();
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
      textureSize: 4096, //gl.getParameter(gl.MAX_TEXTURE_SIZE),
      textureCount: self.gl.getParameter(self.gl.MAX_TEXTURE_IMAGE_UNITS),
      vShaderTextures: self.gl.getParameter(self.gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      indexedElements: maxIndex,
    }
  }

  self.setGl();
  self.setLimits();
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
* Main
**/

var webgl = new Webgl();
var config = new Config();
var world = new World();
var data = new Data();