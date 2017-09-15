import os, glob, shutil

data_dir = '../data/'
sizes = [64, 32]

for size in sizes:
  size = str(size)
  outdir = data_dir + size + '-thumbs/'
  if not os.path.exists(outdir):
    os.makedirs(outdir)

  for i in glob.glob(data_dir + '128-thumbs/*.jpg'):
    basename = os.path.basename(i)
    outfile = outdir + basename
    shutil.copy(i, outfile)
    cmd =  'convert ' + outfile + ' -resize "' + size + 'x' + size + '^"'
    cmd += ' -gravity center -crop ' + size + 'x' + size + '+0+0 '
    cmd += ' -sampling-factor 4:2:0 -strip -quality 85 ' + outfile
    os.system(cmd)