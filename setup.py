from os.path import join, exists, dirname, realpath
from setuptools import setup
import os, sys

# validate python version
if sys.version_info < (3,6):
  sys.exit('Sorry, PixPlot requires Python 3.6 or later')

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
  version='0.0.102',
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
    'hdbscan==0.8.24',
    'h5py==2.10.0',
    'iiif-downloader>=0.0.6',
    'Keras<=2.3.0',
    'numpy==1.16.0',
    'Pillow>=6.1.0',
    'pointgrid>=0.0.2',
    'python-dateutil>=2.8.0',
    'scikit-learn==0.21.3',
    'scipy==1.4.0',
    'tensorflow==1.14.0',
    'umap-learn==0.4.0',
    'yale-dhlab-rasterfairy>=1.0.3',
    'yale-dhlab-keras-preprocessing>=1.1.1',
  ],
  entry_points={
    'console_scripts': [
      'pixplot=pixplot:parse',
    ],
  },
)