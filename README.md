# PixPlot

This repository contains code that can be used to visualize tens of thousands of images in a two-dimensional projection within which similar images are clustered together. The image analysis uses Tensorflow's Inception bindings, and the visualization layer uses a custom WebGL viewer.

![App preview](./pixplot/web/assets/images/preview.png?raw=true)


## Dependencies

To install the Python dependencies, you can run (ideally in a virtual environment):

```bash
pip install pixplot
```

The HTML viewer requires a WebGL-enabled browser.


## Quickstart

If you have a WebGL-enabled browser and a directory full of images to process, you can prepare the data for the viewer by installing the dependencies above then running:

```bash
pixplot --images "path/to/images/*.jpg"
```

To see the results of this process, you can start a web server by running:

```bash
# for python 3.x
python -m http.server 5000

# for python 2.x
python -m SimpleHTTPServer 5000
```

The visualization will then be available at `http://localhost:5000/output`.


## Creating Massive Plots

If you need to plot more than 100,000 images but don't have an expensive graphics card with which to visualize huge WebGL displays, you might want to specify a smaller "cell_size" parameter when building your plot. The "cell_size" argument controls how large each image is in the atlas files. Smaller values require fewer textures to be rendered, which decreases the RAM requirements to view a plot:

```bash
pixplot --images "path/to/images/*.jpg" --cell_size 10
```

## Controlling UMAP Layout

The [UMAP algorithm](https://github.com/lmcinnes/umap) is particularly sensitive to three hyperparemeters:

```
--min_distance: determines the minimum distance between points in the embedding
```
```
--n_neighbors: determines the tradeoff between local and global clusters
```
```
--metric: determines the distance metric to use when positioning points
```

UMAP's creator, Leland McInnes, has written up a [helpful overview of these hyperparameters](https://umap-learn.readthedocs.io/en/latest/parameters.html). To specify the value for one or more of these hyperparameters when building a plot, one may use the flags above, e.g.:

```
pixplot --images "path/to/images/*.jpg" --n_neighbors 2
```

## Curating Automatic Hotspots

By default, PixPlot uses [*K*-Means Clustering](https://en.wikipedia.org/wiki/K-means_clustering) to find twenty hotspots in the visualization.  You can adjust the number of discovered hotspots by adding ` --clusters=n` to the processing script, where `n` is set to the desired number of clusters.

After processing, you can curate the discovered hotspots by editing the resulting `output/centoids/hash.json` file. The hotspots each have a label (by default 'Cluster *N*') and the name of an image that represents the centroid of the discovered hotspot.

You can add, remove or re-order these, change the labels to make them more meaningful, and/or adjust the image that symbolizes each hotspot in the left-hand **Hotspots** menu. *Hint: to get the name of an image that you feel better reflects the cluster, click on it in the visualization and it will appear in a lightbox viewer*


## Adding Metadata

If you have metadata associated with each of your images, you can pass in that metadata when running the data processing script. Doing so will allow the PixPlot viewer to display the metadata associated with an image when a user clicks on that image.

To specify the metadata for your image collection, you can add ` --metadata=path/to/metadata.csv` to the command you use to call the processing script. For example, you might specify:

```bash
pixplot --images "path/to/images/*.jpg" --metadata "path/to/metadata.csv"
```

Your metadata should be in a comma-separated value file (CSV), should contain one row for each of your input images, and should contain exactly the following columns in the following order.

| Filename | Metadata Tags | Description | Permalink   |
| -------- | ------------- | ----------- | ----------- |
| bees.jpg | honey&#124;yellow  | bees' knees | https://... |

The CSV should contain no headers.

## IIIF Images

If you would like to process images that are hosted on a IIIF server, you can specify a newline-delimited list of IIIF image manifests as the `--images` argument. For example, the following could be saved as `manifest.txt`:

```bash
https://manifests.britishart.yale.edu/manifest/40005
https://manifests.britishart.yale.edu/manifest/40006
https://manifests.britishart.yale.edu/manifest/40007
https://manifests.britishart.yale.edu/manifest/40008
https://manifests.britishart.yale.edu/manifest/40009
```

One could then specify these images as input by running `pixplot --images manifest.txt --n_clusters 2`

## Demonstrations (Developed with PixPlot 2.0 codebase)

| Link | Image Count | Collection Info | Browse Images | Download for PixPlot
| ---------- | -------- | --------------- | ------------ | ------------ |
| [NewsPlot: 1910-1912](http://pixplot.yale.edu/v2/loc/) | 24,026 | [George Grantham Bain Collection](https://www.loc.gov/pictures/collection/ggbain/) | [News in the 1910s](https://www.flickr.com/photos/library_of_congress/albums/72157603624867509/with/2163445674/) | [Images](http://pixplot.yale.edu/datasets/bain/photos.tar), [Metadata](http://pixplot.yale.edu/datasets/bain/metadata.csv) |
| [Bildefelt i Oslo](http://pixplot.yale.edu/v2/oslo/) | 31,097 | [oslobilder](http://oslobilder.no) | [Advanced search, 1860-1924](http://oslobilder.no/search?advanced_search=1&query=&place=&from_year=1860&to_year=1924&id=&name=&title=&owner_filter=&producer=&depicted_person=&material=&technique=&event_desc=) | [Images](http://pixplot.yale.edu/datasets/oslo/photos.tar), [Metadata](http://pixplot.yale.edu/datasets/oslo/metadata.csv) |



## Acknowledgements

The DHLab would like to thank [Cyril Diagne](http://cyrildiagne.com/) and [Nicolas Barradeau](http://barradeau.com), lead developers of the spectacular [Google Arts Experiments TSNE viewer](https://artsexperiments.withgoogle.com/tsnemap/), for generously sharing ideas on optimization techniques used in this viewer, and [Lillianna Marie](https://github.com/lilliannamarie) for naming this viewer PixPlot.
