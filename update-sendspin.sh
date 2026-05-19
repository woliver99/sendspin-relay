mkdir -p ./webroot/assets/
cd ./sendspin-js
npm install
npm run build
esbuild dist/index.js --bundle --format=esm --outfile=../webroot/assets/sendspin.js
cd ../
