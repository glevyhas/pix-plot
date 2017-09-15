from __future__ import division
import os, glob, json, shutil, math

def subdivide(l, n):
  sublists = []
  sublist = []
  for i in l:
    sublist.append(i)
    if len(sublist) == n:
      sublists.append(sublist)
      sublist = []
  sublists.append(sublist)
  return sublists

data_dir = '../data/'

selected_imgs = json.load(open(data_dir + 'json/selected_image_tsne_projections.json'))

'''
Each atlas will be 2048x2048px.
Each cell size will be 32, 64, or 128px squared.
'''

for cell_size in [32, 64]:
  imgs_per_row = (2048/cell_size)
  imgs_per_atlas = imgs_per_row**2
  textures = subdivide(selected_imgs, imgs_per_atlas)
  for atlas_idx, atlas_images in enumerate(textures):
    os.system('rm texture-list.txt')
    for img in atlas_images:
      img_path = data_dir + str(cell_size) + '-thumbs/' + os.path.basename(img)
      with open('texture-list.txt', 'a') as out:
        out.write(img_path + '\n')

    out_dir = data_dir + 'textures/' + str(cell_size) + '/'
    if not os.path.exists(out_dir):
      os.makedirs(out_dir)

    out_path = out_dir + 'image-atlas-' + str(atlas_idx) + '.jpg'

    cmd =  'montage `cat texture-list.txt` '
    cmd += ' -geometry +0+0 -background none'
    cmd += ' -tile ' + str(imgs_per_row) + 'x' + ' '
    cmd += out_path
    print(' * building montage', atlas_idx, 'with cell size', cell_size, 'images', len(atlas_images), 'images')
    os.system(cmd)

    # resize the image to 2048x2048
    resize_cmd =  'convert ' + out_path + ' -resize 2048x2048 '
    resize_cmd += ' -background white -gravity NorthWest '
    resize_cmd += ' -extent 2048x2048 ' + out_path + out_file
    os.system(resize_cmd)