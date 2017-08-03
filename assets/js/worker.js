self.onmessage = function(event) {
  self.workerIndex = event.data.index;
  if (event.data.message === 'begin') {
    self.getAsset(event.data.file, self.handleSuccess, self.handleErr);
  }
};

self.getAsset = function(url, success, err) {
  var xmlhttp = new XMLHttpRequest();
  xmlhttp.onreadystatechange = function() {
    if (xmlhttp.readyState == XMLHttpRequest.DONE) {
      xmlhttp.status === 200 ?
          success(xmlhttp.responseText)
        : err(xmlhttp);
    };
  };
  xmlhttp.onprogress = self.handleProgress;
  xmlhttp.open('GET', url, true);
  xmlhttp.send();
}

self.handleSuccess = function(response) {
  self.postMessage({
    status: 'complete',
    workerIndex: self.workerIndex
  })
}

self.handleErr = function(err) {
  self.postMessage({
    status: 'err',
    workerIndex: self.workerIndex
  })
}

self.handleProgress = function(e) {
  var percentComplete = (e.loaded/e.total) * 100;
  self.postMessage({
    status: 'progress',
    percentComplete: percentComplete,
    workerIndex: self.workerIndex
  });
}