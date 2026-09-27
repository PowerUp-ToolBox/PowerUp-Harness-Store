/**
 * @harness-store/manifest/node: the Node-only sources of a Harness Package, which read the file
 * system. The main entry point stays free of Node built-ins so it also runs in the renderer and
 * in Deno; import from here in Node (the desktop main process, the CLI, tests).
 */
export { DirectorySource } from './directory-source.js';
export { fileReader, openArchiveFile } from './archive-file.js';
