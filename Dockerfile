# Official Apify base image. Sets WORKDIR to /usr/src/app and provides Node 20.
FROM apify/actor-node:20

# Copy manifests first so `npm install` is cached independently of source edits.
COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm ls --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -rf ~/.npm

# Copy the rest of the source.
COPY . ./

# Fail the BUILD, loudly, if the entry point did not make it into the image.
# Without this the actor builds fine and only dies at run time with an opaque
# MODULE_NOT_FOUND, which tells you nothing about which layer went wrong.
RUN echo "--- Image contents at $(pwd) ---" \
    && ls -la \
    && echo "--- src/ ---" \
    && ls -la src \
    && test -f src/main.js \
    || (echo "FATAL: src/main.js is missing from the build context." && exit 1)

CMD ["npm", "start"]
