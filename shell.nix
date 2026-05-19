with import <nixpkgs> { };

mkShell {
  buildInputs = [
    nodejs
    esbuild
    zip
  ];
}
