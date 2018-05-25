# Specify base image
FROM ubuntu:16.04

# Specify author \ maintainer
MAINTAINER Douglas Duhaime <douglas.duhaime@gmail.com>

##
# Install Python
##

# Add repository that contains Python 3.6
RUN apt-get update
RUN apt-get install -y software-properties-common
RUN add-apt-repository ppa:jonathonf/python-3.6
RUN apt-get update

# Install Python 3.6
RUN apt-get install -y build-essential \
  python3.6 \
  python3.6-dev \
  python3-pip \
  python3.6-venv

# Update pip
RUN python3.6 -m pip install pip --upgrade
RUN python3.6 -m pip install wheel

##
# Install ImageMagick
##

RUN apt-get install -y imagemagick

##
# Copy source files
##

ENV APP_PATH="pixplot"
RUN mkdir "$APP_PATH"
ADD . "$APP_PATH"

##
# Install PixPlot dependencies
##

RUN cd "$APP_PATH" && \
  python3.6 -m pip install -r "utils/requirements.txt"

##
# Start server on 5000
##

EXPOSE 5000
