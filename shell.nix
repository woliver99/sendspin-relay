with import <nixpkgs> { };

mkShell {
  buildInputs = [
    nodejs
    esbuild
    zip
    python3
    python3Packages.websockets
    cargo
    rustc
  ];
}
