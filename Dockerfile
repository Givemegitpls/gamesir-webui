# Static front end only: WebHID talks to the controller straight from the browser,
# so the container needs no device passthrough at all - and, just as important, it
# cannot replace the host udev rule: Chromium opens /dev/hidraw* with the rights of
# the browser process, not of the container. See README ("Права на устройство").
FROM nginx:alpine

COPY web/ /usr/share/nginx/html/

# WebHID requires a secure context. http://localhost counts as one, so this image
# is only useful when published to localhost (or behind TLS).
EXPOSE 80
