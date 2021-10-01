from os.path import join
from setuptools import setup
import os
import sys

# validate python version
if sys.version_info < (3, 6):
  sys.exit('Sorry, PixPlot requires Python 3.6 or later')

# populate list of all paths in `./pixplot/web`
web = []
dirs = [join('pixplot', 'web'), join('pixplot', 'models')]
for i in dirs:
  for root, subdirs, files in os.walk(i):
    if not files:
      continue
    for file in files:
      web.append(join(root.replace('pixplot/', '')
                          .replace('pixplot\\', ''), file))

setup(
  name='pixplot',
  version='0.0.113',
  packages=['pixplot'],
  package_data={
    'pixplot': web,
  },
  keywords=['computer-vision',
            'webgl',
            'three.js',
            'tensorflow',
            'machine-learning'],
  description='Visualize large image collections with WebGL',
  url='https://github.com/yaledhlab/pix-plot',
  author='Douglas Duhaime',
  author_email='douglas.duhaime@gmail.com',
  license='MIT',
  install_requires=[
    'cmake>=3.15.3',
    'Cython>=0.29.21',
    'glob2>=0.6',
    'h5py~=3.1.0',
    'iiif-downloader>=0.0.6',
    'numba==0.53',
    'numpy==1.19.5',
    'Pillow>=6.1.0',
    'pointgrid>=0.0.2',
    'python-dateutil>=2.8.0',
    'scikit-learn==0.24.2',
    'scipy==1.4.0',
    'six==1.15.0',
    'tensorflow==2.5.0',
    'tqdm==4.61.1',
    'umap-learn==0.5.1',
    'yale-dhlab-rasterfairy>=1.0.3',
    'yale-dhlab-keras-preprocessing>=1.1.1',
    'matplotlib'
  ],
  entry_points={
    'console_scripts': [
      'pixplot=pixplot:parse',
    ],
  },
)
