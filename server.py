from flask import Flask, send_from_directory, render_template
from flask_cors import CORS, cross_origin

app = Flask(__name__, static_url_path='/')
CORS(app)

@app.route('/<path:path>')
def send_js(path):
  return send_from_directory('', path)

@app.route('/')
def index():
  return send_from_directory('', 'index.html')

if __name__ == '__main__':
  app.run()
