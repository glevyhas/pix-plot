(function() {

  window.tsne = window.tsne || {};

      /**
      * Image config
      *
      * aws: path to aws bucket with assets
      * imageSize: h,w of each image in px
      * imageScale: multiplier used to project the image positional
      *   coordinates identified in `imagePositionsFile` to the
      *   three.js space
      * imagePositionsFile: file that maps each image to its
      *   coordinates in the space
      * imageToCoords: mapping from imageIdx to that image's
      *   coordinates in the space {x: xpos, y: ypos}
      * imageIdxToOffsets: maps each imageIdx to 4 vec3's that
      *   represent the image's offset within its appropriate
      *   image atlas file
      **/

  var dataPath = 'https://s3-us-west-2.amazonaws.com/lab-apps/meserve-kunhardt/tsne-map/smaller-app-assets/',
      dataPath = 'data/',
      imageSize = 20,
      imageScale = 200,
      imagePositionsFile = dataPath + 'json/selected_image_tsne_projections.json',
      imageToCoords = {},
      imageIdxToOffsets = {},

      /**
      * Atlas config: each atlas contains nxn images
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
      * atlasHW: [h,w] of the atlas size in px (including whitespace on right
      *   and bottom to make image height and width each a power of two)
      * atlasContentHW: [h,w] of the atlas content in px (as opposed to the
      *   remainder of the atlasHW, which is used to pad the atlas so the x,y
      *   dimensions are each a power of two)
      * atlasCoverage: {0:1} percent of the h,w of the atlas that contains
      *   actual atlas content (as opposed to the padding that occupies
      *   the remainder of the atlas to keep the x,y dimensions each a
      *   power of two)
      * imagesPerAtlas: number of images that are contained in each atlas
      **/

      atlasCount = 10,
      atlasPrefix = dataPath + 'textures/64/image-atlas-',
      atlasRowAndCols = 32,
      cellsPerAtlas = atlasRowAndCols**2,
      loadedAtlasCount = 0,
      atlasCellSize = 64,
      atlasHW = [2048, 2048],
      atlasContentHW = [
        atlasRowAndCols*atlasCellSize,
        atlasRowAndCols*atlasCellSize
      ],
      atlasCoverage = [
        atlasContentHW[0]/atlasHW[0],
        atlasContentHW[1]/atlasHW[1]
      ],
      imagesPerAtlas = (atlasHW[0]/atlasCellSize)**2,

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
      textures = {}, // idx to texture
      welcome = document.querySelector('.welcome'),
      bar = document.querySelector('.progress-bar-inner'),
      container = document.querySelector('.progress-bar'),
      button = document.querySelector('.button');

  /**
  * Add DOM event listeners
  **/

  button.addEventListener('click', function() {
    window.setTimeout(function() {
      welcome.style.display = 'none';
    }, 1700);
    welcome.style.opacity = 0;
  })

  /**
  * Initialize
  **/

  get(imagePositionsFile, function(coordData) {
    imageToCoords = JSON.parse(coordData);
    init();
  });

  window.addEventListener('resize', onWindowResize, false);

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
    loadTextures();
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

  function loadTextures() {
    THREE.FileLoader.prototype.crossOrigin = '';
    var loader = new AjaxTextureLoader();
    for (var i=0; i<atlasCount; i++) {
      var atlasFile = atlasPrefix + i + '.jpg';
      // Pass the texture idx and texture to the handleTexture callback
      loader.load( atlasFile, handleTexture.bind(null, i));
    }
  }

  function handleTexture(textureIdx, texture) {
    // Pop this texture into place
    textures[textureIdx] = texture;
    loadedAtlasCount += 1;
    updateLoadProgress();
    addImages(textureIdx);
  }

  function addImages(textureIdx) {
    var texture = textures[textureIdx];
    texture.flipY = false;

    var images = Object.keys(imageToCoords);
    var geometry = getGeometry();

    // identify one sub image in the atlas images for each image file
    for (var i=0; i<imagesPerAtlas; i++) {
      if (i > 0 && i % 1000 === 0) {
        renderObject(geometry, textureIdx);

        // Initialize a new empty geometry
        var geometry = getGeometry();
      }

      /**
      * Compute the locational vertices to position this image
      * within the chart. Vertex order:
      *   lower-left, lower-right, upper-right, upper-left
      * Each vertex is given in x,y,z order
      **/

      // Adjust image idx by current texture position
      var imageIdx = ((textureIdx*imagesPerAtlas) + i);

      // Retrieve the coordinates for this image
      var coords = imageToCoords[ images[ imageIdx ] ];

      console.log(textureIdx, imageIdx, imagesPerAtlas, coords);

      if (!coords) break;

      coords.x *= imageScale;
      coords.y *= imageScale;
      coords.z = Math.random() * 60;

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

    // Add the last object to the scene
    renderObject(geometry, textureIdx);
  }

  /**
  * Get a geometry for the scene
  **/

  function getGeometry() {
    var geometry = new THREE.Geometry();

    // clear out the extant vertices
    geometry.vertices = [];
    geometry.faceVertexUvs[0] = [];
    return geometry;
  }

  /**
  * Create one material per image atlas
  **/

  function renderObject(geometry, textureIdx) {
    var material = new THREE.MeshBasicMaterial({
      map: textures[textureIdx],
      overdraw: 0.5
    });

    // build some meshes for the object
    mesh = new THREE.Mesh(
      geometry,
      material
    );
    mesh.doubleSided = false;
    mesh.position.x = 100;
    mesh.position.z = 100;

    var obj = new THREE.Object3D();
    obj.add(mesh);
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

  function updateLoadProgress() {
    var totalPercent = ((loadedAtlasCount*100)-5) / (atlasCount*100);
    updateProgressBar(totalPercent);
  }

  function updateProgressBar(percentDone) {
    bar.style.width = (percentDone * container.clientWidth) + 'px';
    if (percentDone >= .95 && percentDone < 1) {
      window.setTimeout(updateProgressBar.bind(null, percentDone+0.01), 1000);
    } else if (percentDone >= 1) {
      button.setAttribute('class', 'button');
    }
  }
})()