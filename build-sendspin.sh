mkdir -p ./webroot/
cd ./sendspin-js
npm install
npm run build
esbuild dist/index.js --bundle --format=esm --outfile=../webroot/sendspin.js
cd ../
