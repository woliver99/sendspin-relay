mkdir -p ./dist/

mkdir -p ./webroot/
cd ./webroot/
rm ../dist/webroot.zip
zip -r ../dist/webroot.zip .
cd ../

mkdir -p ./server-python/
cd ./server-python/
rm ../dist/server-python.zip
zip -r ../dist/server-python.zip .
cd ../