mkdir -p ./webroot/
cd ./webroot/
rm ../webroot.zip
zip -r ../webroot.zip .
cd ../

mkdir -p ./server/
cd ./server/
rm ../server.zip
zip -r ../server.zip .
cd ../