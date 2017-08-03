import json, glob, os, random, shutil

selected = {}
total_images = 10000
max_nn = 80
min_nn = 20
data_dir = '../data/'
img_to_coords = json.load(open(data_dir + 'json/image_tsne_projections.json'))
img_to_idx = {}
match_waiting_room = set()

for c, i in enumerate(glob.glob(data_dir + '128-thumbs/*.jpg')):
  img_to_idx[i] = c

for i in glob.glob(data_dir + 'nearest_neighbors/*.json'):
  if len(selected.keys()) == total_images:
    continue

  img = os.path.basename(i).replace('.json','.jpg')
  neighbors = json.load(open(i))
  
  for j in range(random.randint(30, max_nn)):
    match = neighbors[j]
    if match['similarity'] > .8:
      match_img = match['filename'] + '.jpg'
      match_waiting_room.add(match_img)
      match_waiting_room.add(img)

  if len(match_waiting_room) >= min_nn:
    for i in match_waiting_room:
      if len(selected.keys()) == total_images:
        continue
      selected[i] = img_to_coords[i]

  match_waiting_room = set()

with open(data_dir + 'json/selected_image_positions.json','w') as out:
  json.dump(selected, out)

##
# copy the images to a new isolated directory
##

selected_img_dir = data_dir + 'selected_images'
try:
  shutil.rmtree(selected_img_dir)
except:
  pass

os.makedirs(selected_img_dir)

for i in selected.keys():
  shutil.copy(data_dir + '128-thumbs/' + i, data_dir + 'selected_images/' + i)
