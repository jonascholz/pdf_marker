# Notes for AI coding agents
See README.md for features, layout and build.

- Keep it barebones: no Android library dependencies, no framework in the web viewer.
- After changing `app/src/main/assets/`: `npm install && npm run assets && npm run check`.
- The Java side has no local test; CI (`./gradlew assembleDebug`) is the compile check.
