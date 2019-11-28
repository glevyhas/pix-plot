from __future__ import division
import warnings; warnings.filterwarnings('ignore')
from keras.preprocessing.image import save_img, img_to_array, array_to_img
from keras.applications import Xception, VGG19, InceptionV3, imagenet_utils
from os.path import basename, join, exists, dirname, realpath
from keras.applications.inception_v3 import preprocess_input
from sklearn.metrics import pairwise_distances_argmin_min
from keras_preprocessing.image import load_img
from collections import defaultdict, Counter
from distutils.dir_util import copy_tree
from sklearn.cluster import KMeans
from keras.models import Model
from hashlib import sha224
import keras.backend as K
from umap import UMAP
import rasterfairy
import numpy as np
import distutils
import functools
import itertools
import datetime
import argparse
import shutil
import glob2
import uuid
import math
import gzip
import json
import sys
import csv
import os

try:
  from urllib.parse import unquote # python 3
except:
  from urllib import unquote # python 2


config = {
  'images': None,
  'metadata': None,
  'out_dir': 'output',
  'use_cache': False,
  'use_gzip': False,
  'encoding': 'utf8',
  'n_clusters': 20,
  'atlas_size': 2048,
  'lod_cell_height': 128,
  'atlas_cell_height': 32,
  'square_cells': False,
}

##
# Main
##

def process_images(**kwargs):
  '''Main method for processing user images and metadata'''
  copy_web_assets(**kwargs)
  kwargs['out_dir'] = join(kwargs['out_dir'], 'data')
  kwargs['image_paths'] = filter_images(**kwargs)
  kwargs['atlas_positions'] = get_atlas_positions(**kwargs)
  get_manifest(**kwargs)
  write_images(**kwargs)


def stream_images(*args, **kwargs):
  '''Read in all images from args[0], a list of image paths'''
  images = []
  for idx, i in enumerate(kwargs['image_paths']):
    yield Image(i)


def write_images(**kwargs):
  '''Write all originals and thumbs to the output dir'''
  for i in stream_images(**kwargs):
    # copy original for lightbox
    out_dir = join(kwargs['out_dir'], 'originals')
    if not exists(out_dir): os.makedirs(out_dir)
    out_path = join(out_dir, clean_filename(i.path))
    shutil.copy(i.path, out_path)
    # copy thumb for lod texture
    out_dir = join(kwargs['out_dir'], 'thumbs')
    if not exists(out_dir): os.makedirs(out_dir)
    out_path = join(out_dir, clean_filename(i.path))
    img = array_to_img(i.resize_to_max(kwargs['lod_cell_height']))
    save_img(out_path, img)


def get_manifest(**kwargs):
  '''Create and return the base object for the manifest output file'''
  atlas_ids = set([i['idx'] for i in kwargs['atlas_positions']])
  sizes = [[] for _ in atlas_ids]
  pos = [[] for _ in atlas_ids]
  for idx, i in enumerate(kwargs['atlas_positions']):
    sizes[ i['idx'] ].append([ i['w'], i['h'] ])
    pos[ i['idx'] ].append([ i['x'], i['y'] ])
  # create base metadata for manifest
  manifest = {
    'cell_sizes': sizes,
    'atlas': {
      'count': len(atlas_ids),
      'positions': pos,
    },
    'layouts': {},
    'config': {
      'sizes': {
        'atlas': kwargs['atlas_size'],
        'cell': kwargs['atlas_cell_height'],
        'lod': kwargs['lod_cell_height'],
      }
    },
    'images': [clean_filename(i) for i in kwargs['image_paths']],
    'metadata': True if kwargs['metadata'] else False,
    'creation_date': datetime.datetime.today().strftime('%d-%B-%Y-%H:%M:%S'),
  }
  # compute centroids for each layout and add to manifest
  for label, position_path in get_positions(**kwargs).items():
    out_dir = join(kwargs['out_dir'], 'centroids')
    if not exists(out_dir): os.makedirs(out_dir)
    centroid_path = join(out_dir, hash(**kwargs) + '.json')
    if not os.path.exists(centroid_path):
      vecs = json.load(open(position_path))
      centroids = get_centroids(vecs=vecs, **kwargs)
      with open(centroid_path, 'w') as out: json.dump(centroids, out)
    manifest['layouts'][label] = {
      'positions': '/' + position_path,
      'centroids': '/' + centroid_path,
    }
  out_dir = join(kwargs['out_dir'], 'manifests')
  if not exists(out_dir): os.makedirs(out_dir)
  path = join(out_dir, hash(**kwargs) + '.json')
  with open(path, 'w') as out: json.dump(manifest, out)
  path = join(kwargs['out_dir'], 'manifest.json')
  with open(path, 'w') as out: json.dump(manifest, out)
  return manifest


def filter_images(**kwargs):
  '''Main method for filtering images given user metadata (if provided)'''
  image_paths = glob2.glob(kwargs['images'])
  if not image_paths:
    print('\nError: No input images were found. Please check your --images glob')
    sys.exit()
  n_images = len(image_paths)
  n_clusters = kwargs['n_clusters']
  if n_images <= n_clusters:
    print('\nError: n_clusters must be < input image count ')
    print('Found {} images and {} clusters were requested'.format(n_images, n_clusters))
    sys.exit()
  if not kwargs.get('metadata', False): return image_paths
  l = []
  if kwargs['metadata'].endswith('.csv'):
    headers = ['filename', 'tags', 'description', 'permalink']
    with open(kwargs['metadata']) as f:
      for i in list(csv.reader(f)):
        l.append({headers[j]: i[j] for j,_ in enumerate(headers)})
  else:
    for i in glob2.glob(kwargs['metadata']):
      with open(i) as f:
        l.append(json.load(f))
  # retain only records with image and metadata
  img_bn = set([clean_filename(i) for i in image_paths])
  meta_bn = set([clean_filename(i.get('filename', '')) for i in l])
  both = img_bn.intersection(meta_bn)
  no_meta = list(img_bn - meta_bn)
  if no_meta:
    print(' ! Some images are missing metadata:\n  -', '\n  - '.join(no_meta[:10]))
    if len(no_meta) > 10: print(' ...', len(no_meta)-10, 'more')
    with open('missing-metadata.txt', 'w') as out: out.write('\n'.join(no_meta))
  kwargs['metadata'] = [i for i in l if clean_filename(i['filename']) in both]
  write_metadata(**kwargs)
  return [i for i in image_paths if clean_filename(i) in both]


def clean_filename(s):
  '''Given a string that points to a filename, return a clean filename'''
  return unquote(os.path.basename(s))


def write_metadata(**kwargs):
  if not kwargs.get('metadata', []): return
  out_dir = join(kwargs['out_dir'], 'metadata')
  for i in ['filters', 'options', 'file']:
    out_path = join(out_dir, i)
    if not exists(out_path): os.makedirs(out_path)
  # find images with each tag
  d = defaultdict(list)
  for i in kwargs['metadata']:
    filename = clean_filename(i['filename'])
    tags = [j.strip() for j in i['tags'].split('|')]
    i['tags'] = tags
    for j in tags: d[ '__'.join(j.split()) ].append(filename)
    out_path = os.path.join(out_dir, 'file', filename + '.json')
    with open(out_path, 'w') as out: json.dump(i, out)
  filters = [{'filter_name': 'select', 'filter_values': list(d.keys())}]
  with open(os.path.join(out_dir, 'filters', 'filters.json'), 'w') as out:
    json.dump(filters, out)
  # create the options
  for i in d:
    with open(os.path.join(out_dir, 'options', i + '.json'), 'w') as out:
      json.dump(d[i], out)


def get_atlas_positions(**kwargs):
  '''
  Generate and save to disk all atlases to be used for this visualization
  If square, center each cell in an nxn square, else use uniform height
  '''
  print(' * creating atlas files')
  n = 0 # number of atlases
  x = 0 # x pos in atlas
  y = 0 # y pos in atlas
  atlas_positions = [] # l[cell_idx] = atlas data
  atlas = np.zeros((kwargs['atlas_size'], kwargs['atlas_size'], 3))
  for idx, i in enumerate(stream_images(**kwargs)):
    lod_data = i.resize_to_max(kwargs['lod_cell_height'])
    h,w,_ = lod_data.shape # h,w,colors in lod-cell sized image `i`
    if kwargs['square_cells']:
      atl_data = i.resize_to_square(kwargs['atlas_cell_height'])
    else:
      atl_data = i.resize_to_height(kwargs['atlas_cell_height'])
    _,v,_ = atl_data.shape
    appendable = False
    if x + v < kwargs['atlas_size']:
      appendable = True
    elif y + kwargs['atlas_cell_height'] < kwargs['atlas_size']:
      y += kwargs['atlas_cell_height']
      x = 0
      appendable = True
    if not appendable:
      save_atlas(atlas, n, **kwargs)
      n += 1
      atlas = np.zeros((kwargs['atlas_size'], kwargs['atlas_size'], 3))
      x = 0
      y = 0
    atlas[y:y+kwargs['atlas_cell_height'], x:x+v] = atl_data
    atlas_positions.append({
      'idx': n, # atlas idx
      'x': x, # x offset of cell in atlas
      'y': y, # y offset of cell in atlas
      'w': w, # w of cell at lod size
      'h': h, # h of cell at lod size
    })
    x += v
  save_atlas(atlas, n, **kwargs)
  return atlas_positions


def save_atlas(*args, **kwargs):
  '''Save an atlas to disk'''
  data, n = args
  out_dir = join(kwargs['out_dir'], 'atlases')
  if not exists(out_dir): os.makedirs(out_dir)
  save_img(join(out_dir, 'atlas-{}.jpg'.format(n)), data)


def get_positions(*args, **kwargs):
  '''Get the image positions in each projection'''
  vecs = vectorize_images(**kwargs)
  return {
    'rasterfairy': get_rasterfairy_projection(vecs=vecs, **kwargs),
    'umap': get_umap_projection(vecs=vecs, **kwargs),
    'grid': get_grid_projection(**kwargs),
  }


def vectorize_images(**kwargs):
  '''Create and return vector representation of Image() instances'''
  print(' * preparing to vectorize {} images'.format(len(kwargs['image_paths'])))
  base = InceptionV3(include_top=True, weights='imagenet',)
  model = Model(inputs=base.input, outputs=base.get_layer('avg_pool').output)
  print(' * creating image array')
  vecs = []
  for idx, i in enumerate(stream_images(**kwargs)):
    print(' * vectorized {}/{} images'.format(idx+1, len(kwargs['image_paths'])))
    im = preprocess_input( img_to_array( i.original.resize((299,299)) ) )
    vecs.append( model.predict(np.expand_dims(im, 0)).squeeze() )
  return np.array(vecs)


def get_umap_projection(**kwargs):
  '''Get the x,y positions of images passed through a umap projection'''
  print(' * creating UMAP layout')
  out_dir = join(kwargs['out_dir'], 'layouts')
  out_path = join(out_dir, 'umap-{}.json'.format(hash(**kwargs)))
  if os.path.exists(out_path): return out_path
  model = UMAP(n_neighbors=25, min_dist=0.5, metric='correlation')
  z = model.fit_transform(kwargs['vecs'])
  path = write_json(out_path, z, **kwargs)
  return path


def get_rasterfairy_projection(**kwargs):
  '''Get the x, y position of images passed through a rasterfairy projection'''
  print(' * creating rasterfairy layout')
  out_dir = join(kwargs['out_dir'], 'layouts')
  out_path = join(out_dir, 'rasterfairy-{}.json'.format(hash(**kwargs)))
  if os.path.exists(out_path): return out_path
  pos = rasterfairy.transformPointCloud2D(kwargs['vecs'][:,:2])[0]
  x, y = np.array(list(zip(*pos)))
  sizes = [i.resize_to_max(kwargs['lod_cell_height']).shape for i in stream_images(**kwargs)]
  w, h, c = np.array(list(zip(*sizes))) # width, height, colors of images
  #x += ((config['lod_cell_height'] - w)/2)/config['lod_cell_height']
  #y += ((config['lod_cell_height'] - h)/2)/config['lod_cell_height']
  z = np.swapaxes(np.array([x, y]), 0, 1)
  path = write_json(out_path, z, **kwargs)
  return path


def get_grid_projection(**kwargs):
  '''Get the x,y positions of images in a grid projection'''
  print(' * creating grid layout')
  out_dir = join(kwargs['out_dir'], 'layouts')
  out_path = join(out_dir, 'grid-{}.json'.format(hash(**kwargs)))
  if os.path.exists(out_path): return out_path
  paths = kwargs['image_paths']
  n = math.ceil(len(paths)**(1/2))
  l = [] # positions
  for i, _ in enumerate(paths):
    x = i%n
    y = math.floor(i/n)
    l.append([x, y])
  z = np.array(l)
  path = write_json(out_path, z, **kwargs)
  return path


def scale_axes(arr):
  '''Scale numpy `arr` -1:1 among dimensions'''
  z = np.zeros(arr.shape)
  for i in range(arr.shape[1]):
    a = arr[:,i]
    z[:,i] = (((a-np.min(a))/(np.max(a)-np.min(a)))-0.5)*2 # scale -1:1
  return z


def add_z_dim(X, val=0.001):
  '''Given X with shape (n,2) return (n,3) with val as X[:,2]'''
  X = scale_axes(X)
  if X.shape[1] == 2:
    z = np.zeros((X.shape[0], 3)) + val
    for idx, i in enumerate(X): z[idx] += np.array((i[0], i[1], 0))
    return z.tolist()
  return X.tolist()


def write_json(path, obj, precision=4, sub_dir='layouts', **kwargs):
  '''Write json object `o` to disk and return the path to that file'''
  obj = scale_axes(obj)
  out_dir, filename = os.path.split(path)
  if not os.path.exists(out_dir): os.makedirs(out_dir)
  if precision: obj = [[round(float(j), precision) for j in i] for i in obj]
  with open(path, 'w') as out: json.dump(obj, out)
  return path


def get_centroids(**kwargs):
  '''Return the K nearest neighbor centroids for input vectors'''
  z = KMeans(n_clusters=kwargs['n_clusters']).fit(kwargs['vecs'])
  centroids = z.cluster_centers_
  closest, _ = pairwise_distances_argmin_min(centroids, kwargs['vecs'])
  paths = [kwargs['image_paths'][i] for i in closest]
  return [{
    'img': clean_filename(paths[idx]),
    'label': 'Cluster {}'.format(idx+1),
    'idx': int(i),
    'position': centroids[idx].tolist(),
  } for idx,i in enumerate(closest)]


def hash(**kwargs):
  '''Hash `args` into a string and return that string. Overloads hash()'''
  return str(uuid.uuid1())
  return sha224( u''.join([str(i) for i in kwargs]).encode('utf8')).hexdigest()


def copy_web_assets(**kwargs):
  '''Copy the /web directory from the pixplot source to the users cwd'''
  path = join(dirname(realpath(__file__)), 'web')
  copy_tree(path, join(os.getcwd(), kwargs['out_dir']))


def parse():
  '''Read command line args and begin data processing'''
  description = 'Generate the data required to create a PixPlot viewer'
  parser = argparse.ArgumentParser(description=description, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
  parser.add_argument('--images', type=str, default=config['images'], help='path to a glob of images to process', required=True)
  parser.add_argument('--metadata', type=str, default=config['metadata'], help='path to a csv or glob of JSON files with image metadata (see readme for format)', required=False)
  parser.add_argument('--use_cache', type=bool, default=config['use_cache'], help='given inputs identical to prior inputs, load outputs from cache', required=False)
  parser.add_argument('--use_gzip', type=bool, default=config['use_gzip'], help='save outputs with gzip compression', required=False)
  parser.add_argument('--encoding', type=str, default=config['encoding'], help='the encoding of input metadata', required=False)
  parser.add_argument('--n_clusters', type=int, default=config['n_clusters'], help='the number of clusters to identify', required=False)
  parser.add_argument('--out_dir', type=str, default=config['out_dir'], help='the directory to which outputs will be saved', required=False)
  config.update(vars(parser.parse_args()))
  process_images(**config)


class Image:
  def __init__(self, *args, **kwargs):
    self.path = args[0]
    self.original = load_img(self.path)

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
    size = (int(w/h*height), height)
    return img_to_array(self.original.resize(size))

  def resize_to_square(self, n, center=False):
    '''
    Resize self.original to an image with nxn pixels (maintain proportion)
    if center, center the colored pixels in the square, else left align
    '''
    a = self.resize_to_max(n)
    w,h,c = a.shape
    pad_lr = int((n-w)/2) # left right pad
    pad_tb = int((n-h)/2) # top bottom pad
    b = np.zeros((n,n,3))
    if center: b[ pad_lr:pad_lr+w, pad_tb:pad_tb+h, : ] = a
    else: b[:w,:h,:] = a
    return b

if __name__ == '__main__':
  parse()