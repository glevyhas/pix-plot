# TSNE Image Browser

This repository hosts source code that visualizes tens of thousands of images in a two dimensional projection in which similar images are clustered together. The image analysis leverages Tensorflow's Inception bindings, and the visualization layer leverages a custom WebGL viewer.

![App preview](./assets/images/preview.png?raw=true)

## Dependencies

To install the Python dependencies, you can run (ideally in a virtual environment):
```bash
pip install -r assets/requirements.txt --user
```

Image resizing utilities require ImageMagick compiled with jpg support:
```bash
brew uninstall imagemagick && brew install imagemagick
```

The html viewer requires a WebGL-enabled browser.

## Quickstart

If you have a WebGL-enabled browser and a directory full of images to process, you can prepare the data for the viewer by installing the dependencies above then running:

```bash
python imageplot.py "path/to/images/*.jpg"
```

To see the results of this process, you can start a web server by running:

```bash
python server.py
```

The visualization will then be available on port 5000.

## Acknowledgements

The DHLab would like to thank [Cyril Diagne](http://cyrildiagne.com/), a lead developer on the spectacular [Google Arts Experiments TSNE viewer](https://artsexperiments.withgoogle.com/tsnemap/), for generously sharing ideas on optimization techniques used in this viewer.