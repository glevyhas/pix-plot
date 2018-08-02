# PixPlot

This repository contains code that can be used to visualize tens of thousands of images in a two-dimensional projection within which similar images are clustered together. The image analysis uses Tensorflow's Inception bindings, and the visualization layer uses a custom WebGL viewer.

![App preview](./assets/images/preview.png?raw=true)

## Dependencies

To install the Python dependencies, you can run (ideally in a virtual environment):

```bash
pip install -r utils/requirements.txt
```

If you have an NVIDIA GPU, consider replacing `tensorflow` with `tensorflow-gpu` in `requirements.txt`.  You'll need to have CUDA and CUDNN working as well.

Image resizing utilities require ImageMagick compiled with jpg support:

```bash
brew uninstall imagemagick && brew install imagemagick
```

The html viewer requires a WebGL-enabled browser.

## Quickstart

If you have a WebGL-enabled browser and a directory full of images to process, you can prepare the data for the viewer by installing the dependencies above then running:

```bash
git clone https://github.com/YaleDHLab/pix-plot && cd pix-plot
python utils/process_images.py "path/to/images/*.jpg"
```

To see the results of this process, you can start a web server by running:

```bash
# for python 3.x
python -m http.server 5000

# for python 2.x
python -m SimpleHTTPServer 5000
```

The visualization will then be available on port 5000.

## Processing Data with Docker

Some users may find it easiest to use the included Docker image to visualize a dataset.

To do so, you must first [install Docker](https://docs.docker.com/install/). If you are on Windows 7 or earlier, you may need to install [Docker Toolbox](https://docs.docker.com/toolbox/toolbox_install_windows/) instead.

Once Docker is installed, start a terminal, cd into the folder that contains this README file, and run:

```bash
# build the container
docker build --tag pixplot --file Dockerfile .

# process images - use the `-v` flag to mount directories from outside
# the container into the container
docker run \
  -v $(pwd)/output:/pixplot/output \
  -v /Users/my_user/Desktop/my_images:/pixplot/images \
  pixplot \
  bash -c "cd pixplot && python3.6 utils/process_images.py images/*.jpg"

# run the web server
docker run \
  -v $(pwd)/output:/pixplot/output \
  -p 5000:5000 \
  pixplot \
  bash -c "cd pixplot && python3.6 -m http.server 5000"
```

Once the web server starts, you should be able to see your results on `localhost:5000`.

## Curating Automatic Hotspots

By default, PixPlot uses [*k*-means clustering](https://en.wikipedia.org/wiki/K-means_clustering) to find twenty hotspots in the visualization.  You can adjust the number of discovered hotspots by changing the `n_clusters` value in `utils/process_images.py` and re-running the script.

After processing, you can curate the discovered hotspots by editing the resulting `output/plot_data.json` file. (This file can be unwieldy in large datasets -- you may wish to disable syntax highlighting and automatic wordwrap in your text editor.) The hotspots will be listed at the very end of the JSON data, each containing a label (by default 'Cluster *N*') and the name of an image that represents the centroid of the discovered hotspot.

You can add, remove or re-order these, change the labels to make them more meaningful, and/or adjust the image that symbolizes each hotspot in the left-hand **Hotspots** menu.  *Hint: to get the name of an image that you feel better reflects the cluster, click on it in the visualization and it will appear suffixed to the URL.*


## Demonstrations

| Collection | # Images | Collection Info | Image Source |
| ---------- | -------- |  --------------- | ------------ |
| [Per Bagge](https://goo.gl/uk8oUx) | 29,782 | [Bio](https://goo.gl/2jQYGz) | [Lund University](https://goo.gl/zHpebT) |
| [Meserve-Kunhardt](https://goo.gl/sE3ZGy) | 27,000 | [Finding Aid](https://goo.gl/ESfcdB) | [Beinecke (Partial)](goo.gl/ESfcdB) |


## Acknowledgements

The DHLab would like to thank [Cyril Diagne](http://cyrildiagne.com/), a lead developer on the spectacular [Google Arts Experiments TSNE viewer](https://artsexperiments.withgoogle.com/tsnemap/), for generously sharing ideas on optimization techniques used in this viewer.
