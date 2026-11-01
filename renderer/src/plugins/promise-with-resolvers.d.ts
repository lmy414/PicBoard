// tsconfig targets ES2022, which does not declare Promise.withResolvers.
// The renderer runs on current WebView2 (Chromium 119+) and the tests run on
// Node 22+, so the API is present at runtime; pull in its standard declaration.
/// <reference lib="es2024.promise" />
