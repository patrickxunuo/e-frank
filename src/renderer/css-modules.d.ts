// Ambient declarations for Vite's CSS Modules + plain CSS imports.
// Kept in a separate, no-top-level-import file so the wildcard module
// declarations resolve unambiguously (electron-env.d.ts is a module file
// because it imports IpcApi, which can confuse TS about ambient scope).

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css' {
  const content: string;
  export default content;
}
