// add a 
Image.prototype.load = function(url, onProgress) {
  var img = this;
  var xmlHTTP = new XMLHttpRequest();
  xmlHTTP.open('GET', url, true);
  xmlHTTP.responseType = 'arraybuffer';
  xmlHTTP.onload = function(e) {
    img.src = url;
  };
  xmlHTTP.onprogress = function(e) {
    if (onProgress) onProgress(parseInt((e.loaded / e.total) * 100))
  };
  xmlHTTP.send();
};