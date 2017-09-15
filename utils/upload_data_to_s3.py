import os

aws = 's3://lab-apps/meserve-kunhardt/tsne-map/smaller-app-assets/'
flags = ' --acl public-read --profile yale-admin'

os.system('aws s3 cp ../data/image-atlas-pot.jpg ' + aws + 'image-atlas-pot.jpg' + flags)
os.system('aws s3 cp ../data/json/selected_image_tsne_projections.json ' + aws + 'selected_image_tsne_projections.json' + flags)