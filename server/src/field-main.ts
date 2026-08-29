// Dedicated development entry: set the runtime mode before config.ts is loaded.
process.env.CLOSURE_MODE = 'field';
process.env.SERVER_PORT ??= '3003';

await import('./main.js');

export {};
