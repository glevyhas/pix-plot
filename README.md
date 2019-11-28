# PixPlot

This repository contains code that can be used to visualize tens of thousands of images in a two-dimensional projection within which similar images are clustered together. The image analysis uses Tensorflow's Inception bindings, and the visualization layer uses a custom WebGL viewer.

![App preview](./assets/images/preview.png?raw=true)


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
| bees.jpg | honey|yellow  | bees' knees | https://... |

The CSV should contain no headers.

## Demonstrations

| Collection | # Images | Collection Info | Image Source |
| ---------- | -------- | --------------- | ------------ |
| [Per Bagge](http://dh.library.yale.edu/projects/pixplot/bagge/) | 10,889 | [Bio](http://www.alvin-portal.org/alvin/view.jsf?pid=alvin-person%3A29409) | [Lund University](http://www.alvin-portal.org/alvin/resultList.jsf?dswid=6772&af=%5B%22RES_facet%3Astill_image%22%2C%22ARCHIVE_ORG_ID_facet%3A8%22%5D&p=1&fs=true&searchType=EXTENDED&sortString=relevance_sort_desc&noOfRows=10&query=&aq=%5B%5B%7B%22PER_PID%22%3A%22alvin-person%3A29409%22%7D%5D%2C%5B%7B%22SWD_PER%22%3A%22alvin-person%3A29409%22%7D%5D%5D&aqe=%5B%5D) |
| [Meserve-Kunhardt](https://s3-us-west-2.amazonaws.com/lab-apps/pix-plot/index.html) | 27,000 | [Finding Aid](http://drs.library.yale.edu/HLTransformer/HLTransServlet?stylename=yul.ead2002.xhtml.xsl&pid=beinecke:meservekunhardt&clear-stylesheet-cache=yes&big=y) | [Beinecke (Partial)](https://brbl-dl.library.yale.edu/vufind/Search/Results?lookfor=GEN_MSS_1430&type=CallNumber) |


## Acknowledgements

The DHLab would like to thank [Cyril Diagne](http://cyrildiagne.com/) and [Nicolas Barradeau](http://barradeau.com), lead developers of the spectacular [Google Arts Experiments TSNE viewer](https://artsexperiments.withgoogle.com/tsnemap/), for generously sharing ideas on optimization techniques used in this viewer, and [Lillianna Marie](https://github.com/lilliannamarie) for naming this viewer PixPlot.
