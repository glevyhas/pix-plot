/**
 * @author Eberhard Graether / http://egraether.com/
 * @author Mark Lundin   / http://mark-lundin.com
 * @author Simone Manini / http://daron1337.github.io
 * @author Luca Antiga   / http://lantiga.github.io
 * @modified by Cello / http://milletforall.com
 */

THREE.TrackballControls = function ( object, domElement ) {

  var _this = window.inner = this;
  var STATE = { NONE: - 1, ROTATE: 2, ZOOM: 1, PAN: 0, TOUCH_ROTATE: 3, TOUCH_ZOOM_PAN: 4 };

  // the camera
  this.object = object;

  // the dom element that holds the canvas
  this.domElement = ( domElement !== undefined ) ? domElement : document;

  // API
  this.enabled = true;

  this.screen = { left: 0, top: 0, width: 0, height: 0 };

  this.rotateSpeed = 1.0;
  this.zoomSpeed = 1.2;
  this.panSpeed = 0.7;

  this.noRotate = false;
  this.noZoom = false;
  this.noPan = false;

  this.staticMoving = false;
  this.dynamicDampingFactor = 0.2;

  this.minDistance = 0;
  this.maxDistance = Infinity;

  this.keys = [ 65 /*A*/, 83 /*S*/, 68 /*D*/ ];

  // internals
  this.target = new THREE.Vector3();

  var EPS = 0.000001;

  var lastPosition = new THREE.Vector3();

  var _state = STATE.NONE,
      _prevState = STATE.NONE,

      _eye = new THREE.Vector3(),

      _movePrev = new THREE.Vector2(),
      _moveCurr = new THREE.Vector2(),

      _lastAxis = new THREE.Vector3(),
      _lastAngle = 0,

      _zoomStart = new THREE.Vector2(),
      _zoomEnd = new THREE.Vector2(),

      _touchZoomDistanceStart = 0,
      _touchZoomDistanceEnd = 0,

      _panStart = new THREE.Vector2(),
      _panEnd = new THREE.Vector2(),
      _mouseWheelLocation = new THREE.Vector2();

  // for reset
  this.target0 = this.target.clone();
  this.position0 = this.object.position.clone();
  this.up0 = this.object.up.clone();

  // events
  var changeEvent = { type: 'change' };
  var startEvent = { type: 'start' };
  var endEvent = { type: 'end' };

  // methods
  this.handleResize = function () {
    if ( this.domElement === document ) {
      this.screen.left = 0;
      this.screen.top = 0;
      this.screen.width = window.innerWidth;
      this.screen.height = window.innerHeight;
    } else {
      var box = this.domElement.getBoundingClientRect();
      // adjustments come from similar code in the jquery offset() function
      var d = this.domElement.ownerDocument.documentElement;
      this.screen.left = box.left + window.pageXOffset - d.clientLeft;
      this.screen.top = box.top + window.pageYOffset - d.clientTop;
      this.screen.width = box.width;
      this.screen.height = box.height;
    }
  };

  this.handleEvent = function ( event ) {
    if ( typeof this[ event.type ] == 'function' ) {
      this[ event.type ]( event );
    }
  };

  // returns x, y coords of mouse position on screen; each axis is scaled (0:1)
  // and the origin is the top left corner
  var getMouseOnScreen = ( function () {
    var vector = new THREE.Vector2();
    return function getMouseOnScreen( pageX, pageY ) {
      vector.set(
        ( pageX - _this.screen.left ) / _this.screen.width,
        ( pageY - _this.screen.top ) / _this.screen.height
      );
      return vector;
    };
  }() );

  var getMouseOnCircle = ( function () {
    var vector = new THREE.Vector2();
    return function getMouseOnCircle( pageX, pageY ) {
      vector.set(
        ( ( pageX - _this.screen.width * 0.5 - _this.screen.left ) / ( _this.screen.width * 0.5 ) ),
        ( ( _this.screen.height + 2 * ( _this.screen.top - pageY ) ) / _this.screen.width ) // screen.width intentional
      );
      return vector;
    };
  }());

  this.rotateCamera = ( function() {
    var axis = new THREE.Vector3(),
      quaternion = new THREE.Quaternion(),
      eyeDirection = new THREE.Vector3(),
      objectUpDirection = new THREE.Vector3(),
      objectSidewaysDirection = new THREE.Vector3(),
      moveDirection = new THREE.Vector3(),
      angle;
    return function rotateCamera() {
      moveDirection.set( _moveCurr.x - _movePrev.x, _moveCurr.y - _movePrev.y, 0 );
      angle = moveDirection.length();
      if ( angle ) {
        _eye.copy( _this.object.position ).sub( _this.target );
        eyeDirection.copy( _eye ).normalize();
        objectUpDirection.copy( _this.object.up ).normalize();
        objectSidewaysDirection.crossVectors( objectUpDirection, eyeDirection ).normalize();
        objectUpDirection.setLength( _moveCurr.y - _movePrev.y );
        objectSidewaysDirection.setLength( _moveCurr.x - _movePrev.x );
        moveDirection.copy( objectUpDirection.add( objectSidewaysDirection ) );
        axis.crossVectors( moveDirection, _eye ).normalize();
        angle *= _this.rotateSpeed;
        quaternion.setFromAxisAngle( axis, angle );
        _eye.applyQuaternion( quaternion );
        _this.object.up.applyQuaternion( quaternion );
        _lastAxis.copy( axis );
        _lastAngle = angle;
      } else if ( ! _this.staticMoving && _lastAngle ) {
        _lastAngle *= Math.sqrt( 1.0 - _this.dynamicDampingFactor );
        _eye.copy( _this.object.position ).sub( _this.target );
        quaternion.setFromAxisAngle( _lastAxis, _lastAngle );
        _eye.applyQuaternion( quaternion );
        _this.object.up.applyQuaternion( quaternion );
      }
      _movePrev.copy( _moveCurr );
    };
  }());


  this.zoomCamera = (function() {
    return function zoomCamera() {
      var dest = new THREE.Vector3(),
          pan = new THREE.Vector3(),
          objectUp = new THREE.Vector3(),
          factor;
      if ( _state === STATE.TOUCH_ZOOM_PAN ) {
        factor = _touchZoomDistanceStart / _touchZoomDistanceEnd;
        _touchZoomDistanceStart = _touchZoomDistanceEnd;
        _eye.multiplyScalar( factor );
      } else {

        var zoomDeltaY = _zoomEnd.y - _zoomStart.y;
        factor = 1.0 + zoomDeltaY * _this.zoomSpeed;
        if ( factor !== 1.0 && factor > 0.0 ) {

          if (zoomDeltaY < 0) {
            // zoom in towards mouse wheel location
            dest.set(_mouseWheelLocation.x, _mouseWheelLocation.y, 0.0);
            // convert target from screen coords (0:1) to clip coords (-1:1)
            dest = dest.addScalar(-0.5).multiplyScalar(2.0);

            // find the world space coordinates of user mouse position during zoom
            dest.unproject(_this.object);
            var direction = dest.sub(_this.object.position).normalize(),
                distance = - _this.object.position.z / direction.z,
                scaled = direction.multiplyScalar(distance),
                dest = _this.object.position.clone().add(scaled);
          } else {
            // zoom out towards plot origin
            dest.set(0.0, 0.0, 1.0);
            dest = _this.object.position.clone().sub(dest);
          }
          // find the distance we're scrolling in the z plane
          var zz = _eye.clone().multiplyScalar(factor).z - _eye.clone().z;

          // use the percent of zoom in the z dimension to scale changes in x y planes
          var pz = zz / _this.object.position.z;

          // apply the translation force in the x y planes
          var pan = new THREE.Vector3(),
              objectUp = new THREE.Vector3();

          // find the distance between camera and destination in the x & y planes
          var dx = dest.x - _this.object.position.x,
              dy = dest.y - _this.object.position.y;

          // determine the amount of change in the x y planes
          var planeChange = new THREE.Vector2(dx * pz, dy * pz);

          // apply the x pan component
          pan.copy( _eye ).cross( _this.object.up ).setLength(planeChange.x);

          // apply the y pan component
          pan.add( objectUp.copy( _this.object.up ).setLength(planeChange.y) );

          // actually add those forces to the target
          _this.target.add(pan)

          // apply the z translation component
          _eye.multiplyScalar( factor );
        }

        if ( _this.staticMoving ) {
          _zoomStart.copy( _zoomEnd );
        } else {
          _zoomStart.y += ( _zoomEnd.y - _zoomStart.y ) * this.dynamicDampingFactor;
        }
      }

    };
  }());


  this.panCamera = ( function() {
    var mouseChange = new THREE.Vector2(),
        objectUp = new THREE.Vector3(),
        pan = new THREE.Vector3();
    return function panCamera() {
      mouseChange.copy( _panEnd ).sub( _panStart );
      if ( mouseChange.lengthSq() ) {
        mouseChange.multiplyScalar( _eye.length() * _this.panSpeed );
        // set the pan in world coordinates
        pan.copy( _eye ).cross( _this.object.up ).setLength( mouseChange.x );
        pan.add( objectUp.copy( _this.object.up ).setLength( mouseChange.y ) );

        // the following shouldn't be needed as target is updated
        // and camera is updated by virtue of target
        //_this.object.position.add( pan );
        _this.target.add( pan );
        if ( _this.staticMoving ) {
          _panStart.copy( _panEnd );
        } else {
          _panStart.add( mouseChange.subVectors( _panEnd, _panStart ).multiplyScalar( _this.dynamicDampingFactor ) );
        }
      }
    };
  }());

  this.checkDistances = function () {
    if ( ! _this.noZoom || ! _this.noPan ) {
      if ( _eye.lengthSq() > _this.maxDistance * _this.maxDistance ) {
        _this.object.position.addVectors( _this.target, _eye.setLength( _this.maxDistance ) );
        _zoomStart.copy( _zoomEnd );
      }
      if ( _eye.lengthSq() < _this.minDistance * _this.minDistance ) {
        _this.object.position.addVectors( _this.target, _eye.setLength( _this.minDistance ) );
        _zoomStart.copy( _zoomEnd );
      }
    }
  };

  this.update = function () {
    _eye.subVectors( _this.object.position, _this.target );
    if ( ! _this.noRotate ) {
      _this.rotateCamera();
    }
    if ( ! _this.noZoom ) {
      _this.zoomCamera();
    }
    if ( ! _this.noPan ) {
      _this.panCamera();
    }
    _this.object.position.addVectors( _this.target, _eye );
    _this.checkDistances();
    _this.object.lookAt( _this.target );
    if ( lastPosition.distanceToSquared( _this.object.position ) > EPS ) {
      _this.dispatchEvent( changeEvent );
      lastPosition.copy( _this.object.position );
    }
  };

  this.reset = function () {
    _state = STATE.NONE;
    _prevState = STATE.NONE;
    _this.target.copy( _this.target0 );
    _this.object.position.copy( _this.position0 );
    _this.object.up.copy( _this.up0 );
    _eye.subVectors( _this.object.position, _this.target );
    _this.object.lookAt( _this.target );
    _this.dispatchEvent( changeEvent );
    lastPosition.copy( _this.object.position );
  };

  // listeners
  function keydown( event ) {
    if ( _this.enabled === false ) return;
    window.removeEventListener( 'keydown', keydown, eventBindType );
    _prevState = _state;
    if ( _state !== STATE.NONE ) {
      return;
    } else if ( event.keyCode === _this.keys[ STATE.ROTATE ] && ! _this.noRotate ) {
      _state = STATE.ROTATE;
    } else if ( event.keyCode === _this.keys[ STATE.ZOOM ] && ! _this.noZoom ) {
      _state = STATE.ZOOM;
    } else if ( event.keyCode === _this.keys[ STATE.PAN ] && ! _this.noPan ) {
      _state = STATE.PAN;
    }
  }

  function keyup( event ) {
    if ( _this.enabled === false ) return;
    _state = _prevState;
    window.addEventListener( 'keydown', keydown, eventBindType );
  }

  function mousedown( event ) {
    if ( _this.enabled === false ) return;
    if ( _state === STATE.NONE ) {
      _state = event.button;
    }
    if ( _state === STATE.ROTATE && ! _this.noRotate ) {
      _moveCurr.copy( getMouseOnCircle( event.pageX, event.pageY ) );
      _movePrev.copy( _moveCurr );
    } else if ( _state === STATE.ZOOM && ! _this.noZoom ) {
      _zoomStart.copy( getMouseOnScreen( event.pageX, event.pageY ) );
      _zoomEnd.copy( _zoomStart );
    } else if ( _state === STATE.PAN && ! _this.noPan ) {
      _panStart.copy( getMouseOnScreen( event.pageX, event.pageY ) );
      _panEnd.copy( _panStart );
    }
    document.addEventListener( 'mousemove', mousemove, eventBindType );
    document.addEventListener( 'mouseup', mouseup, eventBindType );
    _this.dispatchEvent( startEvent );
  }

  function mousemove( event ) {
    if ( _this.enabled === false ) return;
    if ( _state === STATE.ROTATE && ! _this.noRotate ) {
      _movePrev.copy( _moveCurr );
      _moveCurr.copy( getMouseOnCircle( event.pageX, event.pageY ) );
    } else if ( _state === STATE.ZOOM && ! _this.noZoom ) {
      _zoomEnd.copy( getMouseOnScreen( event.pageX, event.pageY ) );
    } else if ( _state === STATE.PAN && ! _this.noPan ) {
      _panEnd.copy( getMouseOnScreen( event.pageX, event.pageY ) );
    }
  }

  function mouseup( event ) {
    if ( _this.enabled === false ) return;
    _state = STATE.NONE;
    document.removeEventListener( 'mousemove', mousemove, eventBindType );
    document.removeEventListener( 'mouseup', mouseup, eventBindType );
    _this.dispatchEvent( endEvent );
  }

  function mousewheel( event ) {
    if ( _this.enabled === false ) return;

    // store the location where the user ran the mousewheel
    _mouseWheelLocation.copy( getMouseOnScreen( event.pageX, event.pageY ) );

    switch ( event.deltaMode ) {
      case 2:
        // Zoom in pages
        _zoomStart.y -= event.deltaY * 0.025;
        break;

      case 1:
        // Zoom in lines
        _zoomStart.y -= event.deltaY * 0.01;
        break;

      default:
        // undefined, 0, assume pixels
        _zoomStart.y -= event.deltaY * 0.00025;
        break;
    }
    _this.dispatchEvent( startEvent );
    _this.dispatchEvent( endEvent );
  }

  function touchstart( event ) {
    if ( _this.enabled === false ) return;
    switch ( event.touches.length ) {
      case 1:
        _state = STATE.TOUCH_ROTATE;
        _moveCurr.copy( getMouseOnCircle( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY ) );
        _movePrev.copy( _moveCurr );
        break;

      default: // 2 or more
        _state = STATE.TOUCH_ZOOM_PAN;
        var dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
        var dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;
        _touchZoomDistanceEnd = _touchZoomDistanceStart = Math.sqrt( dx * dx + dy * dy );

        var x = ( event.touches[ 0 ].pageX + event.touches[ 1 ].pageX ) / 2;
        var y = ( event.touches[ 0 ].pageY + event.touches[ 1 ].pageY ) / 2;
        _panStart.copy( getMouseOnScreen( x, y ) );
        _panEnd.copy( _panStart );
        break;
    }
    _this.dispatchEvent( startEvent );
  }

  function touchmove( event ) {
    if ( _this.enabled === false ) return;
    switch ( event.touches.length ) {
      case 1:
        _movePrev.copy( _moveCurr );
        _moveCurr.copy( getMouseOnCircle( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY ) );
        break;

      default: // 2 or more
        var dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
        var dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;
        _touchZoomDistanceEnd = Math.sqrt( dx * dx + dy * dy );

        var x = ( event.touches[ 0 ].pageX + event.touches[ 1 ].pageX ) / 2;
        var y = ( event.touches[ 0 ].pageY + event.touches[ 1 ].pageY ) / 2;
        _panEnd.copy( getMouseOnScreen( x, y ) );
        break;
    }
  }

  function touchend( event ) {
    if ( _this.enabled === false ) return;
    switch ( event.touches.length ) {
      case 0:
        _state = STATE.NONE;
        break;

      case 1:
        _state = STATE.TOUCH_ROTATE;
        _moveCurr.copy( getMouseOnCircle( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY ) );
        _movePrev.copy( _moveCurr );
        break;
    }
    _this.dispatchEvent( endEvent );
  }

  function contextmenu( event ) {
    if ( _this.enabled === false ) return;
    event.preventDefault();
  }

  this.dispose = function() {
    this.domElement.removeEventListener( 'contextmenu', contextmenu, eventBindType );
    this.domElement.removeEventListener( 'mousedown', mousedown, eventBindType );
    this.domElement.removeEventListener( 'wheel', mousewheel, eventBindType );

    this.domElement.removeEventListener( 'touchstart', touchstart, eventBindType );
    this.domElement.removeEventListener( 'touchend', touchend, eventBindType );
    this.domElement.removeEventListener( 'touchmove', touchmove, eventBindType );

    document.removeEventListener( 'mousemove', mousemove, eventBindType );
    document.removeEventListener( 'mouseup', mouseup, eventBindType );

    window.removeEventListener( 'keydown', keydown, eventBindType );
    window.removeEventListener( 'keyup', keyup, eventBindType );
  };

  this.domElement.addEventListener( 'contextmenu', contextmenu, eventBindType );
  this.domElement.addEventListener( 'mousedown', mousedown, eventBindType );
  this.domElement.addEventListener( 'wheel', mousewheel, eventBindType );

  this.domElement.addEventListener( 'touchstart', touchstart, eventBindType );
  this.domElement.addEventListener( 'touchend', touchend, eventBindType );
  this.domElement.addEventListener( 'touchmove', touchmove, eventBindType );

  window.addEventListener( 'keydown', keydown, eventBindType );
  window.addEventListener( 'keyup', keyup, eventBindType );

  this.handleResize();

  // force an update at start
  this.update();
};

THREE.TrackballControls.prototype = Object.create( THREE.EventDispatcher.prototype );
THREE.TrackballControls.prototype.constructor = THREE.TrackballControls;

/**
* Determine whether browser supports passive event listener binding
**/

var supportsPassive = false;
try {
  var opts = Object.defineProperty({}, 'passive', {
    get: function() {
      supportsPassive = true;
    }
  });
  window.addEventListener('testPassive', null, opts);
  window.removeEventListener('testPassive', null, opts);
} catch (e) {}

var eventBindType = supportsPassive ? { passive: true } : false;