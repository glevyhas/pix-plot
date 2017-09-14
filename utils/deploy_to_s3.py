import os, glob

files = []
files += glob.glob('../*')
files += glob.glob('../assets/*')
files += glob.glob('../assets/*/*')

cmd_start = 'aws s3 cp '
cmd_mid = ' s3://yale-dh-staging/tsne/'
cmd_end = ' --acl public-read --profile yale-admin '

os.system(cmd_start + ' ../index.html ' + cmd_mid + 'index.html ' + cmd_end)
os.system(cmd_start + ' ../assets ' + cmd_mid + 'assets ' + cmd_end + ' --recursive ')