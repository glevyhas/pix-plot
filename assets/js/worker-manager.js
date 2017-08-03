/**
* Manage worker threads for asset loading
* See SO 13574158 for an overview of concurrent workers
**/

(function() {

  // number of concurrent processes available in hardware host
  var maxWorkers = navigator.hardwareConcurrency || 4,
      index = 0,
      totalWorkers = 1,
      progress = 0,
      loadedFiles = 0,
      totalFiles = 1,
      doRun = false;

  function createWorker() {
    var worker = new Worker('assets/js/worker.js');
    worker.onmessage = function(event) {
      // once a worker has loaded their data, delete the worker
      if (event.data.status === 'complete') {
        console.log('complete', event.data);
        loadedFiles += 1;
        if (loadedFiles === totalFiles) {
          window.tsne.init()
        }

        worker.terminate();
        if (index < totalWorkers) {
          createWorker();
        }

      // gracefully handle errors...
      } else if (event.data.status === 'error') {
        console.warn(event.data)
      
      // update the total progress log
      } else if (event.data.status === 'progress') {
        handleProgress(event.data);
      }
    }

    // inform the worker of the file they should load
    index++;
    var fileToLoad = '/data/image-atlas.jpg';

    worker.postMessage({
      message: 'begin',
      file: fileToLoad,
      index: index
    });
  }

  function handleProgress(event) {
    console.log('received progress', event)
  }

  // initialize the workers
  if (doRun) {
    for (var i=0; i<maxWorkers; i++) {
      if (i+1<=totalWorkers) {
        createWorker();
      }
    }
  }
})();