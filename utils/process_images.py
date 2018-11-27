#!/usr/bin/python

'''
Generates all data required to create a PixPlot viewer.

Documentation: https://github.com/YaleDHLab/pix-plot

Usage: python utils/process_images.py --image_files="data/*/*.jpg"

                      * * *
'''

from __future__ import division, print_function
from collections import defaultdict
from sklearn.cluster import KMeans
from sklearn.metrics import pairwise_distances_argmin_min
from sklearn.manifold import TSNE
from multiprocessing import Pool
from six.moves import urllib
from os.path import join, basename
from shutil import copy, rmtree
from PIL import Image
from umap import UMAP
from math import ceil
from glob import glob
import tensorflow as tf
import numpy as np
import json
import os
import re
import sys
import tarfile
import psutil
import subprocess
import codecs
import csv

# configure command line interface arguments
flags = tf.app.flags
flags.DEFINE_string('model_dir', '/tmp/imagenet', 'The location of downloaded imagenet model')
flags.DEFINE_string('image_files', '', 'A glob path of images to process')
flags.DEFINE_boolean('process_images', True, 'Whether to process images')
flags.DEFINE_boolean('validate_images', True, 'Whether to validate images before processing')
flags.DEFINE_integer('clusters', 20, 'The number of clusters to display in the image browser')
flags.DEFINE_string('output_folder', 'output', 'The folder where output files will be stored')
flags.DEFINE_string('layout', 'umap', 'The layout method to use {umap|tsne}')
flags.DEFINE_boolean('copy_images', True, 'Copy inputs to outputs for detailed image view in browser')
flags.DEFINE_string('csv', '', 'The path to a metadata CSV file (see README)')
FLAGS = flags.FLAGS


class PixPlot:
  def __init__(self, image_glob):
    print(' * writing PixPlot outputs with ' + str(FLAGS.clusters) +
      ' clusters for ' + str(len(image_glob)) +
      ' images to folder "' + FLAGS.output_folder + '"')

    self.image_files = image_glob
    self.sizes = [32, 128]
    self.errored_images = set()
    self.vector_files = []
    self.image_vectors = []
    self.flags = FLAGS
    self.rewrite_image_thumbs = False
    self.rewrite_image_vectors = False
    self.rewrite_atlas_files = True
    self.create_output_dirs()
    self.create_metadata()
    self.copy_original_images()
    if self.flags.process_images:
      self.process_images()


  def process_images(self):
    '''
    Wrapper function that calls all image processing functions
    '''
    self.validate_inputs()
    self.create_image_thumbs()
    self.create_image_vectors()
    self.load_image_vectors()
    self.write_json()
    self.create_atlas_files()
    print('Processed output for ' + \
      str(len(self.image_files) - len(self.errored_images)) + ' images')


  def create_output_dirs(self):
    '''
    Create each of the required output dirs
    '''
    for i in [
      'atlas_files',
      'filters',
      'image_vectors',
      'metadata',
      'originals',
      'thumbs',
    ]:
      ensure_dir_exists( join(self.flags.output_folder, i) )
    # make subdirectories for each image thumb size
    for i in self.sizes:
      ensure_dir_exists( join(self.flags.output_folder, 'thumbs', str(i) + 'px') )


  def create_metadata(self):
    '''
    If the user provided a CSV metadata file, parse the metadata
    '''
    if not self.flags.csv: return
    rmtree(join(self.flags.output_folder, 'metadata'))
    print(' * generating metadata')
    tag_to_filenames = defaultdict(set) # d[tag] = {filename_0, filename_1...}
    filenames = set()
    rows = []
    with open(self.flags.csv) as f:
      reader = csv.reader(f)
      for idx, i in enumerate(reader):
        if len(i) == 0: continue # skip empty rows
        filename, tags, description, permalink = i
        tags = tags.split('|')
        for tag in tags: tag_to_filenames[tag].add(get_filename(filename))
        rows.append([filename, tags, description, permalink])
        filenames.add(filename)
    # inform the user if files are missing from the metadata
    img_filenames = {basename(i) for i in self.image_files}
    missing_from_meta = img_filenames - filenames
    if missing_from_meta:
      print(' ! warning, metadata missing files', missing_from_meta)
    # create the directory where each filter option will live
    levels_dir = join(self.flags.output_folder, 'filters', 'option_values')
    ensure_dir_exists(levels_dir)
    # write the JSON for each tag
    for i in tag_to_filenames:
      hyphenated = '-'.join(i.split())
      with open(join(levels_dir, hyphenated + '.json'), 'w') as out:
        json.dump(list(tag_to_filenames[i]), out)
    # save JSON with all level options
    with open(join(self.flags.output_folder, 'filters', 'filters.json'), 'w') as out:
      json.dump([{
        'filter_name': 'select',
        'filter_values': list(tag_to_filenames.keys())
      }], out)
    # write metadata for each input image
    metadata_dir = join(self.flags.output_folder, 'metadata')
    ensure_dir_exists(metadata_dir)
    cols = ['filename', 'tags', 'description', 'permalink']
    for i in rows:
      d = {cols[idx]: i[idx] for idx, _ in enumerate(i)}
      with open(join(metadata_dir, get_filename(i[0]) + '.json'), 'w') as out:
        json.dump(d, out)


  def copy_original_images(self):
    '''
    Copy the input high-res images to the ouput directory
    '''
    if not self.flags.copy_images: return
    print(' * copying high res images to output directory')
    for i in self.image_files:
      copy(i, join(self.flags.output_folder, 'originals', basename(i)))


  def validate_inputs(self):
    '''
    Make sure the inputs are valid, and warn users if they're not
    '''
    # ensure the user provided enough input images
    if len(self.image_files) < self.flags.clusters:
      print('Please provide >= ' + str(self.flags.clusters) + ' images')
      print(str(len(self.image_files)) + ' images were provided')
      sys.exit()

    if not self.flags.validate_images:
      print(' * skipping image validation')
      return

    # test whether each input image can be processed
    print(' * validating input files')
    invalid_files = []
    for i in self.image_files:
      try:
        cmd = get_magick_command('identify') + ' "' + i + '"'
        response = subprocess.check_output(cmd, shell=True)
      except Exception as exc:
        invalid_files.append(i)
    if invalid_files:
      message = '\n\nThe following files could not be processed:'
      message += '\n  ! ' + '\n  ! '.join(invalid_files) + '\n'
      message += 'Please remove these files and reprocess your images.'
      print(message)
      sys.exit()


  def create_image_thumbs(self):
    '''
    Create output thumbs in 32px, 64px, and 128px
    '''
    print(' * creating image thumbs')
    resize_args = []
    n_thumbs = len(self.image_files)
    for idx, j in enumerate(self.image_files):
      sizes = []
      out_paths = []
      for i in sorted(self.sizes, key=int, reverse=True):
        out_dir = join(self.flags.output_folder, 'thumbs', str(i) + 'px')
        out_path = join( out_dir, get_filename(j) + '.jpg' )
        if os.path.exists(out_path) and not self.rewrite_image_thumbs:
          continue
        sizes.append(i)
        out_paths.append(out_path)
      if len(sizes) > 0:
        resize_args.append([j, idx, n_thumbs, sizes, out_paths])

    pool = Pool()
    for result in pool.imap(resize_thumb, resize_args):
      if result:
        self.errored_images.add( get_filename(result) )


  def create_image_vectors(self):
    '''
    Create one image vector for each input file
    '''
    self.download_inception()
    self.create_tf_graph()

    print(' * creating image vectors')
    with tf.Session() as sess:
      for image_index, image in enumerate(self.image_files):
        try:
          print(' * processing image', image_index+1, 'of', len(self.image_files))
          outfile_name = basename(image) + '.npy'
          out_path = join(self.flags.output_folder, 'image_vectors', outfile_name)
          if os.path.exists(out_path) and not self.rewrite_image_vectors:
            continue
          # save the penultimate inception tensor/layer of the current image
          with tf.gfile.FastGFile(image, 'rb') as f:
            data = {'DecodeJpeg/contents:0': f.read()}
            feature_tensor = sess.graph.get_tensor_by_name('pool_3:0')
            feature_vector = np.squeeze( sess.run(feature_tensor, data) )
            np.save(out_path, feature_vector)
          # close the open files
          for open_file in psutil.Process().open_files():
            file_handler = getattr(open_file, 'fd')
            os.close(file_handler)
        except Exception as exc:
          self.errored_images.add( get_filename(image) )
          print(' * image', get_ascii_chars(image), 'hit a snag', exc)


  def download_inception(self):
    '''
    Download the inception model to FLAGS.model_dir
    '''
    print(' * verifying inception model availability')
    inception_path = 'http://download.tensorflow.org/models/image/imagenet/inception-2015-12-05.tgz'
    dest_directory = FLAGS.model_dir
    ensure_dir_exists(dest_directory)
    filename = inception_path.split('/')[-1]
    filepath = join(dest_directory, filename)
    if not os.path.exists(filepath):
      def progress(count, block_size, total_size):
        percent = float(count * block_size) / float(total_size) * 100.0
        sys.stdout.write('\r>> Downloading %s %.1f%%' % (filename, percent))
        sys.stdout.flush()
      filepath, _ = urllib.request.urlretrieve(inception_path, filepath, progress)
    tarfile.open(filepath, 'r:gz').extractall(dest_directory)


  def create_tf_graph(self):
    '''
    Create a graph from the saved graph_def.pb
    '''
    print(' * creating tf graph')
    graph_path = join(FLAGS.model_dir, 'classify_image_graph_def.pb')
    with tf.gfile.FastGFile(graph_path, 'rb') as f:
      graph_def = tf.GraphDef()
      graph_def.ParseFromString(f.read())
      _ = tf.import_graph_def(graph_def, name='')


  def get_2d_image_positions(self):
    '''
    Create a 2d embedding of the image vectors
    '''
    print(' * calculating 2D image positions')
    model = self.build_model(self.image_vectors)
    return self.get_image_positions(model)


  def load_image_vectors(self):
    '''
    Return all image vectors
    '''
    print(' * loading image vectors')
    self.vector_files = glob( join(self.flags.output_folder, 'image_vectors', '*') )
    for idx, i in enumerate(self.vector_files):
      self.image_vectors.append(np.load(i))
      print(' * loaded', idx+1, 'of', len(self.vector_files), 'image vectors')


  def build_model(self, image_vectors):
    '''
    Build a 2d projection of the `image_vectors`
    '''
    print(' * building 2D projection')
    if self.flags.layout == 'tsne':
      model = TSNE(n_components=2, random_state=0)
      np.set_printoptions(suppress=True)
      return model.fit_transform( np.array(image_vectors) )

    elif self.flags.layout == 'umap':
      model = UMAP(n_neighbors=25, min_dist=0.00001, metric='correlation')
      return model.fit_transform( np.array(image_vectors) )


  def get_image_positions(self, fit_model):
    '''
    Write a JSON file that indicates the 2d position of each image
    '''
    image_positions = []
    for idx, i in enumerate(fit_model):
      # get the full path to the `ith` input image
      img_path = self.image_files[idx]
      # get the basename and file extension of the `ith` input image
      img_filename = get_filename(img_path)
      if img_filename in self.errored_images:
        continue
      with Image.open(img_path) as image:
        width, height = image.size
      # Add the image name, x offset, y offset, full width, full height
      image_positions.append([
        img_filename,
        int(i[0] * 100),
        int(i[1] * 100),
        width,
        height,
      ])
    return image_positions


  def write_json(self):
    '''
    Write a JSON file with image positions, the number of atlas files
    in each size, and the centroids of the k means clusters
    '''
    print(' * writing main JSON plot data file')
    # write each of the distinct JSON files to disk
    self.write_centroids()
    with open(join(self.flags.output_folder, 'plot_data.json'), 'w') as out:
      json.dump({
        'positions': self.get_2d_image_positions(),
        'atlas_counts': self.get_atlas_counts(),
      }, out)


  def write_centroids(self):
    '''
    Use K-Means clustering to find n centroid images
    that represent the center of an image cluster
    '''
    print(' * calculating ' + str(self.flags.clusters) + ' clusters')
    model = KMeans(n_clusters=self.flags.clusters)
    X = np.array(self.image_vectors)
    fit_model = model.fit(X)
    centroids = fit_model.cluster_centers_
    # find the points closest to the cluster centroids
    closest, _ = pairwise_distances_argmin_min(centroids, X)
    centroid_paths = [self.vector_files[i] for i in closest]
    centroid_json = []
    for idx, i in enumerate(centroid_paths):
      centroid_json.append({
        'img': get_filename(i), # strip the npy extension from the vector
        'idx': int(closest[idx]),
        'label': 'Cluster ' + str(idx+1),
      })
    with open(join(self.flags.output_folder, 'centroids.json'), 'w') as out:
      json.dump(centroid_json, out)


  def get_atlas_counts(self):
    return {
      '32px': ceil( len(self.vector_files) / (64**2) ),
    }


  def create_atlas_files(self):
    '''
    Create image atlas files in each required size
    '''
    print(' * creating atlas files')
    atlas_group_imgs = []
    # identify the images for this atlas group
    thumb_size = self.sizes[0]
    atlas_thumbs = self.get_atlas_thumbs(thumb_size)
    atlas_group_imgs.append(len(atlas_thumbs))
    self.write_atlas_files(thumb_size, atlas_thumbs)


  def get_atlas_thumbs(self, thumb_size):
    thumbs = []
    thumb_dir = join(self.flags.output_folder, 'thumbs', str(thumb_size) + 'px')
    with open(join(self.flags.output_folder, 'plot_data.json')) as f:
      for i in json.load(f)['positions']:
        thumbs.append( join(thumb_dir, i[0] + '.jpg') )
    return thumbs


  def write_atlas_files(self, thumb_size, image_thumbs):
    '''
    Given a thumb_size (int) and image_thumbs [file_path],
    write the total number of required atlas files at this size
    '''
    if not self.rewrite_atlas_files: return

    # build a directory for the atlas files
    out_dir = join(self.flags.output_folder, 'atlas_files', str(thumb_size) + 'px')
    ensure_dir_exists(out_dir)

    # specify number of columns in a 2048 x 2048px texture
    atlas_cols = 2048/thumb_size

    # subdivide the image thumbs into groups
    atlas_image_groups = subdivide(image_thumbs, atlas_cols**2)

    # generate a directory for images at this size if it doesn't exist
    for idx, atlas_images in enumerate(atlas_image_groups):
      print(' * creating atlas', idx + 1, 'at size', thumb_size)
      out_path = join(out_dir, 'atlas-' + str(idx) + '.jpg')
      # write a file containing a list of images for the current montage
      tmp_file_path = join(self.flags.output_folder, 'images_to_montage.txt')
      with codecs.open(tmp_file_path, 'w', encoding='utf-8') as out:
        # python 2
        try:
          out.write('\n'.join(map('"{0}"'.decode('utf-8').format, atlas_images)))
        # python 3
        except AttributeError:
          out.write('\n'.join(map('"{0}"'.format, atlas_images)))

      # build the imagemagick command to montage the images
      cmd =  get_magick_command('montage') + ' @' + tmp_file_path + ' '
      cmd += '-background none '
      cmd += '-size ' + str(thumb_size) + 'x' + str(thumb_size) + ' '
      cmd += '-geometry ' + str(thumb_size) + 'x' + str(thumb_size) + '+0+0 '
      cmd += '-tile ' + str(atlas_cols) + 'x' + str(atlas_cols) + ' '
      cmd += '-quality 85 '
      cmd += '-sampling-factor 4:2:0 '
      cmd += '"' + out_path + '"'
      os.system(cmd)

    # delete the last images to montage file
    if os.path.exists(tmp_file_path):
      os.remove(tmp_file_path)


def get_magick_command(cmd):
  '''
  Return the specified imagemagick command prefaced with magick if
  the user is on Windows
  '''
  if os.name == 'nt':
    return 'magick ' + cmd
  return cmd


def resize_thumb(args):
  '''
  Create a command line request to resize an image
  Images for all thumb sizes are created in a single call, chaining the resize steps
  '''
  img_path, idx, n_imgs, sizes, out_paths = args
  print(' * creating thumb', idx+1, 'of', n_imgs, 'at sizes', sizes)
  cmd =  get_magick_command('convert') + ' '
  cmd += '-define jpeg:size={' + str(sizes[0]) + 'x' + str(sizes[0]) + '} '
  cmd += '"' + img_path + '" '
  cmd += '-strip '
  cmd += '-background none '
  cmd += '-gravity center '
  for i in range(0, len(sizes)):
    cmd += '-resize "' + str(sizes[i]) + 'X' + str(sizes[i]) + '>" '
    if not i == len(sizes)-1:
      cmd += "-write "
    cmd += '"' + out_paths[i] + '" '
  try:
    response = subprocess.check_output(cmd, shell=True)
    return None
  except subprocess.CalledProcessError as exc:
    return img_path


def subdivide(l, n):
  '''
  Return n-sized sublists from iterable l
  '''
  n = int(n)
  for i in range(0, len(l), n):
    yield l[i:i + n]


def get_ascii_chars(s):
  '''
  Return a string that contains the ascii characters from string `s`
  '''
  return ''.join(i for i in s if ord(i) < 128)


def get_filename(path, extension=False):
  '''
  Return the root filename of `path`. If `extension` is True,
  keep the extension, else return the filename without extension.
  '''
  filename = basename(path)
  if not extension:
    return os.path.splitext(filename)[0]
  return filename


def ensure_dir_exists(directory):
  '''
  Create the input directory if it doesn't exist
  '''
  if not os.path.exists(directory):
    os.makedirs(directory)


def limit_float(f):
  '''
  Limit the float point precision of float value f
  '''
  return int(f*10000)/10000


def main(*args, **kwargs):
  '''
  The main function to run
  '''
  # user specified glob path with tensorflow flags
  if FLAGS.image_files:
    image_glob = glob(FLAGS.image_files)

  # one argument was passed; assume it's a glob of image paths
  elif len(sys.argv) == 2:
    image_glob = glob(sys.argv[1])

  # many args were passed; check if user passed any flags
  elif len(sys.argv) > 2:
    # use the first argument as the image glob
    if any('--' in i for i in sys.argv):
      image_glob = glob(sys.argv[1])

    # else assume user passed glob without quotes and the
    # shell auto-expanded them into a list of file arguments
    else:
      image_glob = glob(sys.argv[1:])

  # no glob path was specified
  else:
    print('Please specify a glob path of images to process\n' +
      'e.g. python utils/process_images.py "folder/*.jpg"')
    sys.exit()

  PixPlot(image_glob)

if __name__ == '__main__':
  tf.app.run()
