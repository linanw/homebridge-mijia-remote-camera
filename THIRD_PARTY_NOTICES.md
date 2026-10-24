# Distribution and components

The code distributed in this npm package is licensed under MIT. It does not
contain the micam backend, third-party Java runtime, FFmpeg binary, or
ffmpeg-for-homebridge installer. The runtime manifest contains provenance and
SHA-256 identifiers only; it does not grant rights to the identified components.
The included `backend/bridge.jar` contains only the original MIT-licensed
`mijia.bridge` adapter classes built from the supplied Java source.
No micam or Jackson implementation classes are included in that JAR.

The Homebridge settings page and optional local setup command import runtime
files already available on the user's machine. It does not download them or upload them to npm. Local runtime files
are separate from the package and retain their original rights and notices.

- micam, commit `2cc9d9e7607014d1d05c17bc5676544fbb0d5d24`, with local
  authentication and home-selection fixes. Source:
  https://github.com/eugeneRover/micam . The pinned repository has no license.
  No redistribution permission is asserted by this package.
- Eclipse Temurin / OpenJDK 21, Linux x64 glibc and musl. Source:
  https://github.com/adoptium/containers . The importer retains all existing
  runtime legal notices. Image digests and file hashes are in
  `runtime-manifest.json`.
- The known local runtime includes FFmpeg for Homebridge 2.2.2 / FFmpeg 8.0,
  built with `--enable-nonfree`. That binary is excluded from this npm package.
  Source/build information: https://github.com/homebridge/ffmpeg-for-homebridge .
- npm resolves `@homebridge/plugin-ui-utils` (MIT), `tough-cookie` (BSD-3-Clause),
  `tar` (BlueOak-1.0.0), and their dependencies separately, under their respective
  licenses. They are not bundled in the published tarball.

The HomeKit streaming delegate uses Homebridge's public HAP API and requires
neither `homebridge-camera-ffmpeg` nor an independent relay service.

The optional Matter camera implementation resolves `@matter/main` and
`@matter/nodejs` 0.18.0 (Apache-2.0) and `werift` 0.25.1 (MIT), together with
their transitive npm dependencies under their own licenses. These libraries
are installed by npm, not bundled in this package tarball. Matter development
attestation credentials are supplied by the SDK. This package is an experimental
development device and makes no certification claim. WebRTC media encryption and
signaling use these libraries; FFmpeg conversion continues to use the separately
imported local binary described above.

The Xiaomi cloud metadata request schemas were independently established from
static inspection of the public official Mi Home Android application, version
11.8.707. No APK, DEX, decompiled implementation, Xiaomi application code, or
third-party application binary is included in this repository or npm package.
The adapter implements the narrow rename and existing-room move requests itself.
Using a local runtime does not establish permission to redistribute it. Users
must have the right to use their existing files and comply with their notices.
