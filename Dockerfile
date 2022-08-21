FROM node:16

RUN apt-get update && apt-get install -y apt-transport-https ca-certificates curl gnupg && \
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" 'https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key' | apt-key add - && \
    echo "deb https://packages.doppler.com/public/cli/deb/debian any-version main" | tee /etc/apt/sources.list.d/doppler-cli.list && \
    apt-get update && \
    apt-get -y install doppler

WORKDIR /usr/src/app

COPY package*.json ./

# Installing the packages while the image is building
RUN npm ci --omit=dev

RUN npm i node-pre-gyp -g

RUN npm rebuild @tensorflow/tfjs-node --build-from-source

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["doppler", "run", "--", "npm", "start"]
