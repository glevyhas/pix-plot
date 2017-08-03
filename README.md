# TSNE Image Browser

This repository hosts source code used to identify and display 10,000 similar images in a WebGL-powered TSNE image browser. 

![App preview](/assets/images/preview.png?raw=true)

## Dependencies

The scripts in `utils/` rely upon the Python packages identified in `utils/requirememts.txt`. If you create a virtual environment or conda environment, you can run `pip install utils/requirements.txt` to resolve these dependencies.

Image resizing utilities require ImageMagick.

The html viewer requires a WebGL-enabled browser.

## Quickstart

If you have a WebGL-enabled browser, you can start a local web server and see the application by running:

```
git clone https://github.com/YaleDHLab/tsne-images-webgl
cd tsne-images-webgl

wget https://s3-us-west-2.amazonaws.com/lab-apps/meserve-kunhardt/tsne-map/data.tar.gz
tar -zxf data.tar.gz

# Python3
python -m http.server 7051

# Python3
python -m SimpleHTTPServer 7051
```

The viewer will then be available on `localhost:7051`.

## Data Processing

The following table gives a quick overview of the utilities in `utils/`:

| File  | Use |
| ------------- | ------------- |
| classify_images.py | Generates one numpy vector for each input image |
| cluster_vectors.py  | Builds a 2d TSNE model with input image vectors  |
| get_nearest_neighbors.py | Finds 100 nearest neighbors for each input image vector |
| make_montage.py | Generates one large image file from many small images |
| resize_thumbs.py | Resizes all images in a target directory to 128x128px |
| select_images_to_display.py | Selects a subset of all images to create good-looking clusters |
