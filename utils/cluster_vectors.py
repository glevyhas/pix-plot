from PIL import Image
from sklearn.manifold import TSNE
import numpy as np
import glob, json, os

# create datastores
vector_files = []
image_vectors = []
chart_data = {}
image_to_size = {}
image_to_idx = {}
maximum_imgs = None
data_dir = '../data/'
selected_imgs = json.load(open(data_dir + 'json/selected_image_positions.json')).keys()

##
# build a list of image vectors to process
##

vector_files = glob.glob(data_dir + 'results/*.npy')

# allow user to only build projections on a subset of the data
if selected_imgs:
  vf = []
  for i in vector_files:
    img = os.path.basename(i).replace('.npy','')
    if img in selected_imgs:
      vf.append(i)
  vector_files = vf

# allow user to only build projections on n images
if maximum_imgs:
  vector_files = vector_files[:maximum_imgs]

# get the image sizes
image_files = glob.glob(data_dir + 'selected_images/*.jpg')
for c, i in enumerate(image_files):
  image_name = os.path.basename(i)
  image_to_size[image_name] = Image.open(i).size
  image_to_idx[image_name] = c

# load the vectors
for c, i in enumerate(vector_files):
  image_vectors.append(np.load(i))
  print(' * loaded', c, 'of', len(vector_files), 'image vectors')

# build the tsne model on the image vectors
print('building tsne model')
model = TSNE(n_components=2, random_state=0)
np.set_printoptions(suppress=True)
fit_model = model.fit_transform( np.array(image_vectors) )
 
# store the coordinates of each image in the chart data
for c, i in enumerate(fit_model):
  image_name = os.path.basename(vector_files[c]).replace('.npy', '') 
  chart_data[image_name] = {
    'x': i[0],
    'y': i[1],
    'idx': image_to_idx[image_name]
    #'z': i[2]
    #'size': image_to_size[image_name]
  }

with open(data_dir + 'json/selected_image_tsne_projections.json', 'w') as out:
  json.dump(chart_data, out)