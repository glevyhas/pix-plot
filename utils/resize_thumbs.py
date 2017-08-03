import os, glob

data_dir = '../data/'

for i in glob.glob(data_dir + 'thumbs/*.jpg'):
  basename = os.path.basename(i)
  cmd = 'convert ' + i + ' -resize "128x128^" -gravity center -crop 128x128+0+0 -sampling-factor 4:2:0 -strip -quality 85 ' + data_dir + '128-thumbs/' + basename
  os.system(cmd)