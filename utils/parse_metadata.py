from collections import defaultdict, Counter
from os.path import basename, exists, join
import unicodecsv as csv
import json
import sys
import os

def parse_metadata(csv_path):
  '''Convert the user-provided CSV data (if any) to JSON'''
  tags_dict = defaultdict(set)
  rows = []
  select_name = 'Metadata'

  with open(csv_path) as f:
    r = csv.reader(f)
    for idx, i in enumerate(r):
      # skip empty rows
      if len(i) == 0:
        continue
      # assume fields are in the following order
      filename, tag, description, permalink = i
      # determine whether this csv contains headers
      if idx == 0:
        # grab the select filter name from the first row
        select_name = tag
      # save the fact that filename has meta level meta
      else:
        tags_dict[tag].add(filename)
        rows.append([filename, tag, description, permalink])

  # save JSON mapping each filter option to filenames with that option
  options_dir = join(output_dir, 'filters', 'option_values')
  if not os.path.exists(options_dir): os.makedirs(options_dir)
  for i in tags_dict:
    with open(join(options_dir, i + '.json'), 'w') as out:
      json.dump(list(tags_dict[i]), out)

  # save JSON indicating all option values
  filters_path = join(output_dir, 'filters', 'filters.json')
  with open(filters_path, 'w') as out:
    json.dump([{
      'filter_name': select_name,
      'filter_values': list(tags_dict.keys())
    }], out)

  # write inidividual metadata files for each input
  for i in rows:
    d = {}
    filename, tag, description, permalink = i
    d['filename'] = filename
    d['tags'] = [tag]
    d['year'] = ''
    d['title'] = filename
    d['text'] = description
    d['permalink'] = permalink

    meta_dir = join(output_dir, 'metadata')
    if not os.path.exists(meta_dir): os.makedirs(meta_dir)
    with open(join(meta_dir, get_base_filename(filename) + '.json'), 'w') as out:
      json.dump(d, out)

def get_base_filename(file_path):
  '''Return the basename without extension of a file path'''
  base = basename(file_path)
  if '.' in base:
    # edge case is a file with a period but no extension (e.g. 10.5.4.3)
    # if that's your situation you may want to rename your files or hack
    return '.'.join(base.split('.')[:-1])
  return base

if __name__ == '__main__':
  output_dir = 'output'
  if len(sys.argv) < 2:
    print('Please provide the path to your CSV file')
    print('e.g. python utils/parse_metadata.py "data/metadta.csv"')
    sys.exit()

  csv_path = sys.argv[1]
  parse_metadata(csv_path)

