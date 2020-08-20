from __future__ import division
import warnings; warnings.filterwarnings('ignore')
from keras.preprocessing.image import save_img, img_to_array, array_to_img
from os.path import basename, join, exists, dirname, realpath
from keras.applications.inception_v3 import preprocess_input
from keras.applications import InceptionV3, imagenet_utils
from sklearn.metrics import pairwise_distances_argmin_min
from keras.backend.tensorflow_backend import set_session
from dateutil.parser import parse as parse_date
from sklearn.preprocessing import minmax_scale
from keras_preprocessing.image import load_img
from pointgrid import align_points_to_grid
from scipy.spatial.distance import cdist
from distutils.dir_util import copy_tree
from sklearn.decomposition import PCA
from scipy.spatial import ConvexHull
from iiif_downloader import Manifest
from collections import defaultdict
from rasterfairy import coonswarp
import matplotlib.pyplot as plt
from keras.models import Model
from scipy.stats import kde
from hdbscan import HDBSCAN
import keras.backend as K
import tensorflow as tf
from umap import UMAP
import multiprocessing
import pkg_resources
import rasterfairy
import numpy as np
import datetime
import operator
import argparse
import random
import shutil
import glob2
import copy
import uuid
import math
import gzip
import json
import lap
import sys
import csv
import os

try:
  from MulticoreTSNE import MulticoreTSNE as TSNE
except:
  from sklearn.manifold import TSNE

try:
  from urllib.parse import unquote # python 3
except:
  from urllib import unquote # python 2

# handle dynamic GPU memory allocation
tf_config = tf.compat.v1.ConfigProto()
tf_config.gpu_options.allow_growth = True
tf_config.log_device_placement = True
sess = tf.compat.v1.Session(config=tf_config)

'''
NB: Keras Image class objects return image.size as w,h
    Numpy array representations of images return image.shape as h,w,c
'''

config = {
  'images': None,
  'metadata': None,
  'out_dir': 'output',
  'max_images': None,
  'use_cache': True,
  'encoding': 'utf8',
  'min_cluster_size': 20,
  'atlas_size': 2048,
  'cell_size': 32,
  'lod_cell_height': 128,
  'n_neighbors': 6,
  'min_distance': 0.001,
  'metric': 'correlation',
  'pointgrid_fill': 0.05,
  'square_cells': False,
  'gzip': False,
  'plot_id': str(uuid.uuid1()),
  'seed': 24,
}


##
# Entry
##


def process_images(**kwargs):
  '''Main method for processing user images and metadata'''
  np.random.seed(kwargs['seed'])
  tf.compat.v1.set_random_seed(kwargs['seed'])
  copy_web_assets(**kwargs)
  kwargs['out_dir'] = join(kwargs['out_dir'], 'data')
  kwargs['image_paths'], kwargs['metadata'] = filter_images(**kwargs)
  kwargs['atlas_dir'] = get_atlas_data(**kwargs)
  get_manifest(**kwargs)
  write_images(**kwargs)
  print(' * done!')


def copy_web_assets(**kwargs):
  '''Copy the /web directory from the pixplot source to the users cwd'''
  src = join(dirname(realpath(__file__)), 'web')
  dest = join(os.getcwd(), kwargs['out_dir'])
  copy_tree(src, dest)
  # write version numbers into output
  for i in ['index.html', os.path.join('assets', 'js', 'tsne.js')]:
    path = os.path.join(dest, i)
    with open(path, 'r') as f:
      f = f.read().replace('VERSION_NUMBER', get_version())
      with open(path, 'w') as out:
        out.write(f)
  if kwargs['copy_web_only']: sys.exit()


##
# Images
##


def filter_images(**kwargs):
  '''Main method for filtering images given user metadata (if provided)'''
  # validate that input image names are unique
  seen = set()
  duplicates = set()
  for i in stream_images(image_paths=get_image_paths(**kwargs)):
    if i.path in seen:
      duplicates.add(i.path)
  if duplicates:
    raise Exception('''
      Image filenames should all be unique, but the following filenames are duplicated\n
      {}
      '''.format('\n'.join(duplicates)))
  del seen
  # process and filter the images
  image_paths = []
  for i in stream_images(image_paths=get_image_paths(**kwargs)):
    # get image height and width
    w,h = i.original.size
    # remove images with 0 height or width when resized to lod height
    if (h == 0) or (w == 0):
      print(' * skipping {} because it contains 0 height or width'.format(i.path))
      continue
    # remove images that have 0 height or width when resized
    try:
      resized = i.resize_to_max(kwargs['lod_cell_height'])
    except ValueError:
      print(' * skipping {} because it contains 0 height or width when resized'.format(i.path))
      continue
    # remove images that are too wide for the atlas
    if (w/h) > (kwargs['atlas_size']/kwargs['cell_size']):
      print(' * skipping {} because its dimensions are oblong'.format(i.path))
      continue
    image_paths.append(i.path)
  # handle the case user provided no metadata
  if not kwargs.get('metadata', False):
    return [
      limit_image_count(image_paths, **kwargs),
      [],
    ]
  # handle user metadata: retain only records with image and metadata
  l = get_metadata_list(**kwargs)
  meta_bn = set([clean_filename(i.get('filename', '')) for i in l])
  img_bn = set([clean_filename(i) for i in image_paths])
  # identify images with metadata and those without metadata
  meta_present = img_bn.intersection(meta_bn)
  meta_missing = list(img_bn - meta_bn)
  # notify the user of images that are missing metadata
  if meta_missing:
    print(' ! Some images are missing metadata:\n  -', '\n  - '.join(meta_missing[:10]))
    if len(meta_missing) > 10: print(' ...', len(meta_missing)-10, 'more')
    with open('missing-metadata.txt', 'w') as out: out.write('\n'.join(meta_missing))
  # get the sorted lists of images and metadata
  d = {clean_filename(i['filename']): i for i in l}
  images = []
  metadata = []
  for i in image_paths:
    if clean_filename(i) in meta_present:
      images.append(i)
      metadata.append(d[clean_filename(i)])
  kwargs['metadata'] = metadata
  write_metadata(**kwargs)
  return [
    limit_image_count(images, **kwargs),
    limit_image_count(metadata, **kwargs),
  ]


def limit_image_count(arr, **kwargs):
  '''If the user passed a max_images value, return [:max_images] from arr'''
  if kwargs.get('max_images', False):
    return arr[:kwargs['max_images']]
  return arr


def get_image_paths(**kwargs):
  '''Called once to provide a list of image paths--handles IIIF manifest input'''
  # handle case where --images points to iiif manifest
  image_paths = None
  if not kwargs['images']:
    print('\nError: please provide an images argument, e.g.:')
    print('pixplot --images "cat_pictures/*.jpg"\n')
    sys.exit()
  # handle list of IIIF image inputs
  if os.path.exists(kwargs['images']):
    with open(kwargs['images']) as f:
      f = [i.strip() for i in f.read().split('\n') if i.strip()]
      if [i.startswith('http') for i in f]:
        for i in f: Manifest(url=i).save_images(limit=1)
        image_paths = sorted(glob2.glob(os.path.join('iiif-downloads', 'images', '*')))
  # handle case where images flag points to a glob of images
  if not image_paths:
    image_paths = sorted(glob2.glob(kwargs['images']))
  # handle case user provided no images
  if not image_paths:
    print('\nError: No input images were found. Please check your --images glob\n')
    sys.exit()
  # optional shuffle that mutates image_paths
  if kwargs['shuffle']:
    print(' * shuffling input images')
    random.shuffle(image_paths)
  return image_paths


def stream_images(**kwargs):
  '''Read in all images from args[0], a list of image paths'''
  for idx, i in enumerate(kwargs['image_paths']):
    try:
      metadata = None
      if kwargs.get('metadata', False) and kwargs['metadata'][idx]:
        metadata = kwargs['metadata'][idx]
      yield Image(i, metadata=metadata)
    except Exception as exc:
      print(' * image', i, 'could not be processed --', exc)


def clean_filename(s):
  '''Given a string that points to a filename, return a clean filename'''
  return unquote(os.path.basename(s))


##
# Metadata
##


def get_metadata_list(**kwargs):
  '''Return a list of objects with image metadata'''
  if not kwargs['metadata']: return []
  # handle csv metadata
  l = []
  if kwargs['metadata'].endswith('.csv'):
    with open(kwargs['metadata']) as f:
      reader = csv.reader(f)
      headers = [i.lower() for i in next(reader)]
      for i in reader:
        l.append({headers[j]: i[j] if i[j] else '' for j, _ in enumerate(headers)})
  # handle json metadata
  else:
    for i in glob2.glob(kwargs['metadata']):
      with open(i) as f:
        l.append(json.load(f))
  # if the user provided a category but not a tag, use the category as the tag
  for i in l:
    if i.get('category', False) and not i.get('tags', False):
      i.update({'tags': i['category']})
  return l


def write_metadata(metadata, **kwargs):
  '''Write list `metadata` of objects to disk'''
  if not metadata: return
  out_dir = join(kwargs['out_dir'], 'metadata')
  for i in ['filters', 'options', 'file']:
    out_path = join(out_dir, i)
    if not exists(out_path): os.makedirs(out_path)
  # create the lists of images with each tag
  d = defaultdict(list)
  for i in metadata:
    filename = clean_filename(i['filename'])
    i['tags'] = [j.strip() for j in i.get('tags', '').split('|')]
    for j in i['tags']: d[ '__'.join(j.split()) ].append(filename)
    write_json(os.path.join(out_dir, 'file', filename + '.json'), i, **kwargs)
  write_json(os.path.join(out_dir, 'filters', 'filters.json'), [{
    'filter_name': 'select',
    'filter_values': list(d.keys()),
  }], **kwargs)
  # create the options for the category dropdown
  for i in d:
    write_json(os.path.join(out_dir, 'options', i + '.json'), d[i], **kwargs)
  # create the map from date to images with that date (if dates present)
  date_d = defaultdict(list)
  for i in metadata:
    date = i.get('year', '')
    if date:
      date_d[date].append(clean_filename(i['filename']))
  # find the min and max dates to show on the date slider
  dates = np.array([int(i.strip()) for i in date_d if is_number(i)])
  domain = {'min': float('inf'), 'max': -float('inf')}
  mean = np.mean(dates)
  std = np.std(dates)
  for i in dates:
    # update the date domain with all non-outlier dates
    if abs(mean-i) < (std*4):
      domain['min'] = int(min(i, domain['min']))
      domain['max'] = int(max(i, domain['max']))
  # write the dates json
  if len(date_d) > 1:
    write_json(os.path.join(out_dir, 'dates.json'), {
      'domain': domain,
      'dates': date_d,
    }, **kwargs)


def is_number(s):
  '''Return a boolean indicating if a string is a number'''
  try:
    int(s)
    return True
  except:
    return False


##
# Main
##


def get_manifest(**kwargs):
  '''Create and return the base object for the manifest output file'''
  # load the atlas data
  atlas_data = json.load(open(join(kwargs['atlas_dir'], 'atlas_positions.json')))
  # store each cell's size and atlas position
  atlas_ids = set([i['idx'] for i in atlas_data])
  sizes = [[] for _ in atlas_ids]
  pos = [[] for _ in atlas_ids]
  for idx, i in enumerate(atlas_data):
    sizes[ i['idx'] ].append([ i['w'], i['h'] ])
    pos[ i['idx'] ].append([ i['x'], i['y'] ])
  # obtain the paths to each layout's JSON positions
  layouts = get_layouts(**kwargs)
  # create a heightmap for the umap layout
  if 'umap' in layouts and layouts['umap']:
    get_heightmap(layouts['umap']['layout'], 'umap', **kwargs)
  # specify point size scalars
  point_sizes = {}
  point_sizes['min'] = 0
  point_sizes['grid'] = 1 / math.ceil(len(kwargs['image_paths'])**(1/2))
  point_sizes['max'] = point_sizes['grid'] * 1.2
  point_sizes['scatter'] = point_sizes['grid'] * .2
  point_sizes['initial'] = point_sizes['scatter']
  # fetch the date distribution data for point sizing
  if 'date' in layouts and layouts['date']:
    date_layout = read_json(layouts['date']['labels'], **kwargs)
    point_sizes['date'] = 1 / ((date_layout['cols']+1) * len(date_layout['labels']))
  # create manifest json
  manifest = {
    'version': get_version(),
    'plot_id': kwargs['plot_id'],
    'layouts': layouts,
    'initial_layout': 'umap',
    'point_sizes': point_sizes,
    'imagelist': get_path('imagelists', 'imagelist', **kwargs),
    'atlas_dir': kwargs['atlas_dir'],
    'metadata': True if kwargs['metadata'] else False,
    'default_hotspots': get_hotspots(vecs=read_json(layouts['umap']['layout'], **kwargs), **kwargs),
    'custom_hotspots': get_path('hotspots', 'user_hotspots', add_hash=False, **kwargs),
    'config': {
      'sizes': {
        'atlas': kwargs['atlas_size'],
        'cell': kwargs['cell_size'],
        'lod': kwargs['lod_cell_height'],
      },
    },
    'creation_date': datetime.datetime.today().strftime('%d-%B-%Y-%H:%M:%S'),
  }
  path = get_path('manifests', 'manifest', **kwargs)
  write_json(path, manifest, **kwargs)
  path = get_path(None, 'manifest', add_hash=False, **kwargs)
  write_json(path, manifest, **kwargs)
  # create images json
  imagelist = {
    'cell_sizes': sizes,
    'images': [clean_filename(i) for i in kwargs['image_paths']],
    'atlas': {
      'count': len(atlas_ids),
      'positions': pos,
    },
  }
  write_json(manifest['imagelist'], imagelist)


##
# Atlases
##


def get_atlas_data(**kwargs):
  '''
  Generate and save to disk all atlases to be used for this visualization
  If square, center each cell in an nxn square, else use uniform height
  '''
  # if the atlas files already exist, load from cache
  out_dir = os.path.join(kwargs['out_dir'], 'atlases', kwargs['plot_id'])
  if os.path.exists(out_dir) and kwargs['use_cache'] and not kwargs.get('shuffle', False):
    print(' * loading saved atlas data')
    return out_dir
  if not os.path.exists(out_dir):
    os.makedirs(out_dir)
  # else create the atlas images and store the positions of cells in atlases
  print(' * creating atlas files')
  n = 0 # number of atlases
  x = 0 # x pos in atlas
  y = 0 # y pos in atlas
  positions = [] # l[cell_idx] = atlas data
  atlas = np.zeros((kwargs['atlas_size'], kwargs['atlas_size'], 3))
  for idx, i in enumerate(stream_images(**kwargs)):
    if kwargs['square_cells']:
      cell_data = i.resize_to_square(kwargs['cell_size'])
    else:
      cell_data = i.resize_to_height(kwargs['cell_size'])
    _, v, _ = cell_data.shape
    appendable = False
    if (x + v) <= kwargs['atlas_size']:
      appendable = True
    elif (y + (2*kwargs['cell_size'])) <= kwargs['atlas_size']:
      y += kwargs['cell_size']
      x = 0
      appendable = True
    if not appendable:
      save_atlas(atlas, out_dir, n)
      n += 1
      atlas = np.zeros((kwargs['atlas_size'], kwargs['atlas_size'], 3))
      x = 0
      y = 0
    atlas[y:y+kwargs['cell_size'], x:x+v] = cell_data
    # find the size of the cell in the lod canvas
    lod_data = i.resize_to_max(kwargs['lod_cell_height'])
    h,w,_ = lod_data.shape # h,w,colors in lod-cell sized image `i`
    positions.append({
      'idx': n, # atlas idx
      'x': x, # x offset of cell in atlas
      'y': y, # y offset of cell in atlas
      'w': w, # w of cell at lod size
      'h': h, # h of cell at lod size
    })
    x += v
  save_atlas(atlas, out_dir, n)
  out_path = os.path.join(out_dir, 'atlas_positions.json')
  with open(out_path, 'w') as out:
    json.dump(positions, out)
  return out_dir


def save_atlas(atlas, out_dir, n):
  '''Save an atlas to disk'''
  out_path = join(out_dir, 'atlas-{}.jpg'.format(n))
  save_img(out_path, atlas)

##
# Layouts
##


def get_layouts(**kwargs):
  '''Get the image positions in each projection'''
  vecs = vectorize_images(**kwargs)
  umap = get_umap_layout(vecs=vecs, **kwargs)
  try:
    linear_assignment = get_lap_layout(umap=umap, **kwargs)
  except:
    linear_assignment = get_rasterfairy_layout(umap=umap, **kwargs)
  alphabetic = get_alphabetic_layout(**kwargs)
  umap_jittered = get_pointgrid_layout(umap, 'umap', **kwargs)
  categorical = get_categorical_layout(**kwargs)
  date = get_date_layout(**kwargs)
  layouts = {
    'umap': {
      'layout': umap,
      'jittered': umap_jittered,
    },
    'alphabetic': {
      'layout': alphabetic,
    },
    'grid': {
      'layout': linear_assignment,
    },
    'categorical': categorical,
    'date': date,
  }
  return layouts


def vectorize_images(**kwargs):
  '''Create and return vector representation of Image() instances'''
  print(' * preparing to vectorize {} images'.format(len(kwargs['image_paths'])))
  vector_dir = os.path.join(kwargs['out_dir'], 'image-vectors')
  if not os.path.exists(vector_dir): os.makedirs(vector_dir)
  base = InceptionV3(include_top=True, weights='imagenet',)
  model = Model(inputs=base.input, outputs=base.get_layer('avg_pool').output)
  print(' * creating image array')
  vecs = []
  for idx, i in enumerate(stream_images(**kwargs)):
    vector_path = os.path.join(vector_dir, os.path.basename(i.path) + '.npy')
    if os.path.exists(vector_path) and kwargs['use_cache']:
      vec = np.load(vector_path)
    else:
      im = preprocess_input( img_to_array( i.original.resize((299,299)) ) )
      vec = model.predict(np.expand_dims(im, 0)).squeeze()
      np.save(vector_path, vec)
    vecs.append(vec)
    print(' * vectorized {}/{} images'.format(idx+1, len(kwargs['image_paths'])))
  return np.array(vecs)


def get_umap_layout(**kwargs):
  '''Get the x,y positions of images passed through a umap projection'''
  print(' * creating UMAP layout')
  out_path = get_path('layouts', 'umap', **kwargs)
  if os.path.exists(out_path) and kwargs['use_cache']: return out_path
  model = UMAP(n_neighbors=kwargs['n_neighbors'],
    min_dist=kwargs['min_distance'],
    metric=kwargs['metric'])
  # run PCA to reduce dimensionality of image vectors
  w = PCA(n_components=min(100, len(kwargs['vecs']))).fit_transform(kwargs['vecs'])
  # fetch categorical labels for images (if provided)
  y = []
  if kwargs.get('metadata', False):
    labels = [i.get('label', None) for i in kwargs['metadata']]
    # if the user provided labels, integerize them
    if any([i for i in labels]):
      d = defaultdict(lambda: len(d))
      for i in labels:
        if i == None: y.append(-1)
        else: y.append(d[i])
      y = np.array(y)
  # project the PCA space down to 2d for visualization
  z = model.fit(w, y=y if np.any(y) else None).embedding_
  return write_layout(out_path, z, **kwargs)


def get_tsne_layout(**kwargs):
  '''Get the x,y positions of images passed through a TSNE projection'''
  print(' * creating TSNE layout with ' + str(multiprocessing.cpu_count()) + ' cores...')
  out_path = get_path('layouts', 'tsne', **kwargs)
  if os.path.exists(out_path) and kwargs['use_cache']: return out_path
  model = TSNE(perplexity=kwargs.get('perplexity', 2),n_jobs=multiprocessing.cpu_count())
  z = model.fit_transform(kwargs['vecs'])
  return write_layout(out_path, z, **kwargs)


def get_rasterfairy_layout(**kwargs):
  '''Get the x, y position of images passed through a rasterfairy projection'''
  print(' * creating rasterfairy layout')
  out_path = get_path('layouts', 'rasterfairy', **kwargs)
  if os.path.exists(out_path) and kwargs['use_cache']: return out_path
  umap = np.array(read_json(kwargs['umap'], **kwargs))
  umap = (umap + 1)/2 # scale 0:1
  try:
    umap = coonswarp.rectifyCloud(umap, # stretch the distribution
      perimeterSubdivisionSteps=4,
      autoPerimeterOffset=False,
      paddingScale=1.05)
  except:
    print(' * coonswarp rectification could not be performed')
  pos = rasterfairy.transformPointCloud2D(umap)[0]
  return write_layout(out_path, pos, **kwargs)


def get_lap_layout(**kwargs):
  print(' * creating linear assignment layout')
  out_path = get_path('layouts', 'assignment', **kwargs)
  if os.path.exists(out_path) and kwargs['use_cache']: return out_path
  # load the umap layout
  umap = np.array(read_json(kwargs['umap'], **kwargs))
  umap = (umap + 1)/2 # scale 0:1
  # determine length of each side in square grid
  side = math.ceil(umap.shape[0]**(1/2))
  # create square grid 0:1 in each dimension
  grid_x, grid_y = np.meshgrid(np.linspace(0, 1, side), np.linspace(0, 1, side))
  grid = np.dstack((grid_x, grid_y)).reshape(-1, 2)
  # compute pairwise distance costs
  cost = cdist(grid, umap, 'sqeuclidean')
  # increase cost
  cost = cost * (10000000. / cost.max())
  # run the linear assignment
  min_cost, row_assignments, col_assignments = lap.lapjv(np.copy(cost), extend_cost=True)
  # use the assignment vals to determine gridified positions of `arr`
  pos = grid[col_assignments]
  return write_layout(out_path, pos, **kwargs)


def get_alphabetic_layout(**kwargs):
  '''Get the x,y positions of images in a grid projection'''
  print(' * creating grid layout')
  out_path = get_path('layouts', 'grid', **kwargs)
  if os.path.exists(out_path) and kwargs['use_cache']: return out_path
  paths = kwargs['image_paths']
  n = math.ceil(len(paths)**(1/2))
  l = [] # positions
  for i, _ in enumerate(paths):
    x = i%n
    y = math.floor(i/n)
    l.append([x, y])
  z = np.array(l)
  return write_layout(out_path, z, **kwargs)


def get_pointgrid_layout(path, label, **kwargs):
  '''Gridify the positions in `path` and return the path to this new layout'''
  print(' * creating {} pointgrid'.format(label))
  out_path = get_path('layouts', label + '-jittered', **kwargs)
  if os.path.exists(out_path) and kwargs['use_cache']: return out_path
  arr = np.array(read_json(path, **kwargs))
  z = align_points_to_grid(arr, fill=0.025)
  return write_layout(out_path, z, **kwargs)


##
# Date layout
##


def get_date_layout(cols=3, bin_units='years', **kwargs):
  '''
  Get the x,y positions of input images based on their dates
  @param int cols: the number of columns to plot for each bar
  @param str bin_units: the temporal units to use when creating bins
  '''
  date_vals = [kwargs['metadata'][i].get('year', False) for i in range(len(kwargs['metadata']))]
  if not kwargs['metadata'] or not any(date_vals): return False
  # if the data layouts have been cached, return them
  positions_out_path = get_path('layouts', 'timeline', **kwargs)
  labels_out_path = get_path('layouts', 'timeline-labels', **kwargs)
  if os.path.exists(positions_out_path) and \
     os.path.exists(labels_out_path) and \
     kwargs['use_cache']:
    return {
      'layout': positions_out_path,
      'labels': labels_out_path,
    }
  # date layout is not cached, so fetch dates and process
  print(' * creating date layout with {} columns'.format(cols))
  datestrings = [i.metadata.get('year', 'no_date') for i in stream_images(**kwargs)]
  dates = [datestring_to_date(i) for i in datestrings]
  rounded_dates = [round_date(i, bin_units) for i in dates]
  # create d[formatted_date] = [indices into datestrings of dates that round to formatted_date]
  d = defaultdict(list)
  for idx, i in enumerate(rounded_dates):
    d[i].append(idx)
  # determine the number of distinct grid positions in the x and y axes
  n_coords_x = (cols+1)*len(d)
  n_coords_y = 1 + max([len(d[i]) for i in d]) // cols
  if n_coords_y > n_coords_x: return get_date_layout(cols=int(cols*2), **kwargs)
  # create a mesh of grid positions in clip space -1:1 given the time distribution
  grid_x = (np.arange(0,n_coords_x)/(n_coords_x-1))*2
  grid_y = (np.arange(0,n_coords_y)/(n_coords_x-1))*2
  # divide each grid axis by half its max length to center at the origin 0,0
  grid_x = grid_x - np.max(grid_x)/2.0
  grid_y = grid_y - np.max(grid_y)/2.0
  # make dates increase from left to right by sorting keys of d
  d_keys = np.array(list(d.keys()))
  seconds = np.array([date_to_seconds(dates[ d[i][0] ]) for i in d_keys])
  d_keys = d_keys[np.argsort(seconds)]
  # determine which images will fill which units of the grid established above
  coords = np.zeros((len(datestrings), 2)) # 2D array with x, y clip-space coords of each date
  for jdx, j in enumerate(d_keys):
    for kdx, k in enumerate(d[j]):
      x = jdx*(cols+1) + (kdx%cols)
      y = kdx // cols
      coords[k] = [grid_x[x], grid_y[y]]
  # find the positions of labels
  label_positions = np.array([ [ grid_x[i*(cols+1)], grid_y[0] ] for i in range(len(d)) ])
  # move the labels down in the y dimension by a grid unit
  dx = (grid_x[1]-grid_x[0]) # size of a single cell
  label_positions[:,1] = label_positions[:,1] - dx
  # quantize the label positions and label positions
  image_positions = round_floats(coords)
  label_positions = round_floats(label_positions.tolist())
  # write and return the paths to the date based layout
  return {
    'layout': write_json(positions_out_path, image_positions, **kwargs),
    'labels': write_json(labels_out_path, {
      'positions': label_positions,
      'labels': d_keys.tolist(),
      'cols': cols,
    }, **kwargs),
  }


def datestring_to_date(datestring):
  '''
  Given a string representing a date return a datetime object
  '''
  try:
    return parse_date(str(datestring), fuzzy=True, default=datetime.datetime(9999, 1, 1))
  except Exception as exc:
    print(' * could not parse datestring {}'.format(datestring))
    return datestring


def date_to_seconds(date):
  '''
  Given a datetime object return an integer representation for that datetime
  '''
  if isinstance(date, datetime.datetime):
    return (date - datetime.datetime.today()).total_seconds()
  else:
    return - float('inf')


def round_date(date, unit):
  '''
  Return `date` truncated to the temporal unit specified in `units`
  '''
  if not isinstance(date, datetime.datetime): return 'no_date'
  formatted = date.strftime('%d %B %Y -- %X')
  if unit in set(['seconds', 'minutes', 'hours']):
    date = formatted.split('--')[1].strip()
    if unit == 'seconds': date = date
    elif unit == 'minutes': date = ':'.join(d.split(':')[:-1]) + ':00'
    elif unit == 'hours': date = date.split(':')[0] + ':00:00'
  elif unit in set(['days', 'months', 'years', 'decades', 'centuries']):
    date = formatted.split('--')[0].strip()
    if unit == 'days': date = date
    elif unit == 'months': date = ' '.join(date.split()[1:])
    elif unit == 'years': date = date.split()[-1]
    elif unit == 'decades': date = str(int(date.split()[-1])//10) + '0'
    elif unit == 'centuries': date = str(int(date.split()[-1])//100) + '00'
  return date


##
# Metadata layout
##


def get_categorical_layout(null_category='Other', margin=2, **kwargs):
  '''
  Return a numpy array with shape (n_points, 2) with the point
  positions of observations in box regions determined by
  each point's category metadata attribute (if applicable)
  '''
  if not kwargs.get('metadata', False): return False
  # determine the out path and return from cache if possible
  out_path = get_path('layouts', 'categorical', **kwargs)
  labels_out_path = get_path('layouts', 'categorical-labels', **kwargs)
  if os.path.exists(out_path): return out_path
  # accumulate d[category] = [indices of points with category]
  categories = [i.get('category', None) for i in kwargs['metadata']]
  if not any(categories): return False
  d = defaultdict(list)
  for idx, i in enumerate(categories): d[i].append(idx)
  # store the number of observations in each group
  keys_and_counts = [{'key': i, 'count': len(d[i])} for i in d]
  keys_and_counts.sort(key=operator.itemgetter('count'), reverse=True)
  # get the box layout then subdivide into discrete points
  boxes = get_categorical_boxes([i['count'] for i in keys_and_counts], margin=margin)
  points = get_categorical_points(boxes)
  # sort the points into the order of the observations in the metadata
  counts = {i['key']: 0 for i in keys_and_counts}
  offsets = {i['key']: 0 for i in keys_and_counts}
  for idx, i in enumerate(keys_and_counts):
    offsets[i['key']] += sum([j['count'] for j in keys_and_counts[:idx]])
  sorted_points = []
  for idx, i in enumerate(stream_images(**kwargs)):
    category = i.metadata.get('category', null_category)
    sorted_points.append(points[ offsets[category] + counts[category] ])
    counts[category] += 1
  sorted_points = np.array(sorted_points)
  # add to the sorted points the anchors for the text labels for each group
  text_anchors = np.array([[i.x, i.y-margin/2] for i in boxes])
  # add the anchors to the points - these will be removed after the points are projected
  sorted_points = np.vstack([sorted_points, text_anchors])
  # scale -1:1 using the largest axis as the scaling metric
  _max = np.max(sorted_points)
  for i in range(2):
    _min = np.min(sorted_points[:,i])
    sorted_points[:,i] -= _min
    sorted_points[:,i] /= (_max-_min)
    sorted_points[:,i] -= np.max(sorted_points[:,i])/2
    sorted_points[:,i] *= 2
  # separate out the sorted points and text positions
  text_anchors = sorted_points[-len(text_anchors):]
  sorted_points = sorted_points[:-len(text_anchors)]
  z = round_floats(sorted_points.tolist())
  return {
    'layout': write_json(out_path, z, **kwargs),
    'labels': write_json(labels_out_path, {
      'positions': round_floats(text_anchors.tolist()),
      'labels': [i['key'] for i in keys_and_counts],
    }, **kwargs)
  }


def get_categorical_boxes(group_counts, margin=2):
  '''
  @arg [int] group_counts: counts of the number of images in each
    distinct level within the metadata's caetgories
  @kwarg int margin: space between boxes in the 2D layout
  @returns [Box] an array of Box() objects; one per level in `group_counts`
  '''
  boxes = []
  for i in group_counts:
    x = y = math.ceil(i**(1/2))
    boxes.append(Box(i, x, y, None, None))
  # find the position along x axis where we want to create a break
  wrap = sum([i.cells for i in boxes])**(1/2)
  # find the valid positions on the y axis
  y = margin
  y_spots = []
  for idx, i in enumerate(boxes):
    if (y + i.h) < wrap:
      y_spots.append(y)
      y += i.h+margin
  y_spot_index = 0
  for idx, i in enumerate(boxes):
    # find the y position
    y = y_spots[y_spot_index]
    # find members with this y position
    row_members = [j.x + j.w for j in boxes if j.y == y]
    # assign the y position
    i.y = y
    y_spot_index = (y_spot_index + 1) % len(y_spots)
    # assign the x position
    i.x = max(row_members) + margin if row_members else margin
  return boxes


def get_categorical_points(arr, unit_size=None):
  '''Given an array of Box() objects, return a 2D distribution with shape (n_cells, 2)'''
  points_arr = []
  for i in arr:
    area = i.w*i.h
    per_unit = (area / i.cells)**(1/2)
    x_units = math.ceil(i.w / per_unit)
    y_units = math.ceil(i.h / per_unit)
    if not unit_size: unit_size = min(i.w/x_units, i.h/y_units)
    for j in range(i.cells):
      x = j%x_units
      y = j//x_units
      points_arr.append([
        i.x+x*unit_size,
        i.y+y*unit_size,
      ])
  return np.array(points_arr)


class Box:
  '''Store the width, height, and x, y coords of a box'''
  def __init__(self, *args):
    self.cells = args[0]
    self.w = args[1]
    self.h = args[2]
    self.x = None if len(args) < 4 else args[3]
    self.y = None if len(args) < 5 else args[4]


##
# Helpers
##


def get_path(*args, **kwargs):
  '''Return the path to a JSON file with conditional gz extension'''
  sub_dir, filename = args
  out_dir = join(kwargs['out_dir'], sub_dir) if sub_dir else kwargs['out_dir']
  if kwargs.get('add_hash', True):
    filename += '-' + kwargs['plot_id']
  path = join(out_dir, filename + '.json')
  return path + '.gz' if kwargs.get('gzip', False) else path


def write_layout(path, obj, **kwargs):
  '''Write layout json `obj` to disk and return the path to the saved file'''
  obj = (minmax_scale(obj)-0.5)*2 # scale -1:1
  obj = round_floats(obj)
  return write_json(path, obj, **kwargs)


def round_floats(obj, digits=5):
  '''Return 2D array obj with rounded float precision'''
  return [[round(float(j), digits) for j in i] for i in obj]


def write_json(path, obj, **kwargs):
  '''Write json object `obj` to disk and return the path to that file'''
  out_dir, filename = os.path.split(path)
  if not os.path.exists(out_dir): os.makedirs(out_dir)
  if kwargs.get('gzip', False):
    with gzip.GzipFile(path, 'w') as out:
      out.write(json.dumps(obj, indent=4).encode(kwargs['encoding']))
    return path
  else:
    with open(path, 'w') as out:
      json.dump(obj, out, indent=4)
    return path


def read_json(path, **kwargs):
  '''Read and return the json object written by the current process at `path`'''
  if kwargs.get('gzip', False):
    with gzip.GzipFile(path, 'r') as f:
      return json.loads(f.read().decode(kwargs['encoding']))
  with open(path) as f:
    return json.load(f)


def get_hotspots(**kwargs):
  '''Return the stable clusters from the condensed tree of connected components from the density graph'''
  print(' * HDBSCAN clustering data with ' + str(multiprocessing.cpu_count()) + ' cores...')
  config = {
    'core_dist_n_jobs': multiprocessing.cpu_count(),
    'min_cluster_size': kwargs['min_cluster_size'],
    'cluster_selection_epsilon': 0.01,
    'min_samples': 1,
    'approx_min_span_tree': False,
  }
  v = kwargs['vecs']
  z = HDBSCAN(**config).fit(v)
  # create a map from cluster label to image indices in cluster
  d = defaultdict(lambda: defaultdict(list))
  for idx, i in enumerate(z.labels_):
    d[i]['images'].append(idx)
  # find the convex hull for each cluster's points
  for i in d:
    positions = np.array([v[j] for j in d[i]['images']])
    hull = ConvexHull(positions)
    points = [hull.points[j] for j in hull.vertices]
    # the last convex hull simplex needs to connect back to the first point
    d[i]['convex_hull'] = np.vstack([points, points[0]]).tolist()
  # find the centroids for each cluster
  centroids = []
  for i in d:
    positions = np.array([v[j] for j in d[i]['images']])
    x, y = np.array(positions).T
    d[i]['centroid'] = np.array([np.mean(x), np.mean(y)]).tolist()
    # find the image closest to the centroid
    closest, _ = pairwise_distances_argmin_min(np.array([d[i]['centroid']]), v)
    d[i]['img'] = os.path.basename(kwargs['image_paths'][closest[0]])
  # remove massive clusters
  deletable = []
  for i in d:
    # find percent of images in cluster
    image_percent = len(d[i]['images']) / len(v)
    # find percent of plot area in cluster
    x, y = np.array(d[i]['convex_hull']).T
    area_percent = 0.5 * np.abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
    # determine if image or area percent is too large
    if image_percent > 0.5 or area_percent > 0.3:
      deletable.append(i)
  for i in deletable: del d[i]
  # sort the clusers by size and then label the clusters
  clusters = d.values()
  clusters = sorted(clusters, key=lambda i: len(i['images']), reverse=True)
  for idx, i in enumerate(clusters):
    i['label'] = 'Cluster {}'.format(idx+1)
  # save the hotspots to disk and return the path to the saved json
  print(' * found', len(clusters), 'hotspots')
  return write_json(get_path('hotspots', 'hotspot', **kwargs), clusters, **kwargs)


def get_heightmap(path, label, **kwargs):
  '''Create a heightmap using the distribution of points stored at `path`'''
  X = read_json(path, **kwargs)
  if 'positions' in X: X = X['positions']
  X = np.array(X)
  # create kernel density estimate of distribution X
  nbins = 200
  x, y = X.T
  xi, yi = np.mgrid[x.min():x.max():nbins*1j, y.min():y.max():nbins*1j]
  zi = kde.gaussian_kde(X.T)(np.vstack([xi.flatten(), yi.flatten()]))
  # create the plot
  fig, ax = plt.subplots(nrows=1, ncols=1, figsize=(5,5))
  fig.subplots_adjust(0,0,1,1)
  plt.pcolormesh(xi, yi, zi.reshape(xi.shape), shading='gouraud', cmap=plt.cm.gray)
  plt.axis('off')
  # save the plot
  out_dir = os.path.join(kwargs['out_dir'], 'heightmaps')
  if not os.path.exists(out_dir): os.makedirs(out_dir)
  out_path = os.path.join(out_dir, label + '-heightmap.png')
  plt.savefig(out_path, pad_inches=0)


def write_images(**kwargs):
  '''Write all originals and thumbs to the output dir'''
  for i in stream_images(**kwargs):
    filename = clean_filename(i.path)
    # copy original for lightbox
    out_dir = join(kwargs['out_dir'], 'originals')
    if not exists(out_dir): os.makedirs(out_dir)
    out_path = join(out_dir, filename)
    shutil.copy(i.path, out_path)
    # copy thumb for lod texture
    out_dir = join(kwargs['out_dir'], 'thumbs')
    if not exists(out_dir): os.makedirs(out_dir)
    out_path = join(out_dir, filename)
    img = array_to_img(i.resize_to_max(kwargs['lod_cell_height']))
    save_img(out_path, img)


def get_version():
  '''Return the version of pixplot installed'''
  return pkg_resources.get_distribution('pixplot').version


class Image:
  def __init__(self, *args, **kwargs):
    self.path = args[0]
    self.original = load_img(self.path)
    self.metadata = kwargs['metadata']

  def resize_to_max(self, n):
    '''
    Resize self.original so its longest side has n pixels (maintain proportion)
    '''
    w,h = self.original.size
    size = (n, int(n * h/w)) if w > h else (int(n * w/h), n)
    return img_to_array(self.original.resize(size))

  def resize_to_height(self, height):
    '''
    Resize self.original into an image with height h and proportional width
    '''
    w,h = self.original.size
    if (w/h*height) < 1:
      resizedwidth = 1
    else:
      resizedwidth =  int(w/h*height)
    size = (resizedwidth, height)
    return img_to_array(self.original.resize(size))

  def resize_to_square(self, n, center=False):
    '''
    Resize self.original to an image with nxn pixels (maintain proportion)
    if center, center the colored pixels in the square, else left align
    '''
    a = self.resize_to_max(n)
    h,w,c = a.shape
    pad_lr = int((n-w)/2) # left right pad
    pad_tb = int((n-h)/2) # top bottom pad
    b = np.zeros((n,n,3))
    if center: b[ pad_tb:pad_tb+h, pad_lr:pad_lr+w, : ] = a
    else: b[:h, :w, :] = a
    return b


##
# Entry Point
##


def parse():
  '''Read command line args and begin data processing'''
  description = 'Generate the data required to create a PixPlot viewer'
  parser = argparse.ArgumentParser(description=description, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
  parser.add_argument('--images', type=str, default=config['images'], help='path to a glob of images to process', required=False)
  parser.add_argument('--metadata', type=str, default=config['metadata'], help='path to a csv or glob of JSON files with image metadata (see readme for format)', required=False)
  parser.add_argument('--max_images', type=int, default=config['max_images'], help='maximum number of images to process from the input glob', required=False)
  parser.add_argument('--use_cache', type=bool, default=config['use_cache'], help='given inputs identical to prior inputs, load outputs from cache', required=False)
  parser.add_argument('--encoding', type=str, default=config['encoding'], help='the encoding of input metadata', required=False)
  parser.add_argument('--min_cluster_size', type=int, default=config['min_cluster_size'], help='the minimum number of images in a cluster', required=False)
  parser.add_argument('--out_dir', type=str, default=config['out_dir'], help='the directory to which outputs will be saved', required=False)
  parser.add_argument('--cell_size', type=int, default=config['cell_size'], help='the size of atlas cells in px', required=False)
  parser.add_argument('--n_neighbors', type=int, default=config['n_neighbors'], help='the n_neighbors argument for UMAP')
  parser.add_argument('--min_distance', type=float, default=config['min_distance'], help='the min_distance argument for umap')
  parser.add_argument('--metric', type=str, default=config['metric'], help='the metric argument for umap')
  parser.add_argument('--pointgrid_fill', type=float, default=config['pointgrid_fill'], help='float 0:1 that determines sparsity of jittered distributions (lower means more sparse)')
  parser.add_argument('--copy_web_only', action='store_true', help='update ./output/web without reprocessing data')
  parser.add_argument('--gzip', action='store_true', help='save outputs with gzip compression')
  parser.add_argument('--shuffle', action='store_true', help='shuffle the input images before data processing begins')
  parser.add_argument('--plot_id', type=str, default=config['plot_id'], help='unique id for a plot; useful for resuming processing on a started plot')
  parser.add_argument('--seed', type=int, default=config['seed'], help='seed for random processes')
  config.update(vars(parser.parse_args()))
  process_images(**config)

if __name__ == '__main__':
  parse()
