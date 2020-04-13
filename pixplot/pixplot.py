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
from distutils.dir_util import copy_tree
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
import argparse
import random
import shutil
import glob2
import copy
import uuid
import math
import gzip
import json
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
  'use_cache': True,
  'encoding': 'utf8',
  'min_cluster_size': 20,
  'atlas_size': 2048,
  'cell_size': 32,
  'lod_cell_height': 128,
  'n_neighbors': 6,
  'min_dist': 0.001,
  'metric': 'correlation',
  'pointgrid_fill': 0.05,
  'square_cells': False,
  'gzip': False,
  'plot_id': str(uuid.uuid1()),
}


##
# Entry
##


def process_images(**kwargs):
  '''Main method for processing user images and metadata'''
  copy_web_assets(**kwargs)
  kwargs['out_dir'] = join(kwargs['out_dir'], 'data')
  image_paths, metadata = filter_images(**kwargs)
  kwargs['image_paths'] = image_paths
  kwargs['metadata'] = metadata
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
    return [image_paths, []]
  # handle user metadata: retain only records with image and metadata
  l = get_metadata_list(**kwargs)
  img_bn = set([clean_filename(i) for i in image_paths])
  meta_bn = set([clean_filename(i.get('filename', '')) for i in l])
  both = img_bn.intersection(meta_bn)
  no_meta = list(img_bn - meta_bn)
  if no_meta:
    print(' ! Some images are missing metadata:\n  -', '\n  - '.join(no_meta[:10]))
    if len(no_meta) > 10: print(' ...', len(no_meta)-10, 'more')
    with open('missing-metadata.txt', 'w') as out: out.write('\n'.join(no_meta))
  # get the sorted lists of images and metadata
  d = {clean_filename(i['filename']): i for i in l}
  metadata = []
  images = []
  for i in image_paths:
    if clean_filename(i) in both:
      metadata.append(d[clean_filename(i)])
      images.append(i)
  kwargs['metadata'] = metadata
  write_metadata(**kwargs)
  return [images, metadata]


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
      print(' * image', i, 'could not be processed', exc)


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
    headers = ['filename', 'tags', 'description', 'permalink', 'date']
    with open(kwargs['metadata']) as f:
      rows = list(csv.reader(f))
      while len(rows[0]) < len(headers):
        headers = headers[:-1]
      for i in rows:
        l.append({headers[j]: i[j] if i[j] else '' for j,_ in enumerate(headers)})
  # handle json metadata
  else:
    for i in glob2.glob(kwargs['metadata']):
      with open(i) as f:
        l.append(json.load(f))
  return l


def write_metadata(metadata, **kwargs):
  if not metadata: return
  out_dir = join(kwargs['out_dir'], 'metadata')
  for i in ['filters', 'options', 'file']:
    out_path = join(out_dir, i)
    if not exists(out_path): os.makedirs(out_path)
  # create the lists of images with each tag
  d = defaultdict(list)
  for i in metadata:
    filename = clean_filename(i['filename'])
    tags = [j.strip() for j in i['tags'].split('|')]
    i['tags'] = tags
    for j in tags: d[ '__'.join(j.split()) ].append(filename)
    write_json(os.path.join(out_dir, 'file', filename + '.json'), i, **kwargs)
  write_json(os.path.join(out_dir, 'filters', 'filters.json'), [{
    'filter_name': 'select',
    'filter_values': list(d.keys()),
  }], **kwargs)
  # create the options for the tag dropdown
  for i in d:
    write_json(os.path.join(out_dir, 'options', i + '.json'), d[i], **kwargs)
  # create the map from date to images with that date (if dates present)
  date_d = defaultdict(list)
  for i in metadata:
    date = i.get('date', '')
    if not date: continue
    image = clean_filename(i['filename'])
    date_d[date].append(image)
  # find the min and max dates to show on the date slider
  dates = []
  for i in date_d:
    try:
      dates.append(int(i))
    except:
      pass
  dates = np.array(dates)
  domain = {'min': float('inf'), 'max': -float('inf')}
  mean = np.mean(dates)
  std = np.std(dates)
  for i in dates:
    if abs(mean-i) < (std*4):
      domain['min'] = int(min(i, domain['min']))
      domain['max'] = int(max(i, domain['max']))
  # write the dates json
  if len(date_d) > 1:
    write_json(os.path.join(out_dir, 'dates.json'), {
      'domain': domain,
      'dates': date_d,
    }, **kwargs)


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
    'centroids': get_centroids(vecs=read_json(layouts['umap']['layout'], **kwargs), **kwargs),
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
  if os.path.exists(out_dir) and kwargs['use_cache']:
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
  raster = get_rasterfairy_layout(umap=umap, **kwargs)
  grid = get_grid_layout(**kwargs)
  umap_grid = get_pointgrid_layout(umap, 'umap', **kwargs)
  date = get_date_layout(**kwargs)
  layouts = {
    'umap': {
      'layout': umap,
      'jittered': umap_grid,
    },
    'grid': {
      'layout': grid,
    },
    'rasterfairy': {
      'layout': raster,
    },
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
    min_dist=kwargs['min_dist'],
    metric=kwargs['metric'])
  z = model.fit_transform(kwargs['vecs'])
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


def get_grid_layout(**kwargs):
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
  z = align_points_to_grid(arr)
  return write_layout(out_path, z, **kwargs)


def get_date_layout(cols=3, bin_units='years', **kwargs):
  '''
  Get the x,y positions of input images based on their dates
  @param int cols: the number of columns to plot for each bar
  @param str bin_units: the temporal units to use when creating bins
  '''
  if not kwargs['metadata'] or not kwargs['metadata'][0].get('date', False): return False
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
  datestrings = [i.metadata.get('date', 'no_date') for i in stream_images(**kwargs)]
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
  # move the labels down in the y dimension by a grid units
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
  obj = round_floats(obj, 5)
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
      out.write(json.dumps(obj).encode(kwargs['encoding']))
    return path
  else:
    with open(path, 'w') as out:
      json.dump(obj, out)
    return path


def read_json(path, **kwargs):
  '''Read and return the json object written by the current process at `path`'''
  if kwargs.get('gzip', False):
    with gzip.GzipFile(path, 'r') as f:
      return json.loads(f.read().decode(kwargs['encoding']))
  with open(path) as f:
    return json.load(f)


def get_centroids(**kwargs):
  '''Return the stable clusters from the condensed tree of connected components from the density graph'''
  print(' * HDBSCAN clustering data with ' + str(multiprocessing.cpu_count()) + ' cores...')
  config = {
    'min_cluster_size': kwargs['min_cluster_size'],
    'cluster_selection_epsilon': 0.01,
    'min_samples': 1,
    'core_dist_n_jobs': multiprocessing.cpu_count(),
  }
  z = HDBSCAN(**config).fit(kwargs['vecs'])
  # find the centroids for each cluster
  d = defaultdict(list)
  for idx, i in enumerate(z.labels_):
    d[i].append(kwargs['vecs'][idx])
  centroids = []
  for i in d:
    x, y = np.array(d[i]).T
    centroids.append(np.array([np.sum(x)/len(x), np.sum(y)/len(y)]))
  closest, _ = pairwise_distances_argmin_min(centroids, kwargs['vecs'])
  closest = set(closest)
  print(' * found', len(closest), 'clusters')
  paths = [kwargs['image_paths'][i] for i in closest]
  data = [{
    'img': clean_filename(paths[idx]),
    'label': 'Cluster {}'.format(idx+1),
  } for idx,i in enumerate(closest)]
  # save the centroids to disk and return the path to the saved json
  return write_json(get_path('centroids', 'centroid', **kwargs), data, **kwargs)


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
  parser.add_argument('--use_cache', type=bool, default=config['use_cache'], help='given inputs identical to prior inputs, load outputs from cache', required=False)
  parser.add_argument('--encoding', type=str, default=config['encoding'], help='the encoding of input metadata', required=False)
  parser.add_argument('--min_cluster_size', type=int, default=config['min_cluster_size'], help='the minimum number of images in a cluster', required=False)
  parser.add_argument('--out_dir', type=str, default=config['out_dir'], help='the directory to which outputs will be saved', required=False)
  parser.add_argument('--cell_size', type=int, default=config['cell_size'], help='the size of atlas cells in px', required=False)
  parser.add_argument('--n_neighbors', type=int, default=config['n_neighbors'], help='the n_neighbors argument for UMAP')
  parser.add_argument('--min_dist', type=float, default=config['min_dist'], help='the min_dist argument for umap')
  parser.add_argument('--metric', type=str, default=config['metric'], help='the metric argument for umap')
  parser.add_argument('--pointgrid_fill', type=float, default=config['pointgrid_fill'], help='float 0:1 that determines sparsity of jittered distributions (lower means more sparse)')
  parser.add_argument('--copy_web_only', action='store_true', help='update ./output/web without reprocessing data')
  parser.add_argument('--gzip', action='store_true', help='save outputs with gzip compression')
  parser.add_argument('--shuffle', action='store_true', help='shuffle the input images before data processing begins')
  parser.add_argument('--plot_id', type=str, default=config['plot_id'], help='unique id for a plot; useful for resuming processing on a started plot')
  config.update(vars(parser.parse_args()))
  process_images(**config)

if __name__ == '__main__':
  parse()
