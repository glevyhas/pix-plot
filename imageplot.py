from __future__ import division
from collections import defaultdict
from sklearn.manifold import TSNE
from six.moves import urllib
from os.path import join
import glob, json, os, re, sys, tarfile, psutil, umap, subprocess
import tensorflow as tf
import numpy as np

# tensorflow config
FLAGS = tf.app.flags.FLAGS
FLAGS.model_dir = '/tmp/imagenet'

class Imageplot:
  def __init__(self, image_dir, output_dir):
    self.image_files = glob.glob(image_dir)
    self.output_dir = output_dir
    self.sizes = [16, 32, 64, 128]
    self.errored_images = set()
    self.vector_files = []
    self.method = 'umap'
    self.image_positions = []
    self.rewrite_image_thumbs = False
    self.rewrite_image_vectors = False
    self.rewrite_atlas_files = True
    self.create_output_dirs()
    self.create_image_thumbs()
    self.create_image_vectors()
    self.create_2d_projection()
    self.create_atlas_files()

  def create_output_dirs(self):
    '''
    Create each of the required output dirs
    '''
    dirs = ['image_vectors', 'atlas_files', 'thumbs']
    for i in dirs:
      self.ensure_dir_exists( join(self.output_dir, i) )
    # make subdirectories for each image thumb size
    for i in self.sizes:
      self.ensure_dir_exists( join(self.output_dir, 'thumbs', str(i) + 'px') )


  def ensure_dir_exists(self, directory):
    '''
    Create the input directory if it doesn't exist
    '''
    if not os.path.exists(directory):
      os.makedirs(directory)


  def create_image_thumbs(self):
    '''
    Create output thumbs in 32px, 64px, and 128px
    '''
    n_thumbs = len(self.image_files)
    for i in self.sizes:
      print(' * creating', str(i), 'px thumbs')
      for c, j in enumerate(self.image_files):
        print(' * creating thumb', c+1, 'of', n_thumbs, 'at size', i)
        out_dir = join(self.output_dir, 'thumbs', str(i) + 'px')
        out_path = join( out_dir, self.get_filename(j) + '.jpg' )
        if os.path.exists(out_path) and not self.rewrite_image_thumbs:
          continue
        cmd =  'convert ' + j + ' '
        cmd += '-background none '
        cmd += '-gravity center '
        cmd += '-resize "' + str(i) + 'X' + str(i) + '>" '
        cmd += out_path
        try:
          response = subprocess.check_output(cmd, shell=True)
        except subprocess.CalledProcessError as exc:
          self.errored_images.add( self.get_filename(j) )


  def create_image_vectors(self):
    '''
    Create one image vector for each input file
    '''
    self.download_inception()
    self.create_tf_graph()

    with tf.Session() as sess:
      for image_index, image in enumerate(self.image_files):
        try:
          print(' * processing image', image_index+1, 'of', len(self.image_files))
          outfile_name = os.path.basename(image) + '.npy'
          out_path = join(self.output_dir, 'image_vectors', outfile_name)
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
          self.errored_images.add( self.get_filename(image) )
          print(' * image', image, 'hit a snag', exc)


  def get_filename(self, path):
    '''
    Return the root filename of `path` without file extension
    '''
    return os.path.splitext( os.path.basename(path) )[0]


  def download_inception(self):
    '''
    Download the inception model to FLAGS.model_dir
    '''
    inception_path = 'http://download.tensorflow.org/models/image/imagenet/inception-2015-12-05.tgz'
    dest_directory = FLAGS.model_dir
    self.ensure_dir_exists(dest_directory)
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
    graph_path = join(FLAGS.model_dir, 'classify_image_graph_def.pb')
    with tf.gfile.FastGFile(graph_path, 'rb') as f:
      graph_def = tf.GraphDef()
      graph_def.ParseFromString(f.read())
      _ = tf.import_graph_def(graph_def, name='')


  def create_2d_projection(self):
    '''
    Create a 2d embedding of the image vectors
    '''
    image_vectors = self.load_image_vectors()
    model = self.build_model(image_vectors)
    self.write_image_positions(model)


  def load_image_vectors(self):
    '''
    Return all image vectors
    '''
    vectors = []
    self.vector_files = glob.glob( join(self.output_dir, 'image_vectors', '*') )
    for c, i in enumerate(self.vector_files):
      vectors.append(np.load(i))
      print(' * loaded', c+1, 'of', len(self.vector_files), 'image vectors')
    return vectors


  def build_model(self, image_vectors):
    '''
    Build a 2d projection of the `image_vectors`
    '''
    if self.method == 'tsne':
      model = TSNE(n_components=2, random_state=0)
      np.set_printoptions(suppress=True)
      return model.fit_transform( np.array(image_vectors) )

    elif self.method == 'umap':
      model = umap.UMAP(n_neighbors=25, min_dist=0.00001, metric='correlation')
      return model.fit_transform( np.array(image_vectors) )


  def limit_float(self, f):
    '''
    Limit the float point precision of f
    '''
    return int(f*10000)/10000


  def write_image_positions(self, fit_model):
    '''
    Write a JSON file that indicates the 2d position of each image
    '''
    for c, i in enumerate(fit_model):
      img = self.get_filename(self.vector_files[c])
      if img in self.errored_images:
        continue
      self.image_positions.append({
        'x': self.limit_float( i[0] ),
        'y': self.limit_float( i[1] ),
        'img': os.path.basename(img).split('.')[0]
      })
    out_path = join(self.output_dir, 'tsne_image_positions.json')
    with open(out_path, 'w') as out:
      json.dump(self.image_positions, out)


  def create_atlas_files(self):
    '''
    Create image atlas files in each required size
    '''
    atlas_group_imgs = []
    atlas_sizes = self.sizes[:-1]
    for thumb_size in atlas_sizes:
      # identify the images for this atlas group
      atlas_thumbs = self.get_atlas_thumbs(thumb_size)
      print('thumb len', len(atlas_thumbs))
      self.write_atlas_files(thumb_size, atlas_thumbs)
    # assert all image atlases have the same number of images
    assert all(i == atlas_group_imgs[0] for i in atlas_group_imgs)


  def get_atlas_thumbs(self, thumb_size):
    thumbs = []
    thumb_dir = join(self.output_dir, 'thumbs', str(thumb_size) + 'px')
    with open(join(self.output_dir, 'tsne_image_positions.json')) as f:
      for i in json.load(f):
        thumbs.append( join(thumb_dir, i['img'] + '.jpg') )
    return thumbs


  def write_atlas_files(self, thumb_size, image_thumbs):
    '''
    Given a thumb_size (int) and image_thumbs [file_path],
    write the total number of required atlas files at this size
    '''
    # build a directory for the atlas files
    out_dir = join(self.output_dir, 'atlas_files', str(thumb_size) + 'px')
    self.ensure_dir_exists(out_dir)
    
    # specify number of columns in a 2048 x 2048px texture
    atlas_cols = 2048/thumb_size

    # subdivide the image thumbs into groups
    atlas_image_groups = self.subdivide(image_thumbs, atlas_cols**2)
    for idx, atlas_images in enumerate(atlas_image_groups):
      print(' * creating atlas', idx, 'at size', thumb_size)
      out_path = join(out_dir, 'atlas-' + str(idx) + '.jpg')
      if os.path.exists(out_path) and not self.rewrite_atlas_files:
        continue

      # write a file containing a list of images for the current montage
      tmp_file_path = join(self.output_dir, 'images_to_montage.txt')
      with open(tmp_file_path, 'w') as out:
        out.write('\n'.join(atlas_images))

      # build the imagemagick command to montage the images
      cmd =  'montage @' + tmp_file_path + ' '
      cmd += '-background none '
      cmd += '-size ' + str(thumb_size) + 'x' + str(thumb_size) + ' '
      cmd += '-geometry ' + str(thumb_size) + 'x' + str(thumb_size) + '+0+0 '
      cmd += '-tile ' + str(atlas_cols) + 'x' + str(atlas_cols) + ' '
      cmd += '-quality 85 '
      cmd += '-sampling-factor 4:2:0 '
      cmd += out_path
      os.system(cmd)


  def subdivide(self, l, n):
    '''
    Return n-sized sublists from iterable l
    '''
    n = int(n)
    for i in range(0, len(l), n):
      yield l[i:i + n]


if __name__ == '__main__':
  Imageplot(image_dir=sys.argv[1], output_dir='output')
