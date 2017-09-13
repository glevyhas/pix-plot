from __future__ import division
import os, glob, json, shutil, math

data_dir = '../data/'

selected_imgs = json.load(open(data_dir + 'json/selected_image_positions.json'))

# build the image atlas
n = math.ceil(len(selected_imgs.keys())**(1/2))
cmd = 'montage ' + data_dir + '"selected_images/*.jpg" -tile ' + str(n) + 'x' + str(n) + ' ' + data_dir + 'image-atlas.jpg'
print(' * building grid of size', n, 'x', n)
os.system(cmd)

# find power of two multiplier
i=0
while (2**i) < (n*128):
  i += 1

# make the image atlas a power of two
cmd = 'convert ../data/image-atlas.jpg -gravity NorthWest -background white'
cmd += ' -extent ' + str(2**i) + 'x' + str(2**i) + ' ' + data_dir + 'image-atlas-pot.jpg'
os.system(cmd)