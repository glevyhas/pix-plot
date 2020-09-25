from os.path import join, exists, dirname, realpath
from setuptools import setup
import os

try:
  # python 2
  from urllib.request import urlretrieve as download_function
except:
  # python 3
  from urllib.request import retrieve as download_function

# before installing the base package, download the model
print(' * downoading cmu model')
url = 'https://lab-apps.s3-us-west-2.amazonaws.com/pixplot-assets/tf-pose/graph_opt.pb'
out_dir = join(dirname(realpath(__file__)), 'pixplot', 'models', 'graph', 'cmu')
if not exists(out_dir): os.makedirs(out_dir)
out_path = join(out_dir, 'graph_opt.pb')
if not exists(out_path): download_function(url, out_path)

# populate list of all paths in `./pixplot/web`
web = []
dirs = [join('pixplot', 'web'), join('pixplot', 'models')]
for i in dirs:
  for root, subdirs, files in os.walk(i):
    if not files: continue
    for file in files:
      web.append(join(root.replace('pixplot/', ''), file))

setup(
  name='pixplot',
  version='0.0.97',
  packages=['pixplot'],
  package_data={
    'pixplot': web,
  },
  keywords = ['computer-vision', 'webgl', 'three.js', 'tensorflow', 'machine-learning'],
  description='Visualize large image collections with WebGL',
  url='https://github.com/yaledhlab/pix-plot',
  author='Douglas Duhaime',
  author_email='douglas.duhaime@gmail.com',
  license='MIT',
  install_requires=[
    'cmake>=3.15.3',
    'Cython>=0.29.21',
    'glob2>=0.6',
    'hdbscan>=0.8.24',
    'iiif-downloader>=0.0.6',
    'Keras<=2.3.0',
    'lap>=0.4.0',
    'matplotlib>=2.0.0',
    'numpy>=1.16.0',
    'Pillow>=6.1.0',
    'pointgrid>=0.0.2',
    'python-dateutil>=2.8.0',
    'scikit-learn>=0.19.0',
    'scipy>=1.1.0',
    'tensorflow>=1.14.0,<=2.0.0',
    'tf-pose==0.11.0',
    'umap-learn>=0.3.10',
    'yale-dhlab-rasterfairy>=1.0.3',
    'yale-dhlab-keras-preprocessing>=1.1.1',
  ],
  entry_points={
    'console_scripts': [
      'pixplot=pixplot:parse',
    ],
  },
)