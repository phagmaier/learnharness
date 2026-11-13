{
  # Fork-only NixOS dev shell. Node/npm come from mise (mise.toml); this shell
  # only supplies the shared libraries that npm's prebuilt Electron binary
  # needs. It relies on nix-ld: those binaries load through nix-ld, which
  # reads NIX_LD_LIBRARY_PATH, so nix-built tools in the shell are unaffected.
  # See docs/fork/nixos.md.
  description = "LearnHarness fork dev shell (Electron runtime libraries for NixOS)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      electronLibs = with pkgs; [
        alsa-lib
        at-spi2-atk
        at-spi2-core
        atk
        cairo
        cups
        dbus
        expat
        glib
        gtk3
        libdrm
        libGL
        libgbm
        libxkbcommon
        nspr
        nss
        pango
        systemd
        libx11
        libxcomposite
        libxdamage
        libxext
        libxfixes
        libxrandr
        libxcb
        libxshmfence
      ];
    in {
      devShells.${system}.default = pkgs.mkShell {
        shellHook = ''
          export NIX_LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath electronLibs}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
        '';
      };
    };
}
