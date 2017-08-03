(function() {

  window.tsne = window.tsne || {};

      /**
      * Image config
      *
      * imageSize: h,w of each image in px
      * imageScale: multiplier used to project the image positional
      *   coordinates identified in `imagePositionsFile` to the
      *   three.js space
      * maxImages: total number of images to load
      * imagePositionsFile: file that maps each image to its
      *   coordinates in the space
      * imageToCoords: mapping from imageIdx to that images
      *   coordinates in the space {x: xpos, y: ypos}
      * imageIdxToOffsets: maps each imageIdx to 4 vec3's that
      *   represent the image's offset within its appropriate
      *   image atlas file
      **/

  var imageSize = 20,
      imageScale = 200,
      maxImages = 10000,
      imagePositionsFile = 'https://s3-us-west-2.amazonaws.com/lab-apps/meserve-kunhardt/tsne-map/app-assets/selected_image_tsne_projections.json',
      imageToCoords = {},
      imageIdxToOffsets = {},

      /**
      * Atlas config: each atlas contains 59x59 images,
      * where each images is 128x128 px
      *
      * atlasCount: total number of atlasses to load
      * atlasPrefix: path to the atlas file
      * atlasRowAndCols: [row,cols] total number of images in each row
      *   and col of each image atlas
      * cellsPerAtlas: the total number of images contained
      *   in each atlas
      * loadedAtlasCount: total number of atlas files already
      *   loaded
      * atlasCellSize: total number of pixels in the x,y dimensions
      *   of each image in the atlas
      * atlasHW: [h,w] of the atlas size in px
      * atlasContentHW: [h,w] of the atlas content in px (as opposed to the
      *   remainder of the atlasHW, which is used to pad the atlas so the x,y
      *   dimensions are each a power of two)
      * atlasCoverage: {0:1} percent of the h,w of the atlas that contains
      *   actual atlas content (as opposed to the padding that occupies
      *   the remainder of the atlas to keep the x,y dimensions each a
      *   power of two)
      **/

      atlasCount = 1,
      atlasFile = 'https://s3-us-west-2.amazonaws.com/lab-apps/meserve-kunhardt/tsne-map/app-assets/image-atlas-pot.jpg',
      atlasRowAndCols = 100,
      cellsPerAtlas = atlasRowAndCols**2,
      loadedAtlasCount = 0,
      atlasCellSize = 128,
      atlasHW = [16384, 16384],
      atlasContentHW = [12800, 12600],
      atlasCoverage = [
        atlasContentHW[0]/atlasHW[0],
        atlasContentHW[1]/atlasHW[1]
      ],

      /**
      * View config
      **/

      HEIGHT,
      WIDTH,
      container,
      camera,
      scene,
      stats,
      controls,
      texture,
      particles,
      combinedMesh,
      welcome = document.querySelector('.welcome'),
      bar = document.querySelector('.progress-bar-inner'),
      container = document.querySelector('.progress-bar'),
      button = document.querySelector('.button');

  /**
  * Add DOM event listeners
  **/

  window.addEventListener('resize', onWindowResize, false);

  button.addEventListener('click', function() {
    window.setTimeout(function() {
      welcome.style.display = 'none';
    }, 1700);
    welcome.style.opacity = 0;
  })

  /**
  * Initialize
  **/

  window.tsne.init = function() {
    get(imagePositionsFile, function(coordData) {
      imageToCoords = JSON.parse(coordData);
      init();
    });
  };

  window.tsne.init();

  function get(url, success, err) {
    var xmlhttp = new XMLHttpRequest();
    xmlhttp.onreadystatechange = function() {
      if (xmlhttp.readyState == XMLHttpRequest.DONE) {
        xmlhttp.status === 200 ?
            success(xmlhttp.responseText)
          : err(xmlhttp);
      };
    };
    xmlhttp.open('GET', url, true);
    xmlhttp.send();
  }

  function init() {
    HEIGHT = window.innerHeight;
    WIDTH = window.innerWidth;

    // args: field of view, aspect ratio, near plane, far plane
    camera = new THREE.PerspectiveCamera(1000, WIDTH/HEIGHT, 1, 4000);
    camera.position.y = -5;
    camera.position.z = 4000;
    camera.rotation.x = 0;

    // initialize scene
    scene = new THREE.Scene();

    // render the canvas
    renderer = new THREE.WebGLRenderer({antialias: true}); 
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(WIDTH, HEIGHT);

    // add the rendered canvas to the page
    container = document.querySelector('#target');
    container.appendChild(renderer.domElement);

    addLight();
    addStats();
    addControls();
    loadTexture();
    animate();
  }

  function addLight() {
    var ambientLight = new THREE.AmbientLight(0x555555);
    scene.add(ambientLight);

    // add directed light source
    var directionalLight = new THREE.DirectionalLight(0xffffff);
    directionalLight.position.set(1, 1, 1).normalize();
    scene.add(directionalLight);
  }

  // Add stats to show frames per second
  function addStats() {
    stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '0px';
    stats.domElement.style.right = '0px';
    container.appendChild( stats.domElement );
  }

  // configure trackball controls
  function addControls() {
    controls = new THREE.TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 1.5;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
  }

  function loadTexture() {
    THREE.FileLoader.prototype.crossOrigin = '';
    var loader = new AjaxTextureLoader();

    var texture = loader.load(
      atlasFile,
      addImages,
      handleProgress
    );
  }

  function addImages(texture) {
    texture.flipY = false;

    var images = Object.keys(imageToCoords),
        geometry = new THREE.Geometry();

    // clear out the extant vertices
    geometry.vertices = [];
    geometry.faceVertexUvs[0] = [];

    // identify one sub image in the atlas images for each image file
    for (var i=0; i<maxImages; i++) {

      /**
      * Compute the locational vertices to position this image
      * within the chart. Vertex order:
      *   lower-left, lower-right, upper-right, upper-left
      * Each vertex is given in x,y,z order
      **/

      var coords = imageToCoords[images[i]];
      coords.x *= imageScale;
      coords.y *= imageScale;
      coords.z = Math.random() * 20;

      geometry.vertices.push(
        new THREE.Vector3(
          coords.x,
          coords.y,
          coords.z
        ),
        new THREE.Vector3(
          coords.x+imageSize,
          coords.y,
          coords.z
        ),
        new THREE.Vector3(
          coords.x+imageSize,
          coords.y+imageSize,
          coords.z
        ),
        new THREE.Vector3(
          coords.x,
          coords.y+imageSize,
          coords.z
        )
      );

      /**
      * THREE.Face3 describes a triangle. It's a primitive that's
      * autogenerated when one uses higher-order THREE.js geometry
      * types, but when using cusom geometry one must assemble
      * the geometry from these primitives. Its arguments describe
      * the index position of the values in geometry.vertices that
      * should be used to create this object's vertices
      **/

      // ie faceOne has the first three vec3's pushed for this image
      // while faceTwo has the last three vec3's pushed for this image
      var faceOne = new THREE.Face3(
        geometry.vertices.length-4,
        geometry.vertices.length-3,
        geometry.vertices.length-2
      )

      var faceTwo = new THREE.Face3(
        geometry.vertices.length-4,
        geometry.vertices.length-2,
        geometry.vertices.length-1
      )

      geometry.faces.push(faceOne, faceTwo);

      /**
      * atlasIdx: the index of the atlas with this image
      * row: the row of this image in the atlas
      * col: the col of this image in the atlas
      **/

      var atlasIdx = Math.floor(i/cellsPerAtlas),
          row = Math.floor(i/atlasRowAndCols),
          col = i%atlasRowAndCols;

      /**
      * Identify the percent offset of the given image within
      * its appropriate texture. The origin is the lower left
      * hand corner of the texture, and the space maps from {0:1}
      * in the vertical (V) and horizontal (U) dimensions
      * The array contains the vertices that describe the:
      *   Lower-left, Lower-right, Upper-right, Upper-left;
      * Each vertex is given in x,y pairs, where each x,y pair
      * identifies a value {0:1} that identifies the appropriate
      * offset for that region of the image within the atlas 
      **/

      imageIdxToOffsets[i] = [
        new THREE.Vector2(
          (col/atlasRowAndCols) * atlasCoverage[0],
          ((row)/atlasRowAndCols) * atlasCoverage[1]
        ),
        new THREE.Vector2(
          ((col+1)/atlasRowAndCols) * atlasCoverage[0],
          ((row)/atlasRowAndCols) * atlasCoverage[1]
        ),
        new THREE.Vector2(
          ((col+1)/atlasRowAndCols) * atlasCoverage[0],
          ((row+1)/atlasRowAndCols) * atlasCoverage[1]
        ),
        new THREE.Vector2(
          (col/atlasRowAndCols) * atlasCoverage[0],
          ((row+1)/atlasRowAndCols) * atlasCoverage[1]
        )
      ];

      geometry.faceVertexUvs[0].push([
        imageIdxToOffsets[i][0],
        imageIdxToOffsets[i][1],
        imageIdxToOffsets[i][2]
      ]);
      geometry.faceVertexUvs[0].push([
        imageIdxToOffsets[i][0],
        imageIdxToOffsets[i][2],
        imageIdxToOffsets[i][3]
      ]);
    }

    /**
    * Create one material per image atlas
    **/

    var obj = new THREE.Object3D();

    var uniforms = {
      time: {
        type: 'f',
        value: 1.0
      },
      size: {
        type: 'v2',
        value: new THREE.Vector2(WIDTH, HEIGHT)
      },
      map: {
        type: 't',
        value: texture
      },
      effectAmount: {
        type: 'f',
        value: 0.0
      }
    };

    // create some custom shaders for these objects!
    var shaderMaterial = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: document.querySelector('#vertex').textContent,
      fragmentShader: document.querySelector('#fragment').textContent
    });
    shaderMaterial.transparent = false;
    shaderMaterial.depthTest = false;

    // build some meshes for the object
    var mesh = new THREE.Mesh(
      geometry,
      shaderMaterial
    );
    mesh.doubleSided = true;
    mesh.position.x = 100;
    mesh.position.z = 100;
    obj.add(mesh);

    // add the built-up object to the scene
    scene.add(obj);
  }

  function animate() {
    requestAnimationFrame(animate);
    render();
    stats.update();
  }

  function render() {
    renderer.render(scene, camera);
    controls.update();
  }

  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );
    controls.handleResize();
  }

  function handleProgress(xhr) {
    var percentComplete = xhr.loaded / xhr.total * 100;
    var completeNumerator = (loadedAtlasCount * 100) + percentComplete;
    var completeDenominator = atlasCount*100;
    var totalPercent = (completeNumerator-5) / completeDenominator;
    updateProgressBar(totalPercent);
  }

  function updateProgressBar(percentDone) {
    bar.style.width = (percentDone * container.clientWidth) + 'px';
    if (percentDone >= .95 && percentDone < 1) {
      window.setTimeout(updateProgressBar.bind(null, percentDone+0.01), 1000);
    } else if (percentDone === 1) {
      button.setAttribute('class', 'button');
    }
  }
})()