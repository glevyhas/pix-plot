from __future__ import division
from nltk import ngrams
import os, glob, json, shutil, math

data_dir = '../data/'

selected_imgs = json.load(open(data_dir + 'json/selected_image_positions.json'))

# only allow each texture to contain 16*16 images
textures = ngrams(selected_imgs, 256)

# create each texture as a 2048x2048 pixel map with 16x16 images
for c, i in enumerate(textures):
  os.system('rm texture-list.txt')
  for j in i:
    with open('texture-list.txt', 'a') as out:
      out.write('../data/selected_images/' + j + '\n')

  cmd =  'montage `cat texture-list.txt` '
  cmd += ' -tile 16x16 ' + data_dir + 'textures/image-atlas-' + str(c) + '.jpg'
  print(' * building montage', c, 'with', len(i), 'images')
  os.system(cmd)