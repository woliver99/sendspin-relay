mkdir -p ./dist/

mkdir -p ./webroot/
cd ./webroot/
rm ../dist/webroot.zip
zip -r ../dist/webroot.zip .
cd ../

mkdir -p ./server/
cd ./server/
rm ../dist/server.zip
zip -r ../dist/server.zip .
cd ../