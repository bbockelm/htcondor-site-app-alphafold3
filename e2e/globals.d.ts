// The access point injects this into every page it serves; the e2e
// suite reads it to assert the app learned its mount point.
//
// Declared here as well as in web/src/lib/htcondor.ts because the e2e
// suite is a separate TypeScript program -- it does not include the
// app's sources, so it does not see the app's declaration.
declare global {
  interface Window {
    __HTCONDOR_APP__?: { id: string; base: string; name: string };
  }
}

export {};
