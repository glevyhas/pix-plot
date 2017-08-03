from __future__ import division
import os, glob, json, shutil, math

data_dir = '../data/'

selected_imgs = json.load(open(data_dir + 'json/selected_image_positions.json'))

n = math.ceil(len(selected_imgs.keys())**(1/2))

cmd = 'montage ' + data_dir + '"selected_images/*.jpg" -tile ' + str(n) + 'x' + str(n) + ' ' + data_dir + 'image-atlas.jpg'
print(' * building grid of size', n, 'x', n)

os.system(cmd)