with import <nixpkgs> { };

mkShell {
  buildInputs = [
    nodejs
    esbuild
    cargo
    rustc
  ];
}
